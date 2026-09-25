# Model routing

Choose a capability class for the work, then resolve an available model in the active runtime. Do not pin a model generation in this skill. At each run, use the runtime's current model catalog and provider guidance to identify the newest suitable model in the required class; confirm that the selected model and reasoning effort are callable before delegation. Do not infer capability from a model name, version number, or price alone. Honor an explicit user model choice unless it cannot meet a required gate.

| Class | Work |
|---|---|
| Fast | Bounded extraction from a known source; no synthesis or product decision |
| General | Orchestration, evidence reconciliation, settled implementation, routine independent review, and final mutations |
| Deep | Material architecture or behavioral contract decisions, and implementation or review whose failure is costly to reverse |

Use a general model with medium effort for orchestration, high effort for readiness and review, and the effort needed to prove implementation red to green. Use a fast model only for narrow extraction. For Claude Code, request the current `haiku`, `sonnet`, or `opus` family alias when it matches the selected class; first check whether a newer available family better fits that class. For Codex and Copilot, select a callable model from the current catalog for the class and pass its actual ID only at invocation time. If the runtime cannot select models, inspect the active model and use it only for roles it can reliably perform.

## Architecture decision gate

Before checkpoint 1, identify decisions about cryptographic format or protocol, security and authorization, identity, data layout or migration, deployment boundaries, public API behavior, and ticket splits that lock in one of those choices. A deep-capability model must examine the compressed evidence and alternatives **before** the decision becomes an approved contract, ticket, design record, or implementation instruction. This gate applies even when sources appear to agree and the parent agent can articulate a plausible answer. Give the deep pass the exact decision, source evidence, counterexamples, reversibility and migration cost, and proposed acceptance checks. Record its conclusion and unresolved assumptions in the handoff. The user still owns product choices.

The active agent may perform that pass when its resolved model is deep-capability. Otherwise use an authorized specialist with clean context or switch the stage to a deep model. If neither is available, leave the decision unresolved and do not pass checkpoint 1 or create dependent tickets. A general model may handle ordinary ticket decomposition after the architecture contract is settled.

Reopen this gate when new evidence or a user decision changes a material assumption during execution. Reconcile the contract and dependent tickets through the existing checkpoint and invalidation rules before continuing. Pass a concise current-decision handoff, including superseded alternatives, rather than the full evolving conversation.

## Escalation

Use deep capability for implementation or independent review when work spans security, authorization, identity, cryptography, storage migration, or coordinated changes across repositories whose interfaces cannot be tested independently; also escalate after two failures of the same cause or an unstable discriminating red. Mechanical cross-repository work with independent checks can remain general. Semantic reinterpretation during final mutations returns to the user and the architecture decision gate.

## Delegation and evidence

The maximum delegation depth is two: orchestrator to stage agent to specialist child. A stage agent may create at most two specialist children for independent extraction, repository tracing, or a bounded decision. Workers required internally by composed Concord commands such as `review-until-green` follow those commands' own limits. Work directly for simple searches and sequential mutations. Implementation and independent review are sibling stages with separate context; final mutations remain sequential.

Record the role, required class, requested and resolved model, provider, effort when exposed, catalog or alias basis, escalation trigger, and any fallback in the stage handoff. Never silently downgrade a required class. An unavailable ordinary role may use another verified model in the same class. A required deep decision has no automatic downgrade.

| Stage | Owner | Optional specialists |
|---|---|---|
| Evidence and contract | General readiness audit | Up to two source extractors, or one extractor and one deep decision reviewer when the architecture gate applies |
| Ticket set | General final mutations | None by default |
| Ticket implementation | General or escalated deep implementation | Up to two general repository tracers; only the owner edits code |
| Independent review | Fresh general or escalated deep reviewer | Up to two fresh specialists for bounded security, test, or cross-context questions |
| Final mutations and PR | General final mutations | None |
