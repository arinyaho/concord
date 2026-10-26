'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalPath, repositoryIdentity } = require('./initiative-review-run');
const MAX_BYTES = 64 * 1024;
const CLASSIFICATIONS = ['defect', 'acceptance-blocker', 'design-decision', 'optional-hardening'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const text = value => typeof value === 'string' && !!value.trim();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = ['repository', 'stateDir', 'bindingHash', 'target', 'attemptId', 'round', 'head', 'id', 'action', 'findingHash'];
function findingHash(finding) {
  const evidence = {};
  for (const key of ['id', 'gate', 'file', 'span', 'evidence', 'summary', 'requirement', 'class', 'releaseBlocking', 'rationale', 'blockingReason']) if (finding[key] !== undefined) evidence[key] = finding[key];
  return digest(JSON.stringify(evidence));
}
function decisionSnapshot({ repoRoot, stateDir, ledger, id, action, finding }) {
  if (!['dismiss', 'defer'].includes(action) || !finding || finding.id !== id || !text(ledger?.target?.ref) || !text(ledger.attemptId) || !Number.isInteger(ledger.round) || ledger.round < 1 || !text(ledger.target.head_sha)) throw new Error('decision snapshot requires a current finding, action and complete review identity');
  return { repository: repositoryIdentity(repoRoot), stateDir: canonicalPath(stateDir), bindingHash: digest(JSON.stringify(ledger.initiative_binding || null)), target: ledger.target.ref, attemptId: ledger.attemptId, round: ledger.round, head: ledger.target.head_sha, id, action, findingHash: findingHash(finding) };
}
function readReceipt(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('decision receipt requires an absolute file path');
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('unsafe file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const same = stat => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (!same(fs.fstatSync(fd))) throw new Error('changed file');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) { const n = fs.readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
    if (length > MAX_BYTES || length !== before.size || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) throw new Error('changed or oversized file');
    const bytes = buffer.subarray(0, length), raw = bytes.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new Error('invalid UTF-8');
    const value = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || ['by', 'sessionId', 'text'].some(k => !text(value[k])) || Object.keys(value).some(k => !['version', 'by', 'sessionId', 'text', 'decisions'].includes(k)) || !Array.isArray(value.decisions) || !value.decisions.length) throw new Error('invalid receipt schema');
    const seen = new Set();
    for (const entry of value.decisions) {
      if (!object(entry) || fields.filter(k => k !== 'round').some(k => !text(entry[k])) || !Number.isInteger(entry.round) || entry.round < 1 || !['dismiss', 'defer'].includes(entry.action) || !/^[a-f0-9]{64}$/.test(entry.findingHash) || !/^[a-f0-9]{64}$/.test(entry.bindingHash)
        || Object.keys(entry).some(k => ![...fields, 'classification', 'classificationReason', 'reason', 'ref'].includes(k))) throw new Error('invalid decision entry');
      if (entry.action === 'dismiss') {
        if (entry.reason !== undefined || entry.ref !== undefined || (entry.classification !== undefined && !CLASSIFICATIONS.includes(entry.classification)) || (entry.classificationReason !== undefined && (!text(entry.classificationReason) || !entry.classification))) throw new Error('invalid dismissal classification');
      } else if (entry.classification !== undefined || entry.classificationReason !== undefined || !text(entry.reason) || !text(entry.ref)) throw new Error('deferral requires a reason and tracker reference');
      const key = JSON.stringify(fields.filter(k => k !== 'findingHash').map(k => entry[k]));
      if (seen.has(key)) throw new Error('ambiguous duplicate decision'); seen.add(key);
    }
    return { value, hash: digest(bytes) };
  } catch (error) { throw new Error(`decision receipt is invalid or unsafe: ${error.message}`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function resolveDecision({ file, repoRoot, stateDir, ledger, id, action, finding, prior }) {
  const { value, hash } = readReceipt(file);
  const current = { repository: repositoryIdentity(repoRoot), stateDir: canonicalPath(stateDir), bindingHash: digest(JSON.stringify(ledger.initiative_binding || null)), target: ledger.target?.ref, attemptId: ledger.attemptId, round: ledger.round, head: ledger.target?.head_sha, id, action };
  const entries = value.decisions.filter(entry => Object.keys(current).every(k => entry[k] === current[k]));
  if (entries.length !== 1) throw new Error('decision receipt must name this exact worker, finding, action, attempt, round and revision once');
  const entry = entries[0];
  if (prior) {
    if (prior.receiptHash !== hash || JSON.stringify(prior.entry) !== JSON.stringify(entry)) throw new Error('closed finding already has different decision provenance');
  } else if (!finding || entry.findingHash !== findingHash(finding)) throw new Error('decision receipt finding evidence changed');
  return { by: value.by, entry, provenance: { by: value.by, sessionId: value.sessionId, text: value.text, receiptHash: hash, entry } };
}
module.exports = { decisionSnapshot, findingHash, resolveDecision, readReceipt, MAX_BYTES };
