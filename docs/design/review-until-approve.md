# review-until-approve

`review-until-approve` reviews a pull request the user did not write. Each round, a confined reviewer finds defects, a confined verifier tries to refute them, and the script publishes what survives as one GitHub review. It waits for the author, reviews what changed, and approves the reviewed head once nothing blocks. It never requests changes, merges, or pushes. It follows [workflow-state-and-stops.md](workflow-state-and-stops.md) and [independent-review.md](independent-review.md), adapted to an untrusted target.

The decisions:

- **State lives on the pull request.** Markers in the skill's own reviews and comments hold every finding and its status. A new session, another machine, or a reinstalled plugin resumes from the pull request alone.
- **Every pull request is untrusted.** The reviewer and the verifier can read only the round's directory and write only their own output file. No session that holds the user's credentials reads the pull request's content.
- **Waiting costs no model call.** A detached background watcher checks the pull requests every five minutes with `gh` and runs a round only when something happened.
- **The user's view is an input.** The user's notes, kept private to the reviewing account, go to both agents. What the code settles is handled with a quote from the code as evidence; what turns on judgment goes to the user. Only the user waives a finding or changes its class.
- **The skill approves when nothing blocks**, and changes nothing outside the pull request's reviews, its own threads, the comments recording the user's decisions, and its own `review-blocked` label.

Invoking the skill on a pull request authorizes every review it posts there, the approval included, the changes to `review-blocked`, and starting the watcher.

## Roles

- **The user's session** runs the scripts, relays their output (counts, keys, hashes, links, a fixed vocabulary), saves the notes and posts the decisions the user gives in their own words, and asks the questions the scripts report. It never reads the pull request's content, the round directory, or the agents' files; the user reads findings on the pull request.
- **The round script** runs a round without a model: it prepares the round directory, runs the two agents in turn, checks the verifier's list, and publishes.
- **The reviewer** reads the request and the files it names, in a fresh context, and writes the result file.
- **The verifier** then reads the request, the result file, and the checkout, refutes what it can, and writes the verified list.

The agents are `claude -p` or `codex exec` processes, matching the harness the user invoked from, with the model and effort the user asked for. Only their output files are read, never their final messages. The skill acts as the account `gh` is logged in as, which must not be the author.

## Confinement

No statement by the user lifts these limits. Each agent reads only its round's directory (the verifier also the result file), writes only its own output file, which does not exist when it starts, in an owner-only output directory created for that agent just before it starts (Claude Code's `Write` tool refuses to replace a file the session has not read, and a new directory that only this agent can write in means no file another agent left can be taken for its output), has no network, home directory, or GitHub token, and leaves no session behind. The round directory is a fresh owner-only directory among `explain-pr`'s prepared pull requests. Agents are processes, not subagents, because the mode is keyed by session id and a subagent shares its parent's.

| Harness | How the limits are enforced |
|---|---|
| Claude Code | `claude -p` in an empty working directory outside the round directory, with a session id the script chooses and these switches: `--setting-sources` with no source (no user allow rules, hooks, or plugins load); `--settings` registering only the read-only hook; `--permission-mode dontAsk` and `--permission-prompts none` (whatever nothing allows is refused, never prompted); `--tools Read,Grep,Glob,Write`; `--strict-mcp-config` with no servers; `--no-session-persistence`. Without the hook the agent writes nothing, and its round is discarded. The script's `explain-pr` mode file for the session id names the round directory, the output file, and a canary path. The hook denies everything until it has denied and logged the agent's first call, a read of the canary path; then it explicitly allows reads in the round directory and the one write. A round whose log lacks the canary denial is discarded |
| Codex | `codex exec --ephemeral` (no session files kept) with the launch switches of `explain-pr`'s reading session, the round directory as working directory, and writes allowed only in an output directory that holds the one output file, which the agent writes with a shell command (the Codex hook denies patches). The permissions profile is the boundary and the hook a second line. Before starting the agent, the script runs a listing of the user's home under the same profile, without a model, and starts no agent unless it is refused |

