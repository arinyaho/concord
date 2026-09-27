'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function runPath(stateDir, key) {
  return path.join(path.resolve(stateDir), `initiative-review-${crypto.createHash('sha256').update(key).digest('hex')}.json`);
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function openInitiativeRun({ stateDir, key, maxLaunches, maxRounds }) {
  if (!stateDir || !key) throw new Error('initiative review requires both a run key and canonical state directory');
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('initiative review budgets must be positive integers');
  const file = runPath(stateDir, key);
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!ledger) {
    ledger = { version: 1, status: 'active', budget: { maxLaunches, maxRounds }, launches: [] };
    write(file, ledger);
  } else if (ledger.status === 'terminal' || ledger.budget?.maxLaunches !== maxLaunches || ledger.budget?.maxRounds !== maxRounds) {
    throw new Error('initiative review run is terminal or has immutable configured budgets');
  }
  return { path: file };
}

function reserveLaunch(run, launch) {
  const lock = `${run.path}.lock`;
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
    if (ledger.status !== 'active' || !Number.isInteger(launch.round) || launch.round > ledger.budget.maxRounds || ledger.launches.length >= ledger.budget.maxLaunches) return false;
    write(run.path, { ...ledger, launches: [...ledger.launches, { role: launch.role, round: launch.round }] });
    return true;
  } finally { fs.rmdirSync(lock); }
}

function finishInitiativeRun(run) {
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  write(run.path, { ...ledger, status: 'terminal' });
}

module.exports = { runPath, openInitiativeRun, reserveLaunch, finishInitiativeRun };
