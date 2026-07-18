#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runReviewUntilGreen } = require('../engine/codex-review-runner');

const args = process.argv.slice(2);
const broad = args.includes('--broad') || args.includes('--gate');
const positional = args.filter((arg) => arg !== '--broad' && arg !== '--gate');
const resumed = positional[0] === 'resume';
const ref = (resumed ? positional[1] : positional[0]) || require('node:child_process').execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const base = resumed ? positional[2] : positional[1];
runReviewUntilGreen({ ref, base, broad, repoRoot: process.cwd(), cliPath: path.join(__dirname, 'review-cli.js') })
  .then((result) => process.stdout.write(`${result.handoff || result.message || JSON.stringify(result)}\n`))
  .catch((error) => { process.stderr.write(`review-until-green: ${error.message}\n`); process.exit(1); });
