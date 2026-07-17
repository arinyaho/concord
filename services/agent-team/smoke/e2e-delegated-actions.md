# e2e runbook: delegated actions (B-2)

Manual, network, real-LLM-and-real-container runbook. This is not automated -- it exercises the
full path (conversation -> proposal -> author confirm -> real capability job -> outcome feedback)
against real Discord, a real container launch, and a real target repo. Run it once after any change
touching `src/daemon/action_*.mjs`, `pending_action.mjs`, `conversation_dispatch.mjs`, or the bin's
outcome-routing discriminator.

## Prerequisites

- A private, author-only Discord guild already set up per the "Discord app setup" section of the
  main README (bot invited, Message Content Intent enabled, guild/channel/user IDs collected).
- A config JSON (`AGENT_TEAM_CONFIG`) with:
  - `repos` containing at least one real, writable repo alias, e.g. `{ "concord": "/Users/you/ccp/concord" }`.
  - `conversationChannelIds` set to a conversation channel (distinct from the capability `channelId`).
  - `sessionStorePath` pointing at a fresh file (delete any stale one before the run so pending-state
    checks below start clean).
- The daemon running against real credentials (see "Container launch" in the main README for the
  creds-dir setup) -- either via `launchd` or run directly in a terminal so you can watch its logs.

## Steps

1. **Start the daemon** and confirm it logs successful startup (config loaded, bot connected, no
   `AGENT_TEAM_CONFIG` validation errors).

2. **Open a conversation and let a role propose an action.** In the configured conversation channel,
   post a message that clearly calls for an actual repo change against the configured alias, e.g.
   "In `concord`, add a one-line comment to the top of README.md explaining what this repo is." The
   daemon opens a thread and Spec and/or Reviewer reply. Converse for a turn or two if needed until a
   role's reply ends with a `DISPATCH <alias> :: <task>` line.

3. **Confirm the daemon posts a confirm prompt.** After the role's reply, the daemon should post
   a system line of the form: `Proposed job <id> on <alias> (<repoPath>): <task>. Reply `run <id>`
   to execute.` Note the `<id>`.

4. **Confirm the action.** Reply in the SAME thread with exactly `run <id>` (the id from step 3).
   The daemon should post `job started (<id>)`.

5. **Watch the job run.** Confirm (via daemon logs, or `docker ps`) that the existing capability
   container job actually launches -- same container runtime, credential isolation, and
   remote-trigger interlock as a task submitted through the capability channel. Confirm the job runs
   in its own clean clone on branch `agent-team/<id>`, not a clone shared with any other job -- there
   is no per-repo lock, so a second job against the same alias would run concurrently rather than
   queue behind this one, bounded only by the daemon's global `cap`.

6. **Confirm outcome feedback.** Once the job finishes, the thread should receive a synthesized
   turn along the lines of `[job result: alias=<alias>, branch=agent-team/<id>, outcome=done,
   summary=...]`, and the daemon's role(s) should react to it in the next turn. Verify the branch
   named in the outcome actually exists in the target repo and contains the expected change.

7. **Verify the no-op paths.** Each of these must leave the conversation otherwise unaffected (no
   job launched, thread still usable for follow-ups):
   - **Unknown alias:** get a role to emit `DISPATCH doesnotexist :: some task` (or edit a test
     config temporarily). The daemon should post a `cannot dispatch: unknown repo alias '...'`
     message and record no pending proposal -- a subsequent `run <anything>` in that thread should
     get `no pending proposal <id>`.
   - **Leading-dash task:** get a role to emit `DISPATCH <alias> :: -rf /`. The daemon should
     reject it (`cannot dispatch: invalid task (may not begin with '-')`) with no pending proposal
     recorded.
   - **Never confirmed:** let a proposal sit without replying `run <id>`. Restart the daemon (to
     confirm durability) and then send an unrelated follow-up message in the thread -- the proposal
     should still be resolvable with the original `run <id>`, and only that exact id should work;
     replying `run` with any other id should get `no pending proposal <id>` rather than running the
     stale proposal.

8. **Verify capability-channel independence.** While a delegated action from steps 2-6 is in
   flight (or right after), submit an ordinary task directly in the capability channel (the
   existing task-launching path, not a conversation). Confirm it replies normally in its own
   thread with its own outcome -- the delegated-action path must not block, starve, or otherwise
   interfere with a concurrent capability-channel job.

## Cleanup

Delete any branches the job created in the target repo once you have inspected them, and clear
`sessionStorePath` if you want a clean pending-state slate for the next run.
