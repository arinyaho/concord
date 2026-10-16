# review-until-approve

`review-until-approve` reviews someone else's pull request the way `/review-and-fix` reviews a branch, publishes the verified findings, waits at no token cost until the author pushes and replies, reviews what changed, and approves the pull request once a round is clean. It is `/review-and-fix` that never fixes. It never requests changes, merges, pushes to the branch, or posts outside the pull request, and it runs only for a pull request the user named.

## Scope

The skill is Claude-only. It lives in `plugins/concord/skills/review-until-approve/` and is not copied into the Codex or Copilot packages, because its wait needs the Monitor tool and can last days. It runs the review through `runReviewUntilGreen` in `plugins/concord/core/codex-review-runner.js` with `reviewOnly: true`, the same runner `services/pr-review` uses, so there is no second reviewer implementation. `services/` is not part of the installed plugin, so the skill re-implements the publication contract of `services/pr-review/review-one.sh` (finding format, inline-only-in-hunk rule, body fallback, head re-check, credential refusal) instead of sourcing it.

The decisions below are the conclusions of the Opus design pass.

## Round procedure

| Step | Rule | Reason |
|---|---|---|
| Round 1 | Broad review of the PR head against the merge base, requirements from the PR title and body | Same procedure as `/review-and-fix` |
| Checkout | Fresh full clone in a temporary directory, exact head SHA, review run with an allowlisted environment (`PATH`, locale, proxy and certificate variables, the Codex home for its auth) and an empty `HOME`; the Codex profile also denies every entry of the real home directory except the way to the checkout and the review's own directories, and the real `CLAUDE_CONFIG_DIR` when it lies outside the home. The reviewer holds no GitHub or other credential, and the account's credential files (gh, ssh, cloud, Claude, Codex) are not readable by absolute path | The checkout is untrusted, and a prompt injection could otherwise read a credential file and quote it in a published finding. Checked against a decoy file in the real home: readable under the profile without the deny entries, refused with them. Entries created in the home after the review starts are not denied |
| Reviewer | `codex` only; `start` refuses `--reviewer claude` | The Codex profile can deny the real home. A Claude reviewer got only the environment allowlist and an empty `HOME`, which does not stop an absolute-path read, and a `--settings` restriction could not be verified here: the check that tells a reviewer model to read a decoy outside its checkout was stopped by the safety classifier, there is no `CLAUDE_CODE_OAUTH_TOKEN` in this environment, and `socat`, which the Claude sandbox may need for its network proxy, is not installed. A later change may lift the refusal with a verified restriction |
| Later round range | `chooseRange`: same merge base and the last head an ancestor of the new head gives `last head..head`; otherwise `merge base..head`; a changed PR title or body gives `merge base..head` with the broad gate | A force push or a merged-in base branch has no isolatable delta; a changed requirement needs the gate again |
| Earlier findings | Open findings are passed as reviewer guidance ("raise it again with the same id if still present"). `classifyPrior` keeps one open when it was raised again (same span, or the same file and id with another span), when the reviewer was not told about it (at most 20 are listed), or when its file is untouched: in a push-only round whatever the span looks like, since the reviewer never saw the file and a span the engine could not quote verbatim is no evidence, and in a whole-diff round while the span still occurs. Otherwise it is fixed | An unchanged span alone does not disprove an additive fix, so a touched file needs the reviewer to raise it again; silence about a file the reviewer did not see, or a finding it was not told about, fixes nothing. A span path outside the checkout or through a symlink counts as absent |
| Publication | One review per round, `commit_id` set to the reviewed head, event `COMMENT`, or `APPROVE` when the round is clean. Never `REQUEST_CHANGES` | The clean round's review is the approval |
| Published finding | Key is the hash of the file and the whitespace-collapsed span, or file plus id when the span is empty. A finding already in the ledger is listed as "Still open", not posted again | A span survives an id the model renamed |
| Fixed finding | The next review body carries one line, "Fixed since `<sha>`: ids" | Replying to or resolving another account's threads is out of scope for the first layer |
| First line | `<!-- concord-approve: <head> round:<n> base:<range base> -->` | `services/pr-review/scan.sh` treats a first line starting with `<!-- concord-review` as scheduling evidence, so the skill uses a different prefix |

