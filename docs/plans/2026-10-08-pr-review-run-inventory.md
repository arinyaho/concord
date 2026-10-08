# PR Review Run Inventory Implementation Plan

**Goal:** Prevent a duplicate review dispatch when a matching active workflow run is beyond the first 200 results.

**Architecture:** Read every page of the unfiltered `pr-review.yml` workflow-runs REST collection before scanning pull requests. Treat every status other than `completed` as active and fail the poll if the inventory is incomplete.

**Tech Stack:** Bash, GitHub CLI, jq, ShellCheck, fake-gh shell regression.

## Evidence before implementation

On unchanged production script at `24c3afd804527c549aa198536e92afb8851b19e9`, `bash services/pr-review/test/scan.test.sh` exited 1 with only `FAIL active-after-200: want 'no dispatch', got 'broad'`. The fake applies `gh run list --limit 200` before `--jq`, hiding the active 201st run. The observed outcome is a second dispatch of the same PR and SHA, which can cancel the original review through workflow concurrency.

## Task 1: Inventory regression

**Files:** `services/pr-review/test/scan.test.sh`

1. Keep the 201st active-run case red against the unchanged scanner.
2. Add `pending`, `requested`, and `waiting` active-run cases; assert no dispatch for each.
3. Add a paginated API case where page one succeeds and a later page fails; assert the poll fails before any dispatch.
4. Run `bash services/pr-review/test/scan.test.sh`; expect failures only for the new behaviors.

## Task 2: Complete inventory read

**Files:** `services/pr-review/scan.sh`

1. Replace the fixed `gh run list --limit 200` lookup with `gh api --paginate` on the unfiltered workflow-runs collection using `SELF_TOKEN` and `per_page=100`.
2. Extract only run status and display title, retaining `status != completed`.
3. Keep the read before all PR scans and fail on an incomplete lookup.
4. Run the scan regression, then `shellcheck services/pr-review/*.sh services/pr-review/test/*.sh` and `services/pr-review/test/review-one.test.sh`; expect green.

## Task 3: Operator documentation and validation

**Files:** `services/pr-review/README.md`, `docs/design/pr-review-run-inventory.md`

1. State the complete active-run inventory requirement and the 10-minute poll limit in the operator guide.
2. Run the documentation cross-reference and GAP checks for the changed design note.
3. Commit the implementation, regression, and docs together after the checks pass.
