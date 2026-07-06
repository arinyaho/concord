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
- Distribution is a Claude Code plugin: hooks are declared in `plugins/session-state/hooks/hooks.json` via `${CLAUDE_PLUGIN_ROOT}` and activated by enabling the plugin — no user `settings.json` editing.
- English-only source and comments.
- Markdown authoring: one line per paragraph and list item (viewer soft-wraps); fenced code blocks keep literal line breaks.
- Constants (in `plugins/session-state/hooks/lib/config.js`): `RECENCY_HOURS = 48`, `FACTS_CAP = 40`, `OPEN_LOOPS_CAP = 20`, `DECISIONS_CAP = 20`, `NEXTS_CAP = 5`.
- Refinement over the spec: the machine model plus the byte-offset watermark live together in `state/<session_id>.json` (the spec's `.pos` sidecar is folded into this JSON); `state/<session_id>.md` is the rendered inject view; `state/_latest.md` is the rolling project pointer.

## File Structure

All code lives in this repo (`concord`) under `plugins/session-state/`. The plugin's `hooks.json` invokes each entry point via `${CLAUDE_PLUGIN_ROOT}`, which Claude Code expands to the plugin's installed path at runtime, so the relative `require('./lib/...')` calls inside each hook resolve correctly with no symlink or manual wiring.

- `plugins/session-state/.claude-plugin/plugin.json` — plugin manifest.
- `plugins/session-state/hooks/hooks.json` — declares the Stop and SessionStart hooks via `${CLAUDE_PLUGIN_ROOT}`.
- `plugins/session-state/hooks/lib/config.js` — constants and shared regexes.
- `plugins/session-state/hooks/lib/transcript.js` — `readDelta(path, offset)`.
- `plugins/session-state/hooks/lib/extract.js` — `extractFacts`, `extractRationale`, `extractRationaleText`.
- `plugins/session-state/hooks/lib/state.js` — `emptyModel`, `topicKey`, `mergeModel`, `renderMarkdown`.
- `plugins/session-state/hooks/session-state-writer.js` — Stop hook entry point.
- `plugins/session-state/hooks/session-state-injector.js` — SessionStart hook entry point.
- `plugins/session-state/hooks/test/fixtures/sample.jsonl` — pinned real transcript lines.
- `plugins/session-state/hooks/test/*.test.js` — one test file per module.
- `.claude-plugin/marketplace.json` — repo-root marketplace manifest listing the plugin.

Working directory: a checkout of `concord`. Run tests with `node --test plugins/session-state/hooks/test/*.test.js` (an explicit directory is not recursed by `node --test` on Node 24, so use the glob).

---

### Task 1: Config + transcript delta reader

**Files:**
- Create: `plugins/session-state/hooks/lib/config.js`
- Create: `plugins/session-state/hooks/lib/transcript.js`
- Test: `plugins/session-state/hooks/test/transcript.test.js`

**Interfaces:**
- Produces: `readDelta(transcriptPath: string, offset: number) -> { entries: object[], newOffset: number }`. Reads bytes from `offset` to EOF, parses complete JSONL lines only (a partial trailing line is left for next time), skips malformed lines, and resets to 0 if `offset > fileSize` (rewritten transcript). Missing file -> `{ entries: [], newOffset: offset }`.
- Produces: `config` object with the Global Constraints constants plus `TAG_RE` and `MEANINGFUL_BASH_RE`.

- [ ] **Step 1: Write `plugins/session-state/hooks/lib/config.js`**

```js
'use strict';

module.exports = {
  RECENCY_HOURS: 48,   // startup injection skips a _latest.md older than this
  FACTS_CAP: 40,       // recent-activity ring buffer size
  OPEN_LOOPS_CAP: 20,  // max unresolved open loops kept
  DECISIONS_CAP: 20,   // max decisions kept (latest per topic)
  NEXTS_CAP: 5,        // max next-step lines kept
  TAG_RE: /^(DECISION|OPEN-LOOP|NEXT|RESOLVED):\s*(.*)$/i,
  // High-signal build/test/deploy/infra tools. An allowlist (not a denylist)
  // because a bare denylist captures shell variable-assignment setup lines
  // (VAR=/path/...) that dominate multi-line commands; those carry no action.
  MEANINGFUL_BASH_RE: /^(git|gh|pytest|jest|vitest|npm|pnpm|yarn|pip|poetry|uv|cargo|go|mvn|gradle|make|cmake|bazel|docker|docker-compose|kubectl|helm|terraform|aws|gcloud|cdk|amplify|serverless|pulumi|ansible)\b/,
};
```

- [ ] **Step 2: Write the failing test `plugins/session-state/hooks/test/transcript.test.js`**

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

Run: `node --test plugins/session-state/hooks/test/transcript.test.js`
Expected: FAIL — `Cannot find module '../lib/transcript'`.

- [ ] **Step 4: Write `plugins/session-state/hooks/lib/transcript.js`**

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

Run: `node --test plugins/session-state/hooks/test/transcript.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/session-state/hooks/lib/config.js plugins/session-state/hooks/lib/transcript.js plugins/session-state/hooks/test/transcript.test.js
git commit -m "feat: transcript delta reader with byte-offset watermark"
```

---

### Task 2: Extractors (facts + rationale)

**Files:**
- Create: `plugins/session-state/hooks/lib/extract.js`
- Create: `plugins/session-state/hooks/test/fixtures/sample.jsonl`
- Test: `plugins/session-state/hooks/test/extract.test.js`

**Interfaces:**
- Consumes: entries as returned by `readDelta` (parsed transcript objects).
- Produces: `extractFacts(entries) -> string[]` (e.g. `"edited path"`, `"ran: git commit ..."`, `"task: Title [status]"`).
- Produces: `extractRationale(entries) -> { decisions: string[], openLoops: string[], nexts: string[], resolved: string[] }`.
- Produces: `extractRationaleText(text) -> { decisions, openLoops, nexts, resolved }` — same shape, harvested from a single text blob (the Stop hook's `last_assistant_message`).

Transcript shape (verified against real logs): an entry with `type === "assistant"` has `message.content` = an array of items; each item has `type` in `{ "thinking", "text", "tool_use" }`. A `tool_use` item is `{ type, name, input }`; a `text` item is `{ type: "text", text }`.

- [ ] **Step 1: Pin a real fixture `plugins/session-state/hooks/test/fixtures/sample.jsonl`**

Copy 4 representative lines from a real transcript so the extractor is tested against the true shape (one line each). Keep them minimal but structurally real:

```
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/a.js"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"git commit -m \"x\"","description":"commit"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la","description":"list"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"DECISION: [scope] chose A over B\nOPEN-LOOP: verify the injector\nNEXT: wire settings.json"}]}}
```

- [ ] **Step 2: Write the failing test `plugins/session-state/hooks/test/extract.test.js`**

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

test('facts: allowlist captures infra tools, drops noise and variable-assignment setup', () => {
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'docker build -t x .' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'terraform apply' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'F=/some/long/path' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'cd /w && git commit -m x' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'HAT="uv run --project /p hat"' } },
    ] } },
  ];
  const facts = extractFacts(entries);
  assert.ok(facts.includes('ran: docker build -t x .')); // recall: infra tool captured
  assert.ok(facts.includes('ran: terraform apply'));
  assert.ok(facts.includes('ran: cd /w && git commit -m x')); // captured via segment split
  assert.ok(!facts.some((f) => f.includes('ls -la'))); // noise dropped
  assert.ok(!facts.some((f) => f.startsWith('ran: F='))); // variable-assignment setup dropped
  assert.ok(!facts.some((f) => f.includes('HAT='))); // tool name only inside a value -> dropped
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

