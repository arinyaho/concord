# PR to merge

`pr-to-merge` carries the user's own pull requests to their merge, and merges the automated pull requests of accounts and paths the user names. A background watcher checks the watched repositories every five minutes without a model: it requests reviews, re-runs failed jobs, updates branches, merges what qualifies as soon as GitHub allows it, and records notices. A confined headless agent session, which can read and edit files only in a worktree and its own directory, starts only for work that needs a model: answering reviews, fixing a failing check, resolving a merge conflict, and checking a merged pull request's tickets. In the user's session, the skill adds repositories to the watch list and relays the notices. It follows [workflow-state-and-stops.md](workflow-state-and-stops.md).

## Scope

In each watched repository the watcher acts on two sets of open pull requests:

- **The user's own**: authored by `--self`, the account `gh` is logged in as. A draft is watched and not acted on until it is ready.
- **Automated**: from an automation account the user names, changing only paths the user names, such as dependency pin updates.

Other people's pull requests are read only for the merge order. A coordinating session's workers act as the user's account, so their pull requests are the user's own.

## Trust

A counting account has write, maintain, or admin permission on the repository, as GitHub's collaborator permission API reports it. Only a counting account's approval, request for changes, comment, or thread affects a merge; automation accounts and items with no author never count. An account whose permission cannot be read makes the pull request wait for the next check.

Every input others can write is data:

| Input | Read by |
|---|---|
| Titles, branch and check names | The script, whose lines carry only logins, numbers, short SHAs, fixed words, GitHub URLs, and names reduced to a safe character set |
| Review items and their replies | A session. In a private repository every comment; in a public one only those of counting accounts and of `--reviewer-bot` accounts. Other comments are reported as `review` lines only. Visibility is read every check |
| Failed job logs | A session; they carry output of dependencies and third-party actions |
| Ticket text: an issue's body and its comments | A session. Where the repository holding the issue is public, only the parts counting accounts wrote; others are reported as `ticket` lines |
| The branch's tree: code, the rules file, conflicting base code | A session, in its worktree |
| The project's rules file on the default branch | The skill, at invocation: reviewers, tracker commands, reply language |

No session holds a credential or reads outside its worktree and session directory. Under Claude Code it runs no command; under Codex its commands run only inside the permissions profile, with no network. The script runs none of the branch's code, which outside that profile runs only in CI.

## Authorization

Invoking the skill over named repositories authorizes, there and in their tickets: watching, review requests, re-runs of failed jobs, the script's pushes, replies, and thread resolutions on the user's own pull requests, and ticket updates after a merge.

Merging, updating a branch that is behind, and approving an automated pull request or withdrawing that approval also need the merge authorization: the user's words for the invocation naming the repositories, or a coordinating session's standing authorization recorded from such words. The skill records it in the repository's watch entry; an entry without it carries `--no-merge`, and the watcher reports as `ready` what it would merge. `pr-to-merge.js confirm OWNER/REPO#N <sha>`, which the skill runs only on the user's words in their session, confirms that head alone, the SHA the notice printed, and is the merge authorization for it even when the entry has `--no-merge`; under `--no-merge` it also authorizes updating that branch when it is behind. Any update moves the head and so voids an earlier confirmation. A conflict resolution is pushed under `--no-merge` too: it goes to the user's own branch and merges nothing. Automation accounts, paths, reviewer bots, and `--merge-without-confirm` come only from the user's own words, never from a coordinating session's standing authorization.

An entry and its authorization last until the user removes it or seven days after the user's words that authorized it: the user's own invocation, or for an entry a coordinating session writes, the words its standing authorization records. Only a new invocation by the user renews it; `watch remove` and `watch add` do not. Either removal is recorded as `unwatched`.

Nothing uses an administrator override or bypasses a branch rule. A session holds no credential and cannot reach the git directory, so it cannot commit, push, approve, or merge; the script pushes only fast-forwards of the pull request's own branch.

## The watcher

Concord's per-user state directory holds one notice list shared with `review-until-approve`. `pr-to-merge` has its own directory beside it with the watch list, the notice record, the lock, the session records, worktrees, and directories, and a log. `pr-to-merge.js watch add` writes an entry; `watch remove` deletes one.

