#!/usr/bin/env node
'use strict';
// explain-pr: prepare a pull request for reading in one directory, list the tracker tools the read-only mode allows,
// and turn the mode on. Each command prints one JSON line. Nothing from the pull request's text is ever printed:
// errors from gh or git are reported with a fixed description, since their messages could carry that text.
// usage: explain-pr.js prepare <owner/repo> <number> [--checkout <path>]
//        explain-pr.js allow <tracker> <tool>...
//        explain-pr.js start <dir>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dataDir } = require('./data-dir');

// The Claude plugin keeps the shared module in core/, the Codex bundle in engine/.
const core = require(['core', 'engine'].map((d) => path.join(__dirname, '..', '..', '..', d, 'read-only.js')).find((p) => fs.existsSync(p)));

const harness = process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : 'codex';
const DATA = dataDir(process.env, harness);
const PRS = path.join(DATA, 'prs');

const print = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
function usage(msg) {
  process.stderr.write(`explain-pr: ${msg}\n`);
  process.exit(2);
}

// Commands run with argument arrays, never through a shell, from a neutral directory.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 1 << 30, timeout: 600000, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, ...opts,
  });
  if (r.error || r.status !== 0) throw new Error(`${cmd} failed`);
  return r.stdout;
}
const gh = (...args) => JSON.parse(run('gh', args));
const pages = (url) => gh('api', '--paginate', '--slurp', url);

const PR_FIELDS = 'number,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,labels,isDraft,closingIssuesReferences,commits';
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock', 'go.sum', 'Podfile.lock',
  'pubspec.lock', 'mix.lock', 'flake.lock', 'packages.lock.json', 'gradle.lockfile', 'Package.resolved']);
const NAME = /^[\w.-]+$/;

const URL_RE = /https?:\/\/[^\s<>()[\]{}"'`|]+/g;
const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
// The tracker of a URL: a name, null for a link to anything else, undefined for GitHub's own links (issues are read
// into issues/) and for text that is not a URL.
function trackerOf(link) {
  let u;
  try { u = new URL(link); } catch { return undefined; }
  const host = u.hostname;
  if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')) return undefined;
  if (host.endsWith('.atlassian.net') && /^\/browse\/[A-Z][A-Z0-9]{1,9}-\d+/.test(u.pathname)) return 'jira';
  if (/(^|\.)notion\.(so|site)$/.test(host)) return 'notion';
  if (host === 'app.asana.com') return 'asana';
  if (host === 'linear.app') return 'linear';
  return null;
}
function findLinks(texts) {
  const seen = new Map();
  for (const [source, text] of texts) {
    if (typeof text !== 'string') continue;
    const add = (link, tracker) => { if (tracker !== undefined && !seen.has(link)) seen.set(link, { link, tracker, source }); };
    for (const [m] of text.matchAll(URL_RE)) { const link = m.replace(/[.,;:!?]+$/, ''); add(link, trackerOf(link)); }
    for (const [m] of text.replace(URL_RE, ' ').matchAll(KEY_RE)) add(m, 'jira');
  }
  return [...seen.values()];
}

// Deletes every symlink under root, without following any, and returns each as { path, target }. A tool that walks
// head/ could otherwise follow one out of the prepared directory where no hook sees it.
function removeSymlinks(root, rel = '') {
  const found = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) {
      found.push({ path: p, target: fs.readlinkSync(path.join(root, p)) });
      fs.unlinkSync(path.join(root, p));
    } else if (e.isDirectory()) found.push(...removeSymlinks(root, p));
  }
  return found;
}

