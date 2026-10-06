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

Open a pull request against `main`; CI runs the same checks for changes under `plugins/`, `services/` (each service has its own workflow), `VERSION`, and the marketplace manifests; CI does not run the plugin-install end-to-end tests or cover `scripts/dod.mjs` and `review.config.json`, so run `node scripts/dod.mjs` locally for changes to those files, to `plugins/`, or to the marketplace manifests. Keep each PR to one coherent change.
