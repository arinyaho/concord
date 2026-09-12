---
name: ticket-to-pr
description: >-
  Use when a request names a unit of work and asks for it to be taken through several stages at once —
  "이 티켓 설계부터 PR까지", "ES2-1234부터 하자", "take this issue through design, implementation and a PR",
  "이거 끝까지 해서 PR 올려줘". Do NOT use for a single-stage request (just fix this, just review this).
---

# Ticket to PR

One unit of work, one branch, one PR carrying the design and the code together. The stages below are a contract, not a suggested order: each one has an exit condition, and a stage whose exit condition is blocked stays blocked. It does not become a note in the PR body.

## The stages

| # | Stage | Exit condition |
|---|---|---|
| 0 | Branch | A dedicated work branch exists, is checked out, and starts from the intended base; create it if absent |
| 1 | End-to-end red | For a defect, the claimed breakage reproduces against the unchanged code; for a feature, an end-to-end acceptance check fails because the requested behavior is absent |
| 2 | The work has acceptance criteria and a definition of done, and any approved in-progress transition is applied | Every criterion names an observation, not an intention. The DoD says which gates are executable and which are deferred. The board reflects that work began only when the user approved that transition |
| 3 | Design note, committed where the next reader finds it | The decision, the trade-off it costs, and the residual exposure are all written down |
| 4 | Review the design note | `/review-until-green file:<path>` |
| 5 | Plan | Each task ends in something runnable and independently rejectable |
| 6 | Implement | Red test first, verified red for the right reason, and executing where CI will execute it |
| 7 | Review the diff | `/review-until-green <branch>` |
| 8 | End-to-end green | The same check passes against the change |
| 9 | One PR | Design, docs and code in the same PR; every document contradicted by the change corrected in it |

If the work is tracked somewhere and the user explicitly requests or approves an in-progress transition, move it before stage 3, not after stage 9 — a ticket sitting in the backlog while its branch already has commits is a board that lies to everyone reading it. Otherwise, preserve the current state. Expect an approved transition to fail closed on preconditions the tracker does not advertise: an assignee, a parent item that must itself be in-progress, an intermediate status that cannot be skipped. These are cheap to hit and slow to diagnose, so attempt the approved transition and read the refusal rather than assuming it will go through.

Nothing here moves the work to done. Stage 9 ends at a PR URL, and done follows a merge, which is not this pipeline's decision to make.

Stages 2, 3 and 5 have no single owner here — use whatever the repository already provides (a tracker, a `docs/` convention, a planning skill). Stages 4 and 7 are Concord's `review-until-green`. Stages 1 and 8 are described below, because they are the ones that get skipped.

## Stage 1 is the one that gets skipped

A change justified by "X is broken" is a claim about the world. The red run is what makes it a fact — not evidence you collect afterwards to decorate a PR. If stage 1 is blocked (an image to build, an environment to stand up), stage 1 is blocked. Shipping the PR with "red run pending" in the body is how a false premise reaches review.

**Reproduce the harm, not the mechanism.** A unit test proving "the code registers the wrong certificate" can be verified red and still prove nothing, because the claim was "and therefore login breaks" — which lives in someone else's system. The red must be observed at the altitude of the consequence the ticket names.

**When the shipped configuration cannot show it,** the answer is not to skip the red. Construct the configuration that can — a second profile, a different code path, a harness that builds both the before and the after artifact — and say in the test itself which configuration it discriminates on. A check that passes identically before and after is not evidence; label it so no later reader mistakes it for proof.

**Record what the run actually ran against.** Image tags, submodule pins, the commit each artifact was built from — and every place those diverge from what the branch declares. A red/green pair proves something about the artifacts in front of you, and the reader cannot tell which artifacts those were unless you say.

**Make both phases refuse to pass for the wrong reason.** A red phase that passes means the defect did not reproduce, which is a failure of the harness, not a success. A green phase whose preconditions were never met is inconclusive, not green.

## What review cannot do for you

Stages 4 and 7 read the artifacts in front of them. When the design note, the plan, the code comments and the diff all inherit the same false premise, no number of review rounds falsifies it — they agree with each other. In the run this skill came from, four rounds and ten findings left the premise untouched; the first run against the unchanged code broke it in one command.

So: contradictions inside the source are a signal to go measure, not a licence to resolve them in the direction you already chose. Two comments in one file disagreeing about what the code trusts means nobody knows. Open the execution path and find out.

## Stage 9: the documents that never quoted you

Sweep the whole branch diff for documents the change **contradicts** — a removed name still asserted elsewhere, a limitation other documents describe, an interface the change widened. Grep for the identifiers you touched, not only the files you edited.

That finds contradiction, and contradiction is half of it. The other half is what **omits** you: a section that described the thing without ever asserting the invariant you changed is not wrong — it is now incomplete, and incompleteness has no string to grep for. Find those by asking which documents tell an operator what to do with this thing, and reading them.

Sort every finding into one of three, and record the third as well as the first two: corrected in this PR, owned by a follow-up item that carries the procedure, or deliberately unchanged.

If the repository tracks known gaps or limitations, check both directions. Does the change close a row — an adjacent row is not the same row, so read it before claiming it. And does it create a residual that deserves one? A risk your own design note names, that nothing tracks, is a gap you introduced.

## Rationalizations

| Excuse | Reality |
|---|---|
| "The red run needs an image build, I'll add it after the PR" | Then the PR asserts something you have not checked. Build the image. |
| "The comments and the docs both say it works this way" | Comments are claims, not observations. Two of them agreeing means one was copied. |
| "The unit test is red, that's the regression test" | Only if it is red for the harm the ticket names. Mechanism ≠ consequence. |
| "The e2e passes, so the fix works" | Run it against the unchanged code. If it also passes, it discriminates nothing. |
| "The regression test passes locally" | Check the workflow actually runs it. A test CI never executes is not coverage. |
| "The doc sweep is clean, the docs are done" | A sweep finds contradictions. A document that never mentioned the invariant cannot contradict it, and is now incomplete. |
| "Review found ten things, it is thorough enough" | Diff-local review cannot reject a premise the whole diff shares. |
| "The design doc is new, there is nothing to review it against" | That is the reason to measure, not the reason to proceed. |

## Red flags

- A PR body sentence beginning "still to be verified"
- A stage exit condition rewritten as a follow-up ticket while the PR opens anyway
- An acceptance criterion that no command can decide
- A red test whose subject is your own code when the claim is about a dependency's behaviour
- Copying a premise out of a code comment into a design document
- A green run whose image tags and dependency pins are not written down anywhere
- A residual exposure that exists only in the design note you just wrote
- A branch with commits on it while the tracker still says the work has not started

## Notes

`review-until-green` reports its DoD as DEFERRED when the repository has no `review.config.json`; relay that rather than calling the run verified. Never merge — stage 9 ends at the PR URL.
