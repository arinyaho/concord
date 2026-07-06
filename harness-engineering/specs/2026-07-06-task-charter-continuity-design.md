# Task Charter — cross-session context continuity (harness D5)

- Status: DESIGN (brainstorm-approved 2026-07-06)
- Track: harness-engineering D5 (cross-session knowledge continuity, personal)
- Home: concord plugin (`session-state`), extension — not a new plugin
- Spec scope: local (harness dir); stripped from the concord repo per the D2 precedent

## Problem

Sessions lose the founding task context — the initial framing of "what this task is, why, and which forks are already decided." Two observed layers, one root:

1. In-session drift: a session opens with a long task-context dump; partway through, the assistant proceeds in a direction that breaks that framing. Re-stating it concisely does not restore it; re-pulling the original is hard. The user's repeated workaround: "go re-read what I said at the start of this session." The assistant has itself admitted, mid-session, that the relevant data was already accumulated in the session but it did not attend to it.
2. Cross-session loss: a fresh session (or a resume after compaction) starts without that framing at all.

Root cause is the same for both: the founding framing loses salience as the transcript grows, and vanishes across session boundaries. The user's own diagnosis is the key: "if it fails even within one session, then crossing to a new session it just won't know." The failure is retrieval/attention, not storage — in-session the data is fully captured (it is right there in the transcript) yet still not used.

## Evidence (two-machine diagnosis)

The "monster session" is not dysfunction — it is a coping mechanism for broken continuity. The user keeps one session alive for weeks rather than closing at task boundaries, because closing risks losing the founding framing and the fine-grained fork decisions. Measured on two independent machines / workloads:

```
machine      session   tools  span    active   idle%  resumes  out
mac (RAG)    9465de14    833  12.7d   27.9h    91%      19      Y
mac (RAG)    0aa3c199    403  23.9d   20.2h    96%       8      Y
daramg (crypto) ddf39ad5 1438 25.2d   59.2h    90%      23      Y
daramg (crypto) 21f4ada1  803 24.8d   61.7h    90%      15      Y
```

Reading: a "25-day" session is roughly 1-2.5 days of actual work smeared across weeks via 8-23 resumes; 82-96% idle; output present (productive). The pattern replicates across two unrelated workloads — it is the user's working style, not project-specific.

The measurable continuity cost is the resume count (8-23 per monster) times a per-resume re-establish tax (Read of ledger/memory/state files on cold start). The specific verbal workaround ("re-read my first message") is NOT text-quantifiable — its phrasing varies and greps return only boilerplate false positives. Frequency rests on user testimony; the resume/idle structure is the hard evidence.

D3 (monster sessions) and D5 (cross-session continuity) are therefore the same problem seen from two ends. D3 is the symptom (never close because handoff is broken); D5 is the fix (make the handoff carry the founding context so closing is safe). Fixing continuity dissolves the D3 monster.

## Goals

- Preserve the founding task context ("north star") as a durable, high-salience artifact.
- Re-surface it within a long session (fight in-session drift) and re-inject it across session boundaries (continuity).
- Accrete fork decisions (the "chose B over A because X", including the rejected alternative) automatically, append-only.
- Be concurrent-safe: parallel sessions on the same project must not clobber each other's accumulated decisions.
- Zero hand-maintenance for the frequent path (avoid re-importing the D2 ledger-churn disease).

## Non-goals (v1)

- Cross-machine sync. The user works on exactly two machines but on disjoint projects (RAG on one, crypto on the other); a charter is project-scoped and never spans machines. Out of scope.
- LLM-distilled charter. Deferred (lossy-summary risk + cost/latency/nondeterminism).
- Semantic drift-detection. Deferred (per-turn LLM judgment is expensive; heuristics are weak; classic over-engineering — measure whether cheaper levers suffice first).
- Lexical/vector ranking of decisions. v1 uses simple recency + dedup cap; add ranking only on measured need.
- Forcing the model to weight the charter. A hook can re-inject near the context head (recency salience — the best available lever); it cannot compel attention. This is an accepted bound, not a gap to close in v1.

## Design principle

Salience, not storage. The data is captured; the fix is keeping the founding framing near the context head at the moments it is at risk. Everything below serves re-surfacing, not new storage.

## Design

### 1. Charter artifact

A single project-scoped markdown file is the source of truth, plus per-session append-only decision shards:

```
$CLAUDE_CONFIG_DIR/projects/<proj>/state/
  charter.md                  # north-star only. small, user-owned, rare writes.
  charter.d/<session-id>.jsonl  # per-session append-only decision / open-loop log.
  <session-id>.md / .json     # existing concord session-state (unchanged).
```

