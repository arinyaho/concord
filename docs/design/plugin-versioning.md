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

## Post-merge bump

Every change that lands on `main` ships under its own beta version, raised by one automated commit on `main`; pull requests carry no bump. The plugin manager reports an installed plugin as current until `VERSION` changes, so each merge needs a new version, and raising it after the merge spares open pull requests a rebase and a re-review each time another one merges first.

The `release-bump` workflow runs on every push to `main` and calls `node scripts/release-bump.mjs push main`. The script fetches `main` and counts the first-parent commits after the newest bump commit (authored by `github-actions[bot]`). For each of them it computes the next beta from `VERSION` (for example `0.9.0-beta.9` to `0.9.0-beta.10`), runs `node scripts/release-version.mjs <next>`, stages only the files that script writes, and verifies that the commit touches nothing else. It then pushes the resulting `chore(release): bump Concord to <next>` commits in one push. When the push loses a race, the script fetches again and recounts, up to four attempts. Because every run counts from `origin/main` and not from its own checkout, a canceled, replaced, or rerun run creates no extra bump and leaves no merge without one, and the workflow needs no concurrency group. The count assumes a merge method that adds one first-parent commit per pull request (squash or merge commit); a rebase merge adds one commit per rebased commit and therefore one bump for each. Commits by `github-actions[bot]` that are not release bumps are neither counted nor a boundary.

A push made with the repository token starts no workflow run. As a second guard, the script exits without a commit when the checked-out commit is authored by `github-actions[bot]`.

The `version-guard` workflow runs on `pull_request_target`, so the workflow file and `scripts/release-bump.mjs` come from the base branch. It fetches the pull request head as `refs/pr/head`, never checks it out, runs `node scripts/release-bump.mjs guard origin/<base> refs/pr/head`, and fails when the pull request changes `VERSION` or any file the release script writes. A pull request therefore cannot change the guard that checks it. The repository's Actions event policy must allow `pull_request_target`, because GitHub's default policy for public repositories blocks that event.

The rule costs one bot commit per merge, and `main` receives a push after each merge. The workflow needs only `contents: write` on the repository token and no stored credential.

## Guardrail and tests

A Node test reads `VERSION`, all three manifests, and both Copilot marketplace version fields, then asserts the six values are identical. The test uses the actual repository files, so a partial manual update fails the normal test suite.

The test also runs the release script against an isolated release tree to prove that a single invocation updates every target without modifying unrelated fields and that a preflight failure leaves existing files unchanged.

## Scope

This contract unifies version metadata and its release workflow. All harness marketplaces expose the shared plugin name `concord`, while their source directories and installation mechanisms remain independent.
