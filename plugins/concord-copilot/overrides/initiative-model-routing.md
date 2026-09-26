# Model routing

Choose by task shape and failure cost. At each run, resolve the newest suitable fast, general, or deep model from the current Copilot catalog and confirm that it is callable; do not pin a model generation or infer capability from its name or price. Record the requested and resolved model for every delegated stage.

## Roles

| Role | Model class | Purpose |
| --- | --- | --- |
| Orchestrator | General reasoning | Maintain state, enforce checkpoints, and summarize handoffs |
| Source extraction | Fast | Extract bounded facts from independent sources |
| Readiness audit | General reasoning | Reconcile intent, code, tracker, and observed behavior |
| Contract decision | Deep reasoning | Resolve material ambiguity from compressed evidence |
| Implementation | General reasoning | Implement a settled contract and prove red to green |
| Independent review | Fresh general or deep model | Review without implementer context |
| Final mutations | General reasoning | Apply accepted findings, rerun gates, and open PRs |

## Architecture decision gate

Before checkpoint 1, have a deep-capability model examine compressed evidence, alternatives, counterexamples, reversibility, migration cost, and acceptance checks for material choices about cryptographic format or protocol, security, authorization, identity, data layout, deployment boundaries, public API behavior, or ticket splits that lock in those choices. This applies even without conflicting sources. The active root agent cannot satisfy a Deep decision gate. Spawn a separate deep-capability specialist in clean context and request a concrete available model. A role label, requested class, self-assessed capability, or higher reasoning effort is not resolved model evidence. Record the child invocation or agent identity, requested and resolved model, provider and catalog basis, reasoning effort when exposed, successful completion, conclusion, and covered decision identities in the Stage 1 handoff. For a material cryptography, security, or migration decision, require a second independent deep-capability reviewer. Give it source evidence and the proposed decision without the responsible specialist's reasoning. Record a distinct second-reviewer evidence record with that reviewer's invocation or agent identity, requested and resolved model, provider and catalog basis, reasoning effort when exposed, successful completion, conclusion, and covered decision identities. Reconcile substantive disagreement before dependent work continues. If required Deep evidence or independent review is unavailable, leave the decision unresolved and do not present checkpoint 1 or create dependent tickets.

Apply the same gate during implementation and review. If discussion with the user, a failed check, or code investigation raises a new material choice, pause dependent work and use a deep-capability agent to assess it before selecting an implementation direction, even when the ticket was approved and no model has failed. Continue independent work. Record an in-contract decision and continue; if it changes the approved contract, reconcile affected tickets through the existing checkpoint and invalidation rules. Hand off the current decision and superseded alternatives, not the full conversation.

## Delegation bounds

Use clean context for every child. The maximum depth is two: orchestrator to stage agent to bounded specialist. Implementation and independent review are sibling stages, never parent and child. Keep dependent mutations sequential.

Request a specific available Copilot model when model selection is authorized. Never silently substitute a model. An unavailable ordinary role may fall back to another model of the same class only when the handoff records the substitution. A required deep contract decision has no automatic downgrade; return the unresolved decision to the user.

For cross-model review, the reviewer must resolve to a different model from the implementer. If Copilot cannot provide one within the current subscription or parent cost tier, stop and report the capability gap.
