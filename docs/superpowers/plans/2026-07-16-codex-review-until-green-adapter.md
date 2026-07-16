# Codex adapter — review-until-green — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `review-until-green` run natively under the Codex CLI by implementing three ports (Command, Reviewer, StateDir) as a flat Codex plugin, reusing `core/` verbatim.

**Architecture:** A new flat Codex plugin `plugins/concord-codex/` (mirroring the as-built flat Claude Code plugin `plugins/concord/`) with a `.codex-plugin/plugin.json` manifest, a `bin/review-cli.js` entrypoint shim that injects a Codex `~/.codex`-rooted state-dir resolver into `core/review-cli.js`'s `runMain`, and a `commands/review-until-green.md` composed from the neutral `core/review-driver.md` + a Codex `spawn-include.md`. Reviewers and the fix subagent run as `codex exec` subprocesses.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, the Codex CLI (`codex exec`, `codex plugin`), git.

## Global Constraints

- **`core/` is reused verbatim — zero edits.** No file under `plugins/concord/core/` changes. The existing Claude Code suite stays green and the neutrality guard (including its `require('../` sub-test) still passes after every task. `core/review-cli.js` already exports `runMain(resolveFromCwd)`; the Codex shim injects its resolver exactly as `plugins/concord/hooks/review-cli.js` injects the Claude Code one.
- **Flat plugin layout.** The Codex plugin is `plugins/concord-codex/` (flat: `.codex-plugin/`, `bin/`, `commands/`), a sibling of `plugins/concord/`. No `packaging/` directory (none exists in the repo).
- **`<review-cli>` resolves to `./bin/review-cli.js`** (plugin-relative), NOT to `core/review-cli.js` (which does not self-invoke). `<arguments>` resolves to `$ARGUMENTS` (Codex commands support the same token as Claude Code).
- **Reviewer/fix spawn = `codex exec --cd <repoRoot> --sandbox workspace-write "<prompt>"`.** `workspace-write` is required because driver step 5's fix subagent edits repo source, not just a state-dir artifact.
- **CommonJS only; no external deps; `node --test`.**
- **StateDir root:** `process.env.CODEX_HOME || ~/.codex`, namespaced under `concord/` to avoid colliding with Codex's own `sessions/`, `plugins/`, etc. Exact path: `<codexHome>/concord/projects/<slug>/state`, slug = `process.cwd().replace(/[/.]/g, '-')` (same slug rule the Claude Code resolver uses). The `REVIEW_STATE_DIR` override is NOT this resolver's concern — it is applied one layer up by `core/review-cli.js`'s `resolveStateDir()` wrapper.

## File Structure

New files (all outside `core/`, so the neutrality guard is unaffected):

- `plugins/concord/adapters/codex/statedir.js` — StateDirPort: `resolveStateDirFromCwd()` rooted at `~/.codex`. One responsibility: project-scoped state path.
- `plugins/concord/hooks/test/codex-statedir.test.js` — unit test for the above (the mechanical port-shape enforcement the parent design mandates).
- `plugins/concord/adapters/codex/spawn-include.md` — ReviewerPort prose: the `codex exec` spawn fragment for review-class subagents AND the fix subagent.
- `plugins/concord-codex/.codex-plugin/plugin.json` — Codex plugin manifest.
- `plugins/concord-codex/bin/review-cli.js` — entrypoint shim (requires shared `core/review-cli.js`, injects the Codex statedir resolver, `runMain` under `require.main`).
- `plugins/concord-codex/commands/review-until-green.md` — composed command.

Modified:

- `plugins/concord/adapters/codex/GAPS.md` and `README.md` — mark the two resolved open questions and the three implemented ports.

Reused verbatim (no change): `plugins/concord/core/*` (review-cli, review, gate*, dod-exec, ports, review-driver.md), `plugins/concord/adapters/codex/` gains files but the stub docs update in place.

---

