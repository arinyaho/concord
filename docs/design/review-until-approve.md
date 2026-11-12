# review-until-approve

`review-until-approve` reviews a pull request the user did not write. It reviews the pull request, publishes the verified findings as one GitHub review per round, waits for the author to push or reply, reviews what changed, and approves the reviewed head once nothing blocks. It never requests changes, merges, pushes to the branch, or posts anywhere but that pull request. It follows the rules in [workflow-state-and-stops.md](workflow-state-and-stops.md) and uses the review request and result of [independent-review.md](independent-review.md), adapted to a target the user does not trust.

Invoking the skill on a pull request authorizes every review it posts there, the approval included. Invoking it again on the same pull request resumes the work from the pull request alone.

## Roles

- **The session** is the user's own session. It writes the review request, verifies every finding before it is published, judges the author's fixes and replies, and runs the scripts. It acts as the account the user names, or as the ambient `gh` account. That account must not be the pull request's author.
- **The reviewer** is started once per round, in a fresh context, of the harness's own kind: a subagent from the `pr-reviewer` agent definition under Claude Code, and a `codex exec` process under Codex. It reads the request and the files it names, and writes one result file. It runs confined (see Confinement).
- **The scripts** read the pull request's state, prepare and publish rounds, and wait (see What is code).

## Confinement

Every pull request is treated as untrusted, whoever wrote it. Its code must not run with access to the user's home or credentials, and its text must not steer anything into an action. There is no trust declaration and no unconfined mode.

The reviewer can read only the round directory: the checkout of the head, the diff, and the other inputs the script writes there. It can write only its result file. It has no network for anything it runs, no access to the user's home, and no GitHub token.

| Harness | Reviewer | How the limits are enforced |
|---|---|---|
| Claude Code | A subagent from the `pr-reviewer` agent definition, with the tools `Read`, `Grep`, `Glob`, and `Write` only: no shell, no web, no MCP tools | A `PreToolUse` hook shipped with the plugin checks every tool call whose input names that agent type. It allows a read whose real path, after resolving links, lies inside a round directory, and a write only to that round's result file. It denies everything else, including a call with no path. It appends each decision to a log in the round directory, which the reviewer cannot write. A round whose log is missing or empty is discarded, because the hook did not run |
| Codex | A `codex exec` process started by the script with a Codex configuration directory made for the round | A permissions profile denies every entry of the real home except the round directory, that configuration directory, and the Codex installation. It denies the copied login file to the reviewer's commands, disables their network, and allows writes only in the result directory. The checkout is marked untrusted, so its `AGENTS.md` and rules do not load. The process gets an environment with every variable that names a key, secret, or token removed |

Nothing the pull request contains is executed outside these limits. The checkout is made with `core.symlinks=false`, so a link in the pull request is a plain file. Submodules are not cloned and `.gitmodules` is not read. Every git command the script runs uses the script's own configuration, with external diff drivers and text conversion off. The checkout is never a working directory of the session, so its `.claude/` settings and `CLAUDE.md` do not load. The review request tells the reviewer not to run the pull request's tests, build scripts, or hooks. Under Codex, where the reviewer has a shell, a command it runs anyway runs inside the profile.

The session verifies findings by reading the checkout as data. It never runs a command from the pull request.

## State on the pull request

The skill keeps no ledger. Every run reads the state from the pull request: the skill's own reviews and comments, the threads, and the head. Every marker is an HTML comment, and its data is base64url-encoded JSON, so no text inside it can close the comment.

| Where | Marker | What it carries |
|---|---|---|
| The body of every review the skill submits | `<!-- review-until-approve:state <data> -->` | The state after that review: format version, round number, reviewed head, diff base, a hash of the title and body as reviewed, the review language, any user decision on unreviewed submodule changes, and every finding with its key, class (`blocker` or `minor`), status (`open`, `fixed`, `answered`, `waived`), the head that raised it, its file and line, and the head that closed it |
| The first comment of every finding thread | `<!-- review-until-approve:finding <key> -->` | The key, so the thread of a finding can be found |
| Every reply the skill posts | `<!-- review-until-approve:reply <key> <status> <head> -->` | The state change or answer that reply posts, so that it is posted once |
| A comment that records a user decision | `<!-- review-until-approve:decision <data> -->` | The key, and either the waiver or the new class. The visible text gives the reason |
| The body of the pending review that opens a round | `<!-- review-until-approve:claim <data> -->` | The head and the start time of the round |

