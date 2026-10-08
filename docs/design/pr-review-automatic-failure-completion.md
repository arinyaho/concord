# Automatic PR review failure completion

After active same-head suppression, trusted publication reconciliation, and unconsumed explicit-command selection, automatic scheduling is blocked by any retained matching run whose `status == "completed"` and `conclusion != "success"`. The identity is `(repository, pull request, target SHA)` from an exact whole run title. Both legacy `review <repo>#<pr> @ <40-character-sha>` and extended `review <repo>#<pr> @ <40-character-sha> cmd:<decimal-id-or->` titles count. Requested and automatic attempts both contribute to this barrier. The title grammar and active-state rule are defined in [requested command completion](pr-review-command-completion.md).

`failure`, `cancelled`, `timed_out`, `action_required`, `neutral`, `skipped`, `stale`, null or missing conclusions, and unknown conclusions all satisfy the predicate. They mean success is unconfirmed, not necessarily that the reviewer model failed. A noncompleted run remains active regardless of its conclusion. A completed successful run alone creates no failure barrier.

An explicit command takes precedence over the automatic barrier, subject to active same-head suppression. A later successful explicit attempt does not erase an earlier retained non-success barrier for the same head. A new head has a different key and remains eligible under the other scheduling rules. `review-one.sh` creates reviews with `event: "COMMENT"`, submitting them immediately when creation succeeds. For scheduling, the scanner collects first-line marker candidates from trusted-account issue comments and review objects without checking review state or submission time; this collection also does not validate review `commit_id`. These markers are scheduling evidence, not independent proof of submission.

For a status description beginning with a valid `attempt:<UUID>` prefix, settlement requires a trusted-account review with matching target-SHA `commit_id`, a valid first-line marker for that SHA, and an exact second-line receipt for the attempt. This path checks neither review state nor `submitted_at`; a returned pending review satisfying those predicates can qualify. For a status description that does not start with `attempt:`, legacy settlement requires a known status timestamp and a trusted same-SHA marked review whose `submitted_at` is strictly later, whether or not it carries a receipt. Equal timestamps do not qualify. A malformed `attempt:` prefix permits neither path. A terminal workflow run proves neither publication nor successful status settlement.

## Decision and trade-off

Actions terminal conclusions survive a failed worker status write and avoid an immediate automatic duplicate. The scanner uses the paginated inventory described in [run inventory](pr-review-run-inventory.md). Failed or unparseable traversal aborts dispatch. Successful pagination is not an atomic snapshot and can race with new or shifting runs.

## Residual exposure

Expired or deleted run records remove this barrier. If no status or trusted marker remains, the same head can be retried. Reading all retained pages consumes API quota and can defer dispatch when the inventory cannot be completed.
