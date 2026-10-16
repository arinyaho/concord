# review-until-approve

`review-until-approve` reviews someone else's pull request the way `/review-and-fix` reviews a branch, publishes the verified findings, waits (see Wait for the cost per harness) until the author pushes and replies, reviews what changed, and approves the pull request once a round is clean. It is `/review-and-fix` that never fixes. It never requests changes, merges, pushes to the branch, or posts outside the pull request, and it runs only for a pull request the user named.

## Scope

The skill runs on Claude Code and Codex. It lives in `plugins/concord/skills/review-until-approve/` and is bundled into the Codex package with `plugins/concord-codex/bin/bundle.mjs`, without its `test/` directory, whose helpers the Codex package does not carry. It is not in the Copilot package (tracked in #363). The review runner and the review CLI are found by `scripts/locate.js` in `core/` and `hooks/` (Claude Code) or `engine/` and `bin/` (Codex); `scripts/run-review.js` calls `runReviewUntilGreen` directly, so the Codex bin wrapper needs no `reviewOnly` entry point. It runs the review through `runReviewUntilGreen` in `plugins/concord/core/codex-review-runner.js` with `reviewOnly: true`, the same runner `services/pr-review` uses, so there is no second reviewer implementation. `services/` is not part of the installed plugin, so the skill re-implements the publication contract of `services/pr-review/review-one.sh` (finding format, inline-only-in-hunk rule, body fallback, head re-check, credential refusal) instead of sourcing it.

The decisions below are the conclusions of the Opus design pass.

## Round procedure

| Step | Rule | Reason |
|---|---|---|
| Round 1 | Broad review of the PR head against the merge base, requirements from the PR title and body | Same procedure as `/review-and-fix` |
| Checkout | Fresh full clone in a temporary directory, exact head SHA, review run with an allowlisted environment (`PATH`, locale, proxy and certificate variables, the Codex home for its auth or the Claude OAuth token) and an empty `HOME`. The runner itself runs with that empty `HOME`, so `approve.js` hands the engine the account's real home (`reviewRealHome`) and the real `CLAUDE_CONFIG_DIR` (`reviewDenyRead`). The Codex profile denies every entry of the real home except the way to the checkout, the review's own directories and the Codex binary, so the account's credential files (gh, ssh, cloud, Claude, Codex) are not readable by absolute path. The Claude reviewer has no such restriction | The checkout is untrusted, and a prompt injection could otherwise read a credential file and quote it in a published finding. Checked with a decoy file in the real home: readable to `codex exec` under the old profile, refused under the new one, with `git` and writes into the checkout still working. Entries created in the home after a Codex review starts are not denied |
| Reviewer | The harness's own: `claude` under Claude Code (`CLAUDECODE` set), `codex` otherwise; `--reviewer` overrides. `claude` runs only with `--allow-unrestricted-home`: without it `start` refuses and names the flag, and with it `start` and every round print a warning that the reviewer can read the real home and a malicious pull request could publish what it reads. The opt-in is per `start`; a later `start` without the flag is refused | The Claude reviewer has Bash and an empty `HOME` does not stop an absolute-path read, so its restriction (an operating-system wrapper or settings, verified with a decoy file) is a separate help-wanted issue, not part of this change. A Claude Code user without Codex can still use the skill, knowingly |
| Later round range | `chooseRange`: same merge base and the last head an ancestor of the new head gives `last head..head`; otherwise `merge base..head`; a changed PR title or body gives `merge base..head` with the broad gate | A force push or a merged-in base branch has no isolatable delta; a changed requirement needs the gate again |
| Earlier findings | A finding is `fixed` only on evidence in git objects, never because the reviewer is silent. Each finding records `spanVerified`, the head SHA at which its span occurred byte for byte in the file stored in that head's git object (`git ls-tree` then `git cat-file`, a regular file of at most 20 MiB, never the working tree). A later round compares that head with the new head (`git diff -M --name-status`, one tree comparison however many pushes lie between) and resolves the finding's path through renames. It is fixed when the span no longer occurs at that path or in any other file the diff leaves in place; a deleted file counts as absent. It stays open, with `openReason`, as `unverified` (no verbatim span was ever recorded, which includes an empty span and every finding of a ledger written before this field existed), `span-present` (the span occurs at the path or moved to another file, and the finding follows it), `raised` (the reviewer raised it again) or `path-unresolved` (the old head cannot be fetched, or the path is a symlink, submodule or file over 20 MiB at the new head). `unverified` and `path-unresolved` findings cannot be settled from the code: the `round` output lists them as `held` and says `waive` clears them. Open findings are still passed to the reviewer as guidance (up to 20, with the path after a rename) so it can raise one again under the same id, which keeps it open and not posted again; the guidance decides nothing | The reviewer's silence is a signal a prompt-injected reviewer controls, and the checkout is writable by the reviewer inside the Codex sandbox, so neither can fix a finding. A push that changes only a file mode shows `M` in name-status and the reviewer only a mode line; the span is still there, so the finding stays open. Matching is exact bytes with no whitespace or line-ending normalization, so a span the engine reflowed does not verify and is waived. A fixed finding the reviewer raises again with the span verbatim at the head reopens in place, and a re-raise of an unverified finding with the span verbatim verifies it; a re-raise matching only by id never replaces a span |
| Publication | One review per round, `commit_id` set to the reviewed head, event `COMMENT`, or `APPROVE` when the round is clean. Never `REQUEST_CHANGES` | The clean round's review is the approval |
| Published finding | Key is the hash of the file and the whitespace-collapsed span, or file plus id when the span is empty. A finding already in the ledger is listed as "Still open", not posted again | A span survives an id the model renamed |
| Fixed finding | The next review body carries one line, "Fixed since `<sha>`: ids" | Replying to or resolving another account's threads is out of scope for the first layer |
| First line | `<!-- concord-approve: <head> round:<n> base:<range base> -->` | `services/pr-review/scan.sh` treats a first line starting with `<!-- concord-review` as scheduling evidence, so the skill uses a different prefix |

## Approval condition

`evaluateApproval` approves exactly when all of these hold: the reviewed head is the live head, the pull request is open and not a draft, the reviewing account is not the author, no approval was already given for this head, and no finding in the ledger is open. The review engine emits no severity, so every verified finding blocks until it is fixed or the user waives it with the `waive` verb. A waived finding is recorded in the ledger and does not block. A finding the code cannot settle (`unverified`, `path-unresolved`) is cleared only by `waive`, by finding id or, when several open findings share an id, by key.

Required checks are not part of the condition. Approval is a code-review verdict; merge gating belongs to branch protection. A draft is never approved: the skill tells the user, and invoking it again after the pull request is ready approves the unchanged head without a new round.

## Wait

`scripts/watch.js` reads the ledger without writing it, polls `gh` every 60 seconds, prints one JSON event line, and exits. It runs under `mien exec <profile> --` where the reviewing account is not the ambient one.

| Harness | How the session waits | Model cost |
|---|---|---|
| Claude Code | `watch.js` under Monitor, which wakes the session on its one output line | none until the event |
| Codex | `watch.js --max-wait <seconds>` in the foreground; after that many seconds without an event it prints `{"event":"idle"}`, and the session runs it again | about one small model call per window; a window is bounded by the shell tool's command timeout (540 seconds by default in the skill) |

Codex has no background process that wakes a conversation, so the wait there is not zero-token; the skill says so and tells the user after six idle windows in a row. `<ledger>.watch.json` carries the head seen, the nudge shown and the failed polls in a row from one run to the next, so a new window does not restart the two-poll head stability check, repeat a nudge or hide an outage behind `idle`. A window ends at its deadline: the sleep between polls is cut to the time left. The ledger stays the session's and `approve.js`'s alone.

| Event | Fires when |
|---|---|
| `round` | The head differs from the last reviewed head and the author replied after the last review, and the head was the same on two consecutive polls |
| `merged`, `closed` | The pull request reached that state |
| `nudge` | Only a push, or only a reply, has arrived and 24 hours have passed since the last review. It repeats only for a new head or reply, and posts nothing; the session tells the user |
| `timeout` | 7 days since the last review |
| `idle` | Only with `--max-wait`: the window ended without an event (exit status 0) |
| `error` | Ten consecutive failed polls, counted across bounded runs (exit status 1) |

A reply is a comment by the pull request author after the last review, either in a thread of a review the skill published (`in_reply_to_id` is one of its comment ids) or on the pull request conversation, which is the only way to answer a finding posted in a review body. Who pushed does not matter. A push or reply alone, a CI change, a label, or a comment by anyone but the author wakes nothing. A user stop ends the watch and is recorded in the ledger. At most 10 rounds run per pull request, and nothing is posted on any stop.

## State

One JSON file per repository, pull request and reviewing account at `${REVIEW_APPROVE_STATE_DIR:-${CLAUDE_CONFIG_DIR:-~/.claude}/concord/review-until-approve}/<owner>__<repo>__<pr>__<login>.json`, outside any checkout, written atomically, locked by process id so a second session on the same pull request is refused. It holds the reviewing account, the author, `rounds[]` (head, range base, merge base, requirement hash, submission time, review id, comment ids), `findings[]` (key, id, category, file, span, `spanVerified`, summary, status `open|fixed|waived`, `openReason`), `nudged`, `approval`, `stopped`, and `pending` (the head, the newest review id before the post, the round about to be recorded and the findings it would leave, written alone before an `APPROVE` is posted and removed once the review is recorded; the ledger's own findings change only when the review is recorded). What happened since the last review is derived from GitHub on every poll, never stored. Invoking the skill again on a pull request with a ledger resumes it: a moved head runs a round at once, since the invocation is the user's request; otherwise the watch restarts.

## Identity

Every `gh` call, read and write, runs as the account the user names (`mien exec <profile> -- gh`, else the ambient account), recorded as the reviewer. A different account has its own ledger (the login is in the file name) and starts at round 1. If the account is the pull request author, the skill refuses before round 1, because GitHub rejects self-approval. Approval is `POST repos/{o}/{r}/pulls/{n}/reviews` with `event=APPROVE` and `commit_id`, because `gh pr review --approve` cannot pin the commit and races with a push. A push between the last head check and the POST is accepted: the approval is pinned to the reviewed `commit_id`, so GitHub shows it against that commit and branch protection decides whether a later push dismisses it. An account below write permission is warned that its approval will not satisfy branch protection.

## Unattended deployment

The loop can later run unattended, with GitHub Actions or `services/pr-review` reacting to the push and the reply instead of a session's shell loop. The pure decisions (`chooseRange`, `isPublished`, `classifyPrior`, `evaluateApproval`, `repliesSince`, `wakeDecision`) are in `scripts/lib.js`, and the publication code is separate from the watch. Neither depends on Monitor or a live session. No unattended variant is built.

## Transition table

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| reviewed head, no reply | author pushes | no wake, no round | introduced | `watch: a push alone and a reply alone stay silent` |
| reviewed head, no push | author replies | no wake, no round | introduced | `watch: a push alone and a reply alone stay silent` |
| reviewed head | push and reply, head stable for two polls | one `round` event for the live head; a burst of pushes wakes once | introduced | `watch: a push plus a reply wakes once` |
| any open pull request | merged or closed | `merged` or `closed` event, ledger unchanged | introduced | `watch: a reply on the PR conversation counts, a closed PR wakes` |
| one side only for 24 hours | poll | one `nudge` per head and reply; later polls silent | introduced | `wakeDecision: one side alone nudges once`, `nudged records the nudge` |
| no activity for 7 days | poll | `timeout` event, ledger resumable | introduced | `wakeDecision: one side alone nudges once` |
| GitHub unreachable | ten consecutive polls | `error` event, exit status 1 | introduced | `watch: ten failed polls end with an error event` |
| GitHub unreachable, `--max-wait` given | window ends before ten failures | `idle`; the failure count carries to the next run, whose tenth failed poll gives `error` | introduced | `watch: failed polls add up across bounded runs until the error event` |
| silent wait, `--max-wait` given | window ends | `idle` event, exit status 0 | introduced | `watch: --max-wait ends a silent wait with an idle event` |
| nudge shown, session restarts the watch | next bounded run | no second nudge, even when the session did not record it or recorded an earlier one | introduced | `watch: a nudge is not repeated by the next bounded run` |
| head seen in one bounded run | next bounded run | the head counts toward the two-poll stability | introduced | `watch: the head seen by one bounded run counts toward the next run's two-poll stability` |
| sidecar file unreadable or missing | start | treated as empty; at worst a notice repeats | introduced | untested, because the read falls back to an empty object |
| force push, merged-in base, changed requirement | next round | whole-PR range, gate only when the requirement changed | introduced | `chooseRange` tests |
| finding with a renamed id | next round | recognized by span, not posted twice | introduced | `isPublished` test |
| clean round, draft, self-review, moved head, open or waived findings | approval check | approve only when every condition holds | introduced | `evaluateApproval` test |
| any round | review engine fails or prints no `review-only` result | no review posted, ledger unchanged | introduced | untested, because the guard throws before any `gh` write and the credential test already pins the no-post path |
| first round | publish | broad review against the merge base, `COMMENT` with inline findings, ledger gains round 1 and open findings | introduced | `round 1 reviews broad against the merge base` |
| open findings, author fixed and pushed | next round | diff review from the last head, fixed findings marked, clean round posts `APPROVE` pinned to the head | introduced | `round 1 reviews broad against the merge base` |
| open findings, user waives one | `waive` | finding waived; `APPROVE` posted if nothing else blocks | introduced | `a waived finding lets the unchanged head be approved` |
| reviewing account is the author | `start` | refused before any round | introduced | `start refuses when the reviewing account is the author` |
| review text holds a credential | publish | nothing posted, exit status 1 | introduced | `a review containing a credential is never posted` |
| `APPROVE` accepted by GitHub, the call reports failure (timeout) | inline post fails, fallback runs | the review list is read first; a review of the expected state (`APPROVED`, or `COMMENTED`) by this account on this head newer than the pre-post newest id is taken as the posted one, no second post | introduced | `an approval GitHub accepted but the call reported as failed is not posted a second time` |
| crash between an `APPROVE` post and the ledger save | next `start`, `round`, `approve` or `waive` | the pending marker is settled from GitHub's review list: found, the round and the approval are recorded; not found, the marker is dropped and the head is reviewed again | introduced | `start after a crash between the approval post and the ledger save finds the posted review`, `start after a crash before GitHub accepted the approval drops the marker` |
| `APPROVE` post fails outright | `round` | ledger keeps its findings and rounds, marker dropped by the next start, which reviews the head again | introduced | `an APPROVE whose post fails outright leaves the findings as they were`, `a comment review on the pending head is not taken for the approval` |
| finding raised again with another span, same file and id | next round | stays open, not posted again | changed | `a finding raised again with a different span is neither listed fixed nor posted as new` |
| new finding, span verbatim in the head's git object | round | `spanVerified` is the head | introduced | `round 1 reviews broad against the merge base`, `a verbatim re-raise verifies an unverified finding` |
| new finding, empty or reflowed span, not a regular file or over 20 MiB | round | open, `unverified`, named in `held` with the `waive` hint | introduced | `a pure rename (R100) does not fix a finding whose span is not verbatim`, `classifyPrior: a finding whose span was never verified stays open whatever the code says` |
| verified finding, span gone from its path and from every file the push left in place | next round | fixed | changed | `round 1 reviews broad against the merge base`, `every verified finding is judged, however many there are` |
| verified finding, mode-only push, pure rename (R100) or span still in the file | next round | open, `span-present`, at the new path after a rename | changed | `a mode-only push (chmod +x) fixes nothing`, `a pure rename (R100) with the span still present keeps the finding open` |
| verified finding, rename with edits that remove the span | next round | fixed | unchanged | `a rename with edits that removes the verified span fixes the finding` |
| span moved to another file | next round | open at the new path | introduced | `a span that moved to another file keeps the finding open` |
| file deleted: verified finding; unverified finding | next round | fixed; open | introduced | `deleting the file fixes a verified finding and leaves an unverified one open` |
| old head cannot be fetched, or the path is a symlink, submodule or over 20 MiB at the new head | next round | open, `path-unresolved`, named in `held` | introduced | `classifyPrior: a delta that cannot be computed, or a path that is no regular file, keeps the finding open` |
| Codex reviewer edits the checkout during the review | next round | no effect: evidence comes from git objects, and the Codex profile keeps `.git` read-only | introduced | `a reviewer that edits the checkout cannot fix a finding` |
| Claude opt-in reviewer plants `refs/replace/*` in the review clone | next round | no effect: every git call runs with `GIT_NO_REPLACE_OBJECTS=1`; beyond that an unconfined reviewer is not trusted to leave the clone intact (#366) | introduced | `a replace ref planted in the review clone does not change what the head contains` |
| `waive <id>` where two open findings share the id | `waive` | refused, the message lists the keys; `waive <key>` waives exactly one | introduced | `waive refuses an id shared by two open findings` |
| ledger finding without `spanVerified` | next round | open, `unverified`, until waived | introduced | `a ledger finding recorded without spanVerified is unverified` |
| fixed finding raised again, span verbatim at the head | next round | reopened in place and posted | changed | `a fixed finding that the reviewer raises again with the span present reopens` |
| more than 20 open findings | next round | all are judged by the code; only 20 are listed to the reviewer | changed | `every verified finding is judged, however many there are` |
| `round` on a Claude ledger that never took the opt-in | `round` | refused, no review runs | introduced | `round refuses a claude ledger that never took the opt-in` |
| three discarded rounds, head still moving | `round` | `head-keeps-moving`, carrying the unrestricted-home warning like every other result | changed | untested, because it needs the head to move during three live reviews |
| reviewer rewrites files in the review-only `CODEX_HOME` (under the writable `/tmp`) | later launch of the same run | the `CODEX_HOME` is read-only in the Codex profile, so `config.toml` and its deny list are unchanged | introduced | `a command inside the review sandbox cannot rewrite the CODEX_HOME configuration` |
| `--reviewer claude` (or the Claude Code default) without `--allow-unrestricted-home` | `start` | refused, the message names the flag, no ledger file written | introduced | `start refuses the claude reviewer without the opt-in flag` |
| `--reviewer claude --allow-unrestricted-home` | `start`, `round` | runs; every result and stderr carry the warning; a later `start` without the flag is refused | introduced | `with the opt-in flag the claude reviewer runs, and start and every round print the warning` |
| runner started with the reviewer's empty `HOME` | review | the real home still reaches the engine (`reviewRealHome`) | introduced | `the engine is told the real home and the real Claude configuration directory` |
| another session holds the ledger lock | `round`, `approve`, `waive` | refused | introduced | untested, because it needs two live processes; the lock reuses `core/run-lock.js` |

Combinations the ledger lock rules out (two sessions interleaving on one pull request) are refused at start.

## Residual exposure

- If the `APPROVE` post errors and the head then moves, the pending marker is not settled against GitHub's review list until a later `start`, `round`, `approve` or `waive` reads it; an approval GitHub accepted for the old head stays recorded only on GitHub until then.
- A body-mode retry after a timed-out post can post a second review when GitHub's review list lags behind the first.
- Fixed means the quoted text no longer occurs, not that the defect is gone; a trivial edit inside the span fixes the finding, and the next diff review is what catches a defect that remains. A fix that is later undone is noticed only when the reviewer raises the finding again. A reformat that changes the quoted bytes (re-indent, CRLF) fixes the finding for the same reason.
- A finding without a verbatim span (an empty one, or one the engine reflowed) can only be waived, so a reviewer that quotes loosely makes the user waive more. A reviewer that withholds a finding at round 1 is not detectable.
- The review-only state directory is writable by the reviewer (it is the artifact channel); the runner pins and hashes the files it later trusts, so a later role cannot change them unnoticed, but the directory is not read-only.
- The Claude reviewer is not confined (`--allow-unrestricted-home`) and is not trusted to leave the review clone intact beyond the `GIT_NO_REPLACE_OBJECTS` setting; the confinement is tracked in issue #366.
