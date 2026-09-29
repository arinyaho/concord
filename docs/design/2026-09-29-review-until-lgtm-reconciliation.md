# review-until-lgtm reconciliation design

## Decision

`review-until-lgtm` stops on a completed, matching-head GitHub Codex review that carries findings, and records a durable `needs-reconciliation` record for that PR head. The state CLI owns persistence, classification, and request blocking. The agent owns GitHub observation.

A new verb, `record-review <pr> <head-sha>`, reads one normalized observation as JSON on stdin:

```json
{"reviewId": "5332811440", "reviewUrl": "https://github.com/o/r/pull/1#pullrequestreview-5332811440",
 "commitId": "<review commit_id>", "state": "completed", "lgtm": false,
 "findings": [{"url": "<thread or review URL>", "priority": "P1", "signals": ["lifecycle"]}]}
```

- `reviewId` is the GitHub review's id; it may be a number or a digit string and is normalized to a decimal string, because it becomes part of a file name.
- `state` is `completed` or `in-progress`. `priority` is `P1`, `P2`, or `null`. `signals` is required on every finding and may be empty; each value belongs to the closed set `lifecycle`, `ledger`, `audit-privacy`, `provider-parity`, `ac-conflict`, `unsupported-test`. A missing field, an unknown signal, or an invalid priority is rejected.
- `commitId` is the review's `commit_id`. Every state verb, not only `record-review`, requires the head as a full 40- or 64-character SHA (the PR's `headRefOid`), and `record-review` requires the same of `commitId` and compares the two case-insensitively for equality. Markers are keyed by the head string, so accepting abbreviated heads would let one session's claims, windows, and records land under a different key from another's; an abbreviated head is rejected instead of silently bypassing the block or turning every observation into `stale`. Inline comments can report a later `commit_id` than the review that created them, so they are not used for head matching.
- A finding is an unresolved bot thread (its URL) or a summary-level finding (the review URL).

The verb returns one outcome and writes only for the substantive case. Rows are checked top to bottom and the first match wins, so a stale or in-progress observation never writes a record whatever its findings:

| Observation | Outcome | Record written |
|---|---|---|
| `commitId` differs from the head | `stale` | no |
| `state` is `in-progress` | `in-progress` | no |
| completed, at least one finding (LGTM or not) | `needs-reconciliation` | yes |
| completed, no findings, a review record already exists for the head | `needs-reconciliation` | no |
| completed, no findings, `lgtm` true | `green` | no |
| completed, no findings, `lgtm` false | `completed-without-lgtm` | no |

This narrows the skill's existing outcomes: `green` and `completed-without-lgtm` now also require that the review has no summary-level finding and that no review record exists for the head.

A substantive review is stored as `pr-<n>-<head>.review-<reviewId>.json` with `{pr, headSha, reviewId, reviewUrl, recordedAtMs, findings}`, written with the existing exclusive-create pattern. Recording the same review id again returns `{outcome:"needs-reconciliation", recorded:false, duplicate:true}` and leaves the first record unchanged.

`status` gains `reconciliation`: `null` when no review record exists for the head, otherwise the packet: `pr`, `headSha`, `reviews` (each id, URL, findings), `batchCount`, `p1Count`, `p2Count`, the union of `signals`, `classification`, `retryEligible: false`, `choices: ["resume", "revise", "split", "defer"]`, and `requires: "human decision or new head"`. The packet is computed from the stored records on every read; classification is never stored, so a later batch escalates without rewriting earlier records.

Classification is `requires-architecture-review` when any finding is P1, when two or more distinct review ids are recorded for the head, or when any finding carries a signal. Otherwise it is `light-implementation-eligible`.

While any review record exists for the head, `claim-initial-request`, `recover-initial-request`, `claim-retry`, and `recover-retry-request` return `{"claimed":false,"reason":"needs-reconciliation"}`. `mark-initial-requested`, `mark-retry-requested`, `open-window`, and `open-retry-window` are not blocked: they record a request that has already been sent, and refusing them would lose that fact. Records are keyed by the full head, so another head of the same PR is unaffected. There is no verb that clears a record, and a later observation on the same head does not clear it either: a later review without findings returns `{outcome:"needs-reconciliation", recorded:false, duplicate:false}` without writing, `status` still carries the packet, and the claim verbs stay blocked. Resuming means observing a new head; a human who disagrees with the findings pushes a new commit, and the skill's stop report says so.