function prepare(args) {
  const pos = [];
  let checkout;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--checkout') pos.push(args[i]);
    else if (!args[i + 1]) usage('--checkout needs a path');
    else checkout = path.resolve(args[++i]);
  }
  const [repo, num] = pos;
  if (pos.length !== 2 || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(num)) usage('usage: explain-pr.js prepare <owner/repo> <number> [--checkout <path>]');
  const [owner, name] = repo.split('/');

  core.pruneModes(DATA, Date.now());
  fs.mkdirSync(PRS, { recursive: true });
  // Built under a temporary name and renamed at the end, so a failed run leaves nothing `start` accepts.
  const tmp = fs.mkdtempSync(path.join(PRS, '.tmp-'));
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-pr-git-'));
  const write = (file, v) => fs.writeFileSync(path.join(tmp, file), `${JSON.stringify(v, null, 2)}\n`);
  let step = 'read the pull request';
  try {
    const { commits, ...pr } = gh('pr', 'view', num, '--repo', repo, '--json', PR_FIELDS);
    const head = pr.headRefOid;
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) throw new Error('bad head');
    write('pr.json', pr);
    const messages = commits.map((c) => ({ oid: c.oid, message: c.messageBody ? `${c.messageHeadline}\n\n${c.messageBody}` : c.messageHeadline }));
    write('commits.json', messages);

    step = 'read the diff';
    fs.writeFileSync(path.join(tmp, 'diff.patch'), run('gh', ['pr', 'diff', num, '--repo', repo], { encoding: 'buffer' }));
    step = 'read the changed files';
    const changed = pages(`repos/${repo}/pulls/${num}/files`).flat();
    step = 'read the review threads';
    const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
      reviewThreads(first:50,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{path line isResolved isOutdated comments(first:100){nodes{author{login} body createdAt}}}}}}}`;
    write('threads.json', gh('api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${num}`)
      .flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes));
    step = 'read the comments';
    write('comments.json', pages(`repos/${repo}/issues/${num}/comments`).flat().map((c) => ({ author: c.user?.login, body: c.body, createdAt: c.created_at })));
    step = 'read the closing issues';
    fs.mkdirSync(path.join(tmp, 'issues'));
    for (const ref of pr.closingIssuesReferences || []) {
      const r = `${ref.repository?.owner?.login}/${ref.repository?.name}`;
      if (!/^[\w.-]+\/[\w.-]+$/.test(r) || !Number.isInteger(ref.number)) throw new Error('bad issue');
      const i = gh('api', `repos/${r}/issues/${ref.number}`);
      write(`issues/${r === repo ? '' : `${r.replace('/', '__')}__`}${ref.number}.json`, { repo: r, number: i.number, title: i.title, body: i.body, state: i.state });
    }
    step = 'read the check runs';
    write('checks.json', pages(`repos/${repo}/commits/${head}/check-runs`).flatMap((p) => p.check_runs)
      .map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })));

    step = 'fetch the head commit';
    const git = (...a) => run('git', ['-C', gitDir, ...a]);
    git('init', '-q', '--bare');
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    if (checkout) {
      run('git', ['-C', checkout, 'fetch', '-q', 'origin', head]);
      const objects = run('git', ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim();
      fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`);
    } else git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, head);
    // Every file goes into head/ as committed, whatever export-ignore or export-subst the tree's .gitattributes set.
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    step = 'extract the head tree';
    git('archive', '--format=tar', '-o', path.join(gitDir, 'head.tar'), head);
    fs.mkdirSync(path.join(tmp, 'head'));
    run('tar', ['-xf', path.join(gitDir, 'head.tar'), '-C', path.join(tmp, 'head')]);
    const symlinks = removeSymlinks(path.join(tmp, 'head'));
    write('symlinks.json', symlinks);
    const attrs = run('git', ['-C', gitDir, 'check-attr', '-z', '--stdin', '--source', head, 'linguist-generated'], { input: changed.map((f) => f.filename).join('\0') }).split('\0');
    const generated = new Set();
    for (let i = 0; i + 2 < attrs.length; i += 3) if (['set', 'true'].includes(attrs[i + 2])) generated.add(attrs[i]);

    const links = new Map(symlinks.map((s) => [s.path, s.target]));
    const files = changed.map((f) => ({
      path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
      ...(f.previous_filename && { previous: f.previous_filename }),
      lockfile: LOCKFILES.has(path.posix.basename(f.filename)), generated: generated.has(f.filename),
      ...(links.has(f.filename) && { symlink: links.get(f.filename) }),
    }));
    write('files.json', files);

    step = "count the reader's commits";
    const login = gh('api', 'user').login;
    const top = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, 100);
    // ponytail: one sequential gh call per path (up to 100); run them in parallel if prepare is too slow.
    write('reader.json', top.map((f) => ({
      path: f.path,
      commits: gh('api', `repos/${repo}/commits?path=${encodeURIComponent(f.path)}&author=${encodeURIComponent(login)}&per_page=100`).length,
    })));

    step = 'write the prepared directory';
    const found = findLinks([['title', pr.title], ['body', pr.body], ...messages.map((c) => [`commit ${c.oid}`, c.message])]);
    write('links.json', found);
    const trackers = [...new Set(found.map((l) => l.tracker).filter(Boolean))].sort();
    const allowed = core.readAllowedTools(DATA);
    const dir = path.join(PRS, `${owner}__${name}__${num}__${head.slice(0, 12)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    print({
      dir, files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
      trackers, unlistedTrackers: trackers.filter((t) => !(allowed[t] || []).length),
    });
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.stderr.write(`explain-pr: prepare ${repo}#${num} failed: could not ${step}\n`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}

function allow([tracker, ...tools]) {
  if (!tracker || !NAME.test(tracker) || !tools.length || tools.some((t) => !/^\S+$/.test(t))) usage('usage: explain-pr.js allow <tracker> <tool>...');
  const list = core.readAllowedTools(DATA);
  list[tracker] = [...new Set([...(list[tracker] || []), ...tools])];
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, 'allowed-tools.json');
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ trackers: list }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  print({ tracker, tools: list[tracker] });
}

const shq = (a) => `'${a.replace(/'/g, "'\\''")}'`;
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
// The Codex reading session: reads confined to the prepared directory by a permissions profile (not -s, which would
// force the legacy sandbox), no approval prompts, no web search, no apps connector. The listed MCP tools are approved
// in advance, since `-a never` refuses a call that needs approval; other MCP servers stay as configured, and the hook
// denies their tools.
function launchCommand(dir) {
  const approve = [...new Set(core.allToolNames(core.readAllowedTools(DATA)))].map((t) => /^mcp__(.+?)__(.+)$/.exec(t)).filter(Boolean)
    .flatMap(([, server, tool]) => ['-c', `mcp_servers.${tomlKey(server)}.tools.${tomlKey(tool)}.approval_mode="approve"`]);
  const args = ['-C', dir, '-a', 'never', '-c', 'default_permissions="explain-pr"',
    '-c', `permissions.explain-pr.filesystem={":minimal"="read",${JSON.stringify(dir)}="read"}`,
    '-c', 'web_search="disabled"', '--disable', 'apps', ...approve, 'Run the explain-pr skill on this directory.'];
  return ['codex', ...args.map(shq)].join(' ');
}

function start(args) {
  if (args.length !== 1) usage('usage: explain-pr.js start <dir>');
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const dir = real(args[0]);
  const prs = real(PRS);
  if (!dir || !prs || path.dirname(dir) !== prs || path.basename(dir).startsWith('.') || !fs.statSync(dir).isDirectory()) {
    usage('start: the directory is not one prepare wrote');
  }
  if (harness === 'codex') return print({ mode: 'off', launch: launchCommand(dir) });
  try {
    core.writeMode(DATA, process.env.CLAUDE_CODE_SESSION_ID, dir);
  } catch {
    usage('start: CLAUDE_CODE_SESSION_ID is not a usable session id');
  }
  print({ mode: 'on' });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'prepare') prepare(rest);
else if (cmd === 'allow') allow(rest);
else if (cmd === 'start') start(rest);
else usage('usage: explain-pr.js prepare|allow|start ...');
