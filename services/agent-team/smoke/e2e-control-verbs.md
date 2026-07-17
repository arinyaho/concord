# Manual e2e: control verbs (real Discord, network, real container job)

This is a manual runbook, not an automated test. It exercises the four
author-gated control verbs (`/cancel <id>`, `/status`, `/clear`,
`/rename <name>`) against a live daemon, a real Discord guild, and a real
capability job. Run it after any change that touches
`src/daemon/control_verbs.mjs`, the dispatch wiring in
`src/daemon/conversation_dispatch.mjs`, or `src/daemon/queue.mjs`.

For a no-network check of the parser/handler contract alone, run
`node smoke/control-verbs-contract.mjs` instead -- it does not require any of
the setup below.

## Preconditions

Same daemon setup as `smoke/e2e-daemon.md` ("Preconditions"): bot invited to
a private guild with Message Content Intent, config JSON in place, bot token
in Keychain, creds dir seeded, container runtime running, daemon started
(directly or under launchd).

## Case (a): `/status` shows a running job

1. As the authorized account, post a task in the capability channel that
   takes long enough to observe in flight, e.g. `concord: sleep for 30
   seconds then report done`.
2. Expect the usual ack reply: `queued #<jobId>: concord -- ...`. Note the
   `<jobId>`.
3. While the job is still running, post `/status` in any tracked thread (the
   thread the job was dispatched from, or a conversation thread).
4. Expect a reply listing the job under `running`, in the form `running
   <jobId> (thread <threadId>) concord: <task clip>`.

## Case (b): `/cancel <id>` frees the slot, acks, and the origin thread shows a cancelled result

1. With the job from case (a) still running, post `/cancel <jobId>` (same
   thread or any tracked thread -- cancel is global by id, not scoped to the
   thread that dispatched the job).
2. Expect an immediate ack in the thread the `/cancel` was posted from:
   `cancelled <jobId>`.
3. Expect the **originating** thread (the one the job was dispatched from in
   case (a), if different from where `/cancel` was posted) to receive a
   `cancelled (<jobId>)` result -- this is best-effort: the daemon signals
   the container to stop and reports the outcome, but does not guarantee the
   container process itself has exited by the time the message posts.
4. Confirm the daemon's job slot is free: post another task and confirm it
   starts immediately rather than queuing behind the cancelled job (check
   `docker ps` for the cancelled container no longer running, or the daemon
   log for the kill).

## Case (c): `/clear` drops a pending delegated action

1. In a conversation channel/thread, get a role to emit a `DISPATCH
   <alias> :: <task>` proposal (see `smoke/e2e-delegated-actions.md` case
   for how to prompt one), producing a pending action with a confirm prompt
   `Proposed job <id> on <alias> ...`.
2. Before replying `run <id>`, post `/clear` in the same thread.
3. Expect a reply: `cleared`.
4. Confirm the pending action is gone: replying `run <id>` afterward should
   be treated as a stale/unmatched reply (no job dispatched), not the
   original proposal.

## Case (d): `/rename <name>` renames the thread

1. In any tracked thread, post `/rename triage-followup`.
2. Expect the thread's name to change to `triage-followup` in the Discord
   UI.
3. Expect a reply in the thread: `renamed`.

## Case (e): `/status` with `@everyone` in a tracked task does not ping

1. Dispatch a task whose text contains the literal string `@everyone`, e.g.
   `concord: rename the @everyone role check function`.
2. While it is running (or queued), post `/status`.
3. Expect the status reply to include the task text verbatim (clipped to 60
   chars) but **not** trigger a `@everyone` mention notification -- no push
   notification/highlight for other guild members, and the message shows
   `@everyone` as plain text, not a resolved mention. This confirms
   `channel.send` is used with `allowedMentions: { parse: [] }` rather than
   the normal reply path.

## Case (f): `/cancel` on an unknown id is a no-op with a clear message

1. Post `/cancel zzz` where `zzz` does not match any running or queued job
   id.
2. Expect a reply: `no such job zzz`.
3. Confirm no job slot changes state and no container is affected (check
   `docker ps` / daemon log shows nothing new).

## Cleanup

- Cancel or let finish any jobs left running from cases (a)/(e).
- Rename the thread from case (d) back if it should not be kept.
- Delete the creds dir and any throwaway repos under `~/.agent-team/` used
  for this run.
- Delete any `agent-team/<jobId>` branches created during this run from the
  target repo clone if they should not be kept.
- Stop the daemon (Ctrl-C) or unload the launchd job if it should not keep
  running.