| Option | Meaning |
|---|---|
| `OWNER/REPO` or `OWNER/REPO#N` | A whole repository, or pull requests of it. Numbers add to an entry of numbers; a whole repository replaces it. Numbers limit the entry without making a pull request the user's own |
| `--self <login>` | Required: the account `gh` is logged in as; a check finding another records `account` and skips the entry. Its approvals never count, and nothing it posts holds a merge |
| `--automated <account>`, `--automated-path <glob>` | An automation account (`x[bot]` or `app/x` for an app, a plain login for a user) and the paths its pull requests may change. Repeatable; paths are required with an account |
| `--reviewer <login or org/team>` | A reviewer the rules file names. Repeatable |
| `--reviewer-bot <account>` | An automated reviewer whose comments sessions answer in a public repository. Repeatable |
| `--checkout <path>` | A local clone, needed for coverage and sessions. Without it only an approval on the head covers it, and session work is reported |
| `--blocked-label <name>` | The user's hold label, default `blocked`. `review-blocked`, which `review-until-approve` owns, holds too and is not configurable |
| `--merge-without-confirm` | On a base that requires no review, merge the user's own pull request without the user's `confirm` |
| `--no-merge` | No merge, branch update, or automated approval or withdrawal |
| `--harness <claude or codex>`, `--model <name>` | For sessions: the harness the user invoked from, and the model the user asked for |

`watch add` starts the watcher unless the lock names a running one, outside any harness sandbox (a process keeps its sandbox for life), after the probe `review-until-approve` makes (a write in the state directory and a GitHub API read); where the probe fails, it prints the command for the user. The watcher is spawned detached and unreferenced, with nothing registered with the operating system. Every five minutes it runs one check as a child process from the newest installed copy the [state-cli-locator.md](state-cli-locator.md) locator finds. It exits when the watch list is empty, ends at reboot or logout, and runs beside `review-until-approve`'s watcher.

A check reads details only for pull requests of its sets; GitHub's hourly limit covers about fifty. A check short of quota stops and records `rate limited`.

**Notices.** Both skills add their lines to the shared notice list and notify by the same rule: one system notification (Notification Center, `notify-send`, a PowerShell toast) per check that added a line that is not informational, with the count and no pull request text, and one after ten failed checks in a row. The plugin's `SessionStart` hook prints the list's pending lines, and a line for each skill whose watch list is not empty while no watcher runs. A `pr-to-merge` line stays pending until `watch status`, run by the skill in the user's session, shows it; headless sessions load no hooks and run no `watch status`, so they mark nothing shown. Invoking the skill restarts a stopped watcher.

## A check

### Approval and coverage

A pull request is approved when a counting account other than its author and `--self` approved it, requested or not. An approval by `--self`, or whose review body ends with a `<!-- review-until-approve:state … -->` line, which `review-until-approve` writes, never counts, whichever account posted it; a forged line can only remove an approval.

An approval covers the head when it was given on the head, or on an earlier commit followed on the head's first-parent line only by merges that are either a clean merge of the pull request's own base (second parent on the base branch, tree equal to git's conflict-free merge of the parents) or a merge GitHub made for `--self` (verified, committed by GitHub's web flow, authored by `--self`). Without the clone only an approval on the head covers it.

### The user's own pull request

On each of the user's own pull requests that is ready for review, the script:

