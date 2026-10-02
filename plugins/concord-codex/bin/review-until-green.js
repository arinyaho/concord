#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runReviewUntilGreen, acknowledgeContinuationPacket } = require('../engine/codex-review-runner');
const { crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('../engine/spawn-cross-platform');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: review-until-green [<branch> [<base>] | file:<path-or-glob> | resume <ref>] [--reviewer <claude|codex|copilot>] [--reviewer-model <model>] [--fixer <claude|codex|copilot>] [--fixer-model <model>] [--reasoning-effort <effort>] [--service-tier <tier>] [--initiative-run-key <key> --initiative-state-dir <absolute-dir> --initiative-max-launches <n> --initiative-max-rounds <n> [--initiative-mode <base|lite>] [--initiative-finalise]] [--session-handoff <off|suggest|stop-at-checkpoint>] [--broad|--no-broad] [--no-dod]\n');
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
if (args.includes('--initiative-finalise')) { inference.initiativeFinalise = true; inferenceArgs.add(args.indexOf('--initiative-finalise')); }
for (const [flag, field] of [['--session-handoff', 'sessionHandoff'], ['--reviewer', 'reviewer'], ['--reviewer-model', 'reviewerModel'], ['--fixer', 'fixer'], ['--fixer-model', 'fixerModel'], ['--reasoning-effort', 'reasoningEffort'], ['--service-tier', 'serviceTier'], ['--initiative-run-key', 'initiativeRunKey'], ['--initiative-state-dir', 'initiativeStateDir'], ['--initiative-max-launches', 'initiativeMaxLaunches'], ['--initiative-max-rounds', 'initiativeMaxRounds'], ['--initiative-mode', 'initiativeMode']]) {
  const index = args.indexOf(flag); const value = index === -1 ? undefined : args[index + 1];
  if (index !== -1 && (!value || !value.trim() || value.startsWith('--') || args.indexOf(flag, index + 1) !== -1)) {
    process.stderr.write(`review-until-green: ${flag} requires exactly one value\n`);
    process.exit(1);
  }
  if (index !== -1) { inference[field] = value; inferenceArgs.add(index); inferenceArgs.add(index + 1); }
}
if (inference.sessionHandoff && !['off', 'suggest', 'stop-at-checkpoint'].includes(inference.sessionHandoff)) {
  process.stderr.write('review-until-green: --session-handoff must be off, suggest, or stop-at-checkpoint\n');
  process.exit(1);
}
if (inference.initiativeRunKey || inference.initiativeStateDir || inference.initiativeMaxLaunches || inference.initiativeMaxRounds || inference.initiativeMode) {
  if (!inference.initiativeRunKey || !inference.initiativeStateDir || !/^\d+$/.test(inference.initiativeMaxLaunches || '') || !/^\d+$/.test(inference.initiativeMaxRounds || '')) {
    process.stderr.write('review-until-green: initiative runs require key, canonical state dir, positive launch and round budgets\n');
    process.exit(1);
  }
  inference.initiativeMaxLaunches = Number(inference.initiativeMaxLaunches);
  inference.initiativeMaxRounds = Number(inference.initiativeMaxRounds);
  if (!path.isAbsolute(inference.initiativeStateDir)) {
    process.stderr.write('review-until-green: --initiative-state-dir must be absolute\n');
    process.exit(1);
  }
}
for (const field of ['reviewer', 'fixer']) {
  if (inference[field] && !['claude', 'codex', 'copilot'].includes(inference[field])) {
    process.stderr.write(`review-until-green: --${field} must be claude, codex, or copilot\n`);
    process.exit(1);
  }
}
const positional = args.filter((arg, index) => arg !== '--broad' && arg !== '--gate' && arg !== '--no-broad' && arg !== '--no-dod' && !inferenceArgs.has(index) && !broadPhraseArgs.has(index));
const resumed = positional[0] === 'resume';
const ref = (resumed ? positional[1] : positional[0]) || (inference.initiativeFinalise ? undefined : require('node:child_process').execFileSync(crossPlatformCommand('git', process.cwd()), crossPlatformArgs(['branch', '--show-current'], needsDoubleEscape('git', process.cwd())), crossPlatformOpts({ encoding: 'utf8' })).trim());
const base = resumed ? positional[2] : positional[1];
const runnerOptions = { ref, base, broad, noBroad, noDod, ...inference, resume: resumed, handleSignals: true, repoRoot: process.cwd(), cliPath: path.join(__dirname, 'review-cli.js') };
const write = (stream, text) => new Promise((resolve, reject) => stream.write(text, (error) => error ? reject(error) : resolve()));
const deliver = async (stream, packet) => {
  // Write before acknowledging: the packet must actually reach the caller
  // before the ledger marks it consumed, or a write failure between the two
  // would lose a handoff the ledger already claims was delivered. A failed
  // acknowledgement after a successful write is non-fatal -- the ledger
  // entry simply stays unconsumed and the next invocation redelivers it
  // (safe: the caller reads the same claim id either way).
  await write(stream, `${JSON.stringify(packet)}\n`);
  if (packet.delivery?.consumed === false && !acknowledgeContinuationPacket(runnerOptions, packet.delivery.claim)) {
    process.stderr.write('review-until-green: initiative delivery acknowledgement was contended; the ledger will redeliver this packet on the next invocation\n');
  }
};
const deliveredSessionHandoffs = new Set();
runnerOptions.onSessionHandoff = async (handoff) => {
  if (deliveredSessionHandoffs.has(handoff.promptPath)) return;
  await write(process.stdout, `${JSON.stringify({ sessionHandoff: handoff })}\n`);
  deliveredSessionHandoffs.add(handoff.promptPath);
};
runReviewUntilGreen(runnerOptions)
  .then(async (result) => {
    if (result.continuationPacket) await deliver(process.stdout, result.continuationPacket);
    else if (!(result.decision === 'terminal' && result.initiative)) await write(process.stdout, `${result.handoff || result.message || JSON.stringify(result)}\n`);
    if (result.sessionHandoff) await runnerOptions.onSessionHandoff(result.sessionHandoff);
    // Signal blocked reviews and stopped/failed handoffs to callers inspecting only exit status.
    if (result.decision === 'blocked' || result.decision === 'reconciliation-required' || result.decision === 'session-handoff') process.exitCode = 1;
  })
  .catch(async (error) => {
    try {
      if (error.continuationPacket) await deliver(process.stderr, error.continuationPacket);
      else await write(process.stderr, `review-until-green: ${error.message}\n`);
    } catch (deliveryError) { process.stderr.write(`review-until-green: ${deliveryError.message}\n`); }
    process.exit(1);
  });
