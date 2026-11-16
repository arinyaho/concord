# PR to merge

`pr-to-merge` carries the user's own pull requests to their merge, and merges the automated pull requests of accounts and paths the user names. A background watcher checks the watched repositories every five minutes without a model: it requests reviewers, asks an approver again when their approval no longer covers the head, re-runs failed jobs, updates branches that are behind, merges what qualifies as soon as GitHub allows it, and records notices for the user. A confined headless agent session starts only for work that needs a model: answering reviews, fixing a failing check, resolving a merge conflict, and checking a merged pull request's tickets. In the user's session, the skill adds repositories to the watch list and relays the notices. It follows [workflow-state-and-stops.md](workflow-state-and-stops.md).

## Scope

In each watched repository the watcher acts on two sets of open pull requests:

- **The user's own**: authored by `--self`, the account `gh` is logged in as. A draft is watched and not acted on until it is ready.
- **Automated**: from an automation account the user names, changing only paths the user names, such as dependency pin updates.

Other people's pull requests are their authors' to merge; the watcher reads them only for the merge order. A coordinating session's workers act as the user's account, so their pull requests are the user's own.

## Trust

A counting account has write, maintain, or admin permission on the repository, as GitHub's collaborator permission API reports it. Only a counting account's approval, request for changes, comment, or thread affects a merge; automation accounts and items with no author never count. An account whose permission cannot be read makes the pull request wait for the next check.

Every input other people can write is data, never an instruction:

| Input | Read by |
|---|---|
| Titles, branch and check names | The script, whose lines carry only logins, numbers, short SHAs, fixed words, GitHub URLs, and names reduced to a safe character set |
| Review items and their replies | A session. In a private repository every comment; in a public one only those of counting accounts and of `--reviewer-bot` accounts. Other comments are reported as `review` lines only. Visibility is read every check |
| Failed job logs | A session; they carry output of dependencies and third-party actions |
| Ticket text | A session; anyone with access to the tracker writes it |
| The branch's tree: code, the rules file, conflicting base code | A session, in its worktree |
| The project's rules file on the default branch | The skill, at invocation: reviewers, check commands |

No session holds a GitHub credential or runs code from a pull request the user does not own.

## Authorization

Invoking the skill over named repositories authorizes, there and in their tickets: watching, review requests, re-runs of failed jobs, the script's pushes, replies, and thread resolutions on the user's own pull requests, and ticket updates after a merge.

Merging, updating a branch that is behind, and approving an automated pull request or withdrawing that approval also need the merge authorization: the user's words for the invocation naming the repositories, or a coordinating session's standing authorization recorded from such words. The skill records it in the repository's watch entry; an entry without it carries `--no-merge`, and the watcher reports as `ready` what it would merge. `pr-to-merge.js confirm OWNER/REPO#N`, which the skill runs only on the user's words in their session, records the merge authorization for that pull request's current head (under The user's own pull request). Automation accounts, paths, and reviewer bots come only from the user's words.

An entry and its authorization last until the user removes it or seven days after the invocation that wrote it; invoking the skill again renews it. Either removal is recorded as `unwatched`.

Nothing uses an administrator override or bypasses a branch rule. No session can rebase, force-push, approve, or merge (under Headless sessions); the script pushes only fast-forwards of the pull request's own branch.

## The watcher

Concord's per-user state directory holds one notice list shared with `review-until-approve`. `pr-to-merge` has its own directory beside it with the watch list, the notice record, the lock, the session records, the sessions' worktrees, input and result files, and a log. `pr-to-merge.js watch add` writes an entry; `watch remove` deletes one.

