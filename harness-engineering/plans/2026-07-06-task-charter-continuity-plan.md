# Task Charter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the concord `session-state` plugin so a project's founding task framing (a "north star") plus fork decisions survive across session boundaries and re-inject on resume/compaction/fresh-start, concurrent-safely.

**Architecture:** Reuse the existing per-session `<sid>.json` model (already per-session-owned = concurrent-safe) as the decision store. Add a project-level `charter.md` north-star (create-if-absent auto-draft + `/charter` overwrite). Replace the last-writer-wins `_latest.md` fresh-start injection with a recency-gated merge-on-read that unions all recent sessions' models. Add a durability all-scan that catches up any session's un-watermarked transcript tail on the next SessionStart. One injector, extended — no second injector, no separate PreCompact hook (the existing `SessionStart` matcher already covers compaction).

**Tech Stack:** Node.js built-ins only (`node:fs`, `node:path`, `node:os`). Tests: `node:test` + `node:assert`. No third-party dependencies, no `package.json`.

## Global Constraints

- Node built-in modules ONLY — no npm dependencies, no `package.json`.
- Every hook entrypoint wraps `main()` in try/catch and ends `process.exit(0)` — a hook must NEVER block or fail the turn.
- All runtime paths derive from `transcript_path` (hooks) or `process.cwd()` slug / `CHARTER_STATE_DIR` env (CLI) — no hard-coded absolute paths, project-agnostic.
- Concurrent-safety invariant: a process writes only its OWN session's `<sid>.json`, EXCEPT the durability all-scan, which skips any session whose transcript was modified within `ACTIVE_SKIP_MINUTES` and skips the current session (avoids racing a live writer).
- Source, comments, identifiers: English only.
- Code style matches the existing plugin: `'use strict';`, 2-space indent, CommonJS `require`/`module.exports`, small focused files.
- Working directory for all commands: the plugin dir `plugins/session-state/` inside the concord repo. Test command form: `node --test hooks/test/<file>.test.js`.
- Reused, already-exported helpers (do NOT reimplement): `state.js` exports `emptyModel`, `topicKey`, `mergeModel`, `renderMarkdown`; `transcript.js` exports `readDelta`; `extract.js` exports `extractFacts`, `extractRationale`, `extractRationaleText`; `config.js` exports the caps + `TAG_RE` + `MEANINGFUL_BASH_RE`.

---

### Task 1: Charter config constants + north-star read/write

**Files:**
- Modify: `hooks/lib/config.js`
- Create: `hooks/lib/charter.js`
- Test: `hooks/test/charter.test.js`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces: `charter.js` exports (this task adds) `charterPath(stateDir)`, `readNorthStar(stateDir): string|null`, `writeNorthStarIfAbsent(stateDir, text): boolean`, `setNorthStar(stateDir, text): void`. `config.js` adds `SESSIONS_MERGE_CAP`, `ACTIVE_SKIP_MINUTES`, `MIN_MSG_LEN`, `NORTH_STAR_MAX`.

- [ ] **Step 1: Add config constants**

In `hooks/lib/config.js`, add these keys to the exported object (place after `NEXTS_CAP`):

```js
  SESSIONS_MERGE_CAP: 25, // merge-on-read unions at most this many most-recent sessions
  ACTIVE_SKIP_MINUTES: 5, // durability all-scan skips a session whose transcript changed this recently
  MIN_MSG_LEN: 12,        // a user message shorter than this is not a substantive framing
  NORTH_STAR_MAX: 4000,   // cap north-star length written to charter.md
```

- [ ] **Step 2: Write the failing test**

Create `hooks/test/charter.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const charter = require('../lib/charter');

function tmpStateDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-'));
  return d;
}

test('north-star: writeIfAbsent creates when absent, refuses when present (CS1 guard)', () => {
  const dir = tmpStateDir();
  assert.strictEqual(charter.readNorthStar(dir), null);
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'draft framing'), true);
  assert.strictEqual(charter.readNorthStar(dir), 'draft framing');
  // second writer (parallel fresh session) must NOT clobber
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'other draft'), false);
  assert.strictEqual(charter.readNorthStar(dir), 'draft framing');
});

test('north-star: setNorthStar overwrites', () => {
  const dir = tmpStateDir();
  charter.writeNorthStarIfAbsent(dir, 'draft');
  charter.setNorthStar(dir, 'the real crystallized framing');
  assert.strictEqual(charter.readNorthStar(dir), 'the real crystallized framing');
});

test('north-star: empty/whitespace file counts as absent', () => {
  const dir = tmpStateDir();
  fs.writeFileSync(charter.charterPath(dir), '   \n');
  assert.strictEqual(charter.readNorthStar(dir), null);
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'framing'), true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test hooks/test/charter.test.js`
Expected: FAIL — `Cannot find module '../lib/charter'`.

