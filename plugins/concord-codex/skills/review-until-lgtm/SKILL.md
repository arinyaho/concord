---
name: review-until-lgtm
description: Use when an open GitHub PR must be monitored until the GitHub Codex bot gives an explicit LGTM reaction, rather than merely completing its review.
---

# Review until LGTM

Use this after implementation and ordinary review are complete. It is a GitHub observation loop, not a replacement for `review-until-green`, and it does not edit source or merge a PR.

Set `STATE_CLI` to the state script path before polling. A development checkout uses `plugins/concord-codex/bin/review-lgtm-state.js`. An installed host can use its plugin-root variable as a shortcut, but it is not required: use this Node-based locator, which searches the checkout and the common plugin caches without assuming any environment variable: `node -e "const fs=require('fs'),p=require('path'),o=require('os'),q=[process.cwd(),p.join(o.homedir(),'.claude','plugins','cache'),p.join(o.homedir(),'.codex','plugins','cache'),p.join(o.homedir(),'.copilot')];for(const d of q){const s=[d];while(s.length){const x=s.pop();let a;try{a=fs.readdirSync(x,{withFileTypes:true})}catch{continue}for(const e of a){const f=p.join(x,e.name);if(e.isFile()&&e.name==='review-lgtm-state.js'&&['hooks','bin'].includes(p.basename(p.dirname(f)))){console.log(f);process.exit()}if(e.isDirectory())s.push(f)}}}process.exit(1)"`. Set its one-line output as `STATE_CLI`, then invoke every verb as `node "$STATE_CLI" <verb> ...` (PowerShell: `node $STATE_CLI <verb> ...`; cmd.exe: `node "%STATE_CLI%" <verb> ...`), never by executing the `.js` path. Its markers live in the repository git directory, are keyed by PR number and exact head SHA, and make interruptions resumable.

## Observe the current review

1. Resolve the exact PR head SHA before requesting or judging a review. Inspect only reviews, summary comments, threads, and reactions attached to that exact commit; ignore stale results.
2. A matching review is one authored by GitHub Codex and bound to that SHA, regardless of state. Treat bot-authored summary activity naming that SHA as in-progress matching activity when no review object exists; do not request another review. When matching activity is first observed and `status` has no `deadlineMs`, immediately run `node "$STATE_CLI" open-window <pr> <head-sha> 900`; the initial request window bounds both an in-progress review and a completed review waiting for its reaction.
3. Read `node "$STATE_CLI" status <pr> <head-sha>` before requesting. If no matching activity exists, run `node "$STATE_CLI" claim-initial-request <pr> <head-sha>` before requesting the initial review. Request it only when the result is `{"claimed":true}`; a `false` result must poll or reconcile the existing marker, never send a duplicate request. A claim without a sent marker belongs to its original session for a 60-second lease: reconcile matching activity while that lease remains, then run `node "$STATE_CLI" recover-initial-request <pr> <head-sha>` after it expires. Send only when that recovery result is `{"claimed":true}`, then mark it sent and open the initial window. After either successful claim, run `node "$STATE_CLI" mark-initial-requested <pr> <head-sha>` and immediately `node "$STATE_CLI" open-window <pr> <head-sha> 900` only after the request succeeds. On resume, an `initialRequested` marker with no `deadlineMs` must open the same initial window before polling. Do not send a request on every poll.
4. Poll GitHub with the configured authenticated GitHub CLI profile. Record the latest matching review associated with the latest request, its completion state, its summary, unresolved threads authored by that bot, and whether that bot added the explicit LGTM reaction to that summary. Do not combine observations from separate reviews.

## Decide and stop

Report green only when the matching review completed, its bot threads are resolved, and its summary has the configured LGTM reaction (for example, `THUMBS_UP`). A matching review that completed with no open bot threads but no LGTM reaction is `completed-without-lgtm`, not green.

Continue polling only until the current persisted deadline (`deadlineMs` for the initial request, `retryDeadlineMs` for the retry); a resumed session must call `node "$STATE_CLI" status <pr> <head-sha>` and reuse it rather than starting another window. If the deadline arrives while the matching review is still in progress, stop with the named external outcome `review-timeout`; do not retry an unfinished review.

After the initial deadline, only a completed-without-LGTM review may run `node "$STATE_CLI" claim-retry <pr> <head-sha>` before requesting another review. Request the one retry only when it returns `{"claimed":true}`, then run `node "$STATE_CLI" mark-retry-requested <pr> <head-sha>` and immediately `node "$STATE_CLI" open-retry-window <pr> <head-sha> 900` after the request succeeds. A retry claim records `retryClaimedAtMs`. If a resumed session finds a retry claim but no sent marker, reconcile it only with matching GitHub activity created at or after that timestamp; the original matching review cannot satisfy retry reconciliation. Send, mark, and open the retry window only when no such retry-era activity exists. On resume, a `retryRequested` marker with no `retryDeadlineMs` must open the retry window before polling. A sent marker forbids another retry for that exact head. Once the retry deadline expires without LGTM, stop and report `completed-without-lgtm`; do not retry indefinitely. A new head SHA is a new observation attempt. Do not fabricate a reaction or modify code.

## Handoff

State the PR, exact head SHA, matching review completion state, open bot-thread count, LGTM-reaction presence, persisted window deadline, and retry-claim result. A `completed-without-lgtm` result must remain visibly not green.