| Option | Meaning |
|---|---|
| `OWNER/REPO` or `OWNER/REPO#N` | A whole repository, or pull requests of it. Numbers add to an entry of numbers; a whole repository replaces it. Numbers limit the entry without making a pull request the user's own |
| `--self <login>` | Required: the account `gh` is logged in as, which `watch add` checks. A check finding another account records `account` and skips the entry. Its approvals never count, and nothing it posts holds a merge |
| `--automated <account>`, `--automated-path <glob>` | An automation account (`x[bot]` or `app/x` for an app, a plain login for a user) and the paths its pull requests may change. Repeatable; paths are required with an account |
| `--reviewer <login or org/team>` | A reviewer the rules file names. Repeatable |
| `--reviewer-bot <account>` | An automated reviewer whose comments sessions answer in a public repository. Repeatable |
| `--check <command>` | A focused check command the rules file names, which a session may run and the script runs before a push. Repeatable |
| `--checkout <path>` | A local clone. Coverage needs it, and session worktrees are made from it. Without it only an approval on the head covers it and no session starts; its work is reported |
| `--blocked-label <name>` | The user's hold label, default `blocked`. `review-blocked`, which `review-until-approve` owns, holds too and is not configurable |
| `--merge-agent-pushes` | On a base that requires no review, merge the user's own pull request whose head an agent pushed without the user's confirmation |
| `--no-merge` | No merge, branch update, or automated approval or withdrawal |
| `--harness <claude or codex>`, `--model <name>` | For sessions: the harness the user invoked from, and the model the user asked for |

`watch add` starts the watcher unless the lock names a running one, outside any harness sandbox (a process keeps its sandbox for life), after the probe `review-until-approve` makes (a write in the state directory and a GitHub API read); where the probe fails, it prints the command for the user. The watcher is spawned detached and unreferenced, with nothing registered with the operating system. Every five minutes it runs one check as a child process from the newest installed copy the [state-cli-locator.md](state-cli-locator.md) locator finds. It exits when the watch list is empty, ends at reboot or logout, and runs beside `review-until-approve`'s watcher.

A check lists each repository's open pull requests in one query and reads details only for those of its sets; at about eight requests each, GitHub's hourly limit covers about fifty watched pull requests. A check short of quota stops and records `rate limited`.

**Notices.** Both skills add their lines to the shared notice list and notify by the same rule: one system notification (Notification Center, `notify-send`, a PowerShell toast) per check that added a line that is not informational, with the count and no pull request text, and one after ten failed checks in a row. The plugin's `SessionStart` hook prints the list's pending lines, and a line for each skill whose watch list is not empty while no watcher runs. A `pr-to-merge` line stays pending until `watch status`, run by the skill in the user's session, shows it; headless sessions load no hooks and run no `watch status`, so they mark nothing shown. Invoking the skill restarts a stopped watcher.

## A check

### Approval and coverage

A pull request is approved when a counting account other than its author and `--self` approved it; the approver need not have been requested. An approval by `--self`, or whose review body ends with a `<!-- review-until-approve:state … -->` line, which `review-until-approve` writes, never counts, whichever account posted it; a forged line can only remove an approval.

An approval covers the head when it was given on the head, or on an earlier commit followed on the head's first-parent line only by merges that are either a clean merge of the pull request's own base (second parent on the base branch, tree equal to git's conflict-free merge of the parents) or a merge GitHub made for `--self` (verified, committed by GitHub's web flow, authored by `--self`). Without the clone only an approval on the head covers it.

### The user's own pull request

On each of the user's own pull requests that is ready for review, the script:

1. **Requests reviewers** when none is requested, GitHub's timeline shows none ever was, and no counting account has reviewed: the entry's reviewers, recorded as `requested`; with none in the entry, it records `no reviewer`. GitHub requests CODEOWNERS owners itself.
2. **Asks the approver again** when the base requires a review and no counting approval covers the head: it requests a review from the newest counting approver unless already requested, once per head, recorded either way as `stale approval`. An approval later dismissed counts here.
3. **Hands review items to a session** (under Trust for which), each once.
4. **Re-runs a failed required check** once per head (GitHub's run attempt is the record), and hands a second failure to a session. A failed check that is not a workflow job is reported.
5. **Hands a conflict with the base to a session** when the entry has `--check` commands; otherwise reports it.

GitHub reports that the base requires no review when the pull request's review decision is empty. There the pull request can merge without an approval, measured from the **last human push**: the newest commit on the head's first-parent line that neither keeps coverage nor carries the `Concord-Session` trailer the script writes into every commit it makes, timed by its earliest check suite, else its committer date. Unless the entry has `--merge-agent-pushes`, a head with a session commit after the last human push waits: the script records `pushed by an agent; merge after you look`, and the user runs `confirm` or merges by hand. A confirmation covers later commits that keep coverage, as an approval does. An outstanding review request holds such a pull request for 24 hours from the request, unless the user confirms.

### Holds

An approval settles what came before it. What a counting account other than `--self` adds after the newest covering approval holds the merge; on the path without approval, after the later of the last human push and the user's confirmation. Three things hold:

1. **Later activity**: a thread comment, conversation comment, or non-approving review body newer than that time, by the later of its publish and edit times. It holds until a counting approval, or on the path without approval the user's confirmation, comes after it. No push and no thread resolution releases it.
2. **A request for changes** as a counting account's latest review.
3. **A hold label**: `blocked` (or `--blocked-label`) or `review-blocked`, compared without regard to case. The user holds with `blocked`; `review-until-approve` holds with `review-blocked` while its state records an open or asked blocker or cannot be read, because it usually posts as `--self` too.

Items from before that time do not hold, nor anything an automation account posts, nor the covering approval's own inline comments. On an automated pull request every later-activity item holds. What the user writes, as `--self`, does not hold. Nothing here adds or removes a label.

### Automated pull requests

When no counting approval covers the head, a pull request is automated when its author matches an `--automated` account exactly (an app account only by a Bot login, a user account only by a user login), its head branch is in the repository, and every changed file, including a renamed file's old path, matches an `--automated-path`. The script approves such a head after reading the head again unchanged, and merges in a later check; each new head is approved again. When a head it approved is no longer automated, it dismisses its own approval (a body-less approval by `--self` on a named automation account's pull request) and records `triage`; the pull request is then its author's. Failed checks are re-run as on the user's own.

