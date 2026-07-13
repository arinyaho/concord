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
