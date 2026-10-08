# PR review run inventory

The review poller traverses every returned page of the workflow-run inventory before choosing any pull request to dispatch. It reads `pr-review.yml` runs from the copy's own repository through the unfiltered Actions workflow-runs REST endpoint, using `per_page=100` and pagination. It extracts the run state and display title locally. Every run whose status is not `completed` is active: a matching repository, pull request number, and head SHA prevents another dispatch of that review. This rule includes `queued`, `in_progress`, `pending`, `requested`, `waiting`, and future noncompleted states.

The workflow-run read uses `SELF_TOKEN`. If any page cannot be read or parsed, or the lookup is rate limited, cancelled, or times out before the last page, the poll fails before dispatching. The poller must not interpret an incomplete inventory as an empty active set. Existing status, comment, and review reads retain their failure behavior.

## Decision and trade-off

An unfiltered paginated endpoint is used because an arbitrary fixed window can omit an older active run after enough newer runs have accumulated. Server-side status filtering risks a bounded search result; local filtering preserves the full inventory. Reading every page costs more API calls and memory as workflow history grows. The scanner therefore reads the inventory once per poll, before scanning repositories, and reduces it to the fields needed for scheduling. The poll workflow's 10-minute job limit bounds the full inventory and dispatch work together. If history cannot be read completely within that limit, the run dispatches nothing. Full traversal favors duplicate-review safety over a guaranteed dispatch cadence; it is not an atomic snapshot.

The run's display title is scheduling evidence, not a record that a review was published. A completed run does not by itself prove a review marker or status was written.

## Residual exposure

GitHub's workflow-run retention and deletion policies bound the inventory. A deleted or expired active run cannot be recovered from this endpoint. A run accepted after its page or the full inventory was read may be absent. A later dispatch for the same pull request and SHA can duplicate work and cancel the earlier review through workflow concurrency; status and receipt checks do not eliminate this interval. API pagination is not a transactional snapshot, so a run moving between pages during the read can also be missed. Complete pagination removes the fixed-window omission but does not provide an atomic inventory and dispatch operation.

Every poll spends Actions API quota in proportion to retained workflow history. Large history can exhaust the [shared `GITHUB_TOKEN` REST API budget](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github_token-in-github-actions) or the poll job's 10-minute limit before the inventory completes. The affected poll dispatches nothing; repeated polls can remain unable to dispatch until quota or history changes.
