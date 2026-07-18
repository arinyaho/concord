'use strict';

const { isValidFindingId } = require('./gate-contract');

const SHAPES = {
  correctness: { arrays: ['examined', 'findings'], prefixes: ['correctness:', 'docreview:'] },
  verify: { arrays: ['rejected'], prefixes: ['correctness:', 'docreview:'] },
  intent: { arrays: ['findings'], prefixes: ['intent:'] },
  gate: { arrays: ['findings'], prefixes: ['gate:'] },
  'gate-verify': { arrays: ['rejected', 'findings'], prefixes: ['gate:'] },
};

class ArtifactError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function retryPrompt(name, prefix) {
  const shape = SHAPES[name];
  const fields = shape.arrays.map((key) => `"${key}":[]`).join(',');
  const prefixes = String(prefix).split('|').join(' or ');
  return `Rewrite only round artifact ${name} as JSON: {"status":"ok",${fields}}. Findings require id, file, and summary; ids must use ${prefixes}<stable-slug>. Do not add prose or extra top-level fields.`;
}

function normalizeArtifact(name, raw) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`unknown artifact role: ${name}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new ArtifactError('fatal', `${name} artifact is not JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new ArtifactError('fatal', `${name} artifact must be an object`);
  if (!['ok', 'findings', 'clean'].includes(parsed.status)) throw new ArtifactError('retry', `${name} artifact has unsupported status`);
  const canonical = { status: 'ok' };
  for (const key of shape.arrays) {
    const value = parsed[key] === undefined ? [] : parsed[key];
    if (!Array.isArray(value)) throw new ArtifactError('fatal', `${name} artifact field "${key}" must be an array`);
    canonical[key] = value;
  }
  for (const key of shape.arrays.filter((key) => key === 'findings')) {
    for (const [index, finding] of canonical[key].entries()) {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new ArtifactError('fatal', `${name} finding[${index}] is not an object`);
      for (const required of ['id', 'file', 'summary']) {
        if (typeof finding[required] !== 'string' || !finding[required]) throw new ArtifactError('fatal', `${name} finding[${index}] is missing "${required}"`);
      }
      if (!isValidFindingId(finding.id) || !shape.prefixes.some((prefix) => finding.id.startsWith(prefix))) throw new ArtifactError('retry', `${name} finding[${index}] has invalid id "${finding.id}"`);
    }
  }
  for (const key of shape.arrays.filter((key) => key === 'rejected')) {
    for (const [index, id] of canonical[key].entries()) {
      if (typeof id !== 'string' || !isValidFindingId(id) || !shape.prefixes.some((prefix) => id.startsWith(prefix))) throw new ArtifactError('retry', `${name} rejected[${index}] has invalid id "${id}"`);
    }
  }
  return canonical;
}

module.exports = { ArtifactError, normalizeArtifact, retryPrompt };