Run: `node --test plugins/session-state/hooks/test/extract.test.js`
Expected: FAIL — `Cannot find module '../lib/extract'`.

- [ ] **Step 4: Write `plugins/session-state/hooks/lib/extract.js`**

```js
'use strict';
const { TAG_RE, MEANINGFUL_BASH_RE } = require('./config');

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
      // Split on &&/||/;/| and test each segment's leading token against the
      // allowlist, so "cd dir && git commit" is captured but a VAR="...tool..."
      // assignment (tool name only inside the value) is not.
      const cmd = String(input.command || '').split('\n')[0].trim();
      const segments = cmd.split(/&&|\|\||[;|]/).map((s) => s.trim());
      if (cmd && segments.some((s) => MEANINGFUL_BASH_RE.test(s))) {
        facts.push(`ran: ${cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd}`);
      }
    } else if (item.name === 'TaskCreate' || item.name === 'TaskUpdate') {
      const title = input.title || input.task || input.description || '(task)';
      const status = input.status ? ` [${input.status}]` : '';
      facts.push(`task: ${title}${status}`);
    }
  }
  return facts;
}

// Harvest tagged lines from a text blob into an accumulator.
function harvestTags(text, acc) {
  for (const raw of String(text).split('\n')) {
    const m = raw.trim().match(TAG_RE);
    if (!m) continue;
    const body = m[2].trim();
    if (!body) continue;
    const tag = m[1].toUpperCase();
    if (tag === 'DECISION') acc.decisions.push(body);
    else if (tag === 'OPEN-LOOP') acc.openLoops.push(body);
    else if (tag === 'NEXT') acc.nexts.push(body);
    else if (tag === 'RESOLVED') acc.resolved.push(body);
  }
  return acc;
}

function emptyRationale() {
  return { decisions: [], openLoops: [], nexts: [], resolved: [] };
}

// Rationale from tagged lines across all assistant-text items in the delta.
function extractRationale(entries) {
  const acc = emptyRationale();
  for (const item of assistantItems(entries)) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
    harvestTags(item.text, acc);
  }
  return acc;
}

// Rationale from a single text blob, e.g. the Stop hook's last_assistant_message
// (captures the just-finished turn even if it has not flushed to the transcript).
function extractRationaleText(text) {
  const acc = emptyRationale();
  if (text) harvestTags(text, acc);
  return acc;
}

module.exports = { extractFacts, extractRationale, extractRationaleText };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test plugins/session-state/hooks/test/extract.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/session-state/hooks/lib/extract.js plugins/session-state/hooks/test/extract.test.js plugins/session-state/hooks/test/fixtures/sample.jsonl
git commit -m "feat: fact and rationale extractors"
```

