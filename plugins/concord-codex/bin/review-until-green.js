#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runReviewUntilGreen } = require('../engine/codex-review-runner');
const { crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('../engine/spawn-cross-platform');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: review-until-green [<branch> [<base>] | file:<path-or-glob> | resume <ref>] [--reviewer <claude|codex|copilot>] [--reviewer-model <model>] [--fixer <claude|codex|copilot>] [--fixer-model <model>] [--reasoning-effort <effort>] [--service-tier <tier>] [--broad|--no-broad] [--no-dod]\n');
  process.exit(0);
}
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
// --no-dod must be stripped from the positionals like the broad flags are:
// left in, it would be read as `ref` or `base` and passed to git as a ref.
const noBroad = args.includes('--no-broad');
const noDod = args.includes('--no-dod');
const inference = {};
const inferenceArgs = new Set();
for (const [flag, field] of [['--reviewer', 'reviewer'], ['--reviewer-model', 'reviewerModel'], ['--fixer', 'fixer'], ['--fixer-model', 'fixerModel'], ['--reasoning-effort', 'reasoningEffort'], ['--service-tier', 'serviceTier']]) {
  const index = args.indexOf(flag); const value = index === -1 ? undefined : args[index + 1];
  if (index !== -1 && (!value || !value.trim() || value.startsWith('--') || args.indexOf(flag, index + 1) !== -1)) {
    process.stderr.write(`review-until-green: ${flag} requires exactly one value\n`);
    process.exit(1);
  }
  if (index !== -1) { inference[field] = value; inferenceArgs.add(index); inferenceArgs.add(index + 1); }
}
for (const field of ['reviewer', 'fixer']) {
  if (inference[field] && !['claude', 'codex', 'copilot'].includes(inference[field])) {
    process.stderr.write(`review-until-green: --${field} must be claude, codex, or copilot\n`);
    process.exit(1);
  }
}
const positional = args.filter((arg, index) => arg !== '--broad' && arg !== '--gate' && arg !== '--no-broad' && arg !== '--no-dod' && !inferenceArgs.has(index) && !broadPhraseArgs.has(index));
const resumed = positional[0] === 'resume';
const ref = (resumed ? positional[1] : positional[0]) || require('node:child_process').execFileSync(crossPlatformCommand('git', process.cwd()), crossPlatformArgs(['branch', '--show-current'], needsDoubleEscape('git', process.cwd())), crossPlatformOpts({ encoding: 'utf8' })).trim();
const base = resumed ? positional[2] : positional[1];
runReviewUntilGreen({ ref, base, broad, noBroad, noDod, ...inference, resume: resumed, repoRoot: process.cwd(), cliPath: path.join(__dirname, 'review-cli.js') })
  .then((result) => process.stdout.write(`${result.handoff || result.message || JSON.stringify(result)}\n`))
  .catch((error) => { process.stderr.write(`review-until-green: ${error.message}\n`); process.exit(1); });
