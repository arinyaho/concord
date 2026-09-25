# Stages

Every stage writes a handoff before the orchestrator advances. Source documents describe intent; current code and an execution against the relevant entry point establish behavior.

## 1. Evidence and contract

This stage is read-only except for narrowly scoped, owner-controlled synthetic test state when the applicable project instructions and user authorization permit it.

Read the authoritative brief and design, current related tickets and comments, relevant repository instructions and code, and the deployed or otherwise shipped behavior named by the report. Search for duplicate or superseding work. Trace the real caller and upstream guards before treating a code path as reachable. Reproduce the reported consequence at the same environment, entry point, and state provenance when possible; label every unmatched coordinate next to the result.

Before this stage exits, complete synthetic-state teardown and read-back for every account, record, job, or resource created for evidence gathering. Explicit authorization to retain synthetic state must include a named owner and cleanup condition; record that disposition in the handoff.

Separate these classes in the evidence packet:

- Observed current behavior
- Behavior present in code and proven reachable
- Behavior present in code but not proven reachable
- Accepted product or design intent
- Tracker or comment claims without independent evidence
- Material decisions that remain unsettled

Run the architecture decision gate in `model-routing.md` before proposing a contract or ticket set. Record the required model class, resolved model, reviewed decision, and remaining assumptions in this stage's handoff.

Propose the smallest behavioral contract and ticket set supported by the evidence. Each proposed ticket names its outcome, scope, non-goals, affected surface, observable acceptance checks, executable Definition of Done, dependencies, and whether current behavior supplies a discriminating red condition. For a multi-repository outcome, also propose one implementation unit per repository, an integration owner, artifact/version dependencies, and the combined acceptance gate. Do not invent file paths before tracing the caller.

If current behavior already satisfies the approved outcome, propose a no-change closure with its evidence instead of manufacturing tickets or PRs.

### Human checkpoint 1

Present a concise evidence verdict, material decisions with realistic options and consequences, recommended contract, proposed tickets, dependencies, any no-change items, and each proposed design-record mutation. Record the user's exact decisions, ticket-set approval, and specific approval or rejection of every proposed design-record mutation. No tracker or design-document mutation occurs before this checkpoint.

## 2. Ticket set

Use `ticket-writing` for every approved ticket. Reuse or update existing work when it already owns the outcome. Create new tickets only for approved gaps. Keep provider-native formatting and the project's artifact language.

Synchronize an affected product or architecture design only when the user explicitly approved that specific mutation at checkpoint 1, the approved contract changes it, and project instructions authorize that document system. Apply external-document mutations in this stage. Assign every repository-backed design mutation to one approved repository unit, then create, review, commit, and deliver it on that unit's branch and PR. Keep product design timeless and keep implementation paths and test locations in local plans or tickets.

Read every ticket and changed design record back. Verify exact titles, bodies, links, attachments, statuses, acceptance criteria, Definition of Done, decisions, and preserved fields. A ticket is not ready when an unresolved question can change its outcome, scope, or design direction. Do not count comments, implementation notes, or a screenshot alone as acceptance criteria or Definition of Done.

Write the dependency order and one execution handoff per implementation unit. Each handoff contains the final outcome ticket URL, accepted contract, evidence identity, unit repository, target base, artifact/version prerequisites, authorization envelope, and executable gates. For multi-repository work, retain one ticket-level record of the ordered units, their owners and PRs, the integration owner, and the combined acceptance gate. Do not prescribe speculative implementation details.

### Human checkpoint 2

Present the read-back ticket set, design changes, dependency order, observable acceptance criteria, Definition of Done, and any rejected fields or blocked transitions. Continue only after the user approves implementation of that exact set.

## 3. Execute each repository unit

Execute dependency-ready repository units with `ticket-to-pr`. Its stage exits remain authoritative. Keep routine implementation, review, and final mutations with the active agent unless the user, selected model, or CLI harness requires delegation; the architecture decision gate in `model-routing.md` expressly requires a deep-capability specialist when the active agent cannot provide that review.

During implementation and review, watch for a new material architecture or behavioral choice arising from user discussion, test results, or code tracing. Invoke the architecture decision gate before the dependent change is made; an approved ticket does not settle a newly discovered choice. Independent work may continue while that decision is reviewed.

The implementer establishes the unchanged red at the altitude of the ticket's observable outcome, or reads back that shared evidence for a later repository unit and establishes a discriminating red for that unit's contract. Write the design required by `ticket-to-pr`. Commit the initial design note, run `ticket-to-pr`'s file-target review to clean, and commit any accepted review fixes before planning or implementation begins. Then write the plan, implement the smallest root-cause change, prove the check runs where CI runs it, and reach local green. If unchanged behavior already satisfies the relevant check (the outcome acceptance check for a single-repository ticket or the repository unit's contract check for a multi-repository ticket), do not enter `ticket-to-pr`'s PR exit. Return `NO PR NEEDED` only after recording the reproduction and reconciling the approved work to an explicitly approved no-change closure or supersession, or removal of an unnecessary unit from a multi-repository ticket through checkpoint 2, then reading it back; without that authorization or read-back, the work is `BLOCKED`, not a successful no-PR disposition. Then correct the initiative record instead of changing code.

