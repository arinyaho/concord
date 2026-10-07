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
  codex) : "${OPENAI_API_KEY:?not set}" ;;   # the workflow logs Codex in with it before this runs
  *) echo "REVIEWER must be claude or codex, got $REVIEWER" >&2; exit 1 ;;
esac
case "$MODE" in broad) BROAD=--broad ;; diff) BROAD=--no-broad ;; *) echo "MODE must be broad or diff" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENGINE="$ROOT/plugins/concord-codex/bin/review-and-fix.js"

# Fixed per mode, not left to the reviewer to restate -- so it reads the same
# on every review and can't drift from what the mode actually does.
if [ "$MODE" = broad ]; then
  MODE_NOTE="reviewed by $REVIEWER: diff-local correctness + repo-wide gate (ac-coverage, design-conformance, cross-context, silent-gap, threat-model)"
else
  MODE_NOTE="reviewed by $REVIEWER: diff-local correctness only (the repo-wide gate already ran on an earlier commit of this PR)"
fi
# The marker records the commit and the pass that ran, so the poller knows
# whether this pull request has had its broad review.
MARKER="<!-- concord-review: $SHA mode:$MODE${CMD_ID:+ cmd:$CMD_ID} -->"
gh auth setup-git   # git itself does not read GH_TOKEN; the clone below needs the credential helper
ME=$(gh api user --jq .login)   # whose reactions are ours to clear

# Retried, because a status left pending makes the commit look under review.
# The description names the pull request and the command: other pull requests
# can share the commit, and the poller ties a failure to the command it ran for.
status() {
  local attempt
  for attempt in 1 2 3; do
    gh api -X POST "repos/$REPO/statuses/$SHA" -f context=concord/review \
      -f state="$1" -f description="$2 (#$PR${CMD_ID:+ cmd:$CMD_ID})" >/dev/null 2>&1 && return 0
    sleep "$attempt"
  done
  return 1
}

# 🚀 on the comment that asked, so the asker knows it was picked up.
if [ -n "${CMD_ID:-}" ]; then
  gh api -X POST "repos/$REPO/issues/comments/$CMD_ID/reactions" -f content=rocket >/dev/null 2>&1 || true
fi

# Clear the previous review's verdict before this one starts. A reaction is one
# per account per kind, so a 👍 left from an earlier commit is never overwritten
# -- it just sits there while the new review reports findings, and a reaction is
# the first thing someone skimming the PR sees.
unreact() {
  local id
  id=$(gh api --paginate "repos/$REPO/issues/$PR/reactions" \
         --jq ".[] | select(.user.login == \"$ME\" and .content == \"$1\") | .id" | head -1 || true)
  if [ -n "$id" ]; then gh api -X DELETE "repos/$REPO/issues/$PR/reactions/$id" >/dev/null 2>&1 || true; fi
}
unreact '+1'

rid=$(gh api -X POST "repos/$REPO/issues/$PR/reactions" -f content=eyes --jq .id 2>/dev/null || true)
work=$(mktemp -d); intent=$(mktemp); intent_full=$(mktemp); claude_config=$(mktemp -d); posted=
# Runs on every exit -- success, a failed command under set -e, or a cancel
# because a newer commit superseded this review. Only a posted review settles
# the status; anything else leaves it in error rather than pending.
finish() {
  if [ -n "$rid" ]; then gh api -X DELETE "repos/$REPO/issues/$PR/reactions/$rid" >/dev/null 2>&1 || true; fi
  rm -rf "$work" "$intent" "$intent_full" "$claude_config"
  [ -n "$posted" ] || status error "review did not complete" || true
}
trap finish EXIT
trap 'exit 130' INT TERM
status pending "reviewing ($MODE, $REVIEWER)" || true

# A full clone, so the merge base with the pull request's own base branch and
# every blob the review reads are local: the engine runs without the token and
# cannot fetch anything later.
gh repo clone "$REPO" "$work" -- --quiet
git -C "$work" fetch --quiet origin "pull/$PR/head"
# Review exactly the dispatched commit, even if the branch moved since.
git -C "$work" checkout -q -B "concord-pr-$PR" "$SHA"
base_ref=$(gh pr view "$PR" --repo "$REPO" --json baseRefName --jq .baseRefName)
BASE=$(git -C "$work" merge-base "origin/$base_ref" HEAD)

