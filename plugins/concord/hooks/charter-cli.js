#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { readNorthStar, setNorthStar, mergeSessions, renderCharter } = require('../core/charter');
const { resolveStateDirFromCwd } = require('./lib/statedir');

function resolveStateDir() {
  if (process.env.CHARTER_STATE_DIR) return process.env.CHARTER_STATE_DIR;
  return resolveStateDirFromCwd();
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
