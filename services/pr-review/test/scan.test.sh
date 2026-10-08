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
  "issue view") f="$(repo_dir "$5")/issue.json"; out "$f" ;;
  "pr view") f="$(repo_dir "$5")/prs.json"; if [ -n "$jq_expr" ]; then jq -r ".[0] | $jq_expr" "$f"; else jq '.[0]' "$f"; fi ;;
  "api repos/"*"/compare/"*)
    path=${2#repos/}; repo=${path%%/compare/*}; f="$(repo_dir "$repo")/base.json"
    [ -f "$f" ] || printf '{"merge_base_commit":{"sha":"cccccccc3333"}}' > "$f"
    out "$f" ;;
  "workflow run"*) [ -z "${WORKFLOW_FAIL:-}" ] || { echo "workflow dispatch failed" >&2; exit 1; } ;;
  "run list") f="$FIXTURES/runs.json"; [ -e "$FIXTURES/runs.fail" ] && { echo "HTTP 502" >&2; exit 1; }; out "$f" ;;
  "api -X"*)
    if [[ "$*" == *"/statuses/"* ]]; then
      [ -z "${STATUS_POST_FAIL:-}" ] || { echo "status post failed" >&2; exit 1; }
    fi ;;
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
INTENT_HASH=$(printf '# t\n\nbody\n' | node -e 'const c=require("node:crypto");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(c.createHash("sha256").update(s).digest("hex")))')

