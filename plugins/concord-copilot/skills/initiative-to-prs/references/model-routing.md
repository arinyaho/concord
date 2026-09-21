# Model routing

Choose by task shape and failure cost. Use the least expensive available Copilot model that can reliably close the stage, then escalate only when evidence conflicts or the decision is costly to reverse. Record the requested and resolved model for every delegated stage.

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

## Delegation bounds

Use clean context for every child. The maximum depth is two: orchestrator to stage agent to bounded specialist. Implementation and independent review are sibling stages, never parent and child. Keep dependent mutations sequential.

Request a specific available Copilot model when model selection is authorized. Never silently substitute a model. An unavailable ordinary role may fall back to another model of the same class only when the handoff records the substitution. A required deep contract decision has no automatic downgrade; return the unresolved decision to the user.

For cross-model review, the reviewer must resolve to a different model from the implementer. If Copilot cannot provide one within the current subscription or parent cost tier, stop and report the capability gap.