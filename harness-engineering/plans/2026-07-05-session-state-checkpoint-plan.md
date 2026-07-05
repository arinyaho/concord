# Session-State Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Node hooks that persist a compact per-session state file from the transcript and re-inject it on resume, compaction, or a fresh continuation session, so the model stops re-reading its own transcript to recover.

**Architecture:** A Stop hook parses only the transcript delta since a stored byte offset, extracts facts (tool_use) and inline-tagged rationale (assistant text), merges them into a bounded machine model, and renders a small markdown view plus a rolling project pointer. A SessionStart hook prints the relevant view back into context. All paths derive from the `transcript_path` the harness passes on stdin, so one install serves any project. See the design spec: `harness-engineering/specs/2026-07-05-session-state-checkpoint.md`.

**Tech Stack:** Node.js (built-in modules only: `node:fs`, `node:path`, `node:test`, `node:assert`, `node:child_process`), CommonJS, zero external dependencies. Node 18+ (`node --test` runner).

## Global Constraints

- Built-in Node modules only; zero external dependencies; CommonJS (`require`), matching the existing hooks.
- Every hook wraps its body in try/catch and calls `process.exit(0)` unconditionally — a hook failure must never block a turn or a session start.
- Write path adds zero model tokens: the hook is a pure side effect, never prints to a turn.
- All filesystem paths derive from stdin (`transcript_path`, `session_id`); no hardcoded project or brand paths (project-agnostic).
- English-only source and comments.
- Markdown authoring: one line per paragraph and list item (viewer soft-wraps); fenced code blocks keep literal line breaks.
- Constants (in `hooks/lib/config.js`): `RECENCY_HOURS = 48`, `FACTS_CAP = 40`, `OPEN_LOOPS_CAP = 20`, `DECISIONS_CAP = 20`, `NEXTS_CAP = 5`.
- Refinement over the spec: the machine model plus the byte-offset watermark live together in `state/<session_id>.json` (the spec's `.pos` sidecar is folded into this JSON); `state/<session_id>.md` is the rendered inject view; `state/_latest.md` is the rolling project pointer.

## File Structure

All code lives in the `concord` repo under `hooks/`; installation symlinks the two entry hooks into `$CLAUDE_CONFIG_DIR/hooks/` (relative `require('./lib/...')` resolves via the symlink's real path, so `lib/` stays in the repo).

- `hooks/lib/config.js` — constants and shared regexes.
- `hooks/lib/transcript.js` — `readDelta(path, offset)`: byte-offset delta read + JSONL parse.
- `hooks/lib/extract.js` — `extractFacts(entries)`, `extractRationale(entries)`.
- `hooks/lib/state.js` — `emptyModel()`, `topicKey()`, `mergeModel()`, `renderMarkdown()`.
- `hooks/session-state-writer.js` — Stop hook entry point.
- `hooks/session-state-injector.js` — SessionStart hook entry point.
- `hooks/test/fixtures/sample.jsonl` — real transcript lines, pinned for extractor tests.
- `hooks/test/*.test.js` — one test file per module.
- `hooks/install.sh` — symlink hooks, patch settings.json (with backup), print the CLAUDE.md convention line.

Working directory: a checkout of `concord`. Run tests with `node --test hooks/test/`.

---

### Task 1: Config + transcript delta reader

**Files:**
- Create: `hooks/lib/config.js`
- Create: `hooks/lib/transcript.js`
- Test: `hooks/test/transcript.test.js`

**Interfaces:**
- Produces: `readDelta(transcriptPath: string, offset: number) -> { entries: object[], newOffset: number }`. Reads bytes from `offset` to EOF, parses complete JSONL lines only (a partial trailing line is left for next time), skips malformed lines, and resets to 0 if `offset > fileSize` (rewritten transcript). Missing file -> `{ entries: [], newOffset: offset }`.
- Produces: `config` object with the Global Constraints constants plus `TAG_RE`, `MEANINGFUL_BASH_RE`, `NOISE_BASH_RE`.

- [ ] **Step 1: Write `hooks/lib/config.js`**

```js
'use strict';

module.exports = {
  RECENCY_HOURS: 48,   // startup injection skips a _latest.md older than this
  FACTS_CAP: 40,       // recent-activity ring buffer size
  OPEN_LOOPS_CAP: 20,  // max unresolved open loops kept
  DECISIONS_CAP: 20,   // max decisions kept (latest per topic)
  NEXTS_CAP: 5,        // max next-step lines kept
  TAG_RE: /^(DECISION|OPEN-LOOP|NEXT|RESOLVED):\s*(.*)$/i,
  MEANINGFUL_BASH_RE: /\b(git (commit|push|mv|rebase|merge|tag)|gh (pr|issue|release)|pytest|npm (run|test|ci|install)|pip install|cdk (deploy|synth)|amplify|make )\b/,
  NOISE_BASH_RE: /^\s*(ls|cd|cat|echo|grep|pwd|which|head|tail|sed|awk|find)\b/,
};
```

- [ ] **Step 2: Write the failing test `hooks/test/transcript.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDelta } = require('../lib/transcript');

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tx-')), 't.jsonl');
  fs.writeFileSync(p, contents);
  return p;
}

test('reads all complete lines from offset 0 and advances to EOF', () => {
  const p = tmpFile('{"a":1}\n{"a":2}\n');
  const r = readDelta(p, 0);
  assert.deepEqual(r.entries.map((e) => e.a), [1, 2]);
  assert.equal(r.newOffset, fs.statSync(p).size);
});

test('reads only the delta on the second call', () => {
  const p = tmpFile('{"a":1}\n');
  const first = readDelta(p, 0);
  fs.appendFileSync(p, '{"a":2}\n');
  const second = readDelta(p, first.newOffset);
  assert.deepEqual(second.entries.map((e) => e.a), [2]);
});

test('does not consume a partial trailing line', () => {
  const p = tmpFile('{"a":1}\n{"a":2}');           // no trailing newline
  const r = readDelta(p, 0);
  assert.deepEqual(r.entries.map((e) => e.a), [1]); // only the complete line
  assert.equal(r.newOffset, 8);                     // '{"a":1}\n'
});

test('skips malformed lines', () => {
  const p = tmpFile('{"a":1}\nnot json\n{"a":3}\n');
  const r = readDelta(p, 0);
  assert.deepEqual(r.entries.map((e) => e.a), [1, 3]);
});

test('resets to 0 when the file is smaller than the offset', () => {
  const p = tmpFile('{"a":1}\n');
  const r = readDelta(p, 9999);
  assert.deepEqual(r.entries.map((e) => e.a), [1]);
});

test('missing file returns empty and keeps the offset', () => {
  const r = readDelta('/no/such/file.jsonl', 42);
  assert.deepEqual(r, { entries: [], newOffset: 42 });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test hooks/test/transcript.test.js`
Expected: FAIL — `Cannot find module '../lib/transcript'`.

- [ ] **Step 4: Write `hooks/lib/transcript.js`**

```js
'use strict';
const fs = require('node:fs');

// Read new JSONL entries appended since `offset` bytes. Advances the offset only
// to the last complete line, so a partial line mid-write is re-read next time.
// Treats a file smaller than `offset` as rewritten and re-reads from 0.
function readDelta(transcriptPath, offset) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (e) {
    return { entries: [], newOffset: offset };
  }
  const start = offset > stat.size ? 0 : offset;
  if (stat.size - start <= 0) return { entries: [], newOffset: stat.size };

  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { entries: [], newOffset: start };
    const complete = text.slice(0, lastNl + 1);
    const consumed = Buffer.byteLength(complete, 'utf8');
    const entries = [];
    for (const line of complete.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t));
      } catch (e) {
        /* skip malformed line */
      }
    }
    return { entries, newOffset: start + consumed };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readDelta };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test hooks/test/transcript.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/config.js hooks/lib/transcript.js hooks/test/transcript.test.js
git commit -m "feat: transcript delta reader with byte-offset watermark"
```

---

### Task 2: Extractors (facts + rationale)

**Files:**
- Create: `hooks/lib/extract.js`
- Create: `hooks/test/fixtures/sample.jsonl`
- Test: `hooks/test/extract.test.js`

**Interfaces:**
- Consumes: entries as returned by `readDelta` (parsed transcript objects).
- Produces: `extractFacts(entries) -> string[]` (e.g. `"edited path"`, `"ran: git commit ..."`, `"task: Title [status]"`).
- Produces: `extractRationale(entries) -> { decisions: string[], openLoops: string[], nexts: string[], resolved: string[] }`.

Transcript shape (verified against real logs): an entry with `type === "assistant"` has `message.content` = an array of items; each item has `type` in `{ "thinking", "text", "tool_use" }`. A `tool_use` item is `{ type, name, input }`; a `text` item is `{ type: "text", text }`.

- [ ] **Step 1: Pin a real fixture `hooks/test/fixtures/sample.jsonl`**

Copy 4 representative lines from a real transcript so the extractor is tested against the true shape (one line each). Keep them minimal but structurally real:

```
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/a.js"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"git commit -m \"x\"","description":"commit"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la","description":"list"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"DECISION: [scope] chose A over B\nOPEN-LOOP: verify the injector\nNEXT: wire settings.json"}]}}
```

- [ ] **Step 2: Write the failing test `hooks/test/extract.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractFacts, extractRationale } = require('../lib/extract');

function loadFixture() {
  const p = path.join(__dirname, 'fixtures', 'sample.jsonl');
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('facts: edits and meaningful commands, noise filtered', () => {
  const facts = extractFacts(loadFixture());
  assert.ok(facts.includes('edited /repo/a.js'));
  assert.ok(facts.includes('ran: git commit -m "x"'));
  assert.ok(!facts.some((f) => f.includes('ls -la'))); // noise dropped
});

test('rationale: tagged lines routed by tag', () => {
  const r = extractRationale(loadFixture());
  assert.deepEqual(r.decisions, ['[scope] chose A over B']);
  assert.deepEqual(r.openLoops, ['verify the injector']);
  assert.deepEqual(r.nexts, ['wire settings.json']);
});

test('rationale: RESOLVED captured, untagged text ignored', () => {
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'just prose, no tag\nRESOLVED: verify the injector' },
    ] } },
  ];
  const r = extractRationale(entries);
  assert.deepEqual(r.resolved, ['verify the injector']);
  assert.equal(r.decisions.length, 0);
});

test('task tool_use becomes a task fact', () => {
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'TaskUpdate', input: { title: 'Build writer', status: 'completed' } },
    ] } },
  ];
  assert.deepEqual(extractFacts(entries), ['task: Build writer [completed]']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test hooks/test/extract.test.js`
Expected: FAIL — `Cannot find module '../lib/extract'`.

- [ ] **Step 4: Write `hooks/lib/extract.js`**

```js
'use strict';
const { TAG_RE, MEANINGFUL_BASH_RE, NOISE_BASH_RE } = require('./config');

// Flatten the content items of every assistant entry in the delta.
function assistantItems(entries) {
  const out = [];
  for (const e of entries) {
    if (e && e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const item of e.message.content) out.push(item);
    }
  }
  return out;
}

// Facts from tool_use items: edited files, meaningful commands, task changes.
function extractFacts(entries) {
  const facts = [];
  for (const item of assistantItems(entries)) {
    if (!item || item.type !== 'tool_use') continue;
    const input = item.input || {};
    if (item.name === 'Edit' || item.name === 'Write') {
      if (input.file_path) facts.push(`edited ${input.file_path}`);
    } else if (item.name === 'Bash') {
      const cmd = String(input.command || '').split('\n')[0].trim();
      if (cmd && MEANINGFUL_BASH_RE.test(cmd) && !NOISE_BASH_RE.test(cmd)) {
        facts.push(`ran: ${cmd}`);
      }
    } else if (item.name === 'TaskCreate' || item.name === 'TaskUpdate') {
      const title = input.title || input.task || input.description || '(task)';
      const status = input.status ? ` [${input.status}]` : '';
      facts.push(`task: ${title}${status}`);
    }
  }
  return facts;
}

// Rationale from tagged assistant-text lines.
function extractRationale(entries) {
  const decisions = [];
  const openLoops = [];
  const nexts = [];
  const resolved = [];
  for (const item of assistantItems(entries)) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
    for (const raw of item.text.split('\n')) {
      const m = raw.trim().match(TAG_RE);
      if (!m) continue;
      const body = m[2].trim();
      if (!body) continue;
      const tag = m[1].toUpperCase();
      if (tag === 'DECISION') decisions.push(body);
      else if (tag === 'OPEN-LOOP') openLoops.push(body);
      else if (tag === 'NEXT') nexts.push(body);
      else if (tag === 'RESOLVED') resolved.push(body);
    }
  }
  return { decisions, openLoops, nexts, resolved };
}

module.exports = { extractFacts, extractRationale };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test hooks/test/extract.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/extract.js hooks/test/extract.test.js hooks/test/fixtures/sample.jsonl
git commit -m "feat: fact and rationale extractors"
```

---

### Task 3: State model + compaction

**Files:**
- Create: `hooks/lib/state.js`
- Test: `hooks/test/state.test.js`

**Interfaces:**
- Consumes: rationale + facts as produced by Task 2.
- Produces: `emptyModel() -> { offset, openLoops, decisions, nexts, facts }` (arrays, offset 0).
- Produces: `topicKey(decision: string) -> string` (leading `[...]` lowercased, else first four words).
- Produces: `mergeModel(prev, { decisions, openLoops, nexts, resolved, facts }) -> model` (bounded per the caps; `resolved` closes matching open loops; decisions are latest-per-topic; facts are a ring buffer).
- Produces: `renderMarkdown(sessionId: string, model) -> string`.

- [ ] **Step 1: Write the failing test `hooks/test/state.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { emptyModel, mergeModel, renderMarkdown } = require('../lib/state');

function delta(over) {
  return { decisions: [], openLoops: [], nexts: [], resolved: [], facts: [], ...over };
}

test('decisions keep the latest per topic', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ decisions: ['[scope] first'] }));
  m = mergeModel(m, delta({ decisions: ['[scope] second'] }));
  assert.deepEqual(m.decisions, ['[scope] second']);
});

test('RESOLVED closes a matching open loop', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ openLoops: ['verify the injector'] }));
  m = mergeModel(m, delta({ resolved: ['verify the injector'] }));
  assert.deepEqual(m.openLoops, []);
});

test('facts are a bounded ring buffer', () => {
  let m = emptyModel();
  const many = Array.from({ length: 50 }, (_, i) => `edited f${i}.js`);
  m = mergeModel(m, delta({ facts: many }));
  assert.equal(m.facts.length, 40);
  assert.equal(m.facts[0], 'edited f10.js'); // oldest 10 dropped
});

test('renderMarkdown includes the machine-owned header and sections', () => {
  const m = mergeModel(emptyModel(), delta({ decisions: ['[x] d'], facts: ['edited a'] }));
  const md = renderMarkdown('abc', m);
  assert.ok(md.startsWith('# Session state — abc'));
  assert.ok(md.includes('# machine-owned - do not hand-edit'));
  assert.ok(md.includes('## Decisions'));
  assert.ok(md.includes('- [x] d'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test hooks/test/state.test.js`
Expected: FAIL — `Cannot find module '../lib/state'`.

- [ ] **Step 3: Write `hooks/lib/state.js`**

```js
'use strict';
const { FACTS_CAP, OPEN_LOOPS_CAP, DECISIONS_CAP, NEXTS_CAP } = require('./config');

function emptyModel() {
  return { offset: 0, openLoops: [], decisions: [], nexts: [], facts: [] };
}

function topicKey(decision) {
  const bracket = decision.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1].trim().toLowerCase();
  return decision.split(/\s+/).slice(0, 4).join(' ').toLowerCase();
}

// Merge a delta into the model, applying compaction so the file stays bounded.
function mergeModel(prev, d) {
  const m = {
    offset: prev.offset,
    openLoops: prev.openLoops.slice(),
    decisions: prev.decisions.slice(),
    nexts: prev.nexts.slice(),
    facts: prev.facts.slice(),
  };

  m.facts = m.facts.concat(d.facts).slice(-FACTS_CAP);

  m.openLoops = m.openLoops.concat(d.openLoops);
  for (const r of d.resolved) {
    m.openLoops = m.openLoops.filter(
      (o) => !(o === r || o.includes(r) || r.includes(o))
    );
  }
  m.openLoops = m.openLoops.slice(-OPEN_LOOPS_CAP);

  for (const dec of d.decisions) {
    const k = topicKey(dec);
    m.decisions = m.decisions.filter((x) => topicKey(x) !== k);
    m.decisions.push(dec);
  }
  m.decisions = m.decisions.slice(-DECISIONS_CAP);

  m.nexts = m.nexts.concat(d.nexts).slice(-NEXTS_CAP);
  return m;
}

function section(title, items) {
  return [`## ${title}`, ...items.map((x) => `- ${x}`), ''].join('\n');
}

function renderMarkdown(sessionId, m) {
  return [
    `# Session state — ${sessionId}`,
    '# machine-owned - do not hand-edit',
    '',
    section('Open loops', m.openLoops),
    section('Decisions', m.decisions),
    section('Next', m.nexts),
    section('Recent activity', m.facts),
  ].join('\n');
}

module.exports = { emptyModel, topicKey, mergeModel, renderMarkdown };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test hooks/test/state.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/state.js hooks/test/state.test.js
git commit -m "feat: bounded state model with compaction"
```

---

### Task 4: Writer hook (Stop)

**Files:**
- Create: `hooks/session-state-writer.js`
- Test: `hooks/test/writer.test.js`

**Interfaces:**
- Consumes: `readDelta` (Task 1), `extractFacts`/`extractRationale` (Task 2), `emptyModel`/`mergeModel`/`renderMarkdown` (Task 3).
- Behavior: reads stdin JSON `{ session_id, transcript_path }`; resolves `stateDir = dirname(transcript_path)/state`; loads `state/<id>.json` (or `emptyModel`); reads the delta from `model.offset`; merges; writes `state/<id>.json`, `state/<id>.md`, `state/_latest.md`; exits 0 always.

- [ ] **Step 1: Write the failing test `hooks/test/writer.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WRITER = path.join(__dirname, '..', 'session-state-writer.js');

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const transcript = path.join(proj, 'sess.jsonl');
  return { proj, transcript, id: 'sess' };
}

