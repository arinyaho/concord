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
  // POSIX sh launcher: resolve the plugin root from the environment (plain $VAR, never
  // ${a:-b}, so Codex's manifest expander leaves it intact), then DISCOVER node even when
  // it is absent from a scrubbed hook PATH (Codex spawns hooks with a minimal PATH that
  // excludes nvm's node dir). Failing SOFT with exit 0 whenever the root or interpreter
  // cannot be found means a missing node never turns session start into a hook failure.
  return `sh -c 'r="$PLUGIN_ROOT"; [ -n "$r" ] || r="$CLAUDE_PLUGIN_ROOT"; [ -n "$r" ] || exit 0; n="$(command -v node 2>/dev/null)"; [ -n "$n" ] || { for c in "$NVM_BIN/node" "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$c" ] && { n="$c"; break; }; done; }; [ -n "$n" ] || exit 0; exec "$n" "$r/hooks/${script}"'`;
}

test('Codex hook manifest gives every command hook the PATH-independent node-discovery launcher contract', () => {
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

// Codex spawns hooks with a scrubbed PATH that excludes nvm's node dir, so the launcher
// must discover node itself. These run each command with node reachable ONLY via a fake
// $HOME/.nvm tree (never on PATH) -- the exact condition a bare-`node` command form cannot
// survive, which is why SessionStart hooks reported "exited with code 1" on Codex resume.
function fakeNvmHome(t) {
  const home = tempDir(t, 'concord-codex-scrubbed-home-');
  const binDir = path.join(home, '.nvm', 'versions', 'node', 'v-test', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
  return home;
}

function runCodexLauncherScrubbed({ hookEvent, hookIndex = 0, cwd, home, env }) {
  const manifest = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
  const command = manifest.hooks[hookEvent][0].hooks[hookIndex].command;
  return spawnSync('sh', ['-c', command], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, ...env }, // node is NOT on this PATH
    input: '{}',
    encoding: 'utf8',
  });
}

for (const [hookEvent, hookIndex, label] of [
  ['Stop', 0, 'Stop'],
  ['SessionStart', 0, 'SessionStart state injector'],
  ['SessionStart', 1, 'SessionStart review injector'],
]) {
test(`Codex ${label} launcher discovers node off a scrubbed PATH`, (t) => {
  const project = tempDir(t, 'concord-codex-scrubbed-project-');
  const codexHome = tempDir(t, 'concord-codex-scrubbed-codexhome-');
  const home = fakeNvmHome(t);
  const result = runCodexLauncherScrubbed({
    hookEvent, hookIndex, cwd: project, home,
    env: { PLUGIN_ROOT: CODEX_PLUGIN, CODEX_HOME: codexHome },
  });
  assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
});
}

test('Codex Stop launcher actually runs the writer when node is only reachable off a scrubbed PATH', (t) => {
  const project = tempDir(t, 'concord-codex-scrubbed-run-project-');
  const codexHome = tempDir(t, 'concord-codex-scrubbed-run-home-');
  const home = fakeNvmHome(t);
  const transcript = path.join(project, 'rollout.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DECISION: [scope] discovered off PATH' }] } })}\n`);
  const manifest = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
  const command = manifest.hooks.Stop[0].hooks[0].command;
  const result = spawnSync('sh', ['-c', command], {
    cwd: project,
    env: { PATH: '/usr/bin:/bin', HOME: home, PLUGIN_ROOT: CODEX_PLUGIN, CODEX_HOME: codexHome },
    input: JSON.stringify({ session_id: 'scrubbed-1', transcript_path: transcript }),
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  const statePath = path.join(codexStateDir(codexHome, project), 'scrubbed-1.json');
  assert.ok(fs.existsSync(statePath), 'writer did not persist state under a scrubbed PATH');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions, ['[scope] discovered off PATH']);
});

test('Codex launcher fails soft (exit 0) when node cannot be found anywhere', (t) => {
  const project = tempDir(t, 'concord-codex-nonode-project-');
  const home = tempDir(t, 'concord-codex-nonode-home-'); // no .nvm tree inside
  const manifest = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
  const command = manifest.hooks.SessionStart[0].hooks[0].command;
  const result = spawnSync('sh', ['-c', command], {
    cwd: project,
    // Standard PATH so `sh` resolves, but node is not on it (nor via NVM_BIN or $HOME/.nvm).
    env: { PATH: '/usr/bin:/bin', HOME: home, NVM_BIN: '', PLUGIN_ROOT: CODEX_PLUGIN },
    input: '{}',
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
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
