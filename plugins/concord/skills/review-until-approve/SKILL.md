---
name: review-until-approve
description: >-
  Use when the user names someone else's pull request and wants it reviewed in a loop: review it, publish the findings,
  wait for the author to push and reply (one small model call per two-hour window on Claude Code, bounded foreground windows on Codex), review what changed, and approve once a round is clean —
  "이 PR 승인될 때까지 리뷰해줘", "review this PR until it is approvable", "watch the PR and approve when clean".
  Do NOT use for your own branch (use review-and-fix) or to collect other reviewers' comments on your own PR (use review-until-lgtm).
---

# Review until approve

`/review-and-fix` that never fixes. You review a pull request you did not write, publish the verified findings as one review per round, wait for the author, review the delta, and approve the reviewed head when nothing blocks. You never request changes, merge, push to the branch, run a command the pull request provides, or post anywhere but that pull request. Use this skill only for a pull request the user named. Keep what you say to one line per phase: the reviewer note, each round's outcome, the final verdict. Say nothing between watch windows (a window that ends with `idle` or a killed run is not an event) and do not repeat a warning you already relayed in this run.

The decisions behind each step are in `docs/design/review-until-approve.md`.

## Setup

- `SCRIPTS` is the `scripts/` directory next to this file. Resolve the installed path first; do not assume a layout.
- Every command below runs as the reviewing account: prefix it with `mien exec <profile> --` when the user names a profile, otherwise the ambient `gh` account reviews. The account must not be the pull request's author.
- `round` and `watch` call GitHub and, with the default Codex reviewer, start `codex exec`; give them network access.
- `start` picks the reviewer and says which in `reviewer` and, when it is not the harness's own, in a one-line `note`: relay the note once, as it is. Without `--reviewer` it uses the harness's own (`claude` under Claude Code, `codex` under Codex) when that is ready, otherwise the other one. `--reviewer` and a resumed ledger are kept: if that reviewer is not ready, `start` refuses and names what is missing. `codex` is ready when it is installed and logged in; `claude` only when the user has turned it on and a Claude login exists (a `.credentials.json` in the Claude configuration directory, or `CLAUDE_CODE_OAUTH_TOKEN`; it runs as you and no token needs setting when you are logged in on a file-based host). The Claude reviewer can read the account's real home directory (gh, ssh and cloud credentials) and a malicious pull request could make it publish their contents, so it is off by default and the user alone turns it on, by adding `CONCORD_REVIEW_UNCONFINED_CLAUDE=1` under `env` in their own `~/.claude/settings.json`; `start` reads that file on every `start` and `round`, so removing the key turns it off at once. When the user wants the Claude reviewer, explain that risk in one sentence and ask them to add the setting; never type a flag, set a variable, add a permission rule or edit a settings file to turn it on. If a command is denied (an auto-mode classifier or a permission prompt), relay the denial to the user and stop; do not retry the same command or look for another way. Every result of a Claude run carries a warning, which you relay to the user. The Codex reviewer is kept from the real home. When no reviewer is ready, `start` fails with one line per reviewer: tell the user those lines and stop.

## Loop