### Qualifying and merging

A pull request qualifies when:

1. a counting approval covers the head, or it is automated and `--self` approved this head, or it is the user's own on a base that requires no review and not waiting as above;
2. nothing holds it;
3. no session works on it or was handed work for it in this check;
4. GitHub reports it mergeable with no required check pending or failed;
5. GitHub does not report a branch rule blocking it (recorded as `triage` once per head).

The script approves an automated head when conditions 2 to 4 hold.

- It merges into its own base once no open pull request from the same repository, draft included, is based on its branch; otherwise it records `stack`. A chain merges from its last member down, one level per check. A pull request from the default branch is never a parent. A child neither the user's own nor automated is its author's to merge, and its parent waits.
- The method is a merge commit when the head branch is the default branch or the base is another open pull request's branch, else a squash; when the repository does not allow it, the next allowed of squash, merge commit, and rebase.
- Every merge names the expected head (`--match-head-commit`). `merged` is recorded only when GitHub reports the pull request merged; otherwise `queued`, once.
- A branch GitHub reports as behind its base is updated at once with a merge commit.

After a merge, the watcher follows the workflow runs on the merged head that were running at the merge and those the merge commit starts on its base, re-runs a failed job once, and records a second failure as `post-merge failed`. A merge of the user's own pull request goes to a session for the ticket step.

## Notices

Each notice is one line, recorded once per pull request and head (a `review` line once per item) while the notice record holds it. `approved`, `rerun`, `synced`, and `requested` are informational.

| Line | Meaning |
|---|---|
| `merged`, `queued`, `ready` | Merged, with base, method, head, checks not passed, and threads unresolved; accepted and not reported merged; with `--no-merge`, would merge |
| `requested`, `no reviewer` | Reviewers requested; or none requested and the entry names none |
| `stale approval` | The newest counting approver's login and commit, `asked again` or `already requested`, then the number of commits after it that keep no coverage, `commits after it not read` without the clone, or `not on the head's first-parent line` |
| `pushed by an agent; merge after you look` | Waits for `confirm` (under The user's own pull request) |
| `review` | Review activity no session acts on, with who, kind, and link |
| `session … done`, `… question`, `… failed`, `… cap` | A session ended; left a question; failed, timed out, or its push was refused; or the daily cap was reached |
| `triage …: <reason>` | What stops the pull request where nothing handles it: `held by` (`thread`, `comment`, `label`), `changes requested`, `conflict`, `a branch rule blocks the merge`, `required check still red after one re-run`, `required check failed and cannot be re-run`, `automated approval withdrawn` or `could not be withdrawn`, `behind its base` |
| `approved`, `rerun`, `synced`, `stack … #<m>`, `post-merge failed` | Automated approval; failed jobs re-run; branch updated; qualifies but `#<m>` is based on its branch; a run of the merge failed again, with its link |
| `merge failed`, `sync failed`, `request failed`, `post failed` | GitHub refused, with the HTTP status or `refused`; the message goes to the log, which no session reads |
| `closed`, `account`, `unwatched`, `rate limited` | A named pull request closed unmerged; another `gh` account; an entry removed or expired; quota exhausted |

