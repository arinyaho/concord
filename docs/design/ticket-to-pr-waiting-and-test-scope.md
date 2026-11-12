# Waiting and test scope in ticket-to-pr

A model that waits by calling `sleep` repeatedly pays for a full request on every call, and a model that runs the whole test suite after every fix pays for the suite each time. The "Waiting and test scope" section of the `ticket-to-pr` skill therefore asks for one wait per long operation and one full run on the final head. The skill text is the authoritative statement; this note explains why it has that shape.

## Decision

Wait for a long command with one blocking wait or a background notification. The wait costs no model requests while it runs.

During implementation and fixes, run the tests focused on the change, in the environment CI uses. Run the full test suite once, on the final head.

Stage 6 (a failing test first, executing where CI executes) and stage 8 (the discriminating green on the final head) are unchanged by this rule.

## Cost and residual exposure

A defect that only the full suite shows appears at the end instead of during iteration. CI still runs the full suite on the pull request, so the defect is caught before merge.

A blocking wait ends at its condition or at the command's own time limit, so a wait whose condition never comes holds the turn until that limit.

## Evidence and executable gates

The skill-content test in `plugins/concord/hooks/test/ticket-writing-skill.test.js` asserts the waiting rule and the single full run as phrases in the `ticket-to-pr` skill and compares the shared and Codex copies. The Codex package's `bundle.mjs` regenerates the Codex copy.
