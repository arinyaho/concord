# Resume after incomplete plan classification

A schema-valid protocol-v2 plan can omit surviving findings. The completeness check must reject that plan before any fixer reservation or edit. Recovery retries planning without rediscovering findings or weakening classification.

## Decision

Separate normalized plan evidence from an accepted plan in the execution ledger. `artifact-normalize` saves a hash-bound `normalizedPlan` and leaves `plan` pending. `plan-fixes` is the sole transition that marks `plan` completed after it validates every surviving finding exactly once. Resume preserves normalized pending evidence when its round, scope and artifact hash match, and consumes it without launching another planner. Legacy completed plan evidence is consumed through the same semantic guard; accepted plans retain idempotent reuse.

When classification omits finding IDs, `plan-fixes` atomically records a plan failure, invalidates only plan completion and normalized evidence, retains an actionable retry prompt, and supersedes its initiative launch once. Correctness, verifier, intent and gate evidence remain sealed. A subsequent resume launches one newly reserved planner in the same round and initiative key. Denial preserves the actual budget block and launches nothing.

One semantic replacement is allowed per unchanged round. A replacement that also omits findings records exhaustion with the latest omitted IDs; further resumes stop before dispatch. The allowance survives normalization and round-start. This bounds standalone recovery as well as keyed initiative recovery without resetting spent budgets. Schema repair remains a separate representation-only operation; its stale plan bindings are discarded when a semantic replacement is scheduled, while unrelated repair records remain intact.

## Alternatives and trade-offs

Leaving normalization as completion and merely catching runner errors would leave native drivers and interrupted transitions inconsistent. Rerunning all reviewers would discard sealed evidence and spend unrelated reservations. CLI-owned acceptance and rejection applies uniformly to every driver, at the cost of one additional pending evidence field and one durable bounded retry record.

The retry can still produce an invalid or incomplete plan; invalid schemas fail closed and a second incomplete plan requires reconciliation. A denied budget cannot be repaired by increasing limits or changing the initiative key. Scope or hash drift invalidates reusable evidence under the existing resume rules.

## Executable checks

A real-CLI regression uses two surviving findings and an empty-group plan. Before the fix, resume repeats the identical rejection without a new planner. After the fix, it launches only planning, preserves reviewer artifact hashes, reserves and charges the replacement on the same initiative run, and passes the exact finding identities to the accepted plan. Companion cases cover repeated incomplete replacement, denied reservation, and already accepted plan reuse. Pending normalized evidence and a schema-repaired rejected plan also need interruption coverage.

Run the review runner, CLI, initiative budget and telemetry suites, Codex/Copilot drift checks, the plugin and agent-team CI suites under Node 22, and `node scripts/dod.mjs`.
