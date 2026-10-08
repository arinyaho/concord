#!/usr/bin/env bash
# Finds pull requests that need a review and dispatches one review run each.
# Reviewing itself happens in pr-review.yml, one run per pull request, so a new
# push cancels the review of the commit it replaced.
#
# DRY_RUN=1 prints what it would dispatch and dispatches nothing.
set -euo pipefail
# shellcheck source=services/pr-review/identity.sh
source "$(dirname "$0")/identity.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

: "${REPOS:?set REPOS to a space-separated list of owner/name}"
: "${GH_TOKEN:?REVIEW_PAT is not set}"
SELF="${SELF:?set SELF to this repository, owner/name}"
# Dispatching happens as the workflow's own token, not the review PAT: the PAT
# reaches the repositories under review and has no business reaching this one.
: "${SELF_TOKEN:?set SELF_TOKEN to a token with actions:write on SELF}"
MAX_PER_RUN="${MAX_PER_RUN:-3}"   # ponytail: flat cap on reviews started per poll
STALE_DAYS="${STALE_DAYS:-7}"
DISPATCH_GRACE_SECONDS="${DISPATCH_GRACE_SECONDS:-900}"
if [[ ! "$DISPATCH_GRACE_SECONDS" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$DISPATCH_GRACE_SECONDS" -gt 86400 ]; then
  echo "DISPATCH_GRACE_SECONDS must be an integer from 1 to 86400" >&2; exit 1
fi
poll_time=$(date -u +%s)
cutoff=$(date -u -d "${STALE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -v-"${STALE_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)
# Read the full unfiltered history once. A failed or malformed page must stop
# the poll before dispatch. Keep the inventory in a file rather than argv.
inventory=$(mktemp)
trap 'rm -rf "$work"; rm -f "$inventory"' EXIT
GH_TOKEN="$SELF_TOKEN" gh api --paginate \
  "repos/$SELF/actions/workflows/pr-review.yml/runs?per_page=100" \
  --jq 'if (.workflow_runs | type) == "array" and
             all(.workflow_runs[]; type == "object" and
               (.status | type) == "string" and
               (.display_title | type) == "string" and
               ((.conclusion == null) or ((.conclusion | type) == "string")))
        then .workflow_runs[] | [.status, (.conclusion // "null"), .display_title] | @tsv
        else error("malformed workflow run inventory") end' > "$inventory"
declare -A active_heads=() active_identities=() consumed_commands=() failed_heads=() failed_identities=()
canonical_repo() {
  local LC_ALL=C
  printf -v "$2" '%s' "${1,,}"
}
title_pattern='^review ([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*) @ ([0-9a-f]{40})( identity:([0-9a-f]{64}))?( cmd:([1-9][0-9]*|-))?$'
run_repo_key=''
repo_key=''
while IFS=$'\t' read -r run_status conclusion run_title; do
  [[ "$run_title" =~ $title_pattern ]] || continue
  run_repo=${BASH_REMATCH[1]}
  run_pr=${BASH_REMATCH[2]}
  run_sha=${BASH_REMATCH[3]}
  run_identity=${BASH_REMATCH[5]:-}
  run_cmd=${BASH_REMATCH[7]:-}
  if [[ "$run_status" == completed && "$conclusion" == success &&
        ( -z "$run_cmd" || "$run_cmd" == - ) ]]; then
    continue
  fi
  canonical_repo "$run_repo" run_repo_key
  head_key="$run_repo_key|$run_pr|$run_sha"
  if [ "$run_status" != completed ]; then
    if [ -n "$run_identity" ]; then
      active_identities["$head_key|$run_identity"]=1
    else
      active_heads["$head_key"]=1
    fi
  else
    if [ -n "$run_cmd" ] && [ "$run_cmd" != - ]; then
      consumed_commands["$run_repo_key|$run_pr|$run_cmd"]=1
    fi
    if [ "$conclusion" != success ]; then
      if [ -n "$run_identity" ]; then failed_identities["$head_key|$run_identity"]=1
      else failed_heads["$head_key"]=1; fi
    fi
  fi
done < "$inventory"
# Only markers this account posted count: anyone can write the same text in a comment.
ME=$(gh api user --jq .login)

# One pass reads each pull request once and sorts it into requested or
# automatic reviews; requested ones are dispatched first.
requested=(); automatic=()
for repo in $REPOS; do
  canonical_repo "$repo" repo_key
  # A poll that cannot list a repository fails rather than reporting nothing to do.
  # ponytail: the newest 1000 open pull requests per repository.
  prs=$(gh pr list --repo "$repo" --state open --limit 1000 --json number,headRefOid,isDraft,title,updatedAt)
  while IFS=$'\t' read -r num sha updated title; do
    [ -n "$num" ] || continue
    # Legacy activity has no identity, so suppress that head until it ends.
    # Versioned runs suppress only the exact inputs checked below.
    [ -n "${active_heads["$repo_key|$num|$sha"]+x}" ] && continue
    # The status context names the pull request, since other pull requests can
    # share the commit. Without the lookup there is no telling whether the last
    # review failed, so the pull request waits for the next poll.
    statuses=$(gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" --jq '.[]' 2>/dev/null | jq -s .) || continue
    latest=$(jq -Sc --arg context "concord/review (#$num)" '
      [to_entries[] | select(.value.context == $context)]
      | sort_by(.value.created_at // .value.updated_at // "", -.key) | last | .value // {}' <<<"$statuses") || continue
    state=$(jq -r '.state // ""' <<<"$latest")
    description=$(jq -r '.description // ""' <<<"$latest")
    status_identity=
    if [[ "$description" =~ identity:([0-9a-f]{64})(\ |$) ]]; then status_identity=${BASH_REMATCH[1]}; fi
    status_created=$(jq -r '.created_at // .updated_at // ""' <<<"$latest")
    stale=
    [ "$updated" \> "$cutoff" ] || stale=1
    # Old inactive PRs need no conversation read. Pending/error statuses may
    # still need receipt recovery, which only needs the posted reviews.

    # Every page of the conversation; without it there is no telling whether
    # this commit was reviewed, so the pull request waits for the next poll.
    comments='[]'
    if [ -z "$stale" ]; then
      comments=$(gh api --paginate "repos/$repo/issues/$num/comments" --jq '.[]' 2>/dev/null | jq -s .) || continue
    fi
    reviews=$(gh api --paginate "repos/$repo/pulls/$num/reviews" --jq '.[]' 2>/dev/null | jq -s .) || continue
    # Only a review from our account on this commit with this attempt's exact
    # second-line receipt can settle its pending/error status. Older attempts
    # cannot overwrite a newer request, even if they share a timestamp.
    attempt=
    if [[ "$description" =~ ^attempt:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})(\ |$) ]]; then
      attempt="${BASH_REMATCH[1],,}"
      receipt=$(jq -r --arg me "$ME" --arg sha "$sha" --arg attempt "$attempt" --arg identity "$status_identity" '
        [.[] | select(.user.login == $me and .commit_id == $sha)
          | (.body // "" | split("\n")) as $lines
          | select($lines[0] | test("^<!-- concord-review: " + $sha + " mode:(broad|diff)( base:[0-9a-f]+ intent:[0-9a-f]{64})?( cmd:[0-9]+)? -->$"))
          | select($lines[1] == ("<!-- concord-review-attempt: " + $attempt + " -->"))
          | select($identity == "" or $lines[2] == ("<!-- concord-review-identity: " + $identity + " -->"))] | length' <<<"$reviews") || continue
      if [ "$receipt" -gt 0 ]; then
        if [ "$state" != success ]; then
          echo "settle posted review: $repo#$num @ ${sha:0:8} attempt:$attempt"
          if [ -z "${DRY_RUN:-}" ]; then
            latest_now=$(review_latest_status "$repo" "$num" "$sha") || continue
            [ "$latest_now" = "$latest" ] || continue
            gh api -X POST "repos/$repo/statuses/$sha" -f "context=concord/review (#$num)" \
              -f state=success -f "description=attempt:$attempt${status_identity:+ identity:$status_identity} posted" >/dev/null || continue
          fi
        fi
        state=success
      fi
    fi
    # Legacy statuses have no attempt identity. Require a strictly later
    # trusted review; equal timestamps are ambiguous and left for manual repair.
    if [[ "$description" != attempt:* ]] && [ -n "$status_created" ] && [ "$state" != success ]; then
      legacy=$(jq -r --arg me "$ME" --arg sha "$sha" --arg created "$status_created" '
        [.[] | select(.user.login == $me and .commit_id == $sha and .submitted_at > $created)
          | (.body // "" | split("\n"))[0]
          | select(test("^<!-- concord-review: " + $sha + " mode:(broad|diff)( base:[0-9a-f]+ intent:[0-9a-f]{64})?( cmd:[0-9]+)? -->$"))] | length' <<<"$reviews") || continue
      if [ "$legacy" -gt 0 ]; then
        echo "settle legacy posted review: $repo#$num @ ${sha:0:8}"
        if [ -z "${DRY_RUN:-}" ]; then
          latest_now=$(review_latest_status "$repo" "$num" "$sha") || continue
          [ "$latest_now" = "$latest" ] || continue
          gh api -X POST "repos/$repo/statuses/$sha" -f "context=concord/review (#$num)" \
            -f state=success -f description="review posted" >/dev/null || continue
        fi
        state=success
      fi
    fi
    # A marker counts only as the first line of a body this account posted:
    # the lines after it carry model-written finding text. A posted review
    # leaves "concord-review:", a failed requested one "concord-review-failed:".
    markers=$(printf '%s\n%s\n' "$comments" "$reviews" | jq -r --arg me "$ME" '.[]
                 | select(.user.login == $me) | .body // "" | split("\n")[0]
                 | select(startswith("<!-- concord-review"))') || continue

    # Commands from someone with a role on the repository, newest first. The
    # newest one not yet done runs: done means a marker names it, whether its
    # review posted or failed.
    cmd_id=; reviewer=-; cmd_mode=
    while IFS=$'\t' read -r id candidate_mode cmd_reviewer; do
      [ -n "$id" ] || continue
      grep -qF " cmd:$id -->" <<<"$markers" && continue
      [ -n "${consumed_commands["$repo_key|$num|$id"]+x}" ] && continue
      cmd_id=$id; cmd_mode=$candidate_mode; reviewer=$cmd_reviewer; break
    done < <(jq -r '[.[] | select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")
                      | select(.body | test("@concord +(broad|diff)( +(claude|codex))?(\\s|$)"))]
                    | sort_by(.created_at) | reverse[]
                    | (.body | capture("@concord +(?<m>broad|diff)( +(?<r>claude|codex))?(\\s|$)")) as $c
                    | "\(.id)\t\($c.m)\t\($c.r // "-")"' <<<"$comments")
    # Manual mode still reads the conversation to find commands, but does not
    # collect PR/issue snapshots for PRs that have no eligible request.
    if [ -z "$cmd_id" ] && [ -n "${MANUAL_ONLY:-}" ]; then continue; fi

    # Closing issue edits need not touch PR.updatedAt. Check inputs on old
    # covered PRs too, while retaining the cutoff for initial automatic passes.
    if [ -z "$cmd_id" ] && [ -n "$stale" ] && ! grep -qF ' mode:broad' <<<"$markers"; then continue; fi
    review_snapshot "$repo" "$num" "$work/pr.json" "$work/intent.md" || continue
    [ "$SNAP_HEAD" = "$sha" ] || continue  # changed since the PR listing
    [ -n "${active_identities["$repo_key|$num|$sha|$SNAP_ID"]+x}" ] && continue
    # An accepted dispatch may not appear in the inventory immediately. Hold
    # matching pending inputs without rewriting the status timestamp, so the
    # next polls can discover its run before spending tokens on another attempt.
    if [ "$state" = pending ] && [ -n "$attempt" ] && [ "$status_identity" = "$SNAP_ID" ]; then
      status_age=$(jq -er --argjson now "$poll_time" \
        '$now - (.created_at | fromdateiso8601)' <<<"$latest" 2>/dev/null) || continue
      if [ "$status_age" -lt "$DISPATCH_GRACE_SECONDS" ]; then
        echo "defer pending dispatch: $repo#$num @ ${sha:0:8} (grace period)"
        continue
      fi
    fi
    scope="base:$SNAP_BASE intent:$SNAP_INTENT"
    broad_covered=
    if grep -qE "^<!-- concord-review: [0-9a-f]+ mode:broad $scope( cmd:[0-9]+)? -->$" <<<"$markers"; then broad_covered=1; fi

    if [ -n "$cmd_id" ]; then
      requested+=("$repo $num $sha $cmd_mode $cmd_id $reviewer $SNAP_ID $title")
      continue
    fi
    # Manual mode: review only what somebody asked for with an @concord comment.
    [ -n "${MANUAL_ONLY:-}" ] && continue
    [ -n "${failed_heads["$repo_key|$num|$sha"]+x}" ] && continue
    [ -n "${failed_identities["$repo_key|$num|$sha|$SNAP_ID"]+x}" ] && continue
    # A failed review is not retried on its own: a new push or an @concord
    # command starts the next one.
    if [ "$state" = error ] && { [ -z "$status_identity" ] || [ "$status_identity" = "$SNAP_ID" ]; }; then continue; fi
    # Reuse a broad pass only for the same requirements and actual merge base.
    # Legacy head-only completions establish no coverage and refresh once.
    if [ -n "$broad_covered" ]; then mode='diff'; else mode='broad'; fi
    if grep -qE "^<!-- concord-review: $sha mode:broad $scope( cmd:[0-9]+)? -->$" <<<"$markers"; then continue; fi
    if grep -qE "^<!-- concord-review: $sha mode:$mode $scope( cmd:[0-9]+)? -->$" <<<"$markers"; then continue; fi
    automatic+=("$repo $num $sha $mode - - $SNAP_ID $title")
  done < <(jq -r '.[] | select(.isDraft | not) | "\(.number)\t\(.headRefOid)\t\(.updatedAt)\t\(.title)"' <<<"$prs")
done

started=0
for entry in ${requested[@]+"${requested[@]}"} ${automatic[@]+"${automatic[@]}"}; do
  [ "$started" -ge "$MAX_PER_RUN" ] && break
  read -r repo num sha mode cmd_id reviewer identity title <<<"$entry"
  # A command may name the reviewer; otherwise the workflow uses REVIEW_REVIEWER.
  [ "$reviewer" = - ] && reviewer=
  phase=requested
  if [ "$cmd_id" = - ]; then cmd_id=; phase=auto; fi
  echo "dispatch ($mode, $phase, ${reviewer:-default}): $repo#$num @ ${sha:0:8} — $title"
  if [ -z "${DRY_RUN:-}" ]; then
    attempt_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
    # Claim the status before dispatch so an eagerly-starting worker can verify
    # ownership. On failure, do not launch a worker that will correctly refuse it.
    gh api -X POST "repos/$repo/statuses/$sha" -f "context=concord/review (#$num)" \
      -f state=pending -f "description=attempt:$attempt_id identity:$identity queued $mode" >/dev/null || continue
    # Reserve capacity for every issued request, including one whose accepted
    # response might be lost. Failed status claims issue no request and cost none.
    started=$((started + 1))
    if ! GH_TOKEN="$SELF_TOKEN" gh workflow run pr-review.yml --repo "$SELF" \
      -f repo="$repo" -f pr="$num" -f sha="$sha" -f mode="$mode" -f cmd_id="$cmd_id" -f reviewer="$reviewer" -f identity="$identity" -f attempt_id="$attempt_id"; then
      # A failed client response does not prove GitHub rejected the dispatch.
      # Preserve worker progress and let full-inventory polls discover its run.
      # Matching pending inputs wait through the grace period before retrying.
      echo "workflow dispatch result is ambiguous; leaving attempt pending for reconciliation"
      continue
    fi
  else
    started=$((started + 1))
  fi
done

echo "dispatched $started review(s)"
