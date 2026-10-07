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
  # A poll that cannot list a repository fails rather than reporting nothing to do.
  # ponytail: the newest 1000 open pull requests per repository.
  prs=$(gh pr list --repo "$repo" --state open --limit 1000 --json number,headRefOid,isDraft,title,updatedAt)
  while IFS=$'\t' read -r num sha title; do
    [ -n "$num" ] || continue
    # A review of this commit is queued or running. Dispatching it again would
    # cancel that run, and a review longer than the poll interval never posts.
    # A commit status belongs to the commit, which other pull requests can share,
    # so it counts only when its description names this pull request. Without
    # the lookup there is no telling, so the pull request waits for the next poll.
    review_status=$(gh api "repos/$repo/commits/$sha/status?per_page=100" \
      --jq '[.statuses[] | select(.context == "concord/review")][0] | "\(.state)\t\(.updated_at)\t\(.description)"' 2>/dev/null) || continue
    IFS=$'\t' read -r state updated description <<<"$review_status"
    if ! grep -qE "\(#$num( cmd:[0-9]+)?\)$" <<<"$description"; then state=; fi
    if [ "$state" = pending ] && [[ "$updated" > "$running_cutoff" ]]; then continue; fi

    # Every page of the conversation; without it there is no telling whether
    # this commit was reviewed, so the pull request waits for the next poll.
    comments=$(gh api --paginate "repos/$repo/issues/$num/comments" --jq '.[]' 2>/dev/null | jq -s .) || continue
    reviews=$(gh api --paginate "repos/$repo/pulls/$num/reviews" --jq '.[]' 2>/dev/null | jq -s .) || continue
    # A marker counts only as the first line of a body this account posted:
    # the lines after it carry model-written finding text.
    markers=$(jq -rn --arg me "$ME" --argjson c "$comments" --argjson r "$reviews" '($c + $r)[]
                 | select(.user.login == $me) | .body // "" | split("\n")[0]
                 | select(startswith("<!-- concord-review:"))')

    # Commands from someone with a role on the repository, newest first. The
    # newest one not yet done runs: done means its review posted, or its own
    # review failed, which the error status names.
    cmd_id=; reviewer=-
    while IFS=$'\t' read -r id cmd_mode cmd_reviewer; do
      [ -n "$id" ] || continue
      grep -qF " cmd:$id -->" <<<"$markers" && continue
      [ "$state" = error ] && grep -qF " cmd:$id)" <<<"$description" && continue
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
    # This exact commit was already reviewed, automatically or on request.
    if grep -qE "^<!-- concord-review: $sha mode:(broad|diff)( cmd:[0-9]+)? -->$" <<<"$markers"; then continue; fi
    # The broad pass runs until one has completed on this pull request, then
    # later pushes get the diff-local pass alone.
    if grep -qF ' mode:broad' <<<"$markers"; then mode='diff'; else mode='broad'; fi
    automatic+=("$repo $num $sha $mode - - $title")
  done < <(jq -r --arg cutoff "$cutoff" \
             '.[] | select(.isDraft | not) | select(.updatedAt > $cutoff) | "\(.number)\t\(.headRefOid)\t\(.title)"' <<<"$prs")
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
    GH_TOKEN="$SELF_TOKEN" gh workflow run pr-review.yml --repo "$SELF" \
      -f repo="$repo" -f pr="$num" -f sha="$sha" -f mode="$mode" -f cmd_id="$cmd_id" -f reviewer="$reviewer"
    # Pending from the moment it is dispatched, so a run still waiting for a
    # runner is not dispatched again by the next poll.
    gh api -X POST "repos/$repo/statuses/$sha" -f context=concord/review \
      -f state=pending -f description="queued ($mode) (#$num${cmd_id:+ cmd:$cmd_id})" >/dev/null || true
  fi
  started=$((started + 1))
done

echo "dispatched $started review(s)"
