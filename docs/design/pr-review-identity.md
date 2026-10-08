# Dispatched pull request review identity

A review covers a head commit, the actual merge base used to produce its diff,
and the requirements collected from the pull request and its closing issues.
The SHA-256 identity is a versioned hash of those three values. Attempt UUIDs
identify publication attempts separately from reviewed inputs.

The scanner and worker share a snapshot collector. It reads the PR head,
base branch, title, body and closing issue references together, reads issues in
stable repository/number order, and renders the exact intent text passed to a
broad review. Foreign issues and unreadable local issues retain the service's
explicit omission messages. The intent hash includes those messages. A compare
API lookup supplies the actual merge base; a changed base branch with the same
merge base preserves coverage. The worker verifies that its local merge base
matches the dispatched snapshot before reviewing.

Completed markers record head, mode, merge base and intent hash. A broad pass
covers later heads only while merge base and intent match. A changed merge base
or intent requires a fresh broad pass. Identical inputs suppress repeat work.
Active workflow names and failed status descriptions carry the full identity,
so an old run or failure cannot suppress replacement inputs at the same head.
Command IDs remain consumed across input revisions once a command posts or
fails; supersession before posting keeps a requested command eligible.

Legacy completions lack evidence of their base and intent. They require one
broad refresh; their command IDs remain consumed. A legacy active run suppresses
its own head until it finishes. A legacy failure without identity remains
suppressed pending an explicit command or a new commit. Exact attempt receipts
still reconcile publication status, independently of coverage, and remain the
second line of the review body.

The worker re-reads head immediately before each review POST, including a
fallback POST. A changed head or failed lookup prevents findings and thumbs-up,
clears the eyes reaction, and settles the dispatched commit's status to error.
A superseded requested command receives no failed-command completion marker.
A final identity check also rejects a changed base or intent before publication.
After publication, the worker rechecks head before adding a PR-wide thumbs-up.
GitHub does not expose an atomic compare-and-post operation: a head can change
between the last lookup and the POST. This residual race is bounded by the
additional reaction check and the following scanner poll.

The scanner checks intent even for inactive PRs with prior broad coverage:
editing a closing issue need not update PR activity. The activity cutoff still
prevents initial automatic reviews of inactive PRs. This costs metadata and
issue reads on covered inactive PRs, bounded by the scanner's 1000-PR limit.
Unavailable PR or merge-base metadata defers dispatch. Unreadable local issue
content uses the established omission policy, so review covers only visible
requirements; gaining access changes intent and triggers a broad refresh.

## Acceptance and validation

The shell fixture tests run the real scanner and worker against fake GitHub
responses and local Git repositories. They must reproduce these consequences
against the unchanged scripts, then pass after implementation:

- Same head with changed merge base dispatches broad; another base branch with
  the same merge base does not dispatch redundantly.
- Changed title, body or readable closing issue intent dispatches broad;
  unchanged intent does not. New heads reuse matching broad coverage as diff.
- Full identity controls active and failed suppression, while manual commands
  remain deduplicated and explicit refresh still runs.
- Advancing head during review or a failed head lookup posts neither findings
  nor thumbs-up; unchanged head posts; cleanup settles the old SHA.
- Publication receipts repair only their matching attempt.

The required checks are shellcheck and both shell fixture suites, executed by
`pr-review-lint.yml`. Review-and-fix uses the repository's configured DoD.
The service README documents the marker migration and operator behavior.
The PR closes #200, #204 and #206 together.
