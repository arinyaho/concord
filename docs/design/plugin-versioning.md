# Plugin versioning

The Claude Code and Codex distributions are released as one Concord version. A release never exposes different version numbers across the two plugins.

## Single source of truth

The repository-root `VERSION` file contains the only human-maintained release version. It holds one SemVer-compatible version string and a trailing newline.

The two plugin manifests still contain required `version` fields, but those fields are derived release artifacts. Contributors do not update them directly.

## Release operation

`node scripts/release-version.mjs <version>` is the only version-bump interface. It:

1. validates that `<version>` is a SemVer release or prerelease version;
2. writes that value to `VERSION`;
3. updates `plugins/concord/.claude-plugin/plugin.json`;
4. updates `plugins/concord-codex/.codex-plugin/plugin.json`; and
5. preserves unrelated JSON fields.

The script is idempotent: running it with the already-current version produces no file-content changes.

## Post-merge bump

Every change that lands on `main` ships under its own beta version, raised by one automated commit on `main`; pull requests carry no bump. The plugin manager reports an installed plugin as current until `VERSION` changes, so each merge needs a new version, and raising it after the merge spares open pull requests a rebase and a re-review each time another one merges first.

The `release-bump` workflow runs on every push to `main` and calls `node scripts/release-bump.mjs push main`. The script fetches `main` and counts the first-parent commits after the newest boundary: a bump commit (authored by `github-actions[bot]`) or a stable release commit (see "Stable release"). For each of them it computes the next version from `VERSION` (`0.9.0-beta.9` to `0.9.0-beta.10`; a stable `0.9.0` to the next patch's first beta, `0.9.1-beta.1`), runs `node scripts/release-version.mjs <next>`, stages only the files that script writes, and verifies that the commit touches nothing else. It then pushes the resulting `chore(release): bump Concord to <next>` commits in one push. When the push loses a race, the script fetches again and recounts, up to four attempts. Because every run counts from `origin/main` and not from its own checkout, a canceled, replaced, or rerun run creates no extra bump and leaves no merge without one, and the workflow needs no concurrency group. The count assumes a merge method that adds one first-parent commit per pull request (squash or merge commit); a rebase merge adds one commit per rebased commit and therefore one bump for each. Commits by `github-actions[bot]` that are not release bumps are neither counted nor a boundary.

A push made with the repository token starts no workflow run. As a second guard, the script exits without a commit when the checked-out commit is authored by `github-actions[bot]`.

The `version-guard` workflow runs on `pull_request_target`, so the workflow file and `scripts/release-bump.mjs` come from the base branch. It fetches the immutable `pull_request.head.sha` from the event and records it as `refs/pr/head` (without requiring a synthetic `refs/pull/<number>/head` remote ref), never checks it out, and runs `node scripts/release-bump.mjs guard origin/<base> refs/pr/head`. A pull request therefore cannot change the guard that checks it. The repository's Actions event policy must allow `pull_request_target`, because GitHub's default policy for public repositories blocks that event.

The guard protects the version, not the manifests. A pull request may edit a plugin manifest when the manifest's `version` field at the head is identical to its value at the commit the pull request branched from, so descriptions, keywords, and every other field are ordinary content. `VERSION` may not change, and no manifest's `version` field may change, except in a stable release (see "Stable release"). A manifest fails the guard when at the head it is deleted or renamed away, is not a regular file (a symbolic link's content in git is its target path, so the file the release script later writes through it could hold any version), is not valid JSON, lacks a string `version`, or is not in the form the release script writes: two-space JSON with a trailing newline, exactly what serializing its own parse gives. That last condition rejects a duplicated `version` key, which a parser resolves one way and another reader of the file may resolve differently. The diff is read without rename detection, so a moved manifest counts as the deletion it is. When the pull request and the base have more than one merge base, there is no single commit to compare with, and a touched manifest fails. The head is read with `git show` and `git ls-tree` as data and nothing from it runs.

The rule costs one bot commit per merge, and `main` receives a push after each merge. The workflow needs only `contents: write` on the repository token and no stored credential.

## Stable release

A maintainer lands a stable version such as `0.9.0` through an ordinary human-authored pull request that runs `node scripts/release-version.mjs 0.9.0` and changes nothing else.

- **Guard.** `version-guard` passes a pull request that changes the version only when every changed file is one the release script writes, `VERSION` is among them, the head `VERSION` is a stable `X.Y.Z` (no prerelease or build suffix) with higher SemVer precedence than `VERSION` on the base tip, and each of the three files at the head is byte-identical to what the base's `release-version.mjs` writes into the base's copy of that file for that version. A release pull request therefore changes no manifest field except `version`. The head `VERSION` is read with `git show` as data, and the check runs from the base branch like the rest of the guard. Any other change to `VERSION` or to a manifest's `version` still fails, so an ordinary pull request cannot change the version, and a release pull request cannot carry code or edit another manifest field.
- **Bump.** A first-parent commit is a boundary, and is not counted as a merge needing a bump, when its `VERSION` is stable and differs from its first parent's. The check reads file content because the squash-merge title is chosen at merge time. It does not repeat the guard's checks, so a stable `VERSION` change that reaches `main` without a guarded pull request (an administrator's direct push) also counts as a release. The first merge after the release is bumped to the next patch's first beta (`0.9.0` to `0.9.1-beta.1`). A merge between the last bump and the release commit ships inside the release and gets no bump.
- **Patch and minor releases.** A patch release lands on `main` through the same release pull request: `0.9.1` ranks above `0.9.1-beta.N`, so the guard accepts it and the next bump moves to `0.9.2-beta.1`. A new minor or major is a release pull request that sets `0.10.0` (or `1.0.0`), which ranks above every `0.9.x-beta.N`; the bump after it starts at `0.10.1-beta.1`. No maintenance branch is needed.
- **Cost.** The release pull request conflicts on `VERSION` whenever another bump lands, so it is rebased just before merge; the guard reruns on each push. A pull request that edits a manifest's `description` conflicts the same way, because `version` and `description` are adjacent lines: it is brought up to date with the base just before merge, keeping the base's `version` line.
- **Residual exposure.** A pull request may edit any manifest field other than `version`, so a description, keyword, or other metadata change reaches users without the release owner's sign-off on the manifest. A pull request that changes only version files can set any higher stable version, such as `99.0.0`. Only review stops that; a `CODEOWNERS` entry for `VERSION` would require a release owner and is left to the maintainers; one for the manifests would also cover the description edits this rule allows.

## Guardrail and tests

A Node test reads `VERSION` and both manifests, then asserts the three values are identical. The test uses the actual repository files, so a partial manual update fails the normal test suite.

The test also runs the release script against an isolated release tree to prove that a single invocation updates every target without modifying unrelated fields and that a preflight failure leaves existing files unchanged.

## Scope

This contract unifies version metadata and its release workflow for the Claude Code and Codex distributions. Both marketplaces expose the shared plugin name `concord`, while their source directories and installation mechanisms remain independent.
