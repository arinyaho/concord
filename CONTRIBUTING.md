# Contributing

Where to look first:

| Path | What lives there |
| --- | --- |
| `plugins/concord/core/` | The vendor-neutral review, charter, and gate logic. `plugins/concord-codex/engine/` and `plugins/concord-copilot/engine/` hold the same files plus harness-specific additions. |
| `plugins/concord/skills/` | The shared workflow skills (`SKILL.md` per skill). |
| `plugins/*/hooks/`, `plugins/concord/adapters/`, `commands/` | Per-harness glue. |
| `plugins/concord/hooks/test/` | The plugin test suite. |
| `docs/design/`, `docs/plans/` | Design documents and implementation plans. |
| `scripts/dod.mjs`, `review.config.json` | The repo's definition of done, run by the review loop. |
| `VERSION`, `scripts/release-version.mjs` | Release version and the script that applies it to every manifest. |
| `.github/workflows/` | CI. |

Run the tests with Node 22:

```sh
find plugins -path '*/test/*.test.js' -type f -print0 | xargs -0 -r node --test
(cd services/agent-team && npm ci && npm test)
```

Open a pull request against `main`; CI runs the same checks. Keep each PR to one coherent change.
