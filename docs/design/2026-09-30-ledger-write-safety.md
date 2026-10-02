# Ledger write safety

Durable review state is written through one atomic-write helper, and a review ledger that exists but cannot be read stops the run instead of being treated as absent.

## Atomic writes

`core/atomic-write.js` writes a temporary file beside the target and renames it over the target, so a reader never sees partial content. The ledger write (`writeLedger`), the initiative run write, the Codex runner telemetry write, and the intent file write in the review CLI all use it; none calls `renameSync` directly.

On Windows a rename over a file another process holds open (antivirus, indexer, sync client) can fail transiently with `EPERM`, `EACCES`, or `EBUSY`. The helper retries those three codes a bounded number of times with doubling backoff, synchronously, because every caller is synchronous. Any other error is not retried. When the helper gives up it removes its temporary file and throws the last error, so a failed write leaves the previous file intact and no stray temporary file.

## Fail-closed review ledger reads

`readLedger` returns `null` only when the ledger file is missing. Any other read or parse error throws an error that names the file. `round-start` used to read `readLedger(...) || emptyLedger(...)`, so a transient or corrupt read started a fresh run with a new attempt id, a reset budget, and lost parked findings. It now fails and leaves the file untouched.

An unreadable ledger cannot establish a standalone identity or an absent initiative binding. Mutations, including `reset` and `rerun`, refuse it and preserve its bytes, history and evidence. Restore the original readable ledger from retained state and reconcile its identity, initiative binding and spent budget before any mutation. A readable standalone target may use `reset`; an initiative-bound target requires `rerun` with its original options, retaining evidence and spent budget.

The SessionStart injectors list ledgers through `listLedgers`, which returns an entry per unreadable ledger carrying its file name. The report prints one line per unreadable file naming it and directing preservation, restoration and identity/binding reconciliation, and still lists every readable ledger. The injectors keep their catch-all so a session never fails to start.

## Scope of fail-closed

Only review ledgers are fail-closed. The charter read policy (`readNorthStar` and similar) still degrades a missing or corrupt durable file to "nothing yet", because a charter is advisory context and a review ledger carries budget and parked-finding state that a silent reset would forge. Initiative run ledgers were already fail-closed.

## Rejected alternative: fail closed everywhere

Applying the same rule to the charter and other durable files was rejected: it would let one corrupt advisory file block every session, and it changes a documented policy that this design does not need to change.

## Trade-offs and residual exposure

- A corrupt review ledger blocks its ref until the original readable ledger and binding are restored and reconciled. Without recoverable original state, the review remains blocked; discarding the file would lose budget and findings.
- Recovery preserves the original file and associated artifacts until identity and spent-budget reconciliation permits a mutation. Restoring context alone cannot reset a budget or pass a review gate.
- Retry is bounded, so a rename blocked longer than the backoff window still fails the write. The caller sees the error and the previous file is intact.
- The helper does not `fsync`. It guarantees readers see the old or the new file, not that a write survives a crash or power loss, which can also leave a stray temporary file.
- Retry and backoff behavior is verified only with injected rename failures. It is not verified on Windows.
