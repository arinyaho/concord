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
  'plugins/concord-copilot/plugin.json',
  '.github/plugin/marketplace.json',
];

const NUM = '(0|[1-9]\\d*)';
const STABLE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const BETA = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-beta\\.${NUM}$`);

// A stable release goes to the next minor's first beta; a beta goes to its next number.
export function nextVersion(version) {
  const stable = STABLE.exec(version);
  if (stable) return `${stable[1]}.${Number(stable[2]) + 1}.0-beta.1`;
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

// The release is exactly what the base's release script writes for the head version: no other manifest field changes and all five files agree.
function matchesReleaseScript(baseRef, headRef, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-guard-'));
  try {
    for (const file of VERSION_FILES) {
      fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      fs.writeFileSync(path.join(tmp, file), execFileSync('git', ['show', `${baseRef}:${file}`], { cwd: root, encoding: 'utf8' }));
    }
    execFileSync(process.execPath, [path.join(root, 'scripts/release-version.mjs'), version], { cwd: root, env: { ...process.env, CONCORD_VERSION_ROOT: tmp }, stdio: 'ignore' });
    return VERSION_FILES.every((file) => fs.readFileSync(path.join(tmp, file), 'utf8') === execFileSync('git', ['show', `${headRef}:${file}`], { cwd: root, encoding: 'utf8' }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function guard(baseRef, headRef) {
  const changed = git('diff', '--name-only', `${baseRef}...${headRef}`).split('\n').filter(Boolean);
  const touched = touchedVersionFiles(changed);
  if (touched.length === 0) return 0;
  // The one pull request allowed to edit version files is a release: only version files change, and VERSION becomes a higher stable version.
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
  console.error(`Pull requests do not edit version files except a release that sets a higher stable VERSION; main's release-bump workflow raises the version after merge:\n${touched.join('\n')}`);
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
