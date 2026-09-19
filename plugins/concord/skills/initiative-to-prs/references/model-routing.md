# Model routing

Choose by task shape and failure cost. Use the least expensive model that can reliably close the stage, then escalate only on the conditions below. Codex entries include their callable model IDs; Claude Code entries use runtime aliases. If a runtime changes its catalog, preserve the role and escalation rule rather than guessing an equivalent from price alone.

## Defaults

| Role | Codex | Claude Code | Purpose |
|---|---|---|---|
| orchestrator | Terra (`gpt-5.6-terra`), medium | Sonnet | Maintain state, select stages, enforce checkpoints, summarize handoffs |
| source extraction | Luna (`gpt-5.6-luna`), low; Terra (`gpt-5.6-terra`), low when synthesis is needed | Haiku | Extract bounded facts from independent, well-defined sources |
| readiness audit | Terra (`gpt-5.6-terra`), high | Sonnet | Reconcile intent, code, tracker, and observed behavior |
| contract decision | Astra (`gpt-6-astra`), high, only on the escalation conditions below | Opus, only on the escalation conditions below | Decide a material behavioral contract from compressed evidence |
| implementation | Terra (`gpt-5.6-terra`), xhigh by default | Sonnet by default | Implement a settled ticket contract and prove red to green |
| independent review | Fresh Terra (`gpt-5.6-terra`), high or xhigh | Fresh Sonnet | Review premise, behavior, security boundaries, tests, and documentation without implementer context |
| final mutations | Terra (`gpt-5.6-terra`), high | Sonnet | Apply accepted findings, rerun gates, update links, and open PRs |

## Escalation

Use Astra (`gpt-6-astra`) or Opus for a contract decision only when evidence conflicts, accepted sources leave a material ambiguity, or the choice changes multiple tickets, authorization, storage identity, migration, security, or another costly-to-reverse boundary. Do not use a deep model merely because the initiative is important or the source packet is long. Give it the compressed evidence and exact decision, not the raw corpus.

Use Sol (`gpt-5.6-sol`) at xhigh for Codex implementation when the accepted ticket requires coordinated code changes in two or more repositories, changes a security, authorization, storage, identity, or migration contract, has an unstable red, or Terra (`gpt-5.6-terra`) has failed twice for the same cause. On Claude Code, use Opus for the same conditions only when Sonnet cannot close the task reliably; cross-repository work alone is not enough when the changes are mechanical and independently testable.

Use Sol (`gpt-5.6-sol`) at high for Codex final mutations when accepted findings require coordinated fixes across repositories or reinterpretation of the approved semantic contract. A semantic reinterpretation normally returns to the user instead of being repaired silently. Use Opus under the same rule on Claude Code.

## Delegation bounds

The maximum delegation depth is two: orchestrator to stage agent to specialist child. A stage agent may create at most two specialist children, and only for independent source extraction, isolated repository tracing, or a bounded specialist question. Work directly for simple searches, sequential mutations, single-file edits, and tasks whose intermediate context must remain together.

Implementation and independent review are sibling stages created by the orchestrator, never parent and child. Final mutations remain sequential because they edit shared branch and tracker state.

Use clean context for every child. On Codex, request the model and reasoning effort explicitly when the spawn mechanism supports them. On Claude Code, request the model alias explicitly. Record the requested and resolved model, provider, effort when exposed, escalation trigger, and any fallback in the stage handoff.

Never silently substitute a model. For orchestrator, source extraction, readiness audit, implementation, independent review, or final mutations, an unavailable requested model may fall back to the documented model for the same role in the active runtime when the handoff records the substitution. A required deep contract decision has no automatic downgrade; return the unresolved decision to the user when Astra (`gpt-6-astra`) or Opus is unavailable.

## Stage composition

| Stage | Stage owner | Permitted specialist children |
|---|---|---|
| Evidence and contract | readiness audit | At most two children total: up to two source-extraction children for independent corpora when no contract decision is needed, or one source-extraction child plus one contract-decision child when an escalation condition is met |
| Ticket set | final mutations | None by default; the same agent writes and reads back each tracker or design mutation sequentially |
| Ticket implementation | implementation | Up to two Terra (`gpt-5.6-terra`) high-effort or Sonnet repository tracers for independent repositories; only the stage owner edits code |
| Independent review | independent review | Up to two fresh Terra (`gpt-5.6-terra`) high- or xhigh-effort or Sonnet specialists for bounded security, test, or cross-context questions |
| Final mutations and PR | final mutations | None; fixes, checks, push, tracker links, and PR read-back remain sequential |
