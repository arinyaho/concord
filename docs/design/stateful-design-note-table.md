# State-and-event table in stateful design notes

A stateful change has boundary combinations of state and event that prose does not enumerate, and a branch review finds them one at a time, each costing a review round. The "Stateful changes" section of the `ticket-to-pr` skill makes the design note list them up front as a transition table and makes stage 6 give each row evidence. That section is the only statement of the trigger, the row shape and the evidence rules; this note says why the rule has that shape and does not restate it.

## Decision

The rule lives in the skill because installed packages ship the skill and not this note; stage 3 points to it for the table and stage 6 for the evidence.

The rule is principle-first: a short trigger, one row shape, the event classes authors most often miss, and one worked example, with enumeration left to the author. Rows cover the dimensions the change can affect rather than the product of every persisted value, because a full factorial produces rows nobody tests and buries the ones that matter. The example fixes the meaning of the terms instead of further definitions, because each added definition introduces terms that themselves need defining and the text never closes.

Gaps a literal reading of the rule can name but no author has hit are follow-up items, not rule text. The rule is amended only when a finding shows that an author following it could ship an untested state or event, or that a stage exit is undecidable.

This change edits skill text, its test and this note only; under that section's trigger it is not stateful and has no table.

## Cost and residual exposure

The design note is longer for stateful changes.

The rule does not enumerate on the author's behalf; a state or event the author does not think of is still found only by review, and the section's same-PR rule bounds that cost. Short definitions leave terms such as "event" to the reader's judgment; the example is what fixes their meaning.

## Evidence and executable gates

The skill-content test in `plugins/concord/hooks/test/ticket-writing-skill.test.js` asserts the section, the stage pointers, the trigger, the row shape and the same-PR rule, and compares the shared, Codex and Copilot copies, which each package's `bundle.mjs` regenerates.
