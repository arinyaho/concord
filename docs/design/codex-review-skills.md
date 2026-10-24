# Codex review skills

Codex plugins surface skills, not slash commands. The Codex package therefore ships `review-and-fix` and its alias `review-until-green` as skills (`plugins/concord-codex/skills/`), the same form as `review-until-lgtm` and `ticket-to-pr`.

## Decision

The Codex `review-and-fix` skill is hand-written in the Codex package and is not bundled from `plugins/concord/skills/`. Its driver differs from the Claude Code command (it calls `bin/review-and-fix.js`, which runs reviewers through `codex exec`), and a same-named shared skill would collide with the Claude Code command of that name.

The skill locates the runner through `<plugin-root>`, two levels above the skill's base directory. `${CLAUDE_PLUGIN_ROOT}` is not set in Codex.

## Cost and residual exposure

- The runner prose lives in one more hand-maintained file; `round-plan-sync.test.js` and `delivery-disposition.test.js` read it, so drift against the shared driver fails CI.
- `commands/charter.md` is still a command and has the same discovery problem; it is handled separately.

This change is not stateful: it moves a prompt document and writes no data that outlives a run.