## Task 1: Spike — confirm Codex plugin runtime facts

The design flagged two runtime facts as "confirm at implementation": how a Codex command locates its bundled `bin/review-cli.js`, and which `codex exec` sandbox mode writes files non-interactively. This task confirms them against the live Codex CLI before any real code, so later tasks build on facts, not guesses. It is a discovery task — its deliverable is a short recorded findings note, not shipped code.

**Files:**
- Create (throwaway, deleted at end): a scratch Codex plugin under a temp dir.
- Produce: `docs/superpowers/specs/2026-07-16-codex-spike-findings.md` — the recorded facts.

- [ ] **Step 1: Confirm `codex exec` writes a file non-interactively with `workspace-write`**

Run in a scratch git repo:
```bash
mkdir -p /tmp/codex-spike && cd /tmp/codex-spike && git init -q && git commit -q --allow-empty -m init
codex exec --cd /tmp/codex-spike --sandbox workspace-write \
  'Write a file named probe.json containing exactly {"ok":true} and nothing else. Do not ask for confirmation.'
cat /tmp/codex-spike/probe.json
```
Expected: `probe.json` exists with `{"ok":true}`, no interactive prompt. Record whether `--sandbox workspace-write` alone sufficed or whether an extra flag/config (`-c sandbox_permissions=[...]`, `--dangerously-bypass-approvals-and-sandbox`) was needed. Record the minimal working invocation.

- [ ] **Step 2: Confirm how a Codex command resolves a bundled script path**

Create a minimal scratch Codex plugin with a command that runs a bundled script, install it, and invoke it:
```bash
# minimal plugin dir with .codex-plugin/plugin.json, bin/hello.js (prints "HELLO"), commands/spike.md
# commands/spike.md body: run `node "./bin/hello.js"` (test plugin-relative) and report output
codex plugin --help    # learn the install/list subcommands
# install the scratch plugin (local path install), enable it, run /spike in a codex session
```
Determine: does `./bin/hello.js` resolve relative to the plugin dir when the command runs? If not, what does (a `${CODEX_PLUGIN_ROOT}`-style variable, an absolute cache path, `$CODEX_HOME/plugins/...`)? Record the exact working reference form — this is what `<review-cli>` resolves to in Task 5.

- [ ] **Step 3: Record findings and clean up**

Write `docs/superpowers/specs/2026-07-16-codex-spike-findings.md` with: the minimal `codex exec` write invocation (Step 1), the working plugin-relative-or-otherwise script reference form (Step 2), and any deviation from the design's assumptions. Delete the scratch plugin + `/tmp/codex-spike`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-16-codex-spike-findings.md
git commit -m "docs(codex): spike findings -- codex exec writes + command script resolution"
```

If Step 1 or 2 contradicts the design (e.g. no plugin-relative resolution, or `workspace-write` insufficient), STOP and surface it — later tasks depend on these facts.

---

## Task 2: Codex StateDirPort — `adapters/codex/statedir.js` + unit test

**Files:**
- Create: `plugins/concord/adapters/codex/statedir.js`
- Test: `plugins/concord/hooks/test/codex-statedir.test.js`

**Interfaces:**
- Produces: `resolveStateDirFromCwd() -> string` — `<CODEX_HOME|~/.codex>/concord/projects/<slug>/state`, slug = `process.cwd().replace(/[/.]/g, '-')`. No env override of its own (mirrors the Claude Code resolver's contract).

- [ ] **Step 1: Write the failing test**

```js
// plugins/concord/hooks/test/codex-statedir.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const statedir = require('../../adapters/codex/statedir');

