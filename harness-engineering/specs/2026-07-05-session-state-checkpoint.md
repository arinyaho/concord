# Session-State Checkpoint — Design

- Status: Draft (design approved, spec under review)
- Date: 2026-07-05
- Track: Harness engineering - the memory / ledger / doc-churn finding (D2 in the README track map)
- Scope: v1 = Layer 1 (machine activity trail) + Layer 2 (inline-tag rationale harvest), for same-session resume/compaction and for continuation in a fresh session

## Problem

Mining the session corpus surfaced two recurring wastes in long sessions:

- **W1 — ledger/doc write churn.** The model maintains in-flight state (current todos, what is done, open questions, decisions) in a hand-edited prose file (`LEDGER.md`, and misuse of durable memory files). Observed: `LEDGER.md` edited 24x in one session; project memory / `MEMORY.md` edited 14-16x. Each edit is a read-match-replace round trip, with occasional string-not-found retries (the edit-before-read / string-not-found waste, tracked separately).
- **W2 — self-transcript read churn.** The model re-reads its own session transcript (15x in one session) to recover "where am I / what did I decide / what is done". Transcript files reach multiple MB, so each recovery read is large, and it repeats on resume, after context compaction, and whenever in-context state has decayed.

Both are symptoms of one gap: **in-flight (tier-2) session state has no designated home.** Durable cross-session state (tier-1) is already handled by the memory files plus the `MEMORY.md` index (an earlier pass re-leaned that index). Tier-2 state, having no home, sprawls into hand-edited ledgers (W1) and into the transcript itself, which is then re-read for recovery (W2).

### Constraint (from the track)

CLAUDE.md-style behavioral rules do not fix behavioral thrash. Evidence: an existing "use absolute paths, do not `cd`" rule is ignored ~193x in a single session. Therefore a fix must be **enforcement (the harness does it)** or **need-removal (a cheaper path exists so the bad habit dies)** — not a new convention that asks the model to be tidy.

### Evidence that shaped the source decision

- `~/.claude/todos/` does not exist — this harness does not persist the todo/task list to disk.
- The harness task tools (`TaskCreate` / `TaskUpdate`) are used in only 1 of the 8 most recent sessions. The real equilibrium is a hand-written prose ledger, not the structured task list.

Consequence: "persist the task list" has almost nothing to persist. The snapshot source cannot be the task list. It must be **derived from the transcript**, which every hook receives as `transcript_path`.

## Goals

- Kill W2: on resume, compaction, or continuation in a fresh session, the model receives a compact state summary and does not re-read a transcript to recover.
- Reduce W1: with activity auto-captured, the motivation to hand-maintain a status ledger drops (partial need-removal). Full W1 elimination is out of scope for v1.
- Zero added model-token cost on the write path (the harness writes state).
- No new subsystem: two small Node hooks plus a state file format.
- Project-agnostic: the hooks derive every path from `transcript_path`, so one install serves any `~/.claude` project with no per-project config or brand assumption, and each project's state stays isolated by its own directory.

## Non-goals (v1)

- Full elimination of W1 ledger churn (v1 reduces, does not remove).
- LLM/semantic summarization of the transcript (v1 is mechanical extraction + inline-tag harvest only).
- Reconciling state across *concurrent* live sessions in the same project (v1 accepts last-writer-wins on the rolling project pointer; see edge cases). Carryover into a fresh, non-concurrent session *is* in scope (see below).
- Session hygiene for long resumed sessions (checkpoint/close at task boundaries) - a separate track, though this mechanism feeds it.

## Behavioral contract

1. After each assistant turn, the harness appends any new activity + tagged rationale from that turn's transcript delta to a per-session state file. No model action required for the activity half.
2. On session resume or post-compaction restart, the harness injects this session's own state file. On a fresh startup it injects the project's most recent session state, recency-gated and labeled as prior-session context to verify. On an explicit `clear`, it injects nothing.
3. The state file is machine-owned. The model never hand-edits it. Its size stays bounded via machine compaction.
4. If the model tags a decision or open item inline (`DECISION:`, `OPEN-LOOP:`, `NEXT:`), that line is harvested into state. If it does not, only the activity half is captured (graceful degradation) — nothing breaks.

## Architecture

Two hooks + per-session state files plus one rolling project pointer. Both hooks are Node scripts in `$CLAUDE_CONFIG_DIR/hooks/` (the harness config dir, default `~/.claude`), reading stdin JSON and env.

