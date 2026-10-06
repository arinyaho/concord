'use strict';

const { isValidFindingId } = require('./gate-contract');

const SHAPES = {
  correctness: { arrays: ['examined', 'findings'], prefixes: ['correctness:', 'docreview:'] },
  verify: { arrays: ['rejected', 'findings'], prefixes: ['correctness:', 'docreview:'] }, // findings: distrust-green, same as gate-verify
  plan: { arrays: ['groups'], prefixes: ['correctness:', 'docreview:'] },
  intent: { arrays: ['findings'], prefixes: ['intent:'] },
  gate: { arrays: ['findings'], prefixes: ['gate:'] },
  'gate-verify': { arrays: ['rejected', 'findings'], prefixes: ['gate:'] },
};

class ArtifactError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function allowedFindingPrefixes(name) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`unknown artifact role: ${name}`);
  return [...shape.prefixes];
}

function retryPrompt(name) {
  const shape = SHAPES[name];
  const fields = shape.arrays.map((key) => `"${key}":[]`).join(',');
  const prefixes = allowedFindingPrefixes(name).join(' or ');
  const rejectedRule = shape.arrays.includes('rejected')
    ? ` Each "rejected" entry is an object {"id":"<finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"} -- a bare id string is not accepted.`
    : '';
  const groupsRule = name === 'plan' ? ' A v2 plan must classify every surviving finding into exactly one group; never invent an implicit singleton.' : name === 'verify' ? ' The optional "groups" array is legacy evidence only and cannot authorize edits.' : '';
  const ownershipRule = name === 'gate-verify'
    ? ` This artifact role is gate-verify. The only allowed finding ID prefix is ${prefixes}. ${allowedFindingPrefixes('verify').map((prefix) => `${prefix}*`).join(' and ')} candidates are context only and must not be dispositioned in this artifact; their disposition belongs to the correctness verifier. Rewrite only the gate candidates' verdict, preserve the original evidence, and do not delete evidence merely to manufacture a clean verdict.`
    : '';
  return `Rewrite only round artifact ${name} as JSON: {"status":"ok",${name === 'plan' ? '"protocolVersion":2,' : ''}${fields}}. Findings require id, file, and summary; ids must use ${prefixes}<stable-slug>.${rejectedRule}${groupsRule}${ownershipRule} Do not add prose or other extra top-level fields, with one exception: if you could not run the method you were assigned, keep (or add) "blocked":["<tool>: <what failed>"] -- never drop it to make this artifact validate.`;
}

function repairPrompt(packetPath, candidatePath) {
  return `You are performing artifact-repair, not a review. Read only ${JSON.stringify(packetPath)} and its immutable snapshot. Do not inspect a repository, diff, history, design, or other artifacts. Write only a JSON candidate to ${JSON.stringify(candidatePath)}. Preserve every established item by identity; do not add, remove, relabel, or infer evidence.`;
}

function repairPacket(name, error, original) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`unknown artifact role: ${name}`);
  let parsed;
  try { parsed = JSON.parse(original); } catch (_) { throw new Error('repair packet requires JSON original'); }
  const foreign = (value) => typeof value === 'string' && !shape.prefixes.some((prefix) => value.startsWith(prefix));
  const candidateIds = [...new Set(shape.arrays.flatMap((key) => Array.isArray(parsed[key]) ? parsed[key].map((item) => typeof item === 'string' ? item : item && item.id).filter((id) => typeof id === 'string' && !foreign(id)) : []))];
  return { role: name, error, schema: { requiredArrays: shape.arrays, ...(name === 'plan' ? { protocolVersion: 2 } : {}) }, allowedPrefixes: [...shape.prefixes], candidateIds };
}

