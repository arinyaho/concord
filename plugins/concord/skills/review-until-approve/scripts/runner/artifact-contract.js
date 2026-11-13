'use strict';

const { isValidFindingId, normalizeFindingId } = require('./gate-contract');

const SHAPES = {
  correctness: { arrays: ['examined', 'findings'], prefixes: ['correctness:', 'docreview:'] },
  verify: { arrays: ['rejected', 'findings'], prefixes: ['correctness:', 'docreview:'] }, // findings: distrust-green, same as gate-verify
  intent: { arrays: ['findings'], prefixes: ['intent:'] },
  gate: { arrays: ['findings'], prefixes: ['gate:'] },
  'gate-verify': { arrays: ['rejected', 'findings'], prefixes: ['gate:'] },
};

// Earlier findings a verify pass may find answered: the verify prefixes, and the findings of the gate and the intent review.
const ADDRESSABLE_PREFIXES = [...SHAPES.verify.prefixes, ...SHAPES.gate.prefixes, ...SHAPES.intent.prefixes];

class ArtifactError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function allowedFindingPrefixes(name) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`unknown artifact role: ${name}`);
  return [...shape.prefixes];
}

// verify and gate-verify may list a kept candidate in a verdict shape; such an
// entry has no evidence of its own, so a repair may delete it (and only it).
const dropsInvalidFindings = (name) => !!SHAPES[name] && SHAPES[name].arrays.includes('rejected');
const lacksFindingFields = (item) => !!item && typeof item === 'object' && !Array.isArray(item) && ['id', 'file', 'summary'].some((field) => typeof item[field] !== 'string' || !item[field]);

// An entry is foreign only when its id carries none of the role's prefixes;
// a malformed entry (null, no id) is the reviewer's own and is left for normalization to reject.
function isForeign(name, item) {
  const id = typeof item === 'string' ? item : item && item.id;
  return typeof id === 'string' && !SHAPES[name].prefixes.some((prefix) => id.startsWith(prefix));
}
// What a repair may delete from `key`: a foreign entry, or an evidence-less verdict-shape finding.
const repairKeys = (name) => dropsInvalidFindings(name) ? [...SHAPES[name].arrays, 'unverifiable'] : SHAPES[name].arrays;
const removable = (name, key, item) => isForeign(name, item) || (key === 'findings' && dropsInvalidFindings(name) && lacksFindingFields(item));
const ownedItems = (name, key, items) => items.filter((item) => !removable(name, key, item));

// Every place an artifact names a finding id: the callback maps each id string, so one pass both collects and rewrites.
const mapIds = (value, fn) => {
  const one = (item) => typeof item === 'string' ? fn(item) : item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' ? { ...item, id: fn(item.id) } : item;
  const out = { ...value };
  for (const key of ['findings', 'rejected', 'unverifiable', 'blocking', 'addressed']) if (Array.isArray(value[key])) out[key] = value[key].map(one);
  if (Array.isArray(value.duplicates)) out.duplicates = value.duplicates.map((d) => d && typeof d === 'object' ? { ...d, ...(typeof d.id === 'string' ? { id: fn(d.id) } : {}), ...(typeof d.of === 'string' ? { of: fn(d.of) } : {}) } : d);
  return out;
};

// Raw id -> normalized id for every id whose prefix this role may use but whose slug is invalid. Empty when any such id has no
// derivable form or two distinct ids would become one (an order-dependent suffix could attach a verdict to the wrong finding).
function slugRewrites(name, value) {
  const prefixes = [...SHAPES[name].prefixes, ...(name === 'gate-verify' ? SHAPES.verify.prefixes : []), ...ADDRESSABLE_PREFIXES];
  const seen = new Set();
  mapIds(value, (id) => { seen.add(id); return id; });
  const rewrites = new Map();
  const taken = new Map([...seen].filter(isValidFindingId).map((id) => [id, id]));
  for (const id of seen) {
    if (isValidFindingId(id) || !prefixes.some((prefix) => id.startsWith(prefix))) continue;
    const mapped = normalizeFindingId(id);
    if (!mapped || (taken.has(mapped) && taken.get(mapped) !== id)) return new Map();
    taken.set(mapped, id);
    rewrites.set(id, mapped);
  }
  return rewrites;
}

// What a repair deletes (foreign and evidence-less entries) and respells (status), before any id is rewritten.
function strippedCandidate(name, original) {
  const candidate = { ...original };
  if (typeof original.status === 'string') candidate.status = original.status.toLowerCase();
  for (const key of repairKeys(name)) {
    if (key === 'examined' || !Array.isArray(original[key])) continue;
    candidate[key] = ownedItems(name, key, original[key]);
  }
  return candidate;
}

