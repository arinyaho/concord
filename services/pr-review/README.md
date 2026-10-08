# pr-review

Reviews open pull requests in other repositories with Concord's review engine, with Claude or Codex as the reviewer, and posts the verified findings as a GitHub review. Nothing is installed in the reviewed repositories. The workflows stay idle until `REVIEW_REPOS` is set, so this repository runs none of it; a private copy configured as below does.

## How a review runs

Every ten minutes `pr-review-poll.yml` runs `scan.sh`, which reads listed open non-draft pull requests to reconcile unfinished status updates, then considers those touched within `REVIEW_STALE_DAYS` days and dispatches one `pr-review.yml` run per pull request that needs a review, requested reviews first, at most `REVIEW_MAX_PER_RUN` per poll. It skips a pull request when:

- the review account has already posted a `<!-- concord-review: <sha> mode:<broad|diff> -->` marker for its head commit;
- a `pr-review.yml` run for that commit has any status other than `completed`, which the run's name `review <repo>#<pr> @ <sha> cmd:<command-id-or->` tells; older suffix-free names also count;
- a retained run for that commit completed without a confirmed successful conclusion, or its `concord/review (#<pr>)` status is `error`: an automatic review is not retried on its own, and a new push or an `@concord` command starts the next one;
- its conversation or its status cannot be read, until the next poll.

A poll reads every page of the unfiltered `pr-review.yml` run history before deciding what to dispatch, so an older active run cannot be omitted by a fixed result limit. A poll that cannot finish that inventory fails before dispatching. Successful traversal is not an atomic snapshot: concurrent changes to run pages or a run accepted after traversal may be missed. A poll that cannot list a repository's pull requests also fails. The poll workflow has a 10-minute job limit; a long history can exhaust that budget or the shared Actions API quota. Affected polls dispatch nothing, and repeated polls may defer work until quota or history changes. The activity cutoff applies to new review dispatches; status reconciliation also considers older open pull requests in the listed set.

Each review is its own run, keyed on the pull request, so a new push cancels the run still reviewing the commit it replaced. `review-one.sh` reviews only repositories listed in `REVIEW_REPOS`, checks out the dispatched commit, takes the merge base with the pull request's own base branch, and runs `plugins/concord-codex/bin/review-and-fix.js --review-only`: the correctness finder and its verifier, plus the repository-wide gate and gate verifier on a pull request's first review. The engine stops after verification and prints the findings that survived; it edits nothing. The script then posts them as one review, inline where a finding's line is inside a diff hunk and in the review body otherwise.

Review-only workers run sequentially within the job's 90-minute limit. The runner checks the saved round inputs, ledger, and completed reviewer artifacts after each worker and before reporting findings; a changed or missing protected file fails the review. Git rounds save a changed-path manifest from the same fixed comparison as their patch. Correctness coverage and intent filtering use that manifest, including binary changes, empty additions, deletions, renames, and mode-only changes, without reconstructing scope from patch headers.

The first review of a pull request runs the gate (`--broad`); later pushes run the diff-local pass alone (`--no-broad`). The gate asks whether the change as a whole meets its requirements and keeps the invariants of files it did not touch, and those answers do not change when the author fixes a bug and pushes again. On that pass the pull request's title and body and the issues it closes in the same repository are passed to the engine with `--intent-file` as the requirements to check against, in place of any intent command the reviewed repository configures; a foreign issue is named without fetching its body, and a same-repository issue the review token cannot read is named and skipped. The complete intent reaches the engine; its existing 256 KiB cap fails the review instead of silently dropping requirements. The broad pass keeps running on new commits until one has completed on the pull request, which a `mode:broad` marker records; an earlier requested diff pass does not count. A marker counts only as the first line of a body the review account posted; markers anyone else writes, or that appear further down in finding text, are ignored.

The checkout is untrusted, so the engine runs none of its configuration: not the intent command in its `review.config.json`, and not its `.claude/settings.json`, `CLAUDE.md`, skills, or agents (Claude runs with `--setting-sources user`). The reviewer also runs with an empty `CLAUDE_CONFIG_DIR`, so the runner account's own allow-lists, hooks, MCP servers, and plugins do not apply either. Codex logs in under `RUNNER_TEMP`, which the runner empties after every job, and the reviewer runs from a `CODEX_HOME` of its own that holds only that login and marks the checkout untrusted before Codex starts, so the checkout's `.codex/config.toml` (MCP servers, instructions) does not load, and with `project_doc_max_bytes=0` and `--ignore-rules`, so its `AGENTS.md` and execpolicy rules do not either; the checkout's skills still load as text. Its native permissions profile denies shell access to both login files and network access, excludes credentials from tool environments, and uses `--strict-config` so a Codex CLI that cannot apply the profile fails. Review-only mode refuses the Copilot reviewer, which has no such controls. The reviewer process never receives the review token: it reads the checkout, and only `review-one.sh` talks to GitHub. Instructions written into the reviewed files still reach the model as text, so the script also refuses to post a review whose text exactly contains the review token or the reviewer's model credential, and ends in `error` instead.

