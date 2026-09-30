import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Repo definition of done, invoked by review.config.json. Installs the
// lockfile-exact dependencies of services/agent-team when they are missing or
// stale, then runs the whole node test suite from the repo root. Exit 78
// (EX_CONFIG) means the environment could not be prepared, not that a test failed.

const EX_CONFIG = 78;
const TAIL_LINES = 20;
const AGENT_TEAM = 'services/agent-team';

function defaultRun(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// npm writes node_modules/.package-lock.json only after a successful install, so
// a failed or interrupted `npm ci` (which leaves a fresh node_modules directory)
// is not mistaken for an up-to-date one.
function needsInstall(pkgDir) {
  const installed = mtimeMs(path.join(pkgDir, 'node_modules', '.package-lock.json'));
  if (installed === null) return true;
  return installed < mtimeMs(path.join(pkgDir, 'package-lock.json'));
}

export function main({ root, run = defaultRun, env = process.env, platform = process.platform, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const pkgDir = path.join(root, AGENT_TEAM);
  if (needsInstall(pkgDir)) {
    // npm is npm.cmd on Windows, which spawn only resolves through a shell.
    const install = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: pkgDir, env, shell: platform === 'win32' });
    if (install.status !== 0) {
      const out = `${install.stdout}${install.stderr}`.replace(/\s+$/, '');
      if (out) log(out.split(/\r?\n/).slice(-TAIL_LINES).join('\n'));
      const why = install.error ? install.error.message : `exit ${install.status}`;
      log(`npm ci: ${why.length > 120 ? `${why.slice(0, 120)}...` : why}`);
      // Short and last on purpose: the review handoff clips lines and shows only the tail.
      log(`DoD environment error: npm ci failed in ${AGENT_TEAM}. This is not an implementation failure.`);
      return EX_CONFIG;
    }
  }
  const tests = run('node', ['--test'], { cwd: root, env: { ...env, CONCORD_RUN_PLUGIN_INSTALL_E2E: '1' }, stdio: 'inherit' });
  return tests.status == null ? 1 : tests.status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }));
}