- North star: the current best statement of what this task is and why. Updatable (framing evolves — it is not always the first message; this very brainstorm's real scope crystallized several turns in). NOT an immutable pin.
- Decisions / open loops: append-only, machine-written from `DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:` tags (reusing concord's existing tag-harvest).

### 2. Capture

- Auto-draft: the first substantive (non-boilerplate) user message of a session is written as the initial north-star draft. Zero effort, covers the common case.
- Manual override (the only hand-lever): `/charter set <text>` replaces the north-star when the real framing crystallizes; `/charter pin` promotes the immediately-preceding user message without retyping.
- Evolution: fork decisions append automatically to the session shard, flushed incrementally per turn so an abrupt exit strands nothing (see 6).

### 3. Commands (concord-provided custom slash commands, NOT built-in)

| Command | Effect |
|---|---|
| `/charter` | Show current charter: north-star + open loops + recent N decisions. |
| `/charter set <text>` | Replace the north-star with explicit text. |
| `/charter pin` | Promote the previous user message to north-star. |

Shipped as `commands/*.md` in the concord `session-state` plugin. `clear` / `off` deferred (YAGNI).

### 4. Injection triggers

- PreCompact (primary): compaction is the exact moment the opening framing is summarized/dropped. On PreCompact, re-inject the fuller charter (north-star + open loops + capped decisions). Highest-signal, native hook.
- UserPromptSubmit (continuous, cheap): each turn, inject a compact charter header (north-star + open loops, ~5-10 lines, with `(full: /charter)` pointer). Keeps the framing salient before any compaction and fights drift continuously. Header only, not the full charter — token discipline.
- SessionStart (cross-session): inject the charter on resume / fresh session, after catching up any un-watermarked transcript delta from the prior session (see 6). This supersedes concord's LWW `_latest.md` for the fresh-session role (see 7).
- `/charter` (on demand): the one-keystroke form of the user's current manual workaround.

### 5. Storage and concurrent-safety

Last-writer-wins (LWW) = a later writer overwrites an earlier writer's file, losing the earlier content (the observed "modified on disk" parallel-session incident). The split:

- Frequent + automatic (decisions / open loops) must never be LWW. Each session appends only to its own `charter.d/<session-id>.jsonl`; no writer touches another session's file, so clobber is structurally impossible. Readers union + dedup all shards at inject time. This is the append-only-log pattern — concurrent-safe by construction, matching the D5 "append-only files are trivially concurrent-safe" call.
- Rare + deliberate (north-star) may stay single-file LWW in `charter.md`. `/charter set` is a user-intentional, low-frequency act; two parallel sessions setting it at once is implausible, and if overwritten the user is aware.

Merge-on-read must rank + cap (the live lesson: this session's injected `Recent activity` was ~30 churn lines burying the 3 real decisions):

- Always: north-star, unresolved open loops.
- Capped: decisions → most-recent N (dedup by normalized text).
- Dropped: raw activity noise.
- v1 ranking = recency + dedup only. Lexical ranking (the D5 retrieval decision) is added only when a miss is measured.

### 6. Durability across abrupt exit (Ctrl+C / Ctrl+D / crash)

Flush must not depend on the Stop hook alone. An interrupt (Ctrl+C), EOF (Ctrl+D), terminal close, or crash may not fire Stop, so decisions tagged in the last turn(s) would otherwise be stranded. The transcript `.jsonl` is the durable log: Claude Code appends to it per event, independent of hooks, so on abrupt exit everything up to the interrupt is already on disk. Harvest is watermark-based (a byte offset per session) and idempotent. Two layers make loss structurally impossible:

- Incremental flush: UserPromptSubmit (already injecting the compact header every turn) also harvests the transcript delta into the session shard each turn. An abrupt exit leaves at most the final turn un-flushed.
- Catch-up on next start: SessionStart re-processes any un-watermarked transcript delta from the prior session before injecting, recovering that final turn. The watermark prevents double-counting.

Hooks are only *when* the durable transcript is processed; the transcript itself is never the thing that is lost. No explicit "save before exit" action is required of the user.

### 7. Relationship to concord session-state

The charter shard-merge takes over the fresh-session inject role from the LWW `_latest.md`, repairing the concurrent-unsafe defect D5 named. Session-keyed `<session-id>.md` state files are unchanged. The charter layer is additive: new capture (founding framing, currently missed by tag-harvest), new injection points (PreCompact, UserPromptSubmit), new concurrent-safe storage.

## Honest limits

- In-session salience is partly a model/harness bound. Re-injection buys recency, not guaranteed attention. v1 ships the recency lever and measures the residual.
- The auto-draft may capture the wrong framing (when the task emerges over several turns). `/charter set` is the escape hatch; the risk is the user forgetting to use it — mitigated by `/charter` showing what is currently pinned so drift from intent is visible.

## Rollout / dogfood + measurement

- Build in the concord `session-state` plugin (Node built-ins only, project-agnostic paths derived from `transcript_path`, matching existing hooks).
- Dogfood on both machines. The success signal is behavioral: the user can close a session at a task boundary and a fresh session continues without a "re-read my first message" round.
- Measurement (measure-don't-assert): re-run the resume/idle probe after N sessions; watch for a drop in per-session resume count and in state-recovery Reads on cold start — i.e., sessions getting shorter/closable, not smaller-but-still-monster.

## Testing approach

- Unit: north-star draft capture from first substantive message; `/charter set` / `pin` file writes; shard append; merge-on-read union + dedup + recency cap; boilerplate filtering (skill-injection text, `<...>` system blocks, local-command stdout).
- Concurrency: two simulated sessions appending to distinct shards, reader unions both with no loss (the LWW regression guard).
- Abrupt exit: a transcript with tagged decisions but no Stop event; verify the delta is harvested incrementally (UserPromptSubmit) and, failing that, caught up on next SessionStart, with the watermark preventing double-count.
- Injection: PreCompact emits fuller charter; UserPromptSubmit emits compact header under a size bound; SessionStart reads shard-merge not `_latest.md`.
- E2e: real transcript, verify charter file evolves and injected blocks stay capped.

## Deferred (revisit on measured need)

- LLM-distilled north-star.
- Semantic drift-detection trigger.
- Lexical / vector ranking of decisions.
- `/charter clear` / disable.
- Cross-machine sync.
