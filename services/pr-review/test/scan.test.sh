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
jq_expr=
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_expr=$2; shift 2 ;;
    --paginate) shift ;;
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
review() { printf '{"user":{"login":"%s"},"body":"%s"}' "$1" "$2"; }
# status <state> <updated_at> [description suffix, default "(#1)"]
status() { printf '{"statuses":[{"context":"concord/review","state":"%s","updated_at":"%s","description":"review %s"}]}' "$1" "$2" "${3:-(#1)}"; }
marker() { printf '<!-- concord-review: %s mode:%s%s -->' "$1" "$2" "${3:+ cmd:$3}"; }

fixture fresh '[]' '[]'
fixture reviewed '[]' "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture reviewed-on-request '[]' "[$(review reviewbot "$(marker "$SHA" diff 7)")]"
fixture forged-marker "[$(comment outsider NONE "$(marker "$SHA" broad)" 5)]" '[]'
fixture pushed-again '[]' "[$(review reviewbot "$(marker "$OTHER" broad)")]"
fixture broad-never-ran '[]' "[$(review reviewbot "$(marker "$OTHER" diff 4)")]"
fixture running '[]' '[]' "$(status pending "$recent")"
fixture died-running '[]' '[]' "$(status pending "$old")"
fixture failed '[]' '[]' "$(status error "$recent")"
fixture failed-then-asked "[$(comment alice MEMBER "@concord diff" 9 "$recent")]" '[]' "$(status error "$earlier")"
fixture asked-then-failed "[$(comment alice MEMBER "@concord diff" 10 "$earlier")]" '[]' "$(status error "$recent" "(#1 cmd:10)")"
fixture other-failure-after-ask "[$(comment alice MEMBER "@concord diff" 13 "$earlier")]" '[]' "$(status error "$recent")"
fixture failed-other-pr '[]' '[]' "$(status error "$recent" "(#2)")"
fixture running-other-pr '[]' '[]' "$(status pending "$recent" "(#2)")"
fixture status-lookup-fails '[]' '[]'
touch "$FIXTURES/o_status-lookup-fails/status.fail"
fixture command-word-prefix "[$(comment alice MEMBER "@concord difference of opinion" 14)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture marker-quoted-in-body '[]' "[$(review reviewbot "$(marker "$OTHER" broad)\\n- finding text $(marker "$SHA" broad)")]"
fixture outsider-asks "[$(comment outsider NONE "@concord broad" 11)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture member-asks "[$(comment alice MEMBER "@concord broad" 12)]" "[$(review reviewbot "$(marker "$SHA" broad)")]"
fixture older-command-pending "[$(comment alice MEMBER "@concord diff" 20 "$earlier"),$(comment bob MEMBER "@concord broad" 21 "$recent")]" "[$(review reviewbot "$(marker "$SHA" broad 21)")]"
fixture fetch-fails fail '[]'

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
  "other-failure-after-ask:diff"
  "failed-other-pr:broad"
  "running-other-pr:broad"
  "status-lookup-fails:"
  "command-word-prefix:"
  "marker-quoted-in-body:diff"
  "outsider-asks:"
  "member-asks:broad"
  "broad-never-ran:broad"
  "older-command-pending:diff"
  "fetch-fails:"
)

fail=0
for e in "${expect[@]}"; do
  name=${e%%:*}; want=${e#*:}
  got=$(PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 MAX_PER_RUN=5 \
          bash "$SCAN" 2>/dev/null | sed -n 's/^dispatch (\([a-z]*\), [a-z]*):.*/\1/p')
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want '${want:-no dispatch}', got '${got:-no dispatch}'"; fail=1; fi
done

# A poll that cannot list a repository's pull requests fails instead of reporting nothing to do.
if PATH="$work/bin:$PATH" REPOS="o/no-such-repo" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 bash "$SCAN" >/dev/null 2>&1; then
  echo "FAIL a failed pull request listing fails the poll"; fail=1; else echo "ok   a failed pull request listing fails the poll"; fi

scan() { PATH="$work/bin:$PATH" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 "$@" bash "$SCAN" 2>/dev/null | sed -n 's/^dispatch (\([a-z]*\), \([a-z]*\)): o\/\([a-z-]*\)#.*/\3:\1:\2/p'; }
got=$(scan env REPOS="o/fresh o/member-asks" MAX_PER_RUN=1)
if [ "$got" = "member-asks:broad:requested" ]; then echo "ok   a requested review goes before an automatic one"; else echo "FAIL a requested review goes before an automatic one: $got"; fail=1; fi
got=$(scan env REPOS="o/fresh o/member-asks" MANUAL_ONLY=1)
if [ "$got" = "member-asks:broad:requested" ]; then echo "ok   manual mode dispatches only requested reviews"; else echo "FAIL manual mode dispatches only requested reviews: $got"; fail=1; fi

# One poll reads each pull request's conversation once, however many passes it makes.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 bash "$SCAN" >/dev/null 2>&1
n=$(grep -c "/issues/1/comments" "$FIXTURES/calls.log" || true)
if [ "$n" = 1 ]; then echo "ok   one conversation read per pull request"; else echo "FAIL one conversation read per pull request: $n"; fail=1; fi

# A dispatched review is marked pending at once, so a run still queued is not dispatched again.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >/dev/null 2>&1
if grep -q "^api -X POST repos/o/fresh/statuses/$SHA .*state=pending" "$FIXTURES/calls.log" && grep -q "^workflow run" "$FIXTURES/calls.log"; then
  echo "ok   a dispatch marks the commit pending"; else echo "FAIL a dispatch marks the commit pending"; fail=1; fi

exit "$fail"
