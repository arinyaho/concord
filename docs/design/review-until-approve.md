# review-until-approve

`review-until-approve` reviews a pull request the user did not write. Each round, a confined reviewer finds defects and a confined verifier tries to refute them; the script publishes what survives as one GitHub review. The skill then waits for the author to push or reply, reviews what changed, and approves the reviewed head once nothing blocks. It never requests changes, merges, or pushes. It follows [workflow-state-and-stops.md](workflow-state-and-stops.md) and uses the review request and result of [independent-review.md](independent-review.md), adapted to an untrusted target.

The decisions:

- **State lives on the pull request.** Markers in the skill's own reviews and comments hold every finding and its status. A new session, another machine, or a reinstalled plugin resumes from the pull request alone.
- **Every pull request is untrusted.** The reviewer and the verifier can read only the round's directory and write only their own output file. No session that holds the user's credentials reads the pull request's content.
- **Waiting costs no model call.** A detached background watcher checks the pull requests every five minutes with `gh` and runs a round only when something happened.
- **The user's view is an input.** The user's notes go to both agents. What the code settles is handled with a quote from the code as evidence; what turns on judgment goes to the user. Only the user waives a finding or changes its class.
- **The skill approves when nothing blocks**, and changes nothing outside the pull request's reviews, its own threads, the comments recording the user's notes and decisions, and its own `review-blocked` label.

Invoking the skill on a pull request authorizes every review it posts there, the approval included, the changes to `review-blocked`, and starting the watcher.

## Roles

- **The user's session** runs the scripts, relays their output (counts, keys, hashes, links, a fixed vocabulary), posts the notes and decisions the user gives in their own words, and asks the questions the scripts report. It never reads the pull request's content, the round directory, or the agents' files; the user reads findings on the pull request.
- **The round script** runs a round without a model: it prepares the round directory, runs the two agents in turn, checks the verifier's list, and publishes.
- **The reviewer** reads the request and the files it names, in a fresh context, and writes the result file.
- **The verifier** then reads the request, the result file, and the checkout, refutes what it can, and writes the verified list.

The agents are `claude -p` or `codex exec` processes, matching the harness the user invoked from, with the model and effort the user asked for. Only their output files are read, never their final messages. The skill acts as the account `gh` is logged in as, which must not be the author.

## Confinement

No statement by the user lifts these limits. Each agent reads only its round's directory (for the verifier, including the result file) and writes only its own output file, created empty just before it starts; it has no network, home directory, or GitHub token. The round directory is a fresh owner-only directory among the prepared pull requests of [explain-pr.md](explain-pr.md). The agents are separate processes, not subagents, because the read-only mode is keyed by session id and a subagent shares its parent's, which must stay free to run the scripts.

| Harness | How the limits are enforced |
|---|---|
| Claude Code | `claude -p` with a session id the script chooses, built-in tools limited to `Read`, `Grep`, `Glob`, `Write`, and no MCP server. The script first writes an `explain-pr` read-only mode file for that id naming the round directory and the output file. The hook explicitly allows reads inside the directory and the one write, so no prompt is waited on, denies everything else, and logs each decision beside the mode file. A round whose log has no entry for an agent is discarded |
| Codex | `codex exec` with the launch switches of `explain-pr`'s reading session, the round directory in place of the prepared one, and writes only in the agent's output directory. The plugin's Codex hook is a second line. Before reading the pull request, the agent records whether listing the user's home was refused; a round where it was not is discarded |

Nothing from the pull request is executed. The checkout is the head's tree as `explain-pr` prepares it (no `.git`, symlinks, or submodules), in a subdirectory of the agent's working directory so its settings and agent instructions do not load. Diffs are made in the script's own clone with external diff drivers and text conversion off.

## State on the pull request

The skill keeps no ledger. Markers are HTML comments starting `review-until-approve:`, with data in base64url JSON so no text inside can close them.

| Where | Marker | Carries |
|---|---|---|
| Last line of each review | `…:state` | Round, reviewed head, diff base, description hash, notes used, language, submodule decisions, and every finding's key, class (`blocker`, `minor`), status, file, line, and raising and closing heads |
| First line of a finding thread | `…:finding <key>` | The key |
| First line of a reply | `…:reply <key> <status> <head>` | So each reply is posted once |
| First line of a notes comment | `…:notes` | Hash of the notes that follow |
| First line of a decision comment | `…:decision` | Key and decision; the text gives the reason |

