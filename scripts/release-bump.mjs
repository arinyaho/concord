import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node scripts/release-bump.mjs guard <base-ref> | push <branch>';
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

function guard(baseRef) {
  const changed = git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').filter(Boolean);
  const touched = touchedVersionFiles(changed);
  if (touched.length === 0) return 0;
  console.error(`Pull requests do not edit version files; main's release-bump workflow raises the version after merge:\n${touched.join('\n')}`);
  return 1;
}

function bumpOnce(branch) {
  git('fetch', '-q', 'origin', branch);
  git('reset', '-q', '--hard', `origin/${branch}`);
  const next = nextBeta(fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim());
  execFileSync(process.execPath, [path.join(root, 'scripts/release-version.mjs'), next], { cwd: root, stdio: 'inherit' });
  git('add', '--', ...VERSION_FILES);
  git('-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '-q', '--no-verify',
    '-m', `chore(release): bump Concord to ${next}`);
  const committed = git('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
  const stray = committed.filter((file) => !VERSION_FILES.includes(file));
  if (stray.length > 0) throw new Error(`Bump commit touches files outside the release set: ${stray.join(', ')}`);
  try {
    git('push', '-q', 'origin', `HEAD:${branch}`);
    console.log(`Pushed ${next} to ${branch}`);
    return true;
  } catch (error) {
    // Another push landed between fetch and push; anything else is fatal.
    if (/rejected|non-fast-forward|fetch first|failed to update ref|cannot lock ref/.test(String(error.stderr))) return false;
    throw error;
  }
}

function push(branch) {
  if (git('log', '-1', '--format=%ae') === BOT_EMAIL) {
    console.log('HEAD is a release bump; nothing to do');
    return 0;
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (bumpOnce(branch)) return 0;
    console.error(`Push attempt ${attempt} lost a race; retrying`);
  }
  console.error(`Giving up after ${ATTEMPTS} attempts`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ref, ...rest] = process.argv.slice(2);
  if (!ref || rest.length > 0 || !['guard', 'push'].includes(command)) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(command === 'guard' ? guard(ref) : push(ref));
}
