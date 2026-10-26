# Model routing

Choose by task shape and failure cost. Resolve the newest suitable model within the user's authorized choices from the current Copilot catalog and confirm that it is callable and meets the required capability; do not pin a model generation or infer capability from its name or price. Honor the user's explicit model choice and standing model restrictions over default escalation preferences. Honor a user-designated callable model when it meets the required capability. Never invoke Astra or another model the user restricts without direct authorization from the user. A user-designated model may fill a Deep role; do not add a specialist solely because the root agent selected that model. Any required independent review uses a separate invocation and context and may use the same user-approved capable model. Record the applicable policy and requested and resolved model for each role.

If a required model or authorization is unavailable, ask the user once for the pending decision batch and record the policy, requested role/model, question, and answer, including refusal or no answer. Do not silently downgrade or override the user's restriction. Continue independent work; pause only work that depends on the unresolved decision. User approval cannot replace required technical evidence or capability.

After a bounded implementation batch is approved and its contract is clear, use the lowest-cost capable implementation model to complete the batch and its focused self-checks without pausing for status. Reserve higher-cost capability for design work, scope decisions, new P1 findings, findings against the content or wording of a rule, contract, interface, or schema, and one fresh independent verification after the batch.

Give that implementation model only scoped tasks of easy or medium difficulty. It implements and tests each one, and hands back any task that proves harder than its scope suggested instead of pushing through; the orchestrator keeps that task or escalates it to deep capability. Choose the lowest-cost setting by measurement: lower reasoning effort before changing class, move one class at a time, and keep a cheaper setting only when it matches the current one on the same tasks.

## Roles

| Role | Model class | Purpose |
| --- | --- | --- |
| Orchestrator | General reasoning | Maintain state, enforce checkpoints, and summarize handoffs |
| Source extraction | Fast | Extract bounded facts from independent sources |
| Readiness audit | General reasoning | Reconcile intent, code, tracker, and observed behavior |
| Contract decision | Deep reasoning | Resolve design work from compressed evidence: decide what a rule, contract, interface, schema, or architecture should be |
| Implementation | General reasoning | Implement a settled contract and prove red to green |
| Independent review | Fresh general or deep model | Review without implementer context |
| Final mutations | General reasoning | Apply accepted findings, rerun gates, and open PRs |

## Architecture decision gate

A task that decides what something should be, the content or wording of a rule, contract, interface, schema, or architecture, is design work and requires evidence from a callable Deep-capability model. Applying a decision already made stays with the active agent; the reader splits a task that mixes both.

Before checkpoint 1, have a callable Deep-capability model examine compressed evidence, alternatives, counterexamples, reversibility, migration cost, and acceptance checks for choices about cryptographic format or protocol, security, authorization, identity, data layout, deployment boundaries, public API behavior, or ticket splits that lock in those choices. This applies even without conflicting sources. A user-designated callable model may satisfy this gate when it meets the capability requirement; do not force a different model or create a specialist solely because of the root agent's model choice. A role label, requested class, self-assessed capability, or higher reasoning effort is not resolved model evidence. Record the invocation or agent identity, applicable model policy, requested and resolved model, provider and catalog basis, reasoning effort when exposed, successful completion, conclusion, and covered decision identities in the Stage 1 handoff. For a cryptography, security, or migration decision, require a second independent Deep reviewer in separate context; it may use the same user-approved capable model. Give it source evidence and the proposed decision without the responsible reviewer's reasoning. Record a distinct second-reviewer evidence record with that reviewer's invocation or agent identity, requested and resolved model, provider and catalog basis, reasoning effort when exposed, successful completion, conclusion, and covered decision identities. Reconcile substantive disagreement before dependent work continues. If required Deep evidence or independent review is unavailable, leave the decision unresolved and do not present checkpoint 1 or create dependent tickets.

Apply the same gate during implementation and review. If discussion with the user, a failed check, or code investigation raises new design work, pause dependent work and use a callable model that meets the capability gate and user's model policy before selecting an implementation direction, even when the ticket was approved and no model has failed. Ask once per pending decision batch when authorization is needed and record the policy, request, and answer. Continue independent work. Record an in-contract decision and continue; if it changes the approved contract, reconcile affected tickets through the existing checkpoint and invalidation rules. Hand off the current decision and superseded alternatives, not the full conversation.

## Delegation bounds

Use clean context for every child. The maximum depth is two: orchestrator to stage agent to bounded specialist. Implementation and independent review are sibling stages, never parent and child. Keep dependent mutations sequential.

Request a specific available Copilot model when model selection is authorized. Never silently substitute or override a user restriction. An unavailable ordinary role may use another verified model in the same class only when permitted by the user's policy and the handoff records the choice. A required Deep decision has no automatic downgrade; return the unresolved decision to the user. Batch substantive findings against rule, contract, interface, or schema wording for one adjudication per stage, not one escalation per finding.

For cross-model review, the reviewer must resolve to a different model from the implementer. If Copilot cannot provide one within the current subscription or parent cost tier, stop and report the capability gap.