A key is `<round>.<index>`. Statuses: `open`; `fixed` (the verifier confirmed the defect is gone at the closing head); `answered` (a reply proves the finding wrong, shown by a quote from the head); `asked` (waits for the user); `waived` (by the user).

- **Reading.** The account's newest state review, its later decisions in order, and its newest notes comment, plus the live threads, comments, head, description, draft status, and whether the account approved the head (a dismissed approval counts).
- **Whose comments count.** Only the reviewing account's, with the marker at its fixed position. Two accounts have separate states.
- **Pending.** A head that is not the reviewed head; a reply, newer than the state review, from the author or an account with write access, in a finding thread or the conversation; a description whose hash changed; notes newer than those the state names.
- **Edits.** The skill never edits what it posted. A counting item GitHub reports as edited, an unparsable state, or a decision naming an unknown key makes the state unreadable: nothing is approved, and the next round is broad with no prior findings and says so. An edited notes comment stops rounds until the user gives the notes again. A deleted finding comment loses only its thread; the finding stays in the state.

## The user's notes

Where the notes are stored is open; this section describes them as stored on the pull request.

The notes are the user's view ("approach X is fine", what worries them, what not to flag), given at invocation or later in the user's own session. The session writes them from the user's words alone and posts the exact text with `notes` only after the user agrees; each notes comment holds the complete set. Both requests carry them as the user's instruction, apart from the round's data. Changed notes are pending and start a broad round.

The verifier weighs each finding against the notes:

| The finding | Outcome |
|---|---|
| Minor, and under a note that says not to flag it | Not published; the body gives the count |
| Conflicts with a note, and a span quoted from the head settles which side holds | Published with the quote and the note it contradicts, or, if the note holds, listed under "Checked against the notes" with the quote |
| Conflicts with a note on judgment (trade-off, priority, anything the code cannot show) | Published as `asked` under "For the reviewer to decide" |

A blocker is never set aside by a "do not flag" note; that conflict is judgment.

## Author replies

For each open finding with a pending reply, the verifier gives one verdict: `fixed`; `answered`, quoting the head; `open` with the quote that refutes the reply's claim ("handled in X" where X does not handle it); `asked`, when the dispute is judgment; or `open`. An `asked` finding stays so until the user decides or a round finds it fixed.

**Every claim that the code settles something needs a quoted span that occurs at the head; without one it becomes `asked`.**

## Asking the user

The questions: an `asked` finding, an unreviewed submodule range, an agent that cannot start, a hook that did not run, unreadable notes, and a `gh` account that differs from the watch entry's. In a session, the script prints a fixed line with keys and a link, and the session asks. The watcher has no session: it sends a system notification (Notification Center, `notify-send` where installed, a PowerShell toast) and adds the line to its notice list, which the plugin's `SessionStart` hook prints at every session start until answered. Neither carries text from the pull request.

The user reads the finding on the pull request and answers in a session. `decide` takes the key, the decision (keep, waive, `blocker`, `minor`), and the reason from its command line only, posts the decision, approves when the condition holds, and sets the label.

## Text the skill posts

`publish` writes the markers and the lines it composes from fields: keys, classes, counts, links, and file paths that exist at the head. Agent text, quoted spans, and the user's text are escaped: `<` becomes `&lt;`, `@` becomes `＠`, every line is prefixed with `> `, and quoted spans sit in a fence longer than any backtick run inside them. The result is then scanned. A comment opening outside the skill's markers, a line starting with `/`, `@`, or a bot command word, or the GitHub token or a token from the harness's credentials file, stops the review from being published.

## The round

A round runs when the pull request has none yet, when the watcher sees an event, and when the user invokes the skill while something is pending. A failed round posts nothing, so what was pending stays pending.

