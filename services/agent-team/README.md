# agent-team (headless slice)

Personal single-tenant multi-agent dev-team control plane. This is the phase-2
headless slice: a deterministic coordinator drives persistent spec + reviewer
role threads through a handoff/handback loop with a code-owned round cap.

## Run

    unset ANTHROPIC_API_KEY   # runs on `claude login` OAuth (Max plan)
    npm install
    npm test                  # unit tests (no network)
    npm run smoke             # substrate check (network, OAuth)
    node bin/agent-team.mjs --allow-uncontained "Design a rate limiter for a public JSON API"
    node bin/agent-team.mjs --diverge --allow-uncontained "..."   # forces the non-converging path

Requires an active `claude login` session; no API key.

## Container launch (phase 3a)

Run the pipeline credential-isolated inside a container.

Setup (once):
- Install a container runtime: `brew install colima docker` (or OrbStack / Podman). `colima start` before use.
- Seed a Claude-only creds dir OUTSIDE the repo, holding ONLY the credential file. It MUST be `$HOME`-rooted (colima only mounts `$HOME` by default -- a `/tmp`-rooted creds dir binds empty inside the container and auth silently fails):
  `mkdir -p ~/.agent-team/creds && cp ~/.claude/.credentials.json ~/.agent-team/creds/.credentials.json && chmod 600 ~/.agent-team/creds/.credentials.json`
- Build the image: `docker build -t agent-team:3a services/agent-team`. The launcher does NOT build the image itself -- it only resolves the container runtime binary and runs the container, so this build step must be done manually before the first run and repeated after any change to the image.

Run:
`node services/agent-team/bin/agent-team-launch.mjs "<task>" --repo <target-repo> --creds-dir ~/.agent-team/creds`

e2e smoke (manual, network, real LLM calls -- exercises the actual container path end to end):
`node services/agent-team/smoke/e2e-container.mjs --creds-dir ~/.agent-team/creds`
This seeds a throwaway `$HOME`-rooted target repo with a failing node-only DoD, runs the real launcher against it, and asserts the pipeline converges (`"outcome": "done"`) and the produced branch re-exports into the target repo. Delete the creds dir and any throwaway repos under `~/.agent-team/` afterward.

Notes:
- The launcher mounts only the target clone (/work), the concord code (RO), the creds dir (RO), and `~/.claude/skills` (RO). The author's home, cloud CLIs, Keychain, and shell env are NOT reachable inside.
- Rotation / revocation runbook: re-seed the creds dir (re-copy `~/.claude/.credentials.json`). This does NOT revoke an already-exfiltrated token -- for a suspected compromise, do a real server-side re-auth that invalidates prior tokens (revoke the session from the Claude account, not just from this machine), then re-seed.
- Token-TTL failure mode: the creds file is mounted read-only, so the SDK cannot refresh the OAuth token mid-job. A job that outlives the token's lifetime will FAIL (it does not leak) -- re-seed the creds dir to refresh.
- Phase-3a limitation: the image is node-only. A target repo whose DoD needs pnpm/pytest/cargo is not yet supported.

## Discord daemon (3b-2)

Runs the coordinator behind a Discord bot: an authorized user posts a task in a
private channel, the daemon submits it as a job through the phase-3a container
launcher, and replies in-thread with the outcome.

### Config JSON shape

`AGENT_TEAM_CONFIG` must point at an absolute path to a JSON file matching
`src/daemon/config.mjs`:

```json
{
  "guildId": "123456789012345678",
  "channelId": "123456789012345679",
  "credsDir": "/Users/you/.agent-team/creds",
  "botTokenEnv": "DISCORD_BOT_TOKEN",
  "userIds": ["123456789012345670"],
  "repos": { "concord": "/Users/you/ccp/concord" },
  "jobTimeoutMs": 1800000,
  "diagnoseModel": "claude-opus-4-6",
  "cap": 10,
  "queueMax": 50,
  "credsRefreshMs": 1800000,
  "base": "main"
}
```

Required fields: `guildId`, `channelId`, `credsDir` (absolute path),
`botTokenEnv` (name of the env var the token is exported under -- the wrapper
below exports `DISCORD_BOT_TOKEN`, so this must be `"DISCORD_BOT_TOKEN"`),
`userIds` (non-empty array of allowed Discord user IDs), `repos` (non-empty
`{ alias: absolutePath }` map of target repos the bot may launch jobs against),
`jobTimeoutMs` (positive number, ms), `diagnoseModel`.

