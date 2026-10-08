#!/usr/bin/env bash
# Runs scan.sh in dry-run mode against a fake gh and checks what it would
# dispatch for each pull request. Each case is one pull request in its own
# repository, so one case cannot hide another.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCAN="${SCAN_OVERRIDE:-$HERE/../scan.sh}"
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
repo_dir() {
  local LC_ALL=C
  local name=${1,,}
  echo "$FIXTURES/${name//\//_}"
}
if [ "$1" = api ] && [ "${2:-}" = -X ] && [ "${3:-}" = POST ]; then
  if [[ "${4:-}" == repos/*/statuses/* ]] && [ -n "${STATUS_POST_FAIL:-}" ]; then
    echo "status post failed" >&2; exit 1
  fi
  if [[ "${4:-}" == repos/*/statuses/* ]] && [ -n "${PERSIST_STATUS:-}" ]; then
    path=${4#repos/}; repo=${path%%/statuses/*}
    context=; state=; description=
    for arg in "$@"; do
      case "$arg" in context=*) context=${arg#context=} ;; state=*) state=${arg#state=} ;; description=*) description=${arg#description=} ;; esac
    done
    jq -n --arg context "$context" --arg state "$state" --arg description "$description" \
      --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '[{context:$context,state:$state,description:$description,created_at:$created}]' > "$(repo_dir "$repo")/status.json"
  fi
  exit 0
fi
out() { if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$1"; else cat "$1"; fi; }
case "$1 $2" in
  "api user") echo reviewbot ;;
  "pr list") f="$(repo_dir "$4")/prs.json"; [ -f "$f" ] || { echo "HTTP 401" >&2; exit 1; }; out "$f" ;;
  "pr view")
    f="$(repo_dir "$5")/prs.json"
    if [ -n "$jq_expr" ]; then jq -r ".[0] | $jq_expr" "$f"; else jq '.[0]' "$f"; fi ;;
  "issue view") f="$(repo_dir "$5")/issue.json"; [ -f "$f" ] || { echo "HTTP 404" >&2; exit 1; }; out "$f" ;;
  "api repos/"*"/compare/"*)
    path=${2#repos/}; repo=${path%%/compare/*}; f="$(repo_dir "$repo")/base.json"
    [ -f "$f" ] || printf '{"merge_base_commit":{"sha":"cccccccc3333"}}' > "$f"
    out "$f" ;;
  "workflow run"*)
    if [ -n "${WORKFLOW_FAIL:-}" ]; then
      repo=; pr=; sha=; identity=; cmd=; attempt_id=
      for arg in "$@"; do
        case "$arg" in repo=*) repo=${arg#repo=} ;; pr=*) pr=${arg#pr=} ;; sha=*) sha=${arg#sha=} ;; identity=*) identity=${arg#identity=} ;; cmd_id=*) cmd=${arg#cmd_id=} ;; attempt_id=*) attempt_id=${arg#attempt_id=} ;; esac
      done
      if [ -n "${WORKER_STATE:-}" ]; then
        jq --arg state "$WORKER_STATE" --arg description "attempt:$attempt_id identity:$identity worker progressed" \
          '.[0].state=$state | .[0].description=$description' "$(repo_dir "$repo")/status.json" > "$FIXTURES/advanced-status.json"
        mv "$FIXTURES/advanced-status.json" "$(repo_dir "$repo")/status.json"
      fi
      if [ -n "${REPLACE_BEFORE_DISPATCH_ERROR:-}" ]; then
        folder=$(repo_dir o/fresh)
        printf '[{"context":"concord/review (#1)","state":"pending","description":"attempt:123e4567-e89b-42d3-a456-426614174099 identity:%064d replacement","created_at":"2026-10-08T00:00:00Z"}]\n' 0 > "$folder/status.json"
      fi
      echo "workflow dispatch failed" >&2; exit 1
    fi ;;
  "run list") f="$FIXTURES/runs.json"; [ -e "$FIXTURES/runs.fail" ] && { echo "HTTP 502" >&2; exit 1; }
    # gh run list applies --limit before --jq. The real 200-run window must
    # hide an active run at position 201 for this fixture to discriminate.
    if [ -n "$jq_expr" ]; then jq -r "$jq_expr" <(jq '.[0:200]' "$f"); else jq '.[0:200]' "$f"; fi ;;
  "api repos/o/self/actions/workflows/pr-review.yml/runs?per_page=100")
    [ -e "$FIXTURES/runs.fail" ] && { echo "HTTP 502" >&2; exit 1; }
    for page in $(seq 1 20); do
      [ "$page" -eq 1 ] || [ -n "$paginate" ] || break
      if [ "$page" -eq 2 ] && [ -e "$FIXTURES/runs-page2.fail" ]; then echo "HTTP 502 after page one" >&2; exit 1; fi
      if [ "$page" -eq 2 ] && [ -e "$FIXTURES/runs-page2.rate-limit" ]; then echo "HTTP 403 rate limit exceeded" >&2; exit 1; fi
      if [ "$page" -eq 2 ] && [ -e "$FIXTURES/runs-page2.malformed" ]; then
        printf '{"workflow_runs":"invalid"}\n' > "$FIXTURES/malformed.json"
        out "$FIXTURES/malformed.json"; exit
      fi
      f="$FIXTURES/runs-api-page$page.json"
      if [ "$page" -eq 1 ] && [ ! -f "$f" ] && [ -f "$FIXTURES/runs.json" ]; then
        jq '{workflow_runs: map({status, conclusion, display_title: .displayTitle})}' "$FIXTURES/runs.json" > "$FIXTURES/runs-fallback.json"
        f="$FIXTURES/runs-fallback.json"
      fi
      [ -f "$f" ] || break
      out "$f"
    done ;;
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
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OTHER=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# fixture <case> <comments json array or "fail"> <reviews json array> [status json]
fixture() {
  local d="$FIXTURES/o_$1"
  mkdir -p "$d"
  printf '[{"number":1,"headRefOid":"%s","baseRefName":"main","baseRefOid":"eeeeeeee5555","body":"body","closingIssuesReferences":[],"isDraft":false,"title":"t","updatedAt":"%s"}]\n' "$SHA" "$now" > "$d/prs.json"
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
current_intent=$(printf '# t\n\nbody\n' | node -e 'const c=require("node:crypto");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(c.createHash("sha256").update(s).digest("hex")))')
current_marker() { printf '<!-- concord-review: %s mode:%s base:cccccccc3333 intent:%s%s -->' "$SHA" "$1" "$current_intent" "${2:+ cmd:$2}"; }

fixture fresh '[]' '[]'
fixture reviewed '[]' "[$(review reviewbot "$(current_marker broad)")]"
fixture reviewed-on-request '[]' "[$(review reviewbot "$(current_marker diff 7)")]"
fixture broad-before-request '[]' "[$(review reviewbot "$(marker "$OTHER" broad)"),$(review reviewbot "$(current_marker diff 7)")]"
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
fixture command-word-prefix "[$(comment alice MEMBER "@concord difference of opinion" 14)]" "[$(review reviewbot "$(current_marker broad)")]"
fixture marker-quoted-in-body '[]' "[$(review reviewbot "$(marker "$OTHER" broad)\\n- finding text $(marker "$SHA" broad)")]"
fixture outsider-asks "[$(comment outsider NONE "@concord broad" 11)]" "[$(review reviewbot "$(current_marker broad)")]"
fixture member-asks "[$(comment alice MEMBER "@concord broad" 12)]" "[$(review reviewbot "$(current_marker broad)")]"
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
for state in pending error; do
  fixture "legacy-receipt-$state" '[]' "[$(review reviewbot "$receipt")]" "$(status "$state")"
  sed -i "s/$recent/$earlier/" "$FIXTURES/o_legacy-receipt-$state/status.json"
done
fixture legacy-older '[]' "[$(review reviewbot "$(marker "$SHA" broad)")]" "$(status error)"
sed -i "s/$recent/$earlier/" "$FIXTURES/o_legacy-older/reviews.json"
fixture legacy-malformed-attempt '[]' "[$(review reviewbot "$receipt")]" "$(status error 1 'attempt:invalid queued')"
sed -i "s/$recent/$earlier/" "$FIXTURES/o_legacy-malformed-attempt/status.json"
fixture page2-error '[]' '[]' "$(status success)"
sed -i "s/$recent/$earlier/" "$FIXTURES/o_page2-error/status.json"
printf '%s\n' "$(status error)" > "$FIXTURES/o_page2-error/status-page2.json"
fixture stale-posted '[]' "[$(review reviewbot "$receipt")]" "$(status pending 1 "attempt:$attempt queued")"
sed -i "s/\"updatedAt\":\"$now\"/\"updatedAt\":\"2000-01-01T00:00:00Z\"/" "$FIXTURES/o_stale-posted/prs.json"
fixture active-after-200 '[]' '[]'
for state in pending requested waiting; do fixture "active-$state" '[]' '[]'; done
fixture requested-terminal-failed "[$(comment alice MEMBER "@concord diff" 501)]" '[]' "$(status pending)"
fixture requested-terminal-new-head "[$(comment alice MEMBER "@concord diff" 502)]" '[]'
fixture requested-new-command "[$(comment alice MEMBER "@concord diff" 503)]" '[]'
fixture requested-legacy "[$(comment alice MEMBER "@concord diff" 504)]" '[]'
fixture automatic-terminal-failed '[]' '[]' "$(status pending)"
fixture automatic-terminal-new-head '[]' '[]'
fixture automatic-terminal-explicit "[$(comment alice MEMBER "@concord diff" 505)]" '[]'
fixture automatic-terminal-success '[]' '[]'
fixture earlier-failure-later-success '[]' '[]'
fixture exact-title-isolation '[]' '[]'
for conclusion in cancelled timed_out action_required neutral skipped stale mystery null; do fixture "automatic-$conclusion" '[]' '[]'; done
for state in queued in_progress pending requested waiting mystery; do fixture "extended-active-$state" '[]' '[]'; done
fixture active-after-1000 '[]' '[]'
fixture legacy-active-after-1000 '[]' '[]'
fixture terminal-before-worker "[$(comment alice MEMBER '@concord diff' 601)]" '[]'
fixture terminal-after-worker "[$(comment alice MEMBER '@concord diff' 602)]" '[]'
fixture terminal-new-command "[$(comment alice MEMBER '@concord diff' 603)]" '[]'
fixture terminal-other-repo '[]' '[]'
fixture terminal-other-pr '[]' '[]'
fixture terminal-other-sha '[]' '[]'
fixture legacy-terminal-failure '[]' '[]'


# Actions runs of pr-review.yml still queued or in progress, named by run-name.
printf '[{"status":"queued","displayTitle":"review o/running#1 @ %s"},{"status":"in_progress","displayTitle":"review o/running-other-pr#2 @ %s"},{"status":"completed","displayTitle":"review o/died-running#1 @ %s"}]\n' "$SHA" "$SHA" "$SHA" > "$FIXTURES/runs.json"
# More than 200 newer completed runs precede an older review still in progress.
# Dispatching active-after-200 would cancel the expensive original review.
jq --arg sha "$SHA" '. + ([range(0; 200) | {status:"completed", displayTitle:("review o/history#" + (.|tostring) + " @ " + $sha)}] + [{status:"in_progress", displayTitle:("review o/active-after-200#1 @ " + $sha)}] + (["pending","requested","waiting"] | map({status:., displayTitle:("review o/active-" + . + "#1 @ " + $sha)})))' "$FIXTURES/runs.json" > "$FIXTURES/runs.next.json"
mv "$FIXTURES/runs.next.json" "$FIXTURES/runs.json"
# Extended title fixtures follow the intended workflow run-name expression.
run_title() {
  python3 - "$HERE/../../../.github/workflows/pr-review.yml" "$1" "$2" "$3" "${4:-}" <<'PYTITLE'
import pathlib, sys
workflow, repo, sha, cmd, identity = sys.argv[1:]
line = next(line for line in pathlib.Path(workflow).read_text().splitlines() if line.startswith('run-name: '))
title = line.removeprefix('run-name: ')
for expression, value in (
    ('${{ inputs.repo }}', repo), ('${{ inputs.pr }}', '1'),
    ('${{ inputs.sha }}', sha),
    ("${{ inputs.identity && format(' identity:{0}', inputs.identity) || '' }}", f" identity:{identity}" if identity else ""),
    ("${{ inputs.cmd_id || '-' }}", cmd),
):
    title = title.replace(expression, value)
assert '${{' not in title, title
print(title)
PYTITLE
}
python3 - "$FIXTURES/runs.json" "$SHA" "$OTHER" <<'PYFIX'
import json, sys
path, sha, old = sys.argv[1:]
runs=json.load(open(path))
def add(repo, target, cmd, status, conclusion=None, legacy=False):
    title=f'review o/{repo}#1 @ {target}'
    if not legacy: title+=f' cmd:{cmd}'
    runs.append(dict(status=status, conclusion=conclusion, displayTitle=title))
add('requested-terminal-failed',sha,'501','completed','failure')
add('requested-terminal-new-head',old,'502','completed','cancelled')
add('requested-new-command',sha,'500','completed','failure')
add('requested-legacy',sha,'504','completed','failure',True)
add('automatic-terminal-failed',sha,'-','completed','failure')
add('automatic-terminal-new-head',old,'-','completed','failure')
add('automatic-terminal-explicit',sha,'-','completed','failure')
add('automatic-terminal-success',sha,'-','completed','success')
add('earlier-failure-later-success',sha,'-','completed','failure')
add('earlier-failure-later-success',sha,'506','completed','success')
for conclusion in ('cancelled','timed_out','action_required','neutral','skipped','stale','mystery',None):
    add(f'automatic-{conclusion if conclusion else "null"}',sha,'-','completed',conclusion)
for state in ('queued','in_progress','pending','requested','waiting','mystery'):
    add(f'extended-active-{state}',sha,'-',state,'success')
add('terminal-before-worker',sha,'601','completed','cancelled')
add('terminal-after-worker',sha,'602','completed','failure')
add('terminal-new-command',sha,'600','completed','cancelled')
add('terminal-other-repo',sha,'-', 'completed','failure')
runs[-1]['displayTitle']='review o/different-repo#1 @ '+sha+' cmd:-'
add('terminal-other-pr',sha,'-', 'completed','failure')
runs[-1]['displayTitle']='review o/terminal-other-pr#2 @ '+sha+' cmd:-'
add('terminal-other-sha',old,'-', 'completed','failure')
add('legacy-terminal-failure',sha,'-', 'completed','failure',True)
add('posted-pending',sha,'-', 'completed','failure')
for i in range(1001):
    runs.append(dict(status='completed',conclusion='success',displayTitle=f'review o/archive#{i+1} @ {sha} cmd:-'))
add('active-after-1000',sha,'-', 'in_progress')
add('legacy-active-after-1000',sha,'-', 'in_progress',legacy=True)
runs.append(dict(status='completed',conclusion='failure',displayTitle=f'review o/exact-title-isolation#1 @ {sha} cmd:- trailing'))
for name in ('active-after-1000', 'legacy-active-after-1000'):
    positions=[i for i, run in enumerate(runs) if run['displayTitle'].startswith(f'review o/{name}#1 @ ')]
    assert len(positions) == 1 and positions[0] > 1000, (name, positions)
    print(f'pagination index {name}={positions[0]}', flush=True)
json.dump(runs,open(path,'w'))
PYFIX
for page in $(seq 1 20); do
  jq --argjson start "$(((page - 1) * 100))" '{workflow_runs: [.[$start:($start + 100)][] | {status, conclusion, display_title:.displayTitle}]}' "$FIXTURES/runs.json" > "$FIXTURES/runs-api-page$page.json"
done

if [ -n "${PAGINATION_PROBE_ONLY:-}" ]; then
  probe_fail=0
  for name in active-after-1000 legacy-active-after-1000; do
    : > "$FIXTURES/calls.log"
    probe_exit=0
    probe_output=$(PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x \
      bash "$SCAN" 2>"$work/$name.probe.err") || probe_exit=$?
    probe_count=$(grep -c '^workflow run ' "$FIXTURES/calls.log" || true)
    if [ "$probe_exit" -eq 0 ] && [ "$probe_count" = "$PAGINATION_PROBE_ONLY" ] &&
       grep -Fq "dispatched $PAGINATION_PROBE_ONLY review(s)" <<<"$probe_output"; then
      echo "ok   $name probe exit=$probe_exit dispatch=$probe_count"
    else
      echo "FAIL $name probe exit=$probe_exit dispatch=$probe_count expected=$PAGINATION_PROBE_ONLY"
      probe_fail=1
    fi
  done
  exit "$probe_fail"
fi

expect=(
  "fresh:broad"
  "reviewed:"
  "reviewed-on-request:broad"
  "broad-before-request:broad"
  "forged-marker:broad"
  "pushed-again:broad"
  "running:"
  "active-after-200:"
  "active-pending:"
  "active-requested:"
  "active-waiting:"
  "requested-terminal-failed:"
  "requested-terminal-new-head:broad"
  "requested-new-command:diff"
  "requested-legacy:diff"
  "automatic-terminal-failed:"
  "automatic-terminal-new-head:broad"
  "automatic-terminal-explicit:diff"
  "automatic-terminal-success:broad"
  "earlier-failure-later-success:"
  "exact-title-isolation:broad"
  "active-after-1000:"
  "legacy-active-after-1000:"
  "terminal-before-worker:"
  "terminal-after-worker:"
  "terminal-new-command:diff"
  "terminal-other-repo:broad"
  "terminal-other-pr:broad"
  "terminal-other-sha:broad"
  "legacy-terminal-failure:"
  "died-running:"
  "failed:"
  "failed-then-asked:diff"
  "asked-then-failed:"
  "other-failure-after-ask:diff"
  "failed-other-pr:broad"
  "running-other-pr:broad"
  "command-failed-before-push:broad"
  "status-lookup-fails:"
  "command-word-prefix:"
  "marker-quoted-in-body:broad"
  "outsider-asks:"
  "member-asks:broad"
  "broad-never-ran:broad"
  "older-command-pending:diff"
  "fetch-fails:"
  "posted-pending:"
  "posted-new-command:diff"
  "posted-diff-needs-broad:broad"
  "older-receipt-new-attempt:broad"
  "same-second-receipt:broad"
  "foreign-receipt:broad"
  "malformed-receipt:broad"
  "legacy-tie:broad"
  "legacy-newer:broad"
  "page2-error:"
  "stale-posted:broad"
)

for conclusion in cancelled timed_out action_required neutral skipped stale mystery null; do expect+=("automatic-$conclusion:"); done
for state in queued in_progress pending requested waiting mystery; do expect+=("extended-active-$state:"); done
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

# A successful first page cannot authorize dispatch if a later page fails.
touch "$FIXTURES/runs-page2.fail"
: > "$FIXTURES/calls.log"
if PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >/dev/null 2>&1 || grep -q '^workflow run' "$FIXTURES/calls.log"; then
  echo "FAIL partial workflow inventory dispatched or passed"; fail=1
else echo "ok   partial workflow inventory fails before dispatch"; fi
rm "$FIXTURES/runs-page2.fail"
for failure in rate-limit malformed; do
  touch "$FIXTURES/runs-page2.$failure"
  : > "$FIXTURES/calls.log"
  if PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >/dev/null 2>&1 || grep -q '^workflow run' "$FIXTURES/calls.log"; then
    echo "FAIL $failure workflow inventory dispatched or passed"; fail=1
  else echo "ok   $failure workflow inventory fails before dispatch"; fi
  rm "$FIXTURES/runs-page2.$failure"
done

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
if ! grep -Eq '^(workflow run|api -X POST)' "$FIXTURES/calls.log"; then
  echo "ok   dry run performs no writes"
else echo "FAIL dry run wrote to GitHub"; fail=1; fi

# GitHub conversations can exceed the per-argument OS limit. Keep the payload
# in fixture files so only scan.sh's jq invocation can trigger E2BIG.
fixture large-reviewed '[]' '[]'
large_broad_marker=$(current_marker broad)
python3 - "$FIXTURES/o_large-reviewed" "$large_broad_marker" <<'PY'
import json, pathlib, sys
folder, marker = pathlib.Path(sys.argv[1]), sys.argv[2]
padding = "x" * 60_000
(folder / "comments.json").write_text(json.dumps([{"user": {"login": "outsider"}, "body": padding}] * 3))
(folder / "reviews.json").write_text(json.dumps(
    [{"user": {"login": "reviewbot"}, "body": marker}]
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
for name in legacy-tie legacy-newer legacy-receipt-pending legacy-receipt-error legacy-older legacy-malformed-attempt; do
  : > "$FIXTURES/calls.log"
  PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x MANUAL_ONLY=1 bash "$SCAN" >"$work/$name.out" 2>&1
  case "$name" in
    legacy-newer|legacy-receipt-pending|legacy-receipt-error)
      if grep -Fq "api -X POST repos/o/$name/statuses/$SHA -f context=concord/review (#1) -f state=success -f description=review posted" "$FIXTURES/calls.log" && ! grep -q '^workflow run' "$FIXTURES/calls.log"; then
        echo "ok   $name posts legacy success without dispatch"
      else echo "FAIL $name did not post legacy success or dispatched"; fail=1; fi ;;
    *)
      if ! grep -q 'state=success' "$FIXTURES/calls.log" && ! grep -q '^workflow run' "$FIXTURES/calls.log"; then
        echo "ok   $name does not settle or dispatch"
      else echo "FAIL $name settled or dispatched"; fail=1; fi ;;
  esac
done
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/page2-error" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/page2-error.out" 2>&1
if ! grep -q '^workflow run' "$FIXTURES/calls.log"; then echo "ok   a newer error on page two prevents retry"; else echo "FAIL page two error was hidden"; fail=1; fi
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/fresh-dispatch.out" 2>&1
if grep -q "^workflow run .*attempt_id=$" "$FIXTURES/calls.log"; then echo "FAIL dispatch omitted attempt id"; fail=1
elif grep -Eq '^workflow run .*attempt_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "$FIXTURES/calls.log" && grep -q 'description=attempt:' "$FIXTURES/calls.log"; then echo "ok   a dispatch propagates the attempt id"; else echo "FAIL dispatch lacks attempt id"; fail=1; fi

# Exercise a real worker failure before the later scanner poll. The observed
# nonzero worker exits, rather than invented outcomes, become Actions records.
if ! grep -Fq "cmd:\${{ inputs.cmd_id || '-' }}" "$HERE/../../../.github/workflows/pr-review.yml"; then
  echo "FAIL workflow run-name template lacks command identity"; fail=1
fi
worker_exit=0
worker_output=$(KEEP=1 bash "$HERE/review-one.test.sh" 2>&1) || worker_exit=$?
if [ "$worker_exit" -ne 0 ]; then
  echo "FAIL worker harness exited $worker_exit"
  grep '^FAIL' <<<"$worker_output" || true
  fail=1
fi
worker_dir=$(sed -n 's/^kept //p' <<<"$worker_output" | tail -1)
if [ -z "$worker_dir" ]; then echo "FAIL worker harness produced no observed records"; fail=1
else
  worker_sha=$(git -C "$worker_dir/upstream" rev-parse feature)
  worker_base=$(git -C "$worker_dir/upstream" rev-parse main)
  worker_identity=$(sed -n 's/.* identity:\([0-9a-f]\{64\}\) .*/\1/p' "$worker_dir/requested-fails.log.descriptions" | head -1)
  requested_log="$worker_dir/requested-fails-marker-unavailable.log"
  automatic_log="$worker_dir/automatic-fails-status-unavailable.log"
  if [ -s "$requested_log.exit" ] && [ ! -e "$requested_log.comment" ] &&
     [ -s "$automatic_log.exit" ] && [ "$(grep -c 'final status unavailable' "$automatic_log")" -eq 3 ]; then
    echo "ok   observed nonzero worker exits and failed completion writes"
    rm -f "$FIXTURES"/runs-api-page*.json
    for case_name in requested automatic; do
      name="worker-chain-$case_name"
      if [ "$case_name" = requested ]; then
        fixture "$name" "[$(comment alice MEMBER "@concord diff" 43)]" '[]' "$(status pending)"
        command_id=43
      else
        fixture "$name" '[]' '[]' "$(status pending)"
        command_id=-
      fi
      printf '{"workflow_runs":[{"status":"completed","conclusion":"failure","display_title":"%s"}]}\n' "$(run_title "o/$name" "$worker_sha" "$command_id" "$worker_identity")" > "$FIXTURES/runs-api-page1.json"
      printf '[{"status":"completed","conclusion":"failure","displayTitle":"%s"}]\n' "$(run_title "o/$name" "$worker_sha" "$command_id" "$worker_identity")" > "$FIXTURES/runs.json"
      jq -n --arg sha "$worker_sha" --arg base "$worker_base" --arg now "$now" \
        '[{number:1,headRefOid:$sha,baseRefOid:$base,baseRefName:"main",isDraft:false,
           title:"Add a",body:"The PR body says a.txt must exist.",updatedAt:$now,
           closingIssuesReferences:[{number:5,repository:{name:"private",owner:{login:"other"}}}]}]' \
        > "$FIXTURES/o_$name/prs.json"
      jq -n --arg base "$worker_base" '{merge_base_commit:{sha:$base}}' > "$FIXTURES/o_$name/base.json"
      : > "$FIXTURES/calls.log"
      scan_exit=0
      PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/$name.out" 2>&1 || scan_exit=$?
      if [ "$scan_exit" -ne 0 ]; then echo "FAIL $name later poll exited $scan_exit"; fail=1
      elif grep -q '^workflow run' "$FIXTURES/calls.log"; then echo "FAIL $name later poll redispatched observed failed worker"; fail=1
      else echo "ok   $name later poll did not redispatch"; fi
      printf '{"workflow_runs":[]}\n' > "$FIXTURES/runs-api-page1.json"
      control=$(PATH="$work/bin:$PATH" REPOS="o/$name" SELF=o/self GH_TOKEN=x SELF_TOKEN=x DRY_RUN=1 bash "$SCAN")
      if grep -q '^dispatched 1 review(s)$' <<<"$control"; then
        echo "ok   $name becomes eligible when its failure evidence is removed"
      else echo "FAIL $name was hidden by unrelated fixture state"; fail=1; fi
    done
  else echo "FAIL worker failure evidence missing"; fail=1; fi
  rm -rf "$worker_dir"
