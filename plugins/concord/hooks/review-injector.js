#!/usr/bin/env node
'use strict';
const { readStdinEvent } = require('../adapters/claude-code/event');
const { resolveStateDirFromTranscript } = require('../adapters/claude-code/statedir');
const { listLedgers, renderReviewReport } = require('../core/review');

function main() {
  const { transcriptPath } = readStdinEvent();
  if (!transcriptPath) return;
  const stateDir = resolveStateDirFromTranscript(transcriptPath);
  const report = renderReviewReport(listLedgers(stateDir));
  if (report) process.stdout.write(report + '\n');
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
