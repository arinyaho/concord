#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { compareReviewResults } = require('../engine/review-eval');

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  process.stderr.write('usage: review-eval <baseline.json> <candidate.json>\n');
  process.exit(2);
}
try {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const report = compareReviewResults(baseline, candidate);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`review-eval: ${error.message}\n`);
  process.exitCode = 2;
}
