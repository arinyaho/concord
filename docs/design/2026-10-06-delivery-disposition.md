# Delivery disposition at the bounded review boundary

`review-until-lgtm`, `review-and-fix`, `ticket-to-pr` and `initiative-to-prs` each bound review work: request and fix budgets, round budgets, and stop conditions. None of them says what a PR is once that bound is reached and residual findings remain. Without one answer, a PR either looks blocked when its approved scope is complete, or another review/fix cycle is launched to chase non-blocking residuals. The delivery disposition is that one answer: a deterministic classification of one exact PR revision pair, plus one disposition for every accepted finding.

## Classification

The classification has three values and is computed by one function, `classifyDelivery`, exported with `recordDelivery` from `core/lgtm-state.js` beside the existing review-until-lgtm state engine.

- `mergeable-clean`: every approved acceptance criterion is met, every required check succeeded on the exact head, configured reviews are terminal, no material choice is open, and no accepted finding is left as a residual (every accepted finding is `fixed`).
- `mergeable-with-follow-ups`: the same conditions hold, and every residual is verified follow-up eligible, grouped by root cause, and owned by a read-back tracker ticket, or deliberately accepted by a human named in `acceptedBy` who is authorized to accept the residual within the recorded authorization envelope of the workflow.
- `blocked`: any other state. The result lists every reason, so a reader sees all blockers at once.

`mergeable-*` means that the delivery workflow has nothing left to do for this pair. It does not mean the PR is merged, released or LGTM, and GitHub's own `mergeable` field is not an input.

## Inputs

The caller supplies one JSON evidence packet for the exact PR number and head SHA:

| Field | Meaning |
|---|---|
| `baseSha` | Resolved base SHA of the pair |
| `contractDigest` | SHA-256 of the approved contract (ticket, design note or acceptance criteria) the PR is judged against |
| `acceptance[]` | `{id, met}` for each approved acceptance criterion |
| `requiredChecks[]` | `{name, conclusion}` for each required check on the exact head; only `success` passes |
| `reviewsTerminal` | Every configured reviewer finished for this head |
| `openChoices[]` | Unsettled product, contract or architecture choices |
| `findings[]` | Every accepted finding: `{id, url, disposition, rootCause, releaseBlocking[], rationale, acceptedBy}` |
| `tickets[]` | One per follow-up root cause: `{rootCause, url, readBack, reused, duplicateCheck}` |

Finding `disposition` is one of `fixed`, `follow-up`, `accepted` or `blocking`. A finding with no disposition is unowned.

`releaseBlocking[]` names the observable release-blocking categories the finding falls in: `acceptance-criterion`, `required-check`, `correctness`, `security`, `data-integrity`, `contract-choice`, `compatibility`, `contradictory-docs`, `unproven-premise` (the work rests on a false or unproven premise) and `stage-exit` (a required stage exit condition is unmet). A finding in any of these categories blocks unless it is `fixed`. A `follow-up` or `accepted` disposition never clears it, and an exhausted budget does not either. A follow-up-eligible finding has no release-blocking category and has a `rationale` explaining why the approved outcome, required checks, safety boundary and documented behavior stay correct without it. Priority labels such as P1 or P2 are not inputs.

## Rules

Each rule below adds a reason, and any reason makes the result `blocked`:

- An unmet acceptance criterion, a required check whose conclusion is not `success`, non-terminal reviews, or an open choice.
- A finding that is unowned, marked `blocking`, release-blocking but not `fixed`, `follow-up` without a root cause or rationale, or `accepted` without `acceptedBy`. The classifier checks only that `acceptedBy` is present; it cannot verify that the named human holds that authorization.
- A follow-up root cause with no ticket. This is `rollover-pending`, and the result carries a ready-to-file packet for that group (its root cause, finding ids, URLs and rationales). Without tracker authorization or access, this is the outcome, and no ticket URL is invented.
- A ticket that was not read back, a reused ticket whose duplicate check is not recorded, one ticket URL shared by two root causes, or a ticket that owns no follow-up finding.

Follow-up findings are grouped by `rootCause`. Several findings with one root cause produce one ticket that carries all of their evidence. Unrelated root causes need separate tickets, so one URL may not own two root causes. Reusing an existing ticket requires a recorded duplicate check that shows the ticket carries the same outcome and scope.