# fixture <case> <comments json array or "fail"> <reviews json array> [status json]
fixture() {
  local d="$FIXTURES/o_$1"
  mkdir -p "$d"
  printf '[{"number":1,"headRefOid":"%s","isDraft":false,"baseRefName":"main","baseRefOid":"eeeeeeee5555","body":"body","closingIssuesReferences":[],"title":"t","updatedAt":"%s"}]\n' "$SHA" "$now" > "$d/prs.json"
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
marker() { printf '<!-- concord-review: %s mode:%s base:cccccccc3333 intent:%s%s -->' "$1" "$2" "$INTENT_HASH" "${3:+ cmd:$3}"; }

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
fixture stale-head-old-coverage '[]' "[$(review reviewbot "$(marker "$SHA" broad)")]"
sed -i "s/\"headRefOid\":\"$SHA\"/\"headRefOid\":\"$OTHER\"/; s/\"updatedAt\":\"$now\"/\"updatedAt\":\"2000-01-01T00:00:00Z\"/" "$FIXTURES/o_stale-head-old-coverage/prs.json"

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
  "stale-head-old-coverage:diff"
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
python3 - "$FIXTURES/o_large-reviewed" "$SHA" "$INTENT_HASH" <<'PY'
import json, pathlib, sys
folder, sha = pathlib.Path(sys.argv[1]), sys.argv[2]
padding = "x" * 60_000
(folder / "comments.json").write_text(json.dumps([{"user": {"login": "outsider"}, "body": padding}] * 3))
(folder / "reviews.json").write_text(json.dumps(
    [{"user": {"login": "reviewbot"}, "body": f"<!-- concord-review: {sha} mode:broad base:cccccccc3333 intent:{sys.argv[3]} -->"}]
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
elif grep -Eq '^workflow run .*attempt_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}( |$)' "$FIXTURES/calls.log" && grep -q 'description=attempt:' "$FIXTURES/calls.log"; then echo "ok   a dispatch propagates the attempt id"; else echo "FAIL dispatch lacks attempt id"; fail=1; fi


# Capture a trusted completion's metadata and replay it against edited PRs.
# Same head must no longer hide changed requirements or a changed reviewed diff.
fixture identity-seed '[]' '[]'
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/identity-seed" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" > "$work/seed.out" 2>&1
identity=$(sed -n 's/.* identity=\([^ ]*\).*/\1/p' "$FIXTURES/calls.log" | head -1)
base=cccccccc3333
intent=$(printf '# t\n\nbody\n' | node -e 'const c=require("node:crypto");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(c.createHash("sha256").update(s).digest("hex")))')
versioned_marker="<!-- concord-review: $SHA mode:broad base:$base intent:$intent -->"
for name in identity-unchanged retarget-changed retarget-same-diff changed-title changed-body; do
  fixture "$name" '[]' "[$(review reviewbot "$versioned_marker")]"
done
printf '{"merge_base_commit":{"sha":"dddddddd4444"}}' > "$FIXTURES/o_retarget-changed/base.json"
python3 - "$FIXTURES" <<'PYFIX'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
for name, key, value in [('retarget-changed','baseRefName','release'),('retarget-same-diff','baseRefName','release'),('changed-title','title','new title'),('changed-body','body','new requirements')]:
    p=root/f'o_{name}'/'prs.json'; prs=json.loads(p.read_text()); prs[0][key]=value;p.write_text(json.dumps(prs))
PYFIX
for e in identity-unchanged: retarget-changed:broad retarget-same-diff: changed-title:broad changed-body:broad; do
  name=${e%%:*}; want=${e#*:}
  got=$(scan env REPOS="o/$name" | sed -n "s/^$name:\([^:]*\):.*/\1/p")
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want '$want', got '$got'"; fail=1; fi
done
if [ -n "$identity" ]; then echo "ok   dispatch includes reviewed identity"; else echo "FAIL dispatch omits reviewed identity"; fail=1; fi

# The status claim must precede the dispatch so an eager worker sees its owner.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/order.out" 2>&1
dispatch_line=$(grep -n '^workflow run ' "$FIXTURES/calls.log" | cut -d: -f1 || true)
pending_line=$(grep -n 'api -X POST repos/o/fresh/statuses/' "$FIXTURES/calls.log" | cut -d: -f1 || true)
if [ -n "$dispatch_line" ] && [ -n "$pending_line" ] && [ "$pending_line" -lt "$dispatch_line" ]; then
  echo "ok   pending ownership is established before dispatch"
else
  echo "FAIL pending ownership is established before dispatch"; fail=1
fi

# A failed status claim must not launch a worker that will reject its own dispatch.
: > "$FIXTURES/calls.log"
if PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x STATUS_POST_FAIL=1 bash "$SCAN" >"$work/status-post-fails.out" 2>&1; then
  if grep -q '^workflow run ' "$FIXTURES/calls.log"; then echo "FAIL status failure still dispatched a worker"; fail=1
  else echo "ok   status failure prevents worker dispatch"; fi
else
  echo "FAIL status failure should defer dispatch without failing the poll"; fail=1
fi

# A dispatch failure after the status claim settles that exact attempt to error.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x WORKFLOW_FAIL=1 bash "$SCAN" >"$work/workflow-fails.out" 2>&1 || true
if grep -q 'state=error' "$FIXTURES/calls.log"; then echo "ok   failed dispatch settles its claimed status"; else echo "FAIL failed dispatch leaves a pending status"; fail=1; fi


# Only matching input identities suppress errors or active runs.
fixture failed-same-identity '[]' '[]' "$(status error 1 "attempt:$attempt identity:$identity failed")"
fixture failed-old-identity '[]' '[]' "$(status error 1 "attempt:$attempt identity:$(printf 'f%.0s' {1..64}) failed")"
fixture active-same-identity '[]' '[]'
fixture active-old-identity '[]' '[]'
python3 - "$FIXTURES/runs.json" "$SHA" "$identity" <<'PYRUN'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); runs=json.loads(p.read_text())
runs += [{"status":"in_progress","displayTitle":f"review o/active-same-identity#1 @ {sys.argv[2]} identity:{sys.argv[3]}"},
         {"status":"queued","displayTitle":f"review o/active-old-identity#1 @ {sys.argv[2]} identity:{'f'*64}"}]
p.write_text(json.dumps(runs))
PYRUN
for e in failed-same-identity: failed-old-identity:broad active-same-identity: active-old-identity:broad; do
  name=${e%%:*}; want=${e#*:}; got=$(scan env REPOS="o/$name" | sed -n "s/^$name:\([^:]*\):.*/\1/p")
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want '$want', got '$got'"; fail=1; fi
done

# Legacy head-only coverage must migrate once, while preserving old commands.
fixture legacy-completed '[]' "[$(review reviewbot "<!-- concord-review: $SHA mode:broad -->")]"
got=$(scan env REPOS=o/legacy-completed)
if [ "$got" = 'legacy-completed:broad:auto:default' ]; then echo "ok   legacy coverage refreshes once"; else echo "FAIL legacy coverage migration: $got"; fail=1; fi

# A closing issue edit can invalidate a broad pass without updating the PR.
issue_hash=$(printf '# t\n\nbody\n\n\n## Closes 6: Issue\n\nrequirements\n' | node -e 'const c=require("node:crypto");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(c.createHash("sha256").update(s).digest("hex")))')
for name in issue-unchanged issue-edited; do
  fixture "$name" '[]' "[$(review reviewbot "<!-- concord-review: $SHA mode:broad base:$base intent:$issue_hash -->")]"
  python3 - "$FIXTURES/o_$name/prs.json" "$name" <<'PYISSUE'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); data=json.loads(p.read_text()); repo=sys.argv[2]
data[0]['closingIssuesReferences']=[{'number':6,'repository':{'name':repo,'owner':{'login':'o'}}}]
data[0]['updatedAt']='2000-01-01T00:00:00Z'; p.write_text(json.dumps(data))
PYISSUE
  printf '{"number":6,"title":"Issue","body":"requirements"}' > "$FIXTURES/o_$name/issue.json"
done
printf '{"number":6,"title":"Issue","body":"changed requirements"}' > "$FIXTURES/o_issue-edited/issue.json"
for e in issue-unchanged: issue-edited:broad; do
  name=${e%%:*}; want=${e#*:}; got=$(scan env REPOS="o/$name" | sed -n "s/^$name:\([^:]*\):.*/\1/p")
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want '$want', got '$got'"; fail=1; fi
done

fixture malformed-intent '[]' '[]'
python3 - "$FIXTURES/o_malformed-intent/prs.json" <<'PYBAD'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);data=json.loads(p.read_text());data[0]['closingIssuesReferences']=None;p.write_text(json.dumps(data))
PYBAD
got=$(scan env REPOS=o/malformed-intent)
if [ -z "$got" ]; then echo "ok   malformed intent metadata defers dispatch"; else echo "FAIL malformed intent metadata dispatched $got"; fail=1; fi

exit "$fail"
