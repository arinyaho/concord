# Codex CLI end-to-end run — `review-until-green` converges under Codex (fix+commit leg)

Date: 2026-07-16

End-to-end validation for the Codex CLI adapter (see `2026-07-16-codex-review-until-green-adapter-design.md` and the spike findings in `2026-07-16-codex-spike-findings.md`). Drives the built plugin directly via the DIRECT-VERB path — no product code changed. Confirms `review-until-green` converges under a real Codex CLI (`codex-cli 0.144.5`), exercising the fix+commit leg (not just a review pass), with state under `~/.codex`.

## Outcome: CONVERGED

Full loop ran to a terminal `clean`/`converged: true` decision in 2 rounds, with a real fix committed by a `codex exec` subagent between them. No blockers.

## Setup

Scratch repo `/tmp/codex-e2e`:

- `main` (commit `eea9f57`): `review.config.json` = `{"dod":["true"]}` only.
- `e2e` (commit `8469d6f`, branched from `main`): adds `math.js` with a self-contained, obvious inverted-operator bug:
  ```js
  // add(a, b) should return the sum of its two arguments.
  function add(a, b) {
    return a - b;
  }

  module.exports = { add };
  ```

## Drive mechanics discovered (not previously documented)

Two `codex exec` flags were required beyond the driver doc's baseline invocation, both due to this being a non-interactive automation context rather than a Codex-trusted project:

1. **`--skip-git-repo-check`** — `/tmp/codex-e2e` is a real git repo but is not in `~/.codex/config.toml`'s `[projects."..."]` trust table (only paths under `/Users/inkme` are marked `trust_level = "trusted"`). Without this flag, `codex exec` printed `Not inside a trusted directory and --skip-git-repo-check was not specified.` and then blocked forever on `Reading additional input from stdin...` — a real hang risk for an unattended run since there is no TTY to answer the implicit approval prompt. Confirmed by a smoke test that had to be killed manually.
2. **`--add-dir <stateDir>`** — the workspace-write sandbox only grants write access to `--cd`'s workdir, `/tmp`, and `$TMPDIR` by default (confirmed via the run banner: `sandbox: workspace-write [workdir, /tmp, $TMPDIR]`). Since the CLI's real state dir lives under `~/.codex/concord/projects/<slug>/state` — outside both the repo and `/tmp` — every subagent asked to write an artifact there needed `--add-dir "$STATE"` or its writes would be rejected (`patch rejected: writing outside of the project`).

Working invocation shape used for every subagent in this run:
```
codex exec --skip-git-repo-check --cd /tmp/codex-e2e --add-dir "$STATE" --sandbox workspace-write "<prompt>"
```

