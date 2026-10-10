'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./atomic-write');
const { canonicalPath, runPath, repositoryIdentity } = require('./initiative-review-run');

const SESSION_MODES = ['off', 'suggest', 'stop-at-checkpoint'];
const BOUNDARIES = ['stage-complete', 'batch-complete', 'round-complete'];
const SCOPES = ['orchestrator', 'implementation', 'review'];
// THRESHOLDS are the soft limits; HARD_LIMITS apply to a standalone ticket-to-pr run, which stops at the next safe step.
const THRESHOLDS = { inputTokens: 128000, toolCalls: 50, noProgressCalls: 10 };
const HARD_LIMITS = { inputTokens: 200000, toolCalls: 100 };
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(`session handoff: ${message}`); };

function observations(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('observations must be an object');
  return Object.fromEntries(Object.keys(THRESHOLDS).map((key) => {
    const count = value[key] ?? null;
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) fail(`${key} must be a non-negative integer or unmeasured`);
    return [key, count];
  }));
}

function source(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value)) fail('source paths must be absolute and bounded');
  if (!fs.statSync(value).isFile()) fail('source must be a readable text file');
  const content = fs.readFileSync(value);
  if (!content.length || content.length > 1024 * 1024 || content.includes(0) || !content.toString('utf8').trim()) fail('source must be a nonempty text handoff of at most 1MB');
  return { path: canonicalPath(value), sha256: digest(content), content };
}

function continuationPrompt(checkpoint) {
  return [
    'Continue the existing Concord initiative from this checkpoint in a fresh context.',
    `Scope: ${checkpoint.scope}. Read these source files first:`,
    `State: ${JSON.stringify(checkpoint.sources.state.path)} (sha256 ${checkpoint.sources.state.sha256})`,
    `Handoff: ${JSON.stringify(checkpoint.sources.handoff.path)} (sha256 ${checkpoint.sources.handoff.sha256})`,
    `Latest state: ${JSON.stringify(checkpoint.sources.state.originalPath)}; latest handoff: ${JSON.stringify(checkpoint.sources.handoff.originalPath)}.`,
    'Verify snapshot hashes, then read the latest originals and live ledger. Ordinary subsequent execution progress is not authoritative source drift: skip completed steps and use current verified evidence.',
    `Keep session handoff policy ${checkpoint.mode}.`,
    'Verify their hashes, authoritative source versions, approved contract, authorization, branch/head/base and current checks before acting. Source drift requires the normal reconciliation procedure.',
    `Keep the same run key ${JSON.stringify(checkpoint.run.key)}, initiative ID ${JSON.stringify(checkpoint.run.initiativeId)}, initiative state directory ${JSON.stringify(checkpoint.run.stateDir)} and delivery mode ${checkpoint.run.mode}.`,
    `Budget snapshot: ${checkpoint.budget.usedLaunches}/${checkpoint.budget.maxLaunches} launches; ${checkpoint.budget.usedRounds}/${checkpoint.budget.maxRounds} review rounds. Recheck the live ledger; this snapshot is not authority to launch.`,
    `Recorded run status: ${checkpoint.run.status}. Preserve any terminal or reconciliation disposition. Budget exhaustion requires reconciliation, not reset, a new key or larger budgets.`,
    'Read the exact next CLI step, target review state directory, existing reservations and completed role artifacts from the handoff. Reuse verified evidence; do not repeat completed investigation or relaunch reserved workers.',
    `Recorded next action (verify against the approved handoff): ${JSON.stringify(checkpoint.nextAction)}`,
    'Replacing context neither passes a gate nor approves new scope. Apply the original initiative options to every review mutation.',
    '',
  ].join('\n');
}

