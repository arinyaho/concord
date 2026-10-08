#!/usr/bin/env bash
# check() takes assertions as text and evaluates them later, so they stay single-quoted.
# shellcheck disable=SC2016
# Runs review-one.sh against a fake gh, a fake review engine (node on PATH),
# and a local repository standing in for the reviewed one. Usage:
#   review-one.test.sh [path/to/review-one.sh]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${1:-$HERE/../review-one.sh}"
REAL_NODE=$(command -v node)
export REAL_NODE INTENT_READER="$HERE/../../../plugins/concord/core/intent.js"
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
BASE_SHA=$(git -C "$repo" rev-parse main)
export SHA BASE_SHA
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
  *"--json headRefOid,baseRefOid,baseRefName,title,body,closingIssuesReferences"*)
    refs='{"closingIssuesReferences":[]}'
    case "${ISSUE_REF:-foreign}" in
      large) refs=$(cat "$ISSUE_CASE_DIR/refs.json") ;;
      local|unreadable) refs='{"closingIssuesReferences":[{"number":6,"repository":{"name":"r","owner":{"login":"o"}}}]}' ;;
      *) refs='{"closingIssuesReferences":[{"number":5,"repository":{"name":"private","owner":{"login":"other"}}}]}' ;;
    esac
    current_sha=$SHA
    if [ -n "${ADVANCE_BEFORE_REVIEW:-}" ]; then current_sha=bbbbbbbb2222; fi
    if [ -e "$LOG.args" ] && [ -n "${ADVANCE_HEAD:-}" ]; then current_sha=bbbbbbbb2222; fi
    body='The PR body says a.txt must exist.'
    if { [ -e "$LOG.args" ] && [ -n "${CHANGE_INTENT:-}" ]; } || { [ -e "$LOG.inline-failed" ] && [ -n "${CHANGE_INTENT_ON_FALLBACK:-}" ]; }; then body='new requirements'; fi
    jq --arg body "$body" --arg sha "$current_sha" --arg base "$BASE_SHA" '. + {headRefOid:$sha,baseRefOid:$base,baseRefName:"main",title:"Add a",body:$body}' <<< "$refs" ;;
  "api repos/"*"/compare/"*)
    if [ -e "$LOG.args" ] && [ -n "${CHANGE_BASE:-}" ]; then out '{"merge_base_commit":{"sha":"dddddddd4444"}}'; exit; fi
    out "{\"merge_base_commit\":{\"sha\":\"$BASE_SHA\"}}" ;;
  *"--json headRefOid"*)
    echo head-lookup >> "$LOG"
    if [ -e "$LOG.args" ] && [ -n "${HEAD_LOOKUP_FAIL:-}" ]; then exit 1; fi
    if { [ -e "$LOG.args" ] && [ -n "${ADVANCE_HEAD:-}" ]; } || { [ -e "$LOG.inline-failed" ] && [ -z "${CHANGE_INTENT_ON_FALLBACK:-}" ]; } || { [ -e "$LOG.review" ] && [ -n "${ADVANCE_AFTER_POST:-}" ]; }; then out '{"headRefOid":"bbbbbbbb2222"}'; else out "{\"headRefOid\":\"$SHA\"}"; fi ;;
  *"--json baseRefName"*) out '{"baseRefName":"main"}' ;;
  *"--json title,body"*) out '{"title":"Add a","body":"The PR body says a.txt must exist."}' ;;
  *"--json closingIssuesReferences"*)
    if [ "${ISSUE_REF:-foreign}" = large ]; then
      jq -r "$jq_expr" "$ISSUE_CASE_DIR/refs.json"
    elif [ "${ISSUE_REF:-foreign}" = local ] || [ "${ISSUE_REF:-foreign}" = unreadable ]; then
      out '{"closingIssuesReferences":[{"number":6,"repository":{"name":"r","owner":{"login":"o"}}}]}'
    else
      out '{"closingIssuesReferences":[{"number":5,"repository":{"name":"private","owner":{"login":"other"}}}]}'
    fi ;;
  "issue view "*)
    echo "$*" >> "$LOG.issue-views"
    if [ "${ISSUE_REF:-}" = large ]; then jq -r "$jq_expr" "$ISSUE_CASE_DIR/$3.json"; exit; fi
    if [ "${ISSUE_REF:-}" = unreadable ]; then echo "HTTP 404" >&2; exit 1; fi
    if [ "$5" = other/private ]; then
      out '{"number":5,"title":"Foreign requirement","body":"FOREIGN_BODY_SENTINEL"}'
    else
      out '{"number":6,"title":"Local requirement","body":"LOCAL_BODY_SENTINEL"}'
    fi ;;
  "api repos/"*"/commits/"*"/statuses?per_page=100")
    if { [ -e "$LOG.args" ] && [ -n "${NEWER_ATTEMPT:-}" ]; } || [ -n "${NEWER_BEFORE_PENDING:-}" ]; then
      out '[{"context":"concord/review (#1)","state":"pending","description":"attempt:123e4567-e89b-42d3-a456-426614174099 identity:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff queued broad","created_at":"2026-10-08T00:00:00Z"}]'
    elif [ -e "$LOG.latest-status" ]; then out "$(cat "$LOG.latest-status")"; else out '[]'; fi ;;
  *"/statuses/"*)
    all="$*"; state=${all#*state=}; state=${state%% *}
    # FLAKY_STATUS fails the first attempt to settle a final status.
    if [ -n "${FLAKY_STATUS:-}" ] && [ "$state" != pending ] && [ ! -e "$LOG.flaked" ]; then touch "$LOG.flaked"; exit 1; fi
    if [ -n "${FAIL_FINAL_STATUS:-}" ] && [ "$state" != pending ]; then echo "final status unavailable" >> "$LOG"; exit 1; fi
    context=${all#*context=}; echo "${context%% -f *}" >> "$LOG.contexts"
    description=${all#*description=}; echo "${description%% -f *}" >> "$LOG.descriptions"
    jq -n --arg description "$description" --arg state "$state" --arg context "${context%% -f *}" '[{context:$context,state:$state,description:$description,created_at:"2026-10-08T00:00:00Z"}]' > "$LOG.latest-status"
    echo "status $state" >> "$LOG" ;;
  *"/issues/1/comments -f body="*) all="$*"; printf '%s\n' "${all#*body=}" > "$LOG.comment"; echo comment >> "$LOG" ;;
  *"/pulls/1/reviews --input -")
    if [ -n "${ADVANCE_ON_FALLBACK:-}" ] && [ ! -e "$LOG.inline-failed" ]; then cat >/dev/null; touch "$LOG.inline-failed"; exit 1; fi
    cat > "$LOG.review"; echo review >> "$LOG" ;;
  "api -X DELETE "*"/reactions/1") echo clear-eyes >> "$LOG" ;;
  *"content=+1"*) echo "+1" >> "$LOG" ;;
  *"content=eyes"*) echo 1 ;;
  "api repos/"*"/reactions") echo '[]' ;;
  *) ;;
