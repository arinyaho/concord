# Review round budget

A no-DoD review target such as `file:<path>` stops continuing, and parks, when the round being decided would be its `max_rounds`-th continuing round without going dry (the check counts `spent + 1` against `max_rounds`, so the parking round is itself not charged and `spent` stays at `max_rounds - 1`), and `budget.spent` has one documented meaning for every target: the number of rounds recorded with a `continue` decision.

The budget bounds charged (continuing) rounds, not every round. A round that waits on a human (`gate-pending`, `gate-panel-pending`, `intent-review`) is not charged, and those ledger statuses are not terminal, so once the human resolves the wait `round-start` can open further rounds. The round number can therefore exceed `max_rounds` while `spent` stays below it.

## Charging

`budget.max_rounds` bounds the rounds a run works, and `budget.spent` counts the charged ones. For a no-DoD target the `max_rounds`-th round parks uncharged, so `spent` tops out at `max_rounds - 1` while the rounds worked equal `max_rounds`. Rounds that wait on a human are not charged, and a git target may open one round past `max_rounds`. `budget.spent` counts the rounds that were recorded with a `continue` decision: `record` charges one unit after it decides that another round should follow. A round whose decision is terminal (clean, parked, abandoned, or waiting on a human) is never charged, and `round-start` does not charge either. A run that ends in its first round therefore reports `spent: 0`, for example when that round is clean or parked. A round that plans no fixes but still decides `continue`, because progress was made or findings remain, is charged one unit like any other continuing round.

## Termination check

For a no-DoD target, the budget check in `decideTermination` is given `spent + 1`, so the round being decided counts as spent. Without that, the last budgeted round saw `spent = max_rounds - 1`, was allowed to continue, was charged up to `max_rounds`, and the next `round-start` opened round `max_rounds + 1`. With the round counted, a round that would be the `max_rounds`-th continuing round without going dry parks uncharged, leaving `spent` at `max_rounds - 1` (`round budget exhausted before the no-DoD target ran dry`), and a later `round-start` on that ledger returns `terminal` and leaves `round` and `budget` untouched. Convergence is checked first, so a dry final round still converges.

A git target keeps the uncounted `spent`. Because the round being decided is not counted, its final budgeted round may continue into one more round, which lets a round that applied fixes be followed by a no-fix confirmation round. A no-DoD target has no such extra round, since it converges on a dry streak and not on a confirmation. Human-wait rounds are uncharged, so they do not move `spent`.

## Dry streak

A no-DoD target converges when `dryStreak` reaches 2 with no finding open. `dryStreak` advances on a round whose new count is 0 and resets to 0 on any other round. A finding is new when it survives deduplication, was not open going into the round, is not a reopen, and was not killed by verification in the same round. A candidate that verification rejects is therefore never new, and a round in which every candidate is rejected is dry.

The history entry's `new` is the same count the streak consumes.

Counting rejected candidates as new made convergence depend on the reviewer returning an empty `findings` array twice. A reviewer is instructed to report uncertain findings, so it rarely does, and a no-DoD target kept parking on the round budget although verification had rejected everything it raised.

## Trade-offs

- A rejected re-raise no longer counts as activity, so the loop can converge while the reviewer keeps raising candidates that verification rejects. Convergence then rests on the verifier's judgement and not on the reviewer running out of candidates.
- A verifier that wrongly rejects a real finding in two consecutive rounds yields a clean exit that misses it. The ledger still records the killed findings, so the history shows what was rejected.
- A no-DoD run whose last budgeted round applied fixes parks instead of getting one more round. A run that needs it needs a larger budget.
- A git run can still open a round past `max_rounds`.
- The default round budget is 5, the initial `budget.max_rounds` of a new review.
