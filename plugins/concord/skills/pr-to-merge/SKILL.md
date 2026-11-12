---
name: pr-to-merge
description: >-
  Use when the open pull requests of named repositories should be carried to their merge: merge every approved pull request as soon as GitHub allows it, clear open points and conflicts on approved pull requests, answer reviews on the user's own pull requests before approval, and check each merge afterwards — "승인된 PR들 머지될 때까지 챙겨줘", "merge the approved PRs in acme/app as they become ready", "keep my PRs moving until they merge", or a nightly scheduled run.
  Do NOT use to review someone else's pull request (use review-until-approve), to review and fix a branch (use review-and-fix), or to merge one pull request once on request.
---

# PR to merge

A script watches the repositories and merges without a model; you act on each line it prints and start it again. The script decides every exact condition (approval, coverage of the head, qualification, merge order). Never merge, approve, re-run or update a branch yourself in its place. The rules behind each step are in `docs/design/pr-to-merge.md`.

## Setup

- `SCRIPT` is `scripts/pr-to-merge.js` next to this file. Resolve the installed path first; do not assume a layout.
- Read the project's rules file first. Tracker commands, reviewers to request, automation accounts and the reply language for each repository come from it, not from this skill.
- `--self` is the account `gh` is logged in as (`gh api user --jq .login`). `--mine` is the account whose pull requests the user calls theirs, usually the same.
- Pass `--checkout OWNER/REPO=<path>` for every repository with a local clone whose `origin` is that repository. Without it only an approval on the current head counts.
- Pass `--automated <login>[:<title prefix>]` only for automation accounts the user or the rules file names.
- Keep one `--state` file per run, outside every repository (for example `~/.local/state/concord/pr-to-merge-<name>.json`), and pass the same path on every start.

## Authorization

- Merging is authorized only when the user said so for this run, in their own words, and named the repositories. Record the words and the date as the coordinating session's standing authorization. Without it, add `--no-merge`, which also stops every other write of the script.
- The authorization covers the named repositories and the actions this skill describes in them: comments, labels, review requests, thread resolution, issues for minor points, and pushes of merge commits and fixes. Nothing outside those repositories.
- Never use an administrator override, never bypass a branch rule, never approve a pull request (the script approves automated ones), never rebase or force-push.

## Run

Start the script as one background command. Under Claude Code use Bash `run_in_background` with `timeout: 7200000`:

```sh
node "$SCRIPT" --self <login> --mine <login> --state <file> [--checkout OWNER/REPO=<path>]... [--automated <login>[:<prefix>]]... [--no-merge] --deadline 6600 OWNER/REPO... [OWNER/REPO#N...]
```

On a harness without background commands, run it in the foreground with a `--deadline` that fits the command time limit. Do nothing else while it runs. When it exits, act on every line it printed, in order, then start the same command again. Exit status 2 is a usage error: fix the command. Lines on standard error are API failures the script survived; mention them only when the same one repeats across runs.

| Line | Action |
|---|---|
| `merged …` | After a merge |
| `approved … (automated)` | None; its `merged` line follows |
| `ready …` | Tell the user it is ready to merge and that merging is not authorized |
| `review …` | Answering a review on the user's own pull request |
| `triage …: approved, open points` | Approved, with open points |
| `triage …: approved, conflict` | Approved, with a conflict |
| `triage …: approved on an older head only` | Approval on an older head |
| `triage …: required check still red after one re-run`, `triage …: required check failed and cannot be re-run` | Failed required checks |
| `stack …: a child does not contain its parent's head` | Merge the parent's head branch into the child with a merge commit and push, as for a conflict |
| `merge failed …`, `sync failed …` | Tell the user the pull request and GitHub's message. A branch rule that requires a particular reviewer is the user's to settle |
| `closed …` | A pull request listed as `OWNER/REPO#N` was closed without merging: tell the user in one line |
| `rerun …`, `synced …` | None |

### Approved, with open points