- [ ] **Step 4: Write minimal implementation**

Create `hooks/lib/charter.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { NORTH_STAR_MAX } = require('./config');

function charterPath(stateDir) {
  return path.join(stateDir, 'charter.md');
}

// Returns the north-star text, or null if the file is absent/empty.
function readNorthStar(stateDir) {
  try {
    const t = fs.readFileSync(charterPath(stateDir), 'utf8').trim();
    return t ? t : null;
  } catch (e) {
    return null;
  }
}

// Write the draft ONLY if no non-empty north-star exists (first-writer-wins).
// Returns whether it wrote. Parallel fresh sessions cannot clobber each other.
function writeNorthStarIfAbsent(stateDir, text) {
  if (readNorthStar(stateDir) !== null) return false;
  const body = String(text || '').trim();
  if (!body) return false;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(charterPath(stateDir), body.slice(0, NORTH_STAR_MAX));
  return true;
}

// Deliberate overwrite (from the /charter command). LWW is safe here: rare, user-driven.
function setNorthStar(stateDir, text) {
  const body = String(text || '').trim();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(charterPath(stateDir), body.slice(0, NORTH_STAR_MAX));
}

module.exports = { charterPath, readNorthStar, writeNorthStarIfAbsent, setNorthStar };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test hooks/test/charter.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/config.js hooks/lib/charter.js hooks/test/charter.test.js
git commit -m "feat(charter): north-star read/write with first-writer-wins guard"
```

---

### Task 2: First substantive user message extractor (boilerplate filter)

**Files:**
- Modify: `hooks/lib/charter.js`
- Test: `hooks/test/charter.test.js`

**Interfaces:**
- Consumes: `MIN_MSG_LEN` from config.
- Produces: `charter.js` adds `firstSubstantiveUserMessage(entries): string|null`.

- [ ] **Step 1: Write the failing test**

Append to `hooks/test/charter.test.js`:

```js
test('firstSubstantiveUserMessage: skips boilerplate, returns first real user message', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: '<system-reminder>hi</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: 'Base directory for this skill: /x/y' } },
    { type: 'user', message: { role: 'user', content: 'Caveat: local command output below' } },
    { type: 'user', message: { role: 'user', content: 'ok' } }, // too short
    { type: 'user', message: { role: 'user', content: 'Start the D-track charter work: preserve founding context.' } },
    { type: 'user', message: { role: 'user', content: 'a later message' } },
  ];
  assert.strictEqual(
    charter.firstSubstantiveUserMessage(entries),
    'Start the D-track charter work: preserve founding context.'
  );
});

test('firstSubstantiveUserMessage: array content, all-boilerplate returns null', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'CAVEMAN MODE ACTIVE (lite)' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'SessionStart hook fired' }] } },
  ];
  assert.strictEqual(charter.firstSubstantiveUserMessage(entries), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/charter.test.js`
Expected: FAIL — `charter.firstSubstantiveUserMessage is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `hooks/lib/charter.js`, add `const { MIN_MSG_LEN } = require('./config');` (merge with the existing config require) and:

```js
// Substrings/prefixes that mark harness-injected or tooling text, not user framing.
// Harness-fragile by nature: extend as new injection wrappers appear.
const BOILERPLATE = [
  'base directory for this skill',
  'caveat:',
  'plugins/cache',
  'sessionstart',
  'userpromptsubmit hook',
  'local-command',
  'caveman mode',
  '<system-reminder',
  '<command-',
  '<local-command',
];

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function isBoilerplate(text) {
  const low = text.trim().toLowerCase();
  if (low.startsWith('<')) return true;
  return BOILERPLATE.some((p) => low.includes(p));
}

