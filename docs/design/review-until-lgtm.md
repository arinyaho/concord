# review-until-lgtm

## Decision

`review-until-lgtm` is a provider-neutral GitHub PR feedback loop. It collects every configured automated review for one exact head, records the reviews as one batch, verifies and fixes accepted findings together, and pushes once. Codex, Copilot, and other explicitly configured automated reviewers use the same state contract.

The loop has two PR-wide durable ceilings: three manual review requests and three fix-and-push rounds, the latter raised only by a recorded waiver. Neither resets when the head changes or the agent session is replaced. Exhaustion is a human-reconciliation outcome, never green.

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

If no activity exists, the initial request path first waits through a persisted 120-second automatic-review grace. Manual claims are keyed by provider, and each sent attempt reserves one of the PR's three request slots. Status aggregates every claim, recovery, and sent marker for the PR, including markers in older formats, so a replacement session can resume the bounded window, and each counts toward the same budget without double-counting a corresponding slot. Recovery requires an original provider claim, so a missing claim cannot skip the automatic-review grace. Every recovery that may send another provider request consumes another slot, and exhaustion remains visible on resume. Reservation transitions are serialized by a PR-scoped non-reclaiming lock. A concurrent caller retries `transition-busy`; an abandoned lock fails closed for human reconciliation. Reservation remains conservative: a crashed claimant still consumes its slot, because session replacement must not recreate budget.

A recovery-claim marker in an older format also consumes an attempt when no matching request slot covers it, and an older `retry-window` marker remains part of the active collection deadline, so process replacement cannot shorten an already-open retry window.

All configured reviewers finish collection before reconciliation begins. A finding from an early reviewer blocks fixing but does not block bounded claims needed to collect a missing reviewer. All collected findings then go to one clean-context verifier as a batch. A second verifier is used only for conflicting conclusions, security or data-boundary risk, or a proposed contract or architecture change. Accepted findings are deduplicated by shared root cause and planned together.

When the verifier rejects every finding in the exact active batch as false positive, `reject-review-batch` stores the review ids and evidence summary in a durable disposition marker. The original review records remain immutable, no fix round or empty commit is created, and a partial or stale batch is rejected. The disposition only clears reconciliation; green still requires fresh explicit LGTM evidence.

After the verifier and before planning, a new Fable-class agent, at least as capable as the reviewer that raised the findings, adjudicates every accepted finding of a head in one call when any one of four signals holds: an earlier fix exists on the PR and a finding about the content or wording of a rule, contract, schema or interface appears again; a finding cites text or lines added by the previous fix commit; a finding asks to add, restore or enumerate a definition, qualifier or list; or four or more accepted findings land on one head. It returns `CONCEDE` with a patch of a few words or `REBUT` with a reason, and a rebutted finding counts as verifier-rejected. A PR whose findings self-feed, recur on one section across two heads, or survive a second fix round gets a design escalation that returns `KEEP` or `REWRITE`; a second escalation runs only when a signal holds again after the first `REWRITE` was applied, and after that the PR stops for human reconciliation. The local `review-and-fix` loop has no such step because its own round budget bounds it.

`claim-fix-round <pr> <head-sha>` requires a recorded substantive review for that head and atomically reserves at most one fix round for the head and one of the PR's slots (three, plus any rounds a recorded waiver adds). The returned owner is immutable. It may confirm ownership through the `renew-fix-round` verb, but ownership never transfers after a timeout. An abandoned claim or owner fails closed for human reconciliation after confirming the former executor has stopped. The whole accepted plan is applied, relevant regression checks run once, and one commit and push creates the next head. A new head starts a new collection batch but does not replenish either PR-wide budget except through a recorded waiver. Ordinary reconciliation packets direct automatic verification and fixing; only budget exhaustion, abandoned ownership, or a separately identified scope escalation requires a human. A review record without a stored reviewer reports `legacy/unknown` provenance instead of silently omitting the reviewer.

`waive-fix-budget <pr> <person> <n>` records a human's decision to allow `n` further fix rounds on a PR. It requires a non-empty person and a positive integer, is idempotent for the same person and count (a further waiver needs a different count), and raises the cap without reducing the spent count. `status` lists each waiver as `waivers` with its person, count and time, so waived rounds stay visible. A waiver also makes a recorded delivery stale for fix claims, so the waived rounds can be claimed; review-request claims are not reopened. `self-feeding <pr> <head-sha> <file> <start> [<end>]` reports whether `git blame` attributes any line in the range at `<head-sha>` to a commit on the first-parent history after the head of the latest earlier fix round, so lines that arrived by merging the base branch do not count, and a fix head that is not on that history is not used; configured blame ignore lists and textconv filters are ignored, and lines the fix copied or moved from elsewhere keep their original attribution; it reads only the path and line numbers, matches the path literally, and rejects an absolute path or a path leaving the repository. A range past the end of the file is clamped when it only ends there and is an error when it starts there; a file missing at `<head-sha>` is an error.

## Stop conditions

- Green: collection is complete, no accepted current-head findings remain, and at least one fresh explicit LGTM exists.
- `completed-without-lgtm`: a terminal clean review has no qualifying signal by the deadline. The skill does not request another full review on the same head solely to obtain a reaction.
- Human reconciliation: the request budget is exhausted, or an accepted finding changes product contract, PR scope, or unrelated architecture.
- Delivery disposition: when collection is terminal and no fix round is open, including after the fix budget is exhausted, the skill records the delivery disposition (see the delivery disposition design). Release-blocking residuals keep the PR `blocked` for human reconciliation; follow-up-eligible residuals are grouped by root cause into read-back tickets within the tracker authorization.

## Rationale

The review state lives on GitHub, so the skill reads it there with the GitHub CLI; the local state engine (`core/lgtm-state.js`, exposed as `review-lgtm-state`) holds only what GitHub cannot: request and fix budgets, claims, recorded review batches, and delivery records. Collecting every configured reviewer before fixing prevents the first-arriving reviewer from driving a piecemeal fix and push, and a PR-wide budget that survives head changes and session replacement prevents a loop from recreating budget by pushing or restarting.

Treating a completed review without an LGTM signal as `completed-without-lgtm`, a named non-green outcome, preserves the signal without requesting another full review just to obtain a reaction.

## Residual exposure

- An automated reviewer may complete without emitting its LGTM signal. The named outcome preserves that fact but cannot force the reviewer to emit it.

- GitHub may still run a full automatic review for every pushed head. Concord reduces that multiplier by batching fixes and bounding pushes; it cannot control provider-side review scope.
- The agent determines which reviewers are configured and whether their activity is terminal. Unknown provider markup fails to timeout or manual reconciliation rather than green.
- Fewer review launches do not prove token or cost savings. Evaluation must compare actual total and cached tokens when available, provider cost, automatic and manual review launches, duplicate finding/path volume, fix pushes, wall time, final unresolved findings, and escaped defects.
