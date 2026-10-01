# Terminal disposition journal

Initiative review ledgers use breaking schema version 5. Ledgers of any older version are rejected rather than upgraded, so a replay cannot infer terminal state from legacy fields.

Every terminal runner result is normalized into one durable disposition: `terminal`, `error`, or `escape`. A terminal disposition remains the sole replay/identity authority; error and escape entries are retained for audit but do not suppress a later retry. Duplicate dispositions are ignored under the ledger lock.

`escape` covers `record`'s own re-runnable stop states -- `gate-pending` and `intent-review` -- where a human dismisses or resolves the reported finding and a fresh round-start clears it, plus a literal `escape` decision from any caller. `record` always attaches a reconciliation to a *material* finding (every `intent_parked` finding, or a design-conformance/AC-coverage gate finding), which takes precedence and stays `terminal` -- so `gate-pending`/`intent-review` land as `escape` only when the open finding is non-material. `error` is a harness/runner failure (a thrown exception). Every other outcome (converged, parked, abandoned, or a reconciliation-required target) is `terminal`.

The public initiative summary remains aggregate-only. The shared core is bundled unchanged into the Codex and Copilot engines.