// The only candidate preservesArtifact accepts: the original with its status spelling lowercased, foreign dispositions
// omitted, invalid findings deleted and invalid slugs normalized (the finding and its evidence stay).
function repairCandidate(name, raw) {
  if (!SHAPES[name]) throw new Error(`unknown artifact role: ${name}`);
  const stripped = strippedCandidate(name, JSON.parse(raw));
  const rewrites = slugRewrites(name, stripped);
  return rewrites.size ? mapIds(stripped, (id) => rewrites.get(id) || id) : stripped;
}

// True when a slug rewrite alone would make the artifact's ids valid.
function repairsSlugs(name, raw) {
  let parsed; try { parsed = JSON.parse(raw); } catch (_) { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !SHAPES[name]) return false;
  return slugRewrites(name, strippedCandidate(name, parsed)).size > 0;
}

function preservesArtifact(name, raw, candidate) {
  let original;
  try { original = JSON.parse(raw); } catch (_) { return false; }
  if (!original || typeof original !== 'object' || Array.isArray(original) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const comparable = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${comparable(value[key])}`).join(',')}}`
    : Array.isArray(value) ? `[${value.map(comparable).join(',')}]` : JSON.stringify(value);
  const shape = SHAPES[name];
  if (!shape) return false;
  const ownedEvidence = shape.arrays.flatMap((key) => key === 'examined' ? (original[key] || []) : (Array.isArray(original[key]) ? original[key].filter((item) => !isForeign(name, item)) : []));
  if (!ownedEvidence.length && !shape.arrays.every((key) => Array.isArray(original[key]) && original[key].length === 0)) return false;
  if (slugRewrites(name, strippedCandidate(name, original)).size) return comparable(candidate) === comparable(repairCandidate(name, raw));
  for (const key of Object.keys(original)) {
    if (key === 'status') continue;
    // A repair may omit foreign dispositions only when its role-owned evidence
    // remains complete. The immutable original stays audited.
    if (repairKeys(name).includes(key) && Array.isArray(original[key])) {
      if (key === 'examined') {
        if (!Array.isArray(candidate[key]) || comparable(original[key]) !== comparable(candidate[key])) return false;
        continue;
      }
      const owned = ownedItems(name, key, original[key]);
      if (comparable(owned) !== comparable(original[key])) {
        if (!Array.isArray(candidate[key]) || comparable(owned) !== comparable(candidate[key])) return false;
        continue;
      }
    }
    if (comparable(original[key]) !== comparable(candidate[key])) return false;
  }
  for (const key of Object.keys(candidate)) if (key !== 'status' && !Object.hasOwn(original, key)) return false;
  return true;
}

// A review-only verify pass may say that an earlier finding is answered by the code; the entry carries the evidence a person can check.
function normalizeAddressed(name, list) {
  if (!Array.isArray(list)) throw new ArtifactError('fatal', `${name} artifact field "addressed" must be an array`);
  return list.map((entry, index) => {
    const ev = entry && typeof entry === 'object' ? entry.evidence : undefined;
    const bad = (why) => new ArtifactError('retry', `${name} addressed[${index}] ${why}`);
    if (!entry || typeof entry.id !== 'string' || !isValidFindingId(entry.id) || !ADDRESSABLE_PREFIXES.some((prefix) => entry.id.startsWith(prefix))) throw bad('has an invalid id');
    if (!ev || typeof ev !== 'object' || typeof ev.file !== 'string' || !ev.file || typeof ev.span !== 'string' || !ev.span || typeof ev.reason !== 'string' || !ev.reason.trim()) throw bad(`("${entry.id}") needs evidence {file, span, reason}: the file, an exact quote of code at this head, and why that code answers the finding`);
    if (ev.reason.trim().length > 500) throw bad(`("${entry.id}") has a reason over 500 characters`);
    return { id: entry.id, evidence: { file: ev.file, span: ev.span, reason: ev.reason.trim() } };
  });
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
      throw new ArtifactError('fatal', `${name} reviewer could not run: ${parsed.blocked.map((b) => String(b)).join('; ')} -- it was blocked from the method it was assigned, so this round has no usable verdict. If a sandbox, permission, or tool failure blocked it, fix the environment and run the round again. Do not accept the artifact.`);
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
        // verify and gate-verify list kept candidates in a verdict shape (no file), so a missing field is a representation slip; the primary reviewers' prompts spell the fields out and keep it fatal.
        if (typeof finding[required] !== 'string' || !finding[required]) throw new ArtifactError(shape.arrays.includes('rejected') ? 'retry' : 'fatal', `${name} finding[${index}] is missing "${required}"`);
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
  // A verifier whose probe ran but whose result is decided by the reviewer's
  // own environment (the Codex sandbox's user namespace shows unmapped host
  // owners as uid 65534) lists the candidate here instead of declaring
  // `blocked`. The candidate is not rejected, so it survives like any
  // unrefuted finding: this field can only keep a finding alive, never kill
  // one, and cannot manufacture a clean verdict. `blocked` stays fatal for a
  // tool that was missing, denied, crashed, or timed out.
  if (name === 'verify' || name === 'gate-verify') {
    if (parsed.unverifiable !== undefined) {
      if (!Array.isArray(parsed.unverifiable)) throw new ArtifactError('fatal', `${name} artifact field "unverifiable" must be an array`);
      canonical.unverifiable = parsed.unverifiable.map((entry, index) => {
        const id = entry && typeof entry === 'object' ? entry.id : undefined;
        if (typeof id !== 'string' || !isValidFindingId(id) || !shape.prefixes.some((prefix) => id.startsWith(prefix))) throw new ArtifactError('retry', `${name} unverifiable[${index}] has invalid id "${typeof entry === 'string' ? entry : id}"`);
        const reason = entry.reason;
        if (typeof reason !== 'string' || !reason.trim()) throw new ArtifactError('retry', `${name} unverifiable[${index}] ("${id}") has no "reason" -- name the probe you ran and the environment property that decided its result`);
        return { id, reason: reason.trim() };
      });
      const rejectedIds = new Set(canonical.rejected.map((entry) => entry.id));
      for (const entry of canonical.unverifiable) {
        if (rejectedIds.has(entry.id)) throw new ArtifactError('retry', `${name} lists "${entry.id}" as both rejected and unverifiable; a candidate is either rejected on evidence or unverifiable in this environment`);
      }
    }
  }
  if (name === 'verify' && parsed.addressed !== undefined) canonical.addressed = normalizeAddressed(name, parsed.addressed);
  if (name === 'gate-verify' && parsed.blocking !== undefined) {
    if (!Array.isArray(parsed.blocking)) throw new ArtifactError('fatal', 'gate-verify artifact field "blocking" must be an array');
    canonical.blocking = parsed.blocking.map((entry, index) => {
      const id = entry && typeof entry === 'object' ? entry.id : undefined;
      if (typeof id !== 'string' || !isValidFindingId(id) || !id.startsWith('gate:')) throw new ArtifactError('retry', `gate-verify blocking[${index}] has invalid id "${id}"`);
      const reason = entry.reason;
      if (typeof reason !== 'string' || !reason.trim()) throw new ArtifactError('retry', `gate-verify blocking[${index}] ("${id}") has no "reason"`);
      return { id, reason: reason.trim() };
    });
    const rejectedIds = new Set((canonical.rejected || []).map((entry) => entry.id));
    for (const entry of canonical.blocking) {
      if (rejectedIds.has(entry.id)) throw new ArtifactError('retry', `gate-verify lists "${entry.id}" as both rejected and blocking; a candidate is either a false positive or release-blocking`);
    }
    // review.js's fold additionally requires each id to be a gate candidate
  }
  // A gate candidate that restates a correctness candidate is recorded as a
  // duplicate, not rejected: the two verifiers run concurrently, so whether it
  // is dropped depends on the correctness verdict, which review.js folds in.
  if (name === 'gate-verify' && parsed.duplicates !== undefined) {
    if (!Array.isArray(parsed.duplicates)) throw new ArtifactError('fatal', 'gate-verify artifact field "duplicates" must be an array');
    const correctnessPrefixes = allowedFindingPrefixes('verify');
    canonical.duplicates = parsed.duplicates.map((entry, index) => {
      const id = entry && typeof entry === 'object' ? entry.id : undefined;
      const of = entry && typeof entry === 'object' ? entry.of : undefined;
      if (typeof id !== 'string' || !isValidFindingId(id) || !id.startsWith('gate:')) throw new ArtifactError('retry', `gate-verify duplicates[${index}] has invalid id "${id}"`);
      if (typeof of !== 'string' || !isValidFindingId(of) || !correctnessPrefixes.some((prefix) => of.startsWith(prefix))) throw new ArtifactError('retry', `gate-verify duplicates[${index}] ("${id}") must name the ${correctnessPrefixes.join(' or ')} candidate it restates in "of"`);
      return { id, of };
    });
    const rejectedIds = new Set((canonical.rejected || []).map((entry) => entry.id));
    for (const entry of canonical.duplicates) {
      if (rejectedIds.has(entry.id)) throw new ArtifactError('retry', `gate-verify lists "${entry.id}" as both rejected and a duplicate; a duplicate is not a false positive`);
    }
  }
  return canonical;
}

module.exports = { ArtifactError, repairsSlugs, dropsInvalidFindings, normalizeArtifact, repairCandidate, preservesArtifact, allowedFindingPrefixes, ADDRESSABLE_PREFIXES };
