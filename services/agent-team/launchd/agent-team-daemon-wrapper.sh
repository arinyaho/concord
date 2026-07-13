#!/bin/bash
set -euo pipefail
# Read the Discord bot token from the macOS Keychain (never store it plaintext in the plist).
# Create the item once: security add-generic-password -a "$USER" -s agent-team-discord-token -w
DISCORD_BOT_TOKEN="$(security find-generic-password -a "$USER" -s agent-team-discord-token -w)"
export DISCORD_BOT_TOKEN
export AGENT_TEAM_CONFIG="${AGENT_TEAM_CONFIG:?set AGENT_TEAM_CONFIG to the absolute config path}"
exec /usr/bin/env node "$(dirname "$0")/../bin/agent-team-daemon.mjs"