```
Stop hook  (session-state-writer.js)   [fires: end of every assistant turn]
  stdin: { session_id, transcript_path, ... }
  1. resolve state dir = <dir of transcript_path>/state/
  2. read byte-offset watermark for session_id (default 0)
  3. seek transcript_path to watermark, read new bytes, split into JSONL lines
  4. extract A (facts) from tool_use events in the delta
  5. extract B (rationale) from assistant-text lines matching the tag prefixes
  6. merge into state/<session_id>.md, compact in place, write
  7. copy the result to state/_latest.md (rolling project pointer)
  8. persist new byte offset
  9. exit 0 (never block the turn)

SessionStart hook  (session-state-injector.js)   [fires: session start, all sources]
  stdin: { session_id, transcript_path, source, ... }
  1. resolve state dir = <dir of transcript_path>/state/
  2. pick the source file by session start reason:
       resume | compact -> state/<session_id>.md
       startup          -> state/_latest.md, only if its mtime is within
                           RECENCY_H hours; prepend a "prior session in this
                           project - verify relevance" header
       clear            -> none
  3. if a file was picked and exists: write it to stdout (= injected context)
  4. exit 0
```

Injection contract: a SessionStart hook's plain stdout is injected into the session context (documented hook behavior; no structured JSON required).

## Components

### session-state-writer.js (Stop hook)

- **What:** Parse the transcript delta since last run; append facts + tagged rationale to the session state file; compact; advance the watermark.
- **Interface:** stdin JSON `{ session_id, transcript_path }`; side effect = write `state/<session_id>.md`, refresh `state/_latest.md`, and update `state/<session_id>.pos`; stdout ignored; exit 0 always.
- **Depends on:** transcript JSONL schema (tool_use entries with `name` + `input`; assistant message entries with text content).

**Extractor A — facts (from tool_use in delta):**

- `Edit` / `Write` -> edited file path
- `Bash` -> command, filtered to meaningful ones (git commit/push, `gh pr`, test/pytest, cdk/amplify deploy, npm/pip); drop noise (ls, cd, cat, echo, grep)
- `TaskCreate` / `TaskUpdate` -> task title + status change
- PR numbers -> parsed from `gh pr` commands or their tool_result
- (optional) `Agent` dispatches -> subagent task label

**Extractor B — rationale (from assistant text in delta):**

- Lines matching `^(DECISION|OPEN-LOOP|NEXT|RESOLVED):` (case-insensitive), captured verbatim minus the prefix. `RESOLVED:` closes a prior open loop.

### session-state-injector.js (SessionStart hook)

- **What:** On resume/compact, print this session's own state file; on a fresh startup, print the project's most recent session state (recency-gated, labeled) so a session started to continue prior work still recovers without a transcript re-read.
- **Interface:** stdin JSON `{ session_id, transcript_path, source }`; stdout = the picked state (possibly under a prior-session header) or empty; exit 0 always.
- **Depends on:** the writer's per-session file and its `state/_latest.md` pointer.

### State file — state/<session_id>.md

```
# Session state — <session_id>
# machine-owned - do not hand-edit

## Open loops
- <open item>            (from OPEN-LOOP:, until a matching RESOLVED:)

## Decisions
- [<topic>] <decision>   (from DECISION:, latest per topic kept)

## Next
- <next step>            (from NEXT:, latest kept)

## Recent activity
- edited path/to/file.py
- ran: pytest tests/ (exit 0)
- git commit <sha> "<msg>"
- PR #123 opened
```

Sidecar `state/<session_id>.pos` = integer byte offset (watermark).

Rolling project pointer `state/_latest.md` = a copy of the most recent session's state file in this project. The `state/` dir already lives under the project's own directory, so no project key is needed in the name; it is refreshed on every writer run (last-writer-wins across concurrent sessions).

### Compaction (inside the writer, every run)

- **Open loops:** keep all unresolved; a `RESOLVED:` line removes the matching open loop; hard cap N (e.g. 20), oldest dropped with a `(...truncated)` marker.
- **Decisions:** keep the latest per topic key (text in the leading `[...]`, or first few words if untagged); cap N.
- **Recent activity:** ring buffer of the last N facts (e.g. 40).

This keeps the file small and bounded, so it never becomes a growing doc that re-introduces W1.

## Data flow

