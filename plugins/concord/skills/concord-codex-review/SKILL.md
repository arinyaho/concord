---
name: concord-codex-review
description: >-
  Run Concord's review-until-green loop from THIS Claude session, but perform each round's actual
  review with Codex (GPT-5) instead of Claude — Claude stays the driver and applies the fixes; only
  the reviewer passes run as `codex exec` subprocesses. Use this whenever the user wants a Concord /
  review-until-green run reviewed by Codex rather than Claude: "concord로 이 브랜치 코덱스로 리뷰",
  "review PR 203 with concord but use Codex", "cross-AI 리뷰", "리뷰는 GPT-5한테 시켜", "get a second
  model's eyes on this diff", or asks to offload the review passes to Codex to save Claude tokens on a
  long review. The findings come from a different model's eyes than the one orchestrating and fixing.
  Do NOT use for a plain Claude-only review (just run /review-until-green), for a one-shot no-fix
  opinion (that is /code-review), or for running the loop natively under the Codex CLI (that is the
  concord-codex plugin invoked from a Codex session).
---

# Concord review-until-green with Codex reviewers

## What this is

Concord's review loop has three roles — **driver** (runs the deterministic CLI verbs, owns rounds/dedupe/termination), **reviewer** (clean-context pass over the diff that writes a finding artifact), and **fixer** (applies the planned fix and commits). The CLI authenticates only the JSON artifact on disk, never who wrote it, so the reviewer role is engine-swappable independent of who drives.

This skill keeps **Claude as the driver and fixer** and swaps **the reviewer engine to Codex**. Two payoffs:

- **Cross-model verification** — findings come from GPT-5's eyes, not the model orchestrating and fixing. A different architecture catches a single model's blind spots.
- **Token/quota offload** — each reviewer's reasoning is billed to Codex and its verbose output is discarded to a log; only the compact JSON finding artifact enters your context. The heaviest per-round passes (5-lens panel, N-way adversarial verify) run outside your token budget.

This is one direction of a symmetric idea: the reviewer engine is an independent axis from the driving harness, so the mirror arrangement (a Codex-driven loop reviewed by Claude) belongs to the Codex packaging's own spawn strategy rather than to this skill.

## The core idea: drive Concord's own loop, deviate in exactly two places

You do **not** reimplement the review loop here. Concord's Claude-Code command doc IS the loop — round choreography, the exact reviewer prompts, the "wait for the artifact" ordering, dedupe, termination. Follow it verbatim, with two — and only two — substitutions:

