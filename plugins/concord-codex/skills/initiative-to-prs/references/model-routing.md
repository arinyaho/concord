# Model routing

Choose the capability from the work, then pick a model the harness can call within the models the user allows. Name no model generation here: use the harness's current catalog. A model name, a role label, or a higher effort setting does not show capability. The user's explicit model choice and restrictions come before any default below.

| Class | Work |
|---|---|
| Fast | Bounded extraction from a known source; no synthesis, no product decision |
| General | Coordination, reconciling evidence, implementation of a settled contract, checking a delivery, final edits |
| Deep | Design work: deciding what a rule, a contract, an interface, a schema, or an architecture should be. Also the independent reviewer of `review-and-fix` |

- Give an implementation worker scoped tasks of easy or medium difficulty on the lowest-cost model that can do them. It implements and tests each one and hands back a task that proves harder than its scope suggested; you keep that task or give it to a more capable model.
- Lower the cost by measurement: lower the effort before changing class, move one class at a time, and keep a cheaper setting only when it matches the current one on the same tasks.
- Never lower a class silently. When the model a task needs is unavailable or not allowed, ask the user once for all pending cases, record the answer in the state document, and continue the work that does not depend on it.

## Decisions that need a Deep model

Before a decision becomes part of the design document, a ticket, or a worker's instructions, have a Deep model examine it when it concerns a cryptographic format or protocol, security or authorization, identity, data layout or migration, a deployment boundary, public API behavior, or a ticket split that locks in one of these. Give it the exact decision, the source evidence, counterexamples, the cost of reversing it, and the proposed acceptance checks. This applies even when the sources agree. Write its conclusion and open assumptions into the design document.

For a cryptography, security, or migration decision, also get a second Deep look in a separate context, built from the source evidence and the proposed decision without the first one's reasoning. Settle a real disagreement before dependent work continues.

The same applies during implementation: when a failed check, the code, or the user raises new design work, hold only the work that depends on it. The product choice itself is the user's.

## When implementation needs a Deep model

Use a Deep model for implementation when the work spans security, authorization, identity, cryptography, storage migration, or changes across repositories whose interfaces cannot be tested separately; after two failures with the same cause; when the discriminating red is unstable; or when a worker hands a task back. Mechanical work across repositories with independent checks stays General.

## Depth

At most two levels below you: a worker, and a child of that worker. A worker's children are the reviewers `review-and-fix` starts, the Deep model that examines a design decision, and a bounded extraction or trace. No child starts children of its own. Only the worker edits its branch.
