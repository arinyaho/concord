# Review GATE — Design

Status: DESIGN — ready to plan. The GATE sub-system of the Indexed Cross-Context Review project (`2026-07-10-indexed-cross-context-review-design.md`), whose GATE section was left "explicitly not decided yet".
Date: 2026-07-12
Author: Jungjoo Seo (with Claude)
Lineage: the parent design named four sub-systems — INDEX / RETRIEVER / GATE / FRESHNESS — and deferred the GATE's finding taxonomy, pack schema, and concord-integration shape. This spec fixes those, driven by four `review-until-green` dogfood reviews that each ran concord to green and then had a broader review find what concord structurally could not.

## Problem

`review-until-green` is **diff-local**: its correctness gate sees only the changed lines plus the surrounding code, and its one design-aware gate (the intent detector) raises only an **active contradiction of an explicit stated requirement on a changed line** — never silence, never an unchanged file, never "does this meet the design". This scope is deliberate: it is the class the loop can safely **auto-fix** and **deterministically converge** on. Everything outside it was pushed out to keep the loop terminating.

But concord runs on Claude, and a one-line review request to a plain Claude agent — given the design, plan, and acceptance criteria plus read access to the codebase — routinely catches a large class of real defects that the diff-local loop structurally cannot. Four dogfood reviews make this concrete. In each, concord converged green on the diff; a broader review (a dispatched Claude agent with design/plan/AC context and codebase read access — no special tooling) then caught, respectively:

