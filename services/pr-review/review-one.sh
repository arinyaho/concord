#!/usr/bin/env bash
# Reviews exactly one pull request with Concord's review engine in review-only
# mode and posts the verified findings as one review. One run per pull request,
# so GitHub cancels this run when a newer commit starts its own -- the signals
# below are cleaned up on the way out either way.
set -euo pipefail

: "${GH_TOKEN:?REVIEW_PAT is not set}"
: "${REPO:?}" "${PR:?}" "${SHA:?}" "${MODE:?}"
# A dispatch names any repository, but the review token may reach more than
# the configured ones, so only those are reviewed.
: "${REVIEW_REPOS:?set REVIEW_REPOS to the repositories this copy reviews}"
case " $REVIEW_REPOS " in
  *" $REPO "*) ;;
  *) echo "$REPO is not in REVIEW_REPOS" >&2; exit 1 ;;
esac
REVIEWER="${REVIEWER:-claude}"
case "$REVIEWER" in
  claude) : "${CLAUDE_CODE_OAUTH_TOKEN:?not set}" ;;
  codex) : "${OPENAI_API_KEY:?not set}" ;;   # the workflow logs Codex in with it before this runs
  *) echo "REVIEWER must be claude or codex, got $REVIEWER" >&2; exit 1 ;;
esac
case "$MODE" in broad) BROAD=--broad ;; diff) BROAD=--no-broad ;; *) echo "MODE must be broad or diff" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=services/pr-review/identity.sh
source "$ROOT/services/pr-review/identity.sh"
EXPECTED_ID="${IDENTITY:-}"
DIRECT_ATTEMPT=
if [ -z "${ATTEMPT_ID:-}" ]; then DIRECT_ATTEMPT=1; fi
if [ -n "$EXPECTED_ID" ] && [[ ! "$EXPECTED_ID" =~ ^[0-9a-f]{64}$ ]]; then
  echo "IDENTITY must be a SHA-256 hash" >&2; exit 1
fi
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
ATTEMPT_ID="${ATTEMPT_ID:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')}"
if [[ ! "$ATTEMPT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  echo "ATTEMPT_ID must be a UUID" >&2; exit 1
fi
ATTEMPT_ID="${ATTEMPT_ID,,}"
gh auth setup-git   # git itself does not read GH_TOKEN; the clone below needs the credential helper
ME=$(gh api user --jq .login)   # whose reactions are ours to clear

# Retried, because a status left pending makes the commit look under review.
# The context names the pull request, since other pull requests can share the commit.
status() {
  local attempt ownership description="attempt:$ATTEMPT_ID${IDENTITY:+ identity:$IDENTITY} $2"
  if [ "${#description}" -gt 140 ]; then echo "status description exceeds 140 characters" >&2; return 1; fi
  for attempt in 1 2 3; do
    ownership=0
    review_owns_status "$REPO" "$PR" "$SHA" "$ATTEMPT_ID" || ownership=$?
    if [ "$1" = pending ]; then
      # A dispatched attempt owns the pending status written by the scanner.
      # Refuse to overwrite a replacement or a status whose owner is unknown.
      case "$ownership" in
        0|3) ;;
        2)
          if [ -n "$DIRECT_ATTEMPT" ] && review_status_terminal "$REPO" "$PR" "$SHA"; then :
          else superseded=1; return 0
          fi ;;
        *) superseded=1; return 0 ;;
      esac
    else
      [ "$ownership" -ne 2 ] || return 0  # leave a replacement's status alone
      if [ "$ownership" -ne 0 ]; then sleep "$attempt"; continue; fi
    fi
    gh api -X POST "repos/$REPO/statuses/$SHA" -f "context=concord/review (#$PR)" \
      -f state="$1" -f description="$description" >/dev/null 2>&1 && return 0
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
work=$(mktemp -d); intent=$(mktemp); claude_config=$(mktemp -d); posted=; settled=; superseded=; snapshot=$(mktemp -d)
# Runs on every exit -- success, a failed command under set -e, or a cancel
# because a newer commit superseded this review. Only a posted review settles
# the status; anything else leaves it in error rather than pending.
finish() {
  if [ -n "$rid" ]; then gh api -X DELETE "repos/$REPO/issues/$PR/reactions/$rid" >/dev/null 2>&1 || true; fi
  rm -rf "$work" "$intent" "$claude_config" "$snapshot"
  if [ -n "$posted" ]; then
    # Publication is durable. If settlement failed, only retry success.
    [ -n "$settled" ] || status success "posted; recovery" || true
    return
  fi
  status error "incomplete" || true
  # A requested review that fails is marked done, so the poller does not run
  # the same command again on every poll or after the next push.
  if [ -n "${CMD_ID:-}" ] && [ -z "$superseded" ]; then
    gh api -X POST "repos/$REPO/issues/$PR/comments" -f body="<!-- concord-review-failed: $SHA cmd:$CMD_ID -->
The review requested in https://github.com/$REPO/pull/$PR#issuecomment-$CMD_ID did not complete. Comment the command again to retry." >/dev/null 2>&1 || true
  fi
}
trap finish EXIT
trap 'superseded=1; exit 130' INT TERM
review_snapshot "$REPO" "$PR" "$snapshot/pr.json" "$intent" || { echo "cannot read review inputs" >&2; exit 1; }
IDENTITY=$SNAP_ID
if [ "$SNAP_HEAD" != "$SHA" ] || { [ -n "$EXPECTED_ID" ] && [ "$EXPECTED_ID" != "$IDENTITY" ]; }; then
  superseded=1
  # The error belongs to the dispatched inputs, not a replacement snapshot.
  IDENTITY=$EXPECTED_ID
  echo "review inputs superseded before execution" >&2; exit 1
