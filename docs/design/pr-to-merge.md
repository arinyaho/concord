# PR to merge

`pr-to-merge` watches a set of open pull requests and carries each one to its merge: it answers the reviews that arrive, keeps the branch mergeable, merges when people have approved and every merge condition holds, and checks the result afterwards. It has two parts: a script that watches and merges without a model, and a skill for what the script reports but does not decide. It follows the rules in [workflow-state-and-stops.md](workflow-state-and-stops.md).

It serves three uses with the same parts:

- a coordinating session keeps it running over the pull requests its workers open;
- a user starts it over their own open pull requests;
- a scheduler runs it every night over one or more repositories.

## Authorization

Starting the skill authorizes it to push fixes to the covered pull requests' branches and to reply on their threads.

Merging is hard to reverse, so the skill merges only when the user has authorized merging for the run. The authorization names the repositories and whose pull requests are covered: the user's own (authored by or assigned to the user's account), a given list, or every open pull request. A scheduled run carries the authorization in its configuration, which the user writes. Without it the script runs with `--no-merge` and reports a pull request that meets every condition as `ready`.

The script and the skill never approve a pull request, never use an administrator override, and never bypass a branch rule. Approval comes from people.

## The script

`pr-to-merge.js` takes repositories (`OWNER/REPO`) and single pull requests (`OWNER/REPO#N`) as arguments, with these options:

| Option | Meaning |
|---|---|
| `--owner <login>` | In each repository argument, cover open pull requests authored by or assigned to this account. `--owner '*'` covers every open pull request |
| `--self <login>` | The account the skill acts as. Its own reviews and comments are not review activity |
| `--checkout OWNER/REPO=<path>` | A local clone of the repository, used to check that commits after an approval are clean merges of the base |
| `--no-merge` | Report a qualifying pull request as `ready` and do not merge it |
| `--state <file>` | The record of notices already printed |
| `--interval <seconds>`, `--deadline <seconds>` | How often to scan and when to exit |

The base branch is each repository's default branch. Draft pull requests are not covered until they are marked ready.

On every scan the script reads each covered pull request once and does two things with what it reads: it reports new review activity, and it merges what qualifies.

### Review activity

Review activity is a review, a comment in a review thread, or a comment in the pull request's conversation that the `--self` account did not write and that the state file does not list. The script prints one `review` line for each such item and records it.

### When a pull request qualifies for merge

A pull request qualifies when all of these hold on its current head commit:

1. It is open and not a draft.
2. GitHub reports its review decision as approved, and an approval was given on the current head, or on an earlier commit followed only by clean merges of the base branch.
3. Every check reported on the head has finished and passed, was skipped, or is neutral. A cancelled run is ignored when another run of the same check finished.
4. GitHub reports it mergeable.
5. It has no unresolved review thread.

A commit is a clean merge of the base when it is a merge commit whose second parent is on the base branch and whose tree equals the tree git produces by merging its two parents without conflict. Such a commit changes nothing the approver read. This check needs the local clone; without `--checkout` for a repository, only an approval on the current head counts there.

### Merging

- A qualifying pull request based on the default branch is squash-merged.
- A stack is a chain of pull requests, each based on its parent's head branch, down to one based on the default branch. A stack merges only when every pull request in it qualifies and each child already contains its parent's head. The script merges each child into its parent with a merge commit, from the top down, and then squash-merges the bottom pull request. The whole stack merges in one scan or not at all.
- Every merge names the head commit it expects, so a push between the check and the merge fails the merge instead of merging unreviewed commits.
- When GitHub refuses a merge because the branch is behind its base, the script updates the branch with a merge commit and waits for CI in a later scan. The approval remains valid under condition 2.

### What the script reports

The script prints one line per event.

| Line | Meaning |
|---|---|
| `review <repo>#<n> …` | New review activity: who, which kind, and for a thread its file, line, and whether it is resolved |
| `merged <repo>#<n> …` | A pull request was merged |
| `ready <repo>#<n> …` | With `--no-merge`: the pull request meets every condition |
| `rerun <repo>#<n> …` | An approved, mergeable pull request with no open thread had failed checks; its failed jobs were run again. This happens once per head |
| `synced <repo>#<n> …` | A branch was updated from its base |
| `triage <repo>#<n> …: approved on an older head only` | An approval exists, but later commits are not clean merges of the base |
| `triage <repo>#<n> …: approved, unresolved threads` | Everything holds except condition 5 |
| `triage <repo>#<n> …: CI still red after one re-run` | The second run of the failed jobs also failed |
| `stack <repo>#<n>: a child does not contain its parent's head` | The stack needs its parent merged into the child |
| `merge failed …`, `sync failed …` | GitHub refused, with its message |
| `closed <repo>#<n>` | A covered pull request was closed without merging; it is no longer watched |

A `review`, `ready`, or `triage` line is printed once per item or head; the state file records that it was printed. A failed API call does not end the run: the script reports it on standard error and scans again after the interval.

The script exits after a scan that printed a `review`, `merged`, `ready`, `triage`, `stack`, or `failed` line, so that the skill acts on it before the next scan. Otherwise it exits when the deadline passes or when no covered pull request remains open.

## The skill

The skill starts the script as one background command, acts on what it prints, and starts it again. It ends when every covered pull request is merged or closed, or, in a scheduled run, when the script reaches its deadline with nothing printed.

### Answering a review

Read the new item and every unresolved thread on that pull request, and the review bodies as well as the threads. Verify each point against the code before acting on it.