fi

# Repository spelling is API-insensitive, while retained titles keep the
# spelling used by the dispatch that created them. Test both lookup directions.
reset_inventory_pages() {
  rm -f "$FIXTURES"/runs-api-page*.json "$FIXTURES"/runs-page2.fail \
    "$FIXTURES"/runs-page2.rate-limit "$FIXTURES"/runs-page2.malformed
}
case_check() {
  local label=$1 configured=$2 retained=$3 evidence=$4 want=$5 locale=$6
  local d="$FIXTURES/acme_widget" output rc=0 count selected actual
  mkdir -p "$d"
  printf '[{"number":1,"headRefOid":"%s","baseRefName":"main","baseRefOid":"eeeeeeee5555","body":"body","closingIssuesReferences":[],"isDraft":false,"title":"t","updatedAt":"%s"}]\n' "$SHA" "$now" > "$d/prs.json"
  printf '[]\n' > "$d/reviews.json"
  printf '[]\n' > "$d/status.json"
  case "$evidence" in
    active-legacy|active-extended)
      printf '[%s]\n' "$(comment alice MEMBER '@concord diff' 701)" > "$d/comments.json"
      title="review $retained#1 @ $SHA"
      [ "$evidence" = active-legacy ] || title="$title cmd:701"
      run_status=in_progress; conclusion=null; manual=1 ;;
    consumed|consumed-current)
      printf '[%s]\n' "$(comment alice MEMBER '@concord diff' 701)" > "$d/comments.json"
      title="review $retained#1 @ $OTHER cmd:701"
      [ "$evidence" != consumed-current ] || title="review $retained#1 @ $SHA cmd:701"
      run_status=completed; conclusion=success; manual=1 ;;
    success-legacy|success-dash)
      printf '[]\n' > "$d/comments.json"
      title="review $retained#1 @ $SHA"
      [ "$evidence" != success-dash ] || title="$title cmd:-"
      run_status=completed; conclusion=success; manual= ;;
    failed-auto|failed-auto-legacy)
      printf '[]\n' > "$d/comments.json"
      printf '%s\n' "$(status pending)" > "$d/status.json"
      title="review $retained#1 @ $SHA"
      [ "$evidence" = failed-auto-legacy ] || title="$title cmd:-"
      run_status=completed; conclusion=failure; manual= ;;
    failed-requested)
      printf '[%s]\n' "$(comment alice MEMBER '@concord diff' 701)" > "$d/comments.json"
      title="review $retained#1 @ $SHA cmd:701"
      run_status=completed; conclusion=failure; manual= ;;
  esac
  title=${CASE_TITLE_OVERRIDE:-$title}
  reset_inventory_pages
  jq -n --arg status "$run_status" --arg conclusion "$conclusion" --arg title "$title" \
    '{workflow_runs:[{status:$status,conclusion:$conclusion,display_title:$title}]}' > "$FIXTURES/runs-api-page1.json"
  : > "$FIXTURES/calls.log"
  output=$(PATH="$work/bin:$PATH" LC_ALL="$locale" REPOS="$configured" SELF=o/self GH_TOKEN=x SELF_TOKEN=x \
    MANUAL_ONLY="$manual" bash "$SCAN" 2>"$work/case.err") || rc=$?
  if [ -s "$work/case.err" ]; then echo "ERROR $label: $(head -1 "$work/case.err")"; fail=1; fi
  count=$(grep -c '^workflow run ' "$FIXTURES/calls.log" || true)
  selected=$(sed -n 's/^workflow run .* -f cmd_id=\([^ ]*\) .*/\1/p' "$FIXTURES/calls.log")
  actual=$(sed -n 's/^dispatched \([0-9]*\) review(s)$/\1/p' <<<"$output")
  if [ "$rc" -eq 0 ] && [ "$count" = "$want" ] && [ "$actual" = "$want" ] &&
     { [ "$want" = 0 ] || [ "$selected" = "${CASE_COMMAND-701}" ]; }; then
    echo "ok   $label"
  else
    echo "FAIL $label: exit=$rc dispatch=$count reported=$actual command=$selected wanted=$want $(head -1 "$work/case.err")"
    fail=1
  fi
}
for locale in C C.utf8 en_US.utf8; do
  if ! locale -a | grep -Fxiq "$locale"; then echo "FAIL required locale $locale unavailable"; fail=1; continue; fi
  for direction in upper-retained upper-configured; do
    for component in owner repo both; do
      case "$component" in owner) mixed=Acme/widget ;; repo) mixed=acme/Widget ;; both) mixed=Acme/Widget ;; esac
      if [ "$direction" = upper-retained ]; then retained=$mixed; configured=acme/widget
      else retained=acme/widget; configured=$mixed; fi
      for evidence in active-legacy active-extended consumed failed-auto failed-requested; do
        case_check "$locale $direction $component $evidence" "$configured" "$retained" "$evidence" 0 "$locale"
      done
    done
  done
