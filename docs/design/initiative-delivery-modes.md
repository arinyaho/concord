# Initiative delivery modes

An initiative run has a delivery mode, `base` or `lite`, stored in its run ledger. `base` is the default and runs the full review: correctness, verify, and the gate pair. `lite` is opt-in per run and reduces only the cross-cutting gate to a design-conformance check, so work whose risk is local does not pay for the full gate on every round. The run ledger, budgets, and reservation contract are described in the [initiative review runs design](initiative-review-runs.md).

## Ledger and mode

The run ledger (schema version 5) carries `mode` and, after an escalation, `escalation: { from, to, trigger }`. A ledger of an older version is rejected, and the error tells the operator to start a new run key, `rerun` each ref, and remap the initiative skill's source index to the new key.

The budget-equality check performed when a run is reopened ignores the mode. The stored mode is authoritative and the core reopen never changes it, so a driver that restarts without a flag cannot silently change a run's mode. The review CLI refuses an `--initiative-mode` flag that disagrees with the stored mode. `carry` refuses a new run whose mode differs from the old run's, so a target never continues its round under a different reviewer set than the one that started it.

The caller supplies the budgets, both at open and at escalation. The core enforces the stored budgets and applies no mode-specific cap: lite uses fewer launches per round because it launches fewer reviewers, and the caller sizes the budget accordingly. `escalate` replaces the stored budgets with the base-sized budgets the caller supplies, so a reopen after escalation must present the escalated budgets.

## Lite gate

In a keyed `round-start`, the review CLI reads the run's mode. In `lite` it launches `correctness`, `verify`, and a single `gate` reviewer whose prompt asks only for `gate:design-conformance:<slug>` findings and states that ac-coverage, cross-context, and silent-gap findings are not reported. There is no `gate-verify` reviewer and no gate panel, and the round's expected artifact set excludes `gate-verify`. `plan-fixes` rejects any lite gate finding whose class is not design-conformance. `round-start` in a lite run rejects `--broad`, `--no-broad`, and `--gate`, because each would change the reviewer set the mode defines; the rejection happens before any state is written.

The Codex runner opens the run itself and passes the run key, state directory, budgets, and mode to every `round-start` it invokes; the Claude and Copilot drivers pass them explicitly. Both read the same mode from the same ledger. The lite gate prompt is built by `reviewerPrompt` with a `gateMode` option, and the copies embedded in the driver documents are kept in sync with it by `round-plan-sync.test.js`.

## Escalation

A lite run escalates to base when the caller determines, before the first launch and from eligibility known up front, that the change is not locally scoped. `escalate <trigger>` records the trigger and replaces the stored budgets. The trigger is one of a fixed set, one per lite eligibility exclusion: `public-api` (public API or deployment-boundary change), `security` (security, authorization, identity, or cryptography), `migration` (data migration), `legal` (legal, regulatory, or external-data-rights decision), `cross-repository` (more than one repository, or cross-repository integration), `multi-outcome` (more than one independently testable outcome), `unsettled-contract` (the contract is not yet settled), plus `schema` and `cross-package` for narrower scope creep.

Escalation is one-way and is refused after the first launch, because a run that already spent launches under the lite reviewer set would otherwise mix two gate regimes inside one budget. When a lite review that has already launched surfaces non-local scope, the run is not escalated in place: the dependent work parks and a new run key starts in base mode.

## Native driver verbs

The native driver has the run-level verbs the Codex runner performs in code, so a host-driven run can reach the same terminal state:

- `finalise` ends the run. Later `reserve` calls are denied as `inactive`.
- `consume <claim>` acknowledges a delivery claim. `record` prints the claim of the disposition it writes, and `consume` marks it consumed exactly once; a second consume fails.
- `escalate <trigger>` as above.

These verbs require a run key and do not take the per-target ledger lock, because they touch the run ledger only.

## The initiative-to-prs workflow

The `initiative-to-prs` skill passes a run key to every review call, persists the mode in its state and final report, and replaces an unbounded stage repeat loop with one bounded fix pass and one fresh verification of the revision pair that pass produced. A confirmed contract or architecture finding parks the dependent work instead of continuing past it. The skill states when lite is eligible (one repository, one independently testable outcome, a settled contract, no public API or deployment-boundary change, no security, authorization, identity, or cryptography change, no data migration, no legal, regulatory, or external-data-rights decision, no cross-repository integration) and requires escalation to base before any dependent implementation when a trigger applies, with the trigger recorded in the handoff.

The skill forbids launching reviewers outside the plan under new task names. A host can still spawn an agent the plan did not name, and no code can prevent that; what the keyed run guarantees is that such an agent cannot produce accepted evidence, because acceptance requires a matching reservation.

### Deep decision gate

A task that decides what something should be, the content or wording of a rule, contract, interface, schema, or architecture, is design work and requires Deep capability; applying a decision already made stays with the active agent, and the reader splits a task that mixes both. A separate Deep-capability specialist in clean context must do the design work. The active orchestrator never satisfies this gate itself, regardless of its model, reasoning effort, or self-assessment.

Before the first human checkpoint, the handoff identifies the decision, the specialist invocation or agent, the requested and resolved model, the provider or catalog basis, the reasoning effort when exposed, the completed conclusion, and unresolved assumptions. A cryptography, security, or migration decision also requires a second independent Deep reviewer with separate evidence.

The checkpoint and the following stage do not proceed when the handoff is missing or unreadable, a model identity is unresolved, the specialist did not complete successfully, the evidence does not cover the proposed decision, or required independent-review evidence is absent. User approval cannot replace missing technical evidence. The general permission to avoid unnecessary delegation is subordinate to this gate.

The cost is a separate specialist call even when the active agent is Deep-capable. It buys an observable boundary and removes self-certification from a workflow whose orchestrator is normally a general-capability model.

## Rejected alternatives

- Selecting lite automatically from the diff. A heuristic that downgrades review without a person choosing it fails silently in the case that matters, so the mode is an explicit opt-in.
- Dropping the gate entirely in lite. Design conformance is the part of the gate that checks the change against the agreed contract; removing it removes the only check that the change is the one that was approved.
- Migrating older ledgers by defaulting their mode to base. It would keep a second schema path alive and hide the source-index remap the new key requires.
- Letting escalation happen after launches. It would require reconciling findings produced under two reviewer sets against one budget.
- Letting a Deep-capable orchestrator certify its own Deep decision. A role label such as "active root agent" is not separately observable evidence.

## Residual exposure

- Lite reduces coverage on purpose. A cross-context or silent-gap defect in a lite run is not reported by the gate, so eligibility is a human judgment the skill states but code cannot check.
- The trigger set is fixed; a reason outside it is refused, so a new class of trigger needs a code change.
- A host can launch reviewers the plan does not name. Their output is not accepted, but their cost is not prevented.
- The Deep decision gate is a skill contract. There is no harness-owned model receipt and no hook that intercepts the checkpoint or tracker mutations, so the gate cannot be made unbypassable at runtime; an agent-authored record cannot establish model capability. A hard guarantee requires a harness-owned receipt plus a mandatory transition or mutation interception point.