Nothing from the pull request is executed. The checkout is the head's tree as `explain-pr` prepares it (no `.git`, symlinks, or submodules). It is never a working directory, so its settings and hooks do not load; an instruction file inside it (`CLAUDE.md`) can still be loaded by Claude Code when the agent reads files beside it, and is untrusted text like the rest. Diffs are made in the script's own clone with external diff drivers and text conversion off.

## State on the pull request

The skill keeps no ledger. Markers are HTML comments starting `review-until-approve:`, with data in base64url JSON so no text inside can close them.

| Where | Marker | Carries |
|---|---|---|
| Last line of each review | `…:state` | Round, whether agents ran, reviewed head, diff base, description hash, keyed hash of the notes used, language, submodule decisions, and every finding's key, class (`blocker`, `minor`), status, file, line, and raising and closing heads |
| First line of a finding thread | `…:finding <key>` | The key |
| First line of a reply | `…:reply <key> <status> <head>` | So each reply is posted once |
| First line of a decision comment | `…:decision` | Key and decision, or the user's ruling on unreadable state; the text gives the reason |

A key is `<round>.<index>`. Statuses: `open`; `fixed` (the verifier confirmed the defect is gone at the closing head); `answered` (a reply proves the finding wrong, shown by a quote from the head); `asked` (waits for the user); `waived` (by the user).

- **Reading.** The account's newest state review, and its later decisions in order, plus the live threads, comments, head, description, draft status, and whether the account approved the head (a dismissed approval counts).
- **Whose comments count.** Only the reviewing account's, with the marker at its fixed position. Two accounts have separate states.
- **Pending.** A head that is not the reviewed head; a reply, newer than the state review, from the author or an account with write access, in a finding thread or the conversation; a description whose hash changed; notes whose keyed hash differs from the state's.
- **Edits.** The skill never edits what it posted. A counting item GitHub reports as edited, an unparsable state, or a decision naming an unknown key makes the state unreadable. The skill then carries forward the newest unedited state review and decisions (or, with none, runs a broad round), approves nothing, and keeps `review-blocked` on until the user rules with `decide`: continue, or start over. A deleted finding comment loses only its thread; the finding stays in the state.

## The user's notes

The notes are the user's view ("approach X is fine", worries, what not to flag), given in the user's own session at any time. The session writes them from the user's words alone; `notes` saves the complete set and is their only writer. Agents read them in the requests as the user's instruction, apart from the round's data, and cannot write them. Changed notes are pending and start a broad round.

**Where they are kept.** In one of two stores; neither is a default. The first time notes are stored with no store configured, the session asks: a secret gist (no setup) or a private repository the user owns. The answer is recorded as `notes.store` (`gist` or `repo: OWNER/NAME`) and can be changed later. No round runs with notes that are not in a store: while notes exist only in the local cache (no store chosen, or the store not usable), rounds wait and the user is asked to choose or fix a store.

A machine whose state shows notes it does not hold (a keyed hash, and no store configured or no notes in it) looks for a notes gist by its description; failing that, it asks the user for the store before any round. It never runs a round without the notes, and if neither works it runs nothing.

- **Gist.** A secret gist of the reviewing account per pull request, described `concord review notes: OWNER/REPO#N`, found on any machine by listing the account's gists; of two, the newest is used and the duplicate reported. It needs the `gist` scope, which `gh auth login` grants by default; without it the script says so, and rounds wait as above. Notes outlive the pull request until the user deletes them.
- **Private repository.** The file `OWNER/REPO/N.md` in the chosen repository, written through the contents API. Before every read and write the script checks that the repository's owner is the reviewing account, its visibility is `private` (not `internal`), and it has no collaborator but the owner; it refuses one that fails, and never creates one.

The state marker holds a keyed hash of the notes, never a plain one, so the notes cannot be guessed from it; the key always lives in the store with the notes. With either store, the copy in the per-user state directory is a cache only, and a round on another machine reads the same notes as it reads the same state.