done
if locale -a | grep -Eiq '^tr_TR([.]|$)'; then
  case_check 'Turkish locale ASCII I' acme/widget Acme/WIDGET active-extended 0 "$(locale -a | grep -Ei '^tr_TR([.]|$)' | head -1)"
else echo 'SKIP Turkish locale unavailable'; fi
for locale in C C.utf8 en_US.utf8; do
  case_check "$locale uppercase ASCII I" acme/widget Acme/WIDGET active-extended 0 "$locale"
done
case_check 'successful decimal command consumes on current SHA' acme/widget Acme/Widget consumed-current 0 C
CASE_COMMAND=
case_check 'successful legacy completion does not suppress' acme/widget Acme/Widget success-legacy 1 C
case_check 'successful dash completion does not suppress' acme/widget Acme/Widget success-dash 1 C
unset CASE_COMMAND

# Repository punctuation and the other key fields retain exact identity.
for evidence in active-extended consumed failed-auto; do
  case "$evidence" in failed-auto) CASE_COMMAND= ;; *) CASE_COMMAND=701 ;; esac
  for different in owner repo punctuation pr sha command; do
    case "$different" in
      owner) alt=Other/Widget ;; repo) alt=Acme/Other ;; punctuation) alt=Acme/Widget.extra ;;
      *) alt=Acme/Widget ;;
    esac
    CASE_TITLE_OVERRIDE="review $alt#1 @ $SHA cmd:701"
    [ "$evidence" = failed-auto ] && CASE_TITLE_OVERRIDE="review $alt#1 @ $SHA cmd:-"
    case "$different" in
      pr) CASE_TITLE_OVERRIDE=${CASE_TITLE_OVERRIDE/\#1 /\#2 } ;;
      sha) [ "$evidence" = consumed ] && continue; CASE_TITLE_OVERRIDE=${CASE_TITLE_OVERRIDE/@ $SHA/@ $OTHER} ;;
      command) [ "$evidence" = consumed ] || continue; CASE_TITLE_OVERRIDE=${CASE_TITLE_OVERRIDE/cmd:701/cmd:702} ;;
    esac
    case_check "isolation $evidence $different" acme/widget "$alt" "$evidence" 1 C
  done
