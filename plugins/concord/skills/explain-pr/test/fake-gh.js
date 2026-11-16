'use strict';
// A fake `gh` on PATH that serves one pull request from world.json and records each call in calls.jsonl, after
// pr-to-merge's test world. Every list is one page. A `fail` pattern matched against the arguments makes the call fail
// with `failMessage` on stderr. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');

const FAKE_GH = (dir) => `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(dir + '/world.json', 'utf8'));
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(a) + '\\n');
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v) + '\\n');
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
if (w.fail && new RegExp(w.fail).test(a.join(' '))) fail(w.failMessage || 'HTTP 502: Bad Gateway');
const paged = (v) => out(a.includes('--slurp') ? [v] : v);
const url = a.slice(1).find((x, i, arr) => !x.startsWith('-') && !['-f', '-F'].includes(arr[i - 1]));
const pr = w.pr;
let m;
if (a[0] === 'pr' && a[1] === 'view') {
  const fields = a[a.indexOf('--json') + 1].split(',');
  out(Object.fromEntries(fields.map((f) => [f, pr[f]])));
} else if (a[0] === 'api' && url === 'user') out({ login: w.login });
else if (a[0] === 'api' && url === 'graphql') paged({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: w.threads } } } } });
else if (a[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+\\/comments$/.test(url)) paged(w.comments);
else if (a[0] === 'api' && (m = /^repos\\/([^/]+\\/[^/]+)\\/issues\\/(\\d+)$/.exec(url))) {
  const issue = w.issues[m[1] + '#' + m[2]];
  issue ? out(issue) : fail('HTTP 404: Not Found');
} else if (a[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/compare\\//.test(url)) out({ merge_base_commit: { sha: w.mergeBase } });
else if (a[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/commits\\/\\w+\\/check-runs$/.test(url)) paged({ total_count: w.checks.length, check_runs: w.checks });
else if (a[0] === 'api' && (m = /^repos\\/[^/]+\\/[^/]+\\/commits\\?(.*)$/.exec(url))) {
  const q = new URLSearchParams(m[1]);
  out(Array.from({ length: Math.min(100, (w.reader || {})[q.get('path')] || 0) }, (_, i) => ({ sha: 'c' + i })));
} else fail('unexpected gh call: ' + a.join(' '));
`;

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A local bare origin whose head commit is reachable only from refs/pull/<n>/head, and a clone of it made over the
// file transport, so `git fetch origin <oid>` really fetches. `base` and `files` map each path of the base and head
// commits to its content; in `files`, a value { link } makes a symlink and null deletes the path.
function gitPr(number, files, base = {}) {
  const dir = tempDir('xpr-git-');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  sh(work, 'init', '-q', '-b', 'main');
  for (const [p, content] of Object.entries({ 'base.txt': 'base\n', ...base })) {
    fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    fs.writeFileSync(path.join(work, p), content);
  }
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'base');
  const baseOid = sh(work, 'rev-parse', 'HEAD');
  sh(work, 'checkout', '-q', '-b', 'pr');
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    if (content === null) fs.rmSync(path.join(work, p));
    else if (typeof content.link === 'string') fs.symlinkSync(content.link, path.join(work, p));
    else fs.writeFileSync(path.join(work, p), content);
  }
  sh(work, 'add', '-A');
  sh(work, 'commit', '-q', '-m', 'head');
  const head = sh(work, 'rev-parse', 'HEAD');
  sh(work, 'checkout', '-q', 'main');
  const bare = path.join(dir, 'origin.git');
  sh(dir, 'clone', '-q', '--bare', work, bare);
  sh(bare, 'update-ref', `refs/pull/${number}/head`, head);
  sh(bare, 'branch', '-q', '-D', 'pr');
  const checkout = path.join(dir, 'checkout');
  sh(dir, 'clone', '-q', `file://${bare}`, checkout);
  return { head, base: baseOid, bare, checkout };
}

function world(data) {
  const dir = tempDir('xpr-world-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH(dir), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  const file = path.join(dir, 'world.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return {
    dir,
    bin: path.join(dir, 'bin'),
    update(fn) { const w = JSON.parse(fs.readFileSync(file, 'utf8')); fn(w); fs.writeFileSync(file, JSON.stringify(w)); },
    calls: () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

module.exports = { world, gitPr, sh };