## Green with no review object

A clean Codex outcome creates no pull-request review object: the bot marks the head's row in its summary issue comment `✅ Completed` and, a few seconds later, adds a +1 reaction to the PR itself. Nothing exists for `record-review` to read, so this rule lives in the skill's GitHub observation instructions, not in the CLI: the CLI validates and persists a review observation, and there is no review observation for this case.

Green requires four conditions at one poll: no Codex review has `commit_id` equal to the full head SHA (so a review object has not appeared since the summary comment updated); `status`'s `reconciliation` is null (no reconciliation record for the head); every row of the summary comment is `✅ Completed` with a Commit value that is a prefix of the full head SHA; and a +1 reaction on the PR from the Codex bot login has `created_at` at or after that row's completion time.

GitHub keeps at most one +1 reaction per user per reactable subject: the bot's +1 is a single reaction object on the PR, not one per review, so a PR carries at most one bot +1 at a time and it may date from an earlier head that it never re-creates for a later clean head. The reaction-time check exists to detect that: without ordering the reaction against the row it replaces, a stale +1 from an earlier head would report a later head green. Comparing `created_at` to the row's completion time, both truncated to whole seconds so a +1 in the same second as completion counts, ties the reaction to the head it actually closed out. The review-object path applies the same comparison to the same field: `lgtm` is true only when the bot's +1 `created_at` is at or after the matching review's `submitted_at`, both truncated to whole seconds.

Residual exposure: if the bot does not re-create its +1 on a later clean head, the check finds no qualifying reaction and the rule fails closed to `completed-without-lgtm` rather than reporting a false green. GitHub does not document the reaction's lifecycle for this bot, so a future change to when or whether it fires would silently change how often that residual triggers; the scraped summary-comment markup (the HTML comment marker, the row shape, the relative-time attribute) fails closed the same way if the bot changes its rendering; and this path leaves no CLI-recorded state, so a resumed session re-derives it from GitHub on every poll rather than from a durable marker.

## Why this shape

- The CLI does not call GitHub. Calling GitHub from the CLI would duplicate the agent's authenticated profile handling, require GraphQL for thread resolution and reactions, put the network in tests, and couple the CLI to the bot's markup. A normalized observation keeps every acceptance check a deterministic fixture test.
- The agent tags signals from a closed set. Keyword matching over bot text fails silently on new phrasing, and running both would create two authorities with no rule for disagreement. The cost is that an agent can under-tag. For a single batch, only the human reading the packet catches that; the second-batch rule catches it only when another substantive review lands on the same head.
- One record per review id, instead of one mutable record per head, makes a resumed session's replay a no-op and makes the second batch a new file rather than a rewrite.
- A claim leased before the record exists may still send its request, because a sent request cannot be recalled. If its review has findings, it becomes a further batch and escalates; if not, it writes nothing, and the existing record still blocks further requests on that head. A lock around record and claim would add complexity to prevent an outcome that is already safe.
- A same-head unblock verb would bypass the stop this record exists to create. A human who disagrees with the bot ends the loop or pushes a new head; a review re-requested on the same head cannot clear the record, and the skill never sends a new request after it reads the record.

## Residual exposure

- The CLI trusts the findings the agent reports. If the agent misreads a thread as resolved or misses a summary-level finding, `record-review` returns `green` or `completed-without-lgtm` and nothing stops the loop; the skill instructions define the extraction rules, but the CLI cannot check them against GitHub.
- The block holds only if the agent calls `record-review` before claiming a retry; the skill instructions require it, but the CLI cannot observe GitHub to enforce it.
- Escalation counts batches per head. A PR that receives one signal-free P2 batch on each of several successive heads stays `light-implementation-eligible` per head. Cross-head escalation is outside this design.
- The classification depends on the Codex bot's P1/P2 badges. If the badge format changes, the agent records a real P1 as `null`; with no signals, that batch is classified `light-implementation-eligible` without any warning.
