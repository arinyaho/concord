#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { readNorthStar, setNorthStar, mergeSessions, renderCharter } = require('./charter');

function resolveStateDir(resolveFromCwd) {
  if (process.env.CHARTER_STATE_DIR) return process.env.CHARTER_STATE_DIR;
  return resolveFromCwd();
}

function main(resolveFromCwd) {
  const cmd = process.argv[2] || 'show';
  const stateDir = resolveStateDir(resolveFromCwd);
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

function runMain(resolveFromCwd) {
  try {
    main(resolveFromCwd);
  } catch (e) {
    process.stderr.write(`charter: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}

module.exports = { main, runMain };
