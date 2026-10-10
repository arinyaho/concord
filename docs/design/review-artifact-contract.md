# Review artifact contract

Every fail-closed reviewer in a review round writes one JSON artifact for its role, and the review CLI normalizes it with `artifact-normalize <ref> <role>` before anything consumes it. This document covers the role registry and ID namespaces, how a representation failure is repaired without rerunning review, and the plan group contract.

## Roles and namespaces

`core/artifact-contract.js` is the only registry of artifact shapes and owned ID prefixes. Prompt generation and validation both read it, so the namespace a prompt states cannot drift from the one validation enforces.

| Artifact role | Required array fields in the normalized shape | Owned ID prefixes |
| --- | --- | --- |
| `correctness` | `examined`, `findings` | `correctness:`, `docreview:` |
| `verify` | `rejected`, `findings` | `correctness:`, `docreview:` |
| `plan` | `groups` | `correctness:`, `docreview:` |
| `intent` | `findings` | `intent:` |
| `gate` | `findings` | `gate:` |
| `gate-verify` | `rejected`, `findings` | `gate:` |

Strict normalization rejects IDs outside a role's prefixes, malformed JSON, structurally incomplete findings, and declared blocked checks. It never silently filters cross-namespace entries to make an artifact pass.

### Git review scope

A Git round captures its patch and changed-path manifest from the same fixed comparison endpoints. Manifest object IDs accept both Git SHA-1 and SHA-256 formats. The path inventory uses NUL-delimited Git output with rename detection disabled, so both rename paths, deletions, binary changes, empty additions and mode-only changes participate in correctness coverage. Patch display headers do not define the coverage set.

The versioned manifest is bound to the round, target identity and patch hash, with an integrity digest in the execution ledger. Artifact normalization and the verified fold use this saved manifest; neither reconstructs the scope from a moving checkout. Missing, mismatched or malformed scope evidence fails closed. A trusted round-start can regenerate inputs for a legacy round, but must invalidate completion evidence that lacks this binding. File targets retain their document contract without Git path inventory.

Review-only runners protect the manifest alongside the patch, ledger and reviewer artifacts. An untrusted role cannot narrow the required examined set by changing the saved scope.

### Reading untrusted state artifacts

Review-only integrity hashes and trusted artifact consumers share a bounded reader. It rejects symlinks and nonregular files, opens descriptors without following the final link and without waiting on FIFOs, and verifies that the opened file agrees with path metadata. Reads stop at 20 MiB; integrity hashes consume bounded chunks without loading the entire file. Missing future artifacts can be represented as absent, while an entry that changes during opening or reading is a failure.

The same boundary applies to the current role's output before normalization and to repair snapshots, packets, descriptors and candidates. A hash preflight does not replace bounds at the trusted consumer. Repair staging copies validated bounded bytes, and normalized artifacts are published with atomic replacement rather than writing through an untrusted leaf path. File-target identity checks use the same reader and enforce the 20 MiB cap across the combined selected content and headers. Review-only commands reject an occupied target lock before reading owner metadata, and failures stop without rereading a potentially modified ledger. Atomic publications use exclusive temporary-file creation so a planted temporary symlink cannot redirect a trusted write. Trusted normal-mode consumers keep their existing behavior.

Review-only runs inventory the tracked checkout before the first reviewer starts and compare it after every reviewer and before findings are reported. Paths come from the reviewed commit's tree, not the index, so assume-unchanged and skip-worktree flags cannot hide an entry. Each path records its file type and mode, the SHA-256 of regular-file bytes read through the bounded reader, a symlink's target without following it, absence, and an initialized submodule's commit and own inventory. The comparison is against the checkout's own earlier state, so checkout filters and line-ending conversion never run. A path that escapes the checkout, a tracked file over 20 MiB, or an inventory over 250,000 entries or 4 GiB fails the run. The visible dirty and HEAD checks still apply. The inventory does not prove that the starting checkout matched the commit and does not cover untracked, ignored or generated files.

