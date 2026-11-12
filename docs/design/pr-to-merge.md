# PR to merge

`pr-to-merge` watches the open pull requests of one or more repositories and carries them to their merge: it merges every pull request a person has approved as soon as GitHub allows the merge, clears what stands between an approval and the merge, answers the reviews on the user's own pull requests before they are approved, and checks the result after each merge. It has two parts: a script that watches and merges without a model, and a skill for what the script reports but does not decide. It follows the rules in [workflow-state-and-stops.md](workflow-state-and-stops.md).

It serves three uses with the same parts:

- a coordinating session keeps it running over the pull requests its workers open;
- a user starts it over a set of repositories;
- a scheduler runs it every night.

## Which pull requests it covers

In each repository it is given, the skill works on three sets of open, non-draft pull requests.

| Set | Members | What the skill does |
|---|---|---|
| Approved | Every pull request with an approval, whoever opened it and whoever it is assigned to | Clears open points and conflicts, and merges |
| Automated | Pull requests opened by an automation account the user names, such as the ones that move a dependency pin | Approves and merges |
| The user's own | Pull requests authored by or assigned to the account the user names, and pull requests listed one by one | Before approval: answers reviews and pushes fixes |

A pull request that is not approved, not automated, and not the user's own is left alone: the skill does not read its reviews, comment on it, or push to it.

## Authorization

Merging is hard to reverse, so the skill merges only when the user has authorized merging for the run and named the repositories. A scheduled run carries the authorization in its configuration, which the user writes. Without it the script runs with `--no-merge` and reports a pull request that meets every condition as `ready`.

The skill never uses an administrator override and never bypasses a branch rule. It approves only pull requests in the automated set, whose accounts the user names; every other approval comes from people.

## The script

`pr-to-merge.js` takes repositories (`OWNER/REPO`) and single pull requests (`OWNER/REPO#N`) as arguments, with these options:

| Option | Meaning |
|---|---|
| `--self <login>` | Required. The account the skill acts as. Its own reviews and comments are not review activity |
| `--mine <login>` | Pull requests authored by or assigned to this account are the user's own. A pull request given as `OWNER/REPO#N` is also the user's own |
| `--automated <login>[:<title prefix>]` | Pull requests opened by this account, with this title prefix when one is given, are automated. May be repeated |
| `--checkout OWNER/REPO=<path>` | A local clone of the repository, used to check the commits made after an approval |
| `--blocked-label <name>` | The label that keeps a pull request from merging. Default `blocked` |
| `--no-merge` | Report a qualifying pull request as `ready` and do not merge or approve it |
| `--state <file>` | The record of notices already printed |
| `--interval <seconds>`, `--deadline <seconds>` | How often to scan and when to exit |

A pull request.s base is the branch it targets: the repository.s default branch, or for a stack child its parent.s branch.

### When a pull request counts as approved

A pull request is approved when both hold:

1. At least one person who is an owner, member, or collaborator of the repository, and is not the pull request's author, has approved it. The approver does not need to be one of the requested reviewers.
2. No reviewer's latest review requests changes.

The approval covers the current head when it was given on the head commit, or on an earlier commit followed only by merge commits that are either clean merges of the base or made by the `--self` account. A clean merge of the base is a merge commit whose second parent is on the pull request.s base branch or the default branch and whose tree equals the tree git produces by merging its two parents without conflict. A merge made by the `--self` account is one the skill made to resolve a conflict, or one the script made when it merged a stack child into its parent. Both checks need the local clone; without `--checkout` for a repository, only an approval on the current head covers it.

### When a pull request qualifies for merge

An approved pull request qualifies when all of these hold on its current head commit:

1. The approval covers the head.
2. GitHub allows the merge: the pull request has no conflict and the branch rules are satisfied, including the checks the rules require. Checks the rules do not require may still be running.
3. It has no open point. An open point is an unresolved review thread, whoever opened it, or a review body or conversation comment that a person other than `--self` wrote after the approval and that `--self` has not answered with a later conversation comment or review. An approving review is not an open point, and neither is a conversation comment or review body from an automation account; an automated reviewer.s findings count through its threads. With several approvals, "after the approval" is counted from the earliest one that covers the head.
4. It does not carry the `blocked` label.

An automated pull request qualifies when condition 2 holds apart from the missing approval, conditions 3 and 4 hold, and no reviewer.s latest review requests changes. It has no approval to count from, so every comment on it that a person wrote counts under condition 3. The script approves it and merges it.

### Merging

- A qualifying pull request based on the default branch is squash-merged, at once. The script does not wait for checks the branch rules do not require.
- A stack is a chain of pull requests, each based on its parent's head branch, down to one based on the default branch. A stack merges only when every pull request in it qualifies and each child already contains its parent's head. The script merges each child into its parent with a merge commit, from the top down, and then squash-merges the bottom pull request. If a merge partway down the stack fails, the script reports it and the next scan continues from the pull requests that remain: the merge commits the script made are its own, so the approvals of the remaining pull requests still cover their heads.
- Every merge names the head commit it expects, so a push between the check and the merge fails the merge instead of merging unreviewed commits.
- When GitHub reports a qualifying branch as behind its base, the script updates the branch with a merge commit and merges in a later scan. The approval still covers the head.
- When a check the branch rules require has failed on an approved pull request with no open point, the script runs the failed jobs again, once per head.