## Following a review in progress

While a pull request is being reviewed it carries a 👀 reaction and a pending `concord/review (#<pr>)` commit status; the context names the pull request because other pull requests can share the commit. When the review posts, the 👀 goes away and the status settles: `no issues found` plus a 👍 on the pull request when nothing survived verification, otherwise the number of findings. A new review clears the previous review's 👍 first, because a reaction belongs to the pull request rather than to the commit it judged. A review that dies before posting tries to leave its status in `error`; a failed status write can leave it pending. Publication and status settlement are separate. A trusted same-SHA posted review with a valid first-line marker proves publication; its attempt receipt associates that publication with a UUID attempt. A valid attempt-tagged status needs an exact matching receipt to settle. A status whose description does not start with `attempt:` instead needs a known timestamp and a strictly later trusted same-SHA review with a valid publication marker, whether or not the review includes a receipt. Equal timestamps and malformed `attempt:` prefixes cannot settle. If posting succeeds but status settlement fails, the job reports the failure and a later poll can repair the status without repeating the review when the matching evidence is available. An older receipt cannot settle a newer requested attempt. Status reads are paginated, and unreadable evidence defers reconciliation. A required status can remain pending during an API outage. If every attempt-tagged status write fails, or legacy timestamps are ambiguous, the poller cannot safely identify the completed attempt and leaves status repair for manual reconciliation. The pull request body is never edited.

## Asking for a review

An owner, member, or collaborator of the repository can comment `@concord broad` or `@concord diff` on a pull request to get that pass on the next poll, optionally naming the reviewer (`@concord broad codex`, `@concord diff claude`; without one, `REVIEW_REVIEWER` applies), whatever the automatic rule would have chosen, including on a commit that was already reviewed. The comment gets a 🚀 when the command is picked up. Each command runs once: a completed workflow run consumes it even if cancellation or setup/preflight failure prevented the worker from starting. A failed worker also tries to post a `<!-- concord-review-failed: <sha> cmd:<id> -->` marker. Consumption prevents replay; it does not guarantee a review, failure comment, reaction cleanup, notification, or terminal commit status. A pending status may require operator reconciliation. Submit a new command to request another attempt. The mode must be a whole word, so `@concord difference` is not a command. When several commands are waiting, the newest one not yet done runs. With `REVIEW_MANUAL_ONLY` set, only requested reviews run.

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
| `REVIEW_REVIEWER` | `claude` (default) or `codex`, for automatic reviews and commands that name no reviewer |
| `REVIEW_MODEL` | Optional model for the reviewer |
| `REVIEW_RUNNER` | `runs-on` value as JSON, for example `["self-hosted","linux"]`; default `"ubuntu-latest"` |
| `REVIEW_MANUAL_ONLY` | Any value: review only what an `@concord` comment asks for |
| `REVIEW_STALE_DAYS`, `REVIEW_MAX_PER_RUN` | Defaults 7 and 3 |
| `UPSTREAM_REPO` | `owner/name` of Concord, which turns on the daily sync |

| Secret | Meaning |
| --- | --- |
| `REVIEW_PAT` | Fine-grained token over the reviewed repositories: Contents read, Pull requests read and write, Commit statuses read and write, Issues read and write (the broad pass reads the issues a pull request closes, and the 👀, 🚀, and 👍 reactions are issue reactions). Reviews are posted under its account |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`, for the `claude` reviewer |
| `OPENAI_API_KEY` | For the `codex` reviewer. Set both to switch reviewers with a comment when one runs out |
| `SYNC_TOKEN` | Fine-grained token over this copy: Contents and Workflows read and write |

`upstream-sync.yml` runs daily and fast-forwards `main` to the newest Concord release, the last upstream commit that changed `VERSION`, so unreleased work never runs with the copy's secrets. If the copy has commits past the release, its own or unreleased upstream ones, the run fails rather than merging or carrying them.

Run `pr-review-poll` manually with **dry run** checked to list what it would review without spending anything.
