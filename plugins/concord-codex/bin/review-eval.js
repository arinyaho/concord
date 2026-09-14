#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { compareReviewStage } = require('../engine/review-eval');

const [stageFlag, stage, baselinePath, previousPath, candidatePath, ...extra] = process.argv.slice(2);
const valid = stageFlag === '--stage' && /^pr[1-5]$/.test(stage) && baselinePath && !extra.length
  && (stage === 'pr1' ? !previousPath && !candidatePath : previousPath && candidatePath);
if (!valid) {
  process.stderr.write('usage: review-eval --stage pr1 <pr1-matrix.json> | --stage pr2|pr3|pr4|pr5 <pr1-matrix.json> <previous-matrix.json> <candidate-matrix.json>\n');
  process.exit(2);
}
try {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const previous = previousPath ? JSON.parse(fs.readFileSync(previousPath, 'utf8')) : undefined;
  const candidate = candidatePath ? JSON.parse(fs.readFileSync(candidatePath, 'utf8')) : undefined;
  const report = compareReviewStage(stage, baseline, previous, candidate);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`review-eval: ${error.message}\n`);
  process.exitCode = 2;
}
