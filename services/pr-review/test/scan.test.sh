#!/usr/bin/env bash
# Runs scan.sh in dry-run mode against a fake gh and checks what it would
# dispatch for each pull request. Each case is one pull request in its own
# repository, so one case cannot hide another.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCAN="$HERE/../scan.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# The fake gh answers from fixture files under $FIXTURES/<owner_repo>/.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jq_expr=
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_expr=$2; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"
echo "$*" >> "$FIXTURES/calls.log"
repo_dir() { echo "$FIXTURES/${1//\//_}"; }
out() { if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$1"; else cat "$1"; fi; }
case "$1 $2" in
  "api user") echo reviewbot ;;
  "pr list") out "$(repo_dir "$4")/prs.json" ;;
  "pr view") f="$(repo_dir "$5")/convo.json"; [ -f "$f" ] || { echo "HTTP 502" >&2; exit 1; }; out "$f" ;;
  "workflow run"*) ;;
  "api -X POST repos/"*"/statuses/"*) ;;
  "api repos/"*)
    path=${2#repos/}; repo=${path%%/commits/*}
    f="$(repo_dir "$repo")/status.json"
    if [ -f "$f" ]; then out "$f"; else echo '{"statuses":[]}' > "$f.empty"; out "$f.empty"; fi ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/gh"

export FIXTURES="$work/fixtures"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
recent=$(date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)
earlier=$(date -u -d "20 minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-20M +%Y-%m-%dT%H:%M:%SZ)
old=$(date -u -d "2 hours ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)
SHA=aaaaaaaa1111
OTHER=bbbbbbbb2222

# fixture <case> <convo json or "fail"> [status json]
fixture() {
  local d="$FIXTURES/o_$1"
  mkdir -p "$d"
  printf '[{"number":1,"headRefOid":"%s","isDraft":false,"title":"t","updatedAt":"%s"}]\n' "$SHA" "$now" > "$d/prs.json"
  [ "$2" = fail ] || printf '%s\n' "$2" > "$d/convo.json"
  [ -z "${3:-}" ] || printf '%s\n' "$3" > "$d/status.json"
}
comment() { printf '{"author":{"login":"%s"},"authorAssociation":"%s","body":"%s","url":"https://x/pull/1#issuecomment-%s","createdAt":"%s"}' "$1" "$2" "$3" "$4" "${5:-$recent}"; }
review() { printf '{"author":{"login":"%s"},"body":"%s"}' "$1" "$2"; }
status() { printf '{"statuses":[{"context":"concord/review","state":"%s","updated_at":"%s"}]}' "$1" "$2"; }

fixture fresh '{"comments":[],"reviews":[]}'
fixture reviewed "{\"comments\":[],\"reviews\":[$(review reviewbot "<!-- concord-review: $SHA -->")]}"
fixture reviewed-on-request "{\"comments\":[],\"reviews\":[$(review reviewbot "<!-- concord-review: $SHA cmd:7 -->")]}"
fixture forged-marker "{\"comments\":[$(comment outsider NONE "<!-- concord-review: $SHA -->" 5)],\"reviews\":[]}"
fixture pushed-again "{\"comments\":[],\"reviews\":[$(review reviewbot "<!-- concord-review: $OTHER -->")]}"
fixture running '{"comments":[],"reviews":[]}' "$(status pending "$recent")"
fixture died-running '{"comments":[],"reviews":[]}' "$(status pending "$old")"
fixture failed '{"comments":[],"reviews":[]}' "$(status error "$recent")"
fixture failed-then-asked "{\"comments\":[$(comment alice MEMBER "@concord diff" 9 "$recent")],\"reviews\":[]}" "$(status error "$earlier")"
fixture asked-then-failed "{\"comments\":[$(comment alice MEMBER "@concord diff" 10 "$earlier")],\"reviews\":[]}" "$(status error "$recent")"
fixture marker-quoted-in-body "{\"comments\":[],\"reviews\":[$(review reviewbot "<!-- concord-review: $OTHER -->\\n- finding text <!-- concord-review: $SHA -->")]}"
fixture outsider-asks "{\"comments\":[$(comment outsider NONE "@concord broad" 11)],\"reviews\":[$(review reviewbot "<!-- concord-review: $SHA -->")]}"
fixture member-asks "{\"comments\":[$(comment alice MEMBER "@concord broad" 12)],\"reviews\":[$(review reviewbot "<!-- concord-review: $SHA -->")]}"
fixture fetch-fails fail

expect=(
  "fresh:broad"
  "reviewed:"
  "reviewed-on-request:"
  "forged-marker:broad"
  "pushed-again:diff"
  "running:"
  "died-running:broad"
  "failed:"
  "failed-then-asked:diff"
  "asked-then-failed:"
  "marker-quoted-in-body:diff"
  "outsider-asks:"
  "member-asks:broad"
  "fetch-fails:"
)

fail=0
for e in "${expect[@]}"; do
  name=${e%%:*}; want=${e#*:}
  got=$(PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 MAX_PER_RUN=5 \
          bash "$SCAN" 2>/dev/null | sed -n 's/^dispatch (\([a-z]*\), [a-z]*):.*/\1/p')
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want '${want:-no dispatch}', got '${got:-no dispatch}'"; fail=1; fi
done

scan() { PATH="$work/bin:$PATH" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 "$@" bash "$SCAN" 2>/dev/null | sed -n 's/^dispatch (\([a-z]*\), \([a-z]*\)): o\/\([a-z-]*\)#.*/\3:\1:\2/p'; }
got=$(scan env REPOS="o/fresh o/member-asks" MAX_PER_RUN=1)
if [ "$got" = "member-asks:broad:requested" ]; then echo "ok   a requested review goes before an automatic one"; else echo "FAIL a requested review goes before an automatic one: $got"; fail=1; fi
got=$(scan env REPOS="o/fresh o/member-asks" MANUAL_ONLY=1)
if [ "$got" = "member-asks:broad:requested" ]; then echo "ok   manual mode dispatches only requested reviews"; else echo "FAIL manual mode dispatches only requested reviews: $got"; fail=1; fi

# One poll reads each pull request's conversation once, however many passes it makes.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 bash "$SCAN" >/dev/null 2>&1
n=$(grep -c "^pr view" "$FIXTURES/calls.log" || true)
if [ "$n" = 1 ]; then echo "ok   one conversation read per pull request"; else echo "FAIL one conversation read per pull request: $n"; fail=1; fi

# A dispatched review is marked pending at once, so a run still queued is not dispatched again.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >/dev/null 2>&1
if grep -q "^api -X POST repos/o/fresh/statuses/$SHA .*state=pending" "$FIXTURES/calls.log" && grep -q "^workflow run" "$FIXTURES/calls.log"; then
  echo "ok   a dispatch marks the commit pending"; else echo "FAIL a dispatch marks the commit pending"; fail=1; fi

exit "$fail"