## Persistence and launch suppression

`review-lgtm-state record-delivery <pr> <head-sha>` reads the packet on stdin, classifies it, and writes the result as a write-once marker `pr-<pr>-<head>.delivery-<recordedAtMs>-<digest16>.json` beside the existing review markers. The digest covers the canonical packet. The marker also records both PR-wide budgets at that moment, so the handoff can name their max, spent and remaining values. Recording the same packet again returns the latest record and writes nothing.

`status <pr> <head-sha>` reports the latest record for the head as `delivery`. While that record is `mergeable-*`, `claim-initial-request`, `recover-initial-request` and `claim-fix-round` refuse with `delivery-terminal`. Reopening an unchanged head therefore reports the stored classification and spends no request or fix budget.

A new commit is a new head and has no record. A changed base, approved contract or required-check result invalidates the record. The workflow detects this by comparing the live pair, contract digest and checks with the record, then records the new evidence. A record that is `blocked` because of drift (for example `reviews-not-terminal` after a retarget) allows claims again. The CLI cannot observe the live base or checks itself, so this comparison is part of the skill contract.

## Workflow integration

- `review-until-lgtm` records the delivery disposition once collection is terminal and no fix round is open, including after the fix budget is exhausted, and reports it in its handoff. Its earlier rule that only minor residuals may be proposed as a single follow-up issue is replaced by root-cause groups.
- `review-and-fix` is a local branch loop. Its `clean` ledger means its own rounds converged, which is not `mergeable-clean`. Parked, gate-pending and dismissed findings are inputs to the delivery disposition.
- `ticket-to-pr` stage 9 ends at a PR URL with a recorded delivery disposition. A stage exit condition is never a follow-up.
- `initiative-to-prs` reports each PR-backed unit's delivery disposition in the completion report. A `blocked` disposition leaves the unit `BLOCKED`.

Every workflow's final handoff names the exact head and base, required checks and their status, review/request/fix budgets, each finding id with its disposition (fixed findings separate from current follow-ups), follow-up ticket URLs or pending packets, whether the PR and thread links to those tickets are posted, and the classification. It never says clean or LGTM for `mergeable-with-follow-ups`.

When tracker mutation is authorized, the workflow links the source PR and each relevant review thread (the `url` of each follow-up finding) to the read-back ticket URL of its root cause. How a link is posted, and whether a thread is replied to or resolved, is provider-specific; that the link is posted is not. Without authorization no link is posted, the group stays `rollover-pending`, and no ticket URL is invented. Linking is a workflow step outside the evidence packet, so posting a link, or not posting one, does not change the classification.

## Rationale

The classifier is a pure function over an explicit packet. It does not query GitHub or the tracker. This keeps one decision identical across Claude, Codex and Copilot distributions. The provider-specific steps (reading checks, posting thread links, creating tickets) stay in the skills, where each host already does them. The record lives in the existing review-until-lgtm state directory, because that directory is already keyed by PR and exact head, and its claims are the launches the record must suppress.

Rejected alternatives:

- **A new review or verification pass that decides eligibility.** The ticket forbids another loop or reviewer role, and the verifier `review-until-lgtm` already runs settles whether a finding is real. The disposition only partitions findings that are already accepted.
- **Deciding eligibility from priority labels.** P1/P2 labels describe reviewer urgency, not whether the approved outcome holds. The release-blocking categories are observable statements about the finding.
- **Marking the classification invalid from inside the CLI.** The CLI cannot see the live base, contract or checks without provider calls. Recording new evidence is explicit and keeps the CLI provider-neutral.

## Residual exposure

- The classification is only as accurate as the packet. A caller that labels a release-blocking finding as follow-up eligible gets a `mergeable-with-follow-ups` result. The categories and the required rationale make that mislabel visible in the record and handoff, but the CLI cannot detect it.
- An `accepted` disposition is checked only for a non-empty `acceptedBy`. Whether the named human is authorized to accept the residual is the workflow's responsibility, and the CLI cannot detect an unauthorized acceptance.
- Launch suppression covers only `review-until-lgtm`'s request and fix claims. `review-and-fix` rounds are local and bounded by their own ledger. They are not refused by a delivery record.
- Base drift on an unchanged head is detected only when the workflow compares the live pair with the record. Until a new record is written, claims stay refused.
