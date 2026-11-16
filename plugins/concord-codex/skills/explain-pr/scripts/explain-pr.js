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

// A Codex session started from Claude Code's shell inherits CLAUDE_CODE_SESSION_ID; Codex's own marker wins.
const harness = process.env.CLAUDE_CODE_SESSION_ID && !process.env.CODEX_THREAD_ID ? 'claude' : 'codex';
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
// git's status letters in GitHub's words.
const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'changed' };

const URL_RE = /https?:\/\/[^\s<>()[\]{}"'`|]+/g;
const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
// Prefixes of names that look like a Jira key but are not one (UTF-8, SHA-256, RFC-9110).
const NOT_KEYS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'CVE', 'AES', 'TLS', 'HTTP', 'MD', 'RSA', 'ECDSA']);
// "#123" for an issue or pull request of the same repository, not inside a word, path or HTML entity.
const REF_RE = /(?<![\w&/])#(\d+)\b/g;
const HEX_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DAY = 864e5;
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
    for (const [m] of text.replace(URL_RE, ' ').matchAll(KEY_RE)) if (!NOT_KEYS.has(m.split('-')[0])) add(m, 'jira');
  }
  return [...seen.values()];
}

// Deletes every symlink under root, without following any, and returns each as { path, target }. A tool that walks
// head/ could otherwise follow one out of the prepared directory where no hook sees it. A `.git` entry, which a crafted
// tree can carry, is deleted too.
function removeSymlinks(root, rel = '') {
  const found = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.name.toLowerCase() === '.git') fs.rmSync(path.join(root, p), { recursive: true, force: true });
    else if (e.isSymbolicLink()) {
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

  fs.mkdirSync(PRS, { recursive: true });
  // A temporary directory a day old belongs to a run that was killed, not to one still working. A prepared directory
  // 30 days old is deleted; a session whose mode names it is then denied everything. Mode files are never deleted.
  for (const e of fs.readdirSync(PRS)) {
    const p = path.join(PRS, e);
    try { if (Date.now() - fs.statSync(p).mtimeMs > (e.startsWith('.tmp-') ? DAY : 30 * DAY)) fs.rmSync(p, { recursive: true, force: true }); } catch { /* vanished */ }
  }
  // Built under a temporary name and renamed at the end, so a failed run leaves nothing `start` accepts.
  const tmp = fs.mkdtempSync(path.join(PRS, '.tmp-'));
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-pr-git-'));
  const write = (file, v) => fs.writeFileSync(path.join(tmp, file), `${JSON.stringify(v, null, 2)}\n`);
  let step = 'read the pull request';
  try {
    const { commits, ...pr } = gh('pr', 'view', num, '--repo', repo, '--json', PR_FIELDS);
    const head = pr.headRefOid;
    if (!HEX_OID.test(head) || !HEX_OID.test(pr.baseRefOid)) throw new Error('bad commit');
    write('pr.json', pr);
    const messages = commits.map((c) => ({ oid: c.oid, message: c.messageBody ? `${c.messageHeadline}\n\n${c.messageBody}` : c.messageHeadline }));
    write('commits.json', messages);

    step = 'read the review threads';
    const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
      reviewThreads(first:50,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{path line isResolved isOutdated comments(first:100){nodes{author{login} body createdAt}}}}}}}`;
    write('threads.json', gh('api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${num}`)
      .flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes)
      .map((t) => (t.comments?.nodes?.length >= 100 ? { ...t, truncated: true } : t)));
    step = 'read the comments';
    write('comments.json', pages(`repos/${repo}/issues/${num}/comments`).flat().map((c) => ({ author: c.user?.login, body: c.body, createdAt: c.created_at })));
    step = 'read the linked issues';
    fs.mkdirSync(path.join(tmp, 'issues'));
    const saveIssue = (r, i) => write(`issues/${r === repo ? '' : `${r.replace('/', '__')}__`}${i.number}.json`,
      { repo: r, number: i.number, title: i.title, body: i.body, state: i.state, ...(i.pull_request && { pullRequest: true }) });
    const fetched = new Set([Number(num)]);
    for (const ref of pr.closingIssuesReferences || []) {
      const r = `${ref.repository?.owner?.login}/${ref.repository?.name}`;
      if (!/^[\w.-]+\/[\w.-]+$/.test(r) || !Number.isInteger(ref.number)) throw new Error('bad issue');
      saveIssue(r, gh('api', `repos/${r}/issues/${ref.number}`));
      if (r === repo) fetched.add(ref.number);
    }
    const texts = [['title', pr.title], ['body', pr.body], ...messages.map((c) => [`commit ${c.oid}`, c.message])];
    const refs = [...new Set(texts.flatMap(([, t]) => [...String(t || '').matchAll(REF_RE)].map((m) => Number(m[1]))))].filter((n) => !fetched.has(n));
    // ponytail: at most 100 referenced numbers, so a body full of "#n" cannot make thousands of calls.
    for (const n of refs.slice(0, 100)) {
      let i;
      try { i = gh('api', `repos/${repo}/issues/${n}`); } catch { continue; } // "#n" need not name an issue
      saveIssue(repo, i);
    }
    step = 'read the check runs';
    write('checks.json', pages(`repos/${repo}/commits/${head}/check-runs`).flatMap((p) => p.check_runs)
      .map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })));

    step = 'find the merge base';
    const mergeBase = gh('api', `repos/${repo}/compare/${pr.baseRefOid}...${head}?per_page=1`).merge_base_commit?.sha;
    if (!HEX_OID.test(mergeBase || '')) throw new Error('bad merge base');
    step = 'fetch the head commit';
    const git = (...a) => run('git', ['-C', gitDir, ...a]);
    git('init', '-q', '--bare');
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    if (checkout) {
      run('git', ['-C', checkout, 'fetch', '-q', 'origin', head, mergeBase]);
      const objects = run('git', ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim();
      fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`);
    } else git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, head, mergeBase);
    // Every file goes into head/ as committed, whatever export-ignore or export-subst the tree's .gitattributes set.
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    step = 'write the diff';
    // The diff GitHub shows, made locally (gh pr diff refuses large pull requests), without the user's diff drivers.
    const diff = (...a) => run('git', ['-C', gitDir, 'diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', ...a, mergeBase, head], { encoding: 'buffer' });
    fs.writeFileSync(path.join(tmp, 'diff.patch'), diff('--src-prefix=a/', '--dst-prefix=b/'));
    // The file list from the same two commits (GitHub's files endpoint stops at 3000 files). Both outputs are in the
    // same order; a rename is "R<score>\0<from>\0<to>" and "<add>\t<del>\t\0<from>\0<to>", a binary file counts "-".
    const fields = (buf) => buf.toString('utf8').split('\0');
    const ns = fields(diff('--name-status', '-z'));
    const nums = fields(diff('--numstat', '-z'));
    const changed = [];
    for (let i = 0, j = 0; i + 1 < ns.length;) {
      const code = ns[i][0];
      const renamed = code === 'R' || code === 'C';
      const [from, to] = renamed ? [ns[i + 1], ns[i + 2]] : [undefined, ns[i + 1]];
      i += renamed ? 3 : 2;
      const [add, del] = nums[j].split('\t');
      j += renamed ? 3 : 1;
      changed.push({
        path: to, status: STATUS[code] || 'changed',
        ...(add === '-' ? { additions: 0, deletions: 0, binary: true } : { additions: Number(add), deletions: Number(del) }),
        ...(from !== undefined && { previous: from }),
      });
    }
    step = 'extract the head tree';
    git('archive', '--format=tar', '-o', path.join(gitDir, 'head.tar'), head);
    fs.mkdirSync(path.join(tmp, 'head'));
    run('tar', ['-xf', path.join(gitDir, 'head.tar'), '-C', path.join(tmp, 'head')]);
    const symlinks = removeSymlinks(path.join(tmp, 'head'));
    write('symlinks.json', symlinks);
    const attrs = run('git', ['-C', gitDir, 'check-attr', '-z', '--stdin', '--source', head, 'linguist-generated'], { input: changed.map((f) => f.path).join('\0') }).split('\0');
    const generated = new Set();
    for (let i = 0; i + 2 < attrs.length; i += 3) if (['set', 'true'].includes(attrs[i + 2])) generated.add(attrs[i]);

    const links = new Map(symlinks.map((s) => [s.path, s.target]));
    const files = changed.map((f) => ({
      ...f, lockfile: LOCKFILES.has(path.posix.basename(f.path)), generated: generated.has(f.path),
      ...(links.has(f.path) && { symlink: links.get(f.path) }),
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
    const found = findLinks(texts);
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
  if (!tracker || !NAME.test(tracker) || !tools.length || tools.some((t) => !/^mcp__\S+$/.test(t))) usage('usage: explain-pr.js allow <tracker> <mcp__tool>...');
  const list = core.readAllowedTools(DATA);
  list[tracker] = [...new Set([...(list[tracker] || []), ...tools])];
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, 'allowed-tools.json');
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ trackers: list }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  print({ tracker, tools: list[tracker] });
}

const shq = (a) => `'${a.replace(/'/g, "'\\''")}'`;
// The Codex reading session: reads confined to the prepared directory by a permissions profile (not -s, which would
// force the legacy sandbox), no approval prompts, no web search, no apps connector. The listed MCP tools are approved
// in advance, since `-a never` refuses a call that needs approval; a listed tool that is not mcp__<server>__<tool> with
// both names bare TOML keys gets no switch and is returned in skippedTools. Every MCP server of the user's config.toml that hosts no listed tool is disabled, so a
// server the user approved in advance cannot act in a session whose hook the user has not trusted; an id that is not a
// bare TOML key gets no switch and is returned in skippedServers. The prompt names the skill as $concord:explain-pr, so
// Codex loads SKILL.md into the session itself: the profile does not let the session read the plugin's files.
const BARE = /^[A-Za-z0-9_-]+$/;
const UNPARSED = '<unparsed mcp_servers form>';
// The ids of [mcp_servers.<id>] and [mcp_servers.<id>.<sub>] table headers. Only headers are read, never values. Any
// other form that defines servers (an [mcp_servers] table, a dotted or inline mcp_servers key), and a header-shaped
// line inside a multi-line string, is reported as UNPARSED, so no value is ever printed.
// ponytail: a line scan, not a TOML parser; a comment holding """ or ''' can mislead it, and then it reports UNPARSED.
function configuredServers() {
  let text;
  try { text = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8'); } catch { return []; }
  const ids = new Set();
  let open = null; // the delimiter of the multi-line string a line is inside
  for (const line of text.split(/\r?\n/)) {
    const header = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(.+?)[ \t]*\][ \t]*(?:#.*)?$/.exec(line);
    if (open && (header || /mcp_servers/.test(line))) ids.add(UNPARSED);
    else if (header) {
      const q = /^("(?:[^"\\]|\\.)*"|'[^']*')/.exec(header[1]);
      ids.add(q ? q[1] : header[1].split('.')[0].trim());
    } else if (/^\s*(\[\s*mcp_servers\s*\]|mcp_servers\s*[.=])/.test(line)) ids.add(UNPARSED);
    for (const [d] of line.matchAll(/"""|'''/g)) {
      if (!open) open = d;
      else if (d === open) open = null;
    }
  }
  // UNPARSED last, after the ids, whatever order the lines came in.
  return [...ids].filter((id) => id !== UNPARSED).concat(ids.has(UNPARSED) ? [UNPARSED] : []);
}
function launchCommand(dir) {
  const approve = [];
  const skippedTools = [];
  const kept = new Set();
  for (const t of new Set(core.allToolNames(core.readAllowedTools(DATA)))) {
    const m = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/.exec(t);
    if (m) {
      approve.push('-c', `mcp_servers.${m[1]}.tools.${m[2]}.approval_mode="approve"`);
      kept.add(m[1]);
    } else skippedTools.push(t);
  }
  const disable = [];
  const skippedServers = [];
  for (const id of configuredServers()) {
    if (id === UNPARSED || !BARE.test(id)) skippedServers.push(id);
    else if (!kept.has(id)) disable.push('-c', `mcp_servers.${id}.enabled=false`);
  }
  const args = ['-C', dir, '-a', 'never', '-c', 'default_permissions="explain-pr"',
    '-c', `permissions.explain-pr.filesystem={":minimal"="read",${JSON.stringify(dir)}="read"}`,
    '-c', 'web_search="disabled"', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'multi_agent', '--disable', 'image_generation', '-c', 'shell_environment_policy.inherit="core"',
    ...disable, ...approve, '$concord:explain-pr Explain the pull request prepared in this directory.'];
  return { launch: ['codex', ...args.map(shq)].join(' '), skippedTools, skippedServers };
}

function start(args) {
  if (args.length !== 1) usage('usage: explain-pr.js start <dir>');
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const dir = real(args[0]);
  const prs = real(PRS);
  if (!dir || !prs || path.dirname(dir) !== prs || path.basename(dir).startsWith('.') || !fs.statSync(dir).isDirectory()) {
    usage('start: the directory is not one prepare wrote');
  }
  if (harness === 'codex') return print({ mode: 'off', ...launchCommand(dir) });
  try {
    core.writeMode(DATA, process.env.CLAUDE_CODE_SESSION_ID, dir);
  } catch {
    usage('start: CLAUDE_CODE_SESSION_ID is not a usable session id');
  }
  print({ mode: 'on' });
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'prepare') prepare(rest);
  else if (cmd === 'allow') allow(rest);
  else if (cmd === 'start') start(rest);
  else usage('usage: explain-pr.js prepare|allow|start ...');
}
module.exports = { removeSymlinks };