A finding's key is `<round>.<index>`, for example `3.2`. The key is unique by construction, so a run never needs earlier keys to make a new one. Statuses mean:

- `open`: the finding stands.
- `fixed`: the session verified at the closing head that the code no longer has the defect.
- `answered`: the session verified that a reply shows the finding is wrong or does not apply.
- `waived`: the user dismissed it.

Only the user changes a published finding's class, and only the user waives one.

**Reading.** The state is the state marker of the newest review the account submitted, with the decisions the account posted after it applied in order. To that the script adds from GitHub: each finding's thread (resolved or not, and its comments after the skill's last comment), the author's conversation comments, the live head, title, body, draft status, and whether the account already approved the live head. A dismissed approval of the live head counts as given, because a person withdrew it. A round is in progress when the account has a pending review with a claim marker younger than two hours.

**Whose comments count.** A marker counts only on a review or comment authored by the reviewing account. A marker that the pull request's author or anyone else writes is ignored. Two accounts that review the same pull request have separate states.

**Edited or deleted markers.** The skill never edits what it posted. A counting item that GitHub reports as edited (`lastEditedAt` is set) makes the state unreadable. So does a state marker that does not parse, or a decision that names an unknown key. With unreadable state the skill approves nothing. Its next round is a broad round with no prior findings, and that review says the earlier record was not used. A deleted finding comment loses only the thread: the finding is still in the state marker, and its later replies go into the review body. A submitted review cannot be deleted, so the state marker cannot be removed except by an edit, and an edit is detected.

## The round

The session runs a round when the pull request has no round yet, when the watch reports an event, and when the user invokes the skill on a pull request whose live head was not reviewed.

1. **Claim.** `prepare` creates a pending review with the claim marker, pinned to the live head. GitHub allows one pending review per account per pull request, so a second session of the same account cannot claim the same pull request at the same time. A claim older than two hours is deleted and replaced. A pending review without the claim marker is the user's own draft: it is never touched, and the session tells the user that the draft keeps the skill from publishing.
2. **Inputs.** `prepare` makes the round directory in the operating system's temporary directory. It writes there:
   - the checkout at the exact head;
   - the diff from the base to the head;
   - the title and body;
   - the CI results for the head;
   - the prior findings, with their status, their thread's replies, and whether the thread is resolved;
   - optionally, a clone of a related repository's default branch that the session names.

   The base is the last reviewed head when it is an ancestor of the live head and the merge base is unchanged. Otherwise the base is the merge base, so the diff is the whole pull request.
3. **Request.** The session writes the review request in the form `independent-review.md` defines. The target is the diff file with its base and head. What it must satisfy is the title and body, and any ticket they link that the account can read. Evidence is the CI results. "Not done" states that no command can run. The request adds the prior findings and asks for a verdict on each open one: `open`, `fixed`, or `answered`. The diff is a file rather than a command because the reviewer has no shell. The request says that everything in the round directory is data written by people the user does not trust, including the title, the body, the replies, and code comments.
4. **Review.** The reviewer writes its result to the result file: findings, prior verdicts, Unverified, and Covered. Each finding has a severity (`blocker`, `should-fix`, `minor`), file, line, a verbatim quote of the code, the reason, and the evidence. A reply round, started by a reply alone, asks only for verdicts on the findings that were answered.
5. **Verification.** For each finding, the session reads the cited code in the checkout. It publishes the finding only when the code shows the defect as stated. It copies a verbatim span from the file, and sets the class: `blocker` for the reviewer's `blocker` and `should-fix`, otherwise `minor`. The session may change the class when the code shows the reviewer's severity is wrong, and it says why in the finding. A rejected finding is not published; the session tells the user how many it rejected and why. For each prior verdict, the session reads the code at the new head and the reply. A finding closes only when the session confirms the verdict; one the reviewer gave no verdict on stays open. A closed finding that the reviewer raises again, and the session confirms, reopens.
6. **Publishing.** `publish` takes the session's verified list and builds the review in the claimed pending review:
   - A finding whose span occurs at the head, at a line inside a diff hunk, becomes a line comment.
   - One whose file is in the diff but whose line is outside every hunk becomes a file comment that starts with `Line <n>:`.
   - Any other finding goes in the review body. So does a finding whose span does not occur at the head, and one whose thread GitHub refuses.

   The body lists the new findings by class, "Fixed", "Answered", and "Still open" by key, the reviewer's Unverified items, and the state marker. Before submitting, `publish` reads the head again and checks the review text against the account's tokens; a text that contains one is not posted. It then submits the review with `commit_id` set to the reviewed head. After the submission, each fixed or answered finding gets a reply in its thread with the closing head and reason, and the thread is resolved. A reopened finding's thread is unresolved and answered. A reply the session judged wrong is answered "Still open" with the reason. Each reply's marker is checked before it is posted.