---

### Task 3: State model + compaction

**Files:**
- Create: `plugins/session-state/hooks/lib/state.js`
- Test: `plugins/session-state/hooks/test/state.test.js`

**Interfaces:**
- Consumes: rationale + facts as produced by Task 2.
- Produces: `emptyModel() -> { offset, openLoops, decisions, nexts, facts }` (arrays, offset 0).
- Produces: `topicKey(decision: string) -> string` (leading `[...]` lowercased, else first four words).
- Produces: `mergeModel(prev, { decisions, openLoops, nexts, resolved, facts }) -> model` (bounded per the caps; `resolved` closes matching open loops; decisions are latest-per-topic; facts are a ring buffer).
- Produces: `renderMarkdown(sessionId: string, model) -> string`.

- [ ] **Step 1: Write the failing test `plugins/session-state/hooks/test/state.test.js`**

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

test('RESOLVED matches normalized-exact only, so a short token cannot close unrelated loops', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ openLoops: ['write integration tests', 'verify the injector'] }));
  m = mergeModel(m, delta({ resolved: ['tests'] }));
  assert.equal(m.openLoops.length, 2); // short token closes nothing
  m = mergeModel(m, delta({ resolved: ['Write Integration Tests'] }));
  assert.deepEqual(m.openLoops, ['verify the injector']); // case/space-insensitive exact
});

test('open loops dedup: the same loop from two sources collapses to one', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ openLoops: ['verify the injector', 'verify the injector'] }));
  assert.deepEqual(m.openLoops, ['verify the injector']);
});

test('facts are a bounded ring buffer', () => {
  let m = emptyModel();
  const many = Array.from({ length: 50 }, (_, i) => `edited f${i}.js`);
  m = mergeModel(m, delta({ facts: many }));
  assert.equal(m.facts.length, 40);
  assert.equal(m.facts[0], 'edited f10.js'); // oldest 10 dropped
});

