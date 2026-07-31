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
  const rejectedRule = shape.arrays.includes('rejected')
    ? ` Each "rejected" entry is an object {"id":"<finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"} -- a bare id string is not accepted.`
    : '';
  return `Rewrite only round artifact ${name} as JSON: {"status":"ok",${fields}}. Findings require id, file, and summary; ids must use ${prefixes}<stable-slug>.${rejectedRule} Do not add prose or extra top-level fields.`;
}

function normalizeArtifact(name, raw) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`unknown artifact role: ${name}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new ArtifactError('fatal', `${name} artifact is not JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new ArtifactError('fatal', `${name} artifact must be an object`);
  if (!['ok', 'findings', 'clean'].includes(parsed.status)) throw new ArtifactError('retry', `${name} artifact has unsupported status`);
  // A reviewer that could not run a tool it was told to use must say so in
  // `blocked` rather than quietly substituting a weaker method. This is fatal,
  // not a retry: re-running the same reviewer in the same broken environment
  // reproduces the same block, and a schema-valid verdict from a reviewer that
  // never performed its check is worse than a loud failure -- it is
  // indistinguishable from a real one and can manufacture a false clean.
  if (parsed.blocked !== undefined) {
    if (!Array.isArray(parsed.blocked)) throw new ArtifactError('fatal', `${name} artifact field "blocked" must be an array`);
    if (parsed.blocked.length) {
      throw new ArtifactError('fatal', `${name} reviewer could not run: ${parsed.blocked.map((b) => String(b)).join('; ')} -- it was blocked from the method it was assigned, so this round has no usable verdict. Fix the reviewer's environment (sandbox, permissions, missing tool) and re-run; do not accept the artifact.`);
    }
  }
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
  // A rejection kills a confirmed finding, so it carries the same burden of
  // proof the finding did: one line naming what was actually run. Without it a
  // rejection backed by a real measurement and one backed by a guess produce
  // byte-identical artifacts, and the only way to tell them apart is reading
  // the reviewer's log. A bare id string is accepted on input (legacy shape)
  // but fails the reason check, so it retries into the object form.
  for (const key of shape.arrays.filter((key) => key === 'rejected')) {
    canonical[key] = canonical[key].map((entry, index) => {
      const id = typeof entry === 'string' ? entry : entry && entry.id;
      if (typeof id !== 'string' || !isValidFindingId(id) || !shape.prefixes.some((prefix) => id.startsWith(prefix))) throw new ArtifactError('retry', `${name} rejected[${index}] has invalid id "${typeof entry === 'string' ? entry : entry && entry.id}"`);
      const reason = entry && typeof entry === 'object' ? entry.reason : undefined;
      if (typeof reason !== 'string' || !reason.trim()) throw new ArtifactError('retry', `${name} rejected[${index}] ("${id}") has no "reason" -- every rejection must state in one line what was actually run, measured, or read to reject it`);
      return { id, reason: reason.trim() };
    });
  }
  return canonical;
}

module.exports = { ArtifactError, normalizeArtifact, retryPrompt, ARTIFACT_ROLES: Object.keys(SHAPES) };
