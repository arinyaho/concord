#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { resolveStateDirFromTranscript } = require('../adapters/claude-code/statedir');
const { listLedgers, renderReviewReport } = require('../core/review');

function main() {
  const { transcript_path } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!transcript_path) return;
  const stateDir = resolveStateDirFromTranscript(transcript_path);
  const report = renderReviewReport(listLedgers(stateDir));
  if (report) process.stdout.write(report + '\n');
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
