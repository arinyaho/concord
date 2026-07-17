# Unified plugin versioning design

## Goal

Claude's `concord` plugin and Codex's `concord-codex` plugin are released as one Concord version. A release must never expose different version numbers for the two plugins.

## Single source of truth

The repository-root `VERSION` file contains the only human-maintained release version. It holds one SemVer-compatible version string and a trailing newline.

Both plugin manifests continue to contain their required `version` fields, but those fields are derived release artifacts. No contributor updates either manifest version directly.

## Release operation

`node scripts/release-version.mjs <version>` is the sole version-bump interface. It:

1. validates that `<version>` is a SemVer release or prerelease version;
2. writes that value to `VERSION`;
3. updates `plugins/concord/.claude-plugin/plugin.json`;
4. updates `plugins/concord-codex/.codex-plugin/plugin.json`; and
5. preserves all unrelated JSON fields and formatting.

The script is idempotent: running it with the already-current version produces no file-content changes.

## Guardrail and tests

A Node test reads `VERSION` and both manifests, then asserts the three values are identical. The test uses the actual repository files, so direct edits to only one plugin manifest fail the normal test suite.

The test also exercises the release script against a temporary copy of the three version files to prove that a single invocation updates each target without modifying unrelated manifest fields.

## Initial migration

The initial unified version is `0.9.0-alpha.2`, matching the current Claude plugin release. The migration updates Codex from `0.1.0-alpha.1` to that version through the release script, then verifies the parity test and the existing plugin tests.

## Scope

This change only unifies version metadata and its release workflow. It does not assert feature parity between Claude and Codex, alter marketplace names, or make either plugin's installation/update process cross-install the other plugin.
