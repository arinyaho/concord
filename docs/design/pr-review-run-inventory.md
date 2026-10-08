# PR review run inventory

The review poller obtains a complete workflow-run inventory before choosing any pull request to dispatch. It reads `pr-review.yml` runs from the copy's own repository through the unfiltered Actions workflow-runs REST endpoint, using `per_page=100` and pagination. It extracts the run state and display title locally. Every run whose status is not `completed` is active: a matching repository, pull request number, and head SHA prevents another dispatch of that review. This rule includes `queued`, `in_progress`, `pending`, `requested`, `waiting`, and future noncompleted states.

The workflow-run read uses `SELF_TOKEN`. If any page cannot be read or parsed, or the lookup is rate limited, cancelled, or times out before the last page, the poll fails before dispatching. The poller must not interpret an incomplete inventory as an empty active set. Existing status, comment, and review reads retain their failure behavior.

## Decision and trade-off

An unfiltered paginated endpoint is used because an arbitrary fixed window can omit an older active run after enough newer runs have accumulated. Server-side status filtering risks a bounded search result; local filtering preserves the full inventory. Reading every page costs more API calls and memory as workflow history grows. The scanner therefore reads the inventory once per poll, before scanning repositories, and reduces it to the fields needed for scheduling. The poll workflow's 10-minute job limit bounds the full inventory and dispatch work together. If history cannot be read completely within that limit, the run dispatches nothing and a later poll tries again.

The run's display title is scheduling evidence, not a record that a review was published. A completed run does not by itself prove a review marker or status was written.

## Residual exposure

GitHub's workflow-run retention and deletion policies bound the inventory. A deleted or expired active run cannot be recovered from this endpoint. A run may also start or finish after the inventory snapshot; the existing workflow concurrency group and status/receipt checks still govern those races. API pagination is not a transactional snapshot, so a run moving between pages during the read can be missed; this remains a narrow race even when every page succeeds.