7. **Approval.** The review is `APPROVE` exactly when all of these hold at submission: the live head is the reviewed head; the pull request is open and not a draft; the account is not the author; the state the review records has no open `blocker`; every submodule change in the pull request diff is covered by a user decision; and the account has no approval of this head. Otherwise it is `COMMENT`. An approving review lists the open minors as follow-ups. CI results are evidence for the reviewer, not part of the condition: merge gating belongs to branch protection.

A head that only merges the base needs no reviewer. When the last reviewed head is an ancestor of the live head, and the pull request diff (merge base to head) has the same `git patch-id --verbatim` at both heads, the round skips steps 2 to 5. It publishes a review that carries the state forward and approves under the same condition.

A submodule change (a changed gitlink) cannot be reviewed from this repository. The round lists it as unreviewed, and the review does not approve. The session asks the user whether to accept the submodule range unreviewed, because that approval is the user's alone. A yes is recorded as a decision on the pull request.

The user may waive a finding or change its class at any time. `decide` posts the decision, in the finding's thread or in the conversation for a finding in the body, and then submits an approval when the condition holds. The skill never waives or reclassifies a published finding on its own.

The user may ask for the findings in a language. The state marker records the language, and later rounds keep it; markers, keys, paths, and quoted code are never translated. A model or effort the user asks for applies to the reviewer of that invocation.

## Waiting

`watch.js` reads the pull request in the same way `state` does, polls every 60 seconds, and exits printing one line when one of these holds:

| Line | When |
|---|---|
| `head <sha>` | The live head is not the last reviewed head and has not changed for five minutes |
| `reply <keys>` | Someone other than the account commented in a finding's thread, or the author commented in the conversation, after the skill's latest comment there. No new comment has arrived for five minutes |
| `description` | The hash of the title and body differs from the one in the state marker. It has not changed for five minutes |
| `ready` | The last review was clean and did not approve only because the pull request was a draft, the pull request is no longer a draft, and the head is unchanged |
| `merged`, `closed` | The pull request reached that state |
| `inactive` | Seven days have passed since the last review without any of the above |
| `window` | The `--deadline` passed with nothing to report |
| `error` | Ten polls in a row failed. The line gives the last error |

The watch keeps a notice record next to the user's Concord state, listing the lines it has printed for each pull request and account. It does not print the same `head`, `reply`, or `description` line twice. That is what keeps a round that failed on a head from being retried on every poll. Deleting the record causes at most one repeated line. The repeated round finds the head already reviewed, or retries a failed round once.

| Harness | How the session waits | Model cost |
|---|---|---|
| Claude Code | `watch.js --deadline 6600` as a background Bash command with a two-hour timeout, which wakes the session when it exits. On `window`, and on a run the host killed, the session runs the same command again and says nothing | One small model turn per two-hour window |
| Codex | After a round, the session tells the user the review waits for the author and ends the turn. Invoking the skill again on the pull request runs `watch.js --once`, which prints the line that is due now or `none` | One model turn per invocation |

On `head`, `reply`, or `description`, the session runs a round. On `ready`, it runs `publish` with no findings, which approves under the condition. On `merged`, `closed`, or `inactive`, it tells the user and ends. On `error`, it reports the error and starts the watch again. A stop request from the user ends the watch and posts nothing; invoking the skill again resumes it.

