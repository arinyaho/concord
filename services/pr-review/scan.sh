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
# Manual mode: review only what somebody asked for with an @concord comment.
# The requested pass still runs, so a review is one comment away.
PHASES="requested auto"
if [ -n "${MANUAL_ONLY:-}" ]; then PHASES="requested"; fi
cutoff=$(date -u -d "${STALE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -v-"${STALE_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)
# A review still pending after this long died without settling its status;
# pr-review.yml's job timeout is 60 minutes.
running_cutoff=$(date -u -d "60 minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -v-60M +%Y-%m-%dT%H:%M:%SZ)
started=0

for phase in $PHASES; do
for repo in $REPOS; do
  while IFS=$'\t' read -r num sha title; do
    [ "$started" -ge "$MAX_PER_RUN" ] && break 3

    # A review of this commit is still running. Dispatching it again would
    # cancel that run, and a review longer than the poll interval never posts.
    running=$(gh api "repos/$repo/commits/$sha/status" \
      --jq '[.statuses[] | select(.context == "concord/review")][0] | select(.state == "pending") | .updated_at' 2>/dev/null || true)
    if [ -n "$running" ] && [[ "$running" > "$running_cutoff" ]]; then continue; fi

    convo=$(gh pr view "$num" --repo "$repo" --json comments,reviews 2>/dev/null || echo '{}')
    bodies=$(jq -r '(.comments // [])[].body, (.reviews // [])[].body' <<<"$convo")
    # A review costs money, so only someone with a role on the repository asks for one.
    cmd=$(jq -r '(.comments // [])[]
                 | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR")
                 | select(.body | test("@concord +(broad|diff)"))
                 | "\(.url | capture("issuecomment-(?<i>[0-9]+)").i)\t\(.body | capture("@concord +(?<m>broad|diff)").m)"' <<<"$convo" | tail -1)
    cmd_id=${cmd%%$'\t'*}
    cmd_mode=${cmd##*$'\t'}

    if [ -n "$cmd" ] && ! grep -qF "cmd:$cmd_id" <<<"$bodies"; then
      [ "$phase" = auto ] && continue      # already offered in the requested pass
      mode=$cmd_mode
    else
      [ "$phase" = requested ] && continue
      cmd_id=
      # This exact commit was already reviewed, automatically or on request.
      if grep -qE "<!-- concord-review: $sha( cmd:[0-9]+)? -->" <<<"$bodies"; then continue; fi
      # The broad pass runs on the first review only; a PR carrying an earlier
      # marker has had it, so later pushes get the diff-local pass alone.
      if grep -qF '<!-- concord-review:' <<<"$bodies"; then mode='diff'; else mode='broad'; fi
    fi

    echo "dispatch ($mode, $phase): $repo#$num @ ${sha:0:8} — $title"
    if [ -z "${DRY_RUN:-}" ]; then
      GH_TOKEN="$SELF_TOKEN" gh workflow run pr-review.yml --repo "$SELF" \
        -f repo="$repo" -f pr="$num" -f sha="$sha" -f mode="$mode" -f cmd_id="$cmd_id"
    fi
    started=$((started + 1))
  done < <(gh pr list --repo "$repo" --state open --limit 100 --json number,headRefOid,isDraft,title,updatedAt |
             jq -r --arg cutoff "$cutoff" \
               '.[] | select(.isDraft | not) | select(.updatedAt > $cutoff) | "\(.number)\t\(.headRefOid)\t\(.title)"')
done
done

echo "dispatched $started review(s)"
