'use strict';
// A test world for review-until-approve.js: a local bare origin served through git's `url.<base>.insteadOf`, a fake
// `gh` on PATH that serves one pull request from world.json (and changes it as GitHub would on a review, a reply, a
// comment, or a label), and a fake `claude` whose reviewer and verifier outputs come from agents.json. Every gh call is
// recorded in calls.jsonl and every agent start in agents.jsonl. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');
const { stateLine } = require('../scripts/review-until-approve');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'review-until-approve.js');
const TOKEN = 'ghp_testtoken0123456789abcdef';

const FAKE_GH = (dir) => `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
const file = dir + '/world.json';
const w = JSON.parse(fs.readFileSync(file, 'utf8'));
const input = a.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ a, input }) + '\\n');
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const save = () => fs.writeFileSync(file, JSON.stringify(w));
const field = (k) => { const i = a.findIndex((x, j) => ['-f', '-F'].includes(a[j - 1]) && x.startsWith(k + '=')); return i < 0 ? undefined : a[i].slice(k.length + 1); };
const url = a.slice(1).find((x, i, arr) => !x.startsWith('-') && !['-X', '-f', '-F', '--input'].includes(arr[i - 1]));
const method = a.includes('-X') ? a[a.indexOf('-X') + 1] : 'GET';
const now = () => new Date(Date.now() + (w.clock = (w.clock || 0) + 1000)).toISOString();
const git = (...args) => execFileSync('git', ['-C', dir + '/remote/o/r.git', ...args], { encoding: 'utf8' }).trim();
// A failure is { match, times, status, after }: the matching call fails that many times; with after, it fails only
// after it took effect.
let after = null;
for (const f of w.fail || []) {
  if (!new RegExp(f.match).test(method + ' ' + a.join(' ')) || f.times === 0) continue;
  if (f.times) f.times -= 1;
  save();
  if (f.after) after = f; else fail('gh: HTTP ' + (f.status || '502'));
}
const done = (v) => { save(); if (after) fail('gh: HTTP ' + (after.status || '502')); out(v); };
const pr = w.pr;
let m;
if (a[0] === 'auth' && a[1] === 'token') console.log(${JSON.stringify(TOKEN)});
else if (a[0] === 'api' && url === 'user') w.login ? out({ login: w.login }) : fail('gh: HTTP 401');
else if (a[0] === 'api' && url === 'graphql') {
  const q = field('query');
  if (/^mutation/.test(q)) {
    const t = w.threads.find((x) => x.id === field('id'));
    if (t) t.isResolved = /^mutation\\(\\$id:ID!\\)\\{resolve/.test(q);
    w.mutations = [...(w.mutations || []), q.match(/\\{(\\w+)\\(/)[1] + ' ' + field('id')];
    return done({ data: {} });
  }
  if (w.unreadable) fail('gh: GraphQL: Could not resolve to a Repository with the name');
  const page = (conn) => ({ data: { repository: { isPrivate: Boolean(w.private), pullRequest: { ...pr, ...conn } } } });
  if (/closingIssuesReferences/.test(q)) out({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: w.closing || [] } } } } });
  else if (/reviewThreads/.test(q)) out([page({ reviewThreads: { pageInfo: { hasNextPage: false }, nodes: w.threads } })]);
  else if (/reviews\\(/.test(q)) out([page({ reviews: { pageInfo: { hasNextPage: false }, nodes: w.reviews.filter((r) => r.author === field('login')) } })]);
  else out([page({ comments: { pageInfo: { hasNextPage: false }, nodes: w.comments } })]);
} else if (a[0] === 'api' && (m = /^repos\\/o\\/r\\/compare\\/(\\w+)\\.\\.\\.(\\w+)/.exec(url))) {
  const base = git('merge-base', m[1], m[2]);
  const status = base === m[2] ? (m[1] === m[2] ? 'identical' : 'behind') : base === m[1] ? 'ahead' : 'diverged';
  out({ merge_base_commit: { sha: base }, status });
} else if (a[0] === 'api' && /check-runs$/.test(url)) out([{ check_runs: w.checks || [] }]);
else if (a[0] === 'api' && (m = /collaborators\\/([^/]+)\\/permission$/.exec(url))) out({ permission: (w.perms || {})[m[1]] || 'read' });
else if (a[0] === 'api' && (m = /^repos\\/(.+)\\/issues\\/(\\d+)$/.exec(url))) { const i = (w.issues || {})[m[1] + '#' + m[2]]; i ? out(i) : fail('gh: HTTP 404'); }
else if (a[0] === 'api' && (m = /^repos\\/(.+)\\/commits\\/HEAD$/.exec(url))) { const r = (w.related || {})[m[1]]; r ? out({ sha: r }) : fail('gh: HTTP 404'); }
else if (method === 'POST' && url === 'repos/o/r/pulls/5/reviews') {
  const p = JSON.parse(input);
  const id = (w.nextId = (w.nextId || 100) + 1);
  const at = now();
  w.reviews.push({ databaseId: id, author: w.login, state: p.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED', body: p.body, submittedAt: at, lastEditedAt: null, url: pr.url + '#pullrequestreview-' + id, commit: { oid: p.commit_id } });
  for (const c of p.comments || []) {
    const cid = (w.nextId += 1);
    w.threads.push({ id: 'T' + cid, isResolved: false, path: c.path, line: c.line, comments: { nodes: [{ databaseId: cid, author: { login: w.login }, body: c.body, createdAt: at, lastEditedAt: null, url: pr.url + '#discussion_r' + cid }] } });
  }
  done({ id, html_url: pr.url + '#pullrequestreview-' + id });
} else if (method === 'POST' && (m = /^repos\\/o\\/r\\/pulls\\/5\\/comments\\/(\\d+)\\/replies$/.exec(url))) {
  const t = w.threads.find((x) => x.comments.nodes[0].databaseId === Number(m[1]));
  const cid = (w.nextId = (w.nextId || 100) + 1);
  t.comments.nodes.push({ databaseId: cid, author: { login: w.login }, body: JSON.parse(input).body, createdAt: now(), lastEditedAt: null, url: pr.url + '#discussion_r' + cid });
  done({ id: cid });
} else if (method === 'POST' && url === 'repos/o/r/issues/5/comments') {
  const cid = (w.nextId = (w.nextId || 100) + 1);
  w.comments.push({ databaseId: cid, author: { login: w.login }, body: JSON.parse(input).body, createdAt: now(), lastEditedAt: null, url: pr.url + '#issuecomment-' + cid });
  done({ id: cid });
} else if (method === 'POST' && url === 'repos/o/r/issues/5/labels') {
  pr.labels.nodes = [...pr.labels.nodes.filter((l) => l.name !== 'review-blocked'), { name: 'review-blocked' }];
  done([]);
} else if (method === 'DELETE' && url === 'repos/o/r/issues/5/labels/review-blocked') {
  pr.labels.nodes = pr.labels.nodes.filter((l) => l.name !== 'review-blocked');
  done([]);
} else if (a[0] === 'api' && /^gists/.test(url || '')) {
  // Gists of every account; the authenticated account lists its own. Without the gist scope (noGistScope) the list
  // holds only public gists and a write is refused, as GitHub does.
  w.gists = w.gists || [];
  const id = (/^gists\\/(\\w+)$/.exec(url) || [])[1];
  if (method === 'GET' && !id) out([w.gists.filter((g) => g.owner.login === w.login && (!w.noGistScope || g.public)).map(({ files, ...g }) => ({ ...g, files: Object.fromEntries(Object.keys(files).map((k) => [k, {}])) }))]);
  else if (w.noGistScope && method !== 'GET') fail('gh: HTTP 404');
  else if (method === 'GET') { const g = w.gists.find((x) => x.id === id); g ? out(g) : fail('gh: HTTP 404'); }
  else if (method === 'POST') {
    const p = JSON.parse(input);
    const at = now();
    const g = { id: 'g' + require('node:crypto').randomBytes(10).toString('hex'), owner: { login: w.login }, description: p.description, public: p.public !== false, created_at: at, updated_at: at, files: Object.fromEntries(Object.entries(p.files).map(([k, v]) => [k, { content: v.content }])) };
    w.gists.push(g);
    done(g);
  } else if (method === 'PATCH') {
    const g = w.gists.find((x) => x.id === id && x.owner.login === w.login);
    if (!g) fail('gh: HTTP 404');
    for (const [k, v] of Object.entries(JSON.parse(input).files)) g.files[k] = { content: v.content };
    g.updated_at = now();
    done(g);
  } else fail('unexpected gh call: ' + a.join(' '));
} else if (a[0] === 'api' && (m = /^repos\\/([\\w.-]+\\/[\\w.-]+)(\\/.*)?$/.exec((url || '').split('?')[0])) && m[1] !== 'o/r') {
  // Repositories other than the reviewed one: { owner, visibility, collaborators, files }.
  const r = (w.repos || {})[m[1]];
  if (!r) fail('gh: HTTP 404');
  const rest = m[2] || '';
  let c;
  if (!rest && method === 'GET') out({ full_name: m[1], owner: { login: r.owner }, visibility: r.visibility, private: r.visibility !== 'public' });
  else if (rest === '/collaborators' && method === 'GET') out([[{ login: r.owner }, ...(r.collaborators || []).map((login) => ({ login }))]]);
  else if ((c = /^\\/contents\\/(.+)$/.exec(rest))) {
    r.files = r.files || {};
    if (method === 'GET') r.files[c[1]] !== undefined ? out({ sha: 's' + r.files[c[1]].length, content: Buffer.from(r.files[c[1]]).toString('base64') }) : fail('gh: HTTP 404');
    else if (method === 'PUT') {
      const p = JSON.parse(input);
      if (r.files[c[1]] !== undefined && p.sha !== 's' + r.files[c[1]].length) fail('gh: HTTP 409');
      r.files[c[1]] = Buffer.from(p.content, 'base64').toString('utf8');
      done({ content: { path: c[1] } });
    } else fail('unexpected gh call: ' + a.join(' '));
  } else fail('unexpected gh call: ' + a.join(' '));
} else fail('unexpected gh call: ' + a.join(' '));
`;

