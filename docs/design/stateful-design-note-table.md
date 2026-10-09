# State-and-event table in stateful design notes

A change that persists state or adds a retry, recovery or replay path has boundary combinations that prose does not enumerate, and a branch review finds them one at a time. The `ticket-to-pr` design note lists them up front as a transition table, and stage 6 gives each row evidence.

## Decision

The rule lives in the "Stateful changes" section of the `ticket-to-pr` skill, because installed packages ship the skill and not this note; stage 3 points to it for the table and stage 6 for the evidence.

The rule is principle-first: it names the trigger, the row shape (a state and an event, their resulting state and effects, a kind against the base revision, and evidence), the event classes authors most often miss, and one worked example, and leaves enumeration to the author. Rows cover the dimensions the change can affect, not the product of every persisted value; combinations an invariant rules out are listed once under the table. Introduced or changed rows get a test that is red before the change and green after it, or, when no test can exercise the row, a recorded reason and an executable stand-in check run by CI and held to the same bar; unchanged rows cite an existing test that passes after the change or record why none exists. A state or event found later, including in PR review, is added to the table in the same PR with its evidence.

Gaps a literal reading of the rule can name but no author has hit are follow-up items, not rule text. The rule is amended only when a finding shows that an author following it could ship an untested state or event, or that a stage exit is undecidable.

This change edits skill text, its test and this note only, so it touches no persisted state and adds or alters no retry, recovery or replay path, and has no table.

## Cost and residual exposure

The design note is longer for stateful changes.

The rule does not enumerate on the author's behalf; a state or event the author does not think of is still found only by review, and the same-PR rule bounds that cost. Short definitions leave terms such as "event" to the reader's judgment; the example is what fixes their meaning.

## Evidence and executable gates

The skill-content test in `plugins/concord/hooks/test/ticket-writing-skill.test.js` asserts the section, the stage pointers, the trigger, the row shape and the same-PR rule, and compares the shared, Codex and Copilot copies, which each package's `bundle.mjs` regenerates.
