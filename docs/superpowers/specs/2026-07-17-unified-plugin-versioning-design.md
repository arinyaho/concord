# Unified plugin versioning design

## Goal

The Claude Code, Codex, and GitHub Copilot distributions are released as one Concord version. A release must never expose different version numbers across the three plugins or their versioned marketplace metadata.

## Single source of truth

The repository-root `VERSION` file contains the only human-maintained release version. It holds one SemVer-compatible version string and a trailing newline.

The three plugin manifests and the GitHub Copilot marketplace continue to contain required `version` fields, but those fields are derived release artifacts. Contributors do not update them directly.

## Release operation

`node scripts/release-version.mjs <version>` is the sole version-bump interface. It:

1. validates that `<version>` is a SemVer release or prerelease version;
2. writes that value to `VERSION`;
3. updates `plugins/concord/.claude-plugin/plugin.json`;
4. updates `plugins/concord-codex/.codex-plugin/plugin.json`;
5. updates `plugins/concord-copilot/plugin.json`;
6. updates `.github/plugin/marketplace.json` metadata and `concord` entry versions; and
7. preserves unrelated JSON fields.

The script is idempotent: running it with the already-current version produces no file-content changes.

## Guardrail and tests

A Node test reads `VERSION`, all three manifests, and both Copilot marketplace version fields, then asserts the six values are identical. The test uses the actual repository files, so a partial manual update fails the normal test suite.

The test also exercises the release script against an isolated release tree to prove that a single invocation updates every target without modifying unrelated fields and that a preflight failure leaves existing files unchanged.

## Scope

This contract unifies version metadata and its release workflow. All harness marketplaces expose the shared plugin name `concord`, while their source directories and installation mechanisms remain independent.