**Orchestration bug found and fixed during the run (mine, not the product's):** the fix-artifact filename must embed the finding id **verbatim**, including its colon — `round-<n>-fix-<id>.json` for id `correctness:add-subtracts` is literally `round-1-fix-correctness:add-subtracts.json`. I first had the fix subagent write `round-1-fix-correctness-add-subtracts.json` (hyphen instead of colon), which `commit-fix` silently treated as a missing artifact (`{"committed":false,"reason":"no edit or file unchanged"}` — correct fail-closed behavior, just not the error message I expected). Re-wrote the artifact under the correctly-colon-named path and `commit-fix` succeeded immediately. This is a note for future callers of the direct-verb path, not a product defect — `review-cli.js`'s `commit-fix` behaved exactly as designed (fail closed on a missing artifact) and gave no false positive.

## Round 1

`round-start` — confirms the state dir is under `<CODEX_HOME|~/.codex>/concord/projects/<slug>/state`:
```
$ node .../plugins/concord-codex/bin/review-cli.js round-start e2e main
{"decision":"work","round":1,"budget":{"max_rounds":5,"spent":0},"dodPassed":true,"intentApplied":false,"gateApplied":false,"stateDir":"/Users/inkme/.codex/concord/projects/-private-tmp-codex-e2e/state"}
```
`stateDir` = `/Users/inkme/.codex/concord/projects/-private-tmp-codex-e2e/state` — confirmed under `~/.codex/concord/projects/<slug>/state`. (`process.cwd()` resolves `/tmp` to its real path `/private/tmp` on this macOS host, hence the slug; the root is still `~/.codex`.)

**Correctness reviewer** (`codex exec`, backgrounded, artifact appeared in ~10s):
```
$ codex exec --skip-git-repo-check --cd /tmp/codex-e2e --add-dir "$STATE" --sandbox workspace-write "<correctness prompt>"
```
Wrote `round-1-correctness.json`:
```json
{ "status": "ok", "examined": ["math.js"], "findings": [ {"id": "correctness:add-subtracts", "gate": "correctness", "file": "math.js", "span": "return a - b;", "summary": "add(a,b) subtracts instead of adding, contradicting its doc comment."} ] }
```
Correctly identified the bug unprompted (the prompt described the file but let the model do the actual review judgment).

**Verify artifact**: written directly (not via a second `codex exec`) as `{"status":"ok","rejected":[]}` — there were no false positives to adjudicate in a single-finding, single-file diff, so a real verify subagent would add cost without adding signal for this run. Noted per the task's explicit option to do this.

`plan-fixes`:
```
$ node .../review-cli.js plan-fixes e2e
{"fixes":[{"id":"correctness:add-subtracts","file":"math.js","span":"return a - b;","summary":"add(a,b) subtracts instead of adding, contradicting its doc comment."}]}
```

**Fix subagent** (`codex exec`, backgrounded, artifact + edit appeared in ~15s):
```
$ codex exec --skip-git-repo-check --cd /tmp/codex-e2e --add-dir "$STATE" --sandbox workspace-write "<fix prompt>"
```
Edited `math.js` in the working tree (`git diff` confirmed `-  return a - b;` / `+  return a + b;`) and wrote `round-1-fix-correctness:add-subtracts.json`:
```json
{ "status": "ok", "edited": true, "files": ["math.js"] }
```

`commit-fix` (after correcting the filename per the note above):
```
$ node .../review-cli.js commit-fix e2e correctness:add-subtracts
{"committed":true,"sha":"dbd4b44c86ea107d70e96eddb8b0db47c951c924"}
```
```
$ git show --stat dbd4b44
commit dbd4b44c86ea107d70e96eddb8b0db47c951c924
    fix(review-until-green): correctness:add-subtracts

    add(a,b) subtracts instead of adding, contradicting its doc comment.
 math.js | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

`record`:
```
$ node .../review-cli.js record e2e
{"decision":{"continue":true,"converged":false,"parked":false,"abandoned":false,"reason":"round produced progress or findings remain"},"handoff":"...findings: 1 fixed, 0 killed (false-positive), 0 parked\n\nFix digest:\n  - [correctness:add-subtracts] add(a,b) subtracts instead of adding, contradicting its doc comment. -> commit dbd4b44c86ea107d70e96eddb8b0db47c951c924"}
```
`continue: true` — round 1 made progress (a fix landed), so the driver correctly asks for a confirming round rather than declaring victory on the same round that fixed something.

## Round 2 (confirming clean round)

`round-start` shows the diff now contains the fixed code (`return a + b;`), `round: 2`.

**Correctness reviewer**, same mechanism, artifact in ~10s:
```json
{ "status": "ok", "examined": ["math.js"], "findings": [] }
```
Confirms no remaining bug.

Verify artifact written directly again: `{"status":"ok","rejected":[]}`.

`plan-fixes` → `{"fixes":[]}`.

`record`:
```
$ node .../review-cli.js record e2e
{"decision":{"continue":false,"converged":true,"parked":false,"abandoned":false,"reason":"DoD-exec ran and passed, zero open findings, and no fixes this round (stable)"},"handoff":"review-until-green: target e2e -- status: clean\nrounds: 2/5 (spent 1)\nDoD: passed\nintent: not configured\nfindings: 1 fixed, 0 killed (false-positive), 0 parked\n\nFix digest:\n  - [correctness:add-subtracts] add(a,b) subtracts instead of adding, contradicting its doc comment. -> commit dbd4b44c86ea107d70e96eddb8b0db47c951c924"}
```

**Terminal decision: `converged: true`, status `clean`.**

## Assertions checked

- [x] State dir under `<CODEX_HOME|~/.codex>/concord/projects/<slug>/state`: `/Users/inkme/.codex/concord/projects/-private-tmp-codex-e2e/state`.
- [x] At least one reviewer `codex exec` wrote a valid `round-<n>-correctness.json`: two did (round 1 found the bug, round 2 confirmed it gone).
- [x] A fix subagent (`codex exec`) edited the tree: `math.js` changed `return a - b;` → `return a + b;`, confirmed via `git diff` before commit.
- [x] `commit-fix` produced a commit: `dbd4b44c86ea107d70e96eddb8b0db47c951c924`.
- [x] `record` returned a terminal clean/converged decision: `{"continue":false,"converged":true,...}`, status `clean`, round 2/5.

## Cost / timing note

Each `codex exec` (2 correctness reviews + 1 fix, all `gpt-5.6-terra` at `medium` reasoning per this host's default `~/.codex/config.toml`) completed in 10-15 seconds — well inside the ~2-3 minute bounded poll window budgeted for this run. No run was inconclusive or needed to be abandoned.

## Cleanup

`/tmp/codex-e2e` and its Concord state dir `~/.codex/concord/projects/-private-tmp-codex-e2e/state` were removed after this run completed.