- a **security regression via an unchanged sibling file**: a change closed a threat in the file it touched, but an untouched sibling on the same code path re-opened it; diff-local review never looked at the unchanged file. (Same class as the parent doc's **I-1**.)
- a **silent gap**: the design required a validation the code simply omitted — no contradiction on any changed line, an absence. The intent detector is defined to ignore silence.
- an **AC-coverage gap**: several acceptance criteria were only PARTIAL; the diff was internally consistent but did not fulfill the stated done-definition.
- a **"clean but mission-unfulfilled"** gap: the diff passed correctness and tests, yet the change's stated purpose was not actually achieved (the differentiating capability was never built; a test was gamed with a hand-authored fixture the pipeline never produces).

None of the four target repositories were the C++ stack the INDEX sub-system currently indexes; all four wins came from **language-agnostic, ad-hoc agentic retrieval** (the reviewer reading the repo), not from a structural index. A separate lesson recurred: even a good broad pass returned LGTM, and a **second independent pass with different lenses** then found more — single-lens review is insufficient.

## Goal

Bring `review-until-green` up to **built-in-review parity**: a one-line invocation should, at least, cover what a one-line Claude review covers — design conformance, silent gaps, AC coverage, and cross-context violations — without giving up the diff-local loop's determinism and auto-fix. The GATE is the seam where that broader review attaches to the loop.

Non-goal: catching everything. The GATE is report-only and human-gated; it raises what a broad review raises, and a human adjudicates. It does not attempt exhaustiveness, and it never auto-fixes.

## Relationship to the INDEX project

This is the parent project's **GATE**, and only the GATE. The parent decoupled GATE from RETRIEVAL behind a **context-pack interface** precisely so the GATE can ship now against a simple pack while retrieval matures. This spec takes that seam literally:

- **v1 pack = the design source plus live codebase read access** (ad-hoc agentic retrieval). Language-agnostic, works today, and is exactly what produced the four dogfood wins.
- **Later pack = a deterministic structural pack** produced by the RETRIEVER over the INDEX code-graph. The GATE consumes the pack through the same interface; the retrieval backend swaps in without changing the GATE.

The GATE and the INDEX code-graph are **separate deliverables on separate tracks** that meet only at the pack interface. The GATE must not block on INDEX/RETRIEVER maturity, and — because the INDEX Stage-1 core is a single-language structural indexer while the demonstrated GATE value is language-agnostic and largely non-structural (silence, AC, design conformance) — most of the GATE's value is reachable with the ad-hoc pack alone.

## Key decisions

1. **The GATE is a sibling gate to correctness, not an extension of the intent detector.** It reuses the intent detector's proven *reporting* contract — report-only, human-gated, never auto-fixed, config-fetched design source, fail-closed, isolated id namespace — but not its *termination* behavior (see decision 4). The intent detector stays as-is (narrow, active-contradiction, terminal); the GATE is the broad, advisory, convergence-boundary layer.

2. **Three inputs, one pack.** The GATE reviews the round diff against a pack of three parts:
   - **design source** — the design / plan / AC text, fetched by the project-authored command already defined for the intent detector (`review.config.json` `intent.command`). Reused, not re-invented. Absent design source is allowed: cross-context and codebase-fit findings (e.g. the sibling-file security class) are code-vs-code and need no design doc.
   - **structural neighbors** — the bounded set of cross-code relevant to the diff (same repo or a linked repo). v1: empty or ad-hoc; later: filled by the RETRIEVER. The GATE tolerates an empty structural pack and falls back to ad-hoc read.
   - **codebase read access** — unlike the diff-local gates, the GATE subagent may Read and Grep the repository. This IS the v1 "manual/simple pack": ad-hoc agentic retrieval.

3. **A panel, verified — not a single pass.** The GATE mirrors the correctness gate's review-then-verify shape and honors the "single lens is insufficient" lesson:
   - a **gate-review** pass produces candidate findings across the covered classes (design conformance, silent gap, AC coverage, cross-context);
   - an independent **gate-verify** pass, prompted with a *different* lens, rejects false positives and may surface what the first pass missed (distrust-green).
   The number of review lenses is a scale knob; v1 is one review lens plus one independent verify. More lenses (e.g. security / feasibility / consistency) are an additive fan-out, not a redesign.

4. **Report-only, and blocking only at the convergence boundary.** This is the one deliberate divergence from the parent doc's "reuse the intent-review terminus". The intent detector is terminal *per finding*: any intent finding in a round ends that round immediately. That is fine for the intent detector because active contradictions are rare; it is wrong for the GATE, whose findings (silent gaps, AC, design) are common — halting the loop on the first design gap, before the correctness loop has auto-fixed the actual code bugs, would break the loop. Instead:
   - the GATE runs **every round**, alongside correctness, against the same round diff;
   - its findings **never auto-fix and never end a round mid-loop**; they accumulate and are re-evaluated each round (a later fix that resolves an earlier gate finding drops it, exactly as correctness findings dedupe);
   - the correctness + DoD loop proceeds to its natural convergence;
   - **at the moment the loop would declare `clean`**, any still-open GATE findings flip the terminus to a new **`gate-review`** status — human-gated, terminal, re-runnable — instead of `clean`. Zero open GATE findings → `clean` as before.

   Running every round buys early visibility (each round's handoff shows the current advisory findings) and cross-round refinement (fixes clear findings automatically); blocking only at the boundary preserves the auto-fix flow and enforces distrust-green (a green diff is not yet LGTM).

## Execution model

Per round, after the diff is written, the driver spawns — in parallel with the correctness and (if configured) intent subagents — the GATE subagents against the round diff and the pack:

1. **gate-review** (clean context, codebase read access): reviews diff + design source + structural pack (or ad-hoc read) and writes candidate findings to `round-<n>-gate.json`.
2. **gate-verify** (clean context, independent lens): re-reviews the candidates, rejecting false positives, to `round-<n>-gate-verify.json`.

Surviving findings are folded into the ledger's GATE-open set (deduped by stable id against prior rounds, and against a dismissed set — see below). They are reported in the handoff every round and gate the terminus at convergence.

## Finding contract

A GATE finding:

```
{ "id": "gate:<class>:<stable-slug>",
  "class": "cross-context" | "silent-gap" | "ac-coverage" | "design-conformance",
  "file": "<path the finding concerns>",
  "evidence": "<the concrete anchor: a changed line, an unchanged sibling location, an AC id, a design clause>",
  "requirement": "<the design/AC text it fails, when class is design-conformance / ac-coverage / silent-gap; omitted for cross-context>",
  "summary": "<one sentence>" }
```

- The `id` is a stable slug reused for the same gap across rounds, so a fix that persists across rounds dedupes and a re-surfacing gap is recognized — same discipline as correctness ids.
- **Isolated namespace.** `gate:` ids come ONLY from the GATE subagents; a symmetric guard (mirroring the intent detector's) rejects a `gate:`-prefixed id appearing in the correctness or intent artifacts, and rejects a `correctness:`/`intent:` id in the gate artifact. This keeps the auto-fixing gate and the report-only gate from ever crossing wires.
- GATE findings are **never** placed on the fix plan and never auto-committed.

## Termination integration

The termination state machine gains one branch, checked at the convergence point:

- existing order is unchanged up to the clean check;
- **new:** if the loop would otherwise converge `clean` (DoD passed, zero open correctness findings, no fixes this round) AND the GATE-open set is non-empty → terminus `gate-review` (continue:false, converged:false, gateReview:true), human-gated;
- if the GATE-open set is empty → `clean` as today.

`gate-review`, like `intent-review`, is a **re-runnable stop state**: a fresh `round-start` clears it, re-fetches the design source, and re-evaluates, so a human who fixed the code or corrected the design source clears the finding by re-running. It composes with the existing terminal-status handling: `reset <ref>` also discards a `gate-review` ledger, and the round-budget / park breakers still bound the run.

## Dismissal (accepted / deferred findings)

Because the GATE runs every round and never auto-fixes, a finding the human legitimately accepts as out-of-scope or deferred (a documented divergence, a gap owned by a later plan) would otherwise re-block every re-run. The human needs a way to retire it:

- **resolve** — fix the code or the design source and re-run; the finding is re-evaluated and drops. No command.
- **dismiss** — for an accepted / deferred / false-positive finding, a CLI verb records the `gate:` id in a **dismissed set** (a `killed`-style seen entry, reusing the existing dedupe-suppression machinery) so it does not re-surface or re-block. This mirrors, and reuses, the `unpark` / `reset` family rather than inventing a parallel mechanism.

## Configuration

- Opt-in for v1, via a `gate` block in `review.config.json` (default: absent → the loop stays exactly diff-local, preserving the zero-config default and the current cost profile). When present, the GATE runs the panel each round using the design source (the `intent.command` output, if configured) plus ad-hoc read.
- The block also carries the pack source: v1 = ad-hoc; later a retriever endpoint. Trust model matches `dod` and `intent` — a project-authored value the CLI consumes; fail-closed on a present-but-broken block, benign on an absent one.
- **Open policy question (below):** whether the GATE flips to default-on in a later version once trusted — the user's motivating complaint ("a one-line review should include built-in coverage") argues for default-on, but the blocking `gate-review` terminus and the extra per-round passes are a behavior/cost change that v1 keeps behind an explicit opt-in.

## What ships in v1 vs later

- **v1 (this spec, in concord):** the GATE gate — every-round panel (one review lens + one independent verify), report-only, `gate:` findings, `gate-review` convergence-boundary terminus, dismissal path, `review.config.json` `gate` opt-in. Pack = design source + ad-hoc codebase read. Language-agnostic.
- **Later (behind the pack interface, separate tracks):** the RETRIEVER fills a deterministic structural pack from the INDEX code-graph; the GATE consumes it unchanged. Additional review lenses. FRESHNESS. The default-on decision.

## Divergences from the parent design, recorded

- Parent: "reuse the intent-aware report-only + `intent-review` terminus pattern." This spec keeps the report-only half but **replaces the per-finding terminal behavior with a convergence-boundary block**, because the GATE's finding volume makes per-finding halting incompatible with the auto-fix loop (decision 4).
- Parent framed the GATE around **cross-context violations** (structural, from the graph). The dogfood evidence broadens it to **cross-context + silent-gap + AC-coverage + design-conformance**, and shows most demonstrated value is non-structural and language-agnostic — reachable via the ad-hoc pack before the index exists.

## Open questions

- **Default-on timing.** When (if ever) does the GATE stop being opt-in? Tie to a trust threshold (measured false-positive rate on the dismissal ledger).
- **Cost envelope of every-round execution.** A broad pass per round is not free. Is per-round the right cadence, or should the panel run only from round 2, or scale lens count with round number? v1 ships per-round with one lens + verify; measure before widening.
- **Pack schema concretely.** The structured-neighbor shape the RETRIEVER will emit and the GATE will read — deferred to the RETRIEVER spec, but the GATE's v1 finding contract must not assume it (v1 tolerates an empty structural pack).
- **Lens taxonomy.** The exact set and prompts of review lenses (design-conformance / AC / silent-gap / cross-context, and whether security / feasibility / consistency are separate lenses or facets) — v1 starts minimal and earns additions from missed-finding evidence.

## Rigor flags

- **Report-only is load-bearing.** The GATE must never feed the auto-fix loop; a debatable design finding that re-opened the correctness loop, or was auto-fixed, would reintroduce the exact non-convergence that forced concord off headless agentic gates. The convergence-boundary block and the strict `gate:` namespace isolation exist to enforce this.
- **Distrust-green is a first-class requirement, not a nicety.** The independent verify pass is the minimum; a single GATE pass that returns "no findings" is not trusted to mean clean any more than a single reviewer's LGTM is.
- **Ship the ad-hoc pack; do not wait for the index.** The demonstrated value is language-agnostic and largely non-structural; coupling the GATE to the single-language structural index would forfeit it.