function createSessionHandoff({ packetPath, mode = 'suggest', initiative, repository }) {
  try {
    if (!SESSION_MODES.includes(mode)) fail(`mode must be ${SESSION_MODES.join(' | ')}`);
    if (mode === 'off') return { action: 'continue', mode, triggers: [] };
    if (!packetPath || !path.isAbsolute(packetPath) || fs.statSync(packetPath).size > 32768) fail('packet must be an absolute JSON file of at most 32KB');
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) fail('packet must be an object');
    const observed = observations(packet.observations);
    const triggers = Object.keys(THRESHOLDS).filter((key) => observed[key] !== null && observed[key] >= THRESHOLDS[key]);
    if (!triggers.length) return { action: 'continue', mode, triggers };
    if (!BOUNDARIES.includes(packet.boundary) || !Array.isArray(packet.liveWorkers) || packet.liveWorkers.length) {
      return { action: 'defer', mode, triggers, reason: 'finish a safe boundary and drain existing workers before handoff' };
    }
    if (!SCOPES.includes(packet.scope)) fail('scope must be orchestrator, implementation or review');
    if (typeof packet.nextAction !== 'string' || !packet.nextAction.trim() || packet.nextAction.length > 1000) fail('nextAction must contain 1 to 1000 characters');
    const state = source(packet.statePath);
    const handoff = source(packet.handoffPath);
    if (state.path === handoff.path) fail('state and handoff must be distinct files');
    // Read only: a context checkpoint cannot open, reset or advance a run.
    const ledger = JSON.parse(fs.readFileSync(runPath(initiative.stateDir, initiative.key), 'utf8'));
    if (ledger.version !== 5 || ledger.repository !== repositoryIdentity(repository)
      || !['base', 'lite'].includes(ledger.mode) || !['active', 'terminal'].includes(ledger.status)
      || (initiative.mode && initiative.mode !== ledger.mode)
      || ledger.budget?.maxLaunches !== Number(initiative.maxLaunches)
      || ledger.budget?.maxRounds !== Number(initiative.maxRounds)
      || !Array.isArray(ledger.launches) || !Array.isArray(ledger.rounds)) fail('initiative identity, mode or budgets disagree with the live ledger');
    const checkpoint = {
      schema: 1, mode, scope: packet.scope, boundary: packet.boundary, triggers,
      observationSource: 'caller-reported', observations: observed, sources: { state: { path: state.path, sha256: state.sha256 }, handoff: { path: handoff.path, sha256: handoff.sha256 } }, nextAction: packet.nextAction,
      run: { key: initiative.key, initiativeId: ledger.initiativeId || initiative.key, stateDir: canonicalPath(initiative.stateDir), mode: ledger.mode, status: ledger.status },
      budget: { maxLaunches: ledger.budget.maxLaunches, maxRounds: ledger.budget.maxRounds, usedLaunches: ledger.launches.length, usedRounds: ledger.rounds.length },
    };
    const directory = path.join(checkpoint.run.stateDir, `session-handoff-${digest(JSON.stringify(checkpoint))}`);
    for (const [name, original] of Object.entries({ state, handoff })) {
      checkpoint.sources[name] = { path: path.join(directory, `${name}${path.extname(original.path) || '.txt'}`), originalPath: original.path, sha256: original.sha256 };
    }
    const json = `${JSON.stringify(checkpoint, null, 2)}\n`;
    const prompt = continuationPrompt(checkpoint);
    if (Buffer.byteLength(prompt, 'utf8') > 16384) fail('continuation prompt exceeds 16KB');
    const checkpointPath = path.join(directory, 'checkpoint.json');
    const promptPath = path.join(directory, 'resume.md');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, original] of Object.entries({ state, handoff })) {
      writeFileAtomic(checkpoint.sources[name].path, original.content, { mode: 0o600 });
      if (digest(fs.readFileSync(checkpoint.sources[name].path)) !== original.sha256) fail('source snapshot read-back failed');
    }
    writeFileAtomic(checkpointPath, json, { mode: 0o600 });
    writeFileAtomic(promptPath, prompt, { mode: 0o600 });
    if (fs.readFileSync(checkpointPath, 'utf8') !== json || fs.readFileSync(promptPath, 'utf8') !== prompt) fail('continuation read-back failed');
    return { action: mode === 'stop-at-checkpoint' ? 'stop' : 'suggest', mode, triggers, checkpointPath, promptPath };
  } catch (error) {
    if (error.message.startsWith('session handoff:')) throw error;
    fail(error.message);
  }
}

module.exports = { SESSION_MODES, THRESHOLDS, HARD_LIMITS, createSessionHandoff };