1. `node "$SCRIPTS/approve.js" start <owner/repo> <pr> [--reviewer codex|claude] [--model <m>]` checks the account, opens or resumes the ledger, and prints `{ledger, action, reviewer, note?}`. It refuses a pull request that is not open and an account that is the author. Relay a `warning` to the user.
2. `action: "round"`: run `node "$SCRIPTS/approve.js" round <owner/repo> <pr>` in the foreground; it takes minutes. It clones the exact head into a temporary directory, runs the review-only engine without your GitHub token, publishes one review, and approves in the same review when the round is clean. Its last line is the outcome:
   - `published` with `review: "APPROVE"`: tell the user the head is approved and stop.
   - `published` with `review: "COMMENT"`: tell the user the finding counts in one line, then wait (step 4). A `held` list names open findings that no code change can settle (`unverified`: the reviewer's quote is not verbatim in the file; `path-unresolved`: the file cannot be read at the new head); relay it with its `hint`, because only `waive` clears them and the PR is never approved while they are open. `unreviewed` lists submodule ranges that could not be read (`path`, `from`, `to`, `reason`: `url`, `path`, `unreadable`, `audience`, `fetch`, `nested`) with `notApproved: "unreviewed-submodule"`: relay them, because the PR is not approved while one remains and only a push (or a reviewer with access) clears it. `notApproved: "draft"` means a clean round on a draft pull request: the watch does not see a draft turning ready, so tell the user to re-invoke the skill once the pull request is ready (`start` then answers `action: "approve"`) and stop instead of waiting.
   - A non-zero exit: the message is on stderr (another session holds the ledger, a credential was found in the review text and nothing was posted, the runner failed). Tell the user and stop; do not retry in a loop.
   - `round-limit`, `merged`, `closed`, `head-keeps-moving`: tell the user and stop.
3. `action: "watch"`: the head was already reviewed and nothing blocks or approves it yet; go to step 4.
   `action: "approve"`: the reviewed head is clean but was not approved (it was a draft). Run `node "$SCRIPTS/approve.js" approve <owner/repo> <pr>`; it posts the approval only if the condition holds; otherwise it prints `{"event":"not-approved","reason":...}`, which you relay to the user.
4. Wait, by harness (the ledger path is in `start`'s output):
   - Claude Code: build this command once, with absolute paths, and run it with Bash `run_in_background` and `timeout: 7200000` (the background default of 30 minutes would kill it early; the 600 seconds beyond `--max-wait` are the margin): `node "$SCRIPTS/watch.js" <ledger> <owner/repo> <pr> --max-wait 6600`. Note the background task id and do nothing else until it exits; each exit wakes you with one small model turn. When a window ends, run the same command again, verbatim, and say nothing to the user: `idle` is a window, and so is a run with no JSON line that was killed (host timeout, exit 137 or 143). A run with no JSON line that exited on its own with another non-zero code is a failure: tell the user and stop. Only `timeout` or a user stop ends the wait; never end it on your own because time passed. Never edit, wrap or replace `watch.js`, and never write your own polling loop.
   - Codex: there is no background watch that wakes the conversation, so wait in the foreground in bounded windows. Run `node "$SCRIPTS/watch.js" <ledger> <owner/repo> <pr> --max-wait 540` (shorter if the shell tool times out earlier) and read its one JSON line. `idle` means nothing happened in the window: run the same command again, and say nothing to the user between windows. Each window costs one small model call, so this wait is cheap but not free; after 6 windows in a row (about an hour) tell the user in one line that the wait continues, and keep going unless they stop it. A host that cannot run a foreground command this long cannot run this skill to completion: tell the user and stop after the first review.
   The watch prints one JSON line and exits. On that line:
   - `round`: go to step 2 (`start` first, so the ledger and account are re-checked).
   - `merged` or `closed`: tell the user and stop.
   - `nudge`: only a push or only a reply arrived in 24 hours. Run `node "$SCRIPTS/approve.js" nudged <owner/repo> <pr> '<the nudge line>'` first, so a restarted watch stays silent until a new head or reply. Tell the user which, and ask whether to keep waiting or `waive` a finding they consider answered. Restart the watch if they want to keep waiting.
   - `idle`: a window ended with no event; run the same command again, as described for each harness above.
   - `timeout`: 7 days passed since the last review. Tell the user; the ledger stays resumable.
   - `error`: tell the user the detail and stop.
5. A stop request from the user: stop the background task with TaskStop (Claude Code), run `node "$SCRIPTS/approve.js" stop <owner/repo> <pr>`, and post nothing.

## Findings the user disputes

Every verified finding blocks approval, because the review engine emits no severity. A finding is fixed only when its quoted span occurred verbatim in the file at the head it was recorded against and no longer occurs at the new head, read from git objects; the reviewer's silence never fixes one. A finding the code cannot settle stays open until the user waives it. When the user decides a finding does not block, run `node "$SCRIPTS/approve.js" waive <owner/repo> <pr> <finding-id>` (the `key` from the `open` or `held` list when the id belongs to more than one open finding; the command refuses an ambiguous id): it records the waiver and approves the reviewed head if nothing else blocks. Never waive on your own judgment.

## What a round publishes

One review per round, with `commit_id` set to the reviewed head and event `COMMENT`, or `APPROVE` when the round is clean. The review header reads `reviewed by concord (<engine>)`. Findings sit inline where the line is in the reviewed diff and in the body otherwise; a finding the engine gave no line is placed where its span occurs inside a hunk of its file. A finding that is already published is listed as "Still open", not posted again. A finding that is no longer present is listed as "Fixed since `<sha>`". A later round reviews only the commits since the last reviewed head; a force push, a merged-in base branch, or a changed title or body widens it as the design note says.
