# Codex reviewer prerequisites and failure modes

The reviewer passes run as `codex exec` subprocesses. This file covers what must be true for them to run unattended, and the failures to recognize.

## Prerequisites

- **Codex CLI on PATH.** `command -v codex`. Verified working with Codex CLI 0.144.x.
- **Codex authenticated.** `~/.codex/auth.json` must exist (`codex login`). An unauthenticated `codex exec` fails immediately.
- **A clean working tree before `round-start`.** Concord reviews `base...HEAD`; a dirty tree is rejected. Commit or stash first.
- **The target checked out locally.** A PR is reviewed by its local head branch (`gh pr checkout <n>`), not via the GitHub API.

## The four invocation requirements, and why each is non-optional

`codex exec --cd "<repoRoot>" --sandbox workspace-write --add-dir "<stateDir>" --skip-git-repo-check "<PROMPT>" < /dev/null`

- `--cd "<repoRoot>"` — the reviewer reads the diff and repo from here.
- `--sandbox workspace-write` — the reviewer needs to write its JSON artifact. A read-only sandbox denies the write and the artifact never appears.
- `--add-dir "<stateDir>"` — the artifact lands in the CLI-owned state directory, which sits under `~/.claude/...`, OUTSIDE the `--cd` workspace. Without this grant every artifact write is denied as "outside the project." This is the single most common cause of an empty/missing artifact.
- `< /dev/null` — driven from a non-interactive harness, `codex exec` inherits an open stdin pipe that never reaches EOF. It prints `Reading additional input from stdin...` and blocks indefinitely (observed: 30+ minutes, zero progress). Redirecting stdin from `/dev/null` gives it the immediate EOF it is waiting for. Applies to background fan-out invocations too.
- `--skip-git-repo-check` — an unattended `codex exec` against a directory not in Codex's trust table hits the trusted-directory prompt and, with no TTY to answer, **hangs forever**. This flag bypasses that prompt. Its `--help` one-liner understates it; it also skips the trust prompt, not just the git-repo check.

## Keep reviewer output OUT of your context

Always redirect: `... "<PROMPT>" > "<stateDir>/codex-<role>.log" 2>&1`. Then read the artifact JSON, never the log. If you let `codex exec` stream to your Bash result, GPT-5's full reasoning floods your context and the token-offload benefit is gone. The log is there for debugging a failed run only.

## Failure modes to recognize

| Symptom | Cause | Fix |
| --- | --- | --- |
| Artifact file never appears, exit 0 | missing `--add-dir <stateDir>`, or a read-only sandbox | add `--add-dir` and `--sandbox workspace-write` |
| `codex exec` hangs indefinitely, log ends at `Reading additional input from stdin...` | stdin is an open pipe that never EOFs | add `< /dev/null` |
| `codex exec` hangs indefinitely, log empty | trust-directory prompt, no TTY | add `--skip-git-repo-check` |
| `browserType.launch: Target page, context or browser has been closed` | `--sandbox workspace-write` cannot spawn Chromium | ask the user before escalating to `--sandbox danger-full-access`; if they decline, the pass is blocked — it must report `"blocked"`, never fall back to a weaker method |
| `artifact-normalize` returns `harness-failure` naming a `blocked` tool | the reviewer could not run the check it was assigned | terminal by design — fix the environment (sandbox/permissions/missing tool) and re-run the round; never let the verdict stand or call the run clean |
| `artifact-normalize` returns `retry` naming a missing rejection `reason` | the reviewer killed a finding without stating what it ran | re-run that ONE reviewer with the returned prompt appended; a rejection with no stated basis is not auditable |
| Exit non-zero, log shows auth error | Codex not logged in | `codex login`, then retry |
| `artifact-normalize` returns `retry` | reviewer wrote a malformed/partial artifact | re-run that ONE reviewer once with the returned prompt appended, then normalize again (exactly as the driver specifies) — a second retry or any `harness-failure` is terminal |
| handoff says `DoD: DEFERRED (no review.config.json)` | repo has no declared DoD gate | expected — report the deferral, do not call the run verified; a committed `{"dod":[...]}` gates future runs |
| `round-start`: working tree is dirty | uncommitted changes | commit or stash, then retry |

## Cost note

A broad round (correctness + verify + 5-lens panel + 3-way adversarial verify per finding) can be 15–20 `codex exec` processes, each a full model run billed to the user's Codex plan. This is the honest cost of clean-context cross-engine review. Broad review is on by default, so a run reaches this cost without anyone asking for it: the front pass is two processes on round 1, and a repo with `gate.panel` enabled pays the panel at convergence. Mention it if the user seems unaware; `--no-broad` is the opt-out.
