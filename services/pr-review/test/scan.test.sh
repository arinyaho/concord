#!/usr/bin/env bash
# Runs scan.sh in dry-run mode against a fake gh and checks what it would
# dispatch for each pull request. Each case is one pull request in its own
# repository, so one case cannot hide another.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCAN="$HERE/../scan.sh"
work=$(mktemp -d)
trap 'if [ -n "${KEEP:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi' EXIT
mkdir -p "$work/bin"

# The fake gh answers from fixture files under $FIXTURES/<owner_repo>/.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jq_expr=; paginate=
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_expr=$2; shift 2 ;;
    --paginate) paginate=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"
echo "$*" >> "$FIXTURES/calls.log"
repo_dir() { echo "$FIXTURES/${1//\//_}"; }
out() { if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$1"; else cat "$1"; fi; }
case "$1 $2" in
  "api user") echo reviewbot ;;
  "pr list") f="$(repo_dir "$4")/prs.json"; [ -f "$f" ] || { echo "HTTP 401" >&2; exit 1; }; out "$f" ;;
  "workflow run"*) ;;
  "run list") f="$FIXTURES/runs.json"; [ -e "$FIXTURES/runs.fail" ] && { echo "HTTP 502" >&2; exit 1; }; out "$f" ;;
  "api -X POST repos/"*"/statuses/"*) ;;
  "api repos/"*"/issues/"*"/comments")
    path=${2#repos/}; f="$(repo_dir "${path%%/issues/*}")/comments.json"
    [ -f "$f" ] || { echo "HTTP 502" >&2; exit 1; }; out "$f" ;;
  "api repos/"*"/pulls/"*"/reviews")
    path=${2#repos/}; f="$(repo_dir "${path%%/pulls/*}")/reviews.json"; out "$f" ;;
  "api repos/"*)
    path=${2#repos/}; repo=${path%%/commits/*}
    f="$(repo_dir "$repo")/status.json"
    [ -e "$(repo_dir "$repo")/status.fail" ] && { echo "HTTP 502" >&2; exit 1; }
    [[ "$path" == */statuses?per_page=100 ]] && [ -n "$paginate" ] || { echo "status pagination required" >&2; exit 1; }
    if [ -f "$f" ]; then out "$f"; else echo '[]' > "$f.empty"; out "$f.empty"; fi
    if [ -f "$(repo_dir "$repo")/status-page2.json" ]; then out "$(repo_dir "$repo")/status-page2.json"; fi ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/gh"

export FIXTURES="$work/fixtures"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
recent=$(date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)
earlier=$(date -u -d "20 minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-20M +%Y-%m-%dT%H:%M:%SZ)
SHA=aaaaaaaa1111
OTHER=bbbbbbbb2222

# fixture <case> <comments json array or "fail"> <reviews json array> [status json]
fixture() {
  local d="$FIXTURES/o_$1"
  mkdir -p "$d"
  printf '[{"number":1,"headRefOid":"%s","isDraft":false,"title":"t","updatedAt":"%s"}]\n' "$SHA" "$now" > "$d/prs.json"
  [ "$2" = fail ] || printf '%s\n' "$2" > "$d/comments.json"
  printf '%s\n' "$3" > "$d/reviews.json"
  [ -z "${4:-}" ] || printf '%s\n' "$4" > "$d/status.json"
}
# REST shapes: issue comments and pull request reviews.
comment() { printf '{"user":{"login":"%s"},"author_association":"%s","body":"%s","id":%s,"created_at":"%s"}' "$1" "$2" "$3" "$4" "${5:-$recent}"; }
review() { printf '{"user":{"login":"%s"},"commit_id":"%s","submitted_at":"%s","body":"%s"}' "$1" "$SHA" "$recent" "$2"; }
# status <state> [pull request number, default 1]: the context is per pull request.
status() { printf '[{"context":"concord/review (#%s)","state":"%s","created_at":"%s","description":"%s"}]' "${2:-1}" "$1" "$recent" "${3:-}"; }
failed_marker() { printf '<!-- concord-review-failed: %s cmd:%s -->' "$1" "$2"; }
marker() { printf '<!-- concord-review: %s mode:%s%s -->' "$1" "$2" "${3:+ cmd:$3}"; }

fixture fresh '[]' '[]'
fixture reviewed '[]' "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture reviewed-on-request '[]' "[$(review reviewbot "$(marker "$SHA" diff 7)")]"
fixture broad-before-request '[]' "[$(review reviewbot "$(marker "$OTHER" broad)"),$(review reviewbot "$(marker "$SHA" diff 7)")]"
fixture forged-marker "[$(comment outsider NONE "$(marker "$SHA" broad)" 5)]" '[]'
fixture pushed-again '[]' "[$(review reviewbot "$(marker "$OTHER" broad)")]"
fixture broad-never-ran '[]' "[$(review reviewbot "$(marker "$OTHER" diff 4)")]"
fixture running '[]' '[]' "$(status pending)"
fixture died-running '[]' '[]' "$(status pending)"
fixture running-other-pr '[]' '[]'
fixture failed '[]' '[]' "$(status error)"
fixture failed-then-asked "[$(comment alice MEMBER "@concord diff" 9 "$recent")]" '[]' "$(status error)"
fixture asked-then-failed "[$(comment alice MEMBER "@concord diff" 10 "$earlier"),$(comment reviewbot NONE "$(failed_marker "$SHA" 10)" 99)]" '[]' "$(status error)"
fixture other-failure-after-ask "[$(comment alice MEMBER "@concord diff" 13 "$earlier")]" '[]' "$(status error)"
fixture command-failed-before-push "[$(comment alice MEMBER "@concord diff" 15 "$earlier"),$(comment reviewbot NONE "$(failed_marker "$OTHER" 15)" 98)]" '[]'
fixture failed-other-pr '[]' '[]' "$(status error 2)"
fixture status-lookup-fails '[]' '[]'
touch "$FIXTURES/o_status-lookup-fails/status.fail"
fixture command-word-prefix "[$(comment alice MEMBER "@concord difference of opinion" 14)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture marker-quoted-in-body '[]' "[$(review reviewbot "$(marker "$OTHER" broad)\\n- finding text $(marker "$SHA" broad)")]"
fixture outsider-asks "[$(comment outsider NONE "@concord broad" 11)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture member-asks "[$(comment alice MEMBER "@concord broad" 12)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture older-command-pending "[$(comment alice MEMBER "@concord diff" 20 "$earlier"),$(comment bob MEMBER "@concord broad" 21 "$recent")]" "[$(review reviewbot "$(marker "$SHA" broad 21)")]"
fixture asks-codex "[$(comment alice MEMBER "@concord broad codex" 30)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture asks-claude "[$(comment alice MEMBER "@concord diff claude" 31)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture asks-unknown-reviewer "[$(comment alice MEMBER "@concord diff gpt" 32)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture fetch-fails fail '[]'
attempt=123e4567-e89b-42d3-a456-426614174000
new_attempt=123e4567-e89b-42d3-a456-426614174001
receipt="$(marker "$SHA" broad)\\n<!-- concord-review-attempt: $attempt -->"
fixture posted-pending '[]' "[$(review reviewbot "$receipt")]" "$(status pending 1 "attempt:$attempt queued")"
fixture posted-new-command "[$(comment alice MEMBER "@concord diff" 81)]" "[$(review reviewbot "$receipt")]" "$(status pending 1 "attempt:$attempt queued")"
fixture posted-diff-needs-broad '[]' "[$(review reviewbot "$(marker "$SHA" diff)\\n<!-- concord-review-attempt: $attempt -->")]" "$(status pending 1 "attempt:$attempt queued")"
fixture older-receipt-new-attempt '[]' "[$(review reviewbot "$receipt")]" "$(status pending 1 "attempt:$new_attempt queued")"
fixture same-second-receipt '[]' "[$(review reviewbot "$receipt")]" "$(status pending 1 "attempt:$attempt queued")"
fixture foreign-receipt '[]' "[$(review outsider "$receipt")]" "$(status pending 1 "attempt:$attempt queued")"
fixture malformed-receipt '[]' "[$(review reviewbot "$(marker "$SHA" broad)\\n<!-- concord-review-attempt: invalid -->")]" "$(status pending 1 "attempt:$attempt queued")"
fixture legacy-tie '[]' "[$(review reviewbot "$(marker "$SHA" broad)")]" "$(status pending)"
fixture legacy-newer '[]' "[$(review reviewbot "$(marker "$SHA" broad)")]" "$(status pending)"
sed -i "s/$recent/$earlier/" "$FIXTURES/o_legacy-newer/status.json"
fixture page2-error '[]' '[]' "$(status success)"
sed -i "s/$recent/$earlier/" "$FIXTURES/o_page2-error/status.json"
printf '%s\n' "$(status error)" > "$FIXTURES/o_page2-error/status-page2.json"
fixture stale-posted '[]' "[$(review reviewbot "$receipt")]" "$(status pending 1 "attempt:$attempt queued")"
sed -i "s/\"updatedAt\":\"$now\"/\"updatedAt\":\"2000-01-01T00:00:00Z\"/" "$FIXTURES/o_stale-posted/prs.json"

# Actions runs of pr-review.yml still queued or in progress, named by run-name.
printf '[{"status":"queued","displayTitle":"review o/running#1 @ %s"},{"status":"in_progress","displayTitle":"review o/running-other-pr#2 @ %s"},{"status":"completed","displayTitle":"review o/died-running#1 @ %s"}]\n' "$SHA" "$SHA" "$SHA" > "$FIXTURES/runs.json"

expect=(
  "fresh:broad"
  "reviewed:"
  "reviewed-on-request:broad"
  "broad-before-request:"
  "forged-marker:broad"
  "pushed-again:diff"
  "running:"
  "died-running:broad"
  "failed:"
  "failed-then-asked:diff"
  "asked-then-failed:"
  "other-failure-after-ask:diff"
  "failed-other-pr:broad"
  "running-other-pr:broad"
  "command-failed-before-push:broad"
  "status-lookup-fails:"
  "command-word-prefix:"
  "marker-quoted-in-body:diff"
  "outsider-asks:"
  "member-asks:broad"
  "broad-never-ran:broad"
  "older-command-pending:diff"
  "fetch-fails:"
  "posted-pending:"
  "posted-new-command:diff"
  "posted-diff-needs-broad:broad"
  "older-receipt-new-attempt:"
  "same-second-receipt:"
  "foreign-receipt:broad"
  "malformed-receipt:"
  "legacy-tie:"
  "legacy-newer:"
  "page2-error:"
  "stale-posted:"
)

fail=0
for e in "${expect[@]}"; do
  name=${e%%:*}; want=${e#*:}
  got=$(PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 MAX_PER_RUN=5 \
          bash "$SCAN" 2>/dev/null | sed -n 's/^dispatch (\([a-z]*\), [a-z]*, [a-z]*):.*/\1/p')
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want '${want:-no dispatch}', got '${got:-no dispatch}'"; fail=1; fi
done

# A poll that cannot list a repository's pull requests fails instead of reporting nothing to do.
if PATH="$work/bin:$PATH" REPOS="o/no-such-repo" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 bash "$SCAN" >/dev/null 2>&1; then
  echo "FAIL a failed pull request listing fails the poll"; fail=1; else echo "ok   a failed pull request listing fails the poll"; fi

# Without the list of active review runs there is no telling what is in flight.
touch "$FIXTURES/runs.fail"
if PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 bash "$SCAN" >/dev/null 2>&1; then
  echo "FAIL a failed run listing fails the poll"; fail=1; else echo "ok   a failed run listing fails the poll"; fi
rm "$FIXTURES/runs.fail"

scan() { PATH="$work/bin:$PATH" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 "$@" bash "$SCAN" 2>/dev/null | sed -n 's/^dispatch (\([a-z]*\), \([a-z]*\), \([a-z]*\)): o\/\([a-z-]*\)#.*/\4:\1:\2:\3/p'; }
got=$(scan env REPOS="o/fresh o/member-asks" MAX_PER_RUN=1)
if [ "$got" = "member-asks:broad:requested:default" ]; then echo "ok   a requested review goes before an automatic one"; else echo "FAIL a requested review goes before an automatic one: $got"; fail=1; fi
got=$(scan env REPOS="o/fresh o/member-asks" MANUAL_ONLY=1)
if [ "$got" = "member-asks:broad:requested:default" ]; then echo "ok   manual mode dispatches only requested reviews"; else echo "FAIL manual mode dispatches only requested reviews: $got"; fail=1; fi
got=$(scan env REPOS="o/reviewed-on-request" MANUAL_ONLY=1)
if [ -z "$got" ]; then echo "ok   manual mode does not schedule a broad pass after requested diff"; else echo "FAIL manual mode scheduled $got"; fail=1; fi

# A command can name the reviewer; without one the copy's REVIEW_REVIEWER applies.
for e in asks-codex:broad:codex asks-claude:diff:claude asks-unknown-reviewer:diff:default member-asks:broad:default; do
  name=${e%%:*}; want=${e#*:}
  got=$(scan env REPOS="o/$name" | sed -n "s/^$name://p")
  if [ "$got" = "${want%%:*}:requested:${want#*:}" ]; then echo "ok   reviewer for $name"; else echo "FAIL reviewer for $name: want ${want}, got $got"; fail=1; fi
done
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/asks-codex" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >/dev/null 2>&1
if grep -q "^workflow run .*reviewer=codex" "$FIXTURES/calls.log"; then echo "ok   the named reviewer is dispatched"; else echo "FAIL the named reviewer is dispatched"; fail=1; fi

# One poll reads each pull request's conversation once, however many passes it makes.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 bash "$SCAN" >/dev/null 2>&1
n=$(grep -c "/issues/1/comments" "$FIXTURES/calls.log" || true)
if [ "$n" = 1 ]; then echo "ok   one conversation read per pull request"; else echo "FAIL one conversation read per pull request: $n"; fail=1; fi

# GitHub conversations can exceed the per-argument OS limit. Keep the payload
# in fixture files so only scan.sh's jq invocation can trigger E2BIG.
fixture large-reviewed '[]' '[]'
python3 - "$FIXTURES/o_large-reviewed" "$SHA" <<'PY'
import json, pathlib, sys
folder, sha = pathlib.Path(sys.argv[1]), sys.argv[2]
padding = "x" * 60_000
(folder / "comments.json").write_text(json.dumps([{"user": {"login": "outsider"}, "body": padding}] * 3))
(folder / "reviews.json").write_text(json.dumps(
    [{"user": {"login": "reviewbot"}, "body": f"<!-- concord-review: {sha} mode:broad -->"}]
    + [{"user": {"login": "reviewbot"}, "body": padding}] * 3
))
PY
if large_out=$(PATH="$work/bin:$PATH" REPOS="o/large-reviewed o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 MAX_PER_RUN=5 bash "$SCAN" 2>"$work/large-scan.err"); then
  if grep -q 'dispatch (broad, auto, default): o/fresh#1' <<<"$large_out" && ! grep -q 'dispatch .*o/large-reviewed#1' <<<"$large_out"; then
    echo "ok   a large reviewed conversation is skipped and the next pull request is scanned"
  else echo "FAIL a large reviewed conversation is skipped and the next pull request is scanned"; fail=1; fi
else echo "FAIL a large conversation aborts the poll: $(head -1 "$work/large-scan.err")"; fail=1; fi

# A dispatched review is marked pending at once, so a run still queued is not dispatched again.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >/dev/null 2>&1
if grep -q "^api -X POST repos/o/fresh/statuses/$SHA -f context=concord/review (#1) .*state=pending" "$FIXTURES/calls.log" && grep -q "^workflow run" "$FIXTURES/calls.log"; then
  echo "ok   a dispatch marks the commit pending"; else echo "FAIL a dispatch marks the commit pending"; fail=1; fi

# Settlement uses the posted attempt as durable evidence and never invokes a reviewer.
for name in posted-pending same-second-receipt stale-posted; do
  : > "$FIXTURES/calls.log"
  PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x MANUAL_ONLY=1 bash "$SCAN" >"$work/$name.out" 2>&1
  if grep -q "^api -X POST repos/o/$name/statuses/$SHA .*state=success .*description=attempt:$attempt " "$FIXTURES/calls.log" && ! grep -q '^workflow run' "$FIXTURES/calls.log"; then
    echo "ok   $name settles without dispatch"
  else echo "FAIL $name does not settle the posted attempt"; fail=1; fi
  if [ "$name" = stale-posted ] && grep -q '/issues/1/comments' "$FIXTURES/calls.log"; then echo "FAIL stale recovery fetched comments"; fail=1; fi
done
for name in older-receipt-new-attempt foreign-receipt malformed-receipt; do
  : > "$FIXTURES/calls.log"
  PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x MANUAL_ONLY=1 bash "$SCAN" >"$work/$name.out" 2>&1
  if ! grep -q 'state=success' "$FIXTURES/calls.log"; then echo "ok   $name cannot settle"; else echo "FAIL $name settled"; fail=1; fi
done
for name in legacy-tie legacy-newer; do
  : > "$FIXTURES/calls.log"
  PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x MANUAL_ONLY=1 bash "$SCAN" >"$work/$name.out" 2>&1
  if [ "$name" = legacy-tie ] && ! grep -q 'state=success' "$FIXTURES/calls.log"; then echo "ok   equal legacy timestamps do not settle"
  elif [ "$name" = legacy-newer ] && grep -q 'state=success' "$FIXTURES/calls.log"; then echo "ok   strictly newer legacy review settles"
  else echo "FAIL $name legacy settlement"; fail=1; fi
done
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/page2-error" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/page2-error.out" 2>&1
if ! grep -q '^workflow run' "$FIXTURES/calls.log"; then echo "ok   a newer error on page two prevents retry"; else echo "FAIL page two error was hidden"; fail=1; fi
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/fresh-dispatch.out" 2>&1
if grep -q "^workflow run .*attempt_id=$" "$FIXTURES/calls.log"; then echo "FAIL dispatch omitted attempt id"; fail=1
elif grep -Eq '^workflow run .*attempt_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "$FIXTURES/calls.log" && grep -q 'description=attempt:' "$FIXTURES/calls.log"; then echo "ok   a dispatch propagates the attempt id"; else echo "FAIL dispatch lacks attempt id"; fail=1; fi

exit "$fail"
