# Gate verifier namespace contract

## Decision

`gate-verify` continues to read the complete correctness candidate set when paired gate mode runs, because cross-panel context lets it identify duplicate, related, or conflicting observations. That context does not transfer disposition ownership: `correctness` and `verify` own `correctness:*` candidates, while `gate` and `gate-verify` own `gate:*` candidates.

The initial `gate-verify` prompt and an artifact-normalization retry must state the same boundary: use correctness candidates only as context, write verdicts only for `gate:*` candidates, and never copy, accept, or reject `correctness:*` IDs. A retry must also preserve the reviewer's evidence and ask for a rewritten gate verdict rather than imply that deleting invalid entries to produce a clean artifact is acceptable.

Prompt generation will read the existing artifact role prefix contract instead of introducing a second namespace registry. Strict normalization remains unchanged and continues to reject cross-namespace IDs. The existing one-retry limit also remains unchanged.

## Trade-off

The prompt becomes slightly more explicit and the prompt generator depends on the artifact contract's role-prefix accessor. This is preferable to duplicated namespace literals that can drift from validation.

## Residual exposure

Reviewers can still ignore instructions and emit an invalid artifact. Strict validation and the bounded retry convert that behavior into a terminal harness failure rather than silently discarding evidence.
