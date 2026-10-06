import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Repo definition of done, invoked by review.config.json. Runs only what the
// pull-request workflow cannot: the plugin-install e2e, which needs the claude,
// codex and copilot CLIs. CI runs every other test, so repeating them here only
// adds local time. Exit 78 (EX_CONFIG) means the environment could not be
// prepared (a CLI is missing), not that a test failed.

const EX_CONFIG = 78;
const CLIS = ['claude', 'codex', 'copilot'];
// Test titles of the e2e start with this prefix; every other test in those files is CI's.
const E2E_FILES = ['plugins/concord/hooks/test/ticket-writing-skill.test.js', 'plugins/concord/hooks/test/copilot-package.test.js'];
const E2E_NAME = '^plugin-install e2e:';

function defaultRun(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

export function main({ root, run = defaultRun, env = process.env, platform = process.platform, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  for (const cli of CLIS) {
    // claude, codex and copilot may be .cmd shims on Windows, which spawn only resolves through a shell.
    const probe = run(cli, ['--version'], { env, shell: platform === 'win32' });
    if (probe.status !== 0) {
      const why = probe.error ? probe.error.message : `exit ${probe.status}`;
      log(`${cli} --version: ${why.length > 120 ? `${why.slice(0, 120)}...` : why}`);
      // Short and last on purpose: the review handoff clips lines and shows only the tail.
      log(`DoD environment error: ${cli} CLI is not usable. This is not an implementation failure.`);
      return EX_CONFIG;
    }
  }
  const tests = run('node', ['--test', `--test-name-pattern=${E2E_NAME}`, ...E2E_FILES], { cwd: root, env: { ...env, CONCORD_RUN_PLUGIN_INSTALL_E2E: '1' }, stdio: 'inherit' });
  return tests.status == null ? 1 : tests.status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }));
}
