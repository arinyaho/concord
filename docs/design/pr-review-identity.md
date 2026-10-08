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
API lookup against the immutable base-tip OID from the PR snapshot supplies the actual merge base; a changed base branch with the same
merge base preserves coverage. The worker verifies that its local merge base
matches the dispatched snapshot before reviewing.

Completed markers record head, mode, merge base and intent hash. A broad pass
covers later heads only while merge base and intent match. A changed merge base
or intent requires a fresh broad pass. Identical inputs suppress repeat work
when matching coverage or an active run is visible to the scanner. The scanner
reads the complete paginated workflow-run inventory, then uses identity-qualified
run names and status descriptions so an old run or failure cannot suppress
replacement inputs at the same head. Command IDs remain consumed across input
revisions once a workflow run reaches a terminal state, including a superseded
run that never posts. An operator submits a new command to request another attempt.

Legacy completions lack evidence of their base and intent. They require one
broad refresh; their command IDs remain consumed. A legacy active run suppresses
its own head until it finishes. A legacy failure without identity remains
suppressed pending an explicit command or a new commit. Exact attempt receipts
still reconcile publication status, independently of coverage, and remain the
second line of the review body.

The worker re-reads the complete review identity and head immediately before
each review POST, including a fallback POST. A changed input, head or failed
lookup prevents findings and thumbs-up, attempts to clear the eyes reaction and
settle the dispatched commit's status to error. Cleanup writes are best-effort;
an API outage can leave eyes or a pending status even when publication was
safely prevented. Before writing pending or terminal status, a worker checks
that the status is absent for a direct invocation or still belongs to its own
attempt. It verifies snapshot and status ownership before changing PR reactions. A replacement attempt's or unknown owner's status is left untouched. A direct
workflow retry may take over a terminal status; it cannot replace another
attempt that is still pending. The scanner writes an attempt's pending status
before dispatching its workflow, so an eager worker can verify ownership. A
failed status claim defers dispatch; a replacement status remains untouched.
A nonzero workflow-dispatch response is not proof that GitHub rejected
the run. The scanner preserves the attempt's status rather than writing a false
failure. Every poll reads the complete inventory before considering a retry.
Matching pending inputs wait 15 minutes from the latest status's creation time
by default (`DISPATCH_GRACE_SECONDS=900`, configurable from 1 to 86400 seconds),
including explicit same-input commands. Polling does not refresh this timestamp.
Missing or invalid timestamps defer retry because expiry cannot be proved.
A visible matching active run suppresses retry even after grace expires; when
the grace has expired and no run or completion evidence suppresses dispatch,
the scanner may create a fresh attempt. Changed heads or input identities are
eligible independently of the old claim's grace. A late worker must still
prove status ownership before acting. A review of a stale PR head still runs as a diff pass when broad coverage
exists for an older head; the activity cutoff applies only before first broad
coverage.
A superseded requested command receives no failed-command completion marker.
A final identity check also rejects a changed base or intent before publication.
After publication, the worker rechecks head before adding a PR-wide thumbs-up.
GitHub does not expose an atomic compare-and-post operation: a head can change
between the last lookup and the POST. Head, base or intent can change after the last lookup. A stale review or
reaction can therefore appear; this change cannot retract a stale POST or
guarantee its correction time. The reaction check avoids a thumbs-up when
the worker observes a changed head after posting.

The scanner checks intent even for inactive PRs with prior broad coverage:
editing a closing issue need not update PR activity. The activity cutoff still
prevents initial automatic reviews of inactive PRs. Refresh applies only to PRs returned by the existing newest-1000-open-PR
selection and actually processed before the workflow timeout. There is no
fair-rotation guarantee for excluded PRs or separate bound on closing-issue
reads. The dispatch cap limits issued workflow requests, including ambiguous
responses that may already have started a review, not metadata discovery cost.
A failed status claim issues no workflow request and consumes no cap slot.
The reported dispatch count includes ambiguous attempts.
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
  remain deduplicated and explicit refresh still runs. The complete workflow-run
  inventory is parsed before dispatch; incomplete pagination stops the poll.
- Advancing head during review or a failed head lookup posts neither findings
  nor thumbs-up; unchanged head posts; cleanup settles the old SHA.
- Publication receipts repair only their matching attempt.
- Direct/manual retries can take over legacy terminal statuses, but neither
  dispatched workers nor direct retries replace another attempt's pending status.
- An ambiguous workflow-dispatch response never overwrites worker progress with
  an error status. Repeated polls do not retry matching pending inputs during
  grace or renew the grace clock. Delayed active-run visibility suppresses retry
  after expiry; absent run evidence permits a fresh attempt after expiry.

The required checks are shellcheck and both shell fixture suites, executed by
`pr-review-lint.yml`. Review-and-fix uses the repository's configured DoD.
The service README documents the marker migration and operator behavior.
The PR closes #200, #204 and #206 together.