## Concurrency and failure

No outcome needs the user unless it is one of the three stop cases, and none posts twice: the claim admits one round per account, and every post is preceded by a read of the marker it would add.

| Case | Behavior |
|---|---|
| Another session of the account holds a fresh claim | No round. The session watches; the other session's review becomes the state |
| The claim is older than two hours | Deleted. This session claims and runs the round. A session that still runs the old round finds its pending review gone at publishing, and posts nothing |
| The user's own pending review exists | Not touched. The session tells the user and watches (a stop case: the draft is the user's) |
| The reviewer cannot start (not installed, not logged in) | The claim is deleted and nothing is posted. The session tells the user what is missing (a stop case: only the user holds it) |
| The reviewer's result is missing or malformed | The reviewer runs once more. If it fails again, the claim is deleted, nothing is posted, the session reports it, and watches for the next head or reply |
| The confinement log is missing (the Claude Code hook did not run) | The result is discarded and nothing is posted. The session tells the user that the plugin's hooks are off (a stop case: the setting is the user's) |
| A thread call fails while the review is pending | That finding moves to the body. Nothing is visible until the submission |
| Publishing fails before the submission | The pending review is deleted, or left to expire if the process died, and the round is retried once |
| The submission call errors | `publish` reads the reviews. A submitted review by the account that carries this round's state marker for this head is taken as posted. Otherwise it submits once more |
| A reply or resolution fails after the submission | The next run posts it; the reply marker shows what is still missing |
| The head moves during the round | The review is published as `COMMENT`, pinned to the reviewed head, and never approves. Its findings are about that head and stay valid evidence. The watch reports the new head at once |
| The state is unreadable | A broad round with no prior findings, as described under State on the pull request |
| The account cannot read the pull request | The session asks the user which account to use (a stop case). It never picks another account |
| The account is the pull request's author | Refused before any round, because GitHub rejects self-approval |

## What is code

| Script | What it does |
|---|---|
| `review-until-approve.js state` | Reads the reviews, threads, and comments with paging, applies the reading rules above, and prints the state and what is due: a round, an approval, waiting, a round in progress, or done |
| `review-until-approve.js prepare` | Claims the pull request, makes the checkout and the input files, and computes the diff base and the patch-id check |
| `review-until-approve.js review` | Codex only: writes the round's Codex configuration and permissions profile and runs `codex exec` on the request |
| `review-until-approve.js publish` | Locates each verified finding against the diff hunks, builds the pending review, checks the head and the tokens, submits, posts the thread replies, and evaluates the approval condition |
| `review-until-approve.js decide` | Posts a user decision and submits an approval when the condition holds |
| `watch.js` | The polling described under Waiting |
| `confine-reviewer.js` | The Claude Code `PreToolUse` hook described under Confinement |

Each takes its input as arguments and a JSON file, prints one JSON line, and depends only on Node, `gh`, and `git`. Everything else is skill text: the review request, how to verify a finding and a verdict, how to word a finding and a reply, when to ask the user, and what to report. The scripts total about 600 lines.

## Why

**The pull request is the record the author and the user already read.** A finding, its class, its thread, and the approval are all on the pull request. A local ledger is a second copy, and every way it can disagree with the first copy becomes a stop with nothing for the user to decide. With the state on the pull request, a new session, another machine, or a reinstalled plugin resumes from the pull request alone.

**The state marker sits in the review body, because a submitted review cannot be deleted.** Rebuilding the state from per-comment markers alone would lose a finding when its comment is deleted. A complete state in every review needs no history to rebuild it. Detecting edits makes tampering fail safe: the only outcome is a broad round that raises the findings again.

**The claim uses GitHub's limit of one pending review per account per pull request.** The lock then lives in the same place as the state and holds across machines. Comments added to a pending review stay invisible until the submission, so a failure partway through publishing shows nothing.

**Confinement replaces the trust declaration.** A declaration only bought an unconfined reviewer, and the script could not tell whether the user or an injected model wrote it. A reviewer that can only read the checkout can still do the review. Running the pull request's tests is CI's job, and the CI results go to the reviewer as evidence.