// The first user message that is real framing, not harness/tooling boilerplate.
function firstSubstantiveUserMessage(entries) {
  for (const e of entries) {
    const msg = (e && e.message) || {};
    if (msg.role !== 'user') continue;
    const text = messageText(msg.content).trim();
    if (text.length < MIN_MSG_LEN) continue;
    if (isBoilerplate(text)) continue;
    return text;
  }
  return null;
}
```

Add `firstSubstantiveUserMessage` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/charter.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/charter.js hooks/test/charter.test.js
git commit -m "feat(charter): first-substantive-user-message extractor with boilerplate filter"
```

---

### Task 3: Merge-on-read — recency-gated union of session models

**Files:**
- Modify: `hooks/lib/charter.js`
- Test: `hooks/test/charter.test.js`

**Interfaces:**
- Consumes: `mergeModel`, `emptyModel` from `state.js`; `SESSIONS_MERGE_CAP` from config.
- Produces: `charter.js` adds `mergeSessions(stateDir, { excludeSid } = {}): model` where model is `{ openLoops, decisions, nexts, facts, offset }`.

- [ ] **Step 1: Write the failing test**

Append to `hooks/test/charter.test.js`:

```js
function writeSessionModel(dir, sid, model, mtimeMs) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sid}.json`);
  fs.writeFileSync(p, JSON.stringify(model));
  if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}

test('mergeSessions: unions decisions/openLoops across sessions, newest wins per topic', () => {
  const dir = tmpStateDir();
  writeSessionModel(dir, 'sessA', { openLoops: ['loop-a'], decisions: ['[scope] old scope'], nexts: [], facts: [] }, Date.now() - 20000);
  writeSessionModel(dir, 'sessB', { openLoops: ['loop-b'], decisions: ['[scope] new scope', '[trigger] use compact'], nexts: ['ship v1'], facts: [] }, Date.now() - 10000);
  const m = charter.mergeSessions(dir);
  assert.ok(m.openLoops.includes('loop-a') && m.openLoops.includes('loop-b'));
  assert.ok(m.decisions.includes('[scope] new scope')); // newest topic wins
  assert.ok(!m.decisions.includes('[scope] old scope'));
  assert.ok(m.decisions.includes('[trigger] use compact'));
  assert.ok(m.nexts.includes('ship v1'));
});