done
unset CASE_COMMAND CASE_TITLE_OVERRIDE

# A differently spelled active title beyond 200 newer records still wins.
reset_inventory_pages
printf '[%s]\n' "$(comment alice MEMBER '@concord diff' 701)" > "$FIXTURES/acme_widget/comments.json"
jq -n --arg sha "$SHA" '{workflow_runs:[range(0;100) | {status:"completed",conclusion:"success",display_title:("review archive/history#1 @ " + $sha + " cmd:-")}]} ' > "$FIXTURES/runs-api-page1.json"
cp "$FIXTURES/runs-api-page1.json" "$FIXTURES/runs-api-page2.json"
jq -n --arg sha "$SHA" '{workflow_runs:[{status:"in_progress",conclusion:null,display_title:("review Acme/Widget#1 @ " + $sha + " cmd:701")}]} ' > "$FIXTURES/runs-api-page3.json"
: > "$FIXTURES/calls.log"
rc=0
output=$(PATH="$work/bin:$PATH" REPOS=acme/widget SELF=o/self GH_TOKEN=x SELF_TOKEN=x MANUAL_ONLY=1 bash "$SCAN" 2>"$work/deep.err") || rc=$?
count=$(grep -c '^workflow run ' "$FIXTURES/calls.log" || true)
if [ "$rc" -eq 0 ] && [ "$count" = 0 ] && grep -q '^dispatched 0 review(s)$' <<<"$output" && [ ! -s "$work/deep.err" ]; then
  echo 'ok   mixed-case active title beyond 200 records suppresses explicit command'
