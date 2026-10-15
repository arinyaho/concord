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

The `release-bump` workflow runs on every push to `main` and calls `node scripts/release-bump.mjs push main`. The script fetches `main` and counts the first-parent commits after the newest boundary: a bump commit (authored by `github-actions[bot]`) or a stable release commit (see "Stable release"). For each of them it computes the next version from `VERSION` (`0.9.0-beta.9` to `0.9.0-beta.10`; a stable `0.9.0` to the next minor's first beta, `0.10.0-beta.1`), runs `node scripts/release-version.mjs <next>`, stages only the files that script writes, and verifies that the commit touches nothing else. It then pushes the resulting `chore(release): bump Concord to <next>` commits in one push. When the push loses a race, the script fetches again and recounts, up to four attempts. Because every run counts from `origin/main` and not from its own checkout, a canceled, replaced, or rerun run creates no extra bump and leaves no merge without one, and the workflow needs no concurrency group. The count assumes a merge method that adds one first-parent commit per pull request (squash or merge commit); a rebase merge adds one commit per rebased commit and therefore one bump for each. Commits by `github-actions[bot]` that are not release bumps are neither counted nor a boundary.

A push made with the repository token starts no workflow run. As a second guard, the script exits without a commit when the checked-out commit is authored by `github-actions[bot]`.

The `version-guard` workflow runs on `pull_request_target`, so the workflow file and `scripts/release-bump.mjs` come from the base branch. It fetches the pull request head as `refs/pr/head`, never checks it out, runs `node scripts/release-bump.mjs guard origin/<base> refs/pr/head`, and fails when the pull request changes `VERSION` or any file the release script writes, except for a stable release (see "Stable release"). A pull request therefore cannot change the guard that checks it. The repository's Actions event policy must allow `pull_request_target`, because GitHub's default policy for public repositories blocks that event.

The rule costs one bot commit per merge, and `main` receives a push after each merge. The workflow needs only `contents: write` on the repository token and no stored credential.

## Stable release

A maintainer lands a stable version such as `0.9.0` through an ordinary human-authored pull request that runs `node scripts/release-version.mjs 0.9.0` and changes nothing else.

- **Guard.** `version-guard` passes a pull request that edits version files only when every changed file is one the release script writes, `VERSION` is among them, the head `VERSION` is a stable `X.Y.Z` (no prerelease or build suffix) with higher SemVer precedence than `VERSION` on the base tip, and each of the five files at the head is byte-identical to what the base's `release-version.mjs` writes into the base's copy of that file for that version. A release pull request therefore changes no manifest field except `version`. The head `VERSION` is read with `git show` as data, and the check runs from the base branch like the rest of the guard. Any other change to a version file still fails, so an ordinary pull request cannot touch a version file, and a release pull request cannot carry code.
- **Bump.** A first-parent commit is a boundary, and is not counted as a merge needing a bump, when its `VERSION` is stable and differs from its first parent's. The check reads file content because the squash-merge title is chosen at merge time. It does not repeat the guard's checks, so a stable `VERSION` change that reaches `main` without a guarded pull request (an administrator's direct push) also counts as a release. The first merge after the release is bumped to `0.10.0-beta.1`. A merge between the last bump and the release commit ships inside the release and gets no bump.
- **Patch releases.** `0.9.1` is lower than `0.10.0-beta.N`, so the guard rejects it against `main`; accepting it would make the next bump reissue `0.10.0-beta.1`. Patch releases land on a maintenance branch such as `release/0.9`, where the same guard compares `0.9.1` with `0.9.0`. `release-bump` runs only on `main`.
- **Cost.** The release pull request conflicts on `VERSION` whenever another bump lands, so it is rebased just before merge; the guard reruns on each push.
- **Residual exposure.** A pull request that changes only version files can set any higher stable version, such as `99.0.0`. Only review stops that; a `CODEOWNERS` entry for the five version files would require a release owner and is left to the maintainers.

## Guardrail and tests

A Node test reads `VERSION`, all three manifests, and both Copilot marketplace version fields, then asserts the six values are identical. The test uses the actual repository files, so a partial manual update fails the normal test suite.

The test also runs the release script against an isolated release tree to prove that a single invocation updates every target without modifying unrelated fields and that a preflight failure leaves existing files unchanged.

## Scope

This contract unifies version metadata and its release workflow. All harness marketplaces expose the shared plugin name `concord`, while their source directories and installation mechanisms remain independent.
