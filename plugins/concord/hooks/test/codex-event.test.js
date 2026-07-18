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

function runCodexLauncher({ hookEvent, hookIndex = 0, cwd, env }) {
  const manifest = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
  const command = manifest.hooks[hookEvent][0].hooks[hookIndex].command;
  const launcherEnv = { ...process.env };
  delete launcherEnv.PLUGIN_ROOT;
  delete launcherEnv.CLAUDE_PLUGIN_ROOT;
  return spawnSync('sh', ['-c', command], {
    cwd,
    env: { ...launcherEnv, ...env },
    input: '{}',
    encoding: 'utf8',
  });
}

function runCodexStopLauncher(options) {
  return runCodexLauncher({ hookEvent: 'Stop', ...options });
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

function codexLauncherCommand(script) {
  return `node -e 'const cp=require("child_process");const path=require("path");const root=process.env.PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT;if(!root)process.exit(0);const result=cp.spawnSync(process.execPath,[path.join(root,"hooks/${script}")],{stdio:"inherit"});if(result.error)throw result.error;process.exit(result.status??1)'`;
}

test('Codex hook manifest gives every command hook the shell-expansion-free Node launcher contract', () => {
  const manifest = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest).sort(), ['description', 'hooks']);
  assert.deepStrictEqual(manifest.hooks, {
    Stop: [
      { hooks: [{ type: 'command', command: codexLauncherCommand('session-state-writer.js') }] },
    ],
    SessionStart: [
      {
        matcher: 'startup|resume|compact',
        hooks: [
          { type: 'command', command: codexLauncherCommand('session-state-injector.js') },
          { type: 'command', command: codexLauncherCommand('review-injector.js') },
        ],
      },
    ],
  });
});

for (const [hookEvent, hookIndex, label] of [
  ['Stop', 0, 'Stop'],
  ['SessionStart', 0, 'SessionStart state injector'],
  ['SessionStart', 1, 'SessionStart review injector'],
]) {
test(`Codex ${label} launcher uses PLUGIN_ROOT when provided`, (t) => {
  const project = tempDir(t, 'concord-codex-launcher-project-');
  const codexHome = tempDir(t, 'concord-codex-launcher-home-');
  const result = runCodexLauncher({
    hookEvent,
    hookIndex,
    cwd: project,
    env: { PLUGIN_ROOT: CODEX_PLUGIN, CODEX_HOME: codexHome },
  });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
});

test(`Codex ${label} launcher falls back to CLAUDE_PLUGIN_ROOT`, (t) => {
  const project = tempDir(t, 'concord-codex-launcher-project-');
  const codexHome = tempDir(t, 'concord-codex-launcher-home-');
  const result = runCodexLauncher({
    hookEvent,
    hookIndex,
    cwd: project,
    env: { CLAUDE_PLUGIN_ROOT: CODEX_PLUGIN, CODEX_HOME: codexHome },
  });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
});

test(`Codex ${label} launcher prioritizes PLUGIN_ROOT over CLAUDE_PLUGIN_ROOT`, (t) => {
  const project = tempDir(t, 'concord-codex-launcher-project-');
  const codexHome = tempDir(t, 'concord-codex-launcher-home-');
  const invalidRoot = path.join(project, 'missing-plugin-root');
  const result = runCodexLauncher({
    hookEvent,
    hookIndex,
    cwd: project,
    env: {
      PLUGIN_ROOT: invalidRoot,
      CLAUDE_PLUGIN_ROOT: CODEX_PLUGIN,
      CODEX_HOME: codexHome,
    },
  });

  assert.notStrictEqual(result.status, 0);
});

test(`Codex ${label} launcher preserves a node failure for an invalid sole root`, (t) => {
  const project = tempDir(t, 'concord-codex-launcher-project-');
  const invalidRoot = path.join(project, 'missing-plugin-root');
  const result = runCodexLauncher({
    hookEvent,
    hookIndex,
    cwd: project,
    env: { PLUGIN_ROOT: invalidRoot },
  });

  assert.notStrictEqual(result.status, 0);
});

test(`Codex ${label} launcher successfully no-ops without a plugin root`, (t) => {
  const project = tempDir(t, 'concord-codex-launcher-project-');
  const result = runCodexLauncher({ hookEvent, hookIndex, cwd: project, env: {} });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
});
}

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

const codexE2ETest = process.env.CONCORD_RUN_CODEX_HOOK_E2E === '1' ? test : test.skip;

codexE2ETest('project-hook host-runner contract runs explicit PLUGIN_ROOT without Stop hook failure', (t) => {
  const project = tempDir(t, 'concord-codex-hook-e2e-');
  const codexDir = path.join(project, '.codex');
  const trustConfig = `projects.${JSON.stringify(project)}.trust_level="trusted"`;
  fs.mkdirSync(codexDir);
  fs.copyFileSync(CODEX_HOOKS, path.join(codexDir, 'hooks.json'));

  // This is not plugin-installation coverage. Project-local hooks do not receive
  // plugin variables automatically, so pass PLUGIN_ROOT explicitly to exercise
  // Codex's project-hook command runner with the worktree's command form.
  const git = spawnSync('git', ['init', '--quiet', project], { encoding: 'utf8' });
  assert.strictEqual(git.status, 0, `temporary git init exit status: ${git.status}`);

  const result = spawnSync('codex', [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--dangerously-bypass-hook-trust',
    '--config',
    trustConfig,
    'Reply exactly: OK',
  ], {
    cwd: project,
    env: { ...process.env, PLUGIN_ROOT: CODEX_PLUGIN },
    encoding: 'utf8',
    timeout: 120000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const stopFailures = (output.match(/hook: Stop Failed/g) || []).length;

  assert.strictEqual(result.status, 0, `codex exec exit status: ${result.status}`);
  assert.strictEqual(stopFailures, 0, `hook: Stop Failed count: ${stopFailures}`);
});