test('facts dedup: churn collapses and cannot evict high-signal facts', () => {
  let m = emptyModel();
  const churn = Array.from({ length: 45 }, () => 'edited LEDGER.md');
  m = mergeModel(m, delta({ facts: ['ran: git commit -m x', 'ran: gh pr create', ...churn] }));
  assert.equal(m.facts.filter((f) => f === 'edited LEDGER.md').length, 1);
  assert.ok(m.facts.includes('ran: git commit -m x'));
  assert.ok(m.facts.includes('ran: gh pr create'));
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

Run: `node --test plugins/session-state/hooks/test/state.test.js`
Expected: FAIL — `Cannot find module '../lib/state'`.

- [ ] **Step 3: Write `plugins/session-state/hooks/lib/state.js`**

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

// Normalize for exact open-loop/resolved matching (whitespace + case).
function normalizeText(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Keep the most-recent occurrence of each distinct item (by key), order preserved.
function dedupeLatest(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const k = keyFn(items[i]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.unshift(items[i]);
  }
  return out;
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

  // Keep the most-recent occurrence of each distinct item, then cap, so churn
  // (repeated edits, or a tag harvested from both the transcript and the Stop
  // hook's last_assistant_message) cannot evict higher-signal entries.
  m.facts = dedupeLatest(m.facts.concat(d.facts), (f) => f).slice(-FACTS_CAP);

  m.openLoops = m.openLoops.concat(d.openLoops);
  for (const r of d.resolved) {
    const rn = normalizeText(r);
    m.openLoops = m.openLoops.filter((o) => normalizeText(o) !== rn);
  }
  m.openLoops = dedupeLatest(m.openLoops, normalizeText).slice(-OPEN_LOOPS_CAP);

  for (const dec of d.decisions) {
    const k = topicKey(dec);
    m.decisions = m.decisions.filter((x) => topicKey(x) !== k);
    m.decisions.push(dec);
  }
  m.decisions = m.decisions.slice(-DECISIONS_CAP);

  m.nexts = dedupeLatest(m.nexts.concat(d.nexts), normalizeText).slice(-NEXTS_CAP);
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

Run: `node --test plugins/session-state/hooks/test/state.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/session-state/hooks/lib/state.js plugins/session-state/hooks/test/state.test.js
git commit -m "feat: bounded state model with compaction"
```

---

### Task 4: Writer hook (Stop)

**Files:**
- Create: `plugins/session-state/hooks/session-state-writer.js`
- Test: `plugins/session-state/hooks/test/writer.test.js`

**Interfaces:**
- Consumes: `readDelta` (Task 1), `extractFacts`/`extractRationale`/`extractRationaleText` (Task 2), `emptyModel`/`mergeModel`/`renderMarkdown` (Task 3).
- Behavior: reads stdin JSON `{ session_id, transcript_path, last_assistant_message }`; resolves `stateDir = dirname(transcript_path)/state`; loads `state/<id>.json` (or `emptyModel`); reads the delta from `model.offset`; merges; writes `state/<id>.json`, `state/<id>.md`, `state/_latest.md`; exits 0 always.

- [ ] **Step 1: Write the failing test `plugins/session-state/hooks/test/writer.test.js`**

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

test('harvests tags from last_assistant_message and dedups against the transcript', () => {
  const { proj, transcript, id } = setup();
  // Transcript already carries one open loop (the flushed path)...
  fs.writeFileSync(
    transcript,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"OPEN-LOOP: enable the plugin"}]}}\n'
  );
  // ...and stdin carries the same loop (unflushed path) plus a new decision.
  execFileSync('node', [WRITER], {
    input: JSON.stringify({
      session_id: id,
      transcript_path: transcript,
      last_assistant_message: 'OPEN-LOOP: enable the plugin\nDECISION: [scope] ship v1',
    }),
  });
  const model = JSON.parse(fs.readFileSync(path.join(proj, 'state', `${id}.json`), 'utf8'));
  assert.equal(model.openLoops.filter((o) => o === 'enable the plugin').length, 1); // deduped
  assert.ok(model.decisions.includes('[scope] ship v1')); // harvested from stdin
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/session-state/hooks/test/writer.test.js`
Expected: FAIL — cannot find `session-state-writer.js`.

- [ ] **Step 3: Write `plugins/session-state/hooks/session-state-writer.js`**

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readDelta } = require('./lib/transcript');
const { extractFacts, extractRationale, extractRationaleText } = require('./lib/extract');
const { emptyModel, mergeModel, renderMarkdown } = require('./lib/state');

function main() {
  const { session_id, transcript_path, last_assistant_message } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!session_id || !transcript_path) return;

  const sid = path.basename(String(session_id));
  const stateDir = path.join(path.dirname(transcript_path), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonPath = path.join(stateDir, `${sid}.json`);
  const mdPath = path.join(stateDir, `${sid}.md`);
  const latestPath = path.join(stateDir, '_latest.md');

  let model = emptyModel();
  try {
    model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    /* first run for this session */
  }

  const { entries, newOffset } = readDelta(transcript_path, model.offset || 0);
  const facts = extractFacts(entries);
  const rationale = extractRationale(entries);
  // Also harvest tags from the just-finished turn via stdin, in case it has not
  // yet flushed to the transcript; downstream dedup absorbs the overlap.
  const msgRationale = extractRationaleText(last_assistant_message);
  for (const key of ['decisions', 'openLoops', 'nexts', 'resolved']) {
    rationale[key].push(...msgRationale[key]);
  }
  model = mergeModel(model, { ...rationale, facts });
  model.offset = newOffset;

  fs.writeFileSync(jsonPath, JSON.stringify(model));
  const md = renderMarkdown(sid, model);
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

Run: `node --test plugins/session-state/hooks/test/writer.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/session-state/hooks/session-state-writer.js plugins/session-state/hooks/test/writer.test.js
git commit -m "feat: Stop hook writes and rolls session state"
```

---

### Task 5: Injector hook (SessionStart)

**Files:**
- Create: `plugins/session-state/hooks/session-state-injector.js`
- Test: `plugins/session-state/hooks/test/injector.test.js`

**Interfaces:**
- Consumes: `RECENCY_HOURS` (Task 1); the files written by Task 4.
- Behavior: reads stdin JSON `{ session_id, transcript_path, source }`; `resume`/`compact` -> pick `state/<id>.md`; `startup` -> pick `state/_latest.md` under a prior-session header only if its mtime is within `RECENCY_HOURS`; the picked state (if any) plus a one-line tag-convention reminder are printed on every run (the hook's matcher restricts firing to `startup|resume|compact`); exit 0 always.

- [ ] **Step 1: Write the failing test `plugins/session-state/hooks/test/injector.test.js`**

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

test('resume prints the session state file plus the tag convention', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(path.join(stateDir, `${id}.md`), 'STATE-BODY');
  const out = run({ session_id: id, transcript_path: transcript, source: 'resume' });
  assert.ok(out.includes('STATE-BODY'));
  assert.ok(out.includes('DECISION:')); // convention reminder always present
});

test('startup prints _latest under a prior-session header when recent', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(path.join(stateDir, '_latest.md'), 'ROLLING-BODY');
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(out.includes('Prior session state'));
  assert.ok(out.includes('ROLLING-BODY'));
  assert.ok(out.includes('DECISION:'));
});

test('startup with a stale _latest emits only the convention', () => {
  const { transcript, stateDir, id } = setup();
  const p = path.join(stateDir, '_latest.md');
  fs.writeFileSync(p, 'OLD');
  const old = Date.now() / 1000 - 72 * 3600;
  fs.utimesSync(p, old, old);
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(!out.includes('OLD'));
  assert.ok(out.includes('DECISION:'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/session-state/hooks/test/injector.test.js`
Expected: FAIL — cannot find `session-state-injector.js`.

- [ ] **Step 3: Write `plugins/session-state/hooks/session-state-injector.js`**

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { RECENCY_HOURS } = require('./lib/config');

const CONVENTION =
  'Tag durable decisions and open items inline so a hook can persist them across sessions: ' +
  '`DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:`.';

function pickState(stateDir, sessionId, source) {
  if (source === 'resume' || source === 'compact') {
    const p = path.join(stateDir, `${sessionId}.md`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  if (source === 'startup') {
    const p = path.join(stateDir, '_latest.md');
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      return '';
    }
    if ((Date.now() - stat.mtimeMs) / 3.6e6 > RECENCY_HOURS) return '';
    const header =
      '# Prior session state in this project — verify relevance before relying on it\n\n';
    return header + fs.readFileSync(p, 'utf8');
  }
  return '';
}

function main() {
  const { session_id, transcript_path, source } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!transcript_path) return;
  const stateDir = path.join(path.dirname(transcript_path), 'state');
  const state = pickState(stateDir, path.basename(String(session_id)), source);
  const parts = [];
  if (state) parts.push(state);
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test plugins/session-state/hooks/test/injector.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/session-state/hooks/session-state-injector.js plugins/session-state/hooks/test/injector.test.js
git commit -m "feat: SessionStart hook injects session or rolling state"
```

---

### Task 6: Package as a Claude Code plugin

**Files:**
- Create: `plugins/session-state/.claude-plugin/plugin.json`
- Create: `plugins/session-state/hooks/hooks.json`
- Create: `.claude-plugin/marketplace.json`
- Modify: `README.md` (add the plugins/ layout line and a short install note)

**Interfaces:**
- Consumes: the two hook entry points from Tasks 4-5, wired via `plugins/session-state/hooks/hooks.json`'s `${CLAUDE_PLUGIN_ROOT}`-relative commands.
- Produces: an installable plugin (`plugin.json` + `hooks.json`) listed in the repo-root `marketplace.json`.

- [ ] **Step 1: Run the full suite green**

Run: `node --test plugins/session-state/hooks/test/*.test.js`
Expected: PASS, all files.

- [ ] **Step 2: Write `plugins/session-state/.claude-plugin/plugin.json`**

```json
{
  "name": "session-state",
  "version": "0.1.0",
  "description": "Persist per-session state from the transcript and re-inject it on resume, compaction, or a fresh session.",
  "author": { "name": "arinyaho", "url": "https://github.com/arinyaho" },
  "homepage": "https://github.com/arinyaho/concord",
  "repository": "https://github.com/arinyaho/concord",
  "license": "MIT",
  "keywords": ["hooks", "session-state", "context", "harness", "claude-code"]
}
```

- [ ] **Step 3: Write `plugins/session-state/hooks/hooks.json`**

```json
{
  "description": "Persist per-session state from the transcript and re-inject it on session start.",
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-state-writer.js\"" } ] }
    ],
    "SessionStart": [
      { "matcher": "startup|resume|compact", "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-state-injector.js\"" } ] }
    ]
  }
}
```

- [ ] **Step 4: Write the repo-root `.claude-plugin/marketplace.json`**

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "arinyaho-concord",
  "description": "Harness-engineering tooling for the Claude Code workflow.",
  "owner": { "name": "arinyaho", "url": "https://github.com/arinyaho" },
  "plugins": [
    {
      "name": "session-state",
      "description": "Persist per-session state from the transcript and re-inject it on resume, compaction, or a fresh session, so the model stops re-reading its own transcript.",
      "author": { "name": "arinyaho" },
      "category": "development",
      "source": "./plugins/session-state",
      "homepage": "https://github.com/arinyaho/concord"
    }
  ]
}
```

- [ ] **Step 5: Update `README.md`**

Add a line documenting the `plugins/` layout, plus a short install section: add the marketplace with `/plugin marketplace add arinyaho/concord`, then install with `/plugin install session-state@arinyaho-concord`; enabling the plugin registers the Stop and SessionStart hooks automatically, with no `settings.json` editing required.

- [ ] **Step 6: Dogfood in a live session**

Enable the plugin, run a session with a few tool calls and one `DECISION:` line, then end the turn. Confirm `~/.claude/projects/<slug>/state/<session_id>.md` lists the activity and the decision. Resume the session and confirm the injector output (state + tag convention) appears in context without a transcript re-read. Start a fresh session in the same project within `RECENCY_HOURS` and confirm the prior-session block plus the convention are injected.

- [ ] **Step 7: Commit**

```bash
git add plugins/session-state/.claude-plugin/plugin.json plugins/session-state/hooks/hooks.json .claude-plugin/marketplace.json README.md
git commit -m "feat: package session-state as a Claude Code plugin"
```

---

## Self-Review

**Spec coverage:**
- Layer 1 facts -> Task 2 `extractFacts`. Layer 2 tagged rationale -> Task 2 `extractRationale`.
- Byte-offset watermark + append-only reset -> Task 1 `readDelta`.
- Bounded compaction (facts ring, latest-per-topic decisions, resolved closes loops) -> Task 3.
- Writer side effects + `_latest.md` roll -> Task 4. Injector resume/compact/startup gating + recency + label -> Task 5.
- Project-agnostic paths -> every hook derives `stateDir` from `transcript_path` (Tasks 4-5).
- Plugin packaging (hooks.json + plugin.json + marketplace.json) -> Task 6; tag convention injected by the SessionStart hook -> Task 5.
- Zero model tokens on write -> writer never writes to stdout (Task 4).

**Deferred (matches spec, not built here):** exit-status on `ran:` facts (needs tool_result correlation), `pr-link` entry-type as a PR source, PreCompact nudge, generalized in-repo corpus diagnostic.

**Placeholder scan:** none — every step has concrete code or an exact command.

**Type consistency:** `readDelta -> {entries, newOffset}` consumed in Task 4; `mergeModel(prev, {decisions, openLoops, nexts, resolved, facts})` matches `extractRationale` keys plus `facts`; `renderMarkdown(sessionId, model)` used by the writer. Model shape `{offset, openLoops, decisions, nexts, facts}` is consistent across Tasks 3-5.