function preservesArtifact(name, raw, candidate) {
  let original;
  try { original = JSON.parse(raw); } catch (_) { return false; }
  if (!original || typeof original !== 'object' || Array.isArray(original) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const comparable = (value) => JSON.stringify(value);
  const shape = SHAPES[name];
  if (!shape) return false;
  for (const key of Object.keys(original)) {
    if (key === 'status') continue;
    // A gate verifier may remove foreign correctness dispositions only when a
    // complete gate disposition remains. The immutable original stays audited.
    if (name === 'gate-verify' && (key === 'findings' || key === 'rejected') && Array.isArray(original[key])) {
      const owned = original[key].filter((item) => {
        const id = typeof item === 'string' ? item : item && item.id;
        return typeof id === 'string' && shape.prefixes.some((prefix) => id.startsWith(prefix));
      });
      if (owned.length !== original[key].length) {
        if (!owned.length || !Array.isArray(candidate[key]) || comparable(owned) !== comparable(candidate[key])) return false;
        continue;
      }
    }
    if (comparable(original[key]) !== comparable(candidate[key])) return false;
  }
  for (const key of Object.keys(candidate)) if (key !== 'status' && !Object.hasOwn(original, key)) return false;
  return true;
}

function normalizeArtifact(name, raw) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`unknown artifact role: ${name}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new ArtifactError('fatal', `${name} artifact is not JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new ArtifactError('fatal', `${name} artifact must be an object`);
  // Checked BEFORE `status`: a blocked reviewer often pairs the declaration
  // with `"status":"blocked"`, and treating that as a mere status problem would
  // hand it the retry prompt -- which tells it to emit a schema-valid verdict
  // without extra fields, i.e. to drop the very declaration that must fail the
  // round. A declared block wins over whatever status it came with.
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
  if (name === 'plan') {
    if (parsed.protocolVersion !== 2) throw new ArtifactError('retry', 'plan artifact requires protocolVersion 2');
    canonical.protocolVersion = 2;
  }
  if ((name === 'verify' || name === 'plan') && parsed.groups !== undefined) {
    if (!Array.isArray(parsed.groups)) throw new ArtifactError('fatal', 'verify artifact field "groups" must be an array');
    canonical.groups = parsed.groups.map((group, index) => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) throw new ArtifactError('fatal', `verify group[${index}] is not an object`);
      const findingIds = group.findingIds;
      if (!Array.isArray(findingIds) || !findingIds.length || new Set(findingIds).size !== findingIds.length
        || findingIds.some((id) => !isValidFindingId(id) || !shape.prefixes.some((prefix) => id.startsWith(prefix)))) {
        throw new ArtifactError('retry', `verify group[${index}] has invalid or duplicate findingIds`);
      }
      if (typeof group.rootCause !== 'string' || !group.rootCause.trim()) throw new ArtifactError('retry', `verify group[${index}] is missing "rootCause"`);
      if (!Array.isArray(group.invariants) || !group.invariants.length || group.invariants.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new ArtifactError('retry', `verify group[${index}] must name at least one invariant`);
      }
      if (!['local', 'structural'].includes(group.changeClass)) throw new ArtifactError('retry', `verify group[${index}] has invalid "changeClass"`);
      if (!['fix', 'reconcile'].includes(group.action) || (group.action === 'reconcile' && group.changeClass !== 'structural')) {
        throw new ArtifactError('retry', `verify group[${index}] has invalid "action"`);
      }
      if (group.action === 'reconcile' && (typeof group.reason !== 'string' || !group.reason.trim())) {
        throw new ArtifactError('retry', `verify group[${index}] must explain why human reconciliation is required`);
      }
      if (name === 'plan' && (typeof group.groupId !== 'string' || !/^[a-z0-9][a-z0-9:._-]*$/.test(group.groupId))) {
        throw new ArtifactError('retry', `plan group[${index}] has invalid "groupId"`);
      }
      const structuralEffects = group.structuralEffects === undefined ? [] : group.structuralEffects;
      if (!Array.isArray(structuralEffects) || structuralEffects.some((item) => !['identity', 'ownership', 'retry-accounting', 'ordering', 'idempotency', 'lease-fence', 'deadline-ttl'].includes(item))) {
        throw new ArtifactError('retry', `${name} group[${index}] has invalid "structuralEffects"`);
      }
      if (name === 'plan' && group.changeClass === 'structural' && !structuralEffects.length) {
        throw new ArtifactError('retry', `plan group[${index}] must name structuralEffects`);
      }
      let designEvidence;
      if (name === 'plan' && group.changeClass === 'structural' && group.action === 'fix') {
        const evidence = group.designEvidence;
        if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
          || typeof evidence.source !== 'string' || !evidence.source.trim()
          || typeof evidence.sourceHash !== 'string' || !evidence.sourceHash.trim()
          || !Array.isArray(evidence.requirements) || !evidence.requirements.length || evidence.requirements.some((item) => typeof item !== 'string' || !item.trim())
          || typeof evidence.uniqueness !== 'string' || !evidence.uniqueness.trim()) {
          throw new ArtifactError('retry', `plan group[${index}] structural fix requires designEvidence`);
        }
        designEvidence = { source: evidence.source.trim(), sourceHash: evidence.sourceHash.trim(), requirements: evidence.requirements.map((item) => item.trim()), uniqueness: evidence.uniqueness.trim() };
      }
      return {
        ...(name === 'plan' ? { groupId: group.groupId } : {}), findingIds: [...findingIds], rootCause: group.rootCause.trim(), invariants: group.invariants.map((item) => item.trim()),
        changeClass: group.changeClass, ...(name === 'plan' || group.structuralEffects !== undefined ? { structuralEffects: [...structuralEffects] } : {}), action: group.action,
        ...(designEvidence ? { designEvidence } : {}), ...(group.action === 'reconcile' ? { reason: group.reason.trim() } : {}),
      };
    });
  }
  return canonical;
}

module.exports = { ArtifactError, normalizeArtifact, retryPrompt, repairPrompt, repairPacket, preservesArtifact, allowedFindingPrefixes, ARTIFACT_ROLES: Object.keys(SHAPES) };
