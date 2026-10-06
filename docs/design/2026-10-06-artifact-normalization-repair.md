# Artifact normalization repair

## Decision and evidence

For issue #171, replace the automatic substantive reviewer retry after a retryable artifact representation failure with at most one isolated `artifact-repair` operation. Repair can restate evidence already present; it cannot perform review or supply missing evidence. Failure to demonstrate preservation is terminal, not permission to rerun a reviewer or manufacture a clean result.

The approved contract was recorded in the artifact-normalization-retry-cost Stage 1 and Stage 2 handoffs on 2026-10-06 and is fully recorded in this note with the repository evidence below; no external lookup is required to understand the decision. Repository evidence was inspected at `a00dc8c9eaee93a7462bb819bd4ac81320b22528`. PR #170 is a merged prerequisite establishing the existing namespace ownership contract; this decision neither edits its design record nor reopens that work.

At that revision, `plugins/concord/core/codex-review-runner.js` constructs a fresh full `reviewerPrompt(...)` for normalization retries. `core/review-cli.js` persists a retry prompt and marker, charges the superseded launch, and requires another reservation, but resume cleanup retains only verified completed artifacts. `core/review-driver.md` similarly directs manual drivers to rerun the same reviewer. `core/artifact-contract.js` provides the shared role registry and strict validator. Those are the existing integration points; a generalized retry framework and a second namespace registry are unnecessary.

## Repair boundary and launch context

The repair packet contains only the artifact role, exact validation error, exact immutable invalid artifact, minimal applicable schema and ownership rules, allowed prefixes from the existing registry, and necessary role-owned candidate IDs. Candidate IDs constrain identity; they do not prove that a candidate was examined, accepted, rejected, or measured. The orchestrator retains target and revision bindings without supplying repository contents as repair context.

Repair receives no diff text, repository files or instructions, review history, intent or design documents, unrelated artifacts or candidate sets, or substantive reviewer prompt. It cannot inspect code, rerun checks, discover findings, decide a verdict, infer missing evidence, or use a previous reviewer conversation. Do not regenerate or append `reviewerPrompt` for this operation.

Use a fresh invocation in a neutral directory outside repository ancestry, containing only the packet, snapshot, and separate candidate output. Prevent automatic repository instruction loading and inherited repository context through working-directory selection, launch options, environment, and tool/file access. A shorter prompt with the existing repository launch configuration is insufficient. Restrict the repair surface to its inputs and candidate destination; if the selected provider cannot meet this boundary, fail closed rather than falling back to its ordinary reviewer launch. The runner retains responsibility for ledger access and publication outside that directory.

## Immutable evidence and acceptance

On the first eligible normalization failure, preserve the original bytes in an immutable snapshot bound to target, round, artifact role, original content hash, and reviewed diff hash. The original remains available for audit whether repair succeeds or fails. Repair writes a distinct candidate; it never overwrites the original or directly publishes a canonical artifact.

Publication requires both the existing strict validation and a separate preservation check against the original. Validate the candidate before canonicalization can discard fields, and validate its publishable canonical form under the existing schema and downstream coverage/plan requirements. Strict normalization continues to reject invalid namespaces and blocked evidence on direct and repaired paths. Neither validation nor post-processing may silently filter cross-namespace entries to make an artifact pass.

The preservation check must establish the same role-owned evidence and dispositions by identity, not just equal counts. Role-owned findings retain their IDs, file references, summaries, and substantive evidence; rejection reasons retain what was actually run, measured, or read; examined coverage cannot grow by assertion; plan membership, classifications, invariants, reconciliation reasons, and design evidence cannot acquire new meaning. Existing role-owned verdicts cannot be added, removed, or changed. Loss of role-owned evidence-bearing fields through canonicalization also fails preservation. Permit only representation changes whose meaning is demonstrably unchanged, such as an accepted status spelling or JSON formatting, and the narrowly bounded omission of foreign dispositions described below. When the original is too incomplete or ambiguous to establish equivalence, reject the repair instead of guessing.

Fatal failures remain fatal, including malformed JSON, structurally incomplete findings, and declared blocked checks. A retry classification is eligibility for bounded repair consideration, not proof that repair is possible. A bare rejection ID without an existing reason, missing correctness coverage, absent structural-plan evidence, or a missing artifact cannot be repaired by inventing observations. The exact error can identify the omission but cannot supply the omitted evidence. A failed candidate leaves the round without a usable verdict or clean convergence.

## Namespace and mixed-evidence rules

All six roles retain the existing registry contracts:

| Artifact role | Required array fields in the normalized shape | Owned ID prefixes |
| --- | --- | --- |
| `correctness` | `examined`, `findings` | `correctness:`, `docreview:` |
| `verify` | `rejected`, `findings` | `correctness:`, `docreview:` |
| `plan` | `groups` | `correctness:`, `docreview:` |
| `intent` | `findings` | `intent:` |
| `gate` | `findings` | `gate:` |
| `gate-verify` | `rejected`, `findings` | `gate:` |