# The broad pass checks the change against what it was asked to do: the pull
# request's title and body and the issues it closes become the review intent.
# The diff-local pass on later pushes does not re-check requirements.
INTENT_ARGS=()
if [ "$MODE" = broad ]; then
  {
    gh pr view "$PR" --repo "$REPO" --json title,body --jq '"# \(.title)\n\n\(.body)"'
    gh pr view "$PR" --repo "$REPO" --json closingIssuesReferences \
      --jq '.closingIssuesReferences[] | "\(.repository.owner.login)/\(.repository.name) \(.number)"' |
      while read -r issue_repo issue; do
        # An issue the review token cannot read is named, not fatal.
        gh issue view "$issue" --repo "$issue_repo" --json number,title,body \
          --jq '"\n\n## Closes \(.number): \(.title)\n\n\(.body)"' 2>/dev/null \
          || printf '\n\n## Closes %s#%s (not readable with the review token)\n' "$issue_repo" "$issue"
      done
  } > "$intent_full"
  # Truncated after it is written: cutting the pipe would kill the writers
  # with SIGPIPE. The engine refuses intent over 256 KiB.
  head -c 200000 "$intent_full" > "$intent"
  INTENT_ARGS=(--intent-file "$intent")
fi

# The reviewer never sees the review token: it reads the checkout, and only
# this script talks to GitHub. The engine treats the checkout as untrusted and
# keeps the round in a throwaway state directory. An empty Claude configuration
# directory keeps the runner account's own allow-lists, hooks, MCP servers, and
# plugins away from a Claude reviewer; its OAuth token still comes from the
# environment. A Codex reviewer gets a CODEX_HOME of its own from the engine,
# holding only the login, and never sees the API key itself.
result=$(cd "$work" && env -u GH_TOKEN -u GITHUB_TOKEN -u OPENAI_API_KEY CLAUDE_CONFIG_DIR="$claude_config" \
  node "$ENGINE" "concord-pr-$PR" "$BASE" --review-only "$BROAD" --reviewer "$REVIEWER" ${INTENT_ARGS[@]+"${INTENT_ARGS[@]}"} \
    ${REVIEW_MODEL:+--reviewer-model "$REVIEW_MODEL"} \
  | tail -1) || result=''

if ! jq -e '.decision == "review-only" and (.findings | type == "array")' <<<"$result" >/dev/null 2>&1; then
  echo "review failed for $REPO#$PR: ${result:-the engine printed nothing}"
  exit 1
fi
# The findings are model output from a model that read untrusted files, so it
# can be led to quote a credential it can read. Never post one.
for secret in "$GH_TOKEN" "${CLAUDE_CODE_OAUTH_TOKEN:-}" "${OPENAI_API_KEY:-}"; do
  if [ -n "$secret" ] && grep -qF -- "$secret" <<<"$result"; then
    echo "review of $REPO#$PR quoted a credential; nothing was posted" >&2
    exit 1
  fi
done

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

# Inline only where the finding's line is inside a diff hunk: GitHub rejects
# the whole review when one inline comment falls outside them. If it rejects
# the review anyway, every finding goes in the body.
hunks=$(git -C "$work" diff -U3 "$BASE" HEAD | awk '
  /^\+\+\+ b\// { file = substr($0, 7) }
  /^@@ / { split($3, a, ","); start = substr(a[1], 2); len = (a[2] == "" ? 1 : a[2])
           if (len > 0) printf "%s\t%d\t%d\n", file, start, start + len - 1 }' |
  jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {file: .[0], from: (.[1] | tonumber), to: (.[2] | tonumber)})')
review() {  # $1 = inline | body
  jq --arg sha "$SHA" --arg header "$header" --arg how "$1" --argjson hunks "$hunks" '
    def text: "**\(.category)** \(.summary)" + (if .requirement != "" then "\n\n> \(.requirement)" else "" end) + "\n\n`\(.id)`";
    def in_diff: . as $f | $f.line != null and any($hunks[]; .file == $f.file and $f.line >= .from and $f.line <= .to);
    (if $how == "inline" then [.findings[] | select(in_diff)] else [] end) as $inline
    | ([.findings[] | select(($how != "inline") or (in_diff | not))]) as $rest
    | { commit_id: $sha, event: "COMMENT",
        body: ([$header] + ($rest | map("- `\(.file)\(if .line then ":\(.line)" else "" end)` " + text)) | join("\n\n")),
        comments: ($inline | map({ path: .file, line: .line, side: "RIGHT", body: text })) }' <<<"$result"
}
review inline | gh api -X POST "repos/$REPO/pulls/$PR/reviews" --input - >/dev/null 2>&1 \
  || review body | gh api -X POST "repos/$REPO/pulls/$PR/reviews" --input - >/dev/null \
  || { echo "posting the review failed for $REPO#$PR"; exit 1; }

posted=1
case "$n" in
  0) gh api -X POST "repos/$REPO/issues/$PR/reactions" -f content=+1 >/dev/null 2>&1 || true
     verdict_status="no issues found" ;;
  1) verdict_status="1 finding" ;;
  *) verdict_status="$n findings" ;;
esac
# The review is posted; a status that cannot be settled fails the job visibly.
status success "$verdict_status" || { echo "could not set the concord/review status for $REPO@$SHA" >&2; exit 1; }