test('resolveStateDirFromCwd: ~/.codex-rooted, concord-namespaced, cwd-slug encoded (CODEX_HOME set)', () => {
  const prev = process.env.CODEX_HOME;
  const prevCwd = process.cwd();
  process.env.CODEX_HOME = '/home/x/.codex';
  process.chdir('/tmp');
  try {
    const dir = statedir.resolveStateDirFromCwd();
    const slug = process.cwd().replace(/[/.]/g, '-');
    assert.strictEqual(dir, path.join('/home/x/.codex', 'concord', 'projects', slug, 'state'));
  } finally {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test('resolveStateDirFromCwd: falls back to ~/.codex when CODEX_HOME unset', () => {
  const prev = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    const dir = statedir.resolveStateDirFromCwd();
    assert.ok(dir.includes(path.join('.codex', 'concord', 'projects')));
    assert.ok(dir.endsWith('state'));
  } finally {
    if (prev !== undefined) process.env.CODEX_HOME = prev;
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test plugins/concord/hooks/test/codex-statedir.test.js`
Expected: FAIL — `Cannot find module '../../adapters/codex/statedir'`.

- [ ] **Step 3: Implement**

```js
// plugins/concord/adapters/codex/statedir.js
'use strict';
const os = require('node:os');
const path = require('node:path');

// Codex StateDirPort. Rooted at Codex's config dir (CODEX_HOME, default ~/.codex),
// namespaced under `concord/` so Concord's per-project state never collides with
// Codex's own sessions/, plugins/, logs. Same cwd->slug encoding the Claude Code
// resolver uses. Like that resolver, this has NO env override of its own --
// REVIEW_STATE_DIR is applied one layer up by core/review-cli.js's resolveStateDir().
function resolveStateDirFromCwd() {
  const configDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const slug = process.cwd().replace(/[/.]/g, '-');
  return path.join(configDir, 'concord', 'projects', slug, 'state');
}

module.exports = { resolveStateDirFromCwd };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test plugins/concord/hooks/test/codex-statedir.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm no regression + core still clean**

Run: `node --test "plugins/concord/hooks/test/"*.test.js` → all pass (298 + 2 new = 300).
Run: `grep -rn "require('../" plugins/concord/core/` → nothing (the new file is outside core/; core untouched).

- [ ] **Step 6: Commit**

```bash
git add plugins/concord/adapters/codex/statedir.js plugins/concord/hooks/test/codex-statedir.test.js
git commit -m "feat(codex): StateDirPort -- ~/.codex-rooted state dir resolver + unit test"
```

---

## Task 3: Codex ReviewerPort — `adapters/codex/spawn-include.md`

The prose fragment the composed command splices in, defining how the Codex main model spawns each subagent. It has no unit test (it is instructions the harness model executes); its correctness is verified by composition (Task 5) and the E2E (Task 7).

**Files:**
- Create: `plugins/concord/adapters/codex/spawn-include.md`

- [ ] **Step 1: Write the spawn-include**

Content (single-line prose per the repo's no-hard-wrap markdown rule; the `<repoRoot>` and `<the prompt>` are placeholders the driver fills):

```markdown
<!-- plugins/concord/adapters/codex/spawn-include.md -->
**Codex spawn mechanism.** Spawn each review-class subagent (correctness, verify, intent, gate-review, gate-verify, panel lens, adversarial-verify) as a subprocess: `codex exec --cd <repoRoot> --sandbox workspace-write "<the prompt>"`. Each is a fresh, clean-context Codex agent that reviews the diff and writes ONLY its JSON artifact to the state directory, exactly as the prompt instructs. For a parallel fan-out (the 5-lens panel, the 3-way adversarial verify), launch the `codex exec` calls concurrently as background processes and wait for all their artifact files before proceeding. For a sequential dependency ("wait for the file"), launch the dependent `codex exec` only after the prior artifact exists.

Spawn the **fix subagent** (step 5) the same way — `codex exec --cd <repoRoot> --sandbox workspace-write "<the fix prompt>"` — but note it edits arbitrary source files in the working tree (not just a JSON artifact), so it runs strictly ONE AT A TIME (never backgrounded/parallel), and after it returns the main session itself runs `node "<review-cli>" commit-fix <ref> <id>` before spawning the next fix. Every "per the harness spawn-include" reference in the driver means: spawn that subagent this way.

Each `codex exec` is a full model run — a broad round (correctness + verify + 5-lens panel + 3-way verify) can be ~15–20 processes. This is materially heavier than an in-session subagent; it is the honest cost of clean-context review on a harness whose subagent primitive is a subprocess.
```

If Task 1's spike found `--sandbox workspace-write` insufficient, substitute the minimal working invocation it recorded (verbatim) here.

- [ ] **Step 2: Verify no forbidden coupling leaked into core**

This file is under `adapters/codex/`, not `core/` — confirm the neutrality guard is unaffected: `node --test plugins/concord/hooks/test/neutrality-guard.test.js` → pass.

- [ ] **Step 3: Commit**

```bash
git add plugins/concord/adapters/codex/spawn-include.md
git commit -m "feat(codex): ReviewerPort spawn-include -- codex exec reviewer + fix subagents"
```

---

## Task 4: Codex plugin scaffold — manifest + entrypoint shim

**Files:**
- Create: `plugins/concord-codex/.codex-plugin/plugin.json`
- Create: `plugins/concord-codex/bin/review-cli.js`

**Interfaces:**
- Consumes: `core/review-cli.js` (via relative require to the shared tree) and `adapters/codex/statedir.js`.
- Produces: a runnable `node plugins/concord-codex/bin/review-cli.js <verb> ...` that behaves exactly like `plugins/concord/hooks/review-cli.js` but resolves state under `~/.codex`.

- [ ] **Step 1: Write the manifest**

```json
// plugins/concord-codex/.codex-plugin/plugin.json
{
  "name": "concord-codex",
  "version": "0.1.0-alpha.1",
  "description": "Concord review-until-green for the Codex CLI: a review-and-fix loop that keeps reviewing a code change, fixing what it finds, and re-checking until the tests pass -- driven by a deterministic CLI, with reviewers run as codex exec subprocesses.",
  "author": { "name": "arinyaho" },
  "license": "MIT",
  "keywords": ["review", "code-review", "codex", "harness"],
  "commands": "./commands/"
}
```
(If Task 1 found the manifest needs a different key for commands — e.g. commands auto-discovered without a `commands` field — match what the live Codex plugins use; the observed manifests declared `skills` similarly, so `commands` is the expected analogue. Confirm against a real plugin that ships commands.)

- [ ] **Step 2: Write the entrypoint shim (mirrors `plugins/concord/hooks/review-cli.js`)**

For the in-repo first deliverable, the shim requires the shared core via a relative path. (Distribution/vendoring is a non-goal — see the design.)

```js
// plugins/concord-codex/bin/review-cli.js
'use strict';
const cli = require('../../concord/core/review-cli.js');
const { resolveStateDirFromCwd } = require('../../concord/adapters/codex/statedir');
module.exports = cli;
if (require.main === module) cli.runMain(resolveStateDirFromCwd);
```

- [ ] **Step 3: Verify the shim runs and resolves state under ~/.codex**

Run (a graceful-usage smoke, mirroring how the Claude Code shim is checked):
```bash
node plugins/concord-codex/bin/review-cli.js
```
Expected: prints a `review-cli:`-prefixed usage/error line (NOT a stack trace, NOT module-not-found) — proving the relative requires resolve and `runMain` wires the Codex resolver.

Run a state-dir path check:
```bash
CODEX_HOME=/tmp/xcodex node -e "console.log(require('./plugins/concord-codex/bin/review-cli.js'))" >/dev/null 2>&1 || true
node -e "process.chdir('/tmp'); const {resolveStateDirFromCwd}=require('./plugins/concord/adapters/codex/statedir'); process.env.CODEX_HOME='/tmp/xcodex'; console.log(resolveStateDirFromCwd())"
```
Expected: a `/tmp/xcodex/concord/projects/-tmp/state` path.

- [ ] **Step 4: Full suite still green**

Run: `node --test "plugins/concord/hooks/test/"*.test.js` → 300 pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/concord-codex/.codex-plugin/plugin.json plugins/concord-codex/bin/review-cli.js
git commit -m "feat(codex): plugin manifest + entrypoint shim injecting the Codex statedir resolver"
```

---

## Task 5: Compose the Codex command

**Files:**
- Create: `plugins/concord-codex/commands/review-until-green.md`

- [ ] **Step 1: Compose from the neutral driver + Codex spawn-include**

Build the command file the same way Task 7 of the vendor-agnostic deliverable built the Claude Code one:
1. Start from `plugins/concord/core/review-driver.md`'s body.
2. Splice in `plugins/concord/adapters/codex/spawn-include.md` (the Codex spawn mechanism) at the same location the Claude Code command carries its spawn section.
3. Resolve placeholders throughout: every `<review-cli>` → `./bin/review-cli.js` (or the exact reference form Task 1's spike confirmed); every `<arguments>` → `$ARGUMENTS`.
4. Add YAML front-matter mirroring the Claude Code command's `description:` and `argument-hint:` (from `plugins/concord/commands/review-until-green.md`).
5. Add a top-of-body HTML comment: `<!-- Composed from plugins/concord/core/review-driver.md + plugins/concord/adapters/codex/spawn-include.md. Edit those sources, not this file, then recompose. -->`

- [ ] **Step 2: Verify fidelity + no leftover placeholders**

```bash
grep -n '<review-cli>\|<arguments>' plugins/concord-codex/commands/review-until-green.md
```
Expected: nothing (all placeholders resolved).
Read the composed command end to end; confirm it instructs the same verbs, artifact paths, and ordering as `plugins/concord/commands/review-until-green.md`, differing only in the spawn mechanism (codex exec vs Task tool) and the `<review-cli>` path.

- [ ] **Step 3: Commit**

```bash
git add plugins/concord-codex/commands/review-until-green.md
git commit -m "feat(codex): composed review-until-green command (neutral driver + codex spawn-include)"
```

---

## Task 6: Update the Codex stub docs

Resolve the design's "Relationship to the stub" requirement so `GAPS.md`/`README.md` stop reading "documented, not implemented" for the shipped ports.

**Files:**
- Modify: `plugins/concord/adapters/codex/GAPS.md`
- Modify: `plugins/concord/adapters/codex/README.md`

- [ ] **Step 1: Update GAPS.md**

Mark the two resolved open questions: fan-out strategy → OS-level process-parallel `codex exec` (background subprocesses); install-model → option (i), a native flat Codex plugin (`plugins/concord-codex/`). Keep as the remaining known trade-off: the `codex exec` fan-out cost (~15–20 processes/broad round) and the `workspace-write` sandbox requirement for the fix subagent. Note `lifecycle`/`transcript` ports remain open (deferred with session-state/charter).

- [ ] **Step 2: Update README.md port table**

Mark `command`, `reviewer`, `statedir` as **implemented (review-until-green)**; leave `lifecycle`, `transcript` as not-implemented (deferred). Point at `plugins/concord-codex/` and `adapters/codex/statedir.js`/`spawn-include.md` as the implementations.

- [ ] **Step 3: Verify these files are outside core/ (guard unaffected) + commit**

```bash
node --test plugins/concord/hooks/test/neutrality-guard.test.js   # pass
git add plugins/concord/adapters/codex/GAPS.md plugins/concord/adapters/codex/README.md
git commit -m "docs(codex): mark command/reviewer/statedir implemented; resolve fan-out + install-model"
```

---

## Task 7: End-to-end under the Codex CLI

The design's primary acceptance: `review-until-green` converges under `codex` on a real branch, exercising the fix+commit leg (not just a review pass), with state under `~/.codex`.

**Files:** none created — this drives the built plugin.

- [ ] **Step 1: Prepare a throwaway target branch with a fixable defect**

In a scratch git repo (or a scratch branch of this repo), make a small committed change containing one obvious, reviewable correctness bug that a reviewer will flag and a fix subagent can correct (e.g. an off-by-one or an inverted condition with a test that catches it). Ensure a DoD command is configured (`review.config.json`).

- [ ] **Step 2: Drive the loop via the Codex command (or the shim directly)**

Two acceptable drive paths — use whichever Task 1's spike proved works:
- Via the installed Codex plugin: run `/review-until-green` in a `codex` session on the branch.
- Or directly, exercising the same verbs the command issues: `node plugins/concord-codex/bin/review-cli.js round-start <ref> origin/main`, then for the round spawn a reviewer with `codex exec --cd <repo> --sandbox workspace-write "<correctness prompt writing round-1-correctness.json>"`, then `plan-fixes`, then a fix subagent via `codex exec ... "<fix prompt>"`, then `commit-fix`, then `record`.

- [ ] **Step 3: Assert convergence + artifacts**

Confirm: the state dir was created under `<CODEX_HOME|~/.codex>/concord/projects/<slug>/state`; at least one reviewer `codex exec` wrote a valid `round-<n>-correctness.json`; a fix subagent edited the tree; `commit-fix` produced a commit; `record` returned a terminal `clean`/`converged` decision. Record the transcript of the run.

- [ ] **Step 4: Write an E2E note + commit**

```bash
# capture the run outcome in docs/superpowers/specs/2026-07-16-codex-e2e-note.md
git add docs/superpowers/specs/2026-07-16-codex-e2e-note.md
git commit -m "test(codex): review-until-green converges end-to-end under codex (fix+commit leg)"
```

If the E2E cannot complete (e.g. Codex environment constraints in this harness), record exactly where it stopped and what was verified vs blocked — do NOT claim convergence that did not happen.

---

## Task 8: Regression + neutrality gate

**Files:** none.

- [ ] **Step 1: Full Claude Code suite green**

Run: `node --test "plugins/concord/hooks/test/"*.test.js`
Expected: all pass (300: the prior 298 + the 2 codex-statedir tests). Zero failures. Proves the Codex work did not regress the Claude Code adapter.

- [ ] **Step 2: Core untouched + neutrality holds**

Run: `git diff --stat origin/docs/vendor-agnostic-harness-adapter-design..HEAD -- plugins/concord/core/`
Expected: empty (no core file changed).
Run: `node --test plugins/concord/hooks/test/neutrality-guard.test.js` → pass (both sub-tests).

- [ ] **Step 3: Commit (if any final touch-up) / done**

If Steps 1–2 pass with no changes, nothing to commit — the branch is ready. Otherwise fix and re-run.

---

## Self-Review notes

- **Spec coverage:** design's 3 ports → StateDir (T2), Reviewer/spawn-include (T3), Command (T5) + shim (T4); "core reused verbatim" → enforced by T2/T4/T8 (no core edit, guard passes); mechanical statedir test → T2; fix-subagent handling → T3 spawn-include + T7 E2E fix+commit leg; GAPS/README update → T6; flat `plugins/concord-codex/` layout → T4/T5; E2E convergence → T7; the two "confirm at implementation" open details → T1 spike (gates the rest).
- **Type consistency:** `resolveStateDirFromCwd` name matches across T2 (definition), T4 (shim require), and the Claude Code precedent. `runMain(resolveFromCwd)` injection matches `core/review-cli.js`'s real export.
- **Placeholder scan:** the plan's `<repoRoot>`/`<the prompt>`/`<review-cli>` are intentional driver/spawn-include placeholders, not plan gaps; every code step ships complete code.
- **Risk gate:** Task 1 is a hard gate — if the Codex plugin-relative path resolution or the sandbox-write fact differs from the design's assumption, Tasks 4/5/7 adjust to the recorded fact before proceeding.
