# Design work and applying a decision in ticket-to-pr

A rule that routes work to a more capable model only when a choice is important depends on the judgment of importance, which is itself design work, so the rule is applied by the agent least suited to apply it. The "Design work and applying a decision" section of the `ticket-to-pr` skill therefore routes by the kind of work. That section is the authoritative statement of the rule; this note explains why it has that shape, and where the two differ the skill governs.

## Decision

The rule asks one question that the task itself answers: does the task decide what something should be, or apply a decision already made. Design work (the content and wording of a rule, a contract, an interface, a schema, or an architecture) is examined by a model of the most capable class the harness offers, within the models the user allows. Implementation, tests, edits, pushes, and the pull request stay with the agent doing the work. A task that mixes both kinds is split by the reader.

A review finding against the content or wording of a rule, a contract, an interface, or a schema is design work.

The second look in a separate context for cryptography, security, and migration design stays. It names areas and not a degree of importance, so it needs no judgment to trigger.

A new design choice that changes the acceptance criteria, the scope, or the approved design is a product decision under [workflow-state-and-stops.md](workflow-state-and-stops.md): a worker reports it and does not make it.

## Cost and residual exposure

Design decisions cost a call to a more capable model. Patching rule wording with a default model over many attempts costs more than one such call.

A task can mix both kinds, and the split is the reader's judgment; the question is answerable from the task, but a boundary case is still decided by the reader.

## Evidence and executable gates

The skill-content test in `plugins/concord/hooks/test/ticket-writing-skill.test.js` asserts that the skill asks the design-versus-apply question and that a worker reports a new design choice, and compares the shared and Codex copies; the Codex bundler regenerates the Codex copy.
