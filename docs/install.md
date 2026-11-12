# Install, update and remove

The Claude Code steps are in the [README](../README.md). This page covers Codex.

## Codex

Install:

```
codex plugin marketplace add arinyaho/concord --ref main --sparse .agents/plugins --sparse plugins/concord-codex
codex plugin add concord@arinyaho-concord
```

Run those commands in a shell, then start or restart Codex. Use `review-and-fix`, `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, `proposal-package-authoring`, and `review-until-lgtm` in a Codex conversation; they are skills, not shell commands.

The Codex plugin ships the session-state checkpoint, `/charter`, `review-and-fix`, `review-until-lgtm`, `review-until-approve`, `deep-review`, provider-neutral `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. `review-until-green` remains a compatibility alias. Reviewers and fixers run as `codex exec` subprocesses.

Update:

```
codex plugin marketplace upgrade arinyaho-concord
codex plugin add concord@arinyaho-concord
```
