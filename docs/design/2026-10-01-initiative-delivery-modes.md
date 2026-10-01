# Initiative delivery modes

An initiative run has a delivery mode, `base` or `lite`, stored in its run ledger. `base` is the default and runs the full review: correctness, verify, and the gate pair. `lite` is opt-in per run and reduces only the cross-cutting gate to a design-conformance check, so work whose risk is local does not pay for the full gate on every round.

## Ledger and mode

The run ledger is schema version 5 and carries `mode` (`base` or `lite`) and, after an escalation, `escalation: { from, to, trigger }`. Version 4 and older ledgers are rejected, not upgraded. The error tells the operator to start a new run key, `rerun` each ref, and remap the initiative skill's source index to the new key. There is no migration path, so a replay never infers a mode the ledger does not state.

`mode` is not part of the budget-equality check performed when a run is reopened. Reopening is keyed on the budgets alone and the ledger's stored mode is authoritative, so a driver that restarts without a flag cannot silently change a run's mode. A caller that passes a mode that disagrees with the ledger is refused.

Budgets are sized by the caller for the mode. The core enforces the stored budgets, not a mode-specific cap: lite uses fewer launches per round because it launches fewer reviewers, and the caller opens the run with a budget that reflects that.

## Lite gate

In a keyed `round-start`, the review CLI reads the run's mode. In `lite` it launches `correctness`, `verify`, and a single `gate` reviewer whose prompt asks only for `gate:design-conformance:<slug>` findings and states that ac-coverage, cross-context and silent-gap findings are not reported. There is no `gate-verify` reviewer and no gate panel, and the round's expected artifact set excludes `gate-verify`. `plan-fixes` rejects any lite gate finding whose class is not design-conformance. `round-start` in a lite run rejects `--broad`, `--no-broad` and `--gate`, because each would change the reviewer set the mode defines. The rejection happens before any state is written.

The Codex runner opens the run itself and passes the run key, canonical state directory, budgets and mode to every `round-start` it invokes, so both distributions read the same mode from the same ledger. The Claude and Copilot drivers pass them explicitly. A prompt that differs only in its class list is the only per-mode text difference, so the prompt text is built by one function with a `gateMode` option and the drivers do not carry their own copies.

## Escalation

A lite run escalates to base when a reviewer or the implementer finds that the change is not locally scoped. `escalate <ref> <trigger>` records the trigger and resizes the budget to the base size. The trigger is one of a fixed set: `public-api`, `schema`, `security`, `cross-package`, `migration`, `reviewer-finding`. Escalation is one-way and is refused after the first launch, because a run that already spent launches under the lite reviewer set would otherwise mix two gate regimes inside one budget. After the first launch the only way to a base review is a new run key.

## Native driver verbs

The native driver gains the verbs that the Codex runner already performs in code, so a host-driven run can reach the same terminal state:

- `finalise` ends the run. Later `reserve` calls are denied as `inactive`.
- `consume <claim>` acknowledges a delivery claim. `record` prints the claim of the disposition it writes, and `consume` marks it consumed exactly once. A second consume fails.
- `escalate` as above.

These are run-level verbs. They require a run key and do not take the per-target ledger lock, because they touch the initiative ledger only.

## Run lock recovery

The run ledger lock is an exclusive `mkdir`. The holder records its pid in the lock directory. A contender that finds the lock held by a dead pid removes it and retries once. An ownerless lock is treated as stale only when it is older than a fixed age, because a holder that has just created the directory has not yet written its pid. A lock held by a live process is never taken. When the lock cannot be acquired, the denial includes a diagnosis naming the lock path, the owner pid and whether it is running, and the command that removes the lock by hand. Only the run lock recovers: the target-ledger lock keeps its existing behavior of never being reclaimed automatically.

## Initiative delivery skill

The `initiative-to-prs` skill passes a run key to every review call, persists the mode in its state and final report, and replaces the unbounded stage repeat loop with one bounded fix pass and one fresh verification of the revision pair that pass produced. A confirmed contract or architecture finding parks the dependent work instead of continuing past it. The skill documents when lite is eligible (local, reversible, no public contract, schema, security or cross-package change) and requires escalation to base before any dependent implementation when a trigger applies, with the trigger recorded in the handoff.

The skill forbids launching reviewers outside the plan under new task names. A host can still spawn an agent the plan did not name, and no code can prevent that. What the keyed run guarantees is that such an agent cannot produce accepted evidence: acceptance requires a matching reservation.

## Rejected alternatives

- Selecting lite automatically from the diff. A heuristic that downgrades review without a person choosing it fails silently in the case that matters, so the mode is an explicit opt-in.
- Dropping the gate entirely in lite. Design conformance is the part of the gate that checks the change against the agreed contract; removing it removes the only check that the change is the one that was approved.
- Migrating v4 ledgers by defaulting their mode to base. It would keep a second schema path alive and hide the source-index remap the new key requires.
- Letting escalation happen after launches. It would require reconciling findings produced under two reviewer sets against one budget.

## Residual exposure

- Lite reduces coverage on purpose. A cross-context or silent-gap defect in a lite run is not reported by the gate, so eligibility is a human judgment that the skill states but code cannot check.
- The trigger set is fixed text; a reason outside it is refused, so a new class of trigger needs a code change.
- A host can launch reviewers the plan does not name. Their output is not accepted, but their cost is not prevented.
- Stale-lock recovery by pid is only meaningful on one machine. A lock created by a process on another host sharing the state directory looks dead locally and could be reclaimed.
- The pid check races pid reuse: a dead holder whose pid was reassigned to an unrelated live process is treated as live, and the operator must remove the lock by hand using the printed command.
