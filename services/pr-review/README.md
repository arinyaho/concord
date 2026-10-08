# pr-review

Reviews open pull requests in other repositories with Concord's review engine, with Claude or Codex as the reviewer, and posts the verified findings as a GitHub review. Nothing is installed in the reviewed repositories. The workflows stay idle until `REVIEW_REPOS` is set, so this repository runs none of it; a private copy configured as below does.

## How a review runs

Every ten minutes `pr-review-poll.yml` runs `scan.sh`, which reads listed open non-draft pull requests to reconcile unfinished status updates, then considers those touched within `REVIEW_STALE_DAYS` days and previously covered PRs whose review inputs changed, and dispatches one `pr-review.yml` run per pull request that needs a review, requested reviews first, at most `REVIEW_MAX_PER_RUN` per poll. It skips a pull request when:

- the review account has posted coverage for the same head, actual merge base and intent hash, recorded as `<!-- concord-review: <sha> mode:<broad|diff> base:<merge-base> intent:<hash> -->`;
- a visible `pr-review.yml` run for the same review identity is queued or running, named `review <repo>#<pr> @ <sha> identity:<hash>`;
- the last review of the same inputs failed (its `concord/review (#<pr>)` status is `error`): unchanged failed inputs are not retried automatically; changed head, merge base or intent, or a new `@concord` command starts the next one;
- its conversation or its status cannot be read, until the next poll.

A poll that cannot list a repository's pull requests or the active runs fails. The activity cutoff applies to initial automatic reviews. Covered PRs are checked for input changes even when inactive, because a closing issue edit need not update PR activity. Status reconciliation also considers older open pull requests in the listed set. Discovery retains the newest-1000-open-PR and 200-workflow-run windows; PRs outside that selection have no refresh guarantee, and matching active runs outside the visible window can be redispatched. Issue reads have no separate fanout budget, and the workflow timeout can stop discovery early.

Each review is its own run, keyed on the pull request, so a new push cancels the run still reviewing the commit it replaced. `review-one.sh` reviews only repositories listed in `REVIEW_REPOS`, checks out the dispatched commit, validates the dispatched review identity and takes the merge base against the immutable base-tip OID in the PR snapshot, and runs `plugins/concord-codex/bin/review-and-fix.js --review-only`: the correctness finder and its verifier, plus the repository-wide gate and gate verifier on a pull request's first review. The engine stops after verification and prints the findings that survived; it edits nothing. The script then posts them as one review, inline where a finding's line is inside a diff hunk and in the review body otherwise.

Review-only workers run sequentially within the job's 90-minute limit. The runner checks the saved round inputs, ledger, and completed reviewer artifacts after each worker and before reporting findings; a changed or missing protected file fails the review. Git rounds save a changed-path manifest from the same fixed comparison as their patch. Correctness coverage and intent filtering use that manifest, including binary changes, empty additions, deletions, renames, and mode-only changes, without reconstructing scope from patch headers.

The first review runs the gate (`--broad`). Later pushes reuse broad coverage and run the diff-local pass (`--no-broad`) only while the actual merge base and collected intent remain unchanged. A changed merge base, PR title/body or relevant closing-issue title/body requires a new broad pass, including changes at the same head SHA. Retargeting to a different branch with the same merge base and intent preserves coverage. Closing issues are sorted by repository and number before hashing, so reordering does not invalidate intent. The SHA-256 review identity combines head, merge base and the exact collected intent hash; the same helper collects inputs for the scanner and worker. On that pass the pull request's title and body and the issues it closes in the same repository are passed to the engine with `--intent-file` as the requirements to check against, in place of any intent command the reviewed repository configures; a foreign issue is named without fetching its body, and a same-repository issue the review token cannot read is named and skipped. The complete intent reaches the engine; its existing 256 KiB cap fails the review instead of silently dropping requirements. The broad pass keeps running until one has completed for matching merge base and intent, which a `mode:broad` marker records; an earlier requested diff pass does not count. A marker counts only as the first line of a body the review account posted; markers anyone else writes, or that appear further down in finding text, are ignored.

