# Revision-pair targets under an initiative run key

Under one initiative run key, a target is identified by its revision pair: the ref, the base, and the head (`head_sha`, which is a content identity for a file target). For a repository ref the stored base is the commit the base name resolves to when the pair is built, never the name: a base that moves under the same name, such as a remote default branch that advances, is a different pair even when the head is unchanged. A base that does not resolve is stored as given, and `round-start` rejects it. The per-ref review ledger keeps the base name. A terminal disposition belongs to one revision pair. The same ref on a new head or a new base is a new target under the same run key, so a fix pass or base drift can be re-verified without opening a new run key and without leaving the shared budget.

## Behaviour

- A terminal disposition refuses every later launch and every later terminal record for its own revision pair, and only for that pair. Replay of a terminal or unconsumed escape disposition (the Codex runner's preflight) matches the full pair too. Another head or base of the same ref proceeds to `round-start`.
- A launch on a new revision pair reserves launches and rounds from the same global run budget as every other launch under the key. Each pair adds its own entry to the run's target list, so the aggregate output carries one hashed identifier per pair and counts only. Raw refs and SHAs stay in the local run ledger.
- While the run holds a `reconciliation-required` reconciliation hint, a launch on a revision pair the run has not yet opened is refused as `reconciliation-required` and consumes nothing. Pairs already opened keep working, so a target that is mid-review is not cut off by another target's park. The Codex runner checks this before `round-start`, so a refused pair never runs the DoD or moves the per-ref ledger into gates. The hint is never cleared inside a run: resolving it is a human decision, and a materially approved contract revision starts a new run key.
- A refusal has one of five causes, in this order: `inactive` (the run is no longer active, the ledger is missing, or the round or count is invalid; native `reserve` reports it as a `reason`), `reconciliation-required`, `target-terminal`, `budget-exhausted` (launch budget or round budget), or lock contention. Native `reserve` answers `reconciliation-required` as its status, and `denied` with a `reason` for the others (no `reason` for contention). The Codex runner returns `{ decision: 'reconciliation-required' }` or `{ decision: 'blocked', reason: 'budget-exhausted' }` for `reconciliation-required` and `budget-exhausted`, without recording an error disposition, and the Codex launcher prints that result and exits non-zero for both; contention and a terminal pair stay errors, as they signal a defect or a race and not a decision.
- The per-ref target ledger is unchanged. It stays terminal until `rerun <ref>`, which re-arms it and archives the finished run. A re-verification is therefore `rerun <ref>` followed by a normal keyed review of the new head. Default no-key behaviour, `reset`, and `rerun` are not affected.
- On resume the runner does not take the base from a stored disposition, which would make the pair check compare a pair with itself. The base comes from the per-ref review ledger (`target.base`), the authority the resumed review already uses. A repository ref whose ledger records no base fails closed before any identity work when the run holds a terminal or escape disposition for it, and otherwise proceeds to `round-start`. A stored disposition with no head, or no base for a git ref, cannot match any revision and is skipped, so it never blocks a new pair.

## Rationale

Keying the run ledger by pair keeps the terminal refusal a plain equality check and keeps budget accounting global per key, so many revisions can consume the budget quickly, which is the bound the budget exists to enforce. The cost is weaker same-ref traceability across revisions: the run ledger records the ref on every target and disposition, and an audit view can group by it.

Rejected:

- Reopening the old target on a new revision. It would erase the immutable evidence that the earlier pair was reviewed and would let a terminal pair be reviewed again by changing nothing.
- Keying only by ref and allowing a revision change to reset the terminal state. The terminal refusal would then depend on a comparison of mutable heads and would not survive a base change.
- Making the per-ref target ledger per pair. Verbs after `round-start` receive only the ref, so the head and base would have to be threaded through every verb, and no-key behaviour would change.
- Reporting exhaustion as an error disposition. An error disposition reads as a defect and is replayed as a resumable failure, while an exhausted budget is a decision for a human.

## Residual exposure

- A launch whose revision carries no head cannot be told apart from a recorded pair, so it matches every pair of its ref and stays refused after any terminal disposition, and it counts as an unopened pair while the run is parked. This fails closed.
- While the run is parked, a fix commit in a still-running target changes its head and so also opens a new pair, which is refused. The target stops and the run is reconciled by a human.
- A blocked outcome is not recorded in the run ledger, so a repeated attempt is refused again with the same outcome instead of adding records.
- A budget block in the middle of a round leaves reservations partly consumed and nothing to resume within the same key; recovery starts under a new run key.
- A reviewer spawned outside the review driver is not charged and its output is not accepted as review evidence. The ledger bounds cost, not honesty.
