#!/usr/bin/env node
'use strict';
const { readStdinEvent } = require('../engine/event');
const { resolveStateDirFromCwd } = require('../engine/statedir');
const { listLedgers, renderReviewReport } = require('../engine/review');

function main() {
  const { transcriptPath } = readStdinEvent();
  if (!transcriptPath) return;
  // Codex has no per-project transcript sibling to derive a state dir from
  // (unlike Claude Code's resolveStateDirFromTranscript) -- resolve from cwd instead,
  // matching the writer and injector.
  const stateDir = resolveStateDirFromCwd();
  const report = renderReviewReport(listLedgers(stateDir));
  if (report) process.stdout.write(report + '\n');
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