**The session verifies findings, as in every other review.** The author sees only findings checked against the code, and the author's time is the scarcest resource in this loop. The same check closes findings. Whether a fix resolves a finding is a judgment about the code, so it is made by reading the code, not by whether the quoted text is still there.

**A push alone wakes a round.** Waiting until the author also replies needs a reminder rule and a question to the user about whether to keep waiting, and that question is not a stop case. A push is a response, and a round on a partial push costs one delta review.

**A head that only merges the base is not reviewed again.** Updating a branch from its base is the most common push on a long-lived pull request. An unchanged patch id of the pull request diff is an exact test that the author's change did not change, and whitespace counts in it.

**A round whose head moved is still published.** Its findings are true of the head it reviewed, and the next round sees what changed. Discarding the round and starting again can repeat without end on a busy branch.

## Rejected alternatives

- **A local ledger, even as a cache of the pull request.** It saves API reads. A cache that is read instead of the pull request is a ledger with authority under another name.
- **A label or the pull request body as the state.** A label cannot hold findings, and the body belongs to the author.
- **Rebuilding the state by replaying every marker.** It needs no state marker. A deleted comment then silently drops its finding.
- **A trust declaration kept as a local authorization record, or asked for again each round.** Each one only unlocks an unconfined reviewer. A record kept apart from the pull request is a file with authority, and asking again adds friction without a check.
- **An unconfined reviewer that runs the project's tests.** It verifies runtime claims. It also runs the pull request's code with the user's credentials within reach.
- **Separate verifier, gate, and anchor-extraction roles.** They catch false findings and missing anchors before publishing. The session's verification does both, knowing the code, with one reviewer instead of five.
- **Closing a finding when its quoted text disappears.** It is exact. It also closes a finding on any edit to the quoted line, and keeps it open when the fix is elsewhere.
- **Fetching the submodule's own range to review it.** It reviews pin bumps. It needs URL checks against `.gitmodules`, an audience check so a private repository is not quoted into a public review, and a second checkout. A submodule bump to someone else's pull request is rare enough for the user to decide.
- **A reminder after 24 hours of only a push or only a reply.** It asks the user a question that is not a stop case.
- **A limit on rounds.** A limit that runs out stops the review at a point unrelated to the pull request. Each round reviews only what changed since the last one.
- **A subagent of the Codex session as the Codex reviewer.** It inherits the session's sandbox, which reaches the user's home. A `codex exec` process gets a profile of its own.
- **A local lock file as the mutex.** It does not span machines, and deleting it allows a second round to post.

## Residual exposure

- The session is not confined, and it reads the pull request's code and the reviewer's result while verifying. Text that steers the session could make it publish or approve wrongly. The scripts limit what goes through them: posts go only to this pull request, an approval requires no open blocker in the recorded state, and no posted text may contain a token. They do not limit what a steered session does directly. The published threads and their replies are the record the author and the user can contest.
- Whether a finding is fixed or answered is the session's judgment. A finding closed wrongly is visible as the reply in its thread.
- One reviewer misses defects that a second independent pass would find, as in `independent-review.md`.
- The reviewer cannot run anything, so claims about runtime behavior rest on reading and on CI, and the result lists them as Unverified. Under Codex, a command the reviewer runs despite the request runs inside the profile, where the pull request's code can run but can reach no network, no home, and no credential.
- On Claude Code, confinement depends on the plugin's hook. The log check stops a round in which the hook did not run. On a host with hooks off, a reviewer steered by a pull request written against this design could forge the log through its unrestricted `Write`.
- During a round, the claim is a pending review that the user sees as their own draft in the web interface. Submitting it there would publish an empty review.
- Anyone with write access to the repository can edit the skill's comments and force a broad round. Anyone who can post as the reviewing account can write markers that count.
- An approval is pinned to the reviewed head. A push between the last head check and the submission leaves the approval on that head, and branch protection decides whether it still counts.
- An author who pushes often causes a round per push, after the five-minute quiet period.
- A plugin update that removes the installed version's directory during a wait makes the next watch window fail to start. The session reports it, and invoking the skill again resumes from the pull request.
