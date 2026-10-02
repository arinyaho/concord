# Review feedback implementation plan

> **For Claude:** Use executing-plans when continuing this plan in a separate session.

**Goal:** Carry evidence-backed review lessons into future initiative contracts, tickets and designs with bounded context and explicit validation.

**Architecture:** A separate repository-bound feedback store reached through `review-cli feedback <record|decide|select|observe|report> <absolute-store-dir> [absolute-packet.json]`. Feedback operations never open or mutate initiative or target ledgers and never launch a reviewer. Agents interpret root causes; the engine validates provenance, eligibility, decisions and bounded selection. All claims of cause, earlier preventability and review effectiveness remain attributed judgments, not automated causal inference.

**Tech stack:** Shared Node.js engine, native provider wrappers, node:test, packaged workflow instructions.

## Contract

- Record bounded candidates from actual target-ledger findings. Categories: requirements, design, implementation, verification, review-noise, environment. Preserve run key, attempt identity, finding id, ledger identity/hash/status and confirmation evidence. Only fixed findings with a fix commit, earlier-available evidence, an explicit prevention rationale and an eligible category can contribute toward promotion.
- A candidate is grouped by caller-supplied stable pattern plus category, stage and applicability tags. Repeated occurrences within one run count once toward independent support. Its rule and rationale cannot silently change: a changed proposal must use a new pattern. Duplicate occurrences are idempotent; contradicted provenance or a later killed finding blocks acceptance.
- Promotion needs support from two distinct run keys and an explicit attributed accept decision with readable review evidence. Candidate collection does not promote anything, edit shared skills or change approved tickets/designs. Rejection or retirement disables selection. Decision evidence is a declared review, not authenticated human approval.
- Select only accepted eligible lessons matching exact applicability tags and stage (contract, ticket, design). Emit at most three bounded rules with IDs and evidence pointers; do not return accumulated transcripts or full history. No cross-repository reuse.
- Record post-review outcomes for applied lessons per run and unit: recurred, not-observed, unmeasured. Require review evidence; recurred must name an actual non-killed finding in the target ledger, not-observed requires a clean target ledger. These are reported observations, not proof of absence or causal savings. Report category counts, applied exposures and observed recurrences, separating missing measurements. Round count alone never diagnoses weak design.
- Stores are private, atomic and locked for mutations. Corrupt or wrong-repository stores fail visibly rather than being overwritten. Selection/report of an absent store returns empty without creating it. Feedback cannot affect review gates, reservations, budgets or authorization.

## Implementation and validation

1. Add real native CLI tests for candidate collection, repeated-support/decision gates, duplicate provenance, false-positive/environment exclusion, bounded relevant retrieval, retirement, corrupt/cross-repository state, outcomes and budget isolation. Verify RED before production implementation.
2. Add `core/review-feedback.js` and an early namespace dispatch in the native CLI, with explicit packet validation and repository binding.
3. Wire initiative bootstrap, stage 1, ticket-writing, design preparation and completion/blocked handoffs to the feedback protocol using a stable project-level directory outside tracked files. Keep collection out of the review/fix loop; no extra review round solely for learning.
4. Bundle both provider packages, review independently and run the repository Definition of Done and documentation checks.

Actual cross-session adoption and fewer design escapes need subsequent native-session observations; automated tests prove storage and selection behavior only.

Feedback preserves private immutable receipts of the selected finding, original ledger identity/hash, attempt, status and fix commit, plus curated confirmation/decision evidence capped at 16KB per file. Receipts omit the full ledger and transcript. Normal later ledger telemetry updates or reruns do not invalidate past support. Acceptance validates the saved hashes and checks still-available same-attempt origins for explicit contradictions; a later killed or reopened finding blocks promotion. Reusing the same event with changed evidence requires explicit reconciliation and a revised pattern. Accepted stores revalidate their distinct-run/attempt support on load. Originals are provenance pointers, not immutable files. Archival must retain these evidence files alongside the store.
