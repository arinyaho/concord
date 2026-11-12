# Review input and bounded artifacts implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make changed-file coverage complete and bound the consumption of untrusted review artifacts.

**Architecture:** A Git round captures one fixed comparison range, its patch, and a versioned changed-path manifest. Consumers use the saved manifest, independent of patch formatting and later checkout changes. Every read of an artifact that a subagent writes goes through one bounded reader.

**Tech Stack:** Node.js, Git.

## Decisions and invariants

Parsing more patch headers would fix particular examples while leaving coverage dependent on display formatting. Capture paths with `git diff --name-only -z --no-renames` instead. Resolve the effective base and head once, including retry and broad-reuse overrides, and use the same comparison for the patch and manifest. Both sides of renames, deletions, mode-only changes, binary changes and empty additions belong to the coverage set. Invalid filename encoding fails closed.

The manifest belongs to the round and is bound to the captured identities and patch. Artifact normalization, coverage validation and intent filtering consume the same saved data. They do not query a moving HEAD to reconstruct scope. File targets keep their document contract and do not invoke Git. Resume cannot reuse completed artifacts from a legacy round lacking trustworthy scope evidence; trusted round-start regenerates the inputs and invalidates stale completion evidence.

Artifacts that subagents write are untrusted input. Read them only through a shared reader that opens without following symlinks or blocking on devices, accepts only a regular file with a stable identity, and caps the read at 20 MiB. A missing future output keeps its normal meaning and trusted-mode behavior is unchanged.

## Task 1: Capture authoritative round scope

Modify `plugins/concord/core/target.js`, `review-cli.js`, and `codex-review-runner.js`, then synchronize both engine mirrors. Add real-Git regressions in `plugins/concord/hooks/test/review-cli.test.js` and related target/runner test files as needed.

1. Demonstrate that a binary modification, empty addition and executable-bit change can bypass coverage before the fix.
2. Capture a strict NUL-delimited path inventory from the fixed effective range and write `round-<n>-changes.json` with a versioned integrity binding in the execution ledger.
3. Replace patch-derived scope at normalization, fold and broad-reuse call sites. Validate missing, malformed, changed and mismatched manifests fail closed.
4. Include the manifest in protected review inputs. Verify reviewer tampering stops reporting.
5. Verify rename/delete and unusual filename handling, frozen scope after checkout movement, effective retry/reuse ranges, legacy regeneration and Git-free file-target behavior.

## Task 2: Bound untrusted artifact consumption

Modify `core/codex-review-runner.js`, `core/review-cli.js` and a shared `core/bounded-artifact.js`, then synchronize both engine bundles. Apply the reader to review-only integrity hashing, role-output normalization and repair staging/consumption. Use no-follow/nonblocking descriptor opens, regular-file and identity checks, and a 20 MiB read cap. Hash in chunks; copy only validated bounded bytes. Preserve normal trusted-mode behavior and missing future-output semantics. Publish normalized artifacts, ledger updates and telemetry through atomic replacement with exclusive temporary-file creation. Reject occupied review-only target locks before reading owner metadata, and stop failure handling without rereading unsafe state. Bound file-target identity reads across the aggregate selected content and headers.

Verify finite symlink, FIFO, oversized sparse file, missing/ordinary file and substitution cases without running an unbounded device read. Cover permitted role outputs and repair candidates at the actual trusted consumer, not just at a hash preflight. Add a real SHA-256 Git repository regression through round-start, normalization and findings; accept both full object-ID widths. Run only affected regressions and DoD locally, then verify full GitHub CI.
