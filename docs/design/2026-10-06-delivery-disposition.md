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
| `reviewIds` | Ids of the active review batch (recorded, not rejected) that the packet classifies; empty when none. A record whose ids differ from the batch active at write time is refused with `review-batch-changed`, so a review that arrives while the packet is assembled is never classified unseen |
| `contractDigest` | SHA-256 of the approved contract (ticket, design note or acceptance criteria) the PR is judged against |
| `acceptance[]` | `{id, met}` for each approved acceptance criterion |
| `requiredChecks[]` | `{name, conclusion}` for each required check on the exact head; only `success` passes. An empty list asserts that the repository requires no check on this head |
| `reviewsTerminal` | Every configured reviewer finished for this head |
| `openChoices[]` | Unsettled product, contract or architecture choices |
| `findings[]` | Every accepted finding: `{id, url, disposition, rootCause, releaseBlocking[], rationale, acceptedBy}` |
| `tickets[]` | One per follow-up root cause: `{rootCause, url, readBack, reused, duplicateCheck}` |

Finding `disposition` is one of `fixed`, `follow-up`, `accepted` or `blocking`. A finding with no disposition is unowned.

`releaseBlocking[]` names the observable release-blocking categories the finding falls in: `acceptance-criterion`, `required-check`, `correctness`, `security`, `data-integrity`, `contract-choice`, `compatibility`, `contradictory-docs`, `unproven-premise` (the work rests on a false or unproven premise) and `stage-exit` (a required stage exit condition is unmet). A finding in any of these categories blocks unless it is `fixed`. A `follow-up` or `accepted` disposition never clears it, and an exhausted budget does not either. A follow-up-eligible finding has no release-blocking category and has a `rationale` explaining why the approved outcome, required checks, safety boundary and documented behavior stay correct without it. Priority labels such as P1 or P2 are not inputs.

## Rules

Each rule below adds a reason, and any reason makes the result `blocked`:

- No acceptance criteria at all (`acceptance-missing`), an unmet acceptance criterion, a required check whose conclusion is not `success`, non-terminal reviews, or an open choice.
- A finding that is unowned, marked `blocking`, release-blocking but not `fixed`, `follow-up` without a root cause or rationale, or `accepted` without `acceptedBy`. The classifier checks only that `acceptedBy` is present; it cannot verify that the named human holds that authorization.
- A follow-up root cause with no ticket. This is `rollover-pending`, and the result carries a ready-to-file packet for that group (its root cause, finding ids, URLs and rationales). Without tracker authorization or access, this is the outcome, and no ticket URL is invented.
- A ticket that was not read back, a reused ticket whose duplicate check is not recorded, one ticket URL shared by two root causes, or a ticket that owns no follow-up finding.

Follow-up findings are grouped by `rootCause`. Several findings with one root cause produce one ticket that carries all of their evidence. Unrelated root causes need separate tickets, so one URL may not own two root causes. Reusing an existing ticket requires a recorded duplicate check that shows the ticket carries the same outcome and scope.

## Persistence and launch suppression

`review-lgtm-state record-delivery <pr> <head-sha>` reads the packet on stdin, classifies it, and writes the result as a write-once marker `pr-<pr>-<head>.delivery-<sequence>.json` beside the existing review markers. The sequence number is assigned under the PR transition lock, so the latest record is the one written last, whatever the wall clock says; a concurrent call returns `transition-busy` and is retried. The digest covers the canonical packet: only the fields defined above, in a fixed key order, with SHAs lowercased and every text field trimmed. Entries are validated: each acceptance criterion needs an id, each required check a name and conclusion, and ids, check names, finding ids and ticket root causes are unique, so key order, extra fields and padding do not produce a new record. The marker also records both PR-wide budgets at that moment, so the handoff can name their max, spent and remaining values. A packet whose digest equals the digest of the latest record for the head writes nothing and returns that latest record. Any other packet, including one that matches an older record, writes a new record, so the latest record always holds the most recently submitted evidence.

`status <pr> <head-sha>` reports the latest record for the head as `delivery`. Each record stores the ids of the review batch active when it was written, and every finding keeps its root cause, release-blocking categories, rationale and `acceptedBy`, so a resumed handoff can audit each disposition. A review recorded or rejected for the head after the record changes that batch: `delivery.current` becomes false and the record no longer suppresses claims, so a delayed provider review can be reconciled. A head with no review record at all (a clean finish) still reports `report-delivery`. While that record is current and `mergeable-*`, `claim-initial-request`, `recover-initial-request` and `claim-fix-round` refuse with `delivery-terminal`. Reopening an unchanged head therefore reports the stored classification and spends no request or fix budget. `status.reconciliation` then reports action `report-delivery` instead of directing a fix round. `record-delivery` refuses with `fix-round-open` while a fix round for the head is claimed, so a record is never written under an active fixer.

