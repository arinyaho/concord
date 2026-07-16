# Review Target Generalization — High-Level Design

Status: DESIGN (architecture-level / north-star). Decomposed into 3 phases; each phase gets its own detailed spec → plan → implementation cycle. This document fixes the reframe and the phase boundaries, not the per-verb mechanics.
Date: 2026-07-15
Author: arinyaho (with Claude)
Lineage: extends `review-until-green` (shipped as concord 0.8.0-alpha.2) past its diff-local origins. Motivated by the observation that `review-until-green` can only review what `git diff <base>...<HEAD>` produces, so a local spec/design `.md`, a long session's accumulated context/decisions, or a silent gap (something the design requires but no diff touches) cannot be reviewed at all -- `git diff <base>...<HEAD>` yields an empty diff, so the round has nothing to review and converges clean without the file ever being seen. The GATE/panel layers (added in `2026-07-12-review-gate-design.md` and `2026-07-15-gate-holistic-panel-design.md`) already reach past the diff (they Read/Grep the whole repo, catch silent gaps, review design-conformance), which proves the review capability is not intrinsically diff-bound; only the *target-acquisition* and *convergence* mechanics are.

## The reframe

The current model bakes in four coupled assumptions, all traceable to "a review is a git diff":

1. **Target = a git diff.** `round-start` computes `git diff <base>...<HEAD>`; an empty diff produces a round with nothing to review, which converges clean. (This is distinct from a `no-op`, which `beginRound` returns only when the diff is byte-identical to the prior round's.)
2. **Convergence = diff stability.** `decideTermination` converges when `dodPassed && openFindingsCount === 0 && fixedCount === 0` -- the `fixedCount === 0` clause means "no fix changed the tree this round," i.e. the diff stopped moving.
3. **Fix = a git commit.** `commit-fix` git-commits each fix's declared files; the fix loop is a mandatory step baked into `review-until-green.md`.
4. **The reviewer is a fire-and-forget subagent.** It writes a findings JSON and exits; no interaction, no steering.

None of these is intrinsic to reviewing. The generalized model:

- **Review target = the current-state snapshot of a named scope.** A git diff is *one* kind of scope (and stays exactly as-is for code). Other scopes: a set of files/globs, a local spec/design `.md`, concord's own decision records (charter/memory). The target is "what these things say right now," not "what changed."
- **Convergence = the review stops finding new things.** Terminate after N consecutive rounds that surface zero findings not already seen (dedup via the existing `seenHash`/`seen` machinery). This replaces "the diff stopped moving" with "the reviewer ran dry" -- a definition that works whether or not there is a diff.
- **Fix belongs to the caller, not concord.** concord already never edits files -- the main agent's fix subagents do. concord's only fix-time roles are `plan-fixes` (which findings to fix) and `commit-fix` (git persistence). Generalizing means those become *optional*: the caller fixes however the target demands (git commit for code, plain file edit for a doc, a charter-command update for a recorded decision), and re-invokes review. git persistence stays available as a helper for the code path, not a mandatory loop step.
- **The reviewer becomes an interactive agent.** Instead of a JSON-emitting subagent, review is a conversation you can steer and interrogate -- while the deterministic bookkeeping (dedup, dry-round counting, convergence) stays in a ledger the agent *uses*, so "when to stop" is never a model vibe.

Critically, git is **not removed**. concord stops *assuming* every review is a git diff. For the code-review path, git remains the target-acquisition mechanism and the fix-persistence mechanism, unchanged -- zero regression is a hard requirement. git simply becomes one target-type and one persistence-option among several, rather than the only one.

## What stays (the deterministic core)

The value concord provides over "just ask Claude to review" is determinism the model cannot fake: stable round counting, dedup so the same finding across rounds collapses to one, and a convergence rule the model does not get to override. All of that stays -- in the ledger. Specifically preserved across all phases:

- the ledger (per-target state file: findings, `seen`, rounds, status),
- id-based dedup keyed on the gate-emitted stable finding id, backed by a secondary line-independent content hash (`seenHash`) -- already line-number- and diff-position-independent,
- the GATE and holistic-panel layers (already target-agnostic in spirit -- they Read/Grep beyond the diff),
- the "CLI owns termination, the agent supplies judgment" split -- even when the reviewer is agentified, the stop condition is computed from the ledger, not asserted by the model.

## Dedup strategy (the load-bearing risk)

Convergence rests entirely on dedup: if the same finding gets a different identity each round, the loop never runs dry. Today this works because the finding id is a gate-emitted stable slug (e.g. `correctness:assignment-in-condition`), reused across rounds for the same objection, backed by a secondary line-independent content hash (`seenHash` over class + file + span-text + summary) that only distinguishes a byte-identical revert from a reworded reappearance; code spans are stable so both hold. Prose is the hard case -- a reworded summary or a slightly different quoted span both changes that secondary hash and tempts the reviewer to mint a fresh slug, so the same objection reads as "new" forever.

Chosen strategy: **reinforced compromise, not a single mechanism.**

- **Key floor (deterministic):** exact-match on the stable finding id (slug) dedups for free, with no model involvement, and the secondary content hash tells a byte-identical revert apart from a reworded reappearance. This is the convergence guarantee's backbone.
- **Model-assisted id reuse (stability aid):** each round's reviewer is handed the prior round's open findings and instructed to reuse an existing id when it recognizes the same objection, rather than minting a new one. This is a strengthening of what `review-until-green.md` already asks ("reuse the same slug for the same bug"), extended to prose targets where the anchor is weaker.

Rejected: pure model-judged dedup (convergence would lean entirely on the model's "is this new?" call -- the one thing we are keeping deterministic) and pure key-based (too brittle for prose -- a reworded finding never dedups, so the loop never converges).

## Phase decomposition

Each phase produces working, testable software and does not break the phase before it. Phase 1's standalone user-visible value is thin (it is a de-risking internal generalization whose only observable is "code review still works"); Phases 2 and 3 deliver the new capability. This ordering is deliberate: prove the refactor is regression-free before adding new target types on top of it.

### Phase 1 — Generalize the target spec; convergence becomes dry-round

- `round-start` stops hardcoding "the target is a git diff." It acquires a review scope through a target-type abstraction; the first (and, in Phase 1, only) target-type is the existing git-diff producer, so the CLI surface and behavior for code review are identical.
- `decideTermination` replaces the `fixedCount === 0` (diff-stable) convergence clause with a dry-round rule: terminate after N consecutive rounds with zero *new* (previously-unseen) findings. DoD gating stays for target-types that declare a DoD (code); target-types with no DoD skip it. The code path is regression-tested against the new rule.
- `commit-fix` becomes an optional helper rather than a mandatory loop step. Today `record` marks a finding fixed only when this run's journal has its commit (written by `commit-fix` after its git commit); a fix that was not committed is parked, and the fix *report* (`fix-<id>.json`) is consulted only to word the park reason. Making `commit-fix` optional therefore requires `record` to accept a fix report as an alternative "fixed" signal for non-git targets -- a change this design introduces, not existing behavior. The code path keeps calling `commit-fix` to preserve per-fix commit attribution.
- Outcome: code review looks and behaves identically; the internals no longer assume git or diff-stability. Nothing new is reviewable yet.

### Phase 2 — Add diff-less target types

- New target-types in the Phase 1 abstraction: a file/glob set, a local spec/design `.md`, and concord's own decision records (charter/memory). Their snapshot is "current content," with no diff.
- The GATE/panel lenses (design-conformance, silent-gap, cross-doc/SSOT, threat-model) are reused directly -- they were built for exactly this class of review.
- Fix is the caller's, per target: code → git commit, doc → file edit, recorded decision → charter/memory update. A finding can legitimately be resolved by editing the *decision record* rather than the code, when the review surfaces that the recorded decision -- not the artifact under review -- is what is wrong.
- Outcome: local specs/designs, and concord's own accumulated context, become reviewable-and-fixable in a loop.

### Phase 3 — Agentify the reviewer

- The review step changes from a fire-and-forget subagent (emits JSON, exits) to an interactive review agent that can be questioned, steered, and can discuss/refine findings before they are committed to the ledger.
- The deterministic core is unchanged: the agent writes findings to, and reads convergence state from, the ledger. Dedup and the dry-round stop condition remain ledger-computed, never model-asserted.
- Outcome: review becomes conversational without surrendering the determinism that distinguishes concord from an ad-hoc "please review this" prompt.

## Non-goals

- **Syncing external systems (Notion/Confluence) into the review.** Out of scope for all three phases. A review target must be locally materialized (a file the caller can read and edit). Pulling a Notion page into a local file is a separate tool's job; once local, it is a Phase-2 file target like any other. External docs may still enter as *context/grounding* (via the existing `intent.command` mechanism, which fetches a design source) without being review *targets*.
- **Removing git.** git is preserved wholesale for the code path; it is de-privileged, not deleted.
- **Editing the live session transcript.** "Reviewing the conversation context" means reviewing concord's *materialized* decision records (charter/memory), not rewriting the transcript.

## Open items for the per-phase specs

- Phase 1: the exact target-type interface shape; the dry-round threshold N (and whether it is per-target-type configurable); how `record`/`plan-fixes` behave when `commit-fix` was skipped; the precise regression-test matrix proving code-review parity.
- Phase 2: the snapshot/identity model for a no-diff file target (what plays the role `head_sha` plays for git); how a charter/memory-targeting fix is expressed and verified; whether doc target-types get their own lens set or reuse the panel's five.
- Phase 3: the interaction protocol between the interactive reviewer and the ledger; how steering/refinement is prevented from silently weakening the dedup/convergence guarantees.
