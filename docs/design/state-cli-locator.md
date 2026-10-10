# State CLI locator

The `STATE_CLI` locator in review-until-lgtm searches the installed plugin caches for `review-lgtm-state.js` and accepted a copy only when an ancestor directory held `.codex-plugin/plugin.json` naming `concord`. The Claude package ships only `.claude-plugin/plugin.json`, and the Copilot package keeps `plugin.json` at its root, so every Claude and Copilot copy was skipped. On PR #289 the locator returned a Codex beta.19 copy while the installed Claude plugin was beta.25; beta.19 ignores `reviewerUnavailable` and recorded the delivery under older rules (#291).

## Decision

At each ancestor of a candidate script the locator reads, in order, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `plugin.json`. The first that parses decides that candidate: it is kept when its `name` is `concord` and its `version` is a string, and skipped otherwise. The newest version across the Claude, Codex and Copilot caches wins, whichever host the session runs in. The state CLI reads and writes one state directory format in every host, so a newer copy from another host's cache is safer than an older copy from the session's own host, which is the failure #291 records.

The command stays a single `node -e` line, identical in the three packages because `plugins/concord-codex/bin/bundle.mjs` and `plugins/concord-copilot/bin/bundle.mjs` copy the shared skill. `plugins/concord/hooks/test/state-cli-locator.test.js` extracts the command from each package's skill and runs it with `HOME` and `USERPROFILE` pointing at a temporary home that holds fixture caches.

## Transition table

The locator writes nothing; its state is the set of installed copies, and its only event is one run.

| Installed copies | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| Claude beta.25 (`.claude-plugin`), Codex beta.19 | locator run | prints the Claude beta.25 path | changed | `the locator selects a newer Claude cache copy over an older Codex cache copy` |
| Copilot beta.26 (root `plugin.json`), Codex beta.19 | locator run | prints the Copilot beta.26 path | changed | `the locator selects a newer Copilot copy, whose manifest sits at the package root` |
| Codex beta.19 only | locator run | prints the Codex beta.19 path | unchanged | `the locator selects a Codex cache copy when it is the only one installed` |
| Codex beta.19, a newer copy whose manifest names another plugin | locator run | prints the Codex beta.19 path | unchanged | `the locator never selects a copy whose manifest does not name concord` |
| only a copy whose manifest names another plugin | locator run | prints nothing, exits 1 | unchanged | `the locator never selects a copy whose manifest does not name concord` |

## Cost and residual exposure

Reading a root `plugin.json` means any ancestor directory with a `plugin.json` naming `concord` qualifies, not only a Copilot package root; the name check still excludes every other plugin, and the search still covers only the three cache roots, never the reviewed checkout.

Versions are compared with `localeCompare` and `numeric: true`, which orders a release below its own prereleases: `0.9.0` sorts before `0.9.0-beta.27`. A cache holding both would select the prerelease. This predates the change and is tracked as a follow-up.
