# Task Charter — cross-session context continuity

- Status: DESIGN v2 (review-revised 2026-07-06)
- Track: harness-engineering — cross-session knowledge continuity (personal)
- Home: concord plugin (`session-state`), extension — not a new plugin
- Spec home: local (harness dir). concord README policy = "design notes kept local, not in this repo"; the concord PR is review-only, not a merge of this file.

## Problem

Sessions lose the founding task context — the initial framing of "what this task is, why, and which forks are already decided." Two observed layers. v2 keeps them SEPARATE because their fixes differ in confidence:

1. Cross-session loss (mechanical, high-confidence fix): a fresh session or a post-compaction resume starts without the founding framing. Re-injecting it at SessionStart / PreCompact guarantees it is present in context. This is the v1 commitment.
2. In-session drift (weak fix, experiment only): a long session opens with a task-context dump; the assistant later proceeds in a direction that breaks it. Re-injection buys recency near the context head but NOT guaranteed attention — and unlike the session-state plugin (whose enforcement layer degraded onto a passive fallback layer), in-session drift has no floor: if recency does not translate to attention, the residual fix is zero. This half is a measured experiment with a kill criterion, NOT a design commitment.

Root for both is retrieval/attention, not storage — in-session the data is fully captured (it is in the transcript) yet still unused. But "salience, not storage" is only half the story: it fixes the cross-session half cleanly, and is unproven for the in-session half. It also hides a real storage-side gap — capture accuracy (below).

## Evidence (two-machine diagnosis)

The "monster session" is not dysfunction — it is a coping mechanism for broken continuity. The user keeps one session alive for weeks rather than closing at task boundaries, because closing risks losing the founding framing and the fork decisions. Measured on two independent machines / workloads:

```
machine                       session   tools  span    active   idle%  resumes  out
machine A (RAG workload)      9465de14    833  12.7d   27.9h    91%      19      Y
machine A (RAG workload)      0aa3c199    403  23.9d   20.2h    96%       8      Y
machine B (crypto workload)   ddf39ad5   1438  25.2d   59.2h    90%      23      Y
machine B (crypto workload)   21f4ada1    803  24.8d   61.7h    90%      15      Y
```

Reading: a "25-day" session is roughly 1-2.5 days of actual work smeared across weeks via 8-23 resumes; 82-96% idle; output present (productive). Replicates across two unrelated workloads — working style, not project-specific.

The measurable continuity cost is the resume count (8-23 per monster) times a per-resume re-establish tax. The verbal workaround ("re-read my first message") is NOT text-quantifiable (phrasing varies; greps return only boilerplate false positives). Frequency rests on user testimony; the resume/idle structure is the hard evidence.

Monster resumed sessions and this cross-session continuity work are the same problem from two ends: the monster session is the symptom (never close because handoff is broken), this work is the fix. Fixing continuity dissolves the monster.

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

## Refinements adopted at planning (grounded in the existing session-state code)

Reading the existing plugin during planning surfaced four simplifications, all approved before the plan was written; the sections above are written to match them:

- R1 — no separate `_consolidated.jsonl`. Since per-turn injection was dropped, merge-on-read runs only at SessionStart / compaction; a recency cap on sessions merged (SESSIONS_MERGE_CAP) suffices, so the consolidation file is deferred.
- R2 — no separate PreCompact hook. The existing SessionStart matcher already fires on `compact`; compaction re-injection reuses it (post-compaction re-inject rather than pre-compaction placement — see section 4).
- R3 — one injector, not two. The existing injector is extended to render the charter, so there is no second injector and no double-injection of rationale.
- R4 — reuse the existing per-session `<session-id>.json` model as the decision store instead of a new `charter.d/` shard format; it is already per-session-owned, hence concurrent-safe.

## Design

### 1. Charter artifact

```
$CLAUDE_CONFIG_DIR/projects/<proj>/state/
  charter.md                    # north-star only. see the north-star write rule below.
  <session-id>.json / .md       # existing per-session model, REUSED as the decision store (per-session-owned = concurrent-safe). No new shard format — see "Refinements adopted at planning".
```

