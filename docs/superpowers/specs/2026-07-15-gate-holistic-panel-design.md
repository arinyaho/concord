# GATE Holistic Adversarial Panel — Design

Status: DESIGN — ready to plan.
Date: 2026-07-15
Author: arinyaho (with Claude)
Lineage: extends the GATE sub-system fixed in `2026-07-12-review-gate-design.md` (decision 4: gate-review/gate-verify run every round, block only at the convergence boundary). Motivated by a token-usage investigation into `review-until-green` (fixed separately in PR #32 — DoD passthrough + no-new-tooling cap on the correctness subagent) that, while gathering comparison data, found a second, larger, and entirely undocumented cost source: a "holistic adversarial panel" practice that exists only as a per-repo memory note (`reference_concord-blindspot-adversarial-panel.md`, envector-msa project on a remote dev host), not as part of concord itself.

## Problem

The GATE (per the 2026-07-12 spec) is diff-local-plus-codebase-read: one `gate-review` subagent, four finding classes (`cross-context`, `silent-gap`, `ac-coverage`, `design-conformance`), one `gate-verify` pass, running every round. It catches real gaps a diff-only reviewer cannot.

Independently, at least one user has been running a *separate, heavier* practice by hand for SSOT/security-sensitive changes: a Workflow-based fan-out of ~4-6 independent reviewer lenses (AC conformance vs. the ticket, code-vs-spec fidelity across the whole subsystem, cross-doc SSOT consistency, adversarial threat-model correctness), looped until no new finding survives adversarial verification. This practice is real and has caught things the GATE's four classes miss — confirmed on PR #2185 (KMS SSOT §8 realignment), where concord converged clean and the GATE found nothing, but the panel caught a threat-model error (a false "cloud provider cannot read the SK" claim) that was a genuine security-doc defect.

But the practice lives only in a memory note, is re-derived by the assistant from prose each session, and has no cost controls. Measured on one real run (ES2-2203, envector-msa, 2026-07-14): 6 Workflow dispatches totaling **16,768,808 tokens** in a single session, with individual panel rounds costing up to 3.76M tokens and 599 tool calls. The per-round raised-finding count did not monotonically shrink (40 → 33 → 35 → **43** → 19-then-0), meaning later rounds were substantially re-discovering and re-litigating findings already rejected by earlier rounds — the same "no bound on self-directed re-investigation" failure mode as the correctness-subagent issue fixed in PR #32, just at panel scale. Broader sampling (daramg host, all projects, 11 Workflow-adversarial runs) put the aggregate at **21,179,406 tokens**, ~79% of it this one session.

## Goal

Bring this practice into concord as a GATE extension, so it: (a) is deterministic and versioned instead of re-derived from memory prose each session, (b) is repo-agnostic (no hardcoded file-path heuristics — the existing GATE opt-in config mechanism is reused), and (c) has real cost controls — specifically, a convergence mechanism that makes round *N+1* cheaper/smaller than round *N* by construction, not by luck.

Non-goal: replacing the existing lightweight GATE (decision 4 of the 2026-07-12 spec, unchanged). Non-goal: auto-fixing panel findings — like the GATE, the panel is report-only, human-gated.

## Key decisions

1. **One command, not a new one.** The panel is a new stage inside `/review-until-green`, not a separate slash command. (Considered and rejected: a fully independent command — it would duplicate `review-cli.js`'s round/ledger/dedupe machinery for no benefit, since the panel's natural trigger point — "correctness has converged" — is already a first-class state the existing CLI tracks.)

2. **Extend the existing GATE, don't build a parallel system.** The panel's four inherited lenses map directly onto the GATE's existing finding classes:

   | existing GATE class | panel lens |
   |---|---|
   | `ac-coverage` | AC conformance vs. the ticket |
   | `design-conformance` | code-vs-spec fidelity |
   | `cross-context` | cross-doc SSOT consistency (partial overlap; cross-context is broader, covering sibling/cross-repo code) |
   | `silent-gap` | (no panel equivalent; GATE-only) |
   | — | **`threat-model`** (new class; the one lens the panel adds that the GATE has no equivalent for) |

   The panel is a 5-way parallel fan-out (one subagent per class, `threat-model` newly added), not one subagent covering all classes serially.

3. **The existing every-round GATE is untouched.** Decision 4 of the 2026-07-12 spec (lightweight `gate-review`/`gate-verify`, every round, blocks only at the convergence boundary) stays exactly as-is — its early-visibility and cross-round dedup properties are real and cheap at its current single-subagent scope. Making the *5-lens* panel run every round was considered and rejected: at panel scale (measured ~1.9M tokens/run average, up to 3.76M) that multiplies round count directly into cost, which is the problem this spec exists to avoid.

4. **The panel triggers exactly once**, at the round where correctness/verify would otherwise converge clean (i.e., the moment the loop would declare `clean` per the existing terminus logic) — not every round. This is a deliberate divergence from decision 4's "every round" for the *lightweight* GATE; the panel is expensive enough that running it speculatively on rounds that still have open correctness findings (which will keep changing the diff) wastes the panel's own convergence work.

5. **Convergence: dedup carry-forward, not a hard round cap.** The panel's internal loop (potentially several rounds of its own, independent of `review-until-green`'s round counter) tracks a cumulative rejected-findings set (`gate-panel-rejected.json`) and feeds it into each round's finder prompts ("these were already raised and rejected without new evidence — do not re-raise them"). This directly targets the observed failure mode (raised counts plateauing/bouncing instead of shrinking) rather than papering over it with a blunt cap that risks cutting off a late-round genuine finding (round 1 of the measured ES2-2203 run found 14 of its total confirmed findings). Termination: **two consecutive dry rounds** (a round contributes zero new confirmed findings after adversarial verification) — one dry round alone risks a lucky-early stop.

