# pr-review

Reviews open pull requests in other repositories with Concord's review engine, with Claude or Codex as the reviewer, and posts the verified findings as a GitHub review. Nothing is installed in the reviewed repositories. The workflows stay idle until `REVIEW_REPOS` is set, so this repository runs none of it; a private copy configured as below does.

## How a review runs

Every ten minutes `pr-review-poll.yml` runs `scan.sh`, which lists open non-draft pull requests touched within `REVIEW_STALE_DAYS` days, and dispatches one `pr-review.yml` run for each, at most `REVIEW_MAX_PER_RUN` per poll. It skips a pull request whose head commit already carries a `<!-- concord-review: <sha> mode:<broad|diff> -->` marker posted by the review account, whose review of that commit is queued or running (a `concord/review` status pending for under an hour, set the moment the review is dispatched), or whose review of that commit failed (status `error`); a status counts only when its description names this pull request, since other pull requests can share the commit; a failed review is not retried on its own, and a new push or an `@concord` command starts the next one. It also skips, for that poll, a pull request whose conversation it cannot read. Each pull request is read once per poll, and requested reviews are dispatched before automatic ones. A pull request nobody has touched in a week is not waiting on a review.

Each review is its own run, keyed on the pull request, so a new push cancels the run still reviewing the commit it replaced. `review-one.sh` checks out the dispatched commit, takes the merge base with the pull request's own base branch, and runs `plugins/concord-codex/bin/review-and-fix.js --review-only`: the correctness finder and its verifier, plus the repository-wide gate and gate verifier on a pull request's first review. The engine stops after verification and prints the findings that survived; it edits nothing. The script then posts them as one review, inline where a finding's line is inside a diff hunk and in the review body otherwise.

The first review of a pull request runs the gate (`--broad`); later pushes run the diff-local pass alone (`--no-broad`). The gate asks whether the change as a whole meets its requirements and keeps the invariants of files it did not touch, and those answers do not change when the author fixes a bug and pushes again. On that pass the pull request's title and body and the issues it closes are passed to the engine with `--intent-file` as the requirements to check against, in place of any intent command the reviewed repository configures; an issue the review token cannot read is named and skipped. The broad pass keeps running on new commits until one has completed on the pull request, which a `mode:broad` marker records; an earlier requested diff pass does not count. A marker counts only as the first line of a body the review account posted; markers anyone else writes, or that appear further down in finding text, are ignored.

The checkout is untrusted, so the engine runs none of its configuration: not the intent command in its `review.config.json`, and not its `.claude/settings.json`, `CLAUDE.md`, skills, or agents (Claude runs with `--setting-sources user`). The reviewer also runs with an empty `CLAUDE_CONFIG_DIR`, so the runner account's own allow-lists, hooks, MCP servers, and plugins do not apply either. A Codex reviewer runs from a `CODEX_HOME` of its own that holds only the login and marks the checkout untrusted before Codex starts, so the checkout's `.codex/config.toml` (MCP servers, instructions) does not load, and with `project_doc_max_bytes=0` and `--ignore-rules`, so its `AGENTS.md` and execpolicy rules do not either; the checkout's skills still load as text. Review-only mode refuses the Copilot reviewer, which has no such controls. The reviewer process never receives the review token: it reads the checkout, and only `review-one.sh` talks to GitHub. Instructions written into the reviewed files still reach the model as text, so the script refuses to post a review whose text contains the review token or the reviewer's model credential, and ends in `error` instead.

## Following a review in progress

While a pull request is being reviewed it carries a 👀 reaction and a pending `concord/review` commit status. When the review posts, the 👀 goes away and the status settles: `no issues found` plus a 👍 on the pull request when nothing survived verification, otherwise the number of findings. A new review clears the previous review's 👍 first, because a reaction belongs to the pull request rather than to the commit it judged. The status never fails, so it cannot block a merge; a review that dies before posting leaves it in `error`. The pull request body is never edited.

## Asking for a review

An owner, member, or collaborator of the repository can comment `@concord broad` or `@concord diff` on a pull request to get that pass on the next poll, whatever the automatic rule would have chosen, including on a commit that was already reviewed. The comment gets a 🚀 when the command is picked up. Each command runs once: if its own review fails, which the error status names, it is not run again until someone asks again. The mode must be a whole word, so `@concord difference` is not a command. When several commands are waiting, the newest one not yet done runs. With `REVIEW_MANUAL_ONLY` set, only requested reviews run.

## Setting up a private copy

Run this from a private repository, never a public fork: Actions logs in a public repository are public, and they name the reviewed repositories and pull requests. Create an empty private repository and push Concord's newest release into it as `main`, so the copy never starts on unreleased work:

```sh
git clone https://github.com/arinyaho/concord.git && cd concord
git push <private-repository-url> "$(git log -1 --format=%H origin/main -- VERSION):refs/heads/main"
```

Then configure it as below. Keep the copy free of its own commits so `upstream-sync.yml` can fast-forward it; change Concord upstream instead.

| Variable | Meaning |
| --- | --- |
| `REVIEW_REPOS` | Space-separated `owner/name` list of repositories to review. Setting it turns the poller on |
| `REVIEW_REVIEWER` | `claude` (default) or `codex` |
| `REVIEW_MODEL` | Optional model for the reviewer |
| `REVIEW_RUNNER` | `runs-on` value as JSON, for example `["self-hosted","linux"]`; default `"ubuntu-latest"` |
| `REVIEW_MANUAL_ONLY` | Any value: review only what an `@concord` comment asks for |
| `REVIEW_STALE_DAYS`, `REVIEW_MAX_PER_RUN` | Defaults 7 and 3 |
| `UPSTREAM_REPO` | `owner/name` of Concord, which turns on the daily sync |

| Secret | Meaning |
| --- | --- |
| `REVIEW_PAT` | Fine-grained token over the reviewed repositories: Contents read, Pull requests read and write, Commit statuses read and write, Issues read and write (the broad pass reads the issues a pull request closes, and the 👀, 🚀, and 👍 reactions are issue reactions). Reviews are posted under its account |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`, when the reviewer is `claude` |
| `OPENAI_API_KEY` | When the reviewer is `codex` |
| `SYNC_TOKEN` | Fine-grained token over this copy: Contents and Workflows read and write |

`upstream-sync.yml` runs daily and fast-forwards `main` to the newest Concord release, the last upstream commit that changed `VERSION`, so unreleased work never runs with the copy's secrets. If the copy has commits past the release, its own or unreleased upstream ones, the run fails rather than merging or carrying them.

Run `pr-review-poll` manually with **dry run** checked to list what it would review without spending anything.