test('mergeSessions: excludeSid and non-json files ignored', () => {
  const dir = tmpStateDir();
  writeSessionModel(dir, 'sessA', { openLoops: ['loop-a'], decisions: [], nexts: [], facts: [] });
  writeSessionModel(dir, 'sessB', { openLoops: ['loop-b'], decisions: [], nexts: [], facts: [] });
  fs.writeFileSync(path.join(dir, 'charter.md'), 'north star'); // must be skipped
  const m = charter.mergeSessions(dir, { excludeSid: 'sessB' });
  assert.ok(m.openLoops.includes('loop-a'));
  assert.ok(!m.openLoops.includes('loop-b'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/charter.test.js`
Expected: FAIL — `charter.mergeSessions is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `hooks/lib/charter.js`, extend requires with `const { emptyModel, mergeModel } = require('./state');` and `const { SESSIONS_MERGE_CAP } = require('./config');`, then add:

```js
// List `<sid>.json` session model files, most-recent first, capped.
function sessionModelFiles(stateDir, cap) {
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch (e) {
    return [];
  }
  const files = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      const p = path.join(stateDir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch (e) {
        /* ignore */
      }
      return { sid: n.slice(0, -5), path: p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, cap);
}

// Union the most-recent sessions' models into one, reusing mergeModel's dedup/cap/topic
// logic. Fold oldest-first so the newest session wins per topic.
function mergeSessions(stateDir, { excludeSid } = {}) {
  const files = sessionModelFiles(stateDir, SESSIONS_MERGE_CAP)
    .filter((f) => f.sid !== excludeSid)
    .reverse(); // oldest first
  let acc = emptyModel();
  for (const f of files) {
    let sm;
    try {
      sm = JSON.parse(fs.readFileSync(f.path, 'utf8'));
    } catch (e) {
      continue;
    }
    acc = mergeModel(acc, {
      openLoops: sm.openLoops || [],
      decisions: sm.decisions || [],
      nexts: sm.nexts || [],
      resolved: [],
      facts: sm.facts || [],
    });
  }
  return acc;
}
```

Add `mergeSessions` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/charter.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/charter.js hooks/test/charter.test.js
git commit -m "feat(charter): recency-gated merge-on-read union of session models"
```

---

### Task 4: Render the charter (north-star + merged sections)

**Files:**
- Modify: `hooks/lib/charter.js`
- Test: `hooks/test/charter.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `charter.js` adds `renderCharter(northStar, model): string`.

- [ ] **Step 1: Write the failing test**

Append to `hooks/test/charter.test.js`:

```js
test('renderCharter: includes north-star and non-empty sections only', () => {
  const md = charter.renderCharter('preserve founding context', {
    openLoops: ['drift kills flat-file'],
    decisions: ['[scope] north-star + shards'],
    nexts: ['ship v1'],
    facts: [],
  });
  assert.ok(md.includes('# Task charter'));
  assert.ok(md.includes('preserve founding context'));
  assert.ok(md.includes('## Open loops'));
  assert.ok(md.includes('- drift kills flat-file'));
  assert.ok(md.includes('## Decisions'));
  assert.ok(md.includes('## Next'));
  assert.ok(!md.includes('## Recent activity')); // facts not rendered in the charter view
});

test('renderCharter: null north-star renders a placeholder line', () => {
  const md = charter.renderCharter(null, { openLoops: [], decisions: [], nexts: [], facts: [] });
  assert.ok(md.includes('# Task charter'));
  assert.ok(md.toLowerCase().includes('no north star set'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/charter.test.js`
Expected: FAIL — `charter.renderCharter is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `hooks/lib/charter.js`, add:

```js
function section(title, items) {
  if (!items || items.length === 0) return '';
  return [`## ${title}`, ...items.map((x) => `- ${x}`), ''].join('\n');
}

// The charter view: the north-star framing plus the merged cross-session rationale.
// Facts (activity) are deliberately excluded — the charter carries intent, not log.
function renderCharter(northStar, model) {
  const parts = ['# Task charter', ''];
  parts.push(northStar ? `**North star:** ${northStar}` : '_No north star set — use `/charter set` to pin the task framing._');
  parts.push('');
  const secs = [
    section('Open loops', model.openLoops),
    section('Decisions', model.decisions),
    section('Next', model.nexts),
  ].filter(Boolean);
  return parts.concat(secs).join('\n').trimEnd() + '\n';
}
```

Add `renderCharter` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/charter.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/charter.js hooks/test/charter.test.js
git commit -m "feat(charter): renderCharter (north-star + merged rationale sections)"
```

---

### Task 5: Durability all-scan — catch up abandoned sessions

**Files:**
- Modify: `hooks/lib/charter.js`
- Test: `hooks/test/charter.test.js`

**Interfaces:**
- Consumes: `readDelta` from `transcript.js`; `extractFacts`, `extractRationale` from `extract.js`; `mergeModel`, `emptyModel` from `state.js`; `ACTIVE_SKIP_MINUTES` from config.
- Produces: `charter.js` adds `catchUpSessions(stateDir, { currentSid, now } = {}): void`. The transcript for session `<sid>` is resolved as `path.join(path.dirname(stateDir), '<sid>.jsonl')` (state dir is `<projectDir>/state`, transcripts are `<projectDir>/<sid>.jsonl`).

- [ ] **Step 1: Write the failing test**

Append to `hooks/test/charter.test.js`:

```js
test('catchUpSessions: harvests an abandoned session un-watermarked tail; idempotent', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = path.join(proj, 'state');
  fs.mkdirSync(dir, { recursive: true });
  // abandoned session: transcript has a tagged decision past the model offset
  const sid = 'abandoned1';
  const line = (o) => JSON.stringify(o) + '\n';
  const transcript =
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'DECISION: [x] chose B over A' }] } });
  const tpath = path.join(proj, `${sid}.jsonl`);
  fs.writeFileSync(tpath, transcript);
  // stale mtime so it is not treated as active
  const old = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(tpath, new Date(old), new Date(old));
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ offset: 0, openLoops: [], decisions: [], nexts: [], facts: [] }));

  charter.catchUpSessions(dir, { currentSid: 'other', now: Date.now() });
  const after = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  assert.ok(after.decisions.includes('[x] chose B over A'));
  assert.ok(after.offset > 0);

  // idempotent: a second scan changes nothing
  const before2 = fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8');
  charter.catchUpSessions(dir, { currentSid: 'other', now: Date.now() });
  assert.strictEqual(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'), before2);
});

test('catchUpSessions: skips a recently-active session (race guard)', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = path.join(proj, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'live1';
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'DECISION: [y] live' }] } }) + '\n');
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ offset: 0, openLoops: [], decisions: [], nexts: [], facts: [] }));
  // transcript mtime is "now" => active => skipped
  charter.catchUpSessions(dir, { currentSid: 'other', now: Date.now() });
  const after = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  assert.strictEqual(after.decisions.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/charter.test.js`
Expected: FAIL — `charter.catchUpSessions is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `hooks/lib/charter.js`, extend requires with `const { readDelta } = require('./transcript');` and `const { extractFacts, extractRationale } = require('./extract');` and `const { ACTIVE_SKIP_MINUTES } = require('./config');`, then add:

```js
// Re-process any session whose model watermark lags its transcript (e.g. a session
// abandoned before its Stop hook flushed the final turn). Skips the current session
// and any transcript touched within ACTIVE_SKIP_MINUTES to avoid racing a live writer.
function catchUpSessions(stateDir, { currentSid, now = Date.now() } = {}) {
  const projDir = path.dirname(stateDir);
  const activeCutoff = now - ACTIVE_SKIP_MINUTES * 60 * 1000;
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch (e) {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const sid = n.slice(0, -5);
    if (sid === currentSid) continue;
    const tpath = path.join(projDir, `${sid}.jsonl`);
    let tstat;
    try {
      tstat = fs.statSync(tpath);
    } catch (e) {
      continue; // no transcript for this model
    }
    if (tstat.mtimeMs > activeCutoff) continue; // likely live

    const jsonPath = path.join(stateDir, n);
    let model;
    try {
      model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      continue;
    }
    if ((model.offset || 0) >= tstat.size) continue; // already caught up

    const { entries, newOffset } = readDelta(tpath, model.offset || 0);
    if (entries.length === 0) continue;
    const facts = extractFacts(entries);
    const rationale = extractRationale(entries);
    const merged = mergeModel(model, { ...rationale, facts });
    merged.offset = newOffset;
    fs.writeFileSync(jsonPath, JSON.stringify(merged));
  }
}
```

Add `catchUpSessions` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/charter.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/charter.js hooks/test/charter.test.js
git commit -m "feat(charter): durability all-scan for abandoned-session tails"
```

---

### Task 6: Writer — auto-draft the north-star, drop `_latest.md`

**Files:**
- Modify: `hooks/session-state-writer.js`
- Test: `hooks/test/writer.test.js`

**Interfaces:**
- Consumes: `writeNorthStarIfAbsent`, `firstSubstantiveUserMessage`, `readNorthStar` from `charter.js`; existing `readDelta`.
- Produces: on Stop, if `charter.md` is absent, a draft north-star from the transcript's first substantive user message. No `_latest.md` write.

- [ ] **Step 1: Write the failing test**

Append to `hooks/test/writer.test.js` (follow the file's existing stdin-driven pattern; this shows the shape — reuse the existing helper that runs the writer with a mocked stdin/env if present, otherwise spawn as below):

```js
const { execFileSync } = require('node:child_process');

test('writer: drafts north-star from first substantive user message when charter.md absent', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wproj-'));
  const sid = 'wsess1';
  const tpath = path.join(proj, `${sid}.jsonl`);
  const L = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(
    tpath,
    L({ type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }) +
      L({ type: 'user', message: { role: 'user', content: 'Build the task charter: preserve founding context across sessions.' } }) +
      L({ type: 'assistant', message: { content: [{ type: 'text', text: 'DECISION: [scope] north-star + shards' }] } })
  );
  const input = JSON.stringify({ session_id: sid, transcript_path: tpath, last_assistant_message: '' });
  execFileSync('node', [path.join(__dirname, '..', 'session-state-writer.js')], { input });

  const northStar = fs.readFileSync(path.join(proj, 'state', 'charter.md'), 'utf8');
  assert.ok(northStar.includes('Build the task charter'));
  assert.ok(!northStar.toLowerCase().includes('system-reminder'));
  // _latest.md is no longer written
  assert.strictEqual(fs.existsSync(path.join(proj, 'state', '_latest.md')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/writer.test.js`
Expected: FAIL — charter.md not created / `_latest.md` still present.

- [ ] **Step 3: Modify the writer**

In `hooks/session-state-writer.js`:

(a) Add to requires:

```js
const { writeNorthStarIfAbsent, firstSubstantiveUserMessage } = require('./lib/charter');
```

(b) Remove the `_latest.md` write. Delete the line:

```js
  const latestPath = path.join(stateDir, '_latest.md');
```

and the line:

```js
  fs.writeFileSync(latestPath, md);
```

(c) After the existing `fs.writeFileSync(mdPath, md);`, add the auto-draft:

```js
  // Auto-draft the north-star from the first substantive user message, but only if
  // no charter.md exists yet (first-writer-wins; a wrong draft is corrected by
  // `/charter set`). Read from offset 0 so the first message is in scope even on a
  // later Stop that would otherwise only see the delta.
  const head = readDelta(transcript_path, 0).entries;
  const firstMsg = firstSubstantiveUserMessage(head);
  if (firstMsg) writeNorthStarIfAbsent(stateDir, firstMsg);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/writer.test.js`
Expected: PASS (existing writer tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add hooks/session-state-writer.js hooks/test/writer.test.js
git commit -m "feat(charter): writer auto-drafts north-star, drop _latest.md"
```

---

### Task 7: Injector — north-star prepend, merge-on-read startup, durability scan

**Files:**
- Modify: `hooks/session-state-injector.js`
- Test: `hooks/test/injector.test.js`

**Interfaces:**
- Consumes: `readNorthStar`, `mergeSessions`, `renderCharter`, `catchUpSessions` from `charter.js`.
- Produces: SessionStart injection = durability catch-up, then the charter (north-star + merged rationale). `startup` unions recent sessions (replaces `_latest.md`); `resume`/`compact` render the same charter (the current session is already caught up by its own writer). The convention line is preserved.

- [ ] **Step 1: Write the failing test**

Append to `hooks/test/injector.test.js`:

```js
const { execFileSync } = require('node:child_process');

function runInjector(input) {
  return execFileSync('node', [path.join(__dirname, '..', 'session-state-injector.js')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('injector startup: emits north-star + merged decisions, not _latest.md', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'iproj-'));
  const dir = path.join(proj, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'charter.md'), 'preserve founding context');
  fs.writeFileSync(path.join(dir, 'sessX.json'), JSON.stringify({ offset: 1, openLoops: ['drift'], decisions: ['[scope] v1 small'], nexts: [], facts: [] }));
  const out = runInjector({ session_id: 'new1', transcript_path: path.join(proj, 'new1.jsonl'), source: 'startup' });
  assert.ok(out.includes('# Task charter'));
  assert.ok(out.includes('preserve founding context'));
  assert.ok(out.includes('[scope] v1 small'));
  assert.ok(out.includes('DECISION:')); // convention line still delivered
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/injector.test.js`
Expected: FAIL — output lacks the charter block.

- [ ] **Step 3: Modify the injector**

Replace `hooks/session-state-injector.js` body with:

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readNorthStar, mergeSessions, renderCharter, catchUpSessions } = require('./lib/charter');

const CONVENTION =
  'Tag durable decisions and open items inline so a hook can persist them across sessions: ' +
  '`DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:`.';

function main() {
  const { session_id, transcript_path, source } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!transcript_path) return;
  const sid = path.basename(String(session_id || ''));
  const stateDir = path.join(path.dirname(transcript_path), 'state');

  // Durability: fold any abandoned session's un-watermarked tail before reading.
  catchUpSessions(stateDir, { currentSid: sid });

  const northStar = readNorthStar(stateDir);
  const merged = mergeSessions(stateDir, { excludeSid: sid });
  const hasContent = northStar || merged.openLoops.length || merged.decisions.length || merged.nexts.length;

  const parts = [];
  if (hasContent) {
    const header = '# Prior task context in this project — verify relevance before relying on it\n';
    parts.push(header + '\n' + renderCharter(northStar, merged));
  }
  parts.push(CONVENTION);
  process.stdout.write(parts.join('\n\n'));
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
```

Note: `RECENCY_HOURS` and `pickState` are removed; recency is now handled by `mergeSessions` (session cap) and the durability scan. The old `_latest.md` / `<sid>.md` read paths are superseded by the merge-on-read.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/injector.test.js`
Expected: PASS. If pre-existing injector tests asserted `_latest.md`/`pickState` behavior, update them to assert the charter output (they describe removed behavior).

- [ ] **Step 5: Run the full hook test suite**

Run: `node --test hooks/test/`
Expected: PASS across extract/state/transcript/writer/injector/charter.

- [ ] **Step 6: Commit**

```bash
git add hooks/session-state-injector.js hooks/test/injector.test.js
git commit -m "feat(charter): injector emits merged charter + durability scan"
```

---

### Task 8: Charter CLI (show / set) for the slash command

**Files:**
- Create: `hooks/charter-cli.js`
- Test: `hooks/test/charter-cli.test.js`

**Interfaces:**
- Consumes: `readNorthStar`, `setNorthStar`, `mergeSessions`, `renderCharter` from `charter.js`.
- Produces: a CLI. `node charter-cli.js show` prints the rendered charter; `node charter-cli.js set` reads north-star text from stdin and writes it. State dir resolution: `CHARTER_STATE_DIR` env if set (used by tests and power users), else `<homedir>/.claude/projects/<cwd-slug>/state` where slug = `process.cwd()` with `/` replaced by `-`.

- [ ] **Step 1: Write the failing test**

Create `hooks/test/charter-cli.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'charter-cli.js');

test('charter-cli set: writes north-star from stdin; show: renders it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  execFileSync('node', [CLI, 'set'], { input: 'the crystallized framing', env: { ...process.env, CHARTER_STATE_DIR: dir } });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'charter.md'), 'utf8').trim(), 'the crystallized framing');
  const out = execFileSync('node', [CLI, 'show'], { env: { ...process.env, CHARTER_STATE_DIR: dir }, encoding: 'utf8' });
  assert.ok(out.includes('# Task charter'));
  assert.ok(out.includes('the crystallized framing'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/charter-cli.test.js`
Expected: FAIL — `Cannot find module ... charter-cli.js`.

- [ ] **Step 3: Write the CLI**

Create `hooks/charter-cli.js`:

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readNorthStar, setNorthStar, mergeSessions, renderCharter } = require('./lib/charter');

function resolveStateDir() {
  if (process.env.CHARTER_STATE_DIR) return process.env.CHARTER_STATE_DIR;
  const slug = process.cwd().replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, 'state');
}

function main() {
  const cmd = process.argv[2] || 'show';
  const stateDir = resolveStateDir();
  if (cmd === 'set') {
    const text = fs.readFileSync(0, 'utf8');
    setNorthStar(stateDir, text);
    process.stdout.write('north-star updated.\n');
    return;
  }
  // show
  const md = renderCharter(readNorthStar(stateDir), mergeSessions(stateDir));
  process.stdout.write(md);
}

main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/charter-cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/charter-cli.js hooks/test/charter-cli.test.js
git commit -m "feat(charter): show/set CLI backing the slash command"
```

---

### Task 9: `/charter` slash command

**Files:**
- Create: `commands/charter.md`

**Interfaces:**
- Consumes: `hooks/charter-cli.js`.
- Produces: a `/charter` command with `show` (default), `set <text>`, `pin` sub-forms.

- [ ] **Step 1: Create the command**

Create `commands/charter.md`:

```markdown
---
description: Show or update the project task charter (north-star framing + merged decisions)
argument-hint: "[set <text> | pin]"
---

The charter CLI lives at `${CLAUDE_PLUGIN_ROOT}/hooks/charter-cli.js`.

Arguments: `$ARGUMENTS`

Do exactly one of:

- If the arguments are empty or start with `show`: run
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/charter-cli.js" show`
  and display its output verbatim to the user.

- If the arguments start with `set `: take the text after `set ` as the new north-star and run
  `printf '%s' '<TEXT>' | node "${CLAUDE_PLUGIN_ROOT}/hooks/charter-cli.js" set`
  (substitute `<TEXT>`, shell-escaping single quotes). Then confirm the update.

- If the arguments are `pin`: use the user's immediately-preceding message in this
  conversation as the north-star text, and run the same `... set` pipe with that text.
  Then confirm what was pinned.

Keep it to the single command execution and a one-line confirmation. Do not editorialize.
```

- [ ] **Step 2: Manually verify the command is discovered**

Run (from a session with the plugin installed after this branch is enabled):
`/charter`
Expected: prints the Task charter view (north-star + merged decisions) for the current project. `/charter set testing one two` then `/charter` shows the updated north-star.

Note: automated testing of the slash surface is out of scope (it requires a live Claude Code session); the CLI it delegates to is unit-tested in Task 8. Record the manual result in the PR description.

- [ ] **Step 3: Commit**

```bash
git add commands/charter.md
git commit -m "feat(charter): /charter slash command (show/set/pin)"
```

---

### Task 10: Version bump, README, full suite, end-to-end dogfood

**Files:**
- Modify: `plugins/session-state/.claude-plugin/plugin.json`
- Modify: `README.md` (concord root)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a releasable `session-state` 0.2.0 with the charter capability.

- [ ] **Step 1: Bump the plugin version and description**

In `.claude-plugin/plugin.json`, set `"version": "0.2.0"` and extend the description:

```json
  "description": "Persist per-session state and a project task charter (north-star + merged decisions) from the transcript, and re-inject them on resume, compaction, or a fresh session.",
```

- [ ] **Step 2: Update the concord README Plugins bullet**

In `README.md`, replace the `session-state` bullet under `## Plugins` with:

```markdown
- `session-state` - persists per-session state and a project task charter (north-star framing + merged cross-session decisions) from the transcript, and re-injects them on resume, compaction, or a fresh session, so a new session inherits the founding context instead of re-reading the transcript.
```

- [ ] **Step 3: Run the full test suite**

Run: `node --test hooks/test/`
Expected: PASS — all suites (extract, state, transcript, writer, injector, charter, charter-cli).

- [ ] **Step 4: End-to-end dogfood (manual, recorded in PR)**

1. Enable the branch's plugin locally; open a fresh session in a scratch project; send a substantive first message; end the turn (Stop) — confirm `state/charter.md` was auto-drafted (check it contains the first message, not boilerplate).
2. Run `/charter set <a precise framing>`; run `/charter` — confirm the precise framing shows.
3. In the session, emit a `DECISION: [x] ...` line; end the turn; start a NEW session in the same project — confirm the SessionStart injection contains `# Task charter`, the north-star, and the decision.
4. Confirm no `state/_latest.md` is created.

Record the four results in the PR description.

- [ ] **Step 5: Commit**

```bash
git add plugins/session-state/.claude-plugin/plugin.json README.md
git commit -m "chore(charter): bump session-state to 0.2.0, update README"
```

---

## Self-Review

**Spec coverage:**
- North-star capture (auto-draft create-if-absent + `/charter set`/`pin`): Tasks 1, 2, 6, 8, 9. ✓
- Append-only / concurrent-safe decision store via per-session `<sid>.json`: reused; merge-on-read in Task 3. ✓
- Injection at SessionStart (fresh/resume/compact) with merged charter: Task 7. ✓ (PreCompact folded into the existing SessionStart `compact` matcher — no separate hook, per approved refinement R2.)
- Concurrent-safety (CS1 first-writer-wins north-star; per-session ownership): Task 1 test + Task 5 race guard. ✓
- Read-cost bound (recency-gated merge): Task 3 `SESSIONS_MERGE_CAP`. ✓ (`_consolidated.jsonl` deferred per R1 — infrequent SessionStart/compact reads only, no per-turn injection.)
- Durability all-scan (abandon-then-new): Task 5. ✓
- Injector ownership (single injector renders rationale; facts stay in `<sid>.md` writer): Task 7. ✓ (X1 dissolved — one injector.)
- Capture-accuracy honesty / boilerplate fragility: Task 2 filter + Task 6 draft-only-if-absent. ✓
- Drop per-turn injection: not built (Non-goal). ✓
- In-session drift experiment: not built (deferred, Non-goal). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows assertions and the exact run command.

**Type consistency:** `charter.js` surface used consistently across tasks — `charterPath`, `readNorthStar`, `writeNorthStarIfAbsent`, `setNorthStar` (Task 1); `firstSubstantiveUserMessage` (Task 2); `mergeSessions(stateDir, {excludeSid})` (Task 3, consumed in Tasks 7/8); `renderCharter(northStar, model)` (Task 4, consumed in Tasks 7/8); `catchUpSessions(stateDir, {currentSid, now})` (Task 5, consumed in Task 7). Model shape `{openLoops, decisions, nexts, facts, offset}` matches `state.js emptyModel`.

## Notes for the executor

- Work in a git worktree off concord `main` (use `superpowers:using-git-worktrees`). Branch name suggestion: `feat/task-charter`.
- The existing `injector.test.js` may assert removed `_latest.md`/`pickState` behavior; Task 7 Step 4 updates those assertions rather than preserving dead behavior.
- This ships on top of `session-state`, which is enabled and dogfooded; run the full suite (Task 7 Step 5, Task 10 Step 3) before opening the PR.
