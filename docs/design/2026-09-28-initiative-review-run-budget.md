# Initiative review run budget

An opt-in run supplies an opaque key, canonical initiative state directory, and immutable launch and round budgets. The durable local ledger is `initiative-review-<sha256(key)>.json`; it deliberately contains no key, prompt, source text, artifact path, environment, or credential. It may retain raw target refs and base/head revisions for local audit and reconciliation handoff only. Project aggregates and external tracker or PR output use SHA-256 target IDs and aggregate counts only.

Each reviewer, fixer, panel lens, and panel vote reserves one launch through an exclusive filesystem lock before it is spawned. A failed or crashed process has already consumed its reservation. Lock contention and exhausted budgets deny the launch, so separate worktrees cannot race a final slot.

The existing target ledger remains the source of review findings and compatibility behavior. With no run key, target-local accounting and reset/rerun remain available. With a key, terminal outcomes make the run immutable: reset/rerun cannot reopen it or alter budgets; a materially revised review uses a new key.

Before fixer planning, intent findings and design-conformance or AC-coverage gate findings become reconciliation work for keyed and no-key runs. This deliberately suppresses correctness and docreview fixers in the same round. Residual exposure: the filesystem lock is intentionally fail-closed; an orphaned lock requires operator cleanup after confirming no runner owns it.
