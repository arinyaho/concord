# Document review follow-ups

Each new file-target attempt opts into a bounded review-and-fix cycle for a document. It performs an initial review, verification, and any required fixes, then one confirmation pass over the updated file. Legacy attempts retain their stored review policy. A finding that remains after confirmation may be reported as a follow-up only when the independent verifier confirms it as minor and non-blocking. The follow-up retains the finding's original ID and the rationale that explains why the document remains accurate without a fix.

The terminal status is `reviewed-with-followups`. It means the confirmed minor findings remain open; it is not a clean result. The driver reports the IDs and rationales and stops. It does not launch another automatic review or discard those findings. Repeating `round-start` replays this terminal outcome. When the user explicitly requests additional review, use `review-cli rerun <ref>` to archive the prior ledger and evidence before starting a new attempt; do not silently reset the ledger or increase its budget.

Release-blocking, unknown, unverifiable, or otherwise unconfirmed findings remain actionable. The verifier's confirmation applies only to a matching original finding and cannot override a blocking category or a conflicting rejection. Missing or malformed classification fails closed. Review prompts carry the shared finding and confirmation requirements; drivers must follow the CLI's durable outcome rather than infer a disposition from reviewer prose.

This policy applies to file targets only. Git-target review and initiative review retain their existing terminal and follow-up policies.
