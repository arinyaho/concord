#!/usr/bin/env bash
# Reviews exactly one pull request with Concord's review engine in review-only
# mode and posts the verified findings as one review. One run per pull request,
# so GitHub cancels this run when a newer commit starts its own -- the signals
# below are cleaned up on the way out either way.
set -euo pipefail

: "${GH_TOKEN:?REVIEW_PAT is not set}"
: "${REPO:?}" "${PR:?}" "${SHA:?}" "${MODE:?}"
REVIEWER="${REVIEWER:-claude}"
case "$REVIEWER" in
  claude) : "${CLAUDE_CODE_OAUTH_TOKEN:?not set}" ;;
  codex) ;;   # the workflow logs Codex in before this runs
  *) echo "REVIEWER must be claude or codex, got $REVIEWER" >&2; exit 1 ;;
esac
case "$MODE" in broad) BROAD=--broad ;; diff) BROAD=--no-broad ;; *) echo "MODE must be broad or diff" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENGINE="$ROOT/plugins/concord-codex/bin/review-and-fix.js"

# Fixed per mode, not left to the reviewer to restate -- so it reads the same
# on every review and can't drift from what the mode actually does.
if [ "$MODE" = broad ]; then
  MODE_NOTE="reviewed by $REVIEWER: diff-local correctness + repo-wide gate (ac-coverage, design-conformance, cross-context, silent-gap)"
else
  MODE_NOTE="reviewed by $REVIEWER: diff-local correctness only (the repo-wide gate already ran on an earlier commit of this PR)"
fi
MARKER="<!-- concord-review: $SHA${CMD_ID:+ cmd:$CMD_ID} -->"
gh auth setup-git   # git itself does not read GH_TOKEN; the clone below needs the credential helper
ME=$(gh api user --jq .login)   # whose reactions are ours to clear

status() { gh api -X POST "repos/$REPO/statuses/$SHA" -f context=concord/review \
             -f state="$1" -f description="$2" >/dev/null 2>&1 || true; }

# 🚀 on the comment that asked, so the asker knows it was picked up.
[ -n "${CMD_ID:-}" ] && gh api -X POST "repos/$REPO/issues/comments/$CMD_ID/reactions" \
  -f content=rocket >/dev/null 2>&1 || true

# Clear the previous review's verdict before this one starts. A reaction is one
# per account per kind, so a 👍 left from an earlier commit is never overwritten
# -- it just sits there while the new review reports findings, and a reaction is
# the first thing someone skimming the PR sees.
unreact() {
  local id
  id=$(gh api "repos/$REPO/issues/$PR/reactions" \
         --jq ".[] | select(.user.login == \"$ME\" and .content == \"$1\") | .id" | head -1 || true)
  [ -n "$id" ] && gh api -X DELETE "repos/$REPO/issues/$PR/reactions/$id" >/dev/null 2>&1 || true
}
unreact '+1'

rid=$(gh api -X POST "repos/$REPO/issues/$PR/reactions" -f content=eyes --jq .id 2>/dev/null || true)
work=$(mktemp -d); state=$(mktemp -d)
cleanup() {
  [ -n "$rid" ] && gh api -X DELETE "repos/$REPO/issues/$PR/reactions/$rid" >/dev/null 2>&1 || true
  rm -rf "$work" "$state"
}
# Runs on a cancel (a newer commit superseded this review) as well as on success.
trap 'cleanup; status error "review did not complete"; exit' INT TERM
status pending "reviewing ($MODE, $REVIEWER)"

gh repo clone "$REPO" "$work" -- --depth 50 --no-single-branch >/dev/null
git -C "$work" fetch --depth 50 origin "pull/$PR/head" >/dev/null
git -C "$work" checkout -q -B "concord-pr-$PR" FETCH_HEAD
BASE="$(git -C "$work" merge-base origin/HEAD HEAD 2>/dev/null || git -C "$work" rev-parse origin/HEAD)"

# The reviewer never sees the review token: it reads the checkout, and only
# this script talks to GitHub.
result=$(cd "$work" && env -u GH_TOKEN -u GITHUB_TOKEN REVIEW_STATE_DIR="$state" \
  node "$ENGINE" "concord-pr-$PR" "$BASE" --review-only "$BROAD" --reviewer "$REVIEWER" \
    ${REVIEW_MODEL:+--reviewer-model "$REVIEW_MODEL"} ${REVIEW_EFFORT:+--reasoning-effort "$REVIEW_EFFORT"} \
  | tail -1) || result=''

if ! jq -e '.decision == "review-only" and (.findings | type == "array")' <<<"$result" >/dev/null 2>&1; then
  echo "review failed for $REPO#$PR: ${result:-the engine printed nothing}"
  cleanup; status error "review did not complete"; exit 1
fi

n=$(jq '.findings | length' <<<"$result")
files=$(git -C "$work" diff --name-only "$BASE" HEAD | wc -l | tr -d ' ')
if [ "$n" -eq 0 ]; then
  verdict="LGTM — no finding survived verification across $files changed file(s)."
else
  verdict=$(jq -r '[.findings[].category] | group_by(.) | map("\(length) \(.[0])") | join(", ")' <<<"$result")
fi
header="$MARKER
<!-- concord-review-findings: $n -->
$MODE_NOTE
$verdict"

# Inline where the finding has a line; GitHub rejects the whole review when a
# line is outside the diff, so on rejection every finding goes in the body.
review() {  # $1 = inline | body
  jq --arg sha "$SHA" --arg header "$header" --arg how "$1" '
    def text: "**\(.category)** \(.summary)" + (if .requirement != "" then "\n\n> \(.requirement)" else "" end) + "\n\n`\(.id)`";
    (if $how == "inline" then [.findings[] | select(.line != null)] else [] end) as $inline
    | ([.findings[] | select(($how != "inline") or (.line == null))]) as $rest
    | { commit_id: $sha, event: "COMMENT",
        body: ([$header] + ($rest | map("- `\(.file)\(if .line then ":\(.line)" else "" end)` " + text)) | join("\n\n")),
        comments: ($inline | map({ path: .file, line: .line, side: "RIGHT", body: text })) }' <<<"$result"
}
review inline | gh api -X POST "repos/$REPO/pulls/$PR/reviews" --input - >/dev/null 2>&1 \
  || review body | gh api -X POST "repos/$REPO/pulls/$PR/reviews" --input - >/dev/null \
  || { echo "posting the review failed for $REPO#$PR"; cleanup; status error "review did not post"; exit 1; }

cleanup
case "$n" in
  0) gh api -X POST "repos/$REPO/issues/$PR/reactions" -f content=+1 >/dev/null 2>&1 || true
     status success "no issues found" ;;
  1) status success "1 finding" ;;
  *) status success "$n findings" ;;
esac
