# DoD scope and environment errors

The repository's definition of done is the `dod` command list in `review.config.json`. It runs from the repository root and gates a review round: a round is clean only when the DoD actually ran and passed.

## Decision

The DoD is a single command, `node scripts/dod.mjs`. It runs only what the pull-request workflow does not: the plugin-install e2e tests. The pull-request workflow (`.github/workflows/pull-request.yml`) already runs every other test, the plugin tests and the `services/agent-team` tests, so repeating them locally spends minutes on results CI produces anyway. The full suite is CI's gate; the DoD is the local gate for the one thing CI cannot check.

The script does two things:

1. It checks that the `claude`, `codex` and `copilot` CLIs run (`<cli> --version`). The e2e tests install the plugin through each of them. On Windows the CLIs are invoked through a shell so that `.cmd` shims resolve.
2. It runs `node --test` with `CONCORD_RUN_PLUGIN_INSTALL_E2E=1` on the two test files that contain the e2e tests, selecting only tests whose title starts with `plugin-install e2e:`, and exits with that status. The other tests in those files are CI's and are not run.

If a CLI cannot run (missing, or exits non-zero), the script does not run the tests. It prints one truncated detail line, then the short line `DoD environment error: <cli> CLI is not usable. This is not an implementation failure.`, and exits with 78 (EX_CONFIG). The explanatory line comes last because the review handoff shows only the tail of the failing command's output.

Exit code 78 is the convention for "the DoD could not be prepared". Any DoD command may use it. The review handoff labels a failing command with exit 78 as a DoD environment/setup error rather than a test failure of the reviewed change. The label is text only: termination, budgets and the ledger treat the result like any other DoD failure.

The e2e test titles carry the `plugin-install e2e:` prefix so the name pattern selects them. `dod-script.test.js` asserts that every e2e test in those files has the prefix, so a renamed test cannot make the DoD silently run zero tests.

## Rejected alternatives

- Running the full suite and skipping it when a green result is recorded for the exact head. It needs a local record and an invalidation rule, and a stale or wrongly keyed record passes a head that was never tested.
- Running the full suite as before. Each review round repeats several minutes of tests that CI repeats again.

## Residual exposure

An environment error still fails the gate. The label tells the reader why, but it does not make the round pass: a round whose reviewers found nothing, with the DoD failing for an environment reason, does not converge and the run parks with no progress. The fix is to repair the environment and resume, not to skip the gate.

A clean review no longer means the full suite passed locally; a change that breaks a CI-run test is caught by the pull-request workflow. The workflow triggers only on its path filters, so a change that touches none of them (for example only `scripts/dod.mjs` or `docs/`) has no full-suite run.
