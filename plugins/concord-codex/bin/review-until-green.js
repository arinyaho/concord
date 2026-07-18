#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runReviewUntilGreen } = require('../engine/codex-review-runner');

const args = process.argv.slice(2);
const broadPhraseArgs = new Set();
for (let i = 0; i < args.length; i++) {
  const arg = args[i].trim().toLowerCase();
  if (arg === '게이트' || arg === 'broad review') broadPhraseArgs.add(i);
  if (arg === 'broad' && args[i + 1] && args[i + 1].trim().toLowerCase() === 'review') {
    broadPhraseArgs.add(i);
    broadPhraseArgs.add(i + 1);
  }
}
const broad = args.includes('--broad') || args.includes('--gate') || broadPhraseArgs.size > 0;
const positional = args.filter((arg, index) => arg !== '--broad' && arg !== '--gate' && !broadPhraseArgs.has(index));
const resumed = positional[0] === 'resume';
const ref = (resumed ? positional[1] : positional[0]) || require('node:child_process').execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const base = resumed ? positional[2] : positional[1];
runReviewUntilGreen({ ref, base, broad, repoRoot: process.cwd(), cliPath: path.join(__dirname, 'review-cli.js') })
  .then((result) => process.stdout.write(`${result.handoff || result.message || JSON.stringify(result)}\n`))
  .catch((error) => { process.stderr.write(`review-until-green: ${error.message}\n`); process.exit(1); });