function runWriter(transcript, id) {
  execFileSync('node', [WRITER], {
    input: JSON.stringify({ session_id: id, transcript_path: transcript }),
  });
}

test('writes state json, md, and rolling pointer', () => {
  const { proj, transcript, id } = setup();
  fs.writeFileSync(
    transcript,
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/a.js"}}]}}\n'
  );
  runWriter(transcript, id);
  const stateDir = path.join(proj, 'state');
  const model = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), 'utf8'));
  assert.ok(model.facts.includes('edited /x/a.js'));
  assert.ok(fs.readFileSync(path.join(stateDir, `${id}.md`), 'utf8').includes('edited /x/a.js'));
  assert.ok(fs.existsSync(path.join(stateDir, '_latest.md')));
});

test('second run consumes only the delta (idempotent, no dup)', () => {
  const { proj, transcript, id } = setup();
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/a.js"}}]}}\n';
  fs.writeFileSync(transcript, line);
  runWriter(transcript, id);
  runWriter(transcript, id); // no new bytes
  const model = JSON.parse(fs.readFileSync(path.join(proj, 'state', `${id}.json`), 'utf8'));
  assert.equal(model.facts.filter((f) => f === 'edited /x/a.js').length, 1);
});

test('malformed stdin exits 0 without throwing', () => {
  // execFileSync throws if the process exits non-zero; absence of throw = pass.
  execFileSync('node', [WRITER], { input: 'not json' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test hooks/test/writer.test.js`
Expected: FAIL — cannot find `session-state-writer.js`.

- [ ] **Step 3: Write `hooks/session-state-writer.js`**

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readDelta } = require('./lib/transcript');
const { extractFacts, extractRationale } = require('./lib/extract');
const { emptyModel, mergeModel, renderMarkdown } = require('./lib/state');

function main() {
  const { session_id, transcript_path } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!session_id || !transcript_path) return;

  const stateDir = path.join(path.dirname(transcript_path), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonPath = path.join(stateDir, `${session_id}.json`);
  const mdPath = path.join(stateDir, `${session_id}.md`);
  const latestPath = path.join(stateDir, '_latest.md');

  let model = emptyModel();
  try {
    model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    /* first run for this session */
  }

  const { entries, newOffset } = readDelta(transcript_path, model.offset || 0);
  if (entries.length) {
    const facts = extractFacts(entries);
    const rationale = extractRationale(entries);
    model = mergeModel(model, { ...rationale, facts });
  }
  model.offset = newOffset;

  fs.writeFileSync(jsonPath, JSON.stringify(model));
  const md = renderMarkdown(session_id, model);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(latestPath, md);
}

try {
  main();
} catch (e) {
  /* never block the turn */
}
process.exit(0);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test hooks/test/writer.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/session-state-writer.js hooks/test/writer.test.js
git commit -m "feat: Stop hook writes and rolls session state"
```

---

### Task 5: Injector hook (SessionStart)

**Files:**
- Create: `hooks/session-state-injector.js`
- Test: `hooks/test/injector.test.js`

**Interfaces:**
- Consumes: `RECENCY_HOURS` (Task 1); the files written by Task 4.
- Behavior: reads stdin JSON `{ session_id, transcript_path, source }`; `resume`/`compact` -> print `state/<id>.md`; `startup` -> print `state/_latest.md` under a prior-session header only if its mtime is within `RECENCY_HOURS`; `clear`/other -> print nothing; exit 0 always.

- [ ] **Step 1: Write the failing test `hooks/test/injector.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INJECTOR = path.join(__dirname, '..', 'session-state-injector.js');

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const stateDir = path.join(proj, 'state');
  fs.mkdirSync(stateDir);
  return { transcript: path.join(proj, 'sess.jsonl'), stateDir, id: 'sess' };
}

function run(input) {
  return execFileSync('node', [INJECTOR], { input: JSON.stringify(input), encoding: 'utf8' });
}

test('resume prints the session state file', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(path.join(stateDir, `${id}.md`), 'STATE-BODY');
  const out = run({ session_id: id, transcript_path: transcript, source: 'resume' });
  assert.equal(out, 'STATE-BODY');
});

test('startup prints _latest under a prior-session header when recent', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(path.join(stateDir, '_latest.md'), 'ROLLING-BODY');
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(out.includes('Prior session state'));
  assert.ok(out.includes('ROLLING-BODY'));
});

test('startup prints nothing when _latest is stale', () => {
  const { transcript, stateDir, id } = setup();
  const p = path.join(stateDir, '_latest.md');
  fs.writeFileSync(p, 'OLD');
  const old = Date.now() / 1000 - 72 * 3600; // 72h ago, older than RECENCY_HOURS
  fs.utimesSync(p, old, old);
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.equal(out, '');
});

test('clear prints nothing', () => {
  const { transcript, id } = setup();
  const out = run({ session_id: id, transcript_path: transcript, source: 'clear' });
  assert.equal(out, '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test hooks/test/injector.test.js`
Expected: FAIL — cannot find `session-state-injector.js`.

- [ ] **Step 3: Write `hooks/session-state-injector.js`**

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { RECENCY_HOURS } = require('./lib/config');

function main() {
  const { session_id, transcript_path, source } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!transcript_path) return;
  const stateDir = path.join(path.dirname(transcript_path), 'state');

  if (source === 'resume' || source === 'compact') {
    const p = path.join(stateDir, `${session_id}.md`);
    if (fs.existsSync(p)) process.stdout.write(fs.readFileSync(p, 'utf8'));
    return;
  }

  if (source === 'startup') {
    const p = path.join(stateDir, '_latest.md');
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      return;
    }
    const ageHours = (Date.now() - stat.mtimeMs) / 3.6e6;
    if (ageHours > RECENCY_HOURS) return;
    const header =
      '# Prior session state in this project — verify relevance before relying on it\n\n';
    process.stdout.write(header + fs.readFileSync(p, 'utf8'));
    return;
  }
  // clear or unknown source: emit nothing
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test hooks/test/injector.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/session-state-injector.js hooks/test/injector.test.js
git commit -m "feat: SessionStart hook injects session or rolling state"
```

---

### Task 6: Install, wire, and dogfood

**Files:**
- Create: `hooks/install.sh`
- Modify: `$CLAUDE_CONFIG_DIR/settings.json` (via the script, with a backup)
- Modify: a project `CLAUDE.md` (add the tag-convention line)

**Interfaces:**
- Consumes: the two hook entry points from Tasks 4-5.

- [ ] **Step 1: Run the full suite green**

Run: `node --test hooks/test/`
Expected: PASS (all files, 21 tests).

- [ ] **Step 2: Write `hooks/install.sh`**

```bash
#!/usr/bin/env bash
# Install the session-state hooks into $CLAUDE_CONFIG_DIR and wire settings.json.
# Idempotent: re-running relinks and re-checks the settings entries.
set -euo pipefail

CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
REPO_HOOKS="$(cd "$(dirname "$0")" && pwd)"
HOOK_DIR="$CFG/hooks"
SETTINGS="$CFG/settings.json"

mkdir -p "$HOOK_DIR"
ln -sf "$REPO_HOOKS/session-state-writer.js"   "$HOOK_DIR/session-state-writer.js"
ln -sf "$REPO_HOOKS/session-state-injector.js" "$HOOK_DIR/session-state-injector.js"
echo "linked hooks into $HOOK_DIR"

# Patch settings.json (backup first). Adds a Stop hook and a SessionStart hook
# WITHOUT removing any existing entries (e.g. another SessionStart command).
node - "$SETTINGS" "$HOOK_DIR" <<'NODE'
const fs = require('fs');
const [settingsPath, hookDir] = process.argv.slice(2);
const settings = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  : {};
fs.writeFileSync(settingsPath + '.bak', JSON.stringify(settings, null, 2));
settings.hooks = settings.hooks || {};
const cmd = (name) => ({ type: 'command', command: `node "${hookDir}/${name}"` });
const ensure = (event, name) => {
  settings.hooks[event] = settings.hooks[event] || [];
  const has = settings.hooks[event].some((g) =>
    (g.hooks || []).some((h) => (h.command || '').includes(name)));
  if (!has) settings.hooks[event].push({ hooks: [cmd(name)] });
};
ensure('Stop', 'session-state-writer.js');
ensure('SessionStart', 'session-state-injector.js');
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log('wired Stop + SessionStart in ' + settingsPath + ' (backup at .bak)');
NODE

echo "Add this line to your CLAUDE.md so rationale is captured:"
echo '  - Tag durable decisions/open items inline: `DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:` — a hook harvests them into session state.'
```

- [ ] **Step 3: Run the installer and verify wiring**

Run: `bash hooks/install.sh`
Expected: prints "linked hooks", "wired Stop + SessionStart", and the CLAUDE.md line. Confirm `$CLAUDE_CONFIG_DIR/settings.json` now has both hooks and that any pre-existing SessionStart command is still present.

- [ ] **Step 4: Add the tag-convention line to a project `CLAUDE.md`**

Add verbatim under a docs/behavior section:

```
- Tag durable decisions/open items inline: `DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:` — a hook harvests them into session state.
```

- [ ] **Step 5: Dogfood in a live session**

Start a session, run a few tool calls and emit one `DECISION:` line, then end the turn. Verify `~/.claude/projects/<slug>/state/<session_id>.md` exists and lists the activity + the decision. Resume the session; confirm the injector's output appears in context without a transcript re-read. Start a fresh session in the same project within `RECENCY_HOURS`; confirm the prior-session block is injected under its header.

- [ ] **Step 6: Commit**

```bash
git add hooks/install.sh
git commit -m "feat: installer wiring hooks and settings, plus dogfood steps"
```

---

## Self-Review

**Spec coverage:**
- Layer 1 facts -> Task 2 `extractFacts`. Layer 2 tagged rationale -> Task 2 `extractRationale`.
- Byte-offset watermark + append-only reset -> Task 1 `readDelta`.
- Bounded compaction (facts ring, latest-per-topic decisions, resolved closes loops) -> Task 3.
- Writer side effects + `_latest.md` roll -> Task 4. Injector resume/compact/startup gating + recency + label -> Task 5.
- Project-agnostic paths -> every hook derives `stateDir` from `transcript_path` (Tasks 4-5).
- Wiring without clobbering an existing SessionStart hook, CLAUDE.md convention -> Task 6.
- Zero model tokens on write -> writer never writes to stdout (Task 4).

**Deferred (matches spec, not built here):** exit-status on `ran:` facts (needs tool_result correlation), `pr-link` entry-type as a PR source, PreCompact nudge, generalized in-repo corpus diagnostic.

**Placeholder scan:** none — every step has concrete code or an exact command.

**Type consistency:** `readDelta -> {entries, newOffset}` consumed in Task 4; `mergeModel(prev, {decisions, openLoops, nexts, resolved, facts})` matches `extractRationale` keys plus `facts`; `renderMarkdown(sessionId, model)` used by the writer. Model shape `{offset, openLoops, decisions, nexts, facts}` is consistent across Tasks 3-5.
