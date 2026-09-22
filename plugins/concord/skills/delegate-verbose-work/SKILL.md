---
name: delegate-verbose-work
description: >-
  Use before running a broad grep/search sweep (roughly 10+ calls to answer one question) or
  re-Reading a file already read this session, on the main thread. Route that investigation to a
  subagent instead and keep only its conclusion. Triggers: "find every place that...", "search the
  whole repo for...", needing the same file's content again mid-session. Do NOT use for a single
  targeted grep or a file being read for the first time.
---

# Delegate verbose work

A broad search sweep or a repeated file re-read belongs on a subagent's thread, not the main
one. The main thread keeps orchestration, decisions, and concise summaries; a subagent absorbs
the many tool calls and reports back only the conclusion.

## When to delegate

- A question needs many grep/search calls to answer (roughly 10 or more) — "every caller of X",
  "where is Y configured across the repo", broad terminology or convention sweeps.
- A file has already been Read this session — check what you already have before issuing another
  Read; if the prior content is stale or incomplete, delegate the re-check rather than re-Reading
  from the main thread.

## When not to

- One or two targeted greps to confirm a specific claim.
- A file being read for the first time this session.
- The result must inform the very next tool call you make (delegating adds a round trip you can't
  afford there).

## How

Give the subagent the exact question and enough context to answer it standalone, and ask for a
conclusion, not a transcript — "report file paths and line numbers, not the full grep output."
Discard the sweep once you have the conclusion; do not pull it back into the main thread's
context.

If this trigger fires while running under a more specific skill that sets its own delegation
default (for example `ticket-to-pr`'s "keep implementation and review with the active agent; do
not hand either stage to another AI"), that skill's contract wins.