esac
EOF
cat > "$work/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Stands in for the review engine: keeps the intent it was given and the
# configuration directory it would run Claude with, prints the result.
if [ "${1:-}" = -e ]; then exec "$REAL_NODE" "$@"; fi
printf '%s\n' "${CLAUDE_CONFIG_DIR:-unset}" > "$LOG.config-dir"
printf '%s\n' "$*" > "$LOG.args"
printf '%s\n' "${OPENAI_API_KEY:-unset}" > "$LOG.openai-key"
ls -A "${CLAUDE_CONFIG_DIR:-/nonexistent}" > "$LOG.config-files" 2>&1 || true
while [ $# -gt 0 ]; do
  if [ "$1" = --intent-file ]; then
    cp "$2" "$LOG.intent"
    "$REAL_NODE" -e 'require(process.argv[1]).readIntentFile(process.argv[2])' "$INTENT_READER" "$2"
  fi
  shift
done
if [ -n "${CANCEL_REVIEW:-}" ]; then kill -TERM "$(cat "$LOG.worker-pid")"; fi
printf '%s\n' "$ENGINE_RESULT"
EOF
chmod +x "$work/bin/gh" "$work/bin/node"

fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
run() {  # run <case> <engine result json>
  export LOG="$work/$1.log"; : > "$LOG"
  PATH="$work/bin:$PATH" UPSTREAM="$repo" ENGINE_RESULT="$2" REPO=o/r PR=1 SHA="$SHA" MODE="${MODE_OVERRIDE-broad}" \
    GH_TOKEN=review-pat-secret CLAUDE_CODE_OAUTH_TOKEN=model-token-secret OPENAI_API_KEY=openai-key-secret \
    REVIEW_REPOS="${REVIEW_REPOS-o/other o/r}" ATTEMPT_ID="${ATTEMPT_ID_OVERRIDE-123e4567-e89b-42d3-a456-426614174000}" \
    bash "$SCRIPT" >"$LOG.out" 2>&1 &
  worker_pid=$!
  echo "$worker_pid" > "$LOG.worker-pid"
  wait "$worker_pid" || echo $? > "$LOG.exit"
}

run clean '{"decision":"review-only","round":1,"findings":[]}'
check "clean review is posted" 'grep -qx review "$LOG"'
check "clean review settles the status to success" '[ "$(grep ^status "$LOG" | tail -1)" = "status success" ]'
check "the marker records the commit and the mode that ran" 'jq -r .body "$LOG.review" | head -1 | grep -Eq "^<!-- concord-review: $SHA mode:broad base:$BASE_SHA intent:[0-9a-f]{64} -->$"'
check "a posted review records a separate attempt receipt" '[ "$(jq -r .body "$LOG.review" | sed -n 2p)" = "<!-- concord-review-attempt: 123e4567-e89b-42d3-a456-426614174000 -->" ]'
check "worker status descriptions carry its attempt" '! grep -v "^attempt:123e4567-e89b-42d3-a456-426614174000 " "$LOG.descriptions"'
check "clean review leaves a thumbs-up" 'grep -qx "+1" "$LOG"'
check "a foreign closing issue is named without its body" 'grep -q "other/private#5 (external issue; body omitted)" "$LOG.intent"'
check "foreign issue body is never fetched" '[ ! -e "$LOG.issue-views" ]'
check "foreign issue body cannot reach intent" '! grep -q "FOREIGN_BODY_SENTINEL" "$LOG.intent"'
check "foreign issue body cannot reach output" '! grep -q "FOREIGN_BODY_SENTINEL" "$LOG.out"'
check "the reviewer runs with its own Claude configuration directory" '[ "$(cat "$LOG.config-dir")" != unset ] && [ "$(cat "$LOG.config-dir")" != "$HOME/.claude" ]'
check "that directory holds no settings of the runner account" '[ ! -s "$LOG.config-files" ]'
check "the pull request body reaches the intent" 'grep -q "must exist" "$LOG.intent"'

ATTEMPT_ID_OVERRIDE=invalid run bad-attempt '{"decision":"review-only","round":1,"findings":[]}'
check "an invalid attempt is rejected before GitHub or model work" '[ -s "$LOG.exit" ] && [ ! -e "$LOG.review" ] && [ ! -e "$LOG.args" ]'
ATTEMPT_ID_OVERRIDE='' run direct-attempt '{"decision":"review-only","round":1,"findings":[]}'
check "a direct worker invocation generates an attempt" 'jq -r .body "$LOG.review" | sed -n 2p | grep -Eq "^<!-- concord-review-attempt: [0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$"'

ISSUE_REF=local run same-repo-issue '{"decision":"review-only","round":1,"findings":[]}'
check "same-repo issue is fetched" 'grep -q "issue view 6 --repo o/r" "$LOG.issue-views"'
check "same-repo issue body reaches intent" 'grep -q "LOCAL_BODY_SENTINEL" "$LOG.intent"'

ISSUE_REF=unreadable run unreadable-same-repo-issue '{"decision":"review-only","round":1,"findings":[]}'
check "an unreadable same-repo issue is fetched" 'grep -q "issue view 6 --repo o/r" "$LOG.issue-views"'
check "an unreadable same-repo issue is named without failing review" 'grep -q "o/r#6 (not readable" "$LOG.intent" && grep -qx review "$LOG"'

# Each issue body is individually small; their accumulated requirements cross
# the old 200 KB truncation point and then the engine's existing 256 KiB cap.
make_large_issues() {
  export ISSUE_CASE_DIR="$work/issues-$1"
  mkdir -p "$ISSUE_CASE_DIR"
  python3 - "$ISSUE_CASE_DIR" "$1" <<'PY'
import json, pathlib, sys
folder, count = pathlib.Path(sys.argv[1]), int(sys.argv[2])
refs = [{"number": n, "repository": {"name": "r", "owner": {"login": "o"}}} for n in range(6, 6 + count)]
(folder / "refs.json").write_text(json.dumps({"closingIssuesReferences": refs}))
for n in range(6, 6 + count):
    body = "x" * 55_000 + ("TRAILING_REQUIREMENT_SENTINEL" if n == 6 + count - 1 else "")
    (folder / f"{n}.json").write_text(json.dumps({"number": n, "title": f"Issue {n}", "body": body}))
PY
}
make_large_issues 4
ISSUE_REF=large run large-valid-intent '{"decision":"review-only","round":1,"findings":[]}'
check "a valid intent over 200 KB retains its last requirement" 'grep -q TRAILING_REQUIREMENT_SENTINEL "$LOG.intent"'
check "a valid intent over 200 KB posts its review" 'grep -qx review "$LOG"'

make_large_issues 5
ISSUE_REF=large run oversized-intent '{"decision":"review-only","round":1,"findings":[]}'
check "an intent over the engine cap posts no review or broad marker" '[ ! -e "$LOG.review" ] && ! grep -qx review "$LOG"'
check "an intent over the engine cap ends in error" '[ "$(grep ^status "$LOG" | tail -1)" = "status error" ]'

run leak '{"decision":"review-only","round":1,"findings":[{"id":"correctness:x","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"token is model-token-secret","requirement":""}]}'
check "a review quoting a credential is not posted" '! grep -qx review "$LOG"'
check "a review quoting a credential ends in error" '[ "$(grep ^status "$LOG" | tail -1)" = "status error" ]'

run outside-diff '{"decision":"review-only","round":1,"findings":[{"id":"correctness:in","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"in the diff","requirement":""},{"id":"gate:cross-context:out","category":"cross-context","file":"b.txt","line":2,"span":"two","summary":"unchanged file","requirement":""}]}'
check "a finding on a changed line is posted inline" '[ "$(jq -c "[.comments[].path]" "$LOG.review")" = "[\"a.txt\"]" ]'
check "a finding outside the diff goes in the body" 'jq -r .body "$LOG.review" | grep -q "b.txt:2"'

FLAKY_STATUS=1 run flaky-status '{"decision":"review-only","round":1,"findings":[]}'
check "a failed attempt to settle the status is retried" '[ "$(grep ^status "$LOG" | tail -1)" = "status success" ]'

FAIL_FINAL_STATUS=1 CMD_ID=42 run exhausted-final-status '{"decision":"review-only","round":1,"findings":[]}'
check "an exhausted final status leaves the posted review" 'grep -qx review "$LOG" && [ -s "$LOG.exit" ]'
check "an exhausted final status never publishes error or failed command marker" '! grep -qx "status error" "$LOG" && [ ! -e "$LOG.comment" ]'

REVIEWER=codex run codex-leak '{"decision":"review-only","round":1,"findings":[{"id":"correctness:x","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"key is openai-key-secret","requirement":""}]}'
check "the codex reviewer is passed to the engine" 'grep -q -- "--reviewer codex" "$LOG.args"'
check "the codex reviewer does not receive the API key" '[ "$(cat "$LOG.openai-key")" = unset ]'
check "a review quoting the OpenAI key is not posted" '! grep -qx review "$LOG"'

CMD_ID=42 run requested '{"decision":"review-only","round":1,"findings":[]}'
check "every status uses the PR-specific context" '[ -s "$LOG.contexts" ] && ! grep -vx "concord/review (#1)" "$LOG.contexts"'

CMD_ID=42 run requested-fails '{"decision":"review-only","round":1,"findings":[{"id":"correctness:x","category":"correctness","file":"a.txt","line":1,"span":"change","summary":"model-token-secret","requirement":""}]}'
check "a failed requested review leaves a marker naming the command" '[ "$(head -1 "$LOG.comment")" = "<!-- concord-review-failed: $SHA cmd:42 -->" ]'

REVIEW_REPOS="o/other" run outside-repos '{"decision":"review-only","round":1,"findings":[]}'
check "a repository outside REVIEW_REPOS is not touched" '[ ! -s "$LOG" ] && [ ! -e "$LOG.args" ]'

ADVANCE_HEAD=1 CMD_ID=43 run advanced-head '{"decision":"review-only","round":1,"findings":[]}'
check "an advanced head receives no review or thumbs-up" '[ ! -e "$LOG.review" ] && ! grep -qx "+1" "$LOG"'
check "a superseded review clears eyes and settles the old status" 'grep -qx clear-eyes "$LOG" && [ "$(grep ^status "$LOG" | tail -1)" = "status error" ]'
check "a superseded requested command stays eligible on the replacement" '[ ! -e "$LOG.comment" ]'

HEAD_LOOKUP_FAIL=1 run failed-head-lookup '{"decision":"review-only","round":1,"findings":[]}'
check "a failed final head lookup posts no review or thumbs-up" '[ ! -e "$LOG.review" ] && ! grep -qx "+1" "$LOG"'
check "a failed head lookup cleans up and leaves error" 'grep -qx clear-eyes "$LOG" && [ "$(grep ^status "$LOG" | tail -1)" = "status error" ]'
check "the head is checked after the engine runs" 'grep -qx head-lookup "$LOG"'

CHANGE_INTENT=1 run changed-intent '{"decision":"review-only","round":1,"findings":[]}'
check "changed intent at the same head prevents stale publication" '[ ! -e "$LOG.review" ] && ! grep -qx "+1" "$LOG"'
ADVANCE_BEFORE_REVIEW=1 run already-superseded '{"decision":"review-only","round":1,"findings":[]}'
check "an already-superseded dispatch runs no engine" '[ ! -e "$LOG.args" ] && [ ! -e "$LOG.review" ]'
ADVANCE_ON_FALLBACK=1 run advanced-on-fallback '{"decision":"review-only","round":1,"findings":[]}'
check "a fallback POST rechecks the head" '[ -e "$LOG.inline-failed" ] && [ ! -e "$LOG.review" ] && ! grep -qx "+1" "$LOG"'
ADVANCE_ON_FALLBACK=1 CHANGE_INTENT_ON_FALLBACK=1 run intent-changed-on-fallback '{"decision":"review-only","round":1,"findings":[]}'
check "a fallback POST rechecks the full review identity" '[ -e "$LOG.inline-failed" ] && [ ! -e "$LOG.review" ] && ! grep -qx "+1" "$LOG"'
CANCEL_REVIEW=1 CMD_ID=44 run canceled-request '{"decision":"review-only","round":1,"findings":[]}'
check "cancellation does not consume a requested command" '[ ! -e "$LOG.comment" ] && [ ! -e "$LOG.review" ]'

NEWER_ATTEMPT=1 ADVANCE_HEAD=1 run replaced-attempt '{"decision":"review-only","round":1,"findings":[]}'
check "old cleanup cannot overwrite a newer attempt on the same SHA" '! grep -qx "status error" "$LOG"'

NEWER_BEFORE_PENDING=1 run replaced-before-pending '{"decision":"review-only","round":1,"findings":[]}'
check "an old worker cannot replace a newer pending status" '! grep -q "status pending" "$LOG" && ! grep -q "status error" "$LOG"'
check "an old worker with a newer pending owner does not start review" '[ ! -e "$LOG.args" ] && [ ! -e "$LOG.review" ]'

CHANGE_BASE=1 run changed-base '{"decision":"review-only","round":1,"findings":[]}'
check "a changed merge base during review prevents publication" '[ ! -e "$LOG.review" ] && ! grep -qx "+1" "$LOG"'
ADVANCE_AFTER_POST=1 run head-after-post '{"decision":"review-only","round":1,"findings":[]}'
check "a changed head after durable publication receives no thumbs-up" '[ -e "$LOG.review" ] && ! grep -qx "+1" "$LOG" && [ "$(grep ^status "$LOG" | tail -1)" = "status success" ]'
export MODE_OVERRIDE=diff
run diff-pass '{"decision":"review-only","round":1,"findings":[]}'
unset MODE_OVERRIDE
check "a diff pass records identity without running intent gates" '[ -e "$LOG.review" ] && grep -q -- "--no-broad" "$LOG.args" && [ ! -e "$LOG.intent" ]'

exit "$fail"
