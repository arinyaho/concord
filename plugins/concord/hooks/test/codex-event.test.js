'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toNeutralEvent } = require('../../adapters/codex/event');

const CODEX_PLUGIN = path.join(__dirname, '..', '..', '..', 'concord-codex');
const CODEX_HOOKS = path.join(CODEX_PLUGIN, 'hooks.json');
const CODEX_WRITER = path.join(CODEX_PLUGIN, 'hooks', 'session-state-writer.js');

function runCodexWriter({ cwd, codexHome, event }) {
  return spawnSync('node', [CODEX_WRITER], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
}

function codexStateDir(codexHome, cwd) {
  return path.join(codexHome, 'concord', 'projects', fs.realpathSync(cwd).replace(/[/.]/g, '-'), 'state');
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('toNeutralEvent maps a Codex SessionStart payload', () => {
  assert.deepStrictEqual(
    toNeutralEvent({ session_id: 's1', transcript_path: '/r.jsonl', cwd: '/proj', source: 'startup' }),
    { sessionId: 's1', transcriptPath: '/r.jsonl', cwd: '/proj', source: 'startup' }
  );
});

test('toNeutralEvent(payload, "stop") overrides source', () => {
  const ev = toNeutralEvent({ session_id: 's1', transcript_path: '/r.jsonl', cwd: '/proj', source: 'startup' }, 'stop');
  assert.strictEqual(ev.source, 'stop');
  assert.strictEqual(ev.sessionId, 's1');
  assert.strictEqual(ev.cwd, '/proj');
});

test('Codex hook manifest uses the supported command-hook shape and CLAUDE_PLUGIN_ROOT for every command', () => {
  const manifest = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest).sort(), ['description', 'hooks']);
  assert.deepStrictEqual(manifest.hooks, {
    Stop: [
      { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-state-writer.js"' }] },
    ],
    SessionStart: [
      {
        matcher: 'startup|resume|compact',
        hooks: [
          { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-state-injector.js"' },
          { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/review-injector.js"' },
        ],
      },
    ],
  });
});

test('vendored Codex writer persists a normal Stop event in the cwd-derived CODEX_HOME state directory', (t) => {
  const project = tempDir(t, 'concord-codex-project-');
  const codexHome = tempDir(t, 'concord-codex-home-');
  const transcript = path.join(project, 'rollout.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DECISION: [scope] retain state' }] } })}\n`);

  const result = runCodexWriter({
    cwd: project,
    codexHome,
    event: { session_id: 'session-1', transcript_path: transcript },
  });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
  const statePath = path.join(codexStateDir(codexHome, project), 'session-1.json');
  assert.ok(fs.existsSync(statePath));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions, ['[scope] retain state']);
});

test('vendored Codex writer successfully no-ops when Stop event persistence fields are absent', (t) => {
  for (const event of [{ transcript_path: '/unused' }, { session_id: 'session-1' }]) {
    const project = tempDir(t, 'concord-codex-noop-project-');
    const codexHome = tempDir(t, 'concord-codex-noop-home-');
    const result = runCodexWriter({ cwd: project, codexHome, event });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(fs.existsSync(codexStateDir(codexHome, project)), false);
  }
});