This protects resource use and checks file identity at the read boundary. It does not provide a universal operating-system sandbox or an atomic directory-tree snapshot.

### Gate verifier context

When paired gate mode runs, including a file-target run in paired gate mode because broad review is explicitly armed, `gate-verify` reads the complete correctness candidate set, because cross-panel context lets it identify duplicate, related, or conflicting observations. That context does not transfer disposition ownership: `correctness` and `verify` own `correctness:*` and `docreview:*` candidates, while `gate` and `gate-verify` own `gate:*` candidates. The `gate-verify` prompt (`core/round-plan.js`) states that correctness candidates are context only, that verdicts are written only for `gate:*` candidates, and that `correctness:*` IDs are never copied, accepted, or rejected. It builds that clause from the registry's prefix accessor rather than from its own namespace literals.

## Artifact repair

A representation failure in an artifact is handled by at most one isolated `artifact-repair` operation, never by rerunning the substantive reviewer. Repair can restate evidence already present; it cannot perform review or supply missing evidence. Failure to demonstrate preservation is terminal, not permission to rerun a reviewer or manufacture a clean result.

### Eligibility

Only two failures are eligible: a status spelling that differs from an accepted value only by case, and a mixed-namespace artifact that contains both role-owned and foreign IDs. Every other schema-validation failure, including malformed JSON, structurally incomplete findings, declared blocked checks, a bare rejection ID without a reason, missing correctness coverage, absent structural-plan evidence, and a missing artifact, is a terminal `harness-failure`. The error can identify an omission, but nothing may supply the omitted evidence by inventing observations.

### Packet and isolation

The repair packet contains only the artifact role, the exact validation error, the required array fields (and the plan protocol version), the allowed prefixes from the registry, and the role-owned candidate IDs found in the original. Candidate IDs constrain identity; they do not prove that a candidate was examined, accepted, rejected, or measured. The orchestrator keeps target and revision bindings without passing repository contents to the repair.

Repair receives no diff text, repository files or instructions, review history, intent or design documents, unrelated artifacts or candidate sets, or substantive reviewer prompt. It cannot inspect code, rerun checks, discover findings, decide a verdict, or use a previous reviewer conversation.

The repair runs as a fresh invocation in a new temporary directory outside the reviewed repository's ancestry, containing only `packet.json`, the snapshot copy `original.json`, and the destination `candidate.json`. The Codex runner also launches it with a dedicated environment so repository instructions and context are not inherited, and refuses with a `harness-failure` if the directory would fall inside the repository. A shorter prompt with the ordinary reviewer launch configuration is not sufficient: when the selected provider cannot meet this boundary, the runner fails closed instead of falling back to a reviewer launch. In the Codex runner only the `codex` provider is accepted for repair. Manual drivers follow the same contract with a `mktemp -d` directory, copy only the packet and snapshot in and only the candidate back out, and never pass a state-directory path to the repair, rerun the reviewer, or edit an artifact themselves.

### Immutable evidence and acceptance

On the first eligible failure, the CLI writes create-once records in the state directory: `round-<n>-<role>.original` holds the original bytes, `round-<n>-<role>.packet.json` the packet, and `round-<n>-<role>.repair.json` the binding (target, round, role, reviewed diff hash, original content hash, packet hash, candidate path and hash, and dispatch state). Conflicting content never overwrites them. Repair writes a distinct candidate; it never overwrites the original or publishes a canonical artifact directly.

Publication requires both strict validation of the candidate and a separate preservation check against the original. The preservation check compares every field of the original other than `status` with the candidate structurally, so role-owned findings, rejections with their reasons, examined coverage, plan groups, classifications, and design evidence must be unchanged, and the candidate may not add a field the original lacks. The only permitted differences are the status spelling and the omission of foreign dispositions, and that omission is allowed only when the role-owned evidence that remains is exactly the original's role-owned evidence. A correctness-only `gate-verify` artifact contains no established gate verdict, so neither relabeling `correctness:` to `gate:` nor emitting empty `rejected` and `findings` arrays is a valid repair. Cross-namespace findings are never relabeled, fuzzy-mapped, or transferred between owners.