1. **Requests reviewers** when none is requested, GitHub's timeline shows none ever was, and no counting account has reviewed: the entry's reviewers, recorded as `requested`; with none in the entry, it records `no reviewer`. GitHub requests CODEOWNERS owners itself.
2. **Asks the approver again** when the base requires a review and no counting approval covers the head: it requests a review from the newest counting approver unless already requested, once per head, recorded either way as `stale approval`. An approval later dismissed counts here.
3. **Hands review items to a session** (under Trust for which), each once.
4. **Re-runs a failed required check** once per head (GitHub's run attempt is the record) and hands a second failure to a session; a failed check that is not a workflow job is reported.
5. **Hands a conflict with the base to a session.**

GitHub reports that the base requires no review when the pull request's review decision is empty. There the pull request can merge without an approval once the user confirms its head. Unless the entry has `--merge-without-confirm`, every head waits: when nothing else stops it, the script brings the branch up to date (under `--no-merge` only after a confirmation, as above) and records `confirm <sha>`, and the user confirms or merges by hand. An outstanding review request holds such a pull request for 24 hours from the request, unless the user confirms.

### Holds

An approval or a confirmation settles what came before it. What a counting account other than `--self` adds after the newest covering approval, or on the path without approval after the user's newest confirmation, holds the merge; with neither, everything it added holds. Three things hold:

1. **Later activity**: a thread comment, conversation comment, or non-approving review body newer than that time, by the later of its publish and edit times. It holds until a counting approval is given after it, or on a base that requires no review, with or without `--merge-without-confirm`, the user's confirmation of a head. No push, whoever made it, and no thread resolution releases it.
2. **A request for changes** as a counting account's latest review.
3. **A hold label**: `blocked` (or `--blocked-label`) or `review-blocked`, compared without regard to case. The user holds with `blocked`; `review-until-approve` holds with `review-blocked` while its state records an open or asked blocker or cannot be read, because it usually posts as `--self` too.

Items from before that time do not hold, nor anything an automation account posts, nor the covering approval's own inline comments. On an automated pull request every later-activity item holds. What the user writes, as `--self`, does not hold. Nothing here adds or removes a label.

### Automated pull requests

When no counting approval covers the head, a pull request is automated when its author matches an `--automated` account exactly (an app account only by a Bot login, a user account only by a user login), its head branch is in the repository, and every changed file, including a renamed file's old path, matches an `--automated-path`. The script approves such a head after reading the head again unchanged, and merges in a later check; each new head is approved again. When a head it approved is no longer automated, it dismisses its own approval (a body-less approval by `--self` on a named automation account's pull request) and records `triage`. Failed checks are re-run as on the user's own.

### Qualifying and merging

A pull request qualifies when:

1. a counting approval covers the head, or it is automated and `--self` approved this head, or it is the user's own on a base that requires no review and its head is confirmed or the entry has `--merge-without-confirm`;
2. nothing holds it;
3. no session works on it or was handed work for it in this check;
4. GitHub reports it mergeable with no required check pending or failed;
5. GitHub does not report a branch rule blocking it (recorded as `triage` once per head).

The script approves an automated head when conditions 2 to 4 hold.

- It merges into its own base once no open pull request from the same repository, draft included, is based on its branch; otherwise it records `stack`. A chain merges from its last member down, one level per check. A pull request from the default branch is never a parent. A child neither the user's own nor automated is its author's to merge, and its parent waits.
- The method is a merge commit when the head branch is the default branch or the base is another open pull request's branch, else a squash; when the repository does not allow it, the next allowed of squash, merge commit, and rebase.
- Every merge names the expected head (`--match-head-commit`). `merged` is recorded only when GitHub reports the pull request merged; otherwise `queued`, once.
- A branch GitHub reports as behind its base is updated at once with a merge commit.

After a merge, the watcher follows the runs still going on the merged head and those the merge starts on its base, re-runs a failed job once, and records a second failure as `post-merge failed`. A merge of the user's own pull request goes to a session for the ticket step.

## Notices

Each notice is one line, recorded once per pull request and head (a `review` or `ticket` line once per item) while the notice record holds it. Which lines are informational is defined in [workflow-state-and-stops.md](workflow-state-and-stops.md).

| Line | Meaning |
|---|---|
| `merged`, `queued`, `ready` | Merged, with base, method, head, checks not passed, and threads unresolved; accepted and not reported merged; with `--no-merge`, would merge |
| `requested`, `no reviewer` | Reviewers requested; or none requested and the entry names none |
| `stale approval` | The newest counting approver's login and commit, `asked again` or `already requested`, then the number of commits after it that keep no coverage, `commits after it not read` without the clone, or `not on the head's first-parent line` |
| `confirm <sha>` | Waits for the user to confirm that head (under The user's own pull request) |
| `review`, `ticket` | Review activity or a ticket no session acts on, with who, kind, and link |
| `session … done`, `… question`, `… failed`, `… cap` | A session ended; left a question; failed, timed out, or its push was refused; or the daily cap was reached |
| `triage <repo>#<n> head <sha>: <reason>` | What stops the pull request where nothing handles it, with the head SHA a confirmation names: `held by` (`thread`, `comment`, `label`), `changes requested`, `conflict`, `a branch rule blocks the merge`, `required check still red after one re-run`, `required check failed and cannot be re-run`, `automated approval withdrawn` or `could not be withdrawn`, `behind its base` |
| `approved`, `rerun`, `synced`, `stack … #<m>`, `post-merge failed` | Automated approval; failed jobs re-run; branch updated; qualifies but `#<m>` is based on its branch; a run of the merge failed again, with its link |
| `merge failed`, `sync failed`, `request failed`, `post failed` | GitHub refused, with the HTTP status; the message goes to the log |
| `closed`, `account`, `unwatched`, `rate limited` | A named pull request closed unmerged; another `gh` account; an entry removed or expired; quota exhausted |