**The location is never written anywhere else**: not in a review, comment, marker, log, or script output. A secret gist is unlisted, unsearchable, and has a random id, so this rule is its protection; no review or reply quotes the notes either.

The verifier weighs each finding against the notes:

| The finding | Outcome |
|---|---|
| Minor, and under a note that says not to flag it | Not published; the body gives the count |
| Conflicts with a note, and a span quoted from the head settles which side holds | Published with the quote if the finding holds; listed with the quote under "Set aside by the reviewer's notes" if the note holds |
| Conflicts with a note on judgment (trade-off, priority, anything the code cannot show) | Published as `asked` under "For the reviewer to decide" |

A blocker is never set aside by a "do not flag" note; that conflict is judgment.

## Author replies

For each open finding with a pending reply, the verifier gives one verdict: `fixed`; `answered`, quoting the head; `open` with the quote that refutes the reply's claim ("handled in X" where X does not handle it); `asked`, when the dispute is judgment; or `open`. An `asked` finding stays so until the user decides or a round finds it fixed. A finding the user has decided on is closed only by the user or by `fixed`.

**Every claim that the code settles something needs a quoted span that occurs at the head; without one it becomes `asked`.**

## Asking the user

The questions: an `asked` finding, unreadable state, an unreviewed submodule, an agent that cannot start, a hook that did not run, notes not found or a store not usable, the daily cap, and a `gh` account other than the entry's. In a session, the script prints a fixed line with keys and a link and the session asks. The watcher adds the line to Concord's shared notice list, which the plugin's `SessionStart` hook prints until it is answered, and sends system notifications (Notification Center, `notify-send`, a PowerShell toast) by the rule [workflow-state-and-stops.md](workflow-state-and-stops.md) gives for both watchers. Neither carries pull request text.

The user reads the finding on the pull request and answers in a session. `decide` takes, from its command line only, either a key with a decision (keep, waive, `blocker`, `minor`) or the ruling on unreadable state (continue or start over), and the reason. It posts the decision, approves when the condition holds, and sets the label.

## Text the skill posts

`publish` writes the markers and composes lines from keys, classes, counts, and links. Agent text and the user's reasons are escaped: `<` becomes `&lt;`, `@` becomes `＠`, and every line is prefixed with `> `. File paths and quoted spans are not escaped but placed only in fenced code blocks, longer than any backtick run inside, where GitHub shows them literally and neither mentions nor HTML act; a path with a line break is not posted. The text outside fences is scanned: an HTML comment other than the skill's markers, or a line starting with `/`, `@`, or a bot command word (`bors`, `atlantis`, `r+`, `retest`, `ok-to-test`, `lgtm`, in any case), stops the review from being published, and so does the GitHub token or a token from the harness's credentials file anywhere in it.

## The round

A round runs when the pull request has none yet, when the watcher sees an event, and when the user invokes the skill while something is pending. A failed round posts nothing, so what was pending stays pending. At most six rounds run per pull request in 24 hours. The cap counts rounds that ran an agent: published ones from the state reviews, whose marker records that agents ran, and failed ones from a local counter per pull request in the notice record. Base-merge carry-forwards, `ready` publishes, and `decide` approvals do not count. Past the cap the watcher asks the user and runs none until the user invokes the skill.

