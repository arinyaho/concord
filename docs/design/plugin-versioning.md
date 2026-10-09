# Plugin versioning

The Claude Code, Codex, and GitHub Copilot distributions are released as one Concord version. A release never exposes different version numbers across the three plugins or their versioned marketplace metadata.

## Single source of truth

The repository-root `VERSION` file contains the only human-maintained release version. It holds one SemVer-compatible version string and a trailing newline.

The three plugin manifests and the GitHub Copilot marketplace still contain required `version` fields, but those fields are derived release artifacts. Contributors do not update them directly.

## Release operation

`node scripts/release-version.mjs <version>` is the only version-bump interface. It:

1. validates that `<version>` is a SemVer release or prerelease version;
2. writes that value to `VERSION`;
3. updates `plugins/concord/.claude-plugin/plugin.json`;
4. updates `plugins/concord-codex/.codex-plugin/plugin.json`;
5. updates `plugins/concord-copilot/plugin.json`;
6. updates `.github/plugin/marketplace.json` metadata and `concord` entry versions; and
7. preserves unrelated JSON fields.

The script is idempotent: running it with the already-current version produces no file-content changes.

## Per-PR bump

Every PR, including a docs-only or test-only PR, ends with the commit `chore(release): bump Concord to <next>`, produced only by `node scripts/release-version.mjs <next>`. `<next>` is `main`'s `VERSION` at merge time plus one prerelease increment, for example `0.9.0-beta.8` to `0.9.0-beta.9`. When `main`'s `VERSION` changes after the branch was cut, the author rebases and runs the script again. A PR that is itself a release bump needs no second bump. Each merged change therefore ships under its own version, and an installed plugin's version identifies the change it contains.

`plugins/concord/hooks/test/version-bump.test.js` enforces the rule. The pull-request workflow supplies the base branch's `VERSION` in `CONCORD_BASE_VERSION`; the test fails when the PR's `VERSION` equals it and passes when the PR's `VERSION` is higher, which includes a release-bump PR. Without `CONCORD_BASE_VERSION`, as in a local run, the test is skipped.

The rule costs one extra commit per PR. When parallel PRs conflict on `VERSION` and the manifests, the later one costs a rebase and one more script run.

## Guardrail and tests

A Node test reads `VERSION`, all three manifests, and both Copilot marketplace version fields, then asserts the six values are identical. The test uses the actual repository files, so a partial manual update fails the normal test suite.

The test also runs the release script against an isolated release tree to prove that a single invocation updates every target without modifying unrelated fields and that a preflight failure leaves existing files unchanged.

## Scope

This contract unifies version metadata and its release workflow. All harness marketplaces expose the shared plugin name `concord`, while their source directories and installation mechanisms remain independent.