- **Write path (every turn):** Stop hook reads only the delta (seek to byte watermark), extracts, merges, compacts, writes. No model tokens. Cost is a tail read + small file write per turn.
- **Read path:** on resume/compact the injector prints this session's own state; on a fresh startup it prints the recency-gated project-rolling state under a prior-session header. Either way one small file enters context; no transcript re-read.

## Hope surface (honest)

- **Layer 1 (facts) = zero-hope floor.** Pure machine extraction, no model behavior change. This is the safety net and it always runs.
- **Layer 2 (rationale) = one micro-convention:** tag decisions/open items inline with `DECISION:` / `OPEN-LOOP:` / `NEXT:`. This is the only "hope" in the system. It is weaker than enforcement but stronger than the failed no-`cd` rule:
  - Different risk profile: `cd` fights entrenched muscle memory (hence 193x ignored); the tag is a new, lightweight behavior with a payoff visible on every resume (self-reinforcing feedback loop).
  - Graceful degradation: if the tag is forgotten, Layer 1 facts still flow, so transcript re-reads shrink (15x -> few) rather than reappearing. The system does not break.

The convention is introduced via a single project CLAUDE.md line, reinforced by the injected payoff — not relied upon as the primary mechanism.

## Error handling / edge cases

- No state file (fresh session): injector emits nothing.
- Unreadable/absent `transcript_path`: writer no-ops, exit 0 (never break a turn).
- Malformed JSONL line: skip it, continue.
- Large mid-session delta: byte-offset seek reads only new bytes, so cost scales with delta, not transcript size.
- Concurrent sessions in the same project: per-session files stay isolated by `session_id`; only the shared `state/_latest.md` is last-writer-wins, and the injected prior-session block is labeled "verify relevance", so a mixed pointer is low-harm.
- Hook exceptions: caught; always exit 0 so a hook failure never blocks the turn or the session start.
- `source = clear`: intentionally emit nothing (the user cleared context on purpose).
- False continuity on fresh startup: `state/_latest.md` may belong to an unrelated prior task. Mitigated by the recency gate (skip if older than RECENCY_H) plus the "prior session - verify relevance" header; the block is small and the model can ignore it.
- Transcript rewrite/truncation: the byte-offset watermark assumes an append-only transcript. If the stored offset exceeds the current file size, treat the transcript as rewritten and reset the offset to 0 (full re-scan). Whether compaction rewrites the `.jsonl` must be verified during implementation.

## Testing

- **Unit — extractor A:** fixture JSONL with Edit/Write/Bash/Task events -> assert the expected fact lines; assert noise commands filtered.
- **Unit — extractor B:** fixture assistant text with tagged + untagged lines -> assert only tagged lines harvested; `RESOLVED:` closes the matching open loop.
- **Idempotency:** run the writer twice on the same transcript (watermark unchanged after first) -> no duplicate appends.
- **Compaction:** superseded decision dropped; caps enforced; truncation marker present.
- **Rolling pointer:** after a writer run, `state/_latest.md` equals the just-written session file; a later run from a second session overwrites it (last-writer-wins).
- **Injector:** `source=resume` with a session file -> stdout equals it; `source=startup` with a recent `state/_latest.md` -> stdout is that state under the prior-session header; `source=startup` with a stale `_latest.md` -> empty; `source=clear` -> empty; no files -> empty.
- **Integration:** point the injector at a real small session's state and confirm the emitted context is the compact summary, not the transcript.

## Rollout

1. Land the two hooks + state format.
2. Wire in `$CLAUDE_CONFIG_DIR/settings.json`: add the Stop hook; append the injector as an additional SessionStart command (do not replace any existing SessionStart hook).
3. Add the one-line CLAUDE.md tag convention.
4. Dogfood on this project's sessions.
5. Measure before vs after by re-running the session-corpus diagnostic (parses session logs): transcript re-read count and `LEDGER.md`/memory edit count.

## Deferred (v2+)

- Full W1 elimination (enforcement on hand-ledger writes, e.g. a PreToolUse guard, if the partial reduction proves insufficient).
- PreCompact nudge: a rare, well-timed reminder to record open loops right before compaction.
- Compaction-quality tuning (topic keying, dedup heuristics).
- Reconciling divergent state across concurrent live sessions (v1 accepts last-writer-wins on `state/_latest.md`).
- Bringing a project-neutral session-corpus diagnostic into this repo (today it is a private, project-named script), so any project can measure the before/after.