Run `review-until-green` as `ticket-to-pr`'s required diff-local gate. When an independent reviewer role is authorized, route the ticket contract, evidence identity, branch or diff, and verification commands to that reviewer in a separate handoff. It verifies premise, contract coverage, reachability, security and data boundaries, test execution, documentation completeness, and unnecessary complexity without receiving the implementer's handoff or editing the branch. When it finds an in-contract issue, final mutations apply the fix, commit the accepted change, explicitly re-arm the clean diff-local ledger by invoking `rerun <ref>` through the runtime-specific packaged review CLI path documented by `review-until-green`, rerun `review-until-green` on the changed diff with the same target and base, and return the resulting diff to a fresh independent review; repeat until clean in both gates on the same final diff. A clean ledger returns terminal without reviewing changed content, so merely invoking `review-until-green` again is insufficient. Any later code or documentation mutation must pass this review cycle again before push or PR creation. This contract review supplements rather than replaces `review-until-green`.

Record the exact reviewed head commit SHA, target base branch, and resolved base commit SHA in the handoff for each passing diff-local review and each required independent review. All required review gates must cover the same revision pair.

Final mutations apply verified findings, rerun the same green check plus repository-required checks, sweep affected documentation, push the branch, create the PR from the repository template, attach the exact PR URL to the ticket where authorized, wait within the repository or provider bounded window for required PR checks on the exact final head and resolved base pair, and then read both PR and ticket back. A finding that changes the approved product contract returns to the user. If the user approves a revised contract, invalidate the affected ticket and its downstream handoffs. Every approved contract revision returns to the ticket set stage: update and read back the ticket through `ticket-writing`, then pass checkpoint 2 again before implementation resumes. Only a revision that changes a product or architecture design record also returns through checkpoint 1 for specific approval, then updates and reads back that approved design record alongside the ticket before checkpoint 2. For each already-reviewed design note changed by the revised contract, update and commit the note, explicitly re-arm its file-target ledger by invoking `rerun file:<path>` through the runtime-specific packaged review CLI path documented by `review-until-green`, pass `/review-until-green file:<path>` again, and commit the final reviewed note after that review reaches clean before planning or implementation resumes; changed content at the same path does not invalidate a clean ledger. A correctness finding within the approved contract is fixed without a routine checkpoint.

Execute implementation units sequentially by default. Parallelize only independent units with separate repositories or worktrees and no shared mutable state or contract dependency. A failure in one unit does not erase completed evidence for another, but an upstream contract failure blocks every dependent unit. A package release required before a downstream pin is a real dependency: stop that unit until the released version and provenance can be read back. The pipeline does not perform the release.

## 4. Initiative completion

The initiative's PR delivery exits successfully when every approved implementation unit has one of these verified dispositions:

- A PR URL whose head, base, body, and documentation disposition were read back, whose tracker link was read back when that mutation was authorized or whose not-authorized disposition was recorded otherwise, whose current head commit SHA, target base branch, and resolved base commit SHA match the recorded passing review gates, and for which every required PR check is in a successful terminal state for that revision pair; a pending check remains in progress during the bounded wait, while a terminal failure, a missing required check after read-back, or an expired bounded wait leaves the unit `BLOCKED`
- `NO PR NEEDED`, supported by a discriminating current-behavior check and a read-back of the explicitly approved ticket closure or supersession, or removal of an unnecessary unit through checkpoint 2 without closing the outcome ticket

For PR-backed dispositions only, at completion compare the live PR revision pair with the recorded review evidence, including the current tip of a stacked prerequisite base. Missing revision evidence or any head or base drift invalidates the review and check gates and leaves the unit `BLOCKED`. Fetch the live PR head and target base. Re-run the relevant discriminating check (the outcome acceptance check for a single-repository ticket or the unit's contract check for a multi-repository ticket) against the exact fetched live base before integrating the unit branch. If that check is no longer red, return through the approved `NO PR NEEDED` or contract-reconciliation path. When an existing PR already represents the unit, this route also requires explicit authorization to close or mark that PR obsolete and a read-back of its final state; without that authorization and read-back, leave the ticket `BLOCKED`. With a clean worktree and no unpushed commits, check out the local PR branch and reset it to the exact fetched live head SHA so review fixes remain attached to the branch; otherwise stop and reconcile the local work first. Integrate the exact live base into the unit branch according to repository policy; if repository policy forbids integration, leave the ticket `BLOCKED`. Re-arm the diff-local ledger by invoking `rerun <ref>` through the runtime-specific packaged review CLI path documented by `review-until-green`, rerun the stage 3 review cycle against the integrated head and base (including every required independent review), rerun required checks, and update the remote only after they pass. If integration rewrote history, push the final reviewed commit with `--force-with-lease=<remote-ref>:<fetched-live-head-sha>`, using the fetched live head SHA as the expected value, only when repository policy authorizes history rewriting; otherwise leave the ticket `BLOCKED`. Without history rewriting, push normally. Wait within the bounded provider or repository window for required PR checks on the exact final head and resolved base pair, then repeat the PR read-back and revision comparison before reporting completion.

For a multi-repository outcome, additionally read back the ticket's complete PR list and exact artifact/version dependencies. Record the outcome-level red and the status of the combined green check separately from PR delivery. The outcome ticket is not `READY FOR TEST` until the exact combined artifacts are deployed in a testable environment and the integration owner has supplied a runnable QA hand-off; it is not `Done` merely because all PRs were opened or merged. Do not transition either status through this PR pipeline. If a required combined check cannot run before delivery, name its owner and unblock condition and report the outcome as pending verification, even when the PR units are complete.

If any approved unit is `BLOCKED`, the initiative's PR delivery exits blocked rather than successfully. Report the exact failed exit condition, owner, and unblock condition alongside the completed dispositions. Never describe an open PR as merged, released, deployed, QA-accepted, or available to customers.