// The fake agent: the reviewer or the verifier, told apart by its request; it reads the canary through the real
// read-only hook when the launcher registered one, then writes the next output of its role (null writes nothing).
const FAKE_AGENT = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const here = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(here, 'agents.json'), 'utf8'));
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const role = /Verification request/.test(prompt) ? 'verifier' : 'reviewer';
const sid = args[args.indexOf('--session-id') + 1];
const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
const mode = JSON.parse(fs.readFileSync(path.join(process.env.EXPLAIN_PR_DIR, 'modes', sid), 'utf8'));
const counter = path.join(here, role + '.count');
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
fs.appendFileSync(path.join(here, 'agents.jsonl'), JSON.stringify({ role, args: args.slice(0, -1), prompt, env: process.env, dir: mode.dir, files: fs.readdirSync(mode.dir) }) + '\\n');
if (b.start === 'fail') process.exit(1);
// Another round publishing while this one runs: a state review appears in the world before this agent finishes.
if (b.inject && role === 'verifier') {
  const w = JSON.parse(fs.readFileSync(b.inject.file, 'utf8'));
  if (b.inject.review) w.reviews.push(b.inject.review);
  if (b.inject.comment) w.comments.push(b.inject.comment);
  if (b.inject.reply) w.threads[0].comments.nodes.push(b.inject.reply);
  fs.writeFileSync(b.inject.file, JSON.stringify(w));
}
const hook = (tool_name, tool_input) => {
  const r = spawnSync(settings.hooks.PreToolUse[0].hooks[0].command, { shell: true, encoding: 'utf8', input: JSON.stringify({ session_id: sid, tool_name, tool_input }) });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'none';
};
if (b.start !== 'nohook') {
  hook('Read', { file_path: mode.canary });
  if (hook('Write', { file_path: mode.output }) !== 'allow') process.exit(1);
}
if (b.sleep) {
  fs.writeFileSync(path.join(here, 'sleeping'), String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, b.sleep);
}
const list = b[role] || [];
const output = list[Math.min(n, list.length - 1)];
if (output !== null && output !== undefined) fs.writeFileSync(mode.output, typeof output === 'string' ? output : JSON.stringify(output));
`;

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A repository whose `main` holds `base` files and whose pull request branch adds `files` (null deletes a path).
// Returns the world: its paths, commit helpers, and run().
function world({ base = { 'a.js': 'one\ntwo\nthree\n' }, files = { 'a.js': 'one\ntwo\nbad line\nthree\n' }, login = 'rev', author = 'dev', pr = {}, ...rest } = {}) {
  const dir = tempDir('rua-world-');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  sh(work, 'init', '-q', '-b', 'main');
  const put = (map) => {
    for (const [p, content] of Object.entries(map)) {
      const file = path.join(work, p);
      if (content === null) { fs.rmSync(file, { force: true }); continue; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    sh(work, 'add', '-A');
  };
  put(base);
  sh(work, 'commit', '-q', '-m', 'base');
  const mergeBase = sh(work, 'rev-parse', 'HEAD');
  sh(work, 'checkout', '-q', '-b', 'pr');
  put(files);
  sh(work, 'commit', '-q', '-m', 'change');
  const head = sh(work, 'rev-parse', 'HEAD');
  const bare = path.join(dir, 'remote', 'o', 'r.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  sh(dir, 'clone', '-q', '--bare', work, bare);
  sh(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH(dir), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_AGENT, { mode: 0o755 });
  // Fake system notifiers record each notification in notifications.jsonl.
  for (const n of ['osascript', 'notify-send']) fs.writeFileSync(path.join(bin, n), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(dir, 'notifications.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
  const config = path.join(dir, 'claude-config');
  const w = {
    login, private: false, reviews: [], threads: [], comments: [], perms: {}, fail: [],
    pr: { number: 5, state: 'OPEN', isDraft: false, title: 'Add a line', body: 'Adds a line.', url: 'https://github.com/o/r/pull/5', headRefOid: head, baseRefOid: mergeBase, author: { login: author }, labels: { nodes: [] }, ...pr },
    ...rest,
  };
  const save = (v) => fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(v));
  save(w);
  const self = {
    dir, work, bare, mergeBase, head, config, bin,
    read: () => JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')),
    update(fn) { const v = self.read(); fn(v); save(v); },
    agents(v) { fs.writeFileSync(path.join(bin, 'agents.json'), JSON.stringify(v)); for (const r of ['reviewer', 'verifier']) fs.rmSync(path.join(bin, `${r}.count`), { force: true }); },
    agentRuns: () => { try { return fs.readFileSync(path.join(bin, 'agents.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } },
    calls: () => { try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } },
    // A new commit on the pull request branch, pushed; the pull request's head moves to it.
    push(map, { merge } = {}) {
      if (merge) {
        sh(work, 'checkout', '-q', 'main');
        put(merge);
        sh(work, 'commit', '-q', '-m', 'base moves');
        const tip = sh(work, 'rev-parse', 'HEAD');
        sh(work, 'checkout', '-q', 'pr');
        sh(work, 'merge', '-q', '--no-edit', 'main');
        self.update((v) => { v.pr.baseRefOid = tip; });
      } else {
        put(map);
        sh(work, 'commit', '-q', '-m', 'more');
      }
      sh(work, 'push', '-q', '--force', bare, 'pr', 'main');
      const h = sh(work, 'rev-parse', 'HEAD');
      self.update((v) => { v.pr.headRefOid = h; });
      return h;
    },
    notifications: () => { try { return fs.readFileSync(path.join(dir, 'notifications.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } },
    // The environment every script run gets; `extra` is added last.
    env: (extra = {}) => ({
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp',
      CLAUDE_CONFIG_DIR: config, CODEX_HOME: path.join(dir, 'codex-home'), GH_TOKEN: TOKEN,
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.file://${path.join(dir, 'remote')}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always', ...extra,
    }),
    // `input` is the script's stdin (the notes `notes ... -` reads).
    run(args, env = {}, input = '') {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000, env: self.env(env), input });
      const out = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
    },
  };
  self.agents({ reviewer: [{ findings: [] }], verifier: [{ findings: [], verdicts: [] }] });
  return self;
}

// A state review of the account `login` carrying `state` (completed with defaults) on `head`.
function stateReview(w, state, { login = 'rev', at = new Date(Date.now() - 3600e3).toISOString(), event = 'COMMENTED', edited = null, id, body = 'Earlier review.' } = {}) {
  const s = fullState(w, state);
  const databaseId = id || Math.floor(Math.random() * 1e6) + 1000;
  return { databaseId, author: login, state: event, body: `${body}\n\n${stateLine(s)}`, submittedAt: at, lastEditedAt: edited, url: `https://github.com/o/r/pull/5#pullrequestreview-${databaseId}`, commit: { oid: s.head } };
}
function fullState(w, s = {}) {
  const crypto = require('node:crypto');
  const v = w.read();
  return {
    v: 1, round: 1, agents: true, head: v.pr.headRefOid, base: w.mergeBase, mergeBase: w.mergeBase,
    desc: crypto.createHash('sha256').update(`${v.pr.title}\n\n${v.pr.body}`).digest('hex'), notes: '', lang: '', seen: { issue: 0, review: 0 }, subs: [], findings: [], ...s,
  };
}
const finding = (w, f) => ({ key: '1.1', class: 'blocker', status: 'open', file: 'a.js', line: 3, raised: w.head, at: w.head, closed: null, closedRound: null, decided: false, ...f });
// A finding thread of the account for `key`, with the given replies ({ login, body, at, edited }).
function thread(key, replies = [], { login = 'rev', resolved = false, id = `T-${key}`, edited = null } = {}) {
  const cid = Math.floor(Math.random() * 1e6) + 2000;
  return {
    id, isResolved: resolved, path: 'a.js', line: 3,
    comments: { nodes: [
      { databaseId: cid, author: { login }, body: `<!-- review-until-approve:finding ${key} -->\n**blocker** \`${key}\``, createdAt: new Date(Date.now() - 7200e3).toISOString(), lastEditedAt: edited, url: `https://github.com/o/r/pull/5#discussion_r${cid}` },
      ...replies.map((r, i) => ({ databaseId: cid + i + 1, author: { login: r.login }, body: r.body, createdAt: r.at || new Date().toISOString(), lastEditedAt: r.edited || null, url: `https://github.com/o/r/pull/5#discussion_r${cid + i + 1}` })),
    ] },
  };
}
const comment = (login, body, { at = new Date().toISOString(), edited = null } = {}) => ({ databaseId: Math.floor(Math.random() * 1e6) + 5000, author: { login }, body, createdAt: at, lastEditedAt: edited, url: 'https://github.com/o/r/pull/5#issuecomment-1' });
const decision = (d, opts) => comment('rev', `<!-- review-until-approve:decision ${Buffer.from(JSON.stringify(d)).toString('base64url')} -->\nThe reviewer's decision`, opts);

module.exports = { world, stateReview, fullState, finding, thread, comment, decision, TOKEN, SCRIPT };
