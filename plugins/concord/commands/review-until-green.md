---
description: Run the review-until-green convergence loop against a branch/target and display its terminal handoff
argument-hint: "[target | resume <ref>]"
---

The engine entry lives at `${CLAUDE_PLUGIN_ROOT}/hooks/review-engine.js`.

Arguments: `$ARGUMENTS`

Determine the target ref:

- If the arguments are empty, use the current git branch (`git branch --show-current`) as the target ref.
- If the arguments start with `resume `, the target ref is the text after `resume `.
- Otherwise, the target ref is the arguments themselves.

Do NOT embed the target ref (or anything else user-supplied) inside a shell command string built by string concatenation -- a ref/branch name is caller-controlled and this must stay shell-injection-safe. The engine takes the ref as a plain CLI argument (not a flag value assembled from free text), so this is safe as long as you pass it as-is and do not let it flow through `bash -c "...${ref}..."` or similar interpolation.

Run:

    node "${CLAUDE_PLUGIN_ROOT}/hooks/review-engine.js" <ref> [base]

This runs the full loop synchronously to convergence, budget exhaustion, or an early stop (harness-failure or park-budget circuit breaker), making real `claude -p` calls per round -- it can take multiple minutes and cost real money per the design's cost estimate. Let it run to completion; do not interrupt it partway and improvise a summary from partial output.

When it finishes, display its terminal handoff verbatim to the user: rounds, killed/fixed/parked counts, the per-fix rationale digest (finding -> fix -> commit), and any needs-decision packets (finding, why the auto-fix failed, the decision needed). If the run aborted with a harness-failure, say so plainly and do not characterize the run as parked or converged.

If a ledger for this target already exists and is `parked`, tell the user up front that resuming will NOT automatically re-run parked findings -- they must `unpark` a specific finding first (via `review-cli.js unpark <ref> <findingId>`) if they want it re-attempted.

Do not editorialize beyond the handoff. Do not run the engine more than once per invocation of this command.
