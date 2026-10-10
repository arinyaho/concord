# Review ledger

The per-ref review ledger holds a target's rounds, budget, findings, and history. This document covers how its round budget is charged and when a target terminates, and how the ledger is written and read safely.

## Round budget

`budget.max_rounds` bounds the rounds a run works, and `budget.spent` has one meaning for every target: the number of rounds recorded with a `continue` decision. `record` charges one unit after it decides that another round should follow. A round whose decision is terminal (clean, parked, abandoned, or waiting on a human) is never charged, and `round-start` does not charge either, so a run that ends in its first round reports `spent: 0`. A round that plans no fixes but still decides `continue`, because progress was made or findings remain, is charged like any other continuing round. The default round budget of a new review is 5.

The budget bounds charged rounds, not every round. A round that waits on a human (`gate-pending`, `gate-panel-pending`, `intent-review`) is not charged, and those statuses are not terminal, so once the human resolves the wait `round-start` can open further rounds. The round number can therefore exceed `max_rounds` while `spent` stays below it.

### Termination check

For a target with no Definition of Done, such as `file:<path>`, the budget check in `decideTermination` is given `spent + 1`, so the round being decided counts as spent. A round that would be the `max_rounds`-th continuing round without going dry parks uncharged, leaving `spent` at `max_rounds - 1` (`round budget exhausted before the no-DoD target ran dry`), and a later `round-start` on that ledger returns `terminal` and leaves `round` and `budget` untouched. Convergence is checked first, so a dry final round still converges. Without the `+ 1`, the last budgeted round would continue, be charged up to `max_rounds`, and let the next `round-start` open round `max_rounds + 1`.

A git target keeps the uncounted `spent`. Its final budgeted round may continue into one more round, which lets a round that applied fixes be followed by a no-fix confirmation round.

### Dry streak

A no-DoD target converges after one round with no new or open finding and no fix applied. Such a target is reviewed whole every round, so `record` marks `resolved` any open finding the round did not report, such as one reopened by `unpark`; it gets no seen entry, so a later report of it is new again. `dryStreak` advances on a round whose new count is 0 and resets on any other round. A finding is new when it survives deduplication, was not open going into the round, is not a reopen, and was not killed by verification in the same round. A candidate that verification rejects is therefore never new, and a round in which every candidate is rejected is dry. A round that applies a fix cannot converge; the changed target receives one subsequent clean confirmation. The history entry's `new` is the same count the streak consumes.

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

## Unparked findings

`unpark` reopens a parked finding, drops its seen entry, marks it `reopened_by_unpark` and clears the ledger's diff hash. If the next round reports it again, it is processed like any other finding and the mark is dropped. If that round does not report it and the round examined the finding's file (the correctness reviewer listed it in `examined`, or on a git target it is a changed path whose blob equals that of a listed changed path, the same rule the coverage check applies), `record` marks it `resolved` with no seen entry, so the run can converge and, on a git target, run its final DoD. A round that did not examine the file leaves it open, and the run parks on no progress as before. Only findings reopened by `unpark` get this rule on a git target, because a git round reviews a diff and a reviewer that merely fails to repeat an ordinary finding must not close it. A no-DoD target resolves every unreported open finding, as described under the dry streak.

Clearing the diff hash makes the next `round-start` open a round even when no commit landed since the park. Without it the unchanged diff makes `round-start` print `no-op`, no round re-examines the finding, and the rule above never runs; this is the usual case when the fixer reported no edit because the reviewed head already carried the fix. `record-fix` on a `gate-pending` ledger clears the hash for the same reason. A marker that `round-start` reads to re-review stable content was rejected: it adds a second path to the same effect. The forced round is an ordinary round: it spends the round budget as any round does, and on a target without a final DoD a quiet round counts toward the dry streak.

A separate `resolve` verb that a person runs with the same evidence was rejected: the evidence it would check is the round `record` already folds, and the target would still park first and wait for a manual step. Previous rejections, finding ids, the journal and both budgets are untouched by the resolution.

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| git, finding parked | `unpark` | finding `open` with `reopened_by_unpark`, seen entry dropped, ledger `converging` | changed | `applyRoundOutcome: an unparked git finding resolves only when the round examined its file` |
| git, finding parked, no commit since | `unpark`, then `round-start` | a round opens (`decision: work`); it was `no-op` before | introduced | `#312: round-start after unpark starts a round although no commit landed since the park` |
| git, unparked finding open | next round does not report it; its file in `examined` | finding `resolved`, no seen entry; run converges and the final DoD runs | introduced | `#308: a git round that no longer reports an unparked finding resolves it, converges and runs the final DoD` |
| git, unparked finding open | next round does not report it; its file not in `examined` | finding stays `open`; run parks on no progress | introduced | `applyRoundOutcome: an unparked git finding resolves only when the round examined its file` |
| git, unparked finding open | next round reports it | mark dropped; finding goes to the fixer; no convergence that round | unchanged | `#308 control: an unparked finding the round reports again goes to the fixer and the run does not converge` |
| git, finding open without the mark | round does not report it | stays `open`; run parks on no progress | unchanged | `#308 control: an open git finding that no unpark reopened stays open when a round does not report it` |
| git, unparked finding open | verification rejects its re-report | finding `killed` with a seen entry, as for any rejected candidate | unchanged | existing rejection tests in `review-cli.test.js` |

