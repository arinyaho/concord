# review-until-approve

`review-until-approve` reviews someone else's pull request the way `/review-and-fix` reviews a branch, publishes the verified findings, waits at no token cost until the author pushes and replies, reviews what changed, and approves the pull request once a round is clean. It is `/review-and-fix` that never fixes. It never requests changes, merges, pushes to the branch, or posts outside the pull request, and it runs only for a pull request the user named.

## Scope

The skill is Claude-only. It lives in `plugins/concord/skills/review-until-approve/` and is not copied into the Codex or Copilot packages, because its wait needs the Monitor tool and can last days. It runs the review through `runReviewUntilGreen` in `plugins/concord/core/codex-review-runner.js` with `reviewOnly: true`, the same runner `services/pr-review` uses, so there is no second reviewer implementation. `services/` is not part of the installed plugin, so the skill re-implements the publication contract of `services/pr-review/review-one.sh` (finding format, inline-only-in-hunk rule, body fallback, head re-check, credential refusal) instead of sourcing it.

The decisions below are the conclusions of the Opus design pass.

## Round procedure

| Step | Rule | Reason |
|---|---|---|
| Round 1 | Broad review of the PR head against the merge base, requirements from the PR title and body | Same procedure as `/review-and-fix` |
| Checkout | Fresh full clone in a temporary directory, exact head SHA, review run with `GH_TOKEN` and `GITHUB_TOKEN` removed from the environment | The checkout is untrusted; the reviewer never holds the token |
| Reviewer | `codex` by default; `claude` only with an empty `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` set | The Codex reviewer is isolated by the engine; a Claude reviewer would otherwise load the user's own allow-lists and hooks |
| Later round range | `chooseRange`: same merge base and the last head an ancestor of the new head gives `last head..head`; otherwise `merge base..head`; a changed PR title or body gives `merge base..head` with the broad gate | A force push or a merged-in base branch has no isolatable delta; a changed requirement needs the gate again |
| Earlier findings | Open findings are passed as reviewer guidance ("raise it again with the same id if still present"). `classifyPrior` keeps one open when it was raised again, or when its file is untouched and its span still occurs at the new head; otherwise it is fixed | An unchanged span alone does not disprove an additive fix, so a touched file needs the reviewer to raise it again |
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

One JSON file per repository, pull request and reviewing account at `${REVIEW_APPROVE_STATE_DIR:-${CLAUDE_CONFIG_DIR:-~/.claude}/concord/review-until-approve}/<owner>__<repo>__<pr>__<login>.json`, outside any checkout, written atomically, locked by process id so a second session on the same pull request is refused. It holds the reviewing account, the author, `rounds[]` (head, range base, merge base, requirement hash, submission time, review id, comment ids), `findings[]` (key, id, category, file, span, summary, status `open|fixed|waived`), `nudged`, `approval`, and `stopped`. What happened since the last review is derived from GitHub on every poll, never stored. Invoking the skill again on a pull request with a ledger resumes it: a moved head runs a round at once, since the invocation is the user's request; otherwise the watch restarts.

## Identity

Every `gh` call, read and write, runs as the account the user names (`mien exec <profile> -- gh`, else the ambient account), recorded as the reviewer. A later round under a different account stops. If the account is the pull request author, the skill refuses before round 1, because GitHub rejects self-approval. Approval is `POST repos/{o}/{r}/pulls/{n}/reviews` with `event=APPROVE` and `commit_id`, because `gh pr review --approve` cannot pin the commit and races with a push. An account below write permission is warned that its approval will not satisfy branch protection.

## Unattended deployment

The loop can later run unattended, with GitHub Actions or `services/pr-review` reacting to the push and the reply instead of a session's shell loop. The pure decisions (`chooseRange`, `isPublished`, `classifyPrior`, `evaluateApproval`, `repliesSince`, `wakeDecision`) are in `scripts/lib.js`, and the publication code is separate from the watch. Neither depends on Monitor or a live session. No unattended variant is built.

## Transition table

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| reviewed head, no reply | author pushes | no wake, no round | introduced | `watch: a push alone and a reply alone stay silent` |
| reviewed head, no push | author replies | no wake, no round | introduced | `watch: a push alone and a reply alone stay silent` |
| reviewed head | push and reply, head stable for two polls | one `round` event for the live head; a burst of pushes wakes once | introduced | `watch: a push plus a reply wakes once` |
| any open pull request | merged or closed | `merged` or `closed` event, ledger unchanged | introduced | `watch: a reply on the PR conversation counts, a closed PR wakes` |
| one side only for 24 hours | poll | one `nudge` per head and reply; later polls silent | introduced | `wakeDecision: one side alone nudges once` |
| no activity for 7 days | poll | `timeout` event, ledger resumable | introduced | `wakeDecision: one side alone nudges once` |
| GitHub unreachable | ten consecutive polls | `error` event, exit status 1 | introduced | `watch: ten failed polls end with an error event` |
| force push, merged-in base, changed requirement | next round | whole-PR range, gate only when the requirement changed | introduced | `chooseRange` tests |
| finding with a renamed id | next round | recognized by span, not posted twice | introduced | `isPublished` test |
| open findings, head changed | next round | file touched and not raised again is fixed | introduced | `classifyPrior` test |
| clean round, draft, self-review, moved head, open or waived findings | approval check | approve only when every condition holds | introduced | `evaluateApproval` test |

Combinations the ledger lock rules out (two sessions interleaving on one pull request) are refused at start.