1. **Lock.** A lock file per pull request and account, created exclusively, records the holder's process id and start time. It is taken over only from a holder that is not running; otherwise the round prints `locked`. Each agent has 30 minutes and an output file of at most 1 MiB; an agent past either is stopped and treated as a malformed output, so no round holds the lock or the watcher longer than four agent runs.
2. **Inputs.** The checkout, the diff, the description, CI results, prior findings with replies and thread state, and the starting state review; for a private repository only, also closing tickets and the related repositories the project's rules list, of the same owner (otherwise cross-repository consistency is Unverified). The base is the last reviewed head when it is an ancestor of the live head, the merge base is unchanged, and the description and notes are unchanged; otherwise the merge base.
3. **Requests.** Skill text with paths and notes filled in. The reviewer's follows `independent-review.md` (the diff, the description and tickets to satisfy, CI as evidence, no command can run) and asks for verdicts on prior findings. Both mark the round directory as untrusted data and the notes as the user's.
4. **Review.** Findings (severity, file, line, verbatim quote, reason, evidence), prior verdicts, Unverified, Covered. A round started only by thread replies asks only about those findings.
5. **Verification.** Each candidate is kept or rejected and weighed against the notes. A kept one gets a class (`blocker` for a holding `blocker` or `should-fix`, else `minor`), a verbatim span, and its text, with the reason when the class differs from the reviewer's severity. Each open finding gets a verdict and reply text; a closed finding raised again and confirmed reopens.
6. **Checks.** The list must parse; prior keys must exist; every span must occur at the head; the text must pass the scan. A failing list is not published. A kept finding whose span is missing goes in the body.
7. **Publishing.** Findings whose span lies in a diff hunk become line comments; the rest go in the body with file and line. The body lists new findings by class, "For the reviewer to decide", "Fixed", "Answered", and "Still open" by key with thread links, "Set aside by the reviewer's notes", Unverified, and the state marker. If the account has a state review newer than the round's start, nothing is posted (`superseded`); otherwise the whole review goes in one call pinned to the reviewed head, with line comments moved into the body once on a position error. Then replies are posted (marker-checked), fixed and answered threads resolved, reopened ones unresolved, and `review-blocked` kept on exactly while approval is blocked by a finding or unreadable state. GitHub refusals are reported, not retried.
8. **Approval.** The review is `APPROVE` exactly when the live head is the reviewed head, the pull request is open and not a draft, the account is not the author, no blocker is `open` or `asked`, no unreadable state awaits the user's ruling, every submodule change has a user decision, and the account has not approved this head. Otherwise it is `COMMENT`. Open minors are listed as follow-ups. CI is evidence, not a condition.

The round removes the mode files and the round directory, then frees the lock.

**Base merges.** When the last reviewed head is an ancestor of the live head, nothing else is pending, and the pull request diff has the same `git patch-id --verbatim`, no agent runs. A review carries the state forward and approves under the same condition.

**Submodules.** A changed gitlink is listed as unreviewed, blocks approval, and is asked about; a yes is recorded as a decision.

**Size.** When a review body would exceed GitHub's 65,536-character limit, the prose sections shrink to keys and counts first; then `fixed` and `answered` findings closed before the previous round, without a user decision, leave the state marker, and a later re-raise of one is a new finding. `waived` findings and every finding with a user decision stay. If the body is still over the limit, the review is a `COMMENT` naming the overflow, it never approves, and the user is asked.

**Language.** A language the user asks for is kept in the state marker; markers, keys, paths, and code are never translated.

## Approvals and `pr-to-merge`

`pr-to-merge` counts no approval carrying this skill's state marker, so a person must still approve. It holds a pull request labeled `blocked` or `review-blocked`; only this skill sets `review-blocked`, so its blocker holds even when posted as `pr-to-merge`'s own account.

## Waiting

**Watch list.** Invoking the skill adds the pull request to the watch list in this skill's own directory under Concord's per-user state directory, with the account, harness, model, and effort; an entry is what lets the watcher run rounds, approval included, without the user present, as the invocation authorized. The user's stop removes it, posting nothing, and a merged or closed pull request is removed.

**The watcher.** Invoking the skill starts the watcher unless one is running, and only outside any harness sandbox, since a process inherits its sandbox for life. Before starting it, the script probes: it writes a file in the per-user state directory and reads the GitHub API. If either fails, it starts nothing and the session prints the command for the user to run in a terminal. A lock file with its process id and start time decides whether one runs. Node's `child_process.spawn` (`detached: true`, `stdio: 'ignore'`, `windowsHide: true`) and `unref()` let it outlive the session and terminal; nothing is registered with the operating system. Every five minutes it runs a check; each check and round runs from the newest installed copy the [state-cli-locator.md](state-cli-locator.md) locator finds. It exits when the list is empty, pauses in sleep, and ends at reboot or logout.

