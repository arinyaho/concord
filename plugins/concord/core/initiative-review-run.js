'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function runPath(stateDir, key) {
  if (!path.isAbsolute(stateDir)) throw new Error('initiative review state directory must be absolute');
  return path.join(stateDir, `initiative-review-${crypto.createHash('sha256').update(key).digest('hex')}.json`);
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function locked(run, update) {
  const lock = `${run.path}.lock`;
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    const next = update(JSON.parse(fs.readFileSync(run.path, 'utf8')));
    if (next) write(run.path, next);
    return next || false;
  } finally { fs.rmdirSync(lock); }
}

function hint(trigger, finding = null, stage = null, avoidedLaunches = 0) {
  return { trigger, firstMaterialFinding: finding, stage, avoidedLaunches, preflight: ['confirm target revisions', 'confirm checks', 'choose resume, revise, or split'], options: ['resume', 'revise', 'split'] };
}

function openInitiativeRun({ stateDir, key, maxLaunches, maxRounds }) {
  if (!stateDir || !key) throw new Error('initiative review requires both a run key and canonical state directory');
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('initiative review budgets must be positive integers');
  const file = runPath(stateDir, key);
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!ledger) {
    ledger = { version: 2, status: 'active', budget: { maxLaunches, maxRounds }, launches: [], rounds: [], targets: [], findings: {}, checks: [], telemetry: [], terminal: null, reconciliation: null };
    write(file, ledger);
  } else if (ledger.status === 'terminal' || ledger.budget?.maxLaunches !== maxLaunches || ledger.budget?.maxRounds !== maxRounds) {
    throw new Error('initiative review run is terminal or has immutable configured budgets');
  }
  return { path: file };
}

function reserveLaunch(run, launch) {
  return Boolean(locked(run, (ledger) => {
    if (ledger.status !== 'active' || !Number.isInteger(launch.round) || ledger.launches.length >= ledger.budget.maxLaunches) return null;
    const target = launch.target || launch.revision?.ref || 'unknown';
    const round = `${target}\u0000${launch.round}`;
    const rounds = ledger.rounds || [];
    if (!rounds.includes(round) && rounds.length >= ledger.budget.maxRounds) return null;
    const revision = launch.revision && { ref: launch.revision.ref || target, ...(launch.revision.base ? { base: launch.revision.base } : {}), ...(launch.revision.head ? { head: launch.revision.head } : {}) };
    const targets = revision && !(ledger.targets || []).some((item) => JSON.stringify(item) === JSON.stringify(revision)) ? [...(ledger.targets || []), revision] : (ledger.targets || []);
    return { ...ledger, rounds: rounds.includes(round) ? rounds : [...rounds, round], targets, launches: [...ledger.launches, { role: launch.role, round: launch.round, ...(target === 'unknown' ? {} : { target }) }] };
  }));
}

function recordTargetTerminal(run, { target, reason = 'target-terminal', finding = null, stage = null, avoidedLaunches = 0, findings = {}, checks = [], telemetry = [] }) {
  const safeTelemetry = telemetry.map(({ role, stage: telemetryStage, revision, count, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }) => ({ role, ...(telemetryStage ? { stage: telemetryStage } : {}), ...(revision ? { revision } : {}), ...(Number.isInteger(count) ? { count } : {}), elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }));
  locked(run, (ledger) => {
    const terminal = { target, reason };
    const previous = ledger.reconciliation || {};
    return { ...ledger, findings: { ...(ledger.findings || {}), ...Object.fromEntries(Object.entries(findings).map(([kind, count]) => [kind, (ledger.findings?.[kind] || 0) + count])) }, checks: [...(ledger.checks || []), ...checks], telemetry: [...(ledger.telemetry || []), ...safeTelemetry], reconciliation: { terminals: [...(previous.terminals || []), terminal], hint: reason === 'reconciliation-required' ? hint(reason, finding, stage, avoidedLaunches) : (previous.hint || hint(reason, finding, stage, avoidedLaunches)) } };
  });
}

function finaliseInitiativeRun(run, reason = 'finalised') {
  return Boolean(locked(run, (ledger) => ledger.status === 'active' && { ...ledger, status: 'terminal', terminal: { reason }, reconciliation: ledger.reconciliation || { terminals: [], hint: hint(reason) } }));
}

module.exports = { runPath, openInitiativeRun, reserveLaunch, recordTargetTerminal, finaliseInitiativeRun, finishInitiativeRun: finaliseInitiativeRun };
