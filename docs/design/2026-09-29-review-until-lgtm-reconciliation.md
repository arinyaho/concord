# review-until-lgtm reconciliation design

## Decision

`review-until-lgtm` is a provider-neutral GitHub PR feedback loop. It collects every configured automated review for one exact head, records the reviews as one batch, verifies and fixes accepted findings together, and pushes once. Codex, Copilot, and other explicitly configured automated reviewers use the same state contract.

The loop has two PR-wide durable ceilings: three manual review requests and three fix-and-push rounds. Neither resets when the head changes or the agent session is replaced. Exhaustion is a human-reconciliation outcome, never green.

## Review evidence

`record-review <pr> <head-sha>` reads one normalized completed-review observation from stdin:

```json
{
  "reviewId": "5332811440",
  "reviewer": "chatgpt-codex-connector[bot]",
  "reviewUrl": "https://github.com/o/r/pull/1#pullrequestreview-5332811440",
  "commitId": "<full review commit_id>",
  "state": "completed",
  "lgtm": false,
  "findings": [{"url": "<thread or review URL>", "priority": "P1", "signals": ["lifecycle"]}]
}
```

The reviewer is required provenance. Review ids are positive integers or decimal strings. The commit id must equal the exact full PR head. Findings require a URL, a P1/P2/null priority, and a signal array drawn from `lifecycle`, `ledger`, `audit-privacy`, `provider-parity`, `ac-conflict`, and `unsupported-test`. Invalid input fails closed.

Each substantive review is stored once as `pr-<n>-<head>.review-<reviewId>.json`. `status.reconciliation.reviews` returns all stored review ids, reviewers, URLs, and findings in recorded-time order. A finding from any review prevents green even when another reviewer emitted LGTM.

An LGTM must be explicit and fresh for the current head: an automated `APPROVED` review, or the same reviewer's positive reaction at or after its terminal review or summary completion. The Codex clean path remains a provider adapter because it can produce no review object: the exact-head completed summary row and a later bot +1 are required together. No findings alone is not LGTM.

## Collection and batching

The skill waits for every known configured automated reviewer to finish before deciding. When GitHub does not expose a finite set, it requires 120 seconds without new current-head review activity, bounded by the persisted 15-minute collection deadline. It records every completed review even after the first finding; this prevents the first-arriving reviewer from causing a piecemeal fix and push.

If no activity exists, the initial request path first waits through a persisted 120-second automatic-review grace. Manual claims are keyed by provider, and each sent attempt reserves one of the PR's three request slots. Legacy orphan claims plus `initial-request` and `retry-request` sent markers count toward the same budget without double-counting a corresponding slot. Recovery requires an original provider claim, so a missing claim cannot skip the automatic-review grace. Every recovery that may send another provider request consumes another slot, and exhaustion remains visible on resume. Reservation is conservative: a crashed claimant still consumes its slot, because session replacement must not recreate budget.

Legacy recovery-claim markers also consume an attempt when no matching request slot covers them. A legacy `retry-window` remains part of the active collection deadline after upgrade, so process replacement cannot shorten an already-open retry window.

All collected findings go to one clean-context verifier as a batch. A second verifier is used only for conflicting conclusions, security or data-boundary risk, or a proposed contract or architecture change. Accepted findings are deduplicated by shared root cause and planned together.

When the verifier rejects every finding in the exact active batch as false positive, `reject-review-batch` stores the review ids and evidence summary in a durable disposition marker. The original review records remain immutable, no fix round or empty commit is created, and a partial or stale batch is rejected. The disposition only clears reconciliation; green still requires fresh explicit LGTM evidence.

`claim-fix-round <pr> <head-sha>` requires a recorded substantive review for that head and atomically reserves at most one fix round for the head and one of three slots for the PR. It returns an owner that must renew the 15-minute lease every 10 minutes and before commit or push. A replacement may resume only after the latest ownership lease expires. The whole accepted plan is applied, relevant regression checks run once, and one commit and push creates the next head. A new head starts a new collection batch but does not replenish either PR-wide budget. Ordinary reconciliation packets direct automatic verification and fixing; only budget exhaustion or a separately identified scope escalation requires a human. Legacy review records expose `legacy/unknown` provenance instead of silently omitting the reviewer.

## Stop conditions

- Green: collection is complete, no accepted current-head findings remain, and at least one fresh explicit LGTM exists.
- `completed-without-lgtm`: a terminal clean review has no qualifying signal by the deadline. The skill does not request another full review on the same head solely to obtain a reaction.
- Human reconciliation: request or fix budget exhausted, the batch does not converge within three fix rounds, or an accepted finding changes product contract, PR scope, or unrelated architecture.
- Follow-up suggestion: only minor non-release-blocking findings remain. The skill proposes one grouped issue and does not create it without user authorization.

## Residual exposure

- GitHub may still run a full automatic review for every pushed head. Concord reduces that multiplier by batching fixes and bounding pushes; it cannot control provider-side review scope.
- The agent determines which reviewers are configured and whether their activity is terminal. Unknown provider markup fails to timeout or manual reconciliation rather than green.
- Fewer review launches do not prove token or cost savings. Evaluation must compare actual total and cached tokens when available, provider cost, automatic and manual review launches, duplicate finding/path volume, fix pushes, wall time, final unresolved findings, and escaped defects.
