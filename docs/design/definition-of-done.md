# Definition of Done

The repository's local definition of done is one command, `node scripts/dod.mjs`, run from the repository root. It runs only what the pull-request workflow does not: the plugin-install e2e tests.

## Decision

The pull-request workflow (`.github/workflows/pull-request.yml`) runs the plugin tests and every other test, so repeating them locally spends minutes on results CI produces anyway. The full suite is CI's gate; the DoD is the local gate for the one thing CI cannot check, because the e2e tests install the plugin through the `claude` and `codex` CLIs, which CI does not have. `ticket-to-pr` runs the full suite once on the final PR head, outside the DoD; `scripts/dod.mjs` still runs only the e2e tests.

The script does two things:

1. It checks that the `claude` and `codex` CLIs run (`<cli> --version`). On Windows the CLIs are invoked through a shell so that `.cmd` shims resolve.
2. It runs `node --test` with `CONCORD_RUN_PLUGIN_INSTALL_E2E=1` on the test file that contains the e2e tests, selecting only tests whose title starts with `plugin-install e2e:`. It uses the TAP reporter, echoes the output, and exits with the test status. Because `node --test` exits 0 when the pattern matches no test and when every match is skipped, the DoD also parses the `# pass N` summary and fails (exit 1) when no e2e test passed. The other tests in that file are CI's and are not run.

If a CLI cannot run (missing, or exits non-zero), the script does not run the tests. It prints one truncated detail line, then the short line `DoD environment error: <cli> CLI is not usable. This is not an implementation failure.`, and exits with 78 (EX_CONFIG). The explanatory line comes last because a caller that shows only the tail of a failing command's output still shows it.

Exit code 78 is the convention for "the DoD could not be prepared", as distinct from a test failure of the change.

The e2e test titles carry the `plugin-install e2e:` prefix so the name pattern selects them. The file list (`E2E_FILES`) and the pattern (`E2E_NAME`) are exported from `scripts/dod.mjs` and are the only copy; `dod-script.test.js` imports them. It scans every `*.test.js` in the hooks test directory and asserts that each `pluginInstallE2ETest` title matches the pattern and sits in the listed file, so a renamed test or a new e2e file cannot go unselected. The zero-pass check above is the runtime backstop.

## Rejected alternatives

- Running the full suite and skipping it when a green result is recorded for the exact head. It needs a local record and an invalidation rule, and a stale or wrongly keyed record passes a head that was never tested.
- Running the full suite in the DoD. Every local run repeats several minutes of tests that CI repeats again.

## Residual exposure

An environment error still fails the DoD. The label tells the reader why, but it does not make the run pass; the fix is to repair the environment and run it again, not to skip it.

A passing DoD does not mean the full suite passed locally; a change that breaks a CI-run test is caught by the pull-request workflow. The workflow triggers only on its path filters, so a change that touches none of them (for example only `scripts/dod.mjs` or `docs/`) has no full-suite run.