1. **Lock.** A lock file per pull request and account, created exclusively, records the holder's process id and start time. It is taken over only from a holder that is not running; otherwise the round prints `locked`.
2. **Inputs.** The checkout, the diff, the description, CI results, prior findings with their replies and thread state, and the starting state review. For a private repository only, also the closing tickets and the related repositories the project's rules list, of the same owner; otherwise cross-repository consistency is Unverified. The base is the last reviewed head when it is an ancestor of the live head with an unchanged merge base and the description and notes are unchanged; otherwise the merge base.
3. **Requests.** Skill text with paths and notes filled in. The reviewer's follows `independent-review.md` (the diff, the description and tickets to satisfy, CI as evidence, no command can run) and asks for verdicts on prior findings. Both mark the round directory as untrusted data and the notes as the user's.
4. **Review.** Findings (severity, file, line, verbatim quote, reason, evidence), prior verdicts, Unverified, Covered. A round started only by thread replies asks only about those findings.
5. **Verification.** Each candidate is kept or rejected and weighed against the notes. A kept one gets a class (`blocker` for a holding `blocker` or `should-fix`, else `minor`), a verbatim span, and its text, with the reason when the class differs from the reviewer's severity. Each open finding gets a verdict and reply text; a closed finding raised again and confirmed reopens.
6. **Checks.** The list must parse; prior keys must exist; every span must occur at the head; the text must pass the scan. A failing list is not published. A kept finding whose span is missing goes in the body.
7. **Publishing.** Findings whose span lies in a diff hunk become line comments; the rest go in the body with file and line. The body lists new findings by class, "For the reviewer to decide", "Fixed", "Answered", and "Still open" by key with thread links, "Checked against the notes", Unverified, and the state marker. If the account has a state review newer than the round's start, `publish` posts nothing (`superseded`); otherwise it submits the whole review in one call pinned to the reviewed head, moving line comments into the body once on a position error. It then posts replies (checking their markers), resolves fixed and answered threads, unresolves reopened ones, and keeps `review-blocked` on exactly while an `open` or `asked` blocker remains. GitHub refusals are reported, not retried.
8. **Approval.** The review is `APPROVE` exactly when the live head is the reviewed head, the pull request is open and not a draft, the account is not the author, no blocker is `open` or `asked`, every submodule change has a user decision, and the account has not approved this head. Otherwise it is `COMMENT`. Open minors are listed as follow-ups. CI is evidence, not a condition.

The round removes the mode files and the round directory, then frees the lock.

**Base merges.** When the last reviewed head is an ancestor of the live head, nothing else is pending, and the pull request diff has the same `git patch-id --verbatim`, no agent runs. A review carries the state forward and approves under the same condition.

**Submodules.** A changed gitlink is listed as unreviewed, blocks approval, and is asked about; a yes is recorded as a decision.

**Language.** A language the user asks for is kept in the state marker; markers, keys, paths, and code are never translated.

## Approvals and `pr-to-merge`

`pr-to-merge` counts no approval whose body carries this skill's state marker, so a person's approval is still needed for an automatic merge. It holds a pull request labeled `blocked` or `review-blocked`. This skill alone adds and removes `review-blocked`, so a blocker it posted as `pr-to-merge`'s own account still holds a merge a person approved.

## Waiting

**Watch list.** Invoking the skill adds the pull request to the watch list in the per-user state directory, with the account, harness, model, and effort. The user's stop removes it, posting nothing, and a merged or closed pull request is removed.

**The watcher.** Invoking the skill starts the watcher unless one is running. A lock file in the state directory holds the watcher's process id and start time and decides whether one is running. It is started with Node's `child_process.spawn` (`detached: true`, `stdio: 'ignore'`, `windowsHide: true`) and `unref()`, so it outlives the session and terminal on macOS, Linux, and Windows; nothing is registered with the operating system. Every five minutes it runs one check. Each check and round runs as a child process from the newest installed copy the [state-cli-locator.md](state-cli-locator.md) locator finds, so plugin updates apply without a restart. It exits when the watch list is empty. Sleep pauses it and it continues on wake; a reboot or logout ends it.

**A check** reads each listed pull request as `state` does. Then:

| Event | When | Action |
|---|---|---|
| head, reply, description, notes | Pending, and unchanged since the previous check | Run a round |
| ready | A clean review withheld approval only because of draft status, the pull request is ready, and the head is unchanged | Publish with no findings, approving under the condition |
| merged, closed | The pull request reached that state | Notify, remove from the list |
| account | `gh` is logged in as another account | Notify, skip |
| error | Ten failed checks in a row | Notify |

Rounds run one after another; questions, approvals, and failed rounds are notified as under Asking the user. A notice record keeps the previous check's view, the notice list, the last check's time, and the state at which a round failed, which the watcher does not retry until something changes (an invocation retries at once). Deleting it at most delays a check or repeats a round.

**Visibility.** `watch status` prints whether the watcher runs and when it last checked; every invocation prints it. The plugin's `SessionStart` hook prints one line when the watch list is not empty and no watcher is running (no lock, or a lock whose process is gone). Invoking the skill restarts it.

## Failure

Only the three stop cases need the user.

