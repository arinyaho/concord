# Task Charter — cross-session context continuity (harness D5)

- Status: DESIGN v2 (review-revised 2026-07-06)
- Track: harness-engineering D5 (cross-session knowledge continuity, personal)
- Home: concord plugin (`session-state`), extension — not a new plugin
- Spec home: local (harness dir). concord README policy = "design notes kept local, not in this repo"; the concord PR is review-only, not a merge of this file.

## Problem

Sessions lose the founding task context — the initial framing of "what this task is, why, and which forks are already decided." Two observed layers. v2 keeps them SEPARATE because their fixes differ in confidence:

1. Cross-session loss (mechanical, high-confidence fix): a fresh session or a post-compaction resume starts without the founding framing. Re-injecting it at SessionStart / PreCompact guarantees it is present in context. This is the v1 commitment.
2. In-session drift (weak fix, experiment only): a long session opens with a task-context dump; the assistant later proceeds in a direction that breaks it. Re-injection buys recency near the context head but NOT guaranteed attention — and unlike D2 (whose Layer-2 enforcement degraded onto a Layer-1 floor), in-session drift has no floor: if recency does not translate to attention, the residual fix is zero. This half is a measured experiment with a kill criterion, NOT a design commitment.

Root for both is retrieval/attention, not storage — in-session the data is fully captured (it is in the transcript) yet still unused. But "salience, not storage" is only half the story: it fixes the cross-session half cleanly, and is unproven for the in-session half. It also hides a real storage-side gap — capture accuracy (below).

## Evidence (two-machine diagnosis)

The "monster session" is not dysfunction — it is a coping mechanism for broken continuity. The user keeps one session alive for weeks rather than closing at task boundaries, because closing risks losing the founding framing and the fork decisions. Measured on two independent machines / workloads:

```
machine          session   tools  span    active   idle%  resumes  out
mac (RAG)        9465de14    833  12.7d   27.9h    91%      19      Y
mac (RAG)        0aa3c199    403  23.9d   20.2h    96%       8      Y
daramg (crypto)  ddf39ad5   1438  25.2d   59.2h    90%      23      Y
daramg (crypto)  21f4ada1    803  24.8d   61.7h    90%      15      Y
```

Reading: a "25-day" session is roughly 1-2.5 days of actual work smeared across weeks via 8-23 resumes; 82-96% idle; output present (productive). Replicates across two unrelated workloads — working style, not project-specific.

The measurable continuity cost is the resume count (8-23 per monster) times a per-resume re-establish tax. The verbal workaround ("re-read my first message") is NOT text-quantifiable (phrasing varies; greps return only boilerplate false positives). Frequency rests on user testimony; the resume/idle structure is the hard evidence.

D3 (monster sessions) and D5 (cross-session continuity) are the same problem from two ends: D3 is the symptom (never close because handoff is broken), D5 is the fix. Fixing continuity dissolves the monster.

## Goals

- v1: preserve the founding framing as a durable artifact and re-inject it across session boundaries (SessionStart) and at compaction (PreCompact). High-confidence, mechanical.
- v1: accrete fork decisions (chose B over A because X, plus the rejected alternative) append-only, concurrent-safe.
- v1: bounded read cost as a project ages (no per-turn full-shard scan; retention/consolidation).
- Experiment (not v1 commitment): mitigate in-session drift; ship behind a kill criterion.

## Non-goals (v1)

- Per-turn charter re-injection (see In-session experiment — deferred behind measurement; prompt-cache and habituation costs).
- Cross-machine sync (two machines, disjoint projects; a charter is project-scoped).
- LLM-distilled charter (lossy-summary risk + cost/latency/nondeterminism).
- Semantic drift-detection (per-turn LLM judgment expensive; heuristics weak).
- Lexical/vector ranking of decisions (recency + dedup until a miss is measured).
- A guarantee that the model weights the charter. Re-injection near the context head is the best available lever; it cannot compel attention. Accepted bound.

## Design

### 1. Charter artifact

```
$CLAUDE_CONFIG_DIR/projects/<proj>/state/
  charter.md                    # north-star only. see CS1 for write rules.
  charter.d/<session-id>.jsonl  # per-session append-only decision / open-loop shards.
  charter.d/_consolidated.jsonl # folded older shards (see CS2 retention).
  <session-id>.md / .json       # existing concord session-state (unchanged).
```

