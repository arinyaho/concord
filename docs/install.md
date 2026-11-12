# Install and update

The Claude Code steps are in the [README](../README.md). This page covers Codex.

## Codex

Install:

```
codex plugin marketplace add arinyaho/concord --ref main --sparse .agents/plugins --sparse plugins/concord-codex
codex plugin add concord@arinyaho-concord
```

Run those commands in a shell, then start or restart Codex. Use `review-and-fix`, `ticket-to-pr`, `initiative-to-prs`, `coordinate-sessions`, `pr-to-merge`, `review-until-approve`, `ticket-writing`, `deep-review`, `proposal-package-authoring`, and `work-report` in a Codex conversation; they are skills, not shell commands.

The Codex plugin ships those skills, the session-state checkpoint, and `/charter`. A Codex plugin carries no agent definitions, so `review-and-fix` and `coordinate-sessions` give the reviewer and the worker their instructions from a reference file inside the skill. `review-until-approve` runs its reviewers as `codex exec` subprocesses.

Update:

```
codex plugin marketplace upgrade arinyaho-concord
codex plugin add concord@arinyaho-concord
```