| Case | Behavior |
|---|---|
| An agent cannot start, or the hook did not run, or the Codex home listing was not refused | Nothing posted; the user is asked |
| An agent's output is missing or malformed, or the list fails a check | That agent runs once more; then the round fails with a fixed reason |
| The submission call errors | A review carrying this round's number and head counts as posted; otherwise submit once more after the same read |
| A reply fails after submission | The next round posts it |
| The head moves during the round | `COMMENT` for the reviewed head; the new head is pending |
| The account cannot read the pull request | The user is asked which account to use; the skill never picks one |

## What is code

`review-until-approve.js` with the verbs `state`, `notes`, `round` (prepare, agents, `publish`), `decide`, and `watch` (`add`, `remove`, `status`, the watcher loop), plus the `explain-pr` read-only hook. Scripts need Node, `gh`, `git`, and the harness's CLI, and print one JSON line per event in the fixed vocabulary, never pull request or agent text or the round directory's path; raw errors go to a log no session reads. The requests, how to verify, weigh, and word findings, and when to ask are skill text.

## Why

- **The pull request is the record people already read.** A local ledger is a second copy whose disagreements become stops with nothing to decide. A review cannot be deleted, so a full state in each needs no history, and detected edits fail safe.
- **Any pull request may be hostile**, and a claim that one is safe could come from an injected model. The verifier reads where steering text sits, so it is confined too.
- **A process per agent** reuses the read-only mode unchanged, allows parallel rounds, needs no orchestrating model, and keeps agents' final messages from every session.
- **The code settles what it can; the user settles judgment.** The quoted span turns "settled" into a script check. Held findings are published so the question sits with the findings.
- **A detached watcher** costs no model call while waiting (a woken session resends its whole conversation), behaves the same on every operating system, and leaves nothing registered.
- **Fixed marker positions and escaping** keep agent text from forging state or acting as the user; **one call after a fresh read** publishes each review whole and once; **private material** is read only where its audience matches.
- **A push alone is an event**, since waiting for a reply needs reminders; **a base merge is not re-reviewed**, since an equal patch id proves the change is the same; **a round whose head moved is still published**, since discarding can repeat without end.

## Rejected alternatives

- **The operating system's scheduler** (launchd, systemd or cron, Task Scheduler). It survives a reboot, but needs a different job per operating system and a registration the user must remove.
- **Waiting in the user's session, or only on invocation.** A full session turn per wait window, or a push left unreviewed until the user remembers.
- **Agents as subagents, confined by agent type.** The hook cannot tell rounds apart (one round per machine), relies on the hook naming the agent type, and needs an orchestrating session that reads the agents' messages.
- **A model session orchestrating rounds, or verifying itself.** A turn per event, and the pull request's text before an unconfined session.
- **A local ledger or cache; a label or the body as state; replaying markers; markers anywhere; a pending review as a claim.** A second copy with authority; no room, or the author's text; a deleted comment drops a finding; agent text writes state; a draft the user can submit by accident.
- **A held finding kept off the pull request; notes always winning; the skill deciding judgment.** A second place to read; findings the code proves dropped; the user overridden.
- **A trust declaration, or an unconfined reviewer running tests.** The pull request's code runs near the user's credentials.
- **More roles; closing on a vanished quote; fetching submodule ranges; a round limit.** Same work in more runs; wrong on unrelated edits; URL and audience checks for a rare case; an arbitrary stop.

## Residual exposure

- Text that steers both agents can get a pull request approved. The span check bounds what is quoted, not the conclusion; the threads are the record, and `pr-to-merge` does not merge on this approval.
- Escaping stops markers, mentions, and line-start commands, not misleading prose or links. Notes on the pull request are public to its readers.
- Two agent runs per event; one reviewer misses what a second would find; rejected findings are not published; runtime claims rest on reading and CI.
- Public pull requests are not checked against related repositories; on private ones, same-owner material can reach readers the pull request lacks.
- Claude Code: the hook is the boundary (the log catches one that did not run, not an extension that approves denied calls); the user's own settings and plugins load, and a `CLAUDE.md` in the checkout can load when read beside. Codex: `explain-pr`'s launch limits apply, and the home listing is the agent's own report.
- Two machines watching one pull request both run agents and can both post within a few seconds.
- An account without write access cannot resolve threads or set the label. Anyone with write access can edit the skill's comments or remove `review-blocked`; anyone posting as the account can write markers.
- A push just before submission leaves the approval on the reviewed head.
- The watcher stops at reboot or logout, is reported only at the next session start or invocation, and reads as the account `gh` is logged in as. Notifications depend on the system.
