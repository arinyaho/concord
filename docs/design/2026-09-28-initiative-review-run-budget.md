# Initiative review run budget

An opt-in run supplies an opaque key, canonical initiative state directory, and immutable launch and round budgets. The durable ledger is `initiative-review-<sha256(key)>.json`; it deliberately contains no key, target ref, prompt, source text, artifact path, environment, or credential.

Each reviewer, fixer, panel lens, and panel vote reserves one launch through an exclusive filesystem lock before it is spawned. A failed or crashed process has already consumed its reservation. Lock contention and exhausted budgets deny the launch, so separate worktrees cannot race a final slot.

The existing target ledger remains the source of review findings and compatibility behavior. With no run key, behavior is unchanged. With a key, terminal outcomes make the run immutable: reset/rerun cannot reopen it or alter budgets; a materially revised review uses a new key.

Before fixer planning, intent findings and design-conformance or AC-coverage gate findings become reconciliation work. Correctness and docreview retain their normal automatic fixer path. Residual exposure: the filesystem lock is intentionally fail-closed; an orphaned lock requires operator cleanup after confirming no runner owns it.