The notice record is also action state: it decides which review items went to a session and which approvers were asked again. A session's input includes replies already posted.

## Headless sessions

**Launch.** The script checks out the pull request's head into a worktree under its session-worktree root in the state directory, never the user's checkout. The worktree has no `.git`: its git directory, fetched from the clone and holding the configuration, is the script's own and out of the session's reach. Every git command for it names both (`--git-dir=<own> --work-tree=<worktree>`) and runs with `-c core.hooksPath=<empty directory>` and `-c core.fsmonitor=false`, so nothing from the branch runs on either harness. Each session also has a session directory holding its inputs and its result file. The session starts with `review-until-approve`'s agent switches, except: the working directory is the worktree; under Claude Code the tools are `Read,Grep,Glob,Edit,Write` with [explain-pr.md](explain-pr.md)'s writable-worktree mode, confined to the worktree and session directory; under Codex the session keeps the shell, and the permissions profile allows reads and writes only in those two directories, with no network and the home and git directory unreadable, the hook denying patches outside them and MCP tools. No Codex session starts unless a pre-flight under the profile finds the home unreadable and the network refused. No token is passed; what nothing allows is refused, never prompted, and a session that cannot proceed fails. The mode file is removed when the session ends. The prompt carries this skill's session instructions and the paths, and marks the inputs as data.

**Input and result.** The script writes the inputs into the session directory: the review items with their replies, the failed job's log, the conflicting merge (the script starts `git merge` of the base, leaving the conflict in the worktree), or the closed issues' bodies and comments that Trust admits. The session edits files and writes the result file: per item a reply and whether to resolve the thread, questions with options and a recommendation, unfixed minor points, and per ticket a verdict. The script ignores what names no input item, commits with the git options above and a message from a fixed template and the item keys, never agent text (a conflict also needs no markers left), pushes as a fast-forward of the head it started from, then posts the replies escaped as `review-until-approve` publishes agent text, adding the mention itself, resolves the marked threads of automated reviewers, and asks each person who reviewed to review again, once per head. For a GitHub issue it closes a ticket whose criteria are met, or reopens one with a comment naming the unmet criterion; a ticket in another tracker is left in the report for the skill.

**Limits.** One session runs at a time. Each has 30 minutes and a result file of at most 1 MiB; past either it is stopped and fails. The session record holds its process id and start time; a watcher that finds a recorded session from a previous watcher stops it if still running, and removes worktrees of sessions not running. At most six sessions run per pull request in 24 hours, counted in the session records; past that the watcher records `session … cap` and starts none for it until the user invokes the skill. A failed session's work is not handed over again. CI on the pushed head is the check: a failure there is a new event, within the cap.

**Work.**

- **Answering a review.** Verify each item against the code, fix what is right, and reply in at most two lines (verdict, reason or change), with file and line for a disagreement. An automated reviewer gets English and its thread marked for resolution; a person gets their language and keeps their thread. Review-body points get one conversation comment; a body called out of date is rewritten; unfixed minor points are listed, with no ticket filed.
- **Fixing a failing check.** Read the log and fix the cause. A failure outside the change (a download, a registry, a runner, a timeout) goes in the report.
- **Resolving a conflict.** Resolve the files. A conflict of intent rather than text goes in the report unpushed. The merge is not clean, so it loses coverage and the approver is asked again.
- **After a merge.** For each ticket, a verdict: done when every acceptance criterion is met with evidence, otherwise in progress with the unmet criterion.

A product decision, or anything else only the user can settle, goes in the result's questions; the session handles the rest.

## The skill

On invocation, the skill reads the rules file on the default branch (reviewers, tracker commands, reply language), takes the merge authorization from the user's words or passes `--no-merge`, runs `watch add` per repository and `watch status`, and relays each notice as one line with a link. It puts a session's question to the user and acts on the answer; does itself the work of a failed session, a ticket in another tracker, or a repository without a clone; offers `confirm` with the printed SHA, running it only on the user's words; and runs `watch remove` on the user's stop.

