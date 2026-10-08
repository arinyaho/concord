# Review input and publication implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make changed-file coverage complete and recover review status updates without repeating a posted review.

**Architecture:** A Git round captures one fixed comparison range, its patch, and a versioned changed-path manifest. Consumers use the saved manifest, independent of patch formatting and later checkout changes. A publication receipt identifies the review attempt separately from its commit status; the scanner reconciles status for that attempt without invoking a reviewer again.

**Tech Stack:** Node.js, Git, Bash, jq, GitHub REST API and Actions.

## Decisions and invariants

Parsing more patch headers would fix particular examples while leaving coverage dependent on display formatting. Capture paths with `git diff --name-only -z --no-renames` instead. Resolve the effective base and head once, including retry and broad-reuse overrides, and use the same comparison for the patch and manifest. Both sides of renames, deletions, mode-only changes, binary changes and empty additions belong to the coverage set. Invalid filename encoding fails closed.

The manifest belongs to the round and is bound to the captured identities and patch. Artifact normalization, coverage validation and intent filtering consume the same saved data. They do not query a moving HEAD to reconstruct scope. File targets keep their document contract and do not invoke Git. Resume cannot reuse completed artifacts from a legacy round lacking trustworthy scope evidence; trusted round-start regenerates the inputs and invalidates stale completion evidence.

Review posting and commit-status updates are independent remote operations. A successful POST is durable publication evidence, even if status settlement fails. A unique attempt identifier travels through dispatch, queued and worker statuses, and a script-generated receipt in the posted review. Only receipts from the configured review account for the same commit and attempt authorize settlement. An older completed review cannot settle a newer requested attempt. Legacy records use conservative timestamp matching. If no attempt-tagged status was ever recorded, a posted receipt alone cannot disambiguate a later unrecorded attempt; settlement remains unknown rather than guessing success.

The scanner reads every status page and selects the latest matching context. Publication reconciliation precedes dispatch filtering, including manual-only mode and the activity cutoff. An API read failure is unknown state and cannot authorize a model retry. A matching receipt repairs status only; it does not post another review. Existing PR-list and active-run backlog limits remain separate follow-ups.

## Task 1: Capture authoritative round scope

Modify `plugins/concord/core/target.js`, `review-cli.js`, and `codex-review-runner.js`, then synchronize both engine mirrors. Add real-Git regressions in `plugins/concord/hooks/test/review-cli.test.js` and related target/runner test files as needed.

1. Demonstrate that a binary modification, empty addition and executable-bit change can bypass coverage before the fix.
2. Capture a strict NUL-delimited path inventory from the fixed effective range and write `round-<n>-changes.json` with a versioned integrity binding in the execution ledger.
3. Replace patch-derived scope at normalization, fold and broad-reuse call sites. Validate missing, malformed, changed and mismatched manifests fail closed.
4. Include the manifest in protected review inputs. Verify reviewer tampering stops reporting.
5. Verify rename/delete and unusual filename handling, frozen scope after checkout movement, effective retry/reuse ranges, legacy regeneration and Git-free file-target behavior.

## Task 2: Separate publication and settlement

Modify `.github/workflows/pr-review.yml`, `services/pr-review/review-one.sh`, `scan.sh`, and their shell tests.

1. Reproduce successful review publication followed by exhausted final-status retries; reproduce an error context beyond the first status page.
2. Propagate a unique attempt identifier through dispatch and status descriptions. Add a trusted publication receipt without changing the existing first-line review marker.
3. Keep cleanup aware of publication and status settlement separately. A failed settlement remains visible; publication is not repeated.
4. Paginate statuses and reconcile a matching posted attempt before deciding whether to dispatch. Preserve newer attempts and skip safely when evidence cannot be read.
5. Verify settlement recovery after an outage, old receipt versus newer requested attempt, timestamp ties, foreign or malformed receipts, manual-only recovery and stale-PR recovery.

## Task 3: Review and delivery

Run focused changed-input and service regressions plus `node scripts/dod.mjs` locally. Inspect red/green evidence and mirrored-file consistency. Have Sol high review the final diff and Astra inspect the invariant boundaries. Commit and push to PR #195, let GitHub run the full suites and lint, then update the PR description and answer the three review threads with verified evidence. No merge is authorized.

## Task 4: Bound untrusted artifact consumption

Modify `core/codex-review-runner.js`, `core/review-cli.js` and a shared `core/bounded-artifact.js`, then synchronize both engine bundles. Apply the reader to review-only integrity hashing, role-output normalization and repair staging/consumption. Use no-follow/nonblocking descriptor opens, regular-file and identity checks, and a 20 MiB read cap. Hash in chunks; copy only validated bounded bytes. Preserve normal trusted-mode behavior and missing future-output semantics. Publish normalized artifacts, ledger updates and telemetry through atomic replacement with exclusive temporary-file creation. Reject occupied review-only target locks before reading owner metadata, and stop failure handling without rereading unsafe state. Bound file-target identity reads across the aggregate selected content and headers.

Verify finite symlink, FIFO, oversized sparse file, missing/ordinary file and substitution cases without running an unbounded device read. Cover permitted role outputs and repair candidates at the actual trusted consumer, not just at a hash preflight. Add a real SHA-256 Git repository regression through round-start, normalization and findings; accept both full object-ID widths. Run only affected regressions and DoD locally, then verify full GitHub CI.
