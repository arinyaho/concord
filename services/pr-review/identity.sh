#!/usr/bin/env bash
# Shared review inputs. Globals are consumed by scan.sh and review-one.sh.
# shellcheck disable=SC2034

review_hash() {
  node -e 'const c=require("node:crypto");const h=c.createHash("sha256");process.stdin.on("data",d=>h.update(d));process.stdin.on("end",()=>process.stdout.write(h.digest("hex")))'
}

# Collect the exact text a broad pass reads, including stable omission messages.
# Files keep arbitrarily large title/body/issue payloads out of argv.
review_snapshot() {
  local repo=$1 pr=$2 metadata=$3 intent=$4 issue_repo issue
  gh pr view "$pr" --repo "$repo" \
    --json headRefOid,baseRefOid,baseRefName,title,body,closingIssuesReferences > "$metadata" || return 1
  jq -e '(.headRefOid | type) == "string" and (.baseRefOid | type) == "string"
    and (.title | type) == "string" and (.body | type) == "string"
    and (.closingIssuesReferences | type) == "array"
    and all(.closingIssuesReferences[];
      (.number | type) == "number" and .number > 0 and .number == (.number | floor)
      and (.repository.name | type) == "string" and (.repository.owner.login | type) == "string")' "$metadata" >/dev/null || return 1
  SNAP_HEAD=$(jq -er '.headRefOid' "$metadata") || return 1
  SNAP_BASE_TIP=$(jq -er '.baseRefOid' "$metadata") || return 1
  [[ "$SNAP_HEAD" =~ ^[0-9a-f]{7,64}$ && "$SNAP_BASE_TIP" =~ ^[0-9a-f]{7,64}$ ]] || return 1
  SNAP_BASE=$(gh api "repos/$repo/compare/$SNAP_BASE_TIP...$SNAP_HEAD" --jq .merge_base_commit.sha) || return 1
  [[ "$SNAP_BASE" =~ ^[0-9a-f]{7,64}$ ]] || return 1
  jq -er '"# \(.title)\n\n\(.body)"' "$metadata" > "$intent" || return 1
  while read -r issue_repo issue; do
    [ -n "$issue_repo" ] || continue
    if [ "$issue_repo" != "$repo" ]; then
      printf '\n\n## Closes %s#%s (external issue; body omitted)\n' "$issue_repo" "$issue" >> "$intent"
    else
      gh issue view "$issue" --repo "$issue_repo" --json number,title,body \
        --jq '"\n\n## Closes \(.number): \(.title)\n\n\(.body)"' >> "$intent" 2>/dev/null \
        || printf '\n\n## Closes %s#%s (not readable with the review token)\n' "$issue_repo" "$issue" >> "$intent"
    fi
  done < <(jq -r '[.closingIssuesReferences[] | {repo: (.repository.owner.login + "/" + .repository.name), number}]
                   | sort_by(.repo, .number)[] | "\(.repo) \(.number)"' "$metadata")
  SNAP_INTENT=$(review_hash < "$intent") || return 1
  SNAP_ID=$(printf 'concord-review-v1\n%s\n%s\n%s\n' "$SNAP_HEAD" "$SNAP_BASE" "$SNAP_INTENT" | review_hash) || return 1
}

# Same SHA replacements share a required-status context. Return the latest
# paginated status with the scanner's timestamp/tie ordering.
review_latest_status() {
  local repo=$1 pr=$2 sha=$3
  gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" --jq '.[]' \
    | jq -s -Sc --arg context "concord/review (#$pr)" '
      [to_entries[] | select(.value.context == $context)]
      | sort_by(.value.created_at // .value.updated_at // "", -.key) | last | .value // {}'
}

# 0 = owns it, 2 = another attempt owns it, 1 = unavailable/unknown ownership.
review_owns_status() {
  local latest description
  latest=$(review_latest_status "$1" "$2" "$3") || return 1
  [ "$latest" != '{}' ] || return 3
  description=$(jq -r '.description // ""' <<< "$latest") || return 1
  [[ "$description" == attempt:* ]] || return 1
  if [[ "$description" == "attempt:$4 "* ]]; then return 0; else return 2; fi
}