fi
REVIEW_BASE=$SNAP_BASE
REVIEW_INTENT=$SNAP_INTENT
BASE_TIP=$SNAP_BASE_TIP
MARKER="<!-- concord-review: $SHA mode:$MODE base:$REVIEW_BASE intent:$REVIEW_INTENT${CMD_ID:+ cmd:$CMD_ID} -->"
status pending "reviewing $MODE" || true
[ -z "$superseded" ] || { echo "another review attempt owns the status" >&2; exit 1; }

# A full clone, so the merge base with the pull request's own base branch and
# every blob the review reads are local: the engine runs without the token and
# cannot fetch anything later.
gh repo clone "$REPO" "$work" -- --quiet
git -C "$work" fetch --quiet origin "pull/$PR/head"
# Review exactly the dispatched commit, even if the branch moved since.
git -C "$work" checkout -q -B "concord-pr-$PR" "$SHA"
git -C "$work" fetch --quiet origin "$BASE_TIP"
BASE=$(git -C "$work" merge-base "$BASE_TIP" HEAD)
[ "$BASE" = "$REVIEW_BASE" ] || { echo "local merge base differs from review snapshot" >&2; exit 1; }

# Identity includes requirements even on a diff pass, but only broad sends them
# to the gate. The collector's exact bytes are the hash's input.
INTENT_ARGS=()
if [ "$MODE" = broad ]; then INTENT_ARGS=(--intent-file "$intent"); fi

# The reviewer never sees the review token: it reads the checkout, and only
# this script talks to GitHub. The engine treats the checkout as untrusted and
# keeps the round in a throwaway state directory. An empty Claude configuration
# directory keeps the runner account's own allow-lists, hooks, MCP servers, and
# plugins away from a Claude reviewer; its OAuth token still comes from the
# environment. A Codex reviewer gets a CODEX_HOME of its own from the engine,
# holding only the login; its shell is denied access to that auth file.
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
<!-- concord-review-attempt: $ATTEMPT_ID -->
<!-- concord-review-identity: $IDENTITY -->
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
# Re-read all protected inputs before publication, then head immediately before
# each POST. A fallback is a separate POST and must pass the same head guard.
review_snapshot "$REPO" "$PR" "$snapshot/final-pr.json" "$snapshot/final-intent.md" \
  || { echo "cannot refresh review inputs before publication" >&2; exit 1; }
if [ "$SNAP_ID" != "$IDENTITY" ]; then
  superseded=1; echo "review inputs superseded during execution" >&2; exit 1
fi
current_head() {
  local head
  head=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid) || return 1
  if [ "$head" != "$SHA" ]; then superseded=1; return 1; fi
}
current_head || { echo "head changed or unavailable before publication" >&2; exit 1; }
if ! review inline | gh api -X POST "repos/$REPO/pulls/$PR/reviews" --input - >/dev/null 2>&1; then
  review_snapshot "$REPO" "$PR" "$snapshot/fallback-pr.json" "$snapshot/fallback-intent.md" \
    || { echo "cannot refresh review inputs before fallback publication" >&2; exit 1; }
  if [ "$SNAP_ID" != "$IDENTITY" ]; then
    superseded=1; echo "review inputs superseded before fallback publication" >&2; exit 1
  fi
  current_head || { echo "head changed or unavailable before fallback publication" >&2; exit 1; }
  review body | gh api -X POST "repos/$REPO/pulls/$PR/reviews" --input - >/dev/null \
    || { echo "posting the review failed for $REPO#$PR"; exit 1; }
fi

posted=1
case "$n" in
  0) if current_head; then gh api -X POST "repos/$REPO/issues/$PR/reactions" -f content=+1 >/dev/null 2>&1 || true; fi
     verdict_status="no issues found" ;;
  1) verdict_status="1 finding" ;;
  *) verdict_status="$n findings" ;;
esac
# The review is posted; a status that cannot be settled fails the job visibly.
status success "$verdict_status" || { echo "could not set the concord/review status for $REPO@$SHA" >&2; exit 1; }
settled=1
