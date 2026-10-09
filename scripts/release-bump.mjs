import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

export function nextBeta(version) {
  const match = /^(\d+\.\d+\.\d+-beta\.)(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Version ${JSON.stringify(version)} has no numeric trailing beta identifier`);
  return `${match[1]}${Number(match[2]) + 1}`;
}

export function touchedVersionFiles(paths) {
  return paths.filter((file) => VERSION_FILES.includes(file));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function guard(baseRef, headRef) {
  const changed = git('diff', '--name-only', `${baseRef}...${headRef}`).split('\n').filter(Boolean);
  const touched = touchedVersionFiles(changed);
  if (touched.length === 0) return 0;
  console.error(`Pull requests do not edit version files; main's release-bump workflow raises the version after merge:\n${touched.join('\n')}`);
  return 1;
}

const BUMP_SUBJECT = 'chore(release): bump Concord to ';

// Every non-bot first-parent commit after the newest release bump is a merge that still needs its bump:
// a bump push lands on the tip its run fetched and carries every merge before it.
// Other commits by the Actions bot are neither a boundary nor a merge.
function pendingMerges(branch) {
  const commits = git('log', '--first-parent', '--format=%ae%x09%s', `origin/${branch}`).split('\n').filter(Boolean);
  let pending = 0;
  for (const commit of commits) {
    const [author, subject] = commit.split('\t');
    if (author === BOT_EMAIL && subject.startsWith(BUMP_SUBJECT)) break;
    if (author !== BOT_EMAIL) pending += 1;
  }
  return pending;
}

function commitBump() {
  const next = nextBeta(fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim());
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