## Review base

A git target is reviewed as the range from the merge base of its base ref and the head to the head. Without a base the range is the head against itself, an empty diff that would be reviewed as work and converge clean, so `round-start` takes the base from its second argument and otherwise from the base the target's ledger recorded at its fresh start. It does not pick a default base itself: the review driver passes the remote main branch when the user names none, and a local branch used as a default can be behind its remote. File targets use no base.

A ledger in a terminal status (`clean`, `parked`, `abandoned`) whose head the repository still reaches makes `round-start` print `decision: "terminal"` before the range is built, so a head that has since been merged into the recorded base still reports the stored decision. A fresh start or a resume of a non-terminal ledger whose base and head resolve to the same commit still fails with a harness failure.

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| fresh git target, no ledger | `round-start <ref>` with no base | refused, message names the base argument; no ledger, artifact or lock is written | introduced | `round-start on a git ref with no base and no ledger refuses and names the base` |
| ledger recording no base | `round-start <ref>` with no base | refused as above | introduced | covered by the same guard; tests seed a recorded base instead |
| fresh git target | base resolves to the head | harness failure `review base and head resolve to the same commit`; no round starts | introduced | `round-start fails closed when the base and the head are the same commit` |
| fresh git target | head already contained in the base (merge base is the head) | same harness failure | introduced | `round-start fails closed when the head is already contained in the base` |
| resume | no base argument | recorded base is used; the same-commit check applies to that range | unchanged for the base, introduced for the check | resume tests in `review-cli.test.js` (unpark, fixes, DoD retry) |
| DoD retry or rerun | head equals the earlier reviewed head | the empty range from the earlier head is reviewed; no failure | unchanged | `git target: repeated failed final DoD attempts consume and stop at the round budget` |
| file target | any | no base is read | unchanged | `e2e-file-target.test.js` |

Only the missing-base refusal runs before the intent-review and gate-pending resets, which delete the cached intent. The same-commit check runs where the range is built, after those resets, so a failure there leaves the cached intent deleted; the next fresh start fetches it again. A branch whose commits net to an empty diff (a revert pair) has a merge base other than the head and still runs.

## Trade-offs and residual exposure

- Rejected-candidate convergence rests on the verifier's judgement, not on the reviewer running out of candidates. A verifier that wrongly rejects a real finding yields a clean exit that misses it, though the ledger still records the killed finding.
- A no-DoD run whose last budgeted round applied fixes parks instead of getting one more round; it needs a larger budget. A git run can still open a round past `max_rounds`.
- A corrupt review ledger blocks its ref until the original readable ledger and binding are restored and reconciled. Without recoverable original state the review stays blocked; discarding the file would lose budget and findings.
- Retry is bounded, so a rename blocked longer than the backoff window still fails the write, with the previous file intact. Retry behavior is verified only with injected rename failures, not on Windows.
- The atomic-write helper does not `fsync`. Readers see the old or the new file, but a write may not survive a crash or power loss, which can also leave a stray temporary file.
- Archives grow without bound for long initiatives; disk usage needs monitoring.
- An unparked git finding whose file no later round examines still parks the run on no progress, and the recovery verbs stay refused.
- `examined` is the reviewer's own claim. A reviewer that lists a file but misses a defect still present in it resolves an unparked finding wrongly; on a git target only the final DoD can catch that.

## Pending plan and bounded semantic retry

`execution.normalizedPlan` seals a plan hash before semantic acceptance; `plan` remains pending until `plan-fixes` accepts its membership. Same-scope resume preserves this artifact and reports it in `normalizedArtifacts` so drivers consume it without relaunching. Acceptance adds `plan` to completed roles and clears the pending hash.

An incomplete plan records a plan failure and `execution.planRetry`, including missing IDs, rejected hash, retry state and whether stale plan repair evidence must be discarded. Re-reading the rejected attempt does not supersede another launch. Resume retains this state and the other completed role hashes; one replacement is allowed even for an unkeyed target. A second incomplete result records exhaustion, and another same-scope resume fails before launching any role. The round number and charged round budget do not change. Keyed replacements additionally consume fresh reservations under the same run key. See [incomplete-plan resume](incomplete-plan-resume.md).

A failed replacement retains a canonical provider diagnostic in `execution.failure` and the bounded failure history. `execution.planTransportRetry` records a separate one-launch allowance (`pending`/zero attempts, `dispatched`/one attempt, or `exhausted`); it never clears `planRetry.launched`. Only positively identified rate limiting or transient execution failure makes this recovery actionable. `plan-dispatch` consumes it after a fresh reservation. Successful normalized or representation-repair evidence may be resumed without redispatch; failure or missing evidence after dispatch cannot authorize another process. CLI results, runner packets and session reports derive continuation from the same durable state. Terminal and legacy exhausted states require handoff and do not invite resume. See [failed planner provider recovery](planner-provider-recovery.md).
