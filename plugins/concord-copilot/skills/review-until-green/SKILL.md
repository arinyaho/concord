---
name: review-until-green
description: Run Concord's deterministic review-and-fix loop with independently selected Claude, Codex, or Copilot reviewer and fixer providers and models.
---

# Review Until Green

Use the bundled `../../bin/review-cli.js` as the sole authority on rounds, deduplication, gates, and termination. Read [references/review-driver.md](references/review-driver.md) before starting and preserve its ordering and artifact contracts.

Resolve the target from the request. Invoke CLI verbs as `node <plugin-root>/bin/review-cli.js <verb> ...`; the skill base directory identifies the installed plugin root. Never infer the path from another harness cache.

Parse `--reviewer <claude|codex|copilot>`, `--reviewer-model <model>`, `--fixer <claude|codex|copilot>`, and `--fixer-model <model>`. Providers default to `copilot`; models default to the selected provider's configured model. Apply the reviewer selection to every review-class role and the fixer selection only to planned fixes. Preserve the selections through every round and resume. Reject unknown providers and unavailable requested models; never silently substitute a provider or model.

One driver step is unavailable in this harness: do not invoke `telemetry-slot`. Copilot Agent Host does not expose stable provider-usage records that the shared telemetry reconciler can authenticate, so per-spawn telemetry is unavailable. Do not create synthetic Claude or Codex slots, and do not claim token measurements in the handoff.

For a Copilot review role, invoke the native `Concord Reviewer` custom agent in clean context, passing `--reviewer-model` as the subagent model when supplied. For a Copilot fix role, invoke the native `Concord Fixer` custom agent sequentially and pass `--fixer-model` when supplied. Pass only the bounded driver prompt and write returned JSON verbatim to the requested artifact path.

For a non-Copilot role, invoke a clean provider CLI process in the repository root and require it to write the requested artifact directly:

- Claude: `claude -p [--model <model>] --output-format json --no-session-persistence --permission-mode acceptEdits --permission-prompts none --add-dir <stateDir> "<prompt>"`
- Codex: `codex exec --cd <repoRoot> --sandbox workspace-write --add-dir <stateDir> --skip-git-repo-check [--model <model>] "<prompt>"`

Redirect external CLI output away from the parent context. A missing executable, authentication/model failure, non-zero exit, missing artifact, denied operation, or declared block is a harness failure. Independent review roles may run in parallel only where the driver explicitly permits it; fixes remain sequential and each is followed by the driver's `commit-fix` contract.

If `agent/runSubagent`, a selected CLI, filesystem access to the state directory, authentication, or a required model/tool is unavailable, stop and report the missing capability. Do not replace clean-context review with an in-context opinion and do not report the run as clean.