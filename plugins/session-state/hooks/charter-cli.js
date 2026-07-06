#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readNorthStar, setNorthStar, mergeSessions, renderCharter } = require('./lib/charter');

function resolveStateDir() {
  if (process.env.CHARTER_STATE_DIR) return process.env.CHARTER_STATE_DIR;
  // Mirror Claude Code's project-dir encoding: the config dir honors CLAUDE_CONFIG_DIR,
  // and the slug replaces BOTH '/' and '.' with '-' (a `.claude` segment becomes
  // `--claude`). Verified against a real project dir name in Step 4b.
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const slug = process.cwd().replace(/[/.]/g, '-');
  return path.join(configDir, 'projects', slug, 'state');
}

function main() {
  const cmd = process.argv[2] || 'show';
  const stateDir = resolveStateDir();
  if (cmd === 'set') {
    const text = fs.readFileSync(0, 'utf8');
    setNorthStar(stateDir, text);
    process.stdout.write('north-star updated.\n');
    return;
  }
  // show
  const md = renderCharter(readNorthStar(stateDir), mergeSessions(stateDir));
  process.stdout.write(md);
}

try {
  main();
} catch (e) {
  process.stderr.write(`charter: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
}