### One attempt, resume, and accounting

At most one repair is allowed per artifact attempt and round across ordinary execution, interruption, and resume. For unchanged sealed detector evidence, the plan has at most two semantic attempts: its original attempt and the single semantic replacement. An explicitly retryable provider failure of the replacement may additionally consume one separate transport launch in the same round; a successful incomplete result cannot restore semantic recovery. Each produced artifact has its own representation-only repair allowance; semantic rejection discards only the rejected attempt’s bindings, while `plan-dispatch` durably bounds semantic and transport dispatch even when a subprocess fails. Repair identity and dispatch state (`prepared`, `reserved`, `dispatched`) are persisted before launch. A prepared or reserved repair proceeds through `artifact-repair-dispatch`. A dispatched repair may have an already-produced candidate validated, but uncertainty about whether it ran never authorizes another launch: a dispatched repair with no candidate is a failure. Resume keeps and hash-checks pending repair records alongside hash-verified completed artifacts instead of deleting them as unfinished round output, and a mismatched target, round, role, diff, or content hash fails closed. Publication, cleanup, or context replacement never resets the consumed allowance.

The repair uses the original artifact's reservation role, with `gate` mapping to `gate-review`. The initial attempt is recorded as superseded exactly once, the repair launch is reserved before dispatch and charged once, and a budget denial prevents the launch. Initiative bindings, budgets, terminal dispositions, and round accounting are otherwise untouched. There is no automatic reviewer fallback after a repair fails, is interrupted, or is exhausted.

Repair records are round files, so `rerun` includes them in its verified content-addressed archive before cleaning up the active copies, and archived evidence cannot authorize a repair in a new run. An explicitly permitted reset of an unfinished standalone run discards its active repair evidence with the rest of that run; this does not widen reset eligibility or replenish an initiative budget. Retention ends when the state or archive storage is deleted.

Telemetry carries an `operation` field, `substantive-review` or `artifact-repair`, so repair calls, outcomes, elapsed time, and tokens are attributed separately from substantive review without a new budget role. Partial or unavailable usage stays partial, not zero.

### Rationale

Rerunning a reviewer with an appended correction prompt sends the full review context again and lets a schema-valid retry drop evidence the original contained, so normalization would not guarantee that the original evidence survives. Repair trades some automatic recovery for trustworthy evidence: omissions that a fresh reviewer might investigate now stop for explicit resolution, and the extra snapshot and dispatch state bounds cost and prevents repeated full-context review. Reusing the existing validator, role registry, reservation roles, and telemetry structure avoids a generalized retry framework and a second namespace registry.

## Plan groups

A plan group has a `changeClass` (`local` or `structural`) and an `action` (`fix` or `reconcile`), and any combination is valid. A local group whose fix needs a decision that no approved source settles reports `local` + `reconcile`. Every reconcile group requires a non-empty `reason` naming the unsettled decision, regardless of class. A structural group names its `structuralEffects`, and a structural `fix` requires design evidence bound to the run's design hash.

The plan validator, the plan prompt in `core/round-plan.js`, and the plan step in every review driver state the same rule. A test reads the `changeClass` and `action` values from the generated plan prompt and checks every pair against the validator, so the two cannot define different sets of valid plans.

`plan-fixes` treats every reconcile group the same way: it launches no fixer, records one reconciliation packet with trigger `group-reconcile` and finding counts keyed by the group's `changeClass`, and `record` stops with a decision that requires a human. A plan rejected for its action reports `action must be "fix" or "reconcile"`; a reconcile group without a reason reports that human reconciliation needs an explanation.

Allowing local reconcile gives a local finding that needs a product decision an honest encoding. Without it the only valid encodings were `local` + `fix`, which sends a product question to a fixer, and `structural` + `reconcile`, which claims a structural effect the finding does not have. The cost is a wider contract: a planner can stop a round for a local finding, and the reason text is the only guard against using it to avoid a fix.

