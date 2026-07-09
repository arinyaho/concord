'use strict';
// Pure gate output-contract parsing/validation. No git, no process, no fs.
// Moved out of engine.js so review-cli.js's `record`/`plan-fixes` can validate
// subagent-written artifacts against the same contract the engine used to enforce.

const FINDING_ID_RE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]{0,79}$/;

function isValidFindingId(id) {
  return typeof id === 'string' && FINDING_ID_RE.test(id);
}

function stripFences(text) {
  const s = String(text == null ? '' : text).trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  return m ? m[1].trim() : s;
}

function parseGateFindings(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch (e) {
    throw new Error(`correctness gate did not return valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('correctness gate output must be a JSON array of findings');
  return parsed.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`finding[${i}] is not an object`);
    if (!isValidFindingId(f.id)) throw new Error(`finding[${i}].id "${f.id}" is not a stable "gate:slug" id (contract violation)`);
    if (typeof f.file !== 'string' || !f.file) throw new Error(`finding[${i}] (${f.id}) is missing "file"`);
    if (typeof f.summary !== 'string' || !f.summary) throw new Error(`finding[${i}] (${f.id}) is missing "summary"`);
    return {
      id: f.id,
      gate: typeof f.gate === 'string' && f.gate ? f.gate : f.id.split(':')[0],
      file: f.file,
      span: typeof f.span === 'string' ? f.span : '',
      summary: f.summary,
      status: 'confirmed',
    };
  });
}

function parseVerifyVerdict(rawText, candidateFindings) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch (e) {
    throw new Error(`verify gate did not return valid JSON: ${e.message}`);
  }
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected.filter((id) => typeof id === 'string') : [];
  const validIds = new Set((candidateFindings || []).map((f) => f.id));
  return { rejectedIds: rejected.filter((id) => validIds.has(id)) };
}

const PARK_KINDS = new Set(['needs-decision', 'harness-failure']);

function validateParkReason(reason) {
  if (!reason || typeof reason !== 'object') throw new Error('park reason must be an object with { kind, text }');
  if (!PARK_KINDS.has(reason.kind)) throw new Error(`park reason kind must be one of ${Array.from(PARK_KINDS).join('|')}, got "${reason.kind}"`);
  if (typeof reason.text !== 'string' || !reason.text.trim()) throw new Error('park reason text must be a non-empty string');
  return { kind: reason.kind, text: reason.text };
}

module.exports = { FINDING_ID_RE, isValidFindingId, stripFences, parseGateFindings, parseVerifyVerdict, PARK_KINDS, validateParkReason };
