#!/usr/bin/env bash
# check() takes assertions as text and evaluates them later, so they stay single-quoted.
# shellcheck disable=SC2016
# Runs review-one.sh against a fake gh, a fake review engine (node on PATH),
# and a local repository standing in for the reviewed one. Usage:
#   review-one.test.sh [path/to/review-one.sh]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${1:-$HERE/../review-one.sh}"
work=$(mktemp -d)
trap 'if [ -n "${KEEP:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi' EXIT
mkdir -p "$work/bin"

# The reviewed repository: main, and a pull request head one commit ahead.
repo="$work/upstream"
git init -q -b main "$repo"
printf 'one\ntwo\n' > "$repo/b.txt"
git -C "$repo" add b.txt
git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m base
echo change > "$repo/a.txt"
git -C "$repo" checkout -q -b feature
git -C "$repo" add a.txt
git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m change
SHA=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" update-ref refs/pull/1/head "$SHA"
git -C "$repo" checkout -q main

cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jq_expr=; args=()
while [ $# -gt 0 ]; do
  case "$1" in --jq) jq_expr=$2; shift 2 ;; --paginate) shift ;; *) args+=("$1"); shift ;; esac
done
set -- "${args[@]}"
out() { if [ -n "$jq_expr" ]; then jq -r "$jq_expr" <<<"$1"; else printf '%s\n' "$1"; fi; }
case "$*" in
  "auth setup-git") ;;
  "api user") echo reviewbot ;;
  "repo clone "*) git clone -q "$UPSTREAM" "$4" ;;
  *"--json baseRefName"*) out '{"baseRefName":"main"}' ;;
  *"--json title,body"*) out '{"title":"Add a","body":"The PR body says a.txt must exist."}' ;;
  *"--json closingIssuesReferences"*) out '{"closingIssuesReferences":[{"number":5,"repository":{"name":"private","owner":{"login":"other"}}}]}' ;;
  "issue view "*) echo "HTTP 404" >&2; exit 1 ;;
  *"/statuses/"*)
    all="$*"; state=${all#*state=}; state=${state%% *}
    # FLAKY_STATUS fails the first attempt to settle a final status.
    if [ -n "${FLAKY_STATUS:-}" ] && [ "$state" != pending ] && [ ! -e "$LOG.flaked" ]; then touch "$LOG.flaked"; exit 1; fi
    context=${all#*context=}; echo "${context%% -f *}" >> "$LOG.contexts"
    echo "status $state" >> "$LOG" ;;
  *"/issues/1/comments -f body="*) all="$*"; printf '%s\n' "${all#*body=}" > "$LOG.comment"; echo comment >> "$LOG" ;;
  *"/pulls/1/reviews --input -") cat > "$LOG.review"; echo review >> "$LOG" ;;
  *"content=+1"*) echo "+1" >> "$LOG" ;;
  *"content=eyes"*) echo 1 ;;
  "api repos/"*"/reactions") echo '[]' ;;
  *) ;;
