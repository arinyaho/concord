---
name: cross-model-review
description: Run a second Concord review-until-green pass whose clean-context reviewers use a different GitHub Copilot model from the implementer or first review.
---

# Cross-Model Review

Use after a normal `review-until-green` run when the user requests independent model diversity. Re-arm the completed ledger with `node <plugin-root>/bin/review-cli.js rerun <ref> --engine <resolved-model>` and then follow the packaged `review-until-green` skill.

Invoke `Concord Reviewer` with an explicit Copilot model different from the implementer and first reviewer. Record the requested and resolved model in the handoff. Do not seed the reviewer with earlier findings; give it the approved contract, exact head/base pair, diff artifact, and required output schema only.

If a different model is unavailable under the current subscription, policy, or parent cost tier, stop and report that cross-model review is unavailable. Never silently reuse the same model or shell out to another vendor CLI.