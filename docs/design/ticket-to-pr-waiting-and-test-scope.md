# Waiting and test scope in ticket-to-pr

A model that waits by calling `sleep` repeatedly pays for a full request on every call, and a model that runs the whole test suite after every fix pays for the suite each time. The "Waiting and test scope" section of the `ticket-to-pr` skill, the waiting steps of `review-until-lgtm` and the review driver therefore ask for one wait per long operation and one full run per PR head. The skill text is the authoritative statement; this note explains why it has that shape.

## Decision

Wait for a long command with one blocking wait or a background notification. `review-until-lgtm` and the review driver wait in one shell command that exits when the condition is true, or when the collection deadline or the driver process ends, so the wait costs no model requests while it runs.

During implementation and fix rounds, run the tests focused on the change, in the environment CI uses. Run the full test suite once on the final head, together with the DoD. When a turn passes 30 minutes, state in one line what is running and the budget status.

Stage 6 (red first, executing where CI executes) and stage 8 (the discriminating green runs once on the exact final head) are unchanged.

## Cost and residual exposure

A defect that only the full suite shows appears at the end instead of during iteration. CI still runs the full suite on the pull request, so the defect is caught before merge.

A one-shell-command wait ends at its condition or deadline, so a wait that never reaches either holds the turn until the shell call's own time limit; the 30-minute report line bounds how long the user goes without a status.

## Evidence and executable gates

Ticket #220 records the run that motivated the rule: 73 of 305 tool calls were `sleep` polls at about 108K tokens of context each, and the full plugin suite ran at least four times between the first implementation and the final head.

The skill-content test in `plugins/concord/hooks/test/ticket-writing-skill.test.js` asserts the three rules as literal phrases in the three `ticket-to-pr` copies, the waiting phrases in the three `review-until-lgtm` copies and the four review-driver copies, and that the old polling wording is gone. Each package's `bundle.mjs` regenerates the Codex and Copilot copies.