- North star: the current best statement of what this task is and why. Updatable (framing evolves; it is not always the first message), not immutable.
- Decisions / open loops: append-only, machine-written from `DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:` tags (reusing concord's tag-harvest).

### 2. Capture — and its honest limit

There is NO zero-effort-accurate capture path. The two options trade accuracy for effort, and v1 states this plainly rather than implying a free lunch:

- Auto-draft (zero-effort, low-accuracy): the first substantive user message is written as a DRAFT north-star ONLY if `charter.md` is absent/empty (see CS1). It is frequently wrong — the real framing often emerges several turns in — and extraction is harness-fragile: skill injections, `<system-reminder>` blocks, hook context, caveman-mode banners, and local-command stdout must all be filtered, and that filter breaks across harness versions (X3). So the auto-draft is a placeholder, not a trusted value.
- Manual set (high-accuracy, non-zero effort): `/charter set <text>` or `/charter pin` writes the real framing. This is deliberate hand-input — the same hand-maintenance D2 fought — accepted here ONLY for the north-star (one small value, set rarely), never for the frequent decision path (which stays automatic).

Mitigation for the auto-draft being wrong: `/charter` shows what is currently pinned, so divergence from intent is visible and correctable in one command.

### 3. Commands (concord-provided custom slash commands, NOT built-in)

| Command | Effect |
|---|---|
| `/charter` | Show current charter: north-star + open loops + recent N decisions. |
| `/charter set <text>` | Overwrite the north-star with explicit text. |
| `/charter pin` | Overwrite the north-star with the previous user message. |

Shipped as `commands/*.md` in the concord `session-state` plugin. `clear` / `off` deferred.

### 4. Injection triggers (v1)

- PreCompact (primary): compaction is the exact moment the opening framing is summarized/dropped. Re-inject the fuller charter (north-star + open loops + capped decisions). Native hook, highest signal.
- SessionStart (cross-session): inject the charter on resume / fresh session, after the durability catch-up (section 6). Supersedes concord's LWW `_latest.md` for the fresh-session role (section 7).

Per-turn UserPromptSubmit injection is NOT in v1 (moved to the experiment, section 8). Rationale: a header that changes every turn, injected at the context head, invalidates the prompt-cache prefix every turn (large cost); injected at the tail it is cache-safe but low-salience — an unaddressed position/cache tradeoff. Repeating it every turn also reproduces the very "noise buries signal" failure inside the context window, and habituates the model so the header becomes wallpaper (SessionStart injection is salient precisely because it is novel/once). Committing an unmeasured per-turn trigger while deferring drift-detection as "unmeasured" is inconsistent; both go to the experiment.

### 5. Storage and concurrent-safety

LWW (last-writer-wins) = a later writer overwrites an earlier writer's file, losing the earlier content (the observed "modified on disk" incident).

- Decisions / open loops (frequent, automatic): each session appends only to its own `charter.d/<session-id>.jsonl`. No writer touches another session's file → clobber structurally impossible. Readers union + dedup. Append-only-log pattern, concurrent-safe by construction.
- North-star (`charter.md`) write rules (CS1 fix): auto-draft writes ONLY when `charter.md` is absent/empty (first-writer-wins), so two fresh parallel sessions cannot clobber each other's draft. Only an explicit `/charter set` / `/charter pin` overwrites — that IS rare and deliberate, so LWW there is safe. (The v1 flaw was calling the automatic per-session auto-draft "rare/deliberate"; it is neither.)

Read cost bound (CS2 fix): merge-on-read must not union all shards unboundedly. As a project ages, un-capped shard reads make every injection cost grow with project lifetime.

- Retention/consolidation: periodically fold older per-session shards into `charter.d/_consolidated.jsonl` (dedup + recency-cap at fold time), so the live shard set stays small.
- Recency-gated read: injection reads `_consolidated` (already capped) + only recent live shards, not every shard ever written.
- Output ranking/cap (recency + dedup): north-star and unresolved open loops always; decisions capped to most-recent N; raw activity noise dropped (the live lesson: injected `Recent activity` was ~30 churn lines burying 3 decisions). Lexical ranking added only on a measured miss.

### 6. Durability across abrupt exit (Ctrl+C / Ctrl+D / crash)

Not "structurally impossible" — one honest residual. The transcript `.jsonl` is the durable log (Claude Code appends per event, independent of hooks), and harvest is watermark-based (per-session byte offset) and idempotent.

- Normal exit: the Stop hook harvests the final delta.
- Abrupt exit, session later resumed: that session's SessionStart catches up its own un-watermarked tail.
- Abrupt exit, session ABANDONED and a NEW session opened (the target workflow): the abandoned session is never resumed, so a per-session catch-up would miss its final turn forever. Fix: SessionStart scans ALL shards/transcripts in the project for an un-watermarked tail (watermark byte-offset < transcript size) and folds any it finds — not just "the prior session." The watermark prevents double-counting.
- Residual: a decision is lost only if the transcript file itself is deleted before any subsequent SessionStart. This is the honest bound; the v1 "loss impossible" claim was overstated.

### 7. Relationship to concord session-state (ownership, X1)

Two SessionStart injectors (existing session-state + charter) must not both emit rationale. Ownership division:

- Charter owns: north-star, open loops, decisions (the rationale layer).
- session-state injector keeps: activity/recovery facts only (what files/commands, recovery pointers), and cedes the `DECISION:` / `OPEN-LOOP:` / `NEXT:` rationale rendering to the charter.

The charter shard-merge supersedes the LWW `_latest.md` for the fresh-session inject role, repairing the concurrent-unsafe defect. Session-keyed `<session-id>.md` state files are unchanged.

## Honest limits

- In-session salience is partly a model/harness bound; re-injection buys recency, not attention. v1 does NOT commit to fixing it (section 8).
- Capture accuracy has no zero-effort-accurate path (section 2). v1 states this rather than implying auto-draft is trustworthy.

## 8. In-session drift — experiment (NOT a v1 commitment)

Ship behind a kill criterion, measured before any commitment:

- Hypothesis: keeping the charter salient mid-session reduces drift.
- Cheapest testable lever: inject-on-change — re-inject the compact header only when it differs from the last injection (steady-state cost ~0), or every-K-turns, rather than every turn.
- Kill criterion: after N sessions, measure residual drift (frequency of "re-read what I said" asks / observed framing breaks). If it does not drop materially, retire the lever — do not keep a hope-surface with no floor.

## Rollout / dogfood + measurement

- Build in the concord `session-state` plugin (Node built-ins only, paths derived from `transcript_path`).
- Dogfood on both machines. Success signal: the user can close a session at a task boundary and a fresh session continues without a "re-read my first message" round.
- Measure (measure-don't-assert): re-run the resume/idle probe after N sessions; watch per-session resume count and cold-start state-reads drop — sessions getting closable, not smaller-but-still-monster.

## Testing approach

- Unit: auto-draft writes only when `charter.md` absent/empty (CS1); `/charter set` / `pin` overwrite; shard append; merge-on-read union + dedup + recency cap; boilerplate/`<...>`/hook/local-command filtering (X3).
- Concurrency: two fresh parallel sessions each auto-draft → no `charter.md` clobber (CS1 regression guard); two sessions append distinct shards → reader unions both with no loss.
- Scaling: a project with many shards → injection read cost stays bounded via `_consolidated` + recency-gated read (CS2 guard).
- Durability: a transcript with tagged decisions but no Stop event, session abandoned → a subsequent DIFFERENT session's SessionStart all-shard scan harvests the tail (section 6), watermark prevents double-count.
- Ownership: SessionStart with both injectors active → rationale emitted once (charter), not duplicated (X1 guard).
- Injection: PreCompact emits fuller charter; SessionStart emits after catch-up. No per-turn injection in v1.

## Deferred (revisit on measured need)

- In-section-8 in-session drift lever (per-turn / inject-on-change / every-K).
- LLM-distilled north-star.
- Semantic drift-detection trigger.
- Lexical / vector ranking of decisions.
- `/charter clear` / disable.
- Cross-machine sync.
