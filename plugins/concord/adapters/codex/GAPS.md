# Codex adapter — known differences

What differs on Codex from the Claude Code adapter, for the code this directory holds and the runner of `review-until-approve`.

## `codex exec` in a directory Codex does not trust

An unattended `codex exec` in a directory that is not in Codex's trust table (the `[projects."..."]` table of `~/.codex/config.toml`) prints `Not inside a trusted directory and --skip-git-repo-check was not specified.` and then waits on standard input forever, because there is no terminal to answer the prompt. Every `codex exec` invocation Concord gives therefore carries `--skip-git-repo-check`: the forms in the `review-and-fix` and `coordinate-sessions` skills, and the runner of `review-until-approve` (`skills/review-until-approve/scripts/runner/launch.js`).

## Reviewer processes

The runner of `review-until-approve` starts each reviewer role as its own `codex exec` process. The processes share no session context, so each pays its own startup and model calls.

## Abandoned session tail

Claude Code can locate an abandoned session transcript beside its project state directory and fold an unwritten tail on the next start. Codex rollouts live in a date-partitioned global session tree unrelated to Concord's state directory, so Codex persists each session through its own Stop hook and cannot perform that catch-up scan.
