# Delegation by kind of work in ticket-to-pr

A rule that routes work to a deep-capability agent only when a choice is important depends on the judgment of importance, which is itself design work, so the rule is applied by the agent least suited to apply it. The "Delegation" section of the `ticket-to-pr` skill therefore routes by the kind of work. That section is the authoritative statement of the rule; this note summarizes it only to explain why it has that shape, and where the two differ the skill governs.

## Decision

The rule asks one question that the task itself answers: does the task decide what something should be, or apply a decision already made. Design work (the content and wording of a rule, contract, interface, schema or architecture) goes to a deep-capability agent; implementation, tests, edits, pushes and PR handling stay with the active agent. A task that mixes both kinds is split by the reader.

A review finding against the content or wording of a rule, contract, interface or schema is design work. For a finding a PR review raised, in a thread or in a review body, the skill defers to the "Adjudicate and escalate" subsection of `review-until-lgtm`, which sends such a finding to a Fable-class adjudicator when a signal of suspicion holds; for a finding local review raised, the deep-capability agent rules on it and the active agent applies the verdict, because patching wording without that ruling repeats the many-round pattern the rule exists to prevent. A finding in a review body has no thread, so the reply that subsection posts on a thread goes instead to a PR comment that quotes the finding's URL, with the same disposition.

The separate-reviewer requirement for cryptography, security and migration stays. It names areas and not a degree of importance, so it needs no judgment to trigger.

## Cost and residual exposure

More work goes to deep-capability agents. Ticket #223 records the measured cost of one escalation in #218 as about 70K tokens, against many rounds of default-model patching of the "Stateful changes" wording (PR #221).

A task can mix both kinds, and the split is the reader's judgment; the question is answerable from the task but a boundary case is still decided by the reader.

## Evidence and executable gates

The skill-content test in `plugins/concord/hooks/test/ticket-writing-skill.test.js` asserts that the section does not contain the word "material" and does contain the design-versus-apply question, the separate-reviewer requirement and the pointer to the "Adjudicate and escalate" subsection as literal phrases, and compares the shared, Codex and Copilot copies, which each package's `bundle.mjs` regenerates.
