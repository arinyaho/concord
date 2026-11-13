import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node scripts/release-bump.mjs guard <base-ref> <head-ref> | push <branch>';
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const ATTEMPTS = 4;

// The files scripts/release-version.mjs writes; keep in step with its target list.
export const VERSION_FILES = [
  'VERSION',
  'plugins/concord/.claude-plugin/plugin.json',
  'plugins/concord-codex/.codex-plugin/plugin.json',
];

const NUM = '(0|[1-9]\\d*)';
const STABLE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const BETA = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-beta\\.${NUM}$`);

// A stable release goes to the next patch's first beta; a beta goes to its next number.
export function nextVersion(version) {
  const stable = STABLE.exec(version);
  if (stable) return `${stable[1]}.${stable[2]}.${Number(stable[3]) + 1}-beta.1`;
  const beta = BETA.exec(version);
  if (beta) return `${beta[1]}.${beta[2]}.${beta[3]}-beta.${Number(beta[4]) + 1}`;
  throw new Error(`Version ${JSON.stringify(version)} is neither a stable X.Y.Z nor an X.Y.Z-beta.N version`);
}

// True when `head` is a stable version with higher SemVer precedence than `base`; a prerelease of X.Y.Z ranks below X.Y.Z.
export function isStableUpgrade(base, head) {
  const to = STABLE.exec(head);
  const from = /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(base);
  if (!to || !from) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(to[i]) !== Number(from[i])) return Number(to[i]) > Number(from[i]);
  }
  return Boolean(from[4]);
}

export function touchedVersionFiles(paths) {
  return paths.filter((file) => VERSION_FILES.includes(file));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The release is exactly what the base's release script writes for the head version: no other manifest field changes and all three files agree.
function matchesReleaseScript(baseRef, headRef, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-guard-'));
  try {
    for (const file of VERSION_FILES) {
      fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      fs.writeFileSync(path.join(tmp, file), execFileSync('git', ['show', `${baseRef}:${file}`], { cwd: root, encoding: 'utf8' }));
    }
    execFileSync(process.execPath, [path.join(root, 'scripts/release-version.mjs'), version], { cwd: root, env: { ...process.env, CONCORD_VERSION_ROOT: tmp }, stdio: 'ignore' });
    for (const file of VERSION_FILES) requireRegularFile(headRef, file);
    return VERSION_FILES.every((file) => fs.readFileSync(path.join(tmp, file), 'utf8') === execFileSync('git', ['show', `${headRef}:${file}`], { cwd: root, encoding: 'utf8' }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Throws unless the path is a regular file at the ref. A symbolic link's blob is its target text, so a link can read as the
// expected content while the file the release script later writes through it holds something else.
function requireRegularFile(ref, file) {
  const entry = git('ls-tree', ref, '--', file);
  if (!entry) throw new Error('deleted or renamed away');
  if (!/^100(644|755) blob /.test(entry)) throw new Error('not a regular file');
}

// The version string of a manifest at a ref, read as data. It throws when the path is not a regular file there, is not JSON,
// or has no string version. With `strict`, the text must also be exactly what JSON.stringify writes for its own parse: a
// duplicated key, which a parser resolves one way and a reader of the file another, does not survive that round trip.
function manifestVersion(ref, file, strict = false) {
  requireRegularFile(ref, file);
  const text = execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  if (typeof manifest.version !== 'string') throw new Error('no string version');
  if (strict && `${JSON.stringify(manifest, null, 2)}\n` !== text) throw new Error('not in the form the release script writes (two-space JSON, trailing newline, no duplicated key)');
  return manifest.version;
}

function guard(baseRef, headRef) {
  // With more than one merge base there is no single commit the pull request branched from, and a merge works from a base
  // built out of all of them. Such a head passes only when every version file is the same at the head as at each merge base:
  // then nothing the head carries can win a later merge, whatever the base has become by then.
  const forkPoints = git('merge-base', '--all', baseRef, headRef).split('\n').filter(Boolean);
  if (forkPoints.length !== 1) {
    const differing = new Set(forkPoints.flatMap((point) => touchedVersionFiles(git('diff', '--name-only', '--no-renames', point, headRef).split('\n').filter(Boolean))));
    if (differing.size === 0) return 0;
    console.error(`The pull request and its base have ${forkPoints.length} merge bases, so a change to a version file cannot be judged; bring the branch up to date with a single merge of the base:\n${[...differing].join('\n')}`);
    return 1;
  }
  // Without rename detection a manifest moved away is listed under its own path, as the deletion it is.
  const changed = git('diff', '--name-only', '--no-renames', `${baseRef}...${headRef}`).split('\n').filter(Boolean);
  const touched = touchedVersionFiles(changed);
  if (touched.length === 0) return 0;
  // The one pull request allowed to change a version is a release: only version files change, and VERSION becomes a higher stable version.
  // The head is read as data with git show; its scripts never run.
  if (touched.length === changed.length && touched.includes('VERSION')) {
    try {
      const base = git('show', `${baseRef}:VERSION`).trim();
      const head = git('show', `${headRef}:VERSION`).trim();
      if (isStableUpgrade(base, head) && matchesReleaseScript(baseRef, headRef, head)) return 0;
    } catch {
      // A missing VERSION or an unrunnable release script is not a release; fall through to the failure.
    }
  }
  // Otherwise VERSION stays put, and a manifest may change only while its version field stays identical.
  // The comparison is with the commit the pull request branched from, as the diff above is: a bump that landed on the base since then is not the pull request's change.
  const reasons = new Map();
  for (const file of touched) {
    if (file === 'VERSION') {
      reasons.set(file, 'changed');
      continue;
    }
    try {
      if (manifestVersion(forkPoints[0], file) !== manifestVersion(headRef, file, true)) reasons.set(file, 'version changed');
    } catch (error) {
      reasons.set(file, error.message.split('\n')[0]);
    }
  }
  if (reasons.size === 0) return 0;
  console.error(`Pull requests do not change the version except a release that sets a higher stable VERSION; main's release-bump workflow raises the version after merge. A manifest may be edited while its version stays as it was:\n${[...reasons].map(([file, why]) => `${file}: ${why}`).join('\n')}`);
  return 1;
}