The checkout is untrusted, so the engine runs none of its configuration: not the intent command in its `review.config.json`, and not its `.claude/settings.json`, `CLAUDE.md`, skills, or agents (Claude runs with `--setting-sources user`). The reviewer also runs with an empty `CLAUDE_CONFIG_DIR`, so the runner account's own allow-lists, hooks, MCP servers, and plugins do not apply either. Codex logs in under `RUNNER_TEMP`, which the runner empties after every job, and the reviewer runs from a `CODEX_HOME` of its own that holds only that login and marks the checkout untrusted before Codex starts, so the checkout's `.codex/config.toml` (MCP servers, instructions) does not load, and with `project_doc_max_bytes=0` and `--ignore-rules`, so its `AGENTS.md` and execpolicy rules do not either; the checkout's skills still load as text. Its native permissions profile denies shell access to both login files and network access, excludes credentials from tool environments, and uses `--strict-config` so a Codex CLI that cannot apply the profile fails. Review-only mode refuses the Copilot reviewer, which has no such controls. The reviewer process never receives the review token: it reads the checkout, and only `review-one.sh` talks to GitHub. Instructions written into the reviewed files still reach the model as text, so the script also refuses to post a review whose text exactly contains the review token or the reviewer's model credential, and ends in `error` instead.

## Existing markers during upgrade

A legacy head-only completion cannot prove its merge base or intent and requires one new broad pass. Its command IDs remain consumed. A legacy active run with the same head is left alone until it finishes; a legacy error without input identity remains suppressed until a new command or commit. Existing exact-attempt and strictly-later legacy publication receipts can still repair statuses, but they do not establish versioned coverage. The new workflow accepts an omitted identity for direct/manual invocation and computes it from the worker snapshot.

## Following a review in progress

While a pull request is being reviewed it carries a 👀 reaction and a pending `concord/review (#<pr>)` commit status; the context names the pull request because other pull requests can share the commit. When the review posts, the 👀 goes away and the status settles: `no issues found` plus a 👍 on the pull request when nothing survived verification, otherwise the number of findings. Before each review POST, including fallback publication, the worker re-reads head and the full review identity and refuses to post if either changed or cannot be read. It checks head again before adding 👍. Superseded or canceled requested reviews leave their command eligible for the replacement. The lookup and POST are not atomic: head, base or intent can change after a lookup, so a stale review or reaction can still appear and no correction time is guaranteed. A new review clears the previous review's 👍 first, because a reaction belongs to the pull request rather than to the commit it judged. A review that dies before posting attempts to leave its dispatched status in `error` and remove 👀. Cleanup is best-effort; API failures can leave a pending status or reaction. The scanner claims the pending status before dispatch so the worker can verify its attempt ownership; a failed claim defers dispatch and a failed dispatch settles that claim to `error` only while the attempt still owns the status. Before changing status or PR reactions, a worker verifies that a different or unknown owner has not replaced it; a direct workflow retry may take over a terminal status but not another pending attempt. Terminal status writes re-read the latest per-PR status before each retry. Missing, legacy or unreadable ownership prevents a worker terminal write; legacy receipt recovery follows the narrower scanner rules. That ownership lookup and write are also non-atomic. Publication and status settlement are separate: every dispatched attempt has an identifier in its statuses and a script-generated receipt in the posted review. If posting succeeds but status settlement fails, the job reports the failure and a later poll repairs only the status for that exact attempt, without repeating the review. Receipts retain the attempt UUID on the second review-body line and the full input identity on the third. A versioned status requires both to match. Recovery re-reads the latest status before writing, so an observed replacement is left alone. An older receipt cannot settle a newer requested attempt. Status reads are paginated, and unreadable evidence defers reconciliation. A required status can remain pending during an API outage. If every attempt-tagged status write fails, or legacy timestamps are ambiguous, the poller cannot safely identify the completed attempt and leaves status repair for manual reconciliation. The pull request body is never edited.

## Asking for a review

An owner, member, or collaborator of the repository can comment `@concord broad` or `@concord diff` on a pull request to get that pass on the next poll, optionally naming the reviewer (`@concord broad codex`, `@concord diff claude`; without one, `REVIEW_REVIEWER` applies), whatever the automatic rule would have chosen, including on a commit that was already reviewed. The comment gets a 🚀 when the command is picked up. Each command runs once: if its review fails, the review account comments a `<!-- concord-review-failed: <sha> cmd:<id> -->` marker saying so, and the command is not run again, even after a push, until someone asks again. The mode must be a whole word, so `@concord difference` is not a command. When several commands are waiting, the newest one not yet done runs. With `REVIEW_MANUAL_ONLY` set, only requested reviews run.

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