**A check** reads each listed pull request as `state` does. Then:

| Event | When | Action |
|---|---|---|
| head, reply, description, notes | Pending, and the head and replies unchanged for one check interval (five minutes) | Run a round, within the daily cap |
| ready | A clean review withheld approval only because of draft status, the pull request is ready, and the head is unchanged | Publish with no findings, approving under the condition |
| merged, closed | The pull request reached that state | Notify, remove from the list |
| account | `gh` is logged in as another account | Notify, skip |
| cap | A seventh round would start within 24 hours | Ask the user, run nothing |
| label | `review-blocked` is missing while the state requires it | Add it back |
| error | Ten failed checks in a row | Notify |

Rounds run one after another; questions, approvals, and failed rounds are notified as under Asking the user. A notice record keeps the previous check's view, the last check's time, the failed-round counter, and the state at which a round failed, which the watcher does not retry until something changes (an invocation retries at once). Deleting it at most delays a check, repeats a round, or resets the failed-round count.

**Visibility.** `watch status` prints whether the watcher runs and when it last checked; every invocation prints it. The plugin's `SessionStart` hook prints one line when the watch list is not empty and no watcher is running (no lock, or a lock whose process is gone). Invoking the skill restarts it.

## Failure

Only the three stop cases need the user.

| Case | Behavior |
|---|---|
| An agent cannot start, the hook did not run, or the Codex home listing was not refused | Nothing posted; the user is asked |
| An agent's output is missing, malformed, too large, or late, or the list fails a check | That agent runs once more; then the round fails with a fixed reason and counts against the daily cap |
| The submission call errors | A review carrying this round's number and head counts as posted; otherwise submit once more after the same read |
| A reply fails after submission | The next round posts it |
| The head moves during the round | `COMMENT` for the reviewed head; the new head is pending |
| The account cannot read the pull request | The user is asked which account to use; the skill never picks one |

## What is code

`review-until-approve.js` with the verbs `state`, `notes`, `round` (prepare, agents, `publish`), `decide`, and `watch` (`add`, `remove`, `status`, the watcher loop), plus the `explain-pr` read-only hook. Scripts need Node, `gh`, `git`, and the harness's CLI, and print one JSON line per event in the fixed vocabulary, never pull request or agent text or the round directory's path; raw errors go to a log no session reads. The requests, how to verify, weigh, and word findings, and when to ask are skill text.

## Why

- **The pull request is the record people already read.** A local ledger is a second copy whose disagreements become stops with nothing to decide. A review cannot be deleted, so the state each one carries needs no history, and detected edits fail safe.
- **Any pull request may be hostile**, and a claim that one is safe could come from an injected model. The verifier reads where steering text sits, so it is confined too.
- **A process per agent** reuses the read-only mode unchanged, lets an invocation's round run beside the watcher's on another pull request, needs no orchestrating model, and keeps agents' final messages from every session.
- **Notes are private to the reviewer** because they are the user's view, not a message to the author; the user chooses between a gist, which needs no setup, and a private repository, which protects by access control rather than by an unguessable URL. Asking once avoids storing anything remote the user did not choose.
- **The code settles what it can; the user settles judgment.** The quoted span turns "settled" into a script check. Held findings are published so the question sits with the findings.
- **A detached watcher** costs no model call while waiting (a woken session resends its whole conversation) and leaves nothing registered with the operating system.
- **Fixed marker positions and escaping** keep agent text from forging state or acting as the user; **one call after a fresh read** publishes each review whole and once; **private material** is read only where its audience matches.
- **A push alone is an event**, since waiting for a reply needs reminders; **a base merge is not re-reviewed**, since an equal patch id proves the change is the same; **a round whose head moved is still published**, since discarding can repeat without end.

## Rejected alternatives

