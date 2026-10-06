# Local group reconciliation

## Decision

A plan group may use `action: "reconcile"` with either `changeClass`. A local group whose fix needs a decision that no approved source settles reports it as `local` + `reconcile` with a `reason` that names the unsettled decision. Every reconcile group requires a non-empty `reason`, regardless of class.

The plan validator, the plan prompt in `core/round-plan.js`, and the plan step in every review driver state the same rule. A test reads the `changeClass` and `action` values from the generated plan prompt and checks every pair against the validator, so the two cannot define different sets of valid plans.

`plan-fixes` treats any reconcile group like a structural reconcile group: it launches no fixer, records one reconciliation packet, and `record` stops with a decision that requires a human. The packet trigger is `group-reconcile` and its finding counts are keyed by the group's `changeClass`.

Structural groups are unchanged: a structural group still names `structuralEffects`, and a structural `fix` still requires design evidence bound to the run's design hash. Plans that were valid before the change remain valid.

A plan that is rejected for its action reports `action must be "fix" or "reconcile"`; a reconcile group without a reason reports that human reconciliation needs an explanation.

## Trade-off

The alternative was to keep the validator and tell the planner that a local finding needing a decision goes elsewhere. No other path carries a per-finding product question: the only valid encodings were `local` + `fix`, which sends a product question to a fixer, and `structural` + `reconcile`, which claims a structural effect the finding does not have. Allowing local reconcile gives that finding an honest encoding at the cost of a wider contract: a planner can now stop a round for a local finding, and the reason text is the only guard against using it to avoid a fix.

## Residual exposure

A planner can classify a fixable local finding as `reconcile` and stop the round. The stop is visible in the handoff with its reason and costs a human look, not a wrong edit. A ledger written by an earlier version that holds a `structural-fix` reconciliation packet is not recognized by `record`; the earlier run must be restarted.