The existing plan protocol version and group requirements remain in force. Correctness candidates visible during substantive gate verification are context, not gate disposition authority. Repair receives only necessary gate-owned candidate IDs; it does not receive the correctness candidate set again.

An immutable mixed-namespace original must remain intact. The bounded repair candidate may omit foreign dispositions only when the original retains all foreign evidence for audit, every existing role-owned evidence item and verdict remains unchanged, the role-owned verdict is complete, and the omission does not manufacture clean convergence. The preservation check must establish all of these conditions; an audit copy alone is insufficient. This exception belongs only to the separately validated repair candidate: the validator and deterministic post-processing must never silently filter cross-namespace entries. Cross-namespace findings or rejections cannot be relabeled, fuzzy-mapped, or transferred between owners. If owned evidence is missing or ambiguous, fail closed. In particular, a correctness-only `gate-verify` artifact contains no established gate verdict: neither replacing `correctness:` with `gate:` nor emitting empty `rejected` and `findings` arrays is a valid repair.

## One attempt, resume, accounting, and telemetry

Persist repair identity, original hash, packet/candidate identities, and dispatch state durably before launching. Allow at most one repair per artifact and round across ordinary execution, interruption, and resume. Resume must retain and verify the pending snapshot and repair state alongside hash-verified completed artifacts instead of deleting them as unfinished round output. Mismatched target, round, role, diff, or content hashes fail closed.

A prepared but undispatched repair may proceed through the same reservation and dispatch transition. A dispatched repair may have its already-produced candidate validated; uncertainty about whether it ran must not authorize another launch. Missing or corrupt recovery evidence requires failure or reconciliation, not reconstruction from a full review prompt. Completed artifact reuse remains hash verified, and a consumed repair allowance is not reset by publication, cleanup, or context replacement.

Use the original artifact's existing reservation role, including `gate` to `gate-review` mapping. Reserve the additional launch before dispatch, record supersession of the initial attempt exactly once, and charge the repair launch once. Recovery must reuse the recorded reservation/dispatch identity rather than double charging or granting another attempt. Budget denial prevents launch. Preserve current initiative binding, budget limits, terminal dispositions, and round accounting; do not reset, increase, or re-key a budget. No automatic substantive reviewer fallback is allowed after repair failure, interruption, or exhaustion.

Add a small operation discriminator distinguishing substantive review from `artifact-repair` to existing telemetry and its aggregation. Keep artifact role, invocation/attempt identity, calls, outcomes, elapsed time, and existing token fields separately attributable without creating a new budget-role framework. Report repair attempts and successes/failures independently of substantive reviews; resume must not duplicate an invocation. Preserve partial or unavailable usage as such, not as zero usage. Token savings remain a measured outcome, not an assumed benchmark result.

## Shared drivers and generated bundles

Implement in shared repository sources and update manual driver instructions to use the same minimal packet, isolation, immutable input, candidate validation, reservation, and one-attempt resume contract. Manual drivers must not rerun the same reviewer with an appended prompt or edit an artifact themselves. The contract applies to `plan` as well as the other artifact roles.

Regenerate the repository Codex and Copilot bundles using their existing `bin/bundle.mjs` scripts and verify parity with shared sources. Generated packages must not retain the old substantive retry behavior. Do not patch installed plugin caches, run Claude/Copilot reviewers for this work, or mutate historical Chemcopilot artifacts or ledgers. This design file is the only mutation in the design-record step; implementation, regeneration, and executable verification follow separately.

## Verification and trade-offs

Implementation verification must first observe a minimal regression fail on the unmodified evidence revision and record the exact assertion. Identity sentinels must prove the complete allowed packet and excluded repository/diff/history/design/unrelated-candidate identities, plus the actual neutral launch context and absence of a second reviewer launch. Focused checks must cover all six roles, immutable original bytes, separate publication, strict and preservation failures, the correctness-only gate example, missing and blocked evidence, one repair across crash/resume boundaries, exact reservation/supersession accounting, and operation-specific telemetry. Run manual-driver and bundle-parity checks and `node scripts/dod.mjs`; independently review and verify the exact implementation head/base before delivery.

The design trades some automatic recovery for trustworthy evidence: omissions that a new substantive reviewer might investigate now stop for explicit resolution. Additional snapshot and dispatch state adds storage and recovery bookkeeping, but bounds cost and prevents repeated full-context review. Reusing the current validator, role registry, reservation roles, and telemetry structure keeps that machinery focused on this operation.

## Residual exposure

An original reviewer can still emit false but schema-valid evidence; preservation proves continuity, not truth. A model can ignore the repair instruction, so enforcement depends on candidate validation and the actual provider isolation surface, not wording alone. Neutral working-directory selection by itself is not an operating-system security sandbox and does not eliminate ambient provider configuration or global tools; implementations must verify the promised context restrictions and fail closed where they cannot enforce them. Conservative comparison may reject harmless rewrites. A crash after dispatch but before durable output can consume the sole repair attempt without a usable result. Strict validation without preservation, or an audit snapshot without acceptance checks, would leave the original evidence-loss exposure unresolved.
