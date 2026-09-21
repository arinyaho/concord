---
name: review-until-green
description: Run Concord's deterministic review-and-fix loop with clean-context GitHub Copilot reviewer and fixer subagents until the CLI returns a terminal decision.
---

# Review Until Green

Use the bundled `../../bin/review-cli.js` as the sole authority on rounds, deduplication, gates, and termination. Read [references/review-driver.md](references/review-driver.md) before starting and preserve its ordering and artifact contracts.

Resolve the target from the request. Invoke CLI verbs as `node <plugin-root>/bin/review-cli.js <verb> ...`; the skill base directory identifies the installed plugin root. Never infer the path from another harness cache.

One driver step is unavailable in this harness: do not invoke `telemetry-slot`. Copilot Agent Host does not expose stable provider-usage records that the shared telemetry reconciler can authenticate, so per-spawn telemetry is unavailable. Do not create synthetic Claude or Codex slots, and do not claim token measurements in the handoff.

For every review-class role, invoke the `Concord Reviewer` custom agent in clean context and pass only the exact target, diff artifact, prior finding IDs, required output schema, and blocked-tool clause from the driver. Write its returned JSON verbatim to the artifact path before invoking the next dependent CLI verb. Independent roles may run in parallel only where the driver explicitly permits it.

For every planned fix, invoke `Concord Fixer` sequentially, then follow the driver's artifact and `commit-fix` contract before starting another fix. The main agent remains the driver and does not judge findings or termination.

If `agent/runSubagent`, either custom agent, filesystem access to the state directory, or a required model/tool is unavailable, stop and report the missing capability. Do not replace clean-context review with an in-context opinion and do not report the run as clean.