### Review activity on the user's own pull requests

For a pull request that is the user's own and not yet approved, review activity is a review, a comment in a review thread, or a conversation comment that `--self` did not write and that the state file does not list. The script prints one `review` line for each such item and records it.

### What the script reports

The script prints one line per event.

| Line | Meaning |
|---|---|
| `merged <repo>#<n> …` | A pull request was merged. The line lists any check that was failing or still running at the merge |
| `approved <repo>#<n> (automated)` | The script approved an automated pull request |
| `ready <repo>#<n> …` | With `--no-merge`: the pull request meets every condition |
| `review <repo>#<n> …` | New review activity on one of the user's own pull requests: who, which kind, and for a thread its file, line, and whether it is resolved |
| `triage <repo>#<n> …: approved, open points` | An approved pull request has an unresolved thread, or a review or comment after the approval that is not answered |
| `triage <repo>#<n> …: approved, conflict` | An approved pull request conflicts with its base |
| `triage <repo>#<n> …: approved on an older head only` | Commits after the approval are neither clean merges of the base nor merges made by `--self` |
| `triage <repo>#<n> …: required check still red after one re-run` | The second run of the failed jobs also failed |
| `triage <repo>#<n> …: required check failed and cannot be re-run` | A required check that is not a workflow job failed |
| `rerun <repo>#<n> …`, `synced <repo>#<n> …` | Failed jobs were run again; a branch was updated from its base |
| `stack <repo>#<n>: a child does not contain its parent's head` | The stack needs its parent merged into the child |
| `merge failed …`, `sync failed …` | GitHub refused, with its message. A branch rule that requires a particular reviewer appears here |
| `closed <repo>#<n>` | A pull request given as `OWNER/REPO#N` was closed without merging |

A `review`, `ready`, or `triage` line is printed once per item or head; the state file records that it was printed. Activity on a pull request that carries the `blocked` label is reported as `triage … open points` again, so that the skill reads it again. A failed API call does not end the run: the script reports it on standard error and scans again after the interval.

The script exits after a scan that printed any line other than `rerun` or `synced`, so that the skill acts on it before the next scan. Otherwise it exits when the deadline passes.

## The skill

The skill starts the script as one background command, acts on what it prints, and starts it again. In a scheduled run it ends when the script reaches its deadline with nothing printed.

### Approved, with open points

Read every unresolved thread, and every review and comment written after the approval. Verify each point against the code, and decide whether it blocks: a serious defect, a security problem, an unmet acceptance criterion, or a mismatch with a related repository blocks; anything else is minor.

- **A point that is already handled.** Reply with the commit that handled it, and resolve the thread.
- **Only minor points remain.** Collect the pull request's minor points into one GitHub issue, reply on each thread or comment with the issue link, and resolve the threads. The pull request then qualifies and the next scan merges it.
- **A point blocks, and the pull request is the user's own.** Fix it and push, and reply with the commit. Then request review again from the people who approved, with one comment that mentions them and names the current commit.
- **A point blocks, and the pull request is someone else's.** Add the `blocked` label and post one comment that mentions the assignee, or the author when there is no assignee, names the blocking point, and asks for it to be resolved. Do not push to the branch. Do this once per point.

When the script reports new activity on a pull request that carries the `blocked` label, read it again. Remove the `blocked` label when no blocking point remains.

### Approved, with a conflict

Resolve the conflict by merging the base into the branch with a merge commit, on anyone's approved pull request. Keep what the base branch contributed and what the pull request contributed: neither side's change is dropped to make the other apply. Run the checks that cover the conflicting files before pushing. Never rebase or force-push.

Do not request a new review for a conflict resolution. The merge commit is made by the `--self` account, so the approval still covers the head and the next scan merges the pull request.

When both contributions cannot be kept, because they change the same behavior in incompatible ways, the choice is a product decision: add the `blocked` label, comment with the two options and mention the assignee, and report it to the user.

### Approval on an older head

New commits after the approval that are not merges of the base need the approver to look again. Request review again from each person who approved an earlier commit, and post one comment that mentions them and names the current commit. Do this once per head.

### Answering a review on the user's own pull request

Read the new item and every unresolved thread on that pull request, and the review bodies as well as the threads. Verify each point against the code before acting on it.

