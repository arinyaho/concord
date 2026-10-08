#!/usr/bin/env bash
# Finds pull requests that need a review and dispatches one review run each.
# Reviewing itself happens in pr-review.yml, one run per pull request, so a new
# push cancels the review of the commit it replaced.
#
# DRY_RUN=1 prints what it would dispatch and dispatches nothing.
set -euo pipefail

: "${REPOS:?set REPOS to a space-separated list of owner/name}"
: "${GH_TOKEN:?REVIEW_PAT is not set}"
SELF="${SELF:?set SELF to this repository, owner/name}"
# Dispatching happens as the workflow's own token, not the review PAT: the PAT
# reaches the repositories under review and has no business reaching this one.
: "${SELF_TOKEN:?set SELF_TOKEN to a token with actions:write on SELF}"
MAX_PER_RUN="${MAX_PER_RUN:-3}"   # ponytail: flat cap on reviews started per poll
STALE_DAYS="${STALE_DAYS:-7}"
cutoff=$(date -u -d "${STALE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -v-"${STALE_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)
# Reviews in flight are the pr-review.yml runs not yet completed, named
# "review <repo>#<pr> @ <sha>". Read the full unfiltered workflow history:
# a fixed window can miss an older active run after many newer runs. An
# incomplete page read fails the poll before any dispatch.
active=$(GH_TOKEN="$SELF_TOKEN" gh api --paginate \
           "repos/$SELF/actions/workflows/pr-review.yml/runs?per_page=100" \
           --jq '.workflow_runs[] | select(.status != "completed") | .display_title')
# Only markers this account posted count: anyone can write the same text in a comment.
ME=$(gh api user --jq .login)

# One pass reads each pull request once and sorts it into requested or
# automatic reviews; requested ones are dispatched first.
requested=(); automatic=()
for repo in $REPOS; do
  # A poll that cannot list a repository fails rather than reporting nothing to do.
  # ponytail: the newest 1000 open pull requests per repository.
  prs=$(gh pr list --repo "$repo" --state open --limit 1000 --json number,headRefOid,isDraft,title,updatedAt)
  while IFS=$'\t' read -r num sha updated title; do
    [ -n "$num" ] || continue
    # A review of this commit is queued or running. Dispatching it again would
    # cancel that run, and a review longer than the poll interval never posts.
    # A review of this commit is queued or running. Dispatching it again would
    # cancel that run.
    grep -qxF "review $repo#$num @ $sha" <<<"$active" && continue
    # The status context names the pull request, since other pull requests can
    # share the commit. Without the lookup there is no telling whether the last
    # review failed, so the pull request waits for the next poll.
    statuses=$(gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" --jq '.[]' 2>/dev/null | jq -s .) || continue
    latest=$(jq -c --arg context "concord/review (#$num)" '
      [to_entries[] | select(.value.context == $context)]
      | sort_by(.value.created_at // .value.updated_at // "", -.key) | last | .value // {}' <<<"$statuses") || continue
    state=$(jq -r '.state // ""' <<<"$latest")
    description=$(jq -r '.description // ""' <<<"$latest")
    status_created=$(jq -r '.created_at // .updated_at // ""' <<<"$latest")
    stale=
    [ "$updated" \> "$cutoff" ] || stale=1
    # Old inactive PRs need no conversation read. Pending/error statuses may
    # still need receipt recovery, which only needs the posted reviews.
    if [ -n "$stale" ] && { [ -z "$state" ] || [ "$state" = success ]; }; then continue; fi

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
      receipt=$(jq -r --arg me "$ME" --arg sha "$sha" --arg attempt "$attempt" '
        [.[] | select(.user.login == $me and .commit_id == $sha)
          | (.body // "" | split("\n")) as $lines
          | select($lines[0] | test("^<!-- concord-review: " + $sha + " mode:(broad|diff)( cmd:[0-9]+)? -->$"))
          | select($lines[1] == ("<!-- concord-review-attempt: " + $attempt + " -->"))] | length' <<<"$reviews") || continue
      if [ "$receipt" -gt 0 ]; then
        if [ "$state" != success ]; then
          echo "settle posted review: $repo#$num @ ${sha:0:8} attempt:$attempt"
          if [ -z "${DRY_RUN:-}" ]; then
            gh api -X POST "repos/$repo/statuses/$sha" -f "context=concord/review (#$num)" \
              -f state=success -f "description=attempt:$attempt review posted" >/dev/null || continue
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
          | select(test("^<!-- concord-review: " + $sha + " mode:(broad|diff)( cmd:[0-9]+)? -->$"))] | length' <<<"$reviews") || continue
      if [ "$legacy" -gt 0 ]; then
        echo "settle legacy posted review: $repo#$num @ ${sha:0:8}"
        if [ -z "${DRY_RUN:-}" ]; then
          gh api -X POST "repos/$repo/statuses/$sha" -f "context=concord/review (#$num)" \
            -f state=success -f description="review posted" >/dev/null || continue
        fi
        state=success
      fi
    fi
    [ -z "$stale" ] || continue
    # A marker counts only as the first line of a body this account posted:
    # the lines after it carry model-written finding text. A posted review
    # leaves "concord-review:", a failed requested one "concord-review-failed:".
    markers=$(printf '%s\n%s\n' "$comments" "$reviews" | jq -r --arg me "$ME" '.[]
                 | select(.user.login == $me) | .body // "" | split("\n")[0]
                 | select(startswith("<!-- concord-review"))') || continue

    # Commands from someone with a role on the repository, newest first. The
    # newest one not yet done runs: done means a marker names it, whether its
    # review posted or failed.
    cmd_id=; reviewer=-
    while IFS=$'\t' read -r id cmd_mode cmd_reviewer; do
      [ -n "$id" ] || continue
      grep -qF " cmd:$id -->" <<<"$markers" && continue
      cmd_id=$id; reviewer=$cmd_reviewer; break
    done < <(jq -r '[.[] | select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")
                      | select(.body | test("@concord +(broad|diff)( +(claude|codex))?(\\s|$)"))]
                    | sort_by(.created_at) | reverse[]
                    | (.body | capture("@concord +(?<m>broad|diff)( +(?<r>claude|codex))?(\\s|$)")) as $c
                    | "\(.id)\t\($c.m)\t\($c.r // "-")"' <<<"$comments")
    if [ -n "$cmd_id" ]; then
      requested+=("$repo $num $sha $cmd_mode $cmd_id $reviewer $title")
      continue
    fi
    # Manual mode: review only what somebody asked for with an @concord comment.
    [ -n "${MANUAL_ONLY:-}" ] && continue
    # A failed review is not retried on its own: a new push or an @concord
    # command starts the next one.
    [ "$state" = error ] && continue
    # A broad review of this commit covers the automatic pass entirely.
    if grep -qE "^<!-- concord-review: $sha mode:broad( cmd:[0-9]+)? -->$" <<<"$markers"; then continue; fi
    # The broad pass runs until one has completed on this pull request, then
    # later pushes get the diff-local pass alone. A requested diff on the
    # current commit does not satisfy the first broad pass.
    if grep -qF ' mode:broad' <<<"$markers"; then mode='diff'; else mode='broad'; fi
    if grep -qE "^<!-- concord-review: $sha mode:$mode( cmd:[0-9]+)? -->$" <<<"$markers"; then continue; fi
    automatic+=("$repo $num $sha $mode - - $title")
  done < <(jq -r '.[] | select(.isDraft | not) | "\(.number)\t\(.headRefOid)\t\(.updatedAt)\t\(.title)"' <<<"$prs")
done

started=0
for entry in ${requested[@]+"${requested[@]}"} ${automatic[@]+"${automatic[@]}"}; do
  [ "$started" -ge "$MAX_PER_RUN" ] && break
  read -r repo num sha mode cmd_id reviewer title <<<"$entry"
  # A command may name the reviewer; otherwise the workflow uses REVIEW_REVIEWER.
  [ "$reviewer" = - ] && reviewer=
  phase=requested
  if [ "$cmd_id" = - ]; then cmd_id=; phase=auto; fi
  echo "dispatch ($mode, $phase, ${reviewer:-default}): $repo#$num @ ${sha:0:8} — $title"
  if [ -z "${DRY_RUN:-}" ]; then
    attempt_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
    GH_TOKEN="$SELF_TOKEN" gh workflow run pr-review.yml --repo "$SELF" \
      -f repo="$repo" -f pr="$num" -f sha="$sha" -f mode="$mode" -f cmd_id="$cmd_id" -f reviewer="$reviewer" -f attempt_id="$attempt_id"
    # Pending from the moment it is dispatched, so a run still waiting for a
    # runner is not dispatched again by the next poll.
    gh api -X POST "repos/$repo/statuses/$sha" -f "context=concord/review (#$num)" \
      -f state=pending -f "description=attempt:$attempt_id queued ($mode)" >/dev/null || true
  fi
  started=$((started + 1))
done

echo "dispatched $started review(s)"
