# DoD environment errors

The repository's definition of done is the `dod` command list in `review.config.json`. It runs from the repository root and gates a review round: a round is clean only when the DoD actually ran and passed.

## Decision

The DoD is a single command, `node scripts/dod.mjs`, not a bare test command. The script does two things:

1. It ensures the dependencies of `services/agent-team`, a separate package with its own lockfile, are installed. It runs `npm ci --no-audit --no-fund` there when `node_modules/.package-lock.json` is missing or older than `package-lock.json`, and skips the install otherwise. npm writes that hidden lockfile only after a successful install, so a failed or interrupted install is retried on the next run instead of being mistaken for an up-to-date one. On Windows npm is invoked through a shell so that `npm.cmd` resolves.
2. It runs `node --test` from the repository root with `CONCORD_RUN_PLUGIN_INSTALL_E2E=1` and exits with that status.

If the install itself fails (offline, registry error, npm missing), the script does not run the tests. It prints the tail of the npm output, one truncated detail line, then the short line `DoD environment error: <what failed>. This is not an implementation failure.`, and exits with 78 (EX_CONFIG). The explanatory line comes last because the review handoff shows only the tail of the failing command's output.

Exit code 78 is the convention for "the DoD could not be prepared". Any DoD command may use it. The review handoff labels a failing command with exit 78 as a DoD environment/setup error rather than a test failure of the reviewed change. The label is text only: termination, budgets and the ledger treat the result like any other DoD failure.

## Rejected alternative

Scoping the DoD to the plugin tests only, so the suite never touches `services/agent-team`, removes the missing-dependency failures but silently stops gating that package. A change that breaks it would then pass the DoD. Preparing the environment keeps the whole repository under the gate.

## Residual exposure

An environment error still fails the gate. The label tells the reader why, but it does not make the round pass: a round whose reviewers found nothing, with the DoD failing for an environment reason, does not converge and the run parks with no progress. The fix is to repair the environment and resume, not to skip the gate.

Concurrent DoD runs in one checkout are not serialized. Two runs that both find the dependencies stale can run `npm ci` in `services/agent-team` at the same time and corrupt each other's install. No lock is taken; run one DoD per checkout at a time.
