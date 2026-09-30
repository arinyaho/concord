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

function needsInstall(pkgDir) {
  const modules = mtimeMs(path.join(pkgDir, 'node_modules'));
  if (modules === null) return true;
  return modules < mtimeMs(path.join(pkgDir, 'package-lock.json'));
}

export function main({ root, run = defaultRun, env = process.env, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const pkgDir = path.join(root, AGENT_TEAM);
  if (needsInstall(pkgDir)) {
    const install = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: pkgDir, env });
    if (install.status !== 0) {
      const out = `${install.stdout}${install.stderr}${install.error ? `${install.error.message}\n` : ''}`.replace(/\s+$/, '');
      if (out) log(out.split(/\r?\n/).slice(-TAIL_LINES).join('\n'));
      const why = install.error ? install.error.message : `npm ci exited ${install.status}`;
      // Last line on purpose: the review handoff shows only the tail of the output.
      log(`DoD environment error: dependency install in ${AGENT_TEAM} failed (${why}). This is not an implementation failure.`);
      return EX_CONFIG;
    }
  }
  const tests = run('node', ['--test'], { cwd: root, env: { ...env, CONCORD_RUN_PLUGIN_INSTALL_E2E: '1' }, stdio: 'inherit' });
  return tests.status == null ? 1 : tests.status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }));
}
