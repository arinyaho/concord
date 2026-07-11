# agent-team (headless slice)

Personal single-tenant multi-agent dev-team control plane. This is the phase-2
headless slice: a deterministic coordinator drives persistent spec + reviewer
role threads through a handoff/handback loop with a code-owned round cap.

## Run

    unset ANTHROPIC_API_KEY   # runs on `claude login` OAuth (Max plan)
    npm install
    npm test                  # unit tests (no network)
    npm run smoke             # substrate check (network, OAuth)
    node bin/agent-team.mjs "Design a rate limiter for a public JSON API"
    node bin/agent-team.mjs --diverge "..."   # forces the non-converging path

Requires an active `claude login` session; no API key.

## Container launch (phase 3a)

Run the pipeline credential-isolated inside a container.

Setup (once):
- Install a container runtime: `brew install colima docker` (or OrbStack / Podman). `colima start` before use.
- Seed a Claude-only creds dir OUTSIDE the repo, holding ONLY the credential file. It MUST be `$HOME`-rooted (colima only mounts `$HOME` by default -- a `/tmp`-rooted creds dir binds empty inside the container and auth silently fails):
  `mkdir -p ~/.agent-team/creds && cp ~/.claude/.credentials.json ~/.agent-team/creds/.credentials.json && chmod 600 ~/.agent-team/creds/.credentials.json`
- Build the image: `docker build -t agent-team:3a services/agent-team` (the launcher also builds on first run).

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
