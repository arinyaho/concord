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
# A review still pending after this long died without settling its status;
# pr-review.yml's job timeout is 60 minutes.
running_cutoff=$(date -u -d "60 minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -v-60M +%Y-%m-%dT%H:%M:%SZ)
# Only markers this account posted count: anyone can write the same text in a comment.
ME=$(gh api user --jq .login)

# One pass reads each pull request once and sorts it into requested or
# automatic reviews; requested ones are dispatched first.
requested=(); automatic=()
for repo in $REPOS; do
  while IFS=$'\t' read -r num sha title; do
    # A review of this commit is queued or running. Dispatching it again would
    # cancel that run, and a review longer than the poll interval never posts.
    review_status=$(gh api "repos/$repo/commits/$sha/status" \
      --jq '[.statuses[] | select(.context == "concord/review")][0] | "\(.state) \(.updated_at)"' 2>/dev/null || true)
    state=${review_status%% *}; updated=${review_status#* }
    if [ "$state" = pending ] && [[ "$updated" > "$running_cutoff" ]]; then continue; fi

    # Without the conversation there is no telling whether this commit was reviewed.
    convo=$(gh pr view "$num" --repo "$repo" --json comments,reviews 2>/dev/null) || continue
    # A marker counts only as the first line of a body this account posted:
    # the lines after it carry model-written finding text.
    markers=$(jq -r --arg me "$ME" '((.comments // []) + (.reviews // []))[]
                 | select(.author.login == $me) | .body | split("\n")[0]
                 | select(startswith("<!-- concord-review:"))' <<<"$convo")
    # A review costs money, so only someone with a role on the repository asks for one.
    cmd=$(jq -r '(.comments // [])[]
                 | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR")
                 | select(.body | test("@concord +(broad|diff)"))
                 | "\(.url | capture("issuecomment-(?<i>[0-9]+)").i)\t\(.body | capture("@concord +(?<m>broad|diff)").m)\t\(.createdAt)"' <<<"$convo" | tail -1)
    IFS=$'\t' read -r cmd_id cmd_mode cmd_at <<<"$cmd"

    # A command runs once: it is done when its review posted, or when a review
    # of this commit failed after it was asked.
    if [ -n "$cmd" ] && ! grep -qF "cmd:$cmd_id" <<<"$markers" \
        && ! { [ "$state" = error ] && [[ "$updated" > "$cmd_at" ]]; }; then
      requested+=("$repo $num $sha $cmd_mode $cmd_id $title")
      continue
    fi
    # Manual mode: review only what somebody asked for with an @concord comment.
    [ -n "${MANUAL_ONLY:-}" ] && continue
    # A failed review is not retried on its own: a new push or an @concord
    # command starts the next one.
    [ "$state" = error ] && continue
    # This exact commit was already reviewed, automatically or on request.
    if grep -qE "^<!-- concord-review: $sha( cmd:[0-9]+)? -->$" <<<"$markers"; then continue; fi
    # The broad pass runs on the first review only; a PR carrying an earlier
    # marker has had it, so later pushes get the diff-local pass alone.
    if [ -n "$markers" ]; then mode='diff'; else mode='broad'; fi
    automatic+=("$repo $num $sha $mode - $title")
  done < <(gh pr list --repo "$repo" --state open --limit 100 --json number,headRefOid,isDraft,title,updatedAt |
             jq -r --arg cutoff "$cutoff" \
               '.[] | select(.isDraft | not) | select(.updatedAt > $cutoff) | "\(.number)\t\(.headRefOid)\t\(.title)"')
done

started=0
for entry in ${requested[@]+"${requested[@]}"} ${automatic[@]+"${automatic[@]}"}; do
  [ "$started" -ge "$MAX_PER_RUN" ] && break
  read -r repo num sha mode cmd_id title <<<"$entry"
  phase=requested
  if [ "$cmd_id" = - ]; then cmd_id=; phase=auto; fi
  echo "dispatch ($mode, $phase): $repo#$num @ ${sha:0:8} — $title"
  if [ -z "${DRY_RUN:-}" ]; then
    GH_TOKEN="$SELF_TOKEN" gh workflow run pr-review.yml --repo "$SELF" \
      -f repo="$repo" -f pr="$num" -f sha="$sha" -f mode="$mode" -f cmd_id="$cmd_id"
    # Pending from the moment it is dispatched, so a run still waiting for a
    # runner is not dispatched again by the next poll.
    gh api -X POST "repos/$repo/statuses/$sha" -f context=concord/review \
      -f state=pending -f description="queued ($mode)" >/dev/null || true
  fi
  started=$((started + 1))
done

echo "dispatched $started review(s)"
