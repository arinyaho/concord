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
