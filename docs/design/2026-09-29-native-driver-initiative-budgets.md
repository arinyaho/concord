# Native driver initiative budgets

The native Claude and Copilot review drivers enforce the same keyed initiative ledger as the Codex runner: one durable launch budget, one round budget, terminal target dispositions, and the `reconciliation-required` handoff, all for one repository and one run key. The review CLI accepts the run key, the canonical initiative state directory, and the immutable budgets (`--initiative-run-key`, `--initiative-state-dir`, `--initiative-max-launches`, `--initiative-max-rounds`), which must be supplied together and are validated and opened by the same code the Codex runner uses. With none of them, behaviour is unchanged.

## Decision: enforce at evidence acceptance, not at launch

Native reviewers, fixers, panel lenses, and votes are spawned by the host model following the driver prose, not by code. The CLI sees only the artifacts they leave behind, so it cannot prevent a launch. The guarantee is therefore that an unreserved launch cannot produce accepted evidence:

- The driver calls `reserve <ref> <role> [--count N]` before each launch or fan-out and launches only after `granted`. Roles are `correctness`, `verify`, `intent`, `gate-review`, `gate-verify`, `fix`, `lens` (the five panel lenses as one batch), and `vote` (a multiple of three).
- A batch is reserved under one initiative-ledger lock in one write: it is granted or denied as a unit, and a denial (budget exhausted, round budget exhausted, terminal target, or lock contention) consumes nothing. A single-launch loop cannot provide this, because the ledger lock is one non-retrying `mkdir`, so parallel lenses or votes would deny each other spuriously.
- A granted reservation stores a random token in the target ledger only. The initiative ledger records role, round, and target, as for the Codex runner, and never an artifact path or token.
- `plan-fixes`, `record`, `commit-fix`, and `gate-panel-round-record` reject any artifact whose role has no matching reservation for the active round (and panel round), fail the keyed run closed by finalising it, and exit with a `harness-failure`. `commit-fix` consumes one unit of `fix` reservation per commit.
- Terminal `record` outcomes are written through the existing disposition path with the same privacy contract as the Codex path: raw refs and SHAs stay in the local ledger, and public summaries carry hashed target IDs and aggregate counts.

A material intent, design-conformance, or AC-coverage finding already yields an empty fixer plan and `reconciliation-required`; the driver reserves `fix` only for a non-empty plan, so no fixer reservation exists in that case.

## Trade-offs and residual exposure

- Reservation is a contract with the driver, not a physical barrier. A host that launches without reserving spends real compute the budget never sees; its output is rejected and the run fails closed, so the overrun is bounded to one round of work.
- Reservation matches artifacts to a role and round, not to a specific launch: a fabricated artifact written by the host in a reserved role is indistinguishable from a real one. The ledger bounds cost, not honesty.
- A reservation whose launch never happens still consumes budget. This is deliberate and matches the Codex runner, where a crashed launch has already consumed its slot.

## Rejected alternatives

- Spawning native reviewers from code, as the Codex runner does, would give a physical launch gate but replaces the host's own subagent mechanism with a process runner and is a separate product.
- A pre-launch hook cannot cover Copilot, which exposes none, and a Claude subagent hook does not see reviewers launched from a shell.
- Reserving each launch individually would let concurrent panel lenses and votes deny each other on lock contention and could leave a fan-out half granted.
