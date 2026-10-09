# Contributing

Where to look first:

| Path | What lives there |
| --- | --- |
| `plugins/concord/core/` | The vendor-neutral review, charter, and gate logic. `plugins/concord-codex/engine/` and `plugins/concord-copilot/engine/` hold the same files plus harness-specific additions. |
| `plugins/concord/skills/` | The shared workflow skills (`SKILL.md` per skill). |
| `plugins/*/hooks/`, `plugins/concord/adapters/`, `plugins/concord/commands/`, `plugins/concord-codex/commands/`, `plugins/concord-copilot/com.github.copilot/commands/` | Per-harness glue and slash commands. |
| `plugins/concord/hooks/test/` | The plugin test suite. |
| `docs/design/` | Design documents and decision records. |
| `scripts/dod.mjs`, `review.config.json` | The repo's definition of done, run by the review loop. |
| `VERSION`, `scripts/release-version.mjs` | Release version and the script that applies it to every manifest. |
| `.github/workflows/` | CI. |

Run the tests with Node 22:

```sh
find plugins -path '*/test/*.test.js' -type f -print0 | xargs -0 -r node --test
(cd services/agent-team && npm ci && npm test)
(cd services/code-index && uv sync --extra dev && uv run pytest -v)
```

Open a pull request against `main`; CI runs the same checks for changes under `plugins/`, `services/` (each service has its own workflow), `VERSION`, and the marketplace manifests; CI does not run the plugin-install end-to-end tests or cover `scripts/dod.mjs` and `review.config.json`, so run `node scripts/dod.mjs` locally for changes to those files, to `plugins/`, or to the marketplace manifests. Keep each PR to one coherent change, and end it with the version bump described under "Versioning".

## Versioning

Every PR, including a docs-only or test-only PR, ends with one commit, `chore(release): bump Concord to <next>`, produced only by `node scripts/release-version.mjs <next>`. `<next>` is `main`'s `VERSION` at merge time plus one prerelease increment, for example `0.9.0-beta.8` to `0.9.0-beta.9`. If `main`'s `VERSION` changes after you cut the branch, rebase and run the script again with the new `<next>`. A PR that is itself a release bump needs no second bump. CI fails a PR whose `VERSION` equals the base branch's.

## Review

Fix review comments that are rollout blockers (serious bugs, security issues, unmet acceptance criteria) before merging. Leave minor comments open while the pull request is in progress; just before merging, read them together once and file a ticket for each one worth keeping. A minor comment does not block a merge.

Group small issues that change the same file or area into one pull request, including the tickets filed for minor review comments, and take the groups with the most issues first. Run groups in different areas in parallel when the files they change do not overlap. Within a group, mark each item that needs rule wording or a design, and give it to an agent of Opus-class or higher capability.
