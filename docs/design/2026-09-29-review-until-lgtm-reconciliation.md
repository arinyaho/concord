# review-until-lgtm reconciliation design

## Decision

`review-until-lgtm` stops on a completed, matching-head GitHub Codex review that carries findings, and records a durable `needs-reconciliation` record for that PR head. The state CLI owns persistence, classification, and request blocking. The agent owns GitHub observation.

A new verb, `record-review <pr> <head-sha>`, reads one normalized observation as JSON on stdin:

```json
{"reviewId": "5332811440", "reviewUrl": "https://github.com/o/r/pull/1#pullrequestreview-5332811440",
 "commitId": "<review commit_id>", "state": "completed", "lgtm": false,
 "findings": [{"url": "<thread or review URL>", "priority": "P1", "signals": ["lifecycle"]}]}
```

- `state` is `completed` or `in-progress`. `priority` is `P1`, `P2`, or `null`. `signals` is required on every finding and may be empty; each value belongs to the closed set `lifecycle`, `ledger`, `audit-privacy`, `provider-parity`, `ac-conflict`, `unsupported-test`. A missing field, an unknown signal, or an invalid priority is rejected.
- `commitId` is the review's `commit_id`. Inline comments can report a later `commit_id` than the review that created them, so they are not used for head matching.
- A finding is an unresolved bot thread (its URL) or a summary-level finding (the review URL).

The verb returns one outcome and writes only for the substantive case:

| Observation | Outcome | Record written |
|---|---|---|
| `commitId` differs from the head | `stale` | no |
| `state` is `in-progress` | `in-progress` | no |
| completed, no findings, `lgtm` true | `green` | no |
| completed, no findings, `lgtm` false | `completed-without-findings` | no |
| completed, at least one finding (LGTM or not) | `needs-reconciliation` | yes |

A substantive review is stored as `pr-<n>-<head>.review-<reviewId>.json` with `{pr, headSha, reviewId, reviewUrl, recordedAtMs, findings}`, written with the existing exclusive-create pattern. Recording the same review id again returns `{outcome:"needs-reconciliation", recorded:false, duplicate:true}` and leaves the first record unchanged.

`status` gains `reconciliation`: `null` when no review record exists for the head, otherwise the packet: `pr`, `headSha`, `reviews` (each id, URL, findings), `batchCount`, `p1Count`, `p2Count`, the union of `signals`, `classification`, `retryEligible: false`, `choices: ["resume", "revise", "split", "defer"]`, and `requires: "human decision or new head"`. The packet is computed from the stored records on every read; classification is never stored, so a later batch escalates without rewriting earlier records.

Classification is `requires-architecture-review` when any finding is P1, when two or more distinct review ids are recorded for the head, or when any finding carries a signal. Otherwise it is `light-implementation-eligible`.

While any review record exists for the head, `claim-initial-request`, `recover-initial-request`, `claim-retry`, and `recover-retry-request` return `{"claimed":false,"reason":"needs-reconciliation"}`. `mark-*-requested` and `open-*-window` are not blocked: they record a request that has already been sent, and refusing them would lose that fact. Records are keyed by head, so another head of the same PR is unaffected. There is no verb that clears a record; resuming means observing a new head.

## Why this shape

- The CLI does not call GitHub. Calling GitHub from the CLI would duplicate the agent's authenticated profile handling, require GraphQL for thread resolution and reactions, put the network in tests, and couple the CLI to the bot's markup. A normalized observation keeps every acceptance check a deterministic fixture test.
- The agent tags signals from a closed set. Keyword matching over bot text fails silently on new phrasing, and running both would create two authorities with no rule for disagreement. The cost is that an agent can under-tag; the second-batch rule and the human reading the packet bound that.
- One record per review id, instead of one mutable record per head, makes a resumed session's replay a no-op and makes the second batch a new file rather than a rewrite.
- A claim leased before the record exists may still send its request, because a sent request cannot be recalled. Its review becomes a further batch and escalates. A lock around record and claim would add complexity to prevent an outcome that is already safe.
- A same-head unblock verb would bypass the stop this record exists to create. A human who disagrees with the bot can re-request a review on GitHub; the skill never does.

## Residual exposure

- The block holds only if the agent calls `record-review` before claiming a retry; the skill instructions require it, but the CLI cannot observe GitHub to enforce it.
- Escalation counts batches per head. A PR that receives one signal-free P2 batch on each of several successive heads stays `light-implementation-eligible` per head. Cross-head escalation is tracked in issue #133.
- The classification depends on the Codex bot's P1/P2 badges; a format change degrades priorities to `null` rather than failing.
