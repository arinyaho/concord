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

## Second-run reconciliation

The preserved second run at head `641b3459d0022845b448b409d1aec154d0995290` independently verified further instances of the same approved contracts. Reserve all panel votes as one round-wide `3 × candidates` batch before launching any voter. Keep suggestion suppression within the current driver context so a new context can receive its own suggestion. An unreadable target cannot prove that it was standalone: reject destructive reset/rerun until its original identity and binding are restored, preserving its bytes and history. Recovery and escalation messages must state reconciliation and retained old state before any separate base-mode run, never offer a new key to bypass spent budgets.

These are implementation corrections, with native regressions and both generated providers required before another preserved review run.

## Third-run reconciliation

The preserved third run at head `5029b884412a83858dca28980fd018e97b134549` verified remaining instruction and feedback edge cases. The detailed panel instructions must put the single round-wide reservation before the per-candidate voter loop. Duplicate feedback with unchanged curated evidence and causal finding identity must retain its original immutable receipt after unrelated ledger telemetry changes. Explicit rejection or retirement must remain usable when several accepted lessons share damaged evidence; structural and repository validation still applies, and acceptance and reuse continue to reject any remaining invalid proof.

## Fourth-run reconciliation

The preserved fourth run at head `792082607341d0fedbdf0706e6cb3683e8852b7c` verified further durability and feedback edge cases. Every intermediate rerun ledger write must preserve the original initiative binding. Before replacing the active ledger or deleting round artifacts, save and verify a private archive of the full prior ledger and actual evidence files; retain its path and hashes in run history while keeping the next review blind. Existing compact history alone does not preserve evidence lost by earlier reruns; retain separately saved original receipts without manufacturing missing artifacts.

Bind proposal identity, wording and applicability to immutable reviewed snapshots so edits cannot reuse the old acceptance proof. Verify those snapshots on reuse, preserving explicit disabling for damaged evidence. Observation retries with unchanged outcomes and curated evidence must retain their original receipt after unrelated ledger telemetry changes, just as duplicate finding records do.

## Fifth-run evidence reconciliation

The fifth run at head `0c563c6f59c24afe2830cf916268aeaf9b0b46b1` passed its ordinary review pairs, then its panel was rejected because one adversarial verifier declared a failed measurement. Preserve that failed evidence; it is neither a clean verdict nor an accepted panel finding. Two other independent executable probes reproduced associated-agent telemetry loss: cleanup selects some untagged agent receipts by their tool-record association, while the archive selected only explicit target fields. Archive the same complete target-associated telemetry set used by cleanup before deleting it, retaining unrelated receipts. Re-review with functioning independent measurements; do not replace the blocked verdict with an assumed result.

## Validation limits

Native tests cover deterministic decisions and durable state. Actual host efficiency, adoption of lessons and token savings need subsequent session observations. A stopped checkpoint is not a clean or terminal review verdict.