- **The operating system's scheduler** (launchd, systemd or cron, Task Scheduler). It survives a reboot, but needs a different job per operating system and a registration the user must remove.
- **Waiting in the user's session, or only on invocation.** A full session turn per wait window, or a push left unreviewed until the user remembers.
- **Agents as subagents, confined by agent type.** The hook cannot tell rounds apart (one round per machine), relies on the hook naming the agent type, and needs an orchestrating session that reads the agents' messages.
- **A model session orchestrating rounds, or verifying itself.** A turn per event, and the pull request's text before an unconfined session.
- **A local ledger or cache; a label or the body as state; replaying markers; markers anywhere; a pending review as a claim.** A second copy with authority; no room, or the author's text; a deleted comment drops a finding; agent text writes state; a draft the user can submit by accident.
- **Notes as a pull request comment.** GitHub has no private comments, so the author would read them.
- **Notes kept only locally, or in a synced folder.** Local notes are lost when the user moves machines; a synced folder needs a service the user may not have and the script cannot check.
- **A held finding kept off the pull request; notes always winning; the skill deciding judgment.** A second place to read; findings the code proves dropped; the user overridden.
- **A trust declaration, or an unconfined reviewer running tests.** The pull request's code runs near the user's credentials.
- **More roles; closing on a vanished quote; fetching submodule ranges; a total round limit.** Same work in more runs; wrong on unrelated edits; URL and audience checks for a rare case; an arbitrary stop, where the daily cap only asks.

## Residual exposure

- Text that steers both agents can get a pull request approved. The span check bounds what is quoted, not the conclusion; the threads are the record, and `pr-to-merge` does not merge on this approval.
- Escaping stops markers, mentions, and line-start commands, not misleading prose or links. Anyone who learns a notes gist's URL can read it; a private repository store avoids that. A "Set aside" list tells the author that notes exist, not what they say.
- Two agent runs per event; one reviewer misses what a second would find; rejected findings are not published; runtime claims rest on reading and CI.
- Public pull requests are not checked against related repositories; on private ones, same-owner material can reach readers the pull request lacks.
- That the user's session never reads the pull request's content rests on the skill text: nothing confines that session, and its tools could read the round directory or the pull request.
- Claude Code: the hook grants every read; without it the agent reads and writes nothing, and the canary log shows whether it ran. An extension that approves denied calls overrides it. `--setting-sources` with no source still loads Claude Code's built-in plugins; they are part of the harness, not the user's configuration, and register no hook that runs. Codex: `explain-pr`'s launch limits apply.
- Two machines watching one pull request both run agents and can both post within a few seconds. An author who pushes all day reaches the daily cap and waits for the user; one who pushes more often than every five minutes delays the round until they stop. A failed round costs up to four agent runs of 30 minutes each; failed rounds count against the cap only through a local counter, which deleting the notice record resets.
- An account without write access cannot resolve threads or set the label. Anyone with write access can edit the skill's comments or remove `review-blocked`; anyone posting as the account can write markers.
- A push just before submission leaves the approval on the reviewed head.
- Platforms: the Codex profile is verified only on macOS; its `/tmp` and `/var/tmp` denials mean nothing on Windows, where a Node file mode does not make a directory owner-only and the round directory relies on the user profile's permissions; a head whose file names Windows cannot represent cannot be prepared there, and the round fails. A watcher started inside a sandbox keeps that sandbox, which is why the skill starts it outside one.
- The watcher stops at reboot or logout, is reported only at the next session start or invocation, and reads as the account `gh` is logged in as. Notifications depend on the system.

## Related documents

[workflow-state-and-stops.md](workflow-state-and-stops.md), [independent-review.md](independent-review.md), [explain-pr.md](explain-pr.md) (the read-only mode and launch switches), [pr-to-merge.md](pr-to-merge.md) (approvals and `review-blocked`), [state-cli-locator.md](state-cli-locator.md), [windows-support.md](windows-support.md). [review-artifact-contract.md](review-artifact-contract.md) describes the multi-role runner this design replaces; it is removed with the implementation.
