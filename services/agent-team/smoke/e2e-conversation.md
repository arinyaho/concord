# Manual e2e: multi-role conversation (real Discord, network, real LLM calls)

This is a manual runbook, not an automated test. It exercises the live gateway connection, a real Discord thread, and the tool-less conversation roles (Spec, Reviewer) end to end. Run it after any change that touches `src/daemon/conversation*.mjs`, `src/daemon/roles.mjs`, `src/daemon/session_store.mjs`, `src/daemon/thread_gate.mjs`, `src/daemon/select_round.mjs`, or the conversation wiring in `bin/agent-team-daemon.mjs`.

For a no-network check of the handler/turn-engine wiring alone, run `node smoke/conversation-contract.mjs` instead -- it does not require any of the setup below.

## Preconditions

- Same Discord application, bot, and **author-only private guild** as `smoke/e2e-daemon.md`'s "Preconditions" -- Message Content Intent enabled, bot token in the Keychain, no other members in the guild besides the author and the bot (see README.md "Discord daemon (3b-2)" -> "Conversation channels (B-1)" for why this matters: the daemon does not screen thread members, it trusts the guild is author-only).
- Bot invited with **Create Public Threads** and **Send Messages in Threads** permission, in addition to the base scopes from `smoke/e2e-daemon.md`. Without these the bot can read the conversation channel but `msg.startThread(...)` fails.
- Config JSON has a non-empty `conversationChannelIds` array containing a channel ID distinct from `channelId` (the capability channel), plus `sessionStorePath` (an absolute path the daemon process can write) and optionally `maxRoundLen`. See README.md "Conversation config fields".
- A conversation channel from `conversationChannelIds` created in the guild and pinned/labeled so you know which one is which.
- Daemon started per `smoke/e2e-daemon.md`'s "Daemon started" step (same command; the conversation path is wired into the same `bin/agent-team-daemon.mjs`).

## Case (a): a design question starts a thread with Spec and Reviewer replies

1. From the authorized account, post an open-ended design question in a conversation channel, e.g. `how should we rate-limit the public JSON API?`.
2. Expect a new thread to be created off that message, named after the message content.
3. Expect a Spec reply in the thread labeled `**spec:** ...`.
4. Expect a Reviewer reply in the thread labeled `**reviewer:** ...` unless Reviewer judged the turn outside its concern and self-skipped (see case (c)) -- for an open design question, both roles should normally reply.

## Case (b): a follow-up in the thread resumes coherently

1. In the thread from case (a), post a follow-up that references what Spec or Reviewer just said, e.g. `what if the rate limit needs to vary per API key tier?`.
2. Expect Spec and/or Reviewer to reply again, and confirm the reply actually engages with the follow-up content (not a generic restatement) -- this confirms each role's session was resumed (`state.roleSessions[name]`) rather than started fresh.

## Case (c): an off-topic message makes a role self-skip

1. In the thread, post a message clearly outside one role's concern, e.g. something purely about UI copy (outside Reviewer's engineering-risk concern) or something with no open design question at all (outside Spec's concern).
2. Expect the daemon to post from at most one role -- the other role's `SKIP` reply must NOT appear as a message in the thread (the dispatcher only posts non-skip outputs; a `SKIP` marker is a "no reply", not a visible post).

## Case (d): restarting the daemon mid-conversation resumes on the next turn

1. Mid-conversation (after at least one turn has completed, so `sessionStorePath` has a persisted entry for the thread), stop the daemon (Ctrl-C, or `launchctl unload` if running under launchd).
2. Restart the daemon with the same `AGENT_TEAM_CONFIG` (same `sessionStorePath`).
3. Post a follow-up in the same thread.
4. Expect a coherent reply (as in case (b)) -- this confirms `loadStore` rehydrated `roleSessions` from disk and the turn resumed each role's session rather than starting over.

## Case (e): an expired session starts fresh with a visible note

1. Using a thread whose per-role session id has expired or become invalid (e.g. force this by editing the session store file on disk to set a role's session id to a bogus value while the daemon is stopped, then restart), post a follow-up in that thread.
2. Expect the role whose session was invalid to post a `(session reset)` notice (per `advanceTurn`'s `res.reset` handling) followed by a fresh, coherent reply -- not a silent failure and not an error notice.

## Cleanup

- Delete or archive the threads created during this run if they should not be kept.
- If you edited the session store file on disk for case (e), confirm the daemon is stopped before editing and note the daemon will rewrite the whole file on the next `saveThread` call.
- If running the daemon directly (not under launchd), stop it (Ctrl-C); if under launchd, `launchctl unload ~/Library/LaunchAgents/com.agent-team.daemon.plist` if you do not want it to keep running.