const BUMP_SUBJECT = 'chore(release): bump Concord to ';

// Every non-bot first-parent commit after the newest release bump or stable release is a merge that still needs its bump:
// a bump push lands on the tip its run fetched and carries every merge before it.
// A stable release commit is recognized by its content, a stable VERSION that differs from its first parent's, because a squash merge title is not fixed.
// Other commits by the Actions bot are neither a boundary nor a merge.
function isStableRelease(sha) {
  try {
    const version = git('show', `${sha}:VERSION`).trim();
    return STABLE.test(version) && version !== git('show', `${sha}^:VERSION`).trim();
  } catch {
    return false; // no parent, or no VERSION file
  }
}

function pendingMerges(branch) {
  const commits = git('log', '--first-parent', '--format=%H%x09%ae%x09%s', `origin/${branch}`).split('\n').filter(Boolean);
  let pending = 0;
  for (const commit of commits) {
    const [sha, author, subject] = commit.split('\t');
    if (author === BOT_EMAIL) {
      if (subject.startsWith(BUMP_SUBJECT)) break;
    } else {
      if (isStableRelease(sha)) break;
      pending += 1;
    }
  }
  return pending;
}

function commitBump() {
  const next = nextVersion(fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim());
  execFileSync(process.execPath, [path.join(root, 'scripts/release-version.mjs'), next], { cwd: root, stdio: 'inherit' });
  git('add', '--', ...VERSION_FILES);
  git('-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '-q', '--no-verify',
    '-m', `${BUMP_SUBJECT}${next}`);
  const committed = git('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
  const stray = committed.filter((file) => !VERSION_FILES.includes(file));
  if (stray.length > 0) throw new Error(`Bump commit touches files outside the release set: ${stray.join(', ')}`);
  return next;
}

function bumpOnce(branch) {
  git('fetch', '-q', 'origin', branch);
  git('reset', '-q', '--hard', `origin/${branch}`);
  const pending = pendingMerges(branch);
  if (pending === 0) {
    console.log(`${branch} has no merge after its last release bump; nothing to do`);
    return true;
  }
  let next;
  for (let i = 0; i < pending; i += 1) next = commitBump();
  try {
    git('push', '-q', 'origin', `HEAD:${branch}`);
    console.log(`Pushed ${next} to ${branch} for ${pending} merge(s)`);
    return true;
  } catch (error) {
    // Another push landed between fetch and push; anything else is fatal.
    if (/rejected|non-fast-forward|fetch first|failed to update ref|cannot lock ref/.test(String(error.stderr))) return false;
    throw error;
  }
}

function push(branch) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (bumpOnce(branch)) return 0;
    console.error(`Push attempt ${attempt} lost a race; retrying`);
  }
  console.error(`Giving up after ${ATTEMPTS} attempts`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...refs] = process.argv.slice(2);
  if (!['guard', 'push'].includes(command) || refs.length !== (command === 'guard' ? 2 : 1) || refs.includes('')) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(command === 'guard' ? guard(...refs) : push(...refs));
}
