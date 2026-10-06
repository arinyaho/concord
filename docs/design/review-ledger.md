# Review ledger

The per-ref review ledger holds a target's rounds, budget, findings, and history. This document covers how its round budget is charged and when a target terminates, and how the ledger is written and read safely.

## Round budget

`budget.max_rounds` bounds the rounds a run works, and `budget.spent` has one meaning for every target: the number of rounds recorded with a `continue` decision. `record` charges one unit after it decides that another round should follow. A round whose decision is terminal (clean, parked, abandoned, or waiting on a human) is never charged, and `round-start` does not charge either, so a run that ends in its first round reports `spent: 0`. A round that plans no fixes but still decides `continue`, because progress was made or findings remain, is charged like any other continuing round. The default round budget of a new review is 5.

The budget bounds charged rounds, not every round. A round that waits on a human (`gate-pending`, `gate-panel-pending`, `intent-review`) is not charged, and those statuses are not terminal, so once the human resolves the wait `round-start` can open further rounds. The round number can therefore exceed `max_rounds` while `spent` stays below it.

### Termination check

For a target with no Definition of Done, such as `file:<path>`, the budget check in `decideTermination` is given `spent + 1`, so the round being decided counts as spent. A round that would be the `max_rounds`-th continuing round without going dry parks uncharged, leaving `spent` at `max_rounds - 1` (`round budget exhausted before the no-DoD target ran dry`), and a later `round-start` on that ledger returns `terminal` and leaves `round` and `budget` untouched. Convergence is checked first, so a dry final round still converges. Without the `+ 1`, the last budgeted round would continue, be charged up to `max_rounds`, and let the next `round-start` open round `max_rounds + 1`.

A git target keeps the uncounted `spent`. Its final budgeted round may continue into one more round, which lets a round that applied fixes be followed by a no-fix confirmation round.

### Dry streak

A no-DoD target converges after one round with no new or open finding and no fix applied. `dryStreak` advances on a round whose new count is 0 and resets on any other round. A finding is new when it survives deduplication, was not open going into the round, is not a reopen, and was not killed by verification in the same round. A candidate that verification rejects is therefore never new, and a round in which every candidate is rejected is dry. A round that applies a fix cannot converge; the changed target receives one subsequent clean confirmation. The history entry's `new` is the same count the streak consumes.

Rejected candidates do not count as new because a reviewer is instructed to report uncertain findings and rarely returns an empty list. Counting them made convergence depend on the reviewer returning nothing twice, and a no-DoD target kept parking on the round budget although verification had rejected everything it raised.

## Atomic writes

`core/atomic-write.js` writes a temporary file beside the target and renames it over the target, so a reader never sees partial content. The review ledger, the initiative run ledger, the Codex runner telemetry, and the intent file written by the review CLI all use it; none renames directly.

On Windows a rename over a file another process holds open (antivirus, indexer, sync client) can fail transiently with `EPERM`, `EACCES`, or `EBUSY`. The helper retries those three codes a bounded number of times with doubling backoff, synchronously, because every caller is synchronous. Any other error is not retried. When the helper gives up it removes its temporary file and throws the last error, so a failed write leaves the previous file intact and no stray temporary file.

## Fail-closed reads

`readLedger` returns `null` only when the ledger file is missing. Any other read or parse error throws an error that names the file. `round-start` fails on such an error and leaves the file untouched, because treating an unreadable ledger as absent would start a fresh run with a new attempt id, a reset budget, and lost parked findings.

An unreadable ledger cannot establish a standalone identity or an absent initiative binding. Mutations, including `reset` and `rerun`, refuse it and preserve its bytes, history, and evidence. Recovery means restoring the original readable ledger from retained state and reconciling its identity, initiative binding, and spent budget before any mutation. A readable standalone target may then use `reset`; an initiative-bound target requires `rerun` with its original options, retaining evidence and spent budget.

The SessionStart injectors list ledgers through `listLedgers`, which returns an entry per unreadable ledger carrying its file name. The report prints one line per unreadable file directing preservation, restoration, and reconciliation, and still lists every readable ledger. The injectors keep their catch-all so a session never fails to start.

Only review ledgers and initiative run ledgers are fail-closed. The charter read policy (`readNorthStar` and similar) degrades a missing or corrupt file to "nothing yet", because a charter is advisory context, while a review ledger carries budget and parked-finding state that a silent reset would forge. Failing closed everywhere was rejected: one corrupt advisory file would block every session.

### Manual recovery without a backup

An operator who independently knows that the target was standalone may stop all workers using it and move the unreadable ledger and its related round artifacts and telemetry into a private quarantine outside the active state directory, then start a fresh standalone review, accepting that previous rounds, findings, and history cannot be recovered. Retain the quarantined files for investigation. If the binding is unknown or the target belongs to an initiative, preserve its original state and reconcile its identity and spent budget; moving files must not bypass initiative limits.

## Target serialization and archive retention

Every target mutation, including standalone operations, holds the target lock. DoD execution can keep it held longer than the 10-second contention wait. Callers serialize operations on the same target and wait for the owner to finish; a live owner's lock is never removed merely because the wait expired.

`rerun` archives the full diff, ledger, and role evidence of the finished run under `review-archives/<slug>/<id>`, content-addressed and hash-verified before the active copies are cleaned up. There is no automatic garbage collection, because active rerun cleanup, run-history pointers, and feedback proofs depend on those files and hashes. After retiring the target and initiative, an operator may move the whole state store to private offline storage, and delete it only after its dependent history and feedback records are retired and the loss of recovery and audit evidence is accepted. Referenced archives are never deleted selectively.

## Trade-offs and residual exposure

- Rejected-candidate convergence rests on the verifier's judgement, not on the reviewer running out of candidates. A verifier that wrongly rejects a real finding yields a clean exit that misses it, though the ledger still records the killed finding.
- A no-DoD run whose last budgeted round applied fixes parks instead of getting one more round; it needs a larger budget. A git run can still open a round past `max_rounds`.
- A corrupt review ledger blocks its ref until the original readable ledger and binding are restored and reconciled. Without recoverable original state the review stays blocked; discarding the file would lose budget and findings.
- Retry is bounded, so a rename blocked longer than the backoff window still fails the write, with the previous file intact. Retry behavior is verified only with injected rename failures, not on Windows.
- The atomic-write helper does not `fsync`. Readers see the old or the new file, but a write may not survive a crash or power loss, which can also leave a stray temporary file.
- Archives grow without bound for long initiatives; disk usage needs monitoring.