else echo "FAIL mixed-case active title beyond 200 records: exit=$rc dispatch=$count"; fail=1; fi

# Eligible work retains configured spelling at every external boundary.
reset_inventory_pages
printf '{"workflow_runs":[]}\n' > "$FIXTURES/runs-api-page1.json"
: > "$FIXTURES/calls.log"
rc=0
output=$(PATH="$work/bin:$PATH" REPOS=AcMe/WiDgEt SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" 2>"$work/raw.err") || rc=$?
count=$(grep -c '^workflow run ' "$FIXTURES/calls.log" || true)
if [ "$rc" -eq 0 ] && [ "$count" = 1 ] && [ ! -s "$work/raw.err" ] &&
   grep -Fq 'dispatch (diff, requested, default): AcMe/WiDgEt#1' <<<"$output" &&
   grep -Fq 'pr list --repo AcMe/WiDgEt' "$FIXTURES/calls.log" &&
   grep -Fq 'api repos/AcMe/WiDgEt/commits/' "$FIXTURES/calls.log" &&
   grep -Fq 'workflow run pr-review.yml --repo o/self -f repo=AcMe/WiDgEt' "$FIXTURES/calls.log"; then
  echo 'ok   raw configured spelling reaches API, display, and dispatch'
else echo "FAIL raw configured spelling: exit=$rc dispatch=$count"; fail=1; fi

rm -f "$FIXTURES"/runs-api-page*.json "$FIXTURES"/runs-page2.*
printf '[]\n' > "$FIXTURES/runs.json"
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

# A dispatch error response is ambiguous; retain the claim for run reconciliation.
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x WORKFLOW_FAIL=1 bash "$SCAN" >"$work/workflow-fails.out" 2>&1 || true
if ! grep -q 'state=error' "$FIXTURES/calls.log" && grep -q 'state=pending' "$FIXTURES/calls.log"; then echo "ok   ambiguous dispatch leaves its claim pending"; else echo "FAIL ambiguous dispatch changed its claim"; fail=1; fi
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS="o/fresh" SELF=o/self GH_TOKEN=x SELF_TOKEN=x WORKFLOW_FAIL=1 REPLACE_BEFORE_DISPATCH_ERROR=1 bash "$SCAN" >"$work/replaced-workflow-fails.out" 2>&1 || true
if ! grep -q 'state=error' "$FIXTURES/calls.log"; then echo "ok   failed dispatch does not overwrite a replacement attempt"; else echo "FAIL failed dispatch overwrote a replacement status"; fail=1; fi

# A lost response must preserve even an eagerly progressing/completed worker.
for worker_state in pending success; do
  fixture "dispatch-worker-$worker_state" '[]' '[]'
  : > "$FIXTURES/calls.log"
  PATH="$work/bin:$PATH" REPOS="o/dispatch-worker-$worker_state" SELF=o/self GH_TOKEN=x SELF_TOKEN=x \
    PERSIST_STATUS=1 WORKFLOW_FAIL=1 WORKER_STATE="$worker_state" bash "$SCAN" >"$work/worker-$worker_state.out" 2>&1
  if ! grep -q 'state=error' "$FIXTURES/calls.log" && \
     [ "$(jq -r '.[0].state' "$FIXTURES/o_dispatch-worker-$worker_state/status.json")" = "$worker_state" ]; then
    echo "ok   ambiguous dispatch preserves same-attempt worker $worker_state"
  else echo "FAIL ambiguous dispatch overwrites worker $worker_state"; fail=1; fi
done

# Consecutive polls defer the same claim without restarting its grace clock.
fixture dispatch-grace '[]' '[]'
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS=o/dispatch-grace SELF=o/self GH_TOKEN=x SELF_TOKEN=x PERSIST_STATUS=1 WORKFLOW_FAIL=1 \
  bash "$SCAN" >"$work/grace-first.out" 2>&1
claim_before=$(cat "$FIXTURES/o_dispatch-grace/status.json")
for poll in 1 2; do
  : > "$FIXTURES/calls.log"
  PATH="$work/bin:$PATH" REPOS=o/dispatch-grace SELF=o/self GH_TOKEN=x SELF_TOKEN=x PERSIST_STATUS=1 \
    bash "$SCAN" >"$work/grace-$poll.out" 2>&1
  if ! grep -Eq '^(workflow run|api -X POST)' "$FIXTURES/calls.log" && \
     [ "$(cat "$FIXTURES/o_dispatch-grace/status.json")" = "$claim_before" ]; then
    echo "ok   grace poll $poll preserves the original attempt and timestamp"
  else echo "FAIL grace poll $poll repeats or renews the dispatch"; fail=1; fi
done
printf '[%s]\n' "$(comment alice MEMBER '@concord broad' 981)" > "$FIXTURES/o_dispatch-grace/comments.json"
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS=o/dispatch-grace SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/grace-command.out" 2>&1
if ! grep -q '^workflow run' "$FIXTURES/calls.log"; then echo "ok   a same-input command waits for the dispatch grace"; else echo "FAIL a command bypasses dispatch grace"; fail=1; fi

# Once a delayed run becomes visible it suppresses retry even after grace ends.
grace_identity=$(jq -r '.[0].description' "$FIXTURES/o_dispatch-grace/status.json" | sed -n 's/.* identity:\([0-9a-f]\{64\}\) .*/\1/p')
jq --arg created "$earlier" '.[0].created_at=$created' "$FIXTURES/o_dispatch-grace/status.json" > "$FIXTURES/grace-aged.json"
mv "$FIXTURES/grace-aged.json" "$FIXTURES/o_dispatch-grace/status.json"
reset_inventory_pages
jq -n --arg title "$(run_title o/dispatch-grace "$SHA" - "$grace_identity")" \
  '{workflow_runs:[{status:"in_progress",conclusion:null,display_title:$title}]}' > "$FIXTURES/runs-api-page1.json"
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS=o/dispatch-grace SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/grace-visible.out" 2>&1
if ! grep -q '^workflow run' "$FIXTURES/calls.log"; then echo "ok   a delayed visible run prevents retry after grace"; else echo "FAIL a delayed run is duplicated"; fail=1; fi
printf '{"workflow_runs":[]}\n' > "$FIXTURES/runs-api-page1.json"
: > "$FIXTURES/calls.log"
PATH="$work/bin:$PATH" REPOS=o/dispatch-grace SELF=o/self GH_TOKEN=x SELF_TOKEN=x bash "$SCAN" >"$work/grace-expired.out" 2>&1
if [ "$(grep -c '^workflow run' "$FIXTURES/calls.log" || true)" = 1 ] && grep -q 'cmd_id=981' "$FIXTURES/calls.log"; then
  echo "ok   expired grace permits one fresh attempt when full inventory has no run"
else echo "FAIL expired grace does not recover dispatch"; fail=1; fi
reset_inventory_pages

# A changed intent is a different review, and unknown timestamps cannot expire.
for case_name in grace-changed-intent grace-unknown-time; do
  fixture "$case_name" '[]' '[]' "$claim_before"
done
jq '.[0].body="changed requirements"' "$FIXTURES/o_grace-changed-intent/prs.json" > "$FIXTURES/changed-pr.json"
mv "$FIXTURES/changed-pr.json" "$FIXTURES/o_grace-changed-intent/prs.json"
jq '.[0].created_at="invalid"' "$FIXTURES/o_grace-unknown-time/status.json" > "$FIXTURES/unknown-status.json"
mv "$FIXTURES/unknown-status.json" "$FIXTURES/o_grace-unknown-time/status.json"
for e in grace-changed-intent:broad grace-unknown-time:; do
  name=${e%%:*}; want=${e#*:}; got=$(scan env REPOS="o/$name" | sed -n "s/^$name:\([^:]*\):.*/\1/p")
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want '$want', got '$got'"; fail=1; fi
done

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
