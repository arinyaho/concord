---
description: Repeatedly review a branch or PR, fix what the review finds, and re-check -- looping until the tests actually pass, or handing back the few things a person has to decide. The loop's state is saved, so a later session picks up where this one stopped. It reviews AND fixes AND repeats, unlike a one-shot review; the reviewing, verifying, and fixing happen as subagents spawned inline in this session (no separate headless process), driven step by step by a deterministic CLI that owns rounds, dedupe, and termination. Use when the user wants a change taken all the way to passing -- "review and fix my branch until it passes", "keep reviewing and fixing until it's green", "make this mergeable", "get this to LGTM", "run review until green". For a single review with no fixes, use /code-review instead.
argument-hint: "[target | resume <ref>]"
---

The review CLI lives at `${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js`. It is the deterministic authority on rounds, dedupe, and termination; you drive it and spawn the review/fix subagents, but you make NO judgement about findings, DoD, or when to stop -- the CLI decides.

Arguments: `$ARGUMENTS`

Determine the target ref: empty -> current branch (`git branch --show-current`); `resume <ref>` -> the ref after `resume`; else the arguments as-is. Optional base ref is the second token (default the repo's main branch).

Run this loop. Do each step in order; do not skip, reorder, or improvise termination.

1. `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" round-start <ref> [base]`
   - `decision: "terminal"` or `"no-op"` -> stop; report the CLI's message.
   - `decision: "work"` -> continue. Note the `round` number `n` and the `stateDir` path it prints -- `stateDir` is the CLI-owned directory for this run's artifacts; every path below is relative to it.
2. Read the diff at `<stateDir>/round-<n>-diff.txt` (the file round-start just wrote). Spawn ONE correctness review subagent (Task tool, general-purpose, a CLEAN context -- do not paste your own prior reasoning). Instruct it to review the diff for correctness bugs, reuse/simplification/efficiency, AND verifier-gaming (hardcoded literals matching test inputs, weakened/deleted assertions, output emitted before the check runs, whether a fix explains WHY a test passes not just that it does). It MUST write ONLY to `<stateDir>/round-<n>-correctness.json` the JSON `{ "status":"ok", "examined":[<every changed file path it looked at>], "findings":[ {"id":"correctness:<stable-slug>","gate":"correctness","file":"<path>","span":"<exact offending text>","summary":"<one sentence>"} ] }` -- empty `findings` array if nothing. The `id` is a stable slug reused for the same bug across rounds.
3. Spawn ONE verify subagent (clean context) to re-review the candidate findings against the diff and write ONLY `{ "status":"ok", "rejected":["<id>", ...] }` to `<stateDir>/round-<n>-verify.json` (ids it judges false positives).
4. `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" plan-fixes <ref>` -> `{ fixes: [{id, file, span, summary}, ...] }`.
5. For EACH fix in order (sequentially, one at a time -- never in parallel; two fixes may touch the same file): spawn a fix subagent that applies the minimal correct fix by editing the working tree, then writes ONLY `{ "status":"ok", "edited": true }` to `<stateDir>/round-<n>-fix-<id>.json` (`edited:false` if it decided no change was warranted). Wait for it, then immediately run `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" commit-fix <ref> <id>` -> `{committed, sha?, reason?}` BEFORE spawning the next fix subagent -- this commits only that one fix's edit while it is the sole uncommitted change, so two fixes touching the same file land as two separate, correctly attributed commits.
6. `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" record <ref>` -> `{ decision, handoff }`.
   - `decision.continue: true` -> go to step 1 for the next round.
   - `decision.continue: false` -> print the `handoff` verbatim and stop.

Never run more rounds than the CLI drives; the CLI enforces the round budget, the park-budget breaker, and convergence. If a CLI verb exits non-zero with a `harness-failure:` message, stop and report it plainly -- do NOT characterize the run as clean or parked.

If a ledger for this ref is already `parked`, tell the user resuming will NOT auto-re-run parked findings; they must `review-cli.js unpark <ref> <findingId>` first.