## Why

**The user's pull requests are the user's to drive**; another author's waits on that author's decisions.

**Trust follows the authority to merge.** A counting account could merge the pull request itself; membership does not imply write access, so the permission API is read.

**An approval settles what came before it, and only a person releases a hold.** The approver saw that moment's threads; only later additions are unseen. A push never releases a hold, because no one can tell from GitHub which pushes a person made. Without an approval, the user's confirmation of a head takes the approval's place.

**A head waits for the user on a base that requires no review.** There the user is the only person between an agent's commit and the base, and any head may carry one, so by default the user looks at the head that merges; `--merge-without-confirm` is for repositories where that is not wanted. The cost is one confirmation per merge, also for heads the user pushed; telling agent pushes apart instead would need a mark every agent writes, which nothing enforces. An outstanding review request means the user wanted a reviewer, so it holds for a day.

**A session edits and the script acts.** A session reads text anyone can write, so it gets no credential, no git directory, no network, and under Claude Code no command. The script's git commands load no hook or configuration from the branch, so a steered edit to a test, build, or hook file runs only in CI or inside the Codex profile, and the worst outcome is a wrong edit that CI, the user, or reviewers see before a merge.

**Outsiders' comments reach a session only in a private repository**, where every commenter has access; in a public one only counting accounts and named reviewer bots do.

**Asking the approver again is the next step, not a judgment**: only later commits made the approval stale, and a request grants nothing.

**Exact rules where a model would drift.** Coverage accepts only merges proved to change nothing unreviewed, by tree or GitHub's verification. Paths bound an automated pull request, since the opening account does not prove who pushed. Merging once nothing is based on the branch handles stacks.

**Waiting costs no model call**; a waiting session resends its conversation at every wake. The watcher, notices, and confinement follow `review-until-approve`; separate processes isolate failures.

**Entries expire**, so an authorization does not cover later work.

## Rejected alternatives

- **Merging every approved pull request.** It takes the timing from authors who did not ask, and does nothing for the user's unapproved work.
- **Never asking the approver.** Each stale approval costs the user a round trip.
- **Releasing a hold on a push.** An agent's push would release a teammate's "do not merge".
- **Sessions that run commands or checks.** Steered text could run anything as the user, through a test file as easily as a shell.
- **Restarting the script from the session, or a nightly wrapper.** A full model turn per wake; a job per operating system.
- **Releasing a hold when a thread is resolved.** A resolution has no time, and the author can resolve any thread.
- **A session judging whether a point blocks.** A model's judgment would release a merge a counting account's comment holds.

## Residual exposure

- A compromised account with write access can approve and have a pull request merged, or with `--merge-without-confirm` push to the user's branch and have it merged.
- An item in the approval's or confirmation's second counts as settled. Where an empty review decision is wrong, GitHub still blocks the merge and the script reports it.
- A point left open before the approval does not hold. Any counting account can delay a merge with a comment.
- With `--merge-without-confirm`, or after the user confirms without looking, an agent's commit merges with no person having read it.
- A session's edit is first tested by CI after the push. Under Codex a session can run the branch's code inside the profile. The worktree's instruction files load as untrusted text.
- Steered text can make a wrong edit or a misleading reply; escaping stops only mentions, markers, and commands.
- Deleting the notice record replays review items to sessions and repeats requests; deleting the session records resets the daily cap. Two machines watching one repository both start sessions; the second push is refused, and replies can be posted twice. A reply loop with an automated reviewer stops at the daily cap.
- Anyone who can push branches can make the user's pull request wait (`stack`). Merge-method rulesets are not read; such a merge is refused and reported. A merge through a queue is `queued`, and nothing after it runs.
- The script's approval of an automated head stands until the next check after a push; the user's own body-less approval there can be withdrawn as the script's; a pin moved within the allowed paths is approved whatever its target.
- Only required checks hold a merge. When `--self` can bypass branch rules, the only guard is not merging while GitHub reports a rule blocking.
- Any process running as the user can edit the watch list and so grant the merge authorization.
- The watcher stops at reboot or logout, reported only at the next session start or invocation. A tracker's automation can mark a ticket done before the verdict is applied.