- Fix what is right, in ordinary commits.
- Reply after the fix is pushed. A reply is at most three lines: the verdict (agreed, disagreed, or already handled), the reason or what changed, and the commit. A disagreement may be longer and gives its evidence with file and line.
- A reply to an automated reviewer is in English, and the skill then resolves the thread.
- A reply to a person is in that person's language and mentions them. The skill leaves the thread for its author to resolve while the pull request is not yet approved.
- Points made in a review body with no thread are answered together in one conversation comment.
- When a point says the pull request body is out of date, rewrite those sections to match the current head.
- After replying, request review again from each person who reviewed.

### Failed required checks

Read the log of a required check that failed twice. A failure outside the change (a download, a registry, a runner) is reported with the run link. A failure caused by the change is a blocking point and is handled as one.

### After a merge

1. Watch the workflow runs on the merged head that were still running at the merge, and the runs the merge commit starts on the default branch. When a job fails, read its log; run it again when the failure is one a re-run can fix (a download, a registry, a runner, a timeout), once. Report a job that fails again, and a failure caused by the merged change, to the user with the run link.
2. For each ticket the merged pull request names, read the ticket's acceptance criteria. When every criterion is met with evidence, move the ticket to done. When one is not, move the ticket back to in progress and comment which criterion is unmet. The commands for the tracker come from the project's rules file.
3. Report each merged pull request to the user as one line with its link.

## Scheduling

The scheduled form runs in two steps on the machine that holds the repository clones and the GitHub credentials:

1. The operating system's scheduler starts the script with the user's configuration. The script uses no model.
2. When the script's output contains any line other than `rerun` or `synced`, a wrapper starts one agent session with the skill and that output as its input. On a night with nothing to merge, answer, or decide, no session starts.

## Why

**Approval is the signal, not ownership.** A pull request a teammate approved is ready to go in whoever opened it, and one nobody approved is not the skill's to touch. Covering every approved pull request lets one run clear a repository; leaving the unapproved ones alone keeps the skill out of work in progress.

**Any teammate's approval counts.** The requested reviewers are a suggestion about who should look. A repository that needs a particular person's approval says so in its branch rules, and GitHub then refuses the merge, which the script reports.

**The merge happens when GitHub allows it.** The branch rules say which checks must pass before a merge. Waiting for the others delays every merge by the slowest job and, with many pull requests, keeps branches falling behind the base. The checks that were not waited for are watched after the merge.

**A blocked pull request is marked with a label.** Whether a comment blocks is a judgment the skill makes once. The label records that judgment where the state of the work lives, so the script, a later session, and a person all see it, and removing it is one action.

**A conflict resolution does not go back to the approver.** The approver read the pull request's contribution, and the base's contribution was reviewed when it merged. A resolution that keeps both adds nothing either reviewer has not seen. Asking for a new review for each one makes an approved pull request wait once more for every merge that lands ahead of it.

**The script distinguishes its own merge commits from other commits after an approval.** Counting every later commit would merge changes no approver read. Counting none would send every synced or conflict-resolved branch back for approval. Clean merges of the base are checked by their tree, and conflict resolutions by the account that made them.

**One script reads each pull request once for every purpose.** Merging, blocking, and answering reviews depend on the same facts: the reviews, the threads, the comments, the checks, the head.

**Waiting costs no tokens.** Waiting for approvals and checks is most of the elapsed time from a ready pull request to its merge. A script waits; a model acts only when there is something to answer or decide.

## Rejected alternatives

- **Waiting until every check has passed.** A failing check that the branch rules do not require is then never merged unread. It also makes each merge wait for jobs the repository has decided are not required.
- **Counting only approvals that satisfy GitHub's review decision.** The decision follows the requested and required reviewers, so an approval from another teammate would not count.
- **Fixing a blocking point on someone else's pull request.** It gets the pull request merged sooner. It also changes a person's work under their approval without them, and the fix is unreviewed.
- **A state file that records blocked pull requests, fix rounds, and replies.** Everything it would record is readable from the pull request, and a record that disagrees with the pull request stops the run.
- **A script that judges comments by itself.** Whether a comment blocks depends on reading the code against it.
- **An agent platform's scheduled task in place of the operating system's scheduler.** It needs no machine of the user's to be running. It starts a model session every night to do what the script does without one, and it has neither the local clones the approval check uses nor the user's GitHub login.

## Residual exposure

- A pull request can merge while a check the branch rules do not require is failing or still running. The failure is found after the merge, on the default branch. In a repository whose rules require no checks, an approved pull request merges with no check finished.
- A conflict resolution is made by the skill and read by no person before the merge. The checks run before the push and CI are what test it.
- Whether a point is minor is the skill's judgment under the merge authorization. A blocking point filed as an issue merges. The issue and the reply are the record.
- An automated pull request is approved because of the account that opened it and its title. A change that the automation account was made to open by other means is approved the same way, so the user names only automation whose inputs they control.
- A commit counts as the skill's own by the account GitHub attributes it to. Anyone who can push as that account can add a merge commit that carries other changes.
- A tracker's own automation can close a ticket when a pull request merges. The post-merge step corrects the status afterwards, so a ticket can read as done for the time between the merge and that step.