Read every unresolved thread, and every review and comment written after the approval. Verify each point against the code. A serious defect, a security problem, an unmet acceptance criterion, or a mismatch with a related repository blocks; anything else is minor. The script counts a review body or conversation comment only when a person wrote it and it is not an approving review; an unresolved thread counts whoever opened it.

- Already handled: reply with the commit that handled it and resolve the thread.
- Only minor points remain: collect the pull request's minor points into one GitHub issue, reply on each thread or comment with the issue link, and resolve the threads. The next scan merges it.
- A point blocks on the user's own pull request: fix it, push, reply with the commit, then request review again from the people who approved, with one comment that mentions them and names the current commit.
- A point blocks on someone else's pull request: add the `blocked` label and post one comment that mentions the assignee (the author when there is none), names the blocking point, and asks for it to be resolved. Do not push to the branch. Do this once per point.

When this line comes for a pull request that carries the `blocked` label, read it again and remove the label when no blocking point remains.

### Approved, with a conflict

On anyone's approved pull request, merge the base into the branch with a merge commit made as `--self`. Keep both what the base contributed and what the pull request contributed. Run the checks that cover the conflicting files, then push. Do not request a new review; the next scan merges it.

When both cannot be kept because they change the same behavior in incompatible ways, add the `blocked` label, comment with the two options mentioning the assignee, and report it to the user as a decision.

### Approval on an older head

Request review again from each person who approved an earlier commit, and post one comment that mentions them and names the current commit. Do this once per head.

### Answering a review on the user's own pull request

Read the new item, every unresolved thread on the pull request, and the review bodies. Verify each point against the code before acting.

- Fix what is right in ordinary commits, and reply after the fix is pushed. A reply is at most three lines: agreed, disagreed or already handled; the reason or what changed; the commit. A disagreement may be longer and gives its evidence with file and line.
- Reply to an automated reviewer in English, then resolve the thread. Reply to a person in that person's language and mention them; leave the thread for them to resolve.
- Answer points made in a review body with no thread together in one conversation comment.
- When a point says the pull request body is out of date, rewrite those sections to match the current head.
- After replying, request review again from each person who reviewed.

### Failed required checks

Read the log of the failed check. A failure outside the change (a download, a registry, a runner) is reported to the user with the run link. A failure caused by the change is a blocking point: handle it as in Approved, with open points.

### After a merge

1. Watch the workflow runs on the merged head that were still running at the merge (the `merged` line names them) and the runs the merge commit starts on the default branch. When a job fails, read its log. Run it again once when a re-run can fix it (a download, a registry, a runner, a timeout). Report a job that fails again, or a failure the merged change caused, to the user with the run link.
2. For each ticket the merged pull request names, read its acceptance criteria. When every criterion is met with evidence, move the ticket to done; otherwise move it back to in progress and comment which criterion is unmet. Use the tracker commands from the rules file.
3. Report each merged pull request to the user as one line with its link.

## Scheduled form

The operating system's scheduler (cron, launchd, Task Scheduler) runs a wrapper on the machine that holds the clones and the `gh` login. The wrapper's command line is the user's configuration; leaving out `--no-merge` is the merge authorization, so the user writes it. The wrapper starts an agent session only when the output holds a line other than `rerun` or `synced`. That session follows this skill and ends when the script reaches its deadline with nothing printed.

```sh
#!/bin/sh
out=$(node /path/to/pr-to-merge.js --self octocat --mine octocat \
  --state "$HOME/.local/state/concord/pr-to-merge-nightly.json" \
  --checkout acme/app="$HOME/src/app" --deadline 1800 acme/app)
if printf '%s\n' "$out" | grep -qv -e '^rerun ' -e '^synced ' -e '^$'; then
  claude -p "Use the pr-to-merge skill for acme/app. Merging is authorized for acme/app by this scheduled configuration. Act on this output, then keep running the script with the same options until it reaches its deadline with nothing printed:
$out"
fi
```