- Fix what is right, in ordinary commits. Never rebase or force-push a branch under review.
- Reply after the fix is pushed. A reply is at most three lines: the verdict (agreed, disagreed, or already handled), the reason or what changed, and the commit. A disagreement may be longer and gives its evidence with file and line.
- A reply to an automated reviewer is in English, and the skill then resolves the thread.
- A reply to a person is in that person's language and mentions them. The skill leaves the thread for its author to resolve while the pull request is not yet approved.
- Points made in a review body with no thread are answered together in one conversation comment.
- When a point says the pull request body is out of date, rewrite those sections to match the current head.
- After replying, request review again from each person who reviewed.

### Approved with unresolved threads

Once a person has approved, the remaining threads are handled so that the pull request can merge:

- A point that is already handled: reply with the commit that handled it, then resolve the thread.
- A minor point that remains: collect the pull request's minor points into one follow-up issue, reply on each thread with the issue link, then resolve the thread.
- A point that blocks: fix it and push, and reply with the commit. The push makes the approval older than the head, which the next case handles.

### Approval on an older head

Request review again from each person who approved an earlier commit, and post one comment that mentions them and names the current commit. Do this once per head.

### Conflicts and stacks

Resolve a conflict by merging the base into the branch with a merge commit. When the resolution needs a design choice, report it to the user as a product decision and leave the pull request.

Before changing a pull request in a stack, list its reviews from the reviews API. A pull request that has an approval on its current head is not changed.

### Failed checks

Read the log of a check that failed twice. A failure outside the change (a download, a registry, a runner) is reported with the run link. A failure caused by the change is fixed like a blocking review point.

### After a merge

1. Watch the workflow runs that the merge commit starts on the default branch. Run a failed job again once; report it if it fails again.
2. For each ticket the merged pull request names, read the ticket's acceptance criteria. When every criterion is met with evidence, move the ticket to done. When one is not, move the ticket back to in progress and comment which criterion is unmet. The commands for the tracker come from the project's rules file.
3. Report each merged pull request to the user as one line with its link.

## Scheduling

The scheduled form runs in two steps on the machine that holds the repository clones and the GitHub credentials:

1. The operating system's scheduler starts the script with the user's configuration. The script uses no model.
2. When the script's output contains any line other than `rerun` or `synced`, a wrapper starts one agent session with the skill and that output as its input. On a night with nothing to answer, merge, or decide, no session starts.

## Why

**One script reads each pull request once for both purposes.** Answering reviews and merging depend on the same facts: the reviews, the threads, the checks, the head. A watcher for reviews and a separate one for merges would each poll the same pull requests and could act on different readings of them.

**The merge conditions are code because a model applies them unevenly.** A session that merges by reading each pull request's page merges one with an unanswered review now and then, and treats GitHub's review decision as proof of an approval on the current head, which it is not. The five conditions are exact and cheap to compute, and the script applies them the same way every time.

**The script stops at a decision and says which.** Whether a review point is right, whether an open thread is minor, whether a failed check is caused by the change, and whether a ticket's criteria are met are judgments. The script reports them and leaves them to the skill.

**The approval check reads the reviews, because the review decision alone is not enough.** The decision stays approved after new commits when the repository does not dismiss stale approvals. The script therefore compares the approved commit with the head, and accepts later commits only when they are clean merges of the base.

**Waiting costs no tokens.** Waiting for CI and for reviewers is most of the elapsed time from a ready pull request to its merge. A script waits; a model acts only when there is something to answer or decide.

**A person's thread is theirs until they approve.** Resolving a reviewer's thread before they have looked at the answer hides it from them. After their approval, the remaining threads are what stands between the approval and the merge, and each is closed with a reply that records what happened to it.

## Rejected alternatives

- **A state file that records fix rounds, review windows, replies, and a delivery classification per head.** It lets a session resume exactly and bounds the number of fix rounds. Everything it records is readable from the pull request, and a record that disagrees with the pull request stops the run.
- **Waiting for an explicit approval signal from an automated reviewer.** An automated reviewer's findings are answered like anyone's. Its approval is not a merge condition unless the repository's branch rules make it one, in which case condition 2 already covers it.
- **Merging when only the required checks pass.** It merges sooner. A failing check that the branch rules do not require is then merged without anyone reading it.
- **A script that resolves threads by itself.** Whether a thread is handled depends on reading the code against the comment.
- **An agent platform's scheduled task in place of the operating system's scheduler.** It needs no machine of the user's to be running. It starts a model session every night to do what the script does without one, and it has neither the local clones the approval check uses nor the user's GitHub login.
- **Counting an approval on any earlier commit.** It never asks a person to approve twice. It merges commits no approver read.

## Residual exposure

- The clean-merge rule accepts a merge of the base that the approver did not read. The merged base content was itself reviewed when it merged; an interaction between it and the approved change is caught only by CI.
- Whether a thread is minor is the skill's judgment under the merge authorization. A blocking point filed as a follow-up issue merges. The follow-up issue and the reply on the thread are the record.
- Deleting the state file makes the script report every existing review item again. The skill then reads threads that are already answered and finds nothing to do, at the cost of one session.
- A tracker's own automation can close a ticket when a pull request merges. The post-merge step corrects the status afterwards, so a ticket can read as done for the time between the merge and that step.
- Squash-merging the bottom of a stack after merging the children into it records the stack as one commit on the default branch. The individual pull requests keep their own history.