1. **Reviewer/verify/gate/panel/intent subagents → `codex exec` subprocesses.** Wherever the driver says to spawn a review-class subagent via the Task tool, run that same prompt as a `codex exec` subprocess instead (recipe below). The prompt already tells the reviewer to write ONLY its JSON artifact to the state directory; Codex honors it identically.
2. **Fix subagents stay Claude — you apply them in-session.** The fixer must remain the driving engine (it edits the working tree and commits, and the loop's single-writer discipline lives here). Where the driver says to spawn a fix subagent, YOU apply the minimal correct fix with your own Edit tool, then run `commit-fix` exactly as the driver says.

Everything else — `round-start`, `plan-fixes`, `commit-fix`, `record`, `artifact-normalize`, the panel sub-loop, the terminal-decision handling — you run unchanged. You still make NO judgement about findings, DoD, or termination; the CLI decides.

## Step 0 — resolve paths and preconditions

Locate the Concord plugin root that owns this skill, then confirm Codex is ready. `CLAUDE_PLUGIN_ROOT` is only exported for the plugin's own commands and hooks, not for a shell you spawn, so resolve it by globbing the installed plugin cache and fall back to a development checkout:

```bash
CONCORD="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/*/concord/*/ 2>/dev/null | sort -V | tail -1)}"
test -f "$CONCORD/hooks/review-cli.js" || CONCORD="$(git rev-parse --show-toplevel 2>/dev/null)/plugins/concord"
REVIEW_CLI="$CONCORD/hooks/review-cli.js"             # the deterministic CLI you drive
DRIVER_DOC="$CONCORD/commands/review-until-green.md"  # the loop you follow
test -f "$REVIEW_CLI" || echo "MISSING: cannot locate Concord's review CLI"
command -v codex >/dev/null || echo "MISSING: codex CLI not on PATH"
test -f ~/.codex/auth.json || echo "MISSING: Codex not authenticated (run: codex login)"
```

Read `$DRIVER_DOC` now — it is the authority on the loop. This skill only tells you *how the reviewer subagents are spawned* and *that fixes stay Claude*; the driver tells you *what to do each round*.

If `codex` is missing or unauthenticated, stop and tell the user — this skill cannot run without it.

## Step 1 — resolve the target

From the user's natural-language request, determine what to review, then hand a git ref to `round-start`:

- **A PR** ("203 리뷰", "review PR 203") → `gh pr checkout 203` to put its head branch in the working tree, then the ref is that branch and the base is `origin/<default>` (usually `origin/main`).
- **A branch / current work** → the branch name, base `origin/main` (a remote base; a local base can be stale).
- **Ambiguous which repo** → infer from the working directory; if genuinely unclear, ask.

Concord reviews a **local git diff** (`base...HEAD`), so the target must be checked out locally. The working tree must be clean before `round-start` (commit or stash first) — same as any Concord run.

## Step 2 — DoD gate

Concord refuses to start without a declared DoD gate (`review.config.json`). If `round-start` returns `harness-failure: no review.config.json`, surface BOTH resolutions to the user and let them pick — declare a gate in a committed `review.config.json`, or re-run with `--no-dod` (review gates only, DoD reported deferred). Never choose `--no-dod` on your own initiative; passing it is the user's decision.

## Step 3 — run the loop with Codex reviewers

Drive `$REVIEW_CLI` per `$DRIVER_DOC`. The one thing that changes is how you spawn each review-class subagent. Use this recipe.

### The codex-exec reviewer recipe

A reviewer subprocess needs write access to the repo (for its own reasoning scratch) and to the CLI-owned state directory (where the artifact lands, which sits under `~/.claude`, outside the repo). Redirect its stdout/stderr to a log so its verbose reasoning never floods your context — you read only the JSON artifact it writes.

```bash
# <PROMPT> is the EXACT reviewer prompt the driver tells you to give this subagent.
# <stateDir> is what round-start printed.
codex exec --cd "<repoRoot>" --sandbox workspace-write --add-dir "<stateDir>" \
  --skip-git-repo-check "<PROMPT>" > "<stateDir>/codex-<role>.log" 2>&1
```

- `--add-dir "<stateDir>"` is required — without it the artifact write fails as writing outside the sandbox.
- `--skip-git-repo-check` prevents an unattended trust prompt from hanging the subprocess.
- After it exits, read `<stateDir>/round-<n>-<role>.json` (the artifact), not the log. Then run `artifact-normalize` exactly as the driver instructs.

### Sequential vs parallel — obey the driver's ordering

The driver's "wait for the artifact" dependencies are engine-independent; honor them with process control:

- **Sequential dependency** (correctness → verify, gate-review → gate-verify, panel lenses → adversarial-verify): run the dependent `codex exec` only AFTER the prior artifact file exists. Never launch it early against a missing file.
- **Parallel fan-out** (the 5 panel lenses; the 3-way adversarial verify per finding; intent alongside the correctness→verify pair): launch the `codex exec` calls as background processes in one shell invocation and `wait`, each writing its own artifact and log:

```bash
for lens in ac-coverage design-conformance cross-context silent-gap threat-model; do
  codex exec --cd "<repoRoot>" --sandbox workspace-write --add-dir "<stateDir>" \
    --skip-git-repo-check "<PROMPT for $lens>" > "<stateDir>/codex-panel-$lens.log" 2>&1 &
done
wait
```

### Model / effort knob (optional)

By default Codex uses its configured model. If the user asks to tier a pass — e.g. a high-effort adversarial verify — add `-m <model>` and/or `-c model_reasoning_effort=<low|medium|high>` to that pass's `codex exec`. Leave it off unless asked; the point of this skill is the engine swap, not fine model tuning.

### Fixes (Claude)

When the driver reaches `plan-fixes` and the per-fix step: for EACH planned fix, apply the minimal correct change yourself with Edit, write the driver's expected `round-<n>-fix-<id>.json` (`{"status":"ok","edited":true,"files":[...]}`), then run `commit-fix` before the next fix — sequentially, one at a time, exactly as the driver specifies. This is the only place you use your own tools instead of Codex; it is deliberate.

## Step 4 — report

Relay `record`'s terminal handoff verbatim, and note the run reviewed via Codex (so it is clear the findings came from GPT-5's eyes while Claude drove and fixed). If a CLI verb exits `harness-failure`, stop and report it plainly — do not characterize the run as clean or parked.

## Guardrails

- **You still don't judge findings.** Codex produces them; the CLI decides rounds/dedupe/termination; you only relay and apply planned fixes. Same discipline as a normal Concord run.
- **Never let a reviewer's reasoning into your context** — always redirect `codex exec` output to a log and read only the artifact. That redirection is what makes the token-offload real; skipping it defeats the purpose.
- **This is not read-only.** review-until-green fixes and commits. If the user wanted only Codex's opinion with no changes, this is the wrong tool — tell them so.
- **Reverse direction is out of scope here.** Codex-driver + Claude-reviewer belongs in the concord-codex plugin's spawn strategy, not this skill.

## Prerequisites at a glance

See `references/prerequisites.md` for the Codex auth/trust/sandbox details and common failure modes (trust-prompt hangs, sandbox-write denials, missing `--add-dir`).
