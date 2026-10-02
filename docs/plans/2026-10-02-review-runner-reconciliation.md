# Native runner and feedback reconciliation plan

> **For Claude:** Use executing-plans when continuing this plan in a separate session.

**Goal:** Complete the native runner and feedback integration required by the approved initiative context, checkpoint and feedback contracts.

**Architecture:** The target review CLI owns reservations and dispositions. Native runners propagate the original initiative options to every call, reserve each actual role through that CLI, and expose checkpoint decisions at drained outer-round boundaries. Feedback retains repository-proven immutable receipts and verifies accepted evidence on reuse. Intent and approval boundaries remain unchanged.

**Tech stack:** Shared Node.js engine, Codex entry point, native CLI tests with controlled worker processes, packaged instructions.

## Evidence and reconciliation

The full review of PR 152, head `fef3476e7f12970f2cf2ded84e1ba4752a14c0a7`, against base `6fcd1dcd5bce30de1b78ba52aa3fe7cc48e82039` ended gate-pending. Independent verification found seven issue classes: runner option propagation; target reservation integration; missing round checkpoint handling; accepted feedback evidence validation; foreign repository provenance; recovery instructions for keyed targets; checkpoint option parsing. Generated mirrors represent the same defects and must be regenerated together.

Resolve these by implementing the existing approved contracts. Do not relax evidence integrity, enable cross-repository reuse, reset bound targets or omit native checkpoints. This is an implementation reconciliation, not a changed product contract. A separate architecture specialist was requested as `gpt-6-astra` for integration guidance; resolved provider identity was not exposed by that native interface. Routine implementation and subsequent review request `gpt-6.1-sol` in scoped contexts.

## Tasks

1. Add real native CLI regressions before code changes. Capture RED and GREEN results in local logs; use fake worker processes only to control artifacts and scheduling, keeping the actual CLI's bindings/reservations/records authoritative.
2. Propagate immutable original run options through the runner CLI wrapper. Reserve roles through target `reserve`; reserve panel batches atomically and charge every retry once. Deliver CLI-owned disposition claims without a second runner record at a different revision.
3. Parse the session-handoff option before target/base. Evaluate only completed outer rounds, after panel completion and all owned workers drain. Preserve the original review decision on stop; save bounded source-based continuation evidence and emit prompt/checkpoint paths. Suggestions must remain visible while the driver continues.
4. Verify accepted support and decision snapshots and same-attempt contradictions on reuse. Verify feedback provenance against a bound version-5 initiative's repository identity. Reject unbound/unverifiable provenance without initializing or mutating its ledger. Allow explicit retirement of invalid evidence while preserving visible errors on acceptance or reuse.
5. Qualify finding-less reset recovery as standalone-only; keyed recovery preserves evidence, history and spent budgets and requires reconciliation. Update source instructions and regenerate providers.
6. Run relevant regression suites and the full repository DoD. Commit the reconciled implementation, re-arm the same durable review target with `rerun`, and perform a fresh deterministic review including the required broad panel when its preconditions are met. Retain the original gate-pending findings and artifacts in history.
7. Before pushing, run applicable GitHub Actions commands on Node 22 and update the existing PR's description and validation evidence. Do not merge.

## Validation limits

Native tests cover deterministic decisions and durable state. Actual host efficiency, adoption of lessons and token savings need subsequent session observations. A stopped checkpoint is not a clean or terminal review verdict.
