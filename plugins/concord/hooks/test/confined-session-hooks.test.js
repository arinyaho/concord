'use strict';
// The state hooks of both plugins harvest nothing and print nothing in a confined agent or headless session: a working
// directory under pr-to-merge's session-worktree root, a marked round directory, or (Claude Code) a confined mode file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { writeMode } = require('../../core/read-only');

const HOOKS = { claude: path.join(__dirname, '..'), codex: path.join(__dirname, '..', '..', '..', 'concord-codex', 'hooks') };
const DECISION = 'DECISION: harvested from a confined session';
const LINES = {
  claude: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: DECISION }] } },
  codex: { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: DECISION }] } },
};

function setup(harness) {
  const home = tempDir('csh-');
  const config = path.join(home, harness === 'claude' ? '.claude' : '.codex');
  const env = { ...process.env, HOME: home, [harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: config };
  delete env.EXPLAIN_PR_DIR;
  delete env[harness === 'claude' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
  const transcript = path.join(home, 'project', 'sess.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify(LINES[harness])}\n`);
  const dirs = {
    session: path.join(config, 'concord', 'pr-to-merge', 'sessions', '1-abc', 'worktree'),
    marked: path.join(config, 'concord', 'explain-pr', 'prs', 'o__r__1__round', 'head'),
    unmarked: path.join(config, 'concord', 'explain-pr', 'prs', 'o__r__2__round', 'head'),
    plain: path.join(home, 'project'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(config, 'concord', 'explain-pr', 'prs', 'o__r__1__round', '.concord-confined-agent'), '');
  // Each hook runs with the session's working directory, as both harnesses run them.
  const hook = (name, cwd, sid = 'sid1') => spawnSync(process.execPath, [path.join(HOOKS[harness], name)], {
    cwd, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd, source: 'startup', last_assistant_message: DECISION }),
  });
  // Every state file either writer has left anywhere under the home.
  const stateFiles = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/^sid\d\.json$/.test(e.name)) out.push(f); } };
    walk(home);
    return out;
  };
  return { home, config, dirs, hook, stateFiles, env };
}

for (const harness of ['claude', 'codex']) {
  test(`${harness}: in a session-worktree or marked round directory the Stop hook harvests nothing and SessionStart prints nothing`, () => {
    const s = setup(harness);
    // A pending watcher line, which SessionStart would otherwise print.
    fs.mkdirSync(path.join(s.config, 'concord', 'notices'), { recursive: true });
    fs.writeFileSync(path.join(s.config, 'concord', 'notices', '000000000000001-aaaaaaaaaaaa.json'), JSON.stringify({ skill: 'pr-to-merge', line: 'ready acme/app#1 head abc', at: 'x' }));
    for (const dir of [s.dirs.session, s.dirs.marked]) {
      const stop = s.hook('session-state-writer.js', dir);
      assert.equal(stop.status, 0);
      assert.equal(stop.stdout, '');
      assert.deepEqual(s.stateFiles(), [], `${dir}: nothing harvested`);
      const start = s.hook('session-state-injector.js', dir);
      assert.equal(start.status, 0);
      assert.equal(start.stdout, '', `${dir}: nothing printed`);
    }
    // The same hooks in an ordinary directory, and in a round directory without the marker (a reading session), work.
    for (const dir of [s.dirs.plain, s.dirs.unmarked]) {
      assert.equal(s.hook('session-state-writer.js', dir).status, 0);
      const start = s.hook('session-state-injector.js', dir);
      assert.match(start.stdout, /harvested from a confined session/, dir);
      assert.match(start.stdout, /ready acme\/app#1/, dir);
    }
    assert.ok(s.stateFiles().length >= 1);
  });
}

test('claude: a session with a confined mode file (an agent started in a scratch directory) harvests and prints nothing', () => {
  const s = setup('claude');
  const modes = path.join(s.config, 'concord', 'explain-pr');
  writeMode(modes, 'sid2', { kind: 'agent', dir: s.dirs.unmarked, output: path.join(s.home, 'o.json'), canary: path.join(s.home, 'c'), log: path.join(s.home, 'l') });
  assert.equal(s.hook('session-state-writer.js', s.dirs.plain, 'sid2').stdout, '');
  assert.deepEqual(s.stateFiles(), []);
  assert.equal(s.hook('session-state-injector.js', s.dirs.plain, 'sid2').stdout, '');
  // explain-pr's own reading session keeps its hooks: its injector prints.
  writeMode(modes, 'sid3', { kind: 'read', dir: s.dirs.unmarked });
  assert.match(s.hook('session-state-injector.js', s.dirs.plain, 'sid3').stdout, /DECISION:/);
});