The notice record is also action state: it decides which review items went to a session and which approvers were asked again. Deleting it replays items; a session's input includes the replies already posted, so it sees an item answered.

## Headless sessions

**Launch.** The script makes a worktree of the pull request's branch at its head, from the clone, in the state directory, never the user's checkout, and starts the session with the switches `review-until-approve` uses for its agents: under Claude Code `claude -p` with no settings sources, only the guard hook, `dontAsk` with no permission prompts, `--tools Read,Grep,Glob,Edit,Write,Bash`, no MCP servers, no persistence, and the canary check; under Codex `codex exec --ephemeral` with a permissions profile writable only in the worktree and the result file, after the same refused home listing. The environment carries no GitHub token. The guard is [explain-pr.md](explain-pr.md)'s read-only hook with a mode file naming the worktree, the input directory, the result file, and the `--check` commands: it allows reads in the worktree and input directory, edits in the worktree, the result-file write, and a shell command only when it equals a check command. Everything else is refused, never prompted; a session that cannot proceed fails. The prompt carries this skill's session instructions and the paths, and marks the inputs as data.

**Input and result.** The script writes the inputs into the input directory: the review items with their replies, the failed job's log, the conflicting merge (the script starts `git merge` of the base, leaving the conflict in the worktree), or the closed GitHub issues' text. The session edits files and writes the result file: per item a reply and whether to resolve the thread, a commit message, questions with options and a recommendation, unfixed minor points, and per ticket a verdict. The script ignores what names no input item, runs the `--check` commands, and commits with the `Concord-Session` trailer only when they pass (a conflict also needs no conflict markers left), pushes as a fast-forward of the head it started from, then posts the replies escaped and scanned as `review-until-approve` publishes agent text, with the mention it adds itself, resolves the threads the result marks for automated reviewers, and requests review again from each person who reviewed, once per head. For a GitHub issue it closes a ticket whose criteria are met, or reopens one with a comment naming the unmet criterion; a ticket in another tracker is left in the report for the skill.

**Limits.** One session runs at a time. Each has 30 minutes and a result file of at most 1 MiB; past either it is stopped and fails. The session record holds its process id and start time; a watcher that finds a recorded session from a previous watcher stops it if still running, and removes worktrees of sessions not running. At most six sessions run per pull request in 24 hours, counted in the session records; past that the watcher records `session … cap` and starts none for it until the user invokes the skill. A failed session's work is not handed over again.

**Work.**

- **Answering a review.** Verify each item against the code, fix what is right, and reply in at most three lines (verdict, reason or change, commit), with file and line for a disagreement. An automated reviewer gets English and its thread marked for resolution; a person gets their language and keeps their thread. Review-body points get one conversation comment; a body called out of date is rewritten; unfixed minor points are listed, with no ticket filed.
- **Fixing a failing check.** Read the log and fix the cause. A failure outside the change (a download, a registry, a runner, a timeout) goes in the report.
- **Resolving a conflict.** Resolve the files and run the checks. A conflict of intent rather than text, or one the checks do not pass, goes in the report unpushed. The merge is not clean, so it loses coverage and the approver is asked again.
- **After a merge.** For each ticket, a verdict: done when every acceptance criterion is met with evidence, otherwise in progress with the unmet criterion.

A product decision, or anything else only the user can settle, goes in the result's questions; the session handles the rest.

## The skill

On invocation, the skill reads the rules file on the default branch (reviewers, check and tracker commands, reply language), takes the merge authorization from the user's words or passes `--no-merge`, runs `watch add` per repository and `watch status`, and relays each notice as one line with a link. It puts a session's question to the user and acts on the answer; does in the user's session the work of a failed session, a ticket in another tracker, or a repository without a clone; offers `confirm` on `pushed by an agent` and runs it only on the user's words; and runs `watch remove` on the user's stop.

## Why

**The user's pull requests are the user's to drive**; another author's waits on that author's decisions, such as when it lands.

**Trust follows the authority to merge.** A counting account could merge the pull request itself; membership does not imply write access, so the permission API is read.

