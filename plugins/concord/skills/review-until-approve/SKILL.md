---
name: review-until-approve
description: >-
  Use when the user names someone else's pull request and wants it reviewed in a loop: review it, publish the findings,
  wait without spending tokens until the author pushes and replies, review what changed, and approve once a round is clean —
  "이 PR 승인될 때까지 리뷰해줘", "review this PR until it is approvable", "watch the PR and approve when clean".
  Do NOT use for your own branch (use review-and-fix) or to collect other reviewers' comments on your own PR (use review-until-lgtm).
---

# Review until approve

`/review-and-fix` that never fixes. You review a pull request you did not write, publish the verified findings as one review per round, wait for the author, review the delta, and approve the reviewed head when nothing blocks. You never request changes, merge, push to the branch, run a command the pull request provides, or post anywhere but that pull request. Use this skill only for a pull request the user named.

The decisions behind each step are in `docs/design/review-until-approve.md`.

## Setup

- `SCRIPTS` is the `scripts/` directory next to this file. Resolve the installed path first; do not assume a layout.
- Every command below runs as the reviewing account: prefix it with `mien exec <profile> --` when the user names a profile, otherwise the ambient `gh` account reviews. The account must not be the pull request's author.
- `round` and `watch` call GitHub and, with the default Codex reviewer, start `codex exec`; give them network access.
- The reviewer is the harness's own: `claude` under Claude Code, `codex` under Codex; `--reviewer` overrides. The Claude reviewer can read the account's real home directory (gh, ssh and cloud credentials), and a malicious pull request could make it publish their contents, so `start` refuses it unless the user accepts that with `--allow-unrestricted-home`; every result then carries a warning, which you relay to the user. The Codex reviewer is kept from the real home. `claude` needs `CLAUDE_CODE_OAUTH_TOKEN` in the environment; `codex` must be installed and logged in.

## Loop

1. `node "$SCRIPTS/approve.js" start <owner/repo> <pr> [--reviewer codex|claude [--allow-unrestricted-home]] [--model <m>]` checks the account, opens or resumes the ledger, and prints `{ledger, action}`. It refuses a pull request that is not open and an account that is the author. Relay a `warning` to the user.
2. `action: "round"`: run `node "$SCRIPTS/approve.js" round <owner/repo> <pr>` in the foreground; it takes minutes. It clones the exact head into a temporary directory, runs the review-only engine without your GitHub token, publishes one review, and approves in the same review when the round is clean. Its last line is the outcome:
   - `published` with `review: "APPROVE"`: tell the user the head is approved and stop.
   - `published` with `review: "COMMENT"`: tell the user the finding counts in one line, then wait (step 4). A `held` list names open findings that no code change can settle (`unverified`: the reviewer's quote is not verbatim in the file; `path-unresolved`: the file cannot be read at the new head); relay it with its `hint`, because only `waive` clears them and the PR is never approved while they are open. `notApproved: "draft"` means a clean round on a draft pull request: the watch does not see a draft turning ready, so tell the user to re-invoke the skill once the pull request is ready (`start` then answers `action: "approve"`) and stop instead of waiting.
   - A non-zero exit: the message is on stderr (another session holds the ledger, a credential was found in the review text and nothing was posted, the runner failed). Tell the user and stop; do not retry in a loop.
   - `round-limit`, `merged`, `closed`, `head-keeps-moving`: tell the user and stop.
3. `action: "watch"`: the head was already reviewed and nothing blocks or approves it yet; go to step 4.
   `action: "approve"`: the reviewed head is clean but was not approved (it was a draft). Run `node "$SCRIPTS/approve.js" approve <owner/repo> <pr>`; it posts the approval only if the condition holds; otherwise it prints `{"event":"not-approved","reason":...}`, which you relay to the user.
4. Wait: start `node "$SCRIPTS/watch.js" <ledger> <owner/repo> <pr>` with Monitor and do nothing else; it spends no model tokens. It prints one JSON line and exits. On that line:
   - `round`: go to step 2 (`start` first, so the ledger and account are re-checked).
   - `merged` or `closed`: tell the user and stop.
   - `nudge`: only a push or only a reply arrived in 24 hours. Run `node "$SCRIPTS/approve.js" nudged <owner/repo> <pr> '<the nudge line>'` first, so a restarted watch stays silent until a new head or reply. Tell the user which, and ask whether to keep waiting or `waive` a finding they consider answered. Restart the watch if they want to keep waiting.
   - `timeout`: 7 days passed since the last review. Tell the user; the ledger stays resumable.
   - `error`: tell the user the detail and stop.
5. A stop request from the user: stop the Monitor, run `node "$SCRIPTS/approve.js" stop <owner/repo> <pr>`, and post nothing.

## Findings the user disputes

Every verified finding blocks approval, because the review engine emits no severity. A finding is fixed only when its quoted span occurred verbatim in the file at the head it was recorded against and no longer occurs at the new head, read from git objects; the reviewer's silence never fixes one. A finding the code cannot settle stays open until the user waives it. When the user decides a finding does not block, run `node "$SCRIPTS/approve.js" waive <owner/repo> <pr> <finding-id>` (the `key` from the `open` or `held` list when the id belongs to more than one open finding; the command refuses an ambiguous id): it records the waiver and approves the reviewed head if nothing else blocks. Never waive on your own judgment.

## What a round publishes

One review per round, with `commit_id` set to the reviewed head and event `COMMENT`, or `APPROVE` when the round is clean. Findings sit inline where the line is in the reviewed diff and in the body otherwise. A finding that is already published is listed as "Still open", not posted again. A finding that is no longer present is listed as "Fixed since `<sha>`". A later round reviews only the commits since the last reviewed head; a force push, a merged-in base branch, or a changed title or body widens it as the design note says.