Optional fields (defaults shown): `cap` (10, max concurrent jobs), `queueMax`
(50, max queued jobs), `credsRefreshMs` (1800000, how often the daemon
re-copies `~/.claude/.credentials.json` into `credsDir`), `base` ("main", the
branch jobs are cut from).

### Keychain token item

The token is never stored in the plist or the config JSON. Create it once in
the macOS Keychain:

    security add-generic-password -a "$USER" -s agent-team-discord-token -w

You will be prompted for the token value. The wrapper script reads it back
with `security find-generic-password -a "$USER" -s agent-team-discord-token -w`
and exports it as `DISCORD_BOT_TOKEN` before exec-ing the daemon.

### Discord app setup

1. Create a Discord application + bot user at https://discord.com/developers/applications.
2. Under Bot -> Privileged Gateway Intents, enable **Message Content Intent**.
   The daemon reads message text to parse tasks, so this is required -- the
   gateway rejects `GatewayIntentBits.MessageContent` without it.
3. Copy the bot token into the Keychain item above (never into a file in the repo).
4. Invite the bot to a **private** guild (server) with a bot-invite URL scoped
   to `bot` + the intents above. Create a private channel in that guild for
   the daemon and restrict it to the users who should be allowed to submit jobs.
5. Copy the guild ID and channel ID (enable Developer Mode in Discord settings
   -> right-click the guild/channel -> Copy ID) into `guildId` / `channelId` in
   the config JSON. Copy each authorized user's ID (right-click their name ->
   Copy ID) into `userIds`.

### Running under launchd

Edit `launchd/com.agent-team.daemon.plist`: replace both `/ABSOLUTE/PATH/...`
placeholders -- the `ProgramArguments` entry with the absolute path to
`agent-team-daemon-wrapper.sh`, and `AGENT_TEAM_CONFIG` with the absolute path
to your config JSON. The token is intentionally NOT in the plist; it only ever
lives in the Keychain.

    cp services/agent-team/launchd/com.agent-team.daemon.plist ~/Library/LaunchAgents/
    # edit ~/Library/LaunchAgents/com.agent-team.daemon.plist to fill in the placeholders
    launchctl load ~/Library/LaunchAgents/com.agent-team.daemon.plist

Logs go to `/tmp/agent-team-daemon.out.log` and `/tmp/agent-team-daemon.err.log`.
`KeepAlive` restarts the daemon if it exits; `launchctl unload
~/Library/LaunchAgents/com.agent-team.daemon.plist` stops it.

### Conversation channels (B-1)

In addition to the capability (task-launching) channel above, the daemon runs a separate tool-less conversation path: an authorized author posts a design question in a conversation channel, the daemon opens a thread, and Spec and Reviewer (a fixed roster, `src/daemon/conversation_roster.mjs`) reply in their own voice, resuming the same thread's session on each follow-up. A role that judges a turn outside its concern replies with nothing (self-skip) rather than posting a generic response.

Config fields (added to the JSON shape above, all under the same file):

```json
{
  "conversationChannelIds": ["123456789012345680"],
  "sessionStorePath": "/Users/you/.agent-team/conversation-sessions.json",
  "maxRoundLen": 2
}
```

- `conversationChannelIds` (required, non-empty array of channel IDs): the channels that start a new conversation thread. Must be disjoint from `channelId` (the capability channel) -- `loadConfig` rejects a config where the two overlap, so a message can only ever route to one path.
- `sessionStorePath` (required, absolute path): where per-thread role session ids are persisted (JSON, mode `0600`, atomic temp-then-rename write on every turn). The daemon reloads this file on startup, so a follow-up posted after a restart resumes the same role sessions rather than starting over.
- `maxRoundLen` (optional, defaults to the roster length): caps how many roles run per turn, in roster order.

Thread permissions: the bot invite needs **Create Public Threads** and **Send Messages in Threads**, in addition to the scopes listed under "Discord app setup" above -- the daemon opens each conversation with `msg.startThread(...)`, which fails without these.

Per-role avatars (B-3b, optional): if `roleAvatars` is configured, replies post through a Discord webhook so each role shows its own name and avatar instead of an inline `**role:**` label. This requires the **Manage Webhooks** permission on the bot invite; without it, the daemon degrades cleanly and falls back to posting the inline `**role:**` label itself.

