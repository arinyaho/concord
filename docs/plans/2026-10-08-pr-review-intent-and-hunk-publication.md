# PR review intent and hunk publication

## Decision

Treat repository owner/name references as the same repository when they differ only by ASCII letter case. Use this identity rule only when deciding whether a closing issue body may enter broad-review intent. Fetch a matching issue through the configured repository spelling. Continue to name foreign issues without fetching their bodies, and name same-repository issues that the review token cannot read.

Serialize diff hunk metadata to a safely created file in the runner's temporary directory, outside the untrusted repository checkout, and let jq read it from that file while constructing the inline review. Remove the file during worker cleanup. Keep the inline eligibility rule unchanged: a finding is inline only when its path and line fall within a changed hunk. Findings outside those hunks remain in the review body.

## Alternatives and costs

Exact-case repository comparison is simpler, but it drops same-repository requirements when GitHub returns canonical capitalization that differs from configuration. Case-folding the full intent text or changing configured values would affect unrelated data and external API spelling, so normalization is limited to the repository identity comparison.

Passing the full hunk map as one command-line argument is concise, but operating systems impose a limit on each argument. A file adds one temporary artifact and a read, while avoiding that per-argument ceiling. The checkout cannot own the artifact because reviewed content is untrusted and can include a symlink at the chosen path. `mktemp` in the runner's temporary directory creates the file independently of checkout contents and cleanup removes it on success and failure.

## Acceptance checks

- Same-repository issue references with case-only owner/name differences contribute their bodies to intent.
- Foreign issue bodies remain excluded, and unreadable same-repository issues remain non-fatal.
- A hunk map larger than Linux's per-argument limit still posts inline findings for changed lines and body findings for lines outside the diff.
- A checkout-provided `hunks.json` symlink cannot redirect the worker's hunk metadata write.
- Existing review boundaries, publication behavior, and the 256 KiB intent cap remain intact.

## Residual exposure

The review still holds the hunk map in a temporary file for the lifetime of the worker, so storage and jq processing scale with the diff size. This removes the operating-system single-argument limit; it does not impose a new total diff-size cap. The file is private to the runner's temporary directory and is removed by worker exit cleanup.