A new commit is a new head and has no record. A changed base, approved contract or required-check result invalidates the record. The workflow detects this by comparing the live pair, contract digest and checks with the record, then records the new evidence. A record that is `blocked` because of drift (for example `reviews-not-terminal` after a retarget) allows claims again. The CLI cannot observe the live base or checks itself, so this comparison is part of the skill contract.

## Workflow integration

- `review-until-lgtm` records the delivery disposition once collection is terminal and no fix round is open, including after the fix budget is exhausted, and reports it in its handoff. Residual findings roll over as root-cause groups, not as one combined follow-up issue.
- `review-and-fix` is a local branch loop. Its `clean` ledger means its own rounds converged, which is not `mergeable-clean`. Its ledger findings enter `findings[]` as follows, and each keeps its release-blocking categories, so no ledger state clears a release-blocking finding: a parked finding is not fixed, so it enters as `follow-up`, `accepted` or `blocking` under the rules above, and a parked finding that needs a human decision stays `blocking` until that decision is made; an open broad-review (gate) finding is a follow-up candidate only when its finder reported an empty `releaseBlocking` array and a non-empty `rationale` saying why the approved outcome, checks, safety boundary and documented behavior stay correct without it, and gate-verify did not list it in `blocking`; when every open gate finding is a follow-up candidate the loop converges and the handoff lists them for rollover as root-cause tickets, and any release-blocking, unclassified or panel-confirmed gate finding keeps the run gate-pending (fail closed); a gate-pending finding enters as `blocking` while its gate is unresolved, becomes `fixed` only after a re-run resolves it, and is treated as a dismissed finding once dismissed; a dismissed finding is one a human chose to leave unchanged, so it enters as `accepted` with that human in `acceptedBy`, or as `follow-up` when it is deferred to a ticket; a killed finding (rejected as a false positive) is not an accepted finding and is excluded.
- `ticket-to-pr` stage 9 ends at a PR URL with a recorded delivery disposition. A stage exit condition is never a follow-up.
- `initiative-to-prs` reports each PR-backed unit's delivery disposition in the completion report. A `blocked` disposition leaves the unit `BLOCKED`.

Every workflow's final handoff names the exact head and base, required checks and their status, review/request/fix budgets, each finding id with its disposition (fixed findings separate from current follow-ups), follow-up ticket URLs or pending packets, whether the PR and thread links to those tickets are posted, and the classification. It never says clean or LGTM for `mergeable-with-follow-ups`.

When tracker mutation is authorized, the workflow links the source PR and each relevant review thread (the `url` of each follow-up finding) to the read-back ticket URL of its root cause. How a link is posted, and whether a thread is replied to or resolved, is provider-specific; that the link is posted is not. Without authorization no link is posted, the group stays `rollover-pending`, and no ticket URL is invented. Linking is a workflow step outside the evidence packet, so posting a link, or not posting one, does not change the classification.

## Rationale

The classifier is a pure function over an explicit packet. It does not query GitHub or the tracker. The Codex and Copilot packages each carry a bundled copy of the state engine, including `lgtm-state.js`, produced by their existing bundling step (`bin/bundle.mjs` in each package), and the existing bundle-drift tests keep those copies byte-identical to `core/`. That parity mechanism plus the pure classifier keeps one decision identical across Claude, Codex and Copilot distributions, and the synchronized skill-contract and package-parity tests for `ticket-to-pr`, `initiative-to-prs`, `review-and-fix` and `review-until-lgtm` check that each distribution's workflows use it the same way. The provider-specific steps (reading checks, posting thread links, creating tickets) stay in the skills, where each host already does them. The record lives in the existing review-until-lgtm state directory, because that directory is already keyed by PR and exact head, and its claims are the launches the record must suppress.

Rejected alternatives:

- **A new review or verification pass that decides eligibility.** The ticket forbids another loop or reviewer role, and the verifier `review-until-lgtm` already runs settles whether a finding is real. The disposition only partitions findings that are already accepted.
- **Deciding eligibility from priority labels.** P1/P2 labels describe reviewer urgency, not whether the approved outcome holds. The release-blocking categories are observable statements about the finding.
- **Marking the classification invalid from inside the CLI.** The CLI cannot see the live base, contract or checks without provider calls. Recording new evidence is explicit and keeps the CLI provider-neutral.

## Residual exposure

- The classification is only as accurate as the packet. A caller that labels a release-blocking finding as follow-up eligible gets a `mergeable-with-follow-ups` result. The categories and the required rationale make that mislabel visible in the record and handoff, but the CLI cannot detect it.
- An `accepted` disposition is checked only for a non-empty `acceptedBy`. Whether the named human is authorized to accept the residual is the workflow's responsibility, and the CLI cannot detect an unauthorized acceptance.
- Launch suppression covers only `review-until-lgtm`'s request and fix claims. `review-and-fix` rounds are local and bounded by their own ledger. They are not refused by a delivery record. Their `clean` ledger can carry follow-up candidates; that convergence is not a delivery disposition.
- Base drift on an unchanged head is detected only when the workflow compares the live pair with the record. Until a new record is written, claims stay refused.