**Standing assumption (load-bearing):** the conversation path does not screen who can read or post in a thread it creates -- it authorizes the *triggering* message (author in `userIds`, guild matches `guildId`) and, for follow-ups, that the thread's live parent is still a listed conversation channel. It does not check thread membership. This is safe only because the guild itself is private and author-only (the same assumption "Discord app setup" already requires for the capability channel). Do not add a `conversationChannelIds` entry that lives in a guild with any member besides the author and the bot -- doing so would let a third party read or post in threads the daemon creates, which B-1's no-third-party-ingress guarantee assumes cannot happen.

### Delegated actions (B-2)

A conversation role (Spec or Reviewer) can propose that the daemon actually change a repository, not just discuss it. It ends its reply with a final line of exactly `DISPATCH <alias> :: <task>`, where `<alias>` is one of the keys of the configured `repos` map (the same map the capability channel uses) and `<task>` is a concise description of the change. Roles are told the configured aliases up front (`buildConversationRoster` injects the list from `Object.keys(cfg.repos)` into each role's system prompt) and are instructed to emit `DISPATCH` only when a real change is warranted, and never with a task that begins with `-`.

The daemon never runs a proposal on its own say-so. It strips the `DISPATCH` line out of the posted reply, resolves the alias against `repos` (an unknown alias or an empty/leading-dash task is rejected with a reason posted in-thread and nothing recorded), mints an id, records ONE pending proposal per thread (last proposal wins), and posts a one-line confirm prompt: `Proposed job <id> on <alias> (<repoPath>): <task>. Reply `run <id>` to execute.` The proposal is durable -- it is persisted to the same session-store file as role sessions, so it survives a daemon restart.

The action only runs once the author (not a role) replies `run <id>` in the thread, matching the id from the confirm prompt exactly. That reply routes through the same author/guild/tracked-thread authorization as any other follow-up message. A mismatched or stale id ("no pending proposal <id>") and a message that isn't the confirm form are both no-ops for the pending proposal -- it stays in place so the author can retry.

A confirmed action runs as the existing capability job (the same container launcher, credential isolation, and remote-trigger interlock as a task submitted through the capability channel above) -- it does not open a second execution path. Each job gets its own clean clone (`agent-team/<jobId>`), so two actions on the same alias can run concurrently; the only thing bounding parallelism is the daemon's global `cap` (max concurrent jobs across all aliases), not any per-repo lock. The job's outcome (`[job result: alias=..., branch=..., outcome=..., summary=...]`) is fed back into the SAME conversation thread as a synthesized turn, so the roles react to what actually happened rather than what was proposed.

The conversation path itself stays tool-less: no role, and no part of the DISPATCH parsing or gate, executes code, reads a filesystem, or reaches a network. `DISPATCH` is inert text a role can emit; only the author's explicit `run <id>` confirmation, itself routed through the pre-existing capability job launcher, causes anything to run. This is the same no-new-RCE-surface property B-1's conversation roster already had.

See `smoke/e2e-delegated-actions.md` for the manual end-to-end runbook.

### Control verbs (B-3a)

Four fixed commands, matched only in a tracked (author-gated) thread and never sent through an LLM: `/cancel <id>`, `/status`, `/clear`, `/rename <name>`. Like the rest of the daemon's message handling, a message from anyone but the configured author in the configured guild is ignored -- these verbs do not open any new authorization path.

- `/cancel <id>` stops a running or queued capability job by its job id, using the same kill path as a timeout. It is global by id: you can cancel a job from any tracked thread, not only the thread that dispatched it. It acks `cancelled <id>` in the thread the command was posted from, and the job's **origin** thread (the one the job was dispatched from) separately receives the job's own cancelled result, `cancelled (<id>)` -- best-effort, since the daemon signals the container to stop but does not wait for it to fully exit before reporting. An id that does not match any running or queued job replies `no such job <id>` and changes nothing.
- `/status` posts a one-message summary of every pending delegated-action proposal and every running/queued capability job, across all tracked threads -- also global, not scoped to the thread it was posted in. It is sent with mentions disabled (`allowedMentions: { parse: [] }`), so a task or proposal text that happens to contain `@everyone` or a role mention cannot ping the guild.
- `/clear` drops the current thread's pending delegated-action proposal (the one created by a role's `DISPATCH` line, see "Delegated actions (B-2)" above), if any. It replies `cleared`, or `nothing pending` if there was none.
- `/rename <name>` renames the current thread via the Discord API and replies `renamed`, or `rename failed` if the API call errors.

See `smoke/control-verbs-contract.mjs` for the no-network parser/handler contract check, and `smoke/e2e-control-verbs.md` for the manual end-to-end runbook.
