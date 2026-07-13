# Manual e2e: Discord daemon (real Discord, network, real LLM calls)

This is a manual runbook, not an automated test. It exercises the live gateway
connection, a real Discord guild/channel, and the phase-3a container launcher
end to end. Run it after any change that touches `src/daemon/*` or
`bin/agent-team-daemon.mjs`, and before rolling a new daemon build under
launchd.

For a no-network check of the handler/queue/outcome wiring alone, run
`node smoke/daemon-contract.mjs` instead -- it does not require any of the
setup below.

## Preconditions

- Discord application created, bot invited to a **private** guild, **Message
  Content Intent** enabled under Bot -> Privileged Gateway Intents (the
  daemon reads message text to parse tasks; the gateway rejects
  `GatewayIntentBits.MessageContent` without this). See README.md "Discord
  app setup" for the full walkthrough.
- Config JSON in place at some absolute path, matching the shape documented
  in README.md ("Config JSON shape"): `guildId`, `channelId`, `credsDir`,
  `botTokenEnv`, `userIds` (must include the author account used in case a,
  and must NOT include the account used in case b), `repos` (at least one
  alias pointing at a real target repo clone), `jobTimeoutMs`,
  `diagnoseModel`.
- Bot token stored in the macOS Keychain under `agent-team-discord-token`
  (see README.md "Keychain token item") -- never in a file in the repo.
- Creds dir seeded per README.md "Container launch (phase 3a)" (a
  `$HOME`-rooted directory holding only `.credentials.json`).
- Container runtime running (`colima start` or equivalent) and the
  `agent-team:3a` image built.
- Daemon started, either directly:

      AGENT_TEAM_CONFIG=/absolute/path/to/config.json \
      DISCORD_BOT_TOKEN="$(security find-generic-password -a "$USER" -s agent-team-discord-token -w)" \
      node bin/agent-team-daemon.mjs

  or under launchd per README.md "Running under launchd" (logs at
  `/tmp/agent-team-daemon.out.log` / `/tmp/agent-team-daemon.err.log`).

## Case (a): authorized message produces a job and a success reply

1. From the account whose Discord user ID is in `userIds`, post a message in
   the pinned private-guild channel in `alias: task` form, e.g.
   `concord: run node --test in services/agent-team and report the result`.
2. Expect an immediate ack reply-to the message: `queued #<jobId>: <alias> --
   <task>`.
3. Expect the container job to actually run (check `docker ps` for a
   container named `agent-team-<jobId>` while it is in flight, or the daemon
   log for the launch).
4. On success, expect a reply-to the same message: `done #<jobId> -- branch
   agent-team/<jobId>`.
5. Verify the branch exists in the target repo clone (`git branch --list
   'agent-team/*'` in the repo path from `repos.<alias>`) and contains the
   expected work.

## Case (b): unauthorized account produces no job

1. From an account whose Discord user ID is **not** in `userIds` (or a bot
   account), post a message in the same channel in `alias: task` form.
2. Expect **no** reply of any kind -- the identity gate is fail-closed and
   silent (it must not confirm the bot's presence to an unauthorized
   account).
3. Confirm no container was started (`docker ps` shows nothing new, no new
   entry in the daemon log for this message).

## Case (c): a deliberately failing task produces an analysis + tail reply

1. As the authorized account, post a task designed to fail the target repo's
   DoD, e.g. `concord: introduce a syntax error in a test file and do not
   fix it`.
2. Expect the ack reply as in case (a).
3. On completion, expect a failure reply-to the message of the form `failed
   -- <analysis>` followed by a fenced code block containing the captured
   stderr tail.
4. Confirm `<analysis>` reads as a plausible LLM diagnosis of the tail (not
   a raw stack dump, not empty).

## Case (d): an oversized tail is truncated, not dropped

1. As the authorized account, post a task designed to produce a very long
   stderr tail (well over Discord's 2000-character message cap), e.g. a task
   that fails after printing many lines of repeated output.
2. Expect a failure reply as in case (c), but confirm:
   - The reply is delivered (no send failure / no silently dropped message).
   - The reply is at or under 2000 characters.
   - The tail portion is the *end* of the captured output (most recent
     lines), not the beginning, and is prefixed with `...` to signal
     truncation -- confirming `formatFailure`'s tail-clamping kept the most
     relevant (most recent) content rather than truncating from the head or
     dropping the message outright.

## Cleanup

- Delete the creds dir and any throwaway repos under `~/.agent-team/` used
  for this run.
- Delete any `agent-team/<jobId>` branches created for cases (a)/(c)/(d) from
  the target repo clone if they should not be kept.
- If running the daemon directly (not under launchd), stop it (Ctrl-C); if
  under launchd, `launchctl unload
  ~/Library/LaunchAgents/com.agent-team.daemon.plist` if you do not want it
  to keep running.