6. **The panel is self-verifying; it does not route through the existing `gate-verify`.** Each panel finding survives an adversarial-verify pass (multiple independent skeptics, majority-to-survive) inside its own round, before ever being counted as "confirmed" for dedup/termination purposes. Running the lightweight GATE's separate `gate-verify` again over the panel's already-verified output would be redundant work at panel-scale cost for no new signal.

7. **Opt-in via existing repo config, no hardcoded paths.** `review.config.json`'s existing `gate` section gains a `panel: true` flag (or equivalent). No file-path or keyword heuristic lives in the shared plugin — a repo that wants the panel (SSOT/security-heavy repos, per the originating memory note) declares it explicitly, the same way DoD commands are already repo-declared. Absent the flag, behavior is unchanged from the 2026-07-12 spec.

8. **Findings feed the existing GATE contract.** The panel's confirmed findings, once its internal loop dries up, are merged into the same `{ "id": "gate:<class>:<slug>", ... }` shape and folded into the ledger's GATE-open set exactly like lightweight-GATE findings — `threat-model` simply becomes a fifth valid `class`. `review-cli.js`'s `record`/`plan-fixes`/`foldGateFindings` logic does not change; it already treats GATE findings as opaque-by-class.

9. **Cost is reported, not just spent.** The handoff message gains a line when the panel ran: round count, total tokens, confirmed-finding count (e.g. `GATE panel: 3 rounds, 1.2M tokens, 6 confirmed`). This investigation took an afternoon of grepping remote session logs to reconstruct panel cost after the fact; the CLI should not require that again.

## Execution model

At the round where `record` would otherwise compute `clean` (all correctness findings resolved, DoD passed, no open lightweight-GATE findings) **and** `review.config.json` has `gate.panel: true`:

1. Spawn 5 lens subagents in parallel (`ac-coverage`, `design-conformance`, `cross-context`, `silent-gap`, `threat-model`), each with codebase read access and the design/AC pack (reusing the existing GATE's pack — design source via `intent.command`, ad-hoc codebase read). Each writes candidates to `gate-panel-<m>-<lens>.json` (`m` = panel-internal round, starts at 1).
2. For each candidate, an adversarial-verify sub-pass (independent skeptics, majority vote) determines survival. Surviving findings this round are appended to the cumulative confirmed set; rejected ones are appended to `gate-panel-rejected.json`.
3. If this round contributed zero new confirmed findings, increment a dry-round counter; else reset it to zero.
4. If the dry-round counter reaches 2, stop. Otherwise increment `m`, re-spawn the 5 lenses with the current `gate-panel-rejected.json` contents injected into their prompts, and repeat from step 1.
5. Merge the cumulative confirmed set into `round-<n>-gate.json` (the existing GATE finding file for this round), tagged with their class (including any new `threat-model` findings), and let the existing `record`/GATE-pending logic take it from there unchanged.

## Finding contract

Unchanged shape; `class` enum extended:

```
{ "id": "gate:<class>:<stable-slug>",
  "class": "cross-context" | "silent-gap" | "ac-coverage" | "design-conformance" | "threat-model",
  "file": "<path the finding concerns>",
  "evidence": "<the concrete anchor>",
  "requirement": "<the design/AC text it fails, when applicable>",
  "summary": "<one sentence>" }
```

## Open items for the implementation plan

- Exact adversarial-verify vote count/quorum per panel finding (measured practice used ~3 skeptics; not yet fixed as a concord default).
- Whether `gate.panel` should be a plain boolean or accept a lens subset (e.g. a repo that only cares about `threat-model` + `ac-coverage`) — deferred; ship boolean-only first, extend if a real repo needs it.
- Interaction with `intentApplied` / the existing intent detector, which also runs alongside correctness today — the panel does not replace or subsume it.