## Residual exposure

- A reviewer can still emit false but schema-valid evidence; preservation proves continuity, not truth.
- A model can ignore the repair instruction, so enforcement rests on candidate validation and the provider isolation surface, not on wording.
- A neutral working directory is not an operating-system sandbox and does not remove ambient provider configuration or global tools; the runner verifies the context restrictions it can and fails closed where it cannot.
- The structural preservation comparison rejects harmless rewrites, and schema-validation failures outside the two eligible kinds stop the round even when a reviewer rerun might have produced a usable artifact.
- A crash after dispatch but before durable output consumes the only repair attempt without a usable result.
- A planner can classify a fixable local finding as `reconcile` and stop the round. The stop is visible in the handoff with its reason and costs a human look, not a wrong edit.

## Semantic plan acceptance and resume

Normalization seals a plan as hash-bound pending evidence in `execution.normalizedPlan`. It does not complete the plan role. `plan-fixes` validates membership against surviving findings before any fixer reservation or edit, then marks an accepted plan completed. Resume consumes a normalized pending plan without reserving another planner. Accepted plans and legacy completed evidence pass through the same semantic guard.

A schema-valid plan that omits surviving findings has a separate bounded recovery path: the CLI invalidates only plan evidence, records the missing IDs, supersedes its launch, and supplies a corrective planner prompt. One replacement may run in the unchanged round, with a fresh initiative reservation when keyed. The CLI discards stale plan repair bindings before replacement, retains other sealed evidence and spent budgets, and stops after another incomplete result. This does not extend schema repair eligibility or permit manufacturing findings. See [incomplete-plan resume](incomplete-plan-resume.md).

Execution failure of that replacement is distinct from a successfully produced invalid plan. Canonical provider diagnostics determine whether one separately reserved planner-only transport retry is actionable or a terminal handoff is required. Raw provider output is not durable evidence. See [failed planner provider recovery](planner-provider-recovery.md).

## Coverage of generated copies

A changed path counts as examined when it is listed in `examined`, or when its blob at the reviewed head equals the blob of a listed changed path. `bin/bundle.mjs` writes the Codex and Copilot copies byte for byte and the bundle-drift tests enforce that, so a reviewer who read the source has read its copies. Matching by content applies to any repository, since only Concord's own repository has bundle paths. A deleted path has no blob and must be listed by name. Two unrelated files with identical bytes cover each other; their content is the same, so the review of one is the review of the other. The same rule applies in `artifact-normalize` and in the verified-round fold that `findings` and `plan-fixes` read.

## Certificate contents

A certificate carries the group id, the exact set of resolved finding ids, the exact set of edited files with the SHA-256 of each file's current bytes, and evidence. `commit-fix` compares each of these with the plan, the fix artifact and the working tree. The invariants are not part of the certificate: the certifier is instructed to write `blocked` unless every planned invariant holds, so `ok` is the attestation, and a copy of the invariant text would only test transcription. The change is not stateful beyond this: `record` reads the same ledger and artifacts as before.

When a fix edited files but no commit landed for it, whether the certifier blocked it, `commit-fix` rejected it, or `commit-fix` never ran, `record` parks the finding as `needs-decision` with the certificate status in the park reason, keeps the fix's changed files as edited in the working tree, and restores every other path. `record` checks the declared files as `commit-fix` does and matches them literally, so a glob or a path outside the repository cannot keep an undeclared edit. If the same round also stops for reconciliation, the run keeps that stop (`gate-pending` or `intent-review`) and its reason names the kept files; otherwise it ends as parked. The person commits the edit or discards it with `git add -- <files> && git restore --source=HEAD --staged --worktree -- <files>`, which also removes files the fix created, then runs `unpark` or resolves the reconciliation stop; until then `round-start` refuses the dirty tree.
