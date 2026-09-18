---
name: review-until-lgtm
description: Use when an open GitHub PR must be monitored until the GitHub Codex bot gives an explicit LGTM reaction, rather than merely completing its review.
---

# Review until LGTM

Use this after implementation and ordinary review are complete. It is a GitHub observation loop, not a replacement for `review-until-green`, and it does not edit source or merge a PR.

## Observe the current review

1. Resolve and record the exact PR head SHA before requesting or judging a review. Inspect only reviews, summary comments, threads, and reactions attached to that exact commit; ignore stale results.
2. If no review is pending or has completed for that SHA, request one review once through the repository's configured GitHub Codex mechanism. Do not send a request on every poll.
3. Poll GitHub with the configured authenticated GitHub CLI profile. A matching review is a completed review authored by GitHub Codex and bound to the exact head SHA. Record its completion state, its summary, unresolved threads authored by that same bot, and whether that bot added the configured explicit LGTM reaction to that summary.

## Decide and stop

Report green only when the matching review completed, its bot threads are resolved, and its summary has the configured LGTM reaction (for example, `THUMBS_UP`).

A matching review that completed with no open bot threads but no LGTM reaction is `completed-without-lgtm`; it is not green. Do not fabricate a reaction, modify code, or claim that completion implies approval.

For an in-progress matching review, wait within a bounded monitoring window. For a stale review, start over from the current head. For a genuine, in-scope bot finding, handle it through the normal implementation and review flow, then observe the new head SHA.

After `completed-without-lgtm`, make at most one additional review request for the same exact PR head SHA. If the reaction is still absent, stop and report that named external outcome. Do not post repeated requests or retry indefinitely.

## Handoff

State the PR, exact PR head SHA, matching review completion state, open bot-thread count, LGTM-reaction presence, and request count. A `completed-without-lgtm` result must remain visibly not green so the caller can decide whether to wait, escalate, or accept a different gate.