- North star: the current best statement of what this task is and why. Updatable (framing evolves; it is not always the first message), not immutable.
- Decisions / open loops: append-only, machine-written from `DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:` tags (reusing concord's tag-harvest).

### 2. Capture — and its honest limit

There is NO zero-effort-accurate capture path. The two options trade accuracy for effort, and v1 states this plainly rather than implying a free lunch:

- Auto-draft (zero-effort, low-accuracy): the first substantive user message is written as a DRAFT north-star ONLY if `charter.md` is absent/empty (see the north-star write rule below). It is frequently wrong — the real framing often emerges several turns in — and extraction is harness-fragile: skill injections, `<system-reminder>` blocks, hook context, caveman-mode banners, and local-command stdout must all be filtered, and that filter breaks across harness versions — a boilerplate-extraction fragility risk. So the auto-draft is a placeholder, not a trusted value.
- Manual set (high-accuracy, non-zero effort): `/charter set <text>` or `/charter pin` writes the real framing. This is deliberate hand-input — the same hand-maintenance the session-state plugin fought — accepted here ONLY for the north-star (one small value, set rarely), never for the frequent decision path (which stays automatic).

Mitigation for the auto-draft being wrong: `/charter` shows what is currently pinned, so divergence from intent is visible and correctable in one command.

### 3. Commands (concord-provided custom slash commands, NOT built-in)

| Command | Effect |
|---|---|
| `/charter` | Show current charter: north-star + open loops + recent N decisions. |
| `/charter set <text>` | Overwrite the north-star with explicit text. |
| `/charter pin` | Overwrite the north-star with the previous user message. |

Shipped as `commands/*.md` in the concord `session-state` plugin. `clear` / `off` deferred.

### 4. Injection triggers (v1)

- SessionStart (all sources — startup / resume / compact): after the durability catch-up (section 6), inject the charter (north-star + merged open loops + capped decisions). The existing session-state SessionStart matcher already fires on `compact`, so compaction re-injection reuses it — there is NO separate PreCompact hook. Note the resulting semantic difference: a PreCompact hook would place the framing in front of the summarizer (pre-compaction); SessionStart(compact) re-injects it into the freshly-compacted context (post-compaction). Both leave the framing present in the compacted context; the post approach reuses a verified, already-wired hook. Startup additionally unions recent sessions, superseding the last-writer-wins `_latest.md` fresh-session role (section 7).

Per-turn UserPromptSubmit injection is NOT in v1 (moved to the experiment, section 8). Rationale: a header that changes every turn, injected at the context head, invalidates the prompt-cache prefix every turn (large cost); injected at the tail it is cache-safe but low-salience — an unaddressed position/cache tradeoff. Repeating it every turn also reproduces the very "noise buries signal" failure inside the context window, and habituates the model so the header becomes wallpaper (SessionStart injection is salient precisely because it is novel/once). Committing an unmeasured per-turn trigger while deferring drift-detection as "unmeasured" is inconsistent; both go to the experiment.

### 5. Storage and concurrent-safety

LWW (last-writer-wins) = a later writer overwrites an earlier writer's file, losing the earlier content (the observed "modified on disk" incident).

- Decisions / open loops (frequent, automatic): reuse the existing per-session `<session-id>.json` model — each session's writer touches only its own file, so clobber is structurally impossible. Readers union + dedup across sessions (merge-on-read). Concurrent-safe by construction, with no new shard format.
- North-star (`charter.md`) write rules: auto-draft writes ONLY when `charter.md` is absent/empty (first-writer-wins), so two fresh parallel sessions cannot clobber each other's draft. Only an explicit `/charter set` / `/charter pin` overwrites — that IS rare and deliberate, so LWW there is safe. (The v1 flaw was calling the automatic per-session auto-draft "rare/deliberate"; it is neither.)

Read cost bound: merge-on-read runs only at SessionStart / compaction (infrequent — per-turn injection was dropped), so an unbounded union was never the real cost. A recency cap suffices:

- Recency-gated merge: union only the most-recent SESSIONS_MERGE_CAP sessions' models, not every session ever written. No separate consolidation file in v1 (deferred).
- Note: the durability all-scan (section 6) still lists all `<session-id>.json` per SessionStart — bounded per start (a readdir + stat per session), but grows with project lifetime; add a recency gate only if a project accumulates thousands of sessions.

- Output ranking/cap (recency + dedup): north-star and unresolved open loops always; decisions capped to most-recent N; raw activity noise dropped (the live lesson: injected `Recent activity` was ~30 churn lines burying 3 decisions). Lexical ranking added only on a measured miss.

### 6. Durability across abrupt exit (Ctrl+C / Ctrl+D / crash)

Not "structurally impossible" — one honest residual. The transcript `.jsonl` is the durable log (Claude Code appends per event, independent of hooks), and harvest is watermark-based (per-session byte offset) and idempotent.

- Normal exit: the Stop hook harvests the final delta.
- Abrupt exit, session later resumed: that session's SessionStart catches up its own un-watermarked tail.
- Abrupt exit, session ABANDONED and a NEW session opened (the target workflow): the abandoned session is never resumed, so a per-session catch-up would miss its final turn forever. Fix: SessionStart scans ALL shards/transcripts in the project for an un-watermarked tail (watermark byte-offset < transcript size) and folds any it finds — not just "the prior session." The watermark prevents double-counting.
- Residual: a decision is lost only if the transcript file itself is deleted before any subsequent SessionStart. This is the honest bound; the v1 "loss impossible" claim was overstated.

### 7. Relationship to concord session-state (injector ownership)

Two SessionStart injectors (existing session-state + charter) must not both emit rationale. Ownership division:

- Charter owns: north-star, open loops, decisions (the rationale layer).
- session-state injector keeps: activity/recovery facts only (what files/commands, recovery pointers), and cedes the `DECISION:` / `OPEN-LOOP:` / `NEXT:` rationale rendering to the charter.

The charter shard-merge supersedes the LWW `_latest.md` for the fresh-session inject role, repairing the concurrent-unsafe defect. Session-keyed `<session-id>.md` state files are unchanged.

## Honest limits

- In-session salience is partly a model/harness bound; re-injection buys recency, not attention. v1 does NOT commit to fixing it (section 8).
- Capture accuracy has no zero-effort-accurate path (section 2). v1 states this rather than implying auto-draft is trustworthy.
- Cross-session RESOLVED does not close a loop opened in another session, so open loops can over-report across sessions until re-resolved in a session whose model still holds them. Documented, not fixed in v1.

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

- Unit: auto-draft writes only when `charter.md` absent/empty (north-star write rule); `/charter set` / `pin` overwrite; per-session decision write; merge-on-read union + dedup + recency cap; boilerplate/`<...>`/hook/local-command filtering (boilerplate-extraction fragility).
- Concurrency: two fresh parallel sessions each auto-draft → no `charter.md` clobber (north-star write-rule regression guard); two sessions each write only their own `<session-id>.json` → reader unions both with no loss.
- Scaling: a project with many sessions → injection read cost stays bounded via the recency-gated session-merge cap (`SESSIONS_MERGE_CAP`), not an unbounded union (read-cost-bound guard).
- Durability: a transcript with tagged decisions but no Stop event, session abandoned → a subsequent DIFFERENT session's SessionStart all-session scan harvests the tail (section 6), watermark prevents double-count.
- Ownership: the single (extended) injector emits rationale once (charter), not duplicated by a second injector (R3; injector-ownership guard).
- Injection: SessionStart emits the charter after catch-up, on every source (startup / resume / compact — R2, no separate PreCompact hook). No per-turn injection in v1.

## Deferred (revisit on measured need)

- In-section-8 in-session drift lever (per-turn / inject-on-change / every-K).
- LLM-distilled north-star.
- Semantic drift-detection trigger.
- Lexical / vector ranking of decisions.
- `/charter clear` / disable.
- Cross-machine sync.