esac
EOF
cat > "$work/bin/node" <<'EOF'
#!/usr/bin/env bash
# Stands in for the review engine: keeps the intent it was given and the
# configuration directory it would run Claude with, prints the result.
printf '%s\n' "${CLAUDE_CONFIG_DIR:-unset}" > "$LOG.config-dir"
printf '%s\n' "$*" > "$LOG.args"
printf '%s\n' "${OPENAI_API_KEY:-unset}" > "$LOG.openai-key"
ls -A "${CLAUDE_CONFIG_DIR:-/nonexistent}" > "$LOG.config-files" 2>&1 || true
while [ $# -gt 0 ]; do
  [ "$1" = --intent-file ] && cp "$2" "$LOG.intent"
  shift
done
printf '%s\n' "$ENGINE_RESULT"
EOF
chmod +x "$work/bin/gh" "$work/bin/node"

fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
run() {  # run <case> <engine result json>
  export LOG="$work/$1.log"; : > "$LOG"
  PATH="$work/bin:$PATH" UPSTREAM="$repo" ENGINE_RESULT="$2" REPO=o/r PR=1 SHA="$SHA" MODE=broad \
    GH_TOKEN=review-pat-secret CLAUDE_CODE_OAUTH_TOKEN=model-token-secret OPENAI_API_KEY=openai-key-secret \
    REVIEW_REPOS="${REVIEW_REPOS-o/other o/r}" \
    bash "$SCRIPT" >"$LOG.out" 2>&1 || true
}

run clean '{"decision":"review-only","round":1,"findings":[]}'
check "clean review is posted" 'grep -qx review "$LOG"'
check "clean review settles the status to success" '[ "$(grep ^status "$LOG" | tail -1)" = "status success" ]'
check "the marker records the commit and the mode that ran" '[ "$(jq -r .body "$LOG.review" | head -1)" = "<!-- concord-review: $SHA mode:broad -->" ]'
check "clean review leaves a thumbs-up" 'grep -qx "+1" "$LOG"'
check "an unreadable closing issue is named, not fatal" 'grep -q "other/private#5 (not readable" "$LOG.intent"'
check "the reviewer runs with its own Claude configuration directory" '[ "$(cat "$LOG.config-dir")" != unset ] && [ "$(cat "$LOG.config-dir")" != "$HOME/.claude" ]'
check "that directory holds no settings of the runner account" '[ ! -s "$LOG.config-files" ]'
check "the pull request body reaches the intent" 'grep -q "must exist" "$LOG.intent"'

run leak '{"decision":"review-only","round":1,"findings":[{"id":"correctness:x","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"token is model-token-secret","requirement":""}]}'
check "a review quoting a credential is not posted" '! grep -qx review "$LOG"'
check "a review quoting a credential ends in error" '[ "$(grep ^status "$LOG" | tail -1)" = "status error" ]'

run outside-diff '{"decision":"review-only","round":1,"findings":[{"id":"correctness:in","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"in the diff","requirement":""},{"id":"gate:cross-context:out","category":"cross-context","file":"b.txt","line":2,"span":"two","summary":"unchanged file","requirement":""}]}'
check "a finding on a changed line is posted inline" '[ "$(jq -c "[.comments[].path]" "$LOG.review")" = "[\"a.txt\"]" ]'
check "a finding outside the diff goes in the body" 'jq -r .body "$LOG.review" | grep -q "b.txt:2"'

FLAKY_STATUS=1 run flaky-status '{"decision":"review-only","round":1,"findings":[]}'
check "a failed attempt to settle the status is retried" '[ "$(grep ^status "$LOG" | tail -1)" = "status success" ]'

REVIEWER=codex run codex-leak '{"decision":"review-only","round":1,"findings":[{"id":"correctness:x","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"key is openai-key-secret","requirement":""}]}'
check "the codex reviewer is passed to the engine" 'grep -q -- "--reviewer codex" "$LOG.args"'
check "the codex reviewer does not receive the API key" '[ "$(cat "$LOG.openai-key")" = unset ]'
check "a review quoting the OpenAI key is not posted" '! grep -qx review "$LOG"'

CMD_ID=42 run requested '{"decision":"review-only","round":1,"findings":[]}'
check "every status uses the pull request's own context" '[ -s "$LOG.contexts" ] && ! grep -vx "concord/review (#1)" "$LOG.contexts"'

CMD_ID=42 run requested-fails '{"decision":"review-only","round":1,"findings":[{"id":"correctness:x","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"model-token-secret","requirement":""}]}'
check "a failed requested review leaves a marker naming the command" '[ "$(head -1 "$LOG.comment")" = "<!-- concord-review-failed: $SHA cmd:42 -->" ]'

REVIEW_REPOS="o/other" run outside-repos '{"decision":"review-only","round":1,"findings":[]}'
check "a repository outside REVIEW_REPOS is not touched" '[ ! -s "$LOG" ] && [ ! -e "$LOG.args" ]'

exit "$fail"
