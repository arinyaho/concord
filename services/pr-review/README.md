# pr-review

Reviews open pull requests in other repositories with Concord's review engine and posts the verified findings as a GitHub review. Nothing is installed in the reviewed repositories. The workflows stay idle until `REVIEW_REPOS` is set, so this repository runs none of it; a private copy configured as below does.

## How a review runs

Every ten minutes `pr-review-poll.yml` runs `scan.sh`, which lists open non-draft pull requests touched within `REVIEW_STALE_DAYS` days, skips any whose comments already carry a `<!-- concord-review: <sha> -->` marker for the current head commit, and dispatches one `pr-review.yml` run for each of the rest, at most `REVIEW_MAX_PER_RUN` per poll. A pull request nobody has touched in a week is not waiting on a review.

Each review is its own run, keyed on the pull request, so a new push cancels the run still reviewing the commit it replaced. `review-one.sh` checks out the head commit and runs `plugins/concord-codex/bin/review-and-fix.js --review-only`: the correctness finder and its verifier, plus the repository-wide gate and gate verifier on a pull request's first review. The engine stops after verification and prints the findings that survived; it edits nothing. The script then posts them as one review, inline where a finding has a line in the diff and in the review body otherwise.

The first review of a pull request runs the gate (`--broad`); later pushes run the diff-local pass alone (`--no-broad`). The gate asks whether the change as a whole meets its requirements and keeps the invariants of files it did not touch, and those answers do not change when the author fixes a bug and pushes again. On that pass the pull request's title and body and the issues it closes are passed to the engine with `--intent-file` as the requirements to check against, in place of any intent command the reviewed repository configures. A pull request is on its first review when none of its comments carry a `<!-- concord-review:` marker.

The reviewer process never receives the review token. It reads the checkout; only `review-one.sh` talks to GitHub.

## Following a review in progress

While a pull request is being reviewed it carries a 👀 reaction and a pending `concord/review` commit status. When the review posts, the 👀 goes away and the status settles: `no issues found` plus a 👍 on the pull request when nothing survived verification, otherwise the number of findings. A new review clears the previous review's 👍 first, because a reaction belongs to the pull request rather than to the commit it judged. The status never fails, so it cannot block a merge; a review that dies before posting leaves it in `error`. The pull request body is never edited.

## Asking for a review

Comment `@concord broad` or `@concord diff` on a pull request to get that pass on the next poll, whatever the automatic rule would have chosen, including on a commit that was already reviewed. The comment gets a 🚀 when the command is picked up, and each command runs once. Requested reviews are taken before automatic ones. With `REVIEW_MANUAL_ONLY` set, only requested reviews run.

## Setting up a private copy

Run this from a private repository, never a public fork: Actions logs in a public repository are public, and they name the reviewed repositories and pull requests. Create an empty private repository, push a mirror of Concord into it (`git clone --bare` then `git push --mirror`), and configure it as below. Keep the copy free of its own commits so `upstream-sync.yml` can fast-forward it; change Concord upstream instead.

| Variable | Meaning |
| --- | --- |
| `REVIEW_REPOS` | Space-separated `owner/name` list of repositories to review. Setting it turns the poller on |
| `REVIEW_REVIEWER` | `claude` (default) or `codex` |
| `REVIEW_MODEL`, `REVIEW_EFFORT` | Optional reviewer model and reasoning effort passed to the engine |
| `REVIEW_RUNNER` | `runs-on` value as JSON, for example `["self-hosted","linux"]`; default `"ubuntu-latest"` |
| `REVIEW_MANUAL_ONLY` | Any value: review only what an `@concord` comment asks for |
| `REVIEW_STALE_DAYS`, `REVIEW_MAX_PER_RUN` | Defaults 7 and 3 |
| `UPSTREAM_REPO` | `owner/name` of Concord, which turns on the daily sync |

| Secret | Meaning |
| --- | --- |
| `REVIEW_PAT` | Fine-grained token over the reviewed repositories: Contents read, Pull requests read and write, Commit statuses read and write. Reviews are posted under its account |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`, when the reviewer is `claude` |
| `OPENAI_API_KEY` | When the reviewer is `codex` |
| `SYNC_TOKEN` | Fine-grained token over this copy: Contents and Workflows read and write |

`upstream-sync.yml` runs daily and fast-forwards `main` to the newest Concord release, the last upstream commit that changed `VERSION`, so unreleased work never runs with the copy's secrets. If the copy has commits of its own, the fast-forward fails and the run fails rather than merging.

Run `pr-review-poll` manually with **dry run** checked to list what it would review without spending anything.
