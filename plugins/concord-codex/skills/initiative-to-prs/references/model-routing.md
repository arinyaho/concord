# Model routing

Choose by task shape and failure cost. Use the least expensive model that can reliably close the stage, then escalate only on the conditions below. Model names are current runtime aliases; if a runtime changes its catalog, preserve the role and escalation rule rather than guessing an equivalent from price alone.

## Defaults

| Role | Codex | Claude Code | Purpose |
|---|---|---|---|
| orchestrator | Terra, medium | Sonnet | Maintain state, select stages, enforce checkpoints, summarize handoffs |
| source extraction | Luna, low; Terra, low when synthesis is needed | Haiku | Extract bounded facts from independent, well-defined sources |
| readiness audit | Terra, high | Sonnet | Reconcile intent, code, tracker, and observed behavior |
| contract decision | Astra, high, only on the escalation conditions below | Opus, only on the escalation conditions below | Decide a material behavioral contract from compressed evidence |
| implementation | Terra, xhigh by default | Sonnet by default | Implement a settled ticket contract and prove red to green |
| independent review | Fresh Terra, high or xhigh | Fresh Sonnet | Review premise, behavior, security boundaries, tests, and documentation without implementer context |
| final mutations | Terra, high | Sonnet | Apply accepted findings, rerun gates, update links, and open PRs |

## Escalation

Use Astra or Opus for a contract decision only when evidence conflicts, accepted sources leave a material ambiguity, or the choice changes multiple tickets, authorization, storage identity, migration, security, or another costly-to-reverse boundary. Do not use a deep model merely because the initiative is important or the source packet is long. Give it the compressed evidence and exact decision, not the raw corpus.

Use Sol at xhigh for Codex implementation when the accepted ticket requires coordinated code changes in two or more repositories, changes a security, authorization, storage, identity, or migration contract, has an unstable red, or Terra has failed twice for the same cause. On Claude Code, use Opus for the same conditions only when Sonnet cannot close the task reliably; cross-repository work alone is not enough when the changes are mechanical and independently testable.

Use Sol at high for Codex final mutations when accepted findings require coordinated fixes across repositories or reinterpretation of the approved semantic contract. A semantic reinterpretation normally returns to the user instead of being repaired silently. Use Opus under the same rule on Claude Code.

## Delegation bounds

The maximum delegation depth is two: orchestrator to stage agent to specialist child. A stage agent may create at most two specialist children, and only for independent source extraction, isolated repository tracing, or a bounded specialist question. Work directly for simple searches, sequential mutations, single-file edits, and tasks whose intermediate context must remain together.

Implementation and independent review are sibling stages created by the orchestrator, never parent and child. Final mutations remain sequential because they edit shared branch and tracker state.

Use clean context for every child. On Codex, request the model and reasoning effort explicitly when the spawn mechanism supports them. On Claude Code, request the model alias explicitly. Record the requested and resolved model, provider, effort when exposed, escalation trigger, and any fallback in the stage handoff.

Never silently substitute a model. For FAST, BALANCED, implementation, review, or final-mutation work, an unavailable requested model may fall back to the documented model for the same role in the active runtime when the handoff records the substitution. A required deep contract decision has no automatic downgrade; return the unresolved decision to the user when Astra or Opus is unavailable.

## Stage composition

| Stage | Stage owner | Permitted specialist children |
|---|---|---|
| Evidence and contract | readiness audit | Up to two source-extraction children for independent corpora; one contract-decision child only when an escalation condition is met |
| Ticket set | final mutations | None by default; the same agent writes and reads back each tracker or design mutation sequentially |
| Ticket implementation | implementation | Up to two Terra-high or Sonnet repository tracers for independent repositories; only the stage owner edits code |
| Independent review | independent review | Up to two fresh Terra-high/xhigh or Sonnet specialists for bounded security, test, or cross-context questions |
| Final mutations and PR | final mutations | None; fixes, checks, push, tracker links, and PR read-back remain sequential |