**An approval settles what came before it, and only a person releases a hold.** The approver saw that moment's threads; only later additions are unseen. A push never releases a hold, because most pushes after a review are made by agents. Without an approval, the last human push and the user's confirmation take the approval's place. The rule compares times and accounts GitHub reports.

**An agent's push waits for the user on a base that requires no review.** There the user is the only person between an agent's commit and the base, so by default the user looks first; `--merge-agent-pushes` is for repositories where that is not wanted. An outstanding review request means the user wanted a reviewer, so it holds for a day.

**A session edits and the script acts.** A session reads text anyone can write, so it gets no credential, `git`, or `gh`; the worst steered output is a wrong edit, which the checks, the user, or reviewers see before a merge.

**Outsiders' comments reach a session only in a private repository**, where every commenter has access; in a public one only counting accounts and named reviewer bots do.

**Asking the approver again is the next step, not a judgment**: only later commits made the approval stale, and a request grants nothing.

**Exact rules where a model would drift.** Coverage accepts only merges proved to change nothing unreviewed (by tree, or by GitHub's verification rather than an author field anyone sets). An automated pull request is bounded by its paths at the head read, since the opening account does not prove who pushed. Merging into a base once nothing is based on the branch handles stacks without knowing the chain. Merging when GitHub allows it avoids waiting on checks the rules do not require.

**Waiting costs no model call**, since a waiting session resends its whole conversation at every wake. The watcher, notices, and confinement are `review-until-approve`'s; separate processes keep one skill's failure from stopping the other's.

**Entries expire**, so an authorization does not cover pull requests opened weeks later.

## Rejected alternatives

- **Merging every approved pull request.** It takes the timing from authors who did not ask, and does nothing for the user's unapproved work.
- **Never asking the approver.** Every stale approval becomes a round trip for a request the user nearly always wants.
- **Releasing a hold on a push.** An agent's push would release a teammate's "do not merge".
- **Unconfined sessions with the user's login.** Steered text could merge, approve, or push anywhere.
- **The session restarting the script after every run, or a nightly scheduled wrapper.** The first relies on the model at every exit and pays a full turn per wake; the second needs a job per operating system and a registration to remove.
- **Releasing a hold when a writer resolves the thread.** A resolution has no time, so it would release later comments, and the author can resolve any thread.
- **Holding on every unresolved thread, or on automation accounts' comments.** Automated reviewers comment on most pull requests and never approve; branch rules can enforce their verdict.
- **A session judging whether a point blocks.** A model's judgment would release a merge a counting account's comment holds.

## Residual exposure

- A compromised account with write access can approve and have a pull request merged, or on a base requiring no review push to the user's branch as a human push.
- The push time can fall back to a committer date the commit's maker sets. An item in the approval's second counts as settled. Where an empty review decision is wrong, GitHub still blocks the merge and the script reports it.
- A point left open before the approval does not hold; the `merged` line counts unresolved threads. Any counting account can delay a merge with a comment.
- With `--merge-agent-pushes`, or after the user confirms without looking, an agent's commit merges with no person having read it.
- The check commands run the branch's code with the user's privileges, as running the tests by hand does. Under Claude Code the guard decides which commands run, not what they do; under Codex the profile also confines them, and checks needing the network fail.
- Steered session text can make a wrong edit or a misleading reply; the escaping stops mentions, markers, and commands, not prose.
- Deleting the notice record replays review items to sessions and repeats requests. Two machines watching one repository both start sessions; the second push is refused as not a fast-forward, and replies can be posted twice.
- The daily cap ends a reply loop with an automated reviewer or another watcher after six sessions.
- Anyone who can push branches can make the user's pull request wait (`stack`). Merge-method rulesets are not read; such a merge is refused and reported. A merge through a queue is `queued`, and nothing after it runs.
- The script's approval of an automated head stands until the next check after a push; a body-less approval the user gives by hand there can be withdrawn as the script's; a pin moved within the allowed paths is approved whatever its target.
- Only required checks hold a merge. When `--self` can bypass branch rules, the only guard is not merging while GitHub reports a rule blocking.
- The watch list carries the merge authorization, so any process running as the user can grant it.
- The watcher stops at reboot or logout and is reported only at the next session start or invocation; notifications depend on the system. A tracker's automation can mark a ticket done before the verdict is applied.