## Approval condition

`evaluateApproval` approves exactly when all of these hold: the reviewed head is the live head, the pull request is open and not a draft, the reviewing account is not the author, no approval was already given for this head, and no finding in the ledger is open. The review engine emits no severity, so every verified finding blocks until it is fixed or the user waives it with the `waive` verb. A waived finding is recorded in the ledger and does not block.

Required checks are not part of the condition. Approval is a code-review verdict; merge gating belongs to branch protection. A draft is never approved: the skill tells the user, and invoking it again after the pull request is ready approves the unchanged head without a new round.

## Wait

`scripts/watch.js` reads the ledger without writing it, polls `gh` every 60 seconds, prints one JSON event line, and exits. It is run under Monitor, under `mien exec <profile> --` where the reviewing account is not the ambient one. It spends no model tokens.

| Event | Fires when |
|---|---|
| `round` | The head differs from the last reviewed head and the author replied after the last review, and the head was the same on two consecutive polls |
| `merged`, `closed` | The pull request reached that state |
| `nudge` | Only a push, or only a reply, has arrived and 24 hours have passed since the last review. It repeats only for a new head or reply, and posts nothing; the session tells the user |
| `timeout` | 7 days since the last review |
| `error` | Ten consecutive failed polls (exit status 1) |

A reply is a comment by the pull request author after the last review, either in a thread of a review the skill published (`in_reply_to_id` is one of its comment ids) or on the pull request conversation, which is the only way to answer a finding posted in a review body. Who pushed does not matter. A push or reply alone, a CI change, a label, or a comment by anyone but the author wakes nothing. A user stop ends the Monitor and is recorded in the ledger. At most 10 rounds run per pull request, and nothing is posted on any stop.

## State

One JSON file per repository, pull request and reviewing account at `${REVIEW_APPROVE_STATE_DIR:-${CLAUDE_CONFIG_DIR:-~/.claude}/concord/review-until-approve}/<owner>__<repo>__<pr>__<login>.json`, outside any checkout, written atomically, locked by process id so a second session on the same pull request is refused. It holds the reviewing account, the author, `rounds[]` (head, range base, merge base, requirement hash, submission time, review id, comment ids), `findings[]` (key, id, category, file, span, summary, status `open|fixed|waived`), `nudged`, `approval`, `stopped`, and `pending` (the head, the newest review id before the post, the round about to be recorded and the findings it would leave, written alone before an `APPROVE` is posted and removed once the review is recorded; the ledger's own findings change only when the review is recorded). What happened since the last review is derived from GitHub on every poll, never stored. Invoking the skill again on a pull request with a ledger resumes it: a moved head runs a round at once, since the invocation is the user's request; otherwise the watch restarts.

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
| force push, merged-in base, changed requirement | next round | whole-PR range, gate only when the requirement changed | introduced | `chooseRange` tests |
| finding with a renamed id | next round | recognized by span, not posted twice | introduced | `isPublished` test |
| open findings, head changed | next round | file touched and not raised again is fixed | introduced | `classifyPrior` test |
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
| push-only round, finding on an untouched file whose span is not in the file | next round | finding stays open, no approval | changed | `a push to another file does not fix a finding whose span the file does not contain verbatim` |
| more than 20 open findings | next round | findings the reviewer was not told about stay open | introduced | `a finding the reviewer was not told about (past the twenty listed) is not fixed by its silence` |
| finding raised again with another span, same file and id | next round | stays open, not posted again | changed | `a finding raised again with a different span is neither listed fixed nor posted as new` |
| span path outside the checkout or through a symlink | next round | counts as absent | introduced | `a finding whose file path leaves the checkout, or runs through a symlink` |
| `--reviewer claude` | `start` | refused, no ledger written | introduced | `start refuses the claude reviewer` |
| another session holds the ledger lock | `round`, `approve`, `waive` | refused | introduced | untested, because it needs two live processes; the lock reuses `core/run-lock.js` |

Combinations the ledger lock rules out (two sessions interleaving on one pull request) are refused at start.
