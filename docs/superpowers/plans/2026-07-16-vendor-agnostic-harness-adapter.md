# Vendor-agnostic harness adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a vendor-neutral core and a Claude Code adapter from Concord's plugin, so the three capabilities (review-until-green, charter, session-state) run over a small port contract instead of assuming Claude Code — with zero observable behavior change for existing Claude Code users.

**Architecture:** Ports-and-adapters. A new `plugins/concord/core/` holds pure logic (rounds, dedupe, charter, fact/rationale extraction over a neutral entry shape) and depends on nothing harness-specific. A new `plugins/concord/adapters/claude-code/` holds every Claude-Code-specific concern (transcript byte-offset read, Claude message-shape → `NeutralEntry` mapping, stdin-payload normalization, state-dir resolution). The existing `plugins/concord/hooks/` and `commands/` dirs stay as the Claude Code *packaging* — the manifest paths never move — but their entrypoints become thin wrappers that require into `core` + `adapters/claude-code`. A stub `adapters/codex/` documents the Codex mapping without implementing it.

**Tech Stack:** Node.js (CommonJS, `require`), `node:test` + `node:assert` (no external test deps), git.

## Global Constraints

- **No behavior change for Claude Code.** The entire existing suite under `plugins/concord/hooks/test/*.test.js` must pass unchanged after every task (adjust a test's `require` path only when a file it imports has moved; never change an assertion). This suite is the regression contract.
- **Manifest paths are frozen.** `plugins/concord/.claude-plugin/plugin.json`, root `marketplace.json`, `hooks/hooks.json`, and `commands/*.md` keep referencing `${CLAUDE_PLUGIN_ROOT}/hooks/*.js`. Entrypoint files at those paths stay resolvable (as thin shims if their logic moves).
- **`core/` is vendor-clean.** No file under `plugins/concord/core/` may contain the substrings `CLAUDE_`, `transcript_path`, `session_id`, `last_assistant_message`, or `Task tool`. A guard test enforces this (Task 8).
- **CommonJS only.** `require`/`module.exports`, matching the existing files. No ESM, no TypeScript, no new dependencies.
- **Node test runner.** All tests run under `node --test` from the repo root (the configured DoD command in `review.config.json`).
- **`NeutralEntry` shape (canonical, extends the design doc):**
  ```js
  // one turn of a harness transcript, harness-agnostic
  NeutralEntry = {
    role: 'user' | 'assistant',
    text: string,                 // concatenated text of the turn ('' if none)
    toolCalls: Array<{ name: string, input: object }>  // [] for user turns / no calls
  }
  ```
  The design doc names `{ role, text }`; `toolCalls` is added here because fact extraction reads tool calls (file paths, commands), not prose. This is the neutral boundary both `extractFacts` (uses `toolCalls`) and `extractRationale` (uses `text`) consume.

---

## File Structure

**New — `plugins/concord/core/`** (vendor-clean logic; moved from `hooks/lib/` + `hooks/*-cli.js`):
- `core/ports.js` — the port contract as JSDoc typedefs + `PORT_NAMES` + a `normalizeEntry()` validator. The one file every adapter reads.
- `core/config.js` — moved from `hooks/lib/config.js` (constants/regex; already neutral).
- `core/state.js` — moved from `hooks/lib/state.js`.
- `core/extract.js` — moved from `hooks/lib/extract.js`, refactored to consume `NeutralEntry[]` (Task 3).
- `core/charter.js` — moved from `hooks/lib/charter.js`, refactored so transcript reading + entry-shape parsing move out to the adapter (Task 4).
- `core/gate.js`, `core/gate-panel.js`, `core/gate-contract.js`, `core/intent.js`, `core/dod-exec.js`, `core/review.js` — moved from `hooks/lib/*` (already neutral; import-path updates only, Task 5).
- `core/review-cli.js` — moved from `hooks/review-cli.js` (the deterministic engine; already vendor-clean, Task 6).
- `core/charter-cli.js` — moved from `hooks/charter-cli.js` (Task 6).

**New — `plugins/concord/adapters/claude-code/`** (every Claude-Code-specific concern):
- `adapters/claude-code/transcript.js` — moved from `hooks/lib/transcript.js` (byte-offset JSONL delta read) + a new `mapEntries(rawEntries) -> NeutralEntry[]` that encapsulates Claude message shape (`e.type === 'assistant'`, `e.message.content`, `item.type` of `tool_use`/`text`, `msg.role === 'user'`).
- `adapters/claude-code/statedir.js` — moved from `hooks/lib/statedir.js`.
- `adapters/claude-code/event.js` — new: `readStdinEvent()` parses the Claude Code hook stdin JSON into a `NeutralEvent` (`{ sessionId, transcriptPath, lastAssistantMessage?, source }`).

**New — `plugins/concord/adapters/codex/`** (stub, Task 9):
- `adapters/codex/README.md`, `adapters/codex/GAPS.md`.

**Modified — `plugins/concord/hooks/`** (thin Claude Code packaging entrypoints):
- `hooks/review-cli.js`, `hooks/charter-cli.js` → one-line shims: `module.exports = require('../core/review-cli.js')` etc., or `require('../core/review-cli.js')` execution passthrough.
- `hooks/session-state-writer.js`, `hooks/session-state-injector.js`, `hooks/review-injector.js` → rewired to use `adapters/claude-code/event.js` + `adapters/claude-code/transcript.js` + `core/*`.

**Modified — `plugins/concord/commands/review-until-green.md`** (Task 7): split into neutral driver prose + an included Claude Code spawn-fragment.

**New — test files** mirror the moved units under `plugins/concord/hooks/test/` (the suite dir stays; requires update to new paths).

---

## Task 1: Port contract + `NeutralEntry` normalizer

**Files:**
- Create: `plugins/concord/core/ports.js`
- Test: `plugins/concord/hooks/test/ports.test.js`

**Interfaces:**
- Produces: `PORT_NAMES: string[]`; `normalizeEntry(raw) -> NeutralEntry` (fills `text:''`, `toolCalls:[]` defaults; throws on missing/invalid `role`).

- [ ] **Step 1: Write the failing test**

```js
// plugins/concord/hooks/test/ports.test.js
const test = require('node:test');
const assert = require('node:assert');
const { PORT_NAMES, normalizeEntry } = require('../../core/ports');

test('PORT_NAMES lists the five seams', () => {
  assert.deepStrictEqual(
    [...PORT_NAMES].sort(),
    ['command', 'lifecycle', 'reviewer', 'statedir', 'transcript']
  );
});

test('normalizeEntry fills defaults and preserves fields', () => {
  assert.deepStrictEqual(
    normalizeEntry({ role: 'assistant', text: 'hi', toolCalls: [{ name: 'Read', input: { file_path: '/a' } }] }),
    { role: 'assistant', text: 'hi', toolCalls: [{ name: 'Read', input: { file_path: '/a' } }] }
  );
  assert.deepStrictEqual(normalizeEntry({ role: 'user' }), { role: 'user', text: '', toolCalls: [] });
});

test('normalizeEntry rejects a bad role', () => {
  assert.throws(() => normalizeEntry({ role: 'system', text: 'x' }), /role/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/concord/hooks/test/ports.test.js`
Expected: FAIL — `Cannot find module '../../core/ports'`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/concord/core/ports.js
'use strict';

// The five harness seams every adapter implements. See
// docs/superpowers/specs/2026-07-16-vendor-agnostic-harness-adapter-design.md.
const PORT_NAMES = ['lifecycle', 'transcript', 'reviewer', 'command', 'statedir'];

/**
 * @typedef {{ role: 'user'|'assistant', text: string, toolCalls: Array<{name:string,input:object}> }} NeutralEntry
 * @typedef {{ sessionId: string, transcriptPath: string, lastAssistantMessage?: string, source: 'startup'|'resume'|'compact'|'stop' }} NeutralEvent
 */

// Coerce a raw entry into the canonical NeutralEntry shape.
function normalizeEntry(raw) {
  const role = raw && raw.role;
  if (role !== 'user' && role !== 'assistant') {
    throw new Error(`normalizeEntry: invalid role ${JSON.stringify(role)}`);
  }
  return {
    role,
    text: typeof raw.text === 'string' ? raw.text : '',
    toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls : [],
  };
}

module.exports = { PORT_NAMES, normalizeEntry };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/concord/hooks/test/ports.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/core/ports.js plugins/concord/hooks/test/ports.test.js
git commit -m "feat(harness): port contract + NeutralEntry normalizer"
```

---

## Task 2: Claude Code transcript adapter (`mapEntries` + moved `readDelta`)

Moves `hooks/lib/transcript.js` to the adapter and adds the Claude message-shape → `NeutralEntry` mapping that currently lives inside `extract.js`/`charter.js`.

**Files:**
- Create: `plugins/concord/adapters/claude-code/transcript.js` (git-moved body of `hooks/lib/transcript.js` + new `mapEntries`)
- Delete: `plugins/concord/hooks/lib/transcript.js`
- Modify: `plugins/concord/hooks/test/transcript.test.js` (update require path)
- Test: `plugins/concord/hooks/test/cc-mapentries.test.js`

**Interfaces:**
- Consumes: `normalizeEntry` from `core/ports`.
- Produces: `readDelta(transcriptPath, offset) -> { entries, newOffset }` (unchanged; `entries` are raw Claude JSONL objects); `mapEntries(rawEntries) -> NeutralEntry[]`; `parseDelta(transcriptPath, offset) -> { entries: NeutralEntry[], newOffset }` (composes the two).

- [ ] **Step 1: Move the file and update its test's require**

```bash
git mv plugins/concord/hooks/lib/transcript.js plugins/concord/adapters/claude-code/transcript.js
```

In `plugins/concord/hooks/test/transcript.test.js`, change:
`require('../lib/transcript')` → `require('../../adapters/claude-code/transcript')`

- [ ] **Step 2: Run the moved test to confirm the move is clean**

Run: `node --test plugins/concord/hooks/test/transcript.test.js`
Expected: PASS (unchanged behavior; only the path moved).

- [ ] **Step 3: Write the failing test for `mapEntries`**

```js
// plugins/concord/hooks/test/cc-mapentries.test.js
const test = require('node:test');
const assert = require('node:assert');
const { mapEntries } = require('../../adapters/claude-code/transcript');

test('mapEntries lifts assistant text + tool calls into NeutralEntry', () => {
  const raw = [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'DECISION: use X' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
  ];
  assert.deepStrictEqual(mapEntries(raw), [
    { role: 'assistant', text: 'DECISION: use X', toolCalls: [{ name: 'Read', input: { file_path: '/a.js' } }] },
    { role: 'user', text: 'do it', toolCalls: [] },
  ]);
});

test('mapEntries skips entries with no message', () => {
  assert.deepStrictEqual(mapEntries([{ type: 'system' }, {}]), []);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `node --test plugins/concord/hooks/test/cc-mapentries.test.js`
Expected: FAIL — `mapEntries is not a function`.

- [ ] **Step 5: Add `mapEntries` + `parseDelta` to the adapter**

Append to `plugins/concord/adapters/claude-code/transcript.js` (before `module.exports`), and extend the exports. This is the Claude message-shape knowledge, relocated from `extract.js`/`charter.js`:

```js
const { normalizeEntry } = require('../../core/ports');

// Claude Code transcript entry -> NeutralEntry. Concatenates text items,
// collects tool_use items as toolCalls. Entries without a message are dropped.
function mapEntries(rawEntries) {
  const out = [];
  for (const e of rawEntries || []) {
    const msg = e && e.message;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    let text = '';
    const toolCalls = [];
    for (const item of content) {
      if (!item) continue;
      if (item.type === 'text' && typeof item.text === 'string') text += (text ? '\n' : '') + item.text;
      else if (item.type === 'tool_use') toolCalls.push({ name: item.name, input: item.input || {} });
    }
    out.push(normalizeEntry({ role: msg.role, text, toolCalls }));
  }
  return out;
}

function parseDelta(transcriptPath, offset) {
  const { entries, newOffset } = readDelta(transcriptPath, offset);
  return { entries: mapEntries(entries), newOffset };
}
```

Update the module exports line to add `mapEntries` and `parseDelta`.

- [ ] **Step 6: Run both tests**

Run: `node --test plugins/concord/hooks/test/transcript.test.js plugins/concord/hooks/test/cc-mapentries.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/concord/adapters/claude-code/transcript.js plugins/concord/hooks/test/transcript.test.js plugins/concord/hooks/test/cc-mapentries.test.js
git rm --cached plugins/concord/hooks/lib/transcript.js 2>/dev/null; git add -A plugins/concord/hooks/lib
git commit -m "feat(harness): claude-code transcript adapter with NeutralEntry mapping"
```

---

## Task 3: Move `extract.js` to core, operating on `NeutralEntry[]`

Removes the Claude message-shape parsing from `extract.js` (now the adapter's job) so it consumes `NeutralEntry[]`.

**Files:**
- Create: `plugins/concord/core/extract.js` (git-moved + refactored)
- Delete: `plugins/concord/hooks/lib/extract.js`
- Modify: `plugins/concord/hooks/test/extract.test.js` (require path + feed NeutralEntry)

**Interfaces:**
- Consumes: `core/config` constants.
- Produces (signatures unchanged, input type changes to `NeutralEntry[]`): `extractFacts(entries) -> string[]`, `extractRationale(entries) -> {decisions,openLoops,nexts,resolved}`, `extractRationaleText(text) -> {...}`.

- [ ] **Step 1: Move the file**

```bash
git mv plugins/concord/hooks/lib/extract.js plugins/concord/core/extract.js
```

- [ ] **Step 2: Refactor `extract.js` to read `NeutralEntry[]`**

Replace the `assistantItems` helper and the two extractors' loops. New body (config require path updates to `./config` — same dir):

```js
'use strict';
const { TAG_RE, MEANINGFUL_BASH_RE } = require('./config');

// extractFacts now reads NeutralEntry.toolCalls instead of raw assistant items.
function extractFacts(entries) {
  const facts = [];
  for (const e of entries || []) {
    if (!e || e.role !== 'assistant') continue;
    for (const call of e.toolCalls || []) {
      // ... PRESERVE the existing per-tool logic verbatim, but read `call.name`
      // and `call.input` instead of `item.name`/`item.input`. (Read/Edit/Write
      // -> file_path; Bash -> MEANINGFUL_BASH_RE over command.)
    }
  }
  return facts;
}

function harvestTags(text, acc) { /* unchanged */ }
function emptyRationale() { /* unchanged */ }

// extractRationale now reads NeutralEntry.text instead of assistant text items.
function extractRationale(entries) {
  const acc = emptyRationale();
  for (const e of entries || []) {
    if (!e || e.role !== 'assistant' || typeof e.text !== 'string') continue;
    harvestTags(e.text, acc);
  }
  return acc;
}

function extractRationaleText(text) { /* unchanged */ }

module.exports = { extractFacts, extractRationale, extractRationaleText };
```

The implementer copies the existing `harvestTags`, `emptyRationale`, `extractRationaleText`, and the per-tool fact logic verbatim from git history (`git show HEAD~1:plugins/concord/hooks/lib/extract.js`), changing only the two loop headers shown above.

- [ ] **Step 3: Update `extract.test.js`**

Change `require('../lib/extract')` → `require('../../core/extract')`. Change the test's input fixtures from raw Claude entries to `NeutralEntry[]` — e.g. a fact-extraction case becomes:
```js
extractFacts([{ role: 'assistant', text: '', toolCalls: [{ name: 'Read', input: { file_path: '/x.js' } }] }])
```
Keep every assertion's expected value identical.

- [ ] **Step 4: Run the test**

Run: `node --test plugins/concord/hooks/test/extract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/core/extract.js plugins/concord/hooks/test/extract.test.js plugins/concord/hooks/lib
git commit -m "refactor(harness): extract.js reads NeutralEntry, moves to core"
```

---

## Task 4: Move `charter.js` to core; push transcript reading + user-message parsing to the adapter

`charter.js` currently requires `./transcript` (adapter now) and parses `msg.role === 'user'` shape in `firstSubstantiveUserMessage`. Both are Claude-Code concerns. The neutral `charter.js` receives already-parsed `NeutralEntry[]`; callers (the writer hook) supply them via the adapter.

**Files:**
- Create: `plugins/concord/core/charter.js` (git-moved + refactored)
- Delete: `plugins/concord/hooks/lib/charter.js`
- Modify: `plugins/concord/hooks/test/charter.test.js` (require path + feed NeutralEntry)

**Interfaces:**
- Consumes: `core/config`, `core/state`, `core/extract`.
- Produces: `firstSubstantiveUserMessage(entries: NeutralEntry[]) -> string|null`; `readNorthStar`, `writeNorthStarIfAbsent`, `mergeSessions`, `renderCharter`, `catchUpSessions`, `mergeModel`, `emptyModel` (all unchanged); **removes** the `require('./transcript')` and the internal `readDelta` call — the writer hook (Task 6) now reads the transcript via the adapter and passes entries in.

- [ ] **Step 1: Move the file**

```bash
git mv plugins/concord/hooks/lib/charter.js plugins/concord/core/charter.js
```

- [ ] **Step 2: Refactor**

- Delete line `const { readDelta } = require('./transcript');`.
- Update remaining requires to same-dir: `require('./config')`, `require('./state')`, `require('./extract')`.
- In `firstSubstantiveUserMessage(entries)`: entries are now `NeutralEntry[]`, so replace the `(e && e.message) || {}` / `msg.role` / `messageText(msg.content)` logic with direct `e.role === 'user'` and `e.text`. Delete the now-unused `messageText` helper if nothing else uses it (grep first).
- If any function here called `readDelta` internally, remove it — the caller passes entries.

The implementer pulls the verbatim bodies from `git show HEAD~1:plugins/concord/hooks/lib/charter.js` and changes only the transcript-touching pieces above.

- [ ] **Step 3: Update `charter.test.js`**

Change `require('../lib/charter')` → `require('../../core/charter')`. Any test feeding raw entries to `firstSubstantiveUserMessage` now feeds `NeutralEntry[]`. Keep expected values identical.

- [ ] **Step 4: Run the test**

Run: `node --test plugins/concord/hooks/test/charter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/core/charter.js plugins/concord/hooks/test/charter.test.js plugins/concord/hooks/lib
git commit -m "refactor(harness): charter.js reads NeutralEntry, moves to core"
```

---

## Task 5: Move the remaining neutral libs + `statedir` to their layers

Pure-logic libs move to `core/`; `statedir.js` (reads `CLAUDE_CONFIG_DIR`) moves to the adapter. Import-path updates only — no logic change.

**Files:**
- `git mv` to `core/`: `config.js`, `state.js`, `gate.js`, `gate-panel.js`, `gate-contract.js`, `intent.js`, `dod-exec.js`, `review.js` (from `hooks/lib/`).
- `git mv plugins/concord/hooks/lib/statedir.js plugins/concord/adapters/claude-code/statedir.js`.
- Modify: every moved file's internal `require('./x')` stays valid **only if its dependency moved to the same dir**. `review.js` requires `./config` + `./gate-panel` (both → core, OK). `state.js`, `gate-panel.js` require `./config`/`./gate` (both → core, OK). No cross-layer requires remain in `core/`.
- Modify each corresponding test's require path (`../lib/X` → `../../core/X`, and `statedir` → `../../adapters/claude-code/statedir`).

**Interfaces:**
- Produces: same exports as before at new paths. No signature changes.

- [ ] **Step 1: Move the neutral libs to core**

```bash
cd plugins/concord/hooks/lib
git mv config.js state.js gate.js gate-panel.js gate-contract.js intent.js dod-exec.js review.js ../../core/
cd -
git mv plugins/concord/adapters/../hooks/lib/statedir.js plugins/concord/adapters/claude-code/statedir.js
```

- [ ] **Step 2: Update test require paths**

In each of `test/state.test.js`, `test/review.test.js`, `test/config.test.js`, `test/gate.test.js`, `test/gate-panel.test.js`, `test/gate-contract.test.js`, `test/intent.test.js`, `test/dod-exec.test.js`: replace `require('../lib/<name>')` with `require('../../core/<name>')`. In `test/statedir.test.js`: `require('../lib/statedir')` → `require('../../adapters/claude-code/statedir')`.

- [ ] **Step 3: Grep for any missed intra-lib requires**

Run: `grep -rn "require('\.\./lib/" plugins/concord`
Expected: only matches inside the still-unmoved hook entrypoints (`hooks/*.js`, handled in Task 6). No matches inside `core/` or `adapters/`.

- [ ] **Step 4: Run the full moved-unit suite**

Run: `node --test plugins/concord/hooks/test/state.test.js plugins/concord/hooks/test/review.test.js plugins/concord/hooks/test/config.test.js plugins/concord/hooks/test/gate.test.js plugins/concord/hooks/test/gate-panel.test.js plugins/concord/hooks/test/gate-contract.test.js plugins/concord/hooks/test/intent.test.js plugins/concord/hooks/test/dod-exec.test.js plugins/concord/hooks/test/statedir.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add -A plugins/concord/core plugins/concord/adapters/claude-code/statedir.js plugins/concord/hooks/lib plugins/concord/hooks/test
git commit -m "refactor(harness): move neutral libs to core, statedir to adapter"
```

---

## Task 6: Rewire the hook + CLI entrypoints as thin packaging shims

The five entrypoints under `hooks/` keep their manifest-referenced paths but now require into `core/` + `adapters/claude-code/`. `review-cli.js`/`charter-cli.js` logic moves to `core/`; a shim stays at the old path. The three lifecycle hooks use the new `adapters/claude-code/event.js` + `parseDelta`.

**Files:**
- `git mv plugins/concord/hooks/review-cli.js plugins/concord/core/review-cli.js`; create shim `hooks/review-cli.js`.
- `git mv plugins/concord/hooks/charter-cli.js plugins/concord/core/charter-cli.js`; create shim `hooks/charter-cli.js`.
- Create: `plugins/concord/adapters/claude-code/event.js`.
- Modify: `hooks/session-state-writer.js`, `hooks/session-state-injector.js`, `hooks/review-injector.js`.
- Modify: `test/review-cli.test.js` (`require('../review-cli')` → still works via shim, or point to `../../core/review-cli`), `test/writer.test.js`, `test/injector.test.js`, `test/review-injector.test.js`, `test/charter-cli.test.js` — update paths as needed.

**Interfaces:**
- Produces: `readStdinEvent() -> NeutralEvent` (adapter). Entrypoints unchanged externally (same stdin contract, same stdout).

- [ ] **Step 1: Move the two CLIs to core and update their internal requires**

```bash
git mv plugins/concord/hooks/review-cli.js plugins/concord/core/review-cli.js
git mv plugins/concord/hooks/charter-cli.js plugins/concord/core/charter-cli.js
```
In each, change `require('./lib/X')` → `require('./X')` (now same-dir in core). Grep to confirm none remain: `grep -n "require('./lib/" plugins/concord/core/review-cli.js plugins/concord/core/charter-cli.js` → no output.

- [ ] **Step 2: Create the shims at the manifest paths**

```js
// plugins/concord/hooks/review-cli.js
'use strict';
require('../core/review-cli.js');
```
```js
// plugins/concord/hooks/charter-cli.js
'use strict';
require('../core/charter-cli.js');
```
(If `charter-cli.js`/`review-cli.js` export functions used by tests rather than running on require, use `module.exports = require('../core/<name>.js')` instead. Check the file's tail: if it ends with a `main()` self-invocation guarded by `require.main === module`, the shim must instead `require` and invoke — verify the existing guard and mirror it.)

- [ ] **Step 3: Write the failing test for `event.js`**

```js
// plugins/concord/hooks/test/cc-event.test.js
const test = require('node:test');
const assert = require('node:assert');
const { toNeutralEvent } = require('../../adapters/claude-code/event');

test('toNeutralEvent maps Claude Stop payload', () => {
  assert.deepStrictEqual(
    toNeutralEvent({ session_id: 's1', transcript_path: '/t.jsonl', last_assistant_message: 'hi' }, 'stop'),
    { sessionId: 's1', transcriptPath: '/t.jsonl', lastAssistantMessage: 'hi', source: 'stop' }
  );
});

test('toNeutralEvent maps SessionStart source through', () => {
  const ev = toNeutralEvent({ session_id: 's2', transcript_path: '/t.jsonl', source: 'resume' }, 'resume');
  assert.strictEqual(ev.source, 'resume');
  assert.strictEqual(ev.sessionId, 's2');
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `node --test plugins/concord/hooks/test/cc-event.test.js`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `event.js`**

```js
// plugins/concord/adapters/claude-code/event.js
'use strict';
const fs = require('node:fs');

// Claude Code hook stdin payload -> NeutralEvent. `source` is the caller's
// classification (the hook that fired); Stop -> 'stop', SessionStart passes
// through the payload's own source (startup|resume|compact).
function toNeutralEvent(payload, source) {
  const p = payload || {};
  const ev = {
    sessionId: String(p.session_id || ''),
    transcriptPath: p.transcript_path || '',
    source: source || p.source,
  };
  if (typeof p.last_assistant_message === 'string') ev.lastAssistantMessage = p.last_assistant_message;
  return ev;
}

function readStdinEvent(source) {
  return toNeutralEvent(JSON.parse(fs.readFileSync(0, 'utf8')), source);
}

module.exports = { toNeutralEvent, readStdinEvent };
```

- [ ] **Step 6: Rewire the three lifecycle hooks**

In `hooks/session-state-writer.js`: replace the inline `JSON.parse(fs.readFileSync(0,...))` + destructure with `const { sessionId, transcriptPath, lastAssistantMessage } = require('../adapters/claude-code/event').readStdinEvent('stop');` (keep the early-return guard on missing `sessionId`/`transcriptPath`). Replace `require('./lib/transcript').readDelta` with `require('../adapters/claude-code/transcript').parseDelta` (returns `NeutralEntry[]` — `extractFacts`/`extractRationale` now expect that). Replace `require('./lib/extract')` → `require('../core/extract')`, `require('./lib/state')` → `require('../core/state')`, `require('./lib/charter')` → `require('../core/charter')`. For the north-star draft path, pass `parseDelta(transcriptPath, 0).entries` into `firstSubstantiveUserMessage`.

In `hooks/session-state-injector.js`: swap `require('./lib/charter')` → `require('../core/charter')`; read the event via `require('../adapters/claude-code/event').readStdinEvent(<source-from-payload>)` — note this hook needs the payload's own `source`, so call `readStdinEvent()` without overriding and let `toNeutralEvent` fall back to `p.source`.

In `hooks/review-injector.js`: swap `require('./lib/statedir')` → `require('../adapters/claude-code/statedir')`, `require('./lib/review')` → `require('../core/review')`, and read `transcriptPath` via the event adapter.

- [ ] **Step 7: Update entrypoint test require paths**

`test/review-cli.test.js`: if it does `require('../review-cli')`, the shim keeps it valid; if it asserts on exported functions, point it at `../../core/review-cli`. `test/charter-cli.test.js`: likewise. `test/writer.test.js`, `test/injector.test.js`, `test/review-injector.test.js`: these invoke the hooks as child processes via stdin (check how) — if they spawn `node hooks/session-state-writer.js`, no path change needed; if they `require` lib internals, update to core/adapter paths.

- [ ] **Step 8: Run the full suite**

Run: `node --test` (from repo root)
Expected: PASS — entire suite, including all pre-existing tests.

- [ ] **Step 9: Commit**

```bash
git add -A plugins/concord
git commit -m "refactor(harness): thin CC entrypoint shims over core + adapter"
```

---

## Task 7: Split `review-until-green.md` into neutral driver + CC spawn-include

The command prose keeps its Claude Code behavior but factors the subagent-spawn mechanics into a clearly delimited, replaceable fragment, so a future Codex packaging composes a different include over the same driver.

**Files:**
- Create: `plugins/concord/core/review-driver.md` (neutral loop prose — CLI verbs, artifact paths, ordering rules; references "a reviewer subagent" abstractly).
- Create: `plugins/concord/adapters/claude-code/spawn-include.md` (the Claude Code specifics: "Task tool, general-purpose, clean context; parallel calls in one message run concurrently").
- Modify: `plugins/concord/commands/review-until-green.md` — becomes the composed Claude Code command: the driver prose with the CC include spliced into each spawn instruction (or an explicit "spawn mechanism" section referenced throughout).

**Interfaces:** documentation only. Acceptance is a human read-through + the guard test in Task 8 (no `Task tool` string in `core/review-driver.md`).

- [ ] **Step 1: Extract the neutral driver**

Copy the current `review-until-green.md` body into `core/review-driver.md`. Replace every concrete spawn phrase ("spawn ONE correctness review subagent (Task tool, general-purpose, a CLEAN context...)") with an abstract reference: "spawn ONE correctness review subagent per the harness spawn-include (clean context)". Do this for correctness, verify, intent, gate-review, gate-verify, the 5-lens panel, and the 3-way adversarial verify. Leave all CLI verbs, artifact filenames, and ordering/"wait for the file" rules verbatim.

- [ ] **Step 2: Write the CC spawn-include**

```markdown
<!-- plugins/concord/adapters/claude-code/spawn-include.md -->
**Claude Code spawn mechanism.** Spawn each reviewer subagent with the `Task`
tool, `general-purpose` agent, in a CLEAN context (do not paste prior reasoning).
Parallel spawns issued as multiple tool calls in one message run concurrently;
sequential dependencies ("wait for the file") mean issue the dependent Task only
after the prior subagent's artifact exists.
```

- [ ] **Step 3: Compose the Claude Code command**

Rewrite `commands/review-until-green.md` as: front-matter (unchanged) + a line pulling in the driver + the CC spawn mechanism section, so the installed command reads exactly as today's behavior. Since Claude Code commands are single self-contained markdown files (no include directive), the composition is literal: paste the `core/review-driver.md` body and the `spawn-include.md` content into one file at build/author time, and add a comment at the top noting it is generated from those two sources.

- [ ] **Step 4: Human verification**

Read the composed `commands/review-until-green.md` end to end. Confirm it instructs the same spawns, verbs, and ordering as the pre-split version (diff against `git show HEAD~6:plugins/concord/commands/review-until-green.md`). No test asserts prose; this step is the gate.

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/core/review-driver.md plugins/concord/adapters/claude-code/spawn-include.md plugins/concord/commands/review-until-green.md
git commit -m "refactor(harness): split review command into neutral driver + CC spawn-include"
```

---

## Task 8: Neutrality guard test

Mechanically enforces Global Constraint "`core/` is vendor-clean" so no future edit re-couples the core.

**Files:**
- Test: `plugins/concord/hooks/test/neutrality-guard.test.js`

- [ ] **Step 1: Write the test**

```js
// plugins/concord/hooks/test/neutrality-guard.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', '..', 'core');
const BANNED = ['CLAUDE_', 'transcript_path', 'session_id', 'last_assistant_message', 'Task tool'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

test('no file under core/ contains a vendor symbol', () => {
  const offenders = [];
  for (const file of walk(CORE)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const sym of BANNED) {
      if (text.includes(sym)) offenders.push(`${path.relative(CORE, file)}: ${sym}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `core/ must be vendor-clean; found: ${offenders.join(', ')}`);
});
```

- [ ] **Step 2: Run it**

Run: `node --test plugins/concord/hooks/test/neutrality-guard.test.js`
Expected: PASS. If it FAILS, the named file/symbol is a real re-coupling — move that concern to `adapters/claude-code/` before proceeding.

- [ ] **Step 3: Commit**

```bash
git add plugins/concord/hooks/test/neutrality-guard.test.js
git commit -m "test(harness): guard that core/ stays vendor-clean"
```

---

## Task 9: Codex adapter stub + GAPS

Documents the Codex mapping for each port without implementing a runtime, per the first-deliverable scope.

**Files:**
- Create: `plugins/concord/adapters/codex/README.md`
- Create: `plugins/concord/adapters/codex/GAPS.md`

- [ ] **Step 1: Write the port-mapping README**

A table mapping each of the five `PORT_NAMES` to its Codex CLI counterpart: `lifecycle` → Codex session-lifecycle hook payload; `transcript` → Codex transcript format + a `mapEntries` to write; `reviewer` → `codex exec <prompt>` (subprocess, not a Task tool); `command` → Codex prompt/command format; `statedir` → `~/.codex`-rooted path + its injection mechanism. Mark each "documented, not implemented".

- [ ] **Step 2: Write GAPS.md**

Record the blocker and degradations found during design: no native parallel clean-context subagent on Codex CLI → a fan-out (5-lens panel, 3-way adversarial verify) degrades to serial or process-parallel `codex exec` calls; the `reviewer` spawn-include is where that policy lives; the Codex install-model choice ((i) native `~/.codex` plugin vs (ii) CC-plugin-shells-out) is open and the seam targets (i).

- [ ] **Step 3: Commit**

```bash
git add plugins/concord/adapters/codex
git commit -m "docs(harness): codex adapter stub + GAPS"
```

---

## Task 10: Full-suite regression + version bump

**Files:**
- Modify: `plugins/concord/.claude-plugin/plugin.json` (version bump, e.g. `0.8.0-alpha.2` → `0.9.0-alpha.1`).

- [ ] **Step 1: Run the entire suite from the repo root**

Run: `node --test`
Expected: PASS — every pre-existing test plus the new `ports`, `cc-mapentries`, `cc-event`, and `neutrality-guard` tests. Zero failures.

- [ ] **Step 2: Sanity-drive the plugin once**

Run: `node plugins/concord/hooks/review-cli.js` with no args (or `--help` if supported) and confirm it behaves as before the move (loads through the shim, prints its usage/known output). Then confirm `hooks/charter-cli.js show` still runs through its shim.

- [ ] **Step 3: Bump the version and commit**

```bash
git add plugins/concord/.claude-plugin/plugin.json
git commit -m "chore(harness): bump to 0.9.0-alpha.1 -- vendor-agnostic core + CC adapter"
```

---

## Self-Review notes

- **Spec coverage:** every spec section maps to a task — audit/architecture → Tasks 2–6 file moves; five ports → ports.js (T1) + transcript (T2) + event (T6) + statedir (T5) + reviewer/spawn-include (T7) + command packaging (T6/T7); first-deliverable items 1–6 → T2–T9; verification (existing suite green, neutrality guard, port-shape) → T2/T6 (port-shape via cc-mapentries/cc-event fixtures) + T8 + T10; Codex stub → T9; compatibility → shims (T6) + frozen manifest paths (Global Constraints).
- **`NeutralEntry` note:** the plan extends the doc's `{role,text}` with `toolCalls`; the design doc should get a one-line amendment to match (author's call — noted, not silently divergent).
- **Type consistency:** `parseDelta`/`mapEntries`/`normalizeEntry`/`toNeutralEvent`/`readStdinEvent`/`firstSubstantiveUserMessage(entries)` names are used identically across Tasks 1–6.
