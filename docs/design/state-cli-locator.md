# Installed script locator

A skill whose commands run across hours or days cannot keep a script path it resolved once: the Codex updater removes the previous version directory while the skill waits. `review-until-approve` therefore resolves its `scripts/` directory again before every command, with one locator command written in its skill text. This document defines which installed copy the locator selects.

## Decision

The locator searches the installed plugin caches of Claude Code and Codex for the skill's entry script (`scripts/approve.js` under `review-until-approve`). It never searches the reviewed checkout or the current directory.

At each ancestor directory of a candidate script the locator reads, in order, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `plugin.json`. The first that parses decides that candidate: it is kept when its `name` is `concord` and its `version` is a string, and skipped otherwise.

The newest version across the caches wins, whichever harness the session runs in. Versions are ordered by Semantic Versioning 2.0.0 precedence: a release outranks its own prereleases, numeric prerelease identifiers compare as numbers and the others lexically, and build metadata after `+` is ignored. The locator prints the directory of the winning script, or prints nothing and exits 1 when no copy qualifies.

The command is a single `node -e` line with no `"`, `$`, or backtick inside it, so it runs unchanged in a POSIX shell, PowerShell, and cmd.exe. It is identical in the two packages because `plugins/concord-codex/bin/bundle.mjs` copies the shared skill.

The locator writes nothing; its state is the set of installed copies, and its only event is one run, so this change is not stateful.

## Why

**The newest installed version, not the harness's own.** Both packages carry the same skill, and a state file written by one is read by the other. Selecting by harness would let an older copy in one cache act on state a newer copy wrote.

**The manifest name decides, not the path.** Another plugin can ship a script with the same file name. Requiring the manifest above the script to name `concord` excludes it.

## Rejected alternatives

- **A path resolved once at the start.** It is one command shorter. The path is gone after an update, and every later command fails.
- **`${CLAUDE_PLUGIN_ROOT}` or the skill's own directory.** They need no search. Codex does not set the variable, and the skill's directory is the one the updater removes.
- **Comparing versions as strings.** It needs no parser. `beta.10` then sorts before `beta.9`, and a release sorts before its own prereleases.

## Residual exposure

- A copy in either cache whose manifest names `concord` is trusted. Anything that can write there can supply the script the session runs.
- The search walks the whole of each cache root on every command.

## Evidence

`plugins/concord/skills/review-until-approve/test/relocate.test.js` extracts the command from the skill text and runs it against fixture caches: it names the newest installed version, and never a path from the reviewed checkout.
