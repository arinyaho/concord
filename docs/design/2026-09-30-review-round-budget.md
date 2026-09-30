# Review round budget

A no-DoD review target such as `file:<path>` never opens a round past its declared round budget, and `budget.spent` has one documented meaning for every target.

## Charging

`budget.max_rounds` is the number of rounds a run may work. `budget.spent` counts the rounds that were recorded with a `continue` decision: `record` charges one unit after it decides that another round should follow. A round whose decision is terminal (clean, parked, abandoned, or waiting on a human) is never charged, and `round-start` does not charge either. A run that ends in its first round therefore reports `spent: 0`, and so does a git round that plans no fixes, because with no fix that round is either the clean confirmation round or a park.

## Termination check

For a no-DoD target, the budget check in `decideTermination` is given `spent + 1`, so the round being decided counts as spent. Without that, the last budgeted round saw `spent = max_rounds - 1`, was allowed to continue, was charged up to `max_rounds`, and the next `round-start` opened round `max_rounds + 1`. With the round counted, a round that reaches `max_rounds` without going dry parks (`round budget exhausted before the no-DoD target ran dry`), and a later `round-start` on that ledger returns `terminal` and leaves `round` and `budget` untouched. Convergence is checked first, so a dry final round still converges.

A git target keeps the uncounted `spent`. Its final budgeted round that applied fixes continues into one confirmation round, because a round that applied fixes cannot itself be the clean round and the fixes need a no-fix round to prove they hold. That confirmation round is the only round a git run may open past `max_rounds`; a no-DoD target has no such round, since it converges on a dry streak and not on a confirmation.

## Trade-offs

- A no-DoD run whose last budgeted round applied fixes parks instead of getting one more round. A run that needs it needs a larger budget.
- A git run can still open one confirmation round past `max_rounds`.
- The default budget is unchanged.
