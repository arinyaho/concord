'use strict';
// Project-local, attributed review knowledge. This is not a review gate or an
// authority to change a contract. The native host supplies the causal judgment.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./atomic-write');
const { repositoryIdentity, canonicalPath, runPath } = require('./initiative-review-run');
const { lockOwner, reclaimStaleLock } = require('./run-lock');
const CATEGORIES = ['requirements', 'design', 'implementation', 'verification', 'review-noise', 'environment'];
const ELIGIBLE = CATEGORIES.slice(0, 4);
const STAGES = ['contract', 'ticket', 'design'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(`feedback: ${message}`); };
const text = (value, label, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(`${label} must be nonempty bounded text (${max})`);
  return value;
};
const member = (value, choices, label) => { if (!choices.includes(value)) fail(`invalid ${label}`); return value; };
function tags(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10 || value.some(tag => typeof tag !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag))) fail('tags must contain 1 to 10 applicability slugs');
  return [...new Set(value)].sort();
}
function readFile(file, max = 2 * 1024 * 1024) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('artifact paths must be absolute');
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size || stat.size > max) fail('artifact must be a nonempty bounded file');
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0) || !bytes.toString('utf8').trim()) fail('artifact must be text');
  return { bytes, reference: { path: canonicalPath(file), sha256: digest(bytes) } };
}
function target(file) {
  const { bytes, reference } = readFile(file);
  const ledger = JSON.parse(bytes);
  if (!ledger || !Array.isArray(ledger.findings) || typeof ledger.attemptId !== 'string' || !ledger.attemptId || !['clean', 'parked', 'abandoned', 'converging', 'intent-review', 'gate-pending'].includes(ledger.status)) fail('expected a native target ledger');
  return { ledger, reference };
}
function assertRepository(ledger, runKey, repository) {
  const binding = ledger.initiative_binding;
  if (!binding || typeof binding.stateDir !== 'string' || !path.isAbsolute(binding.stateDir)) fail('native target has no provable repository binding');
  if (binding.key !== runKey) fail('run key disagrees with target binding');
  const initiative = JSON.parse(readFile(runPath(binding.stateDir, binding.key)).bytes);
  if (initiative?.version !== 5 || initiative.repository !== repository) fail('bound initiative repository disagrees with feedback store');
}
function finding(ledger, id) {
  const matches = [...ledger.findings, ...(ledger.gate_open || []), ...(ledger.intent_parked || [])].filter(f => f?.id === id);
  if (!matches.length) fail('finding is absent from the target ledger');
  return matches[0];
}
const confirmed = f => f.status === 'fixed' && typeof f.fix_commit === 'string' && !!f.fix_commit;
const supported = lesson => {
  const occurrences = lesson.occurrences.filter(o => o.confirmed);
  return new Set(occurrences.map(o => o.runKey)).size >= 2 && new Set(occurrences.map(o => o.attemptId)).size >= 2;
};
function snapshot(directory, bytes, original, extension) {
  const sha256 = digest(bytes);
  const file = path.join(directory, `evidence-${sha256}.${extension}`);
  if (fs.existsSync(file)) {
    if (digest(fs.readFileSync(file)) !== sha256) fail('immutable evidence snapshot was modified');
  } else writeFileAtomic(file, bytes, { mode: 0o600 });
  if (digest(fs.readFileSync(file)) !== sha256) fail('evidence snapshot read-back failed');
  return { path: file, sha256, originalPath: original.path, originalSha256: original.sha256 };
}
function proofSnapshot(directory, file) {
  const proof = readFile(file, 16384);
  return snapshot(directory, proof.bytes, proof.reference, 'md');
}
function findingReceipt(f) {
  return { id: text(f.id, 'finding id', 200), status: f.status || 'open',
    fix_commit: typeof f.fix_commit === 'string' ? text(f.fix_commit, 'fix commit', 200) : null,
    ...(typeof f.file === 'string' ? { file: text(f.file, 'finding file', 4096) } : {}),
    ...(typeof f.summary === 'string' ? { summary: f.summary.slice(0, 500) } : {}) };
}
function ledgerSnapshot(directory, ledger, original, findings, repository) {
  const receipt = { repository, attemptId: ledger.attemptId, status: ledger.status, originLedger: original,
    ...(ledger.initiative_binding ? { initiative_binding: { key: ledger.initiative_binding.key, stateDir: ledger.initiative_binding.stateDir } } : {}),
    findings: findings.map(findingReceipt) };
  return snapshot(directory, Buffer.from(`${JSON.stringify(receipt)}\n`), original, 'json');
}
function assertUncontradicted(occurrence, repository) {
  const origin = occurrence.ledger.originalPath;
  if (!origin || !fs.existsSync(origin)) return;
  const { ledger } = target(origin);
  if (ledger.attemptId !== occurrence.attemptId) return; // a normal rerun keeps its old receipt valid
  assertRepository(ledger, occurrence.runKey, repository);
  const current = [...ledger.findings, ...(ledger.gate_open || []), ...(ledger.intent_parked || [])].find(f => f?.id === occurrence.findingId);
  if (current && (current.status === 'killed' || (occurrence.confirmed && !confirmed(current)))) fail('support is contradicted by the live review evidence');
}

function readOccurrence(occurrence, repository) {
  const { ledger, reference } = target(occurrence.ledger.path);
  if (reference.sha256 !== occurrence.ledger.sha256 || readFile(occurrence.evidence.path, 16384).reference.sha256 !== occurrence.evidence.sha256) fail('support evidence changed; reconcile the candidate');
  if (ledger.attemptId !== occurrence.attemptId || ledger.initiative_binding?.key !== occurrence.runKey
    || ledger.repository !== repository || ledger.originLedger?.path !== occurrence.ledger.originalPath
    || ledger.originLedger?.sha256 !== occurrence.ledger.originalSha256) fail('support receipt provenance disagrees');
  const f = finding(ledger, occurrence.findingId);
  if (confirmed(f) !== occurrence.confirmed || f.status !== occurrence.findingStatus) fail('support is contradicted by the saved review evidence');
  return { ledger, finding: f };
}
function validateSupport(lesson, repository) {
  for (const occurrence of lesson.occurrences) {
    const saved = readOccurrence(occurrence, repository);
    if (saved.finding.status === 'killed') fail('support is contradicted by the saved review evidence');
    assertUncontradicted(occurrence, repository);
  }
  if (!supported(lesson)) fail('acceptance needs confirmed support from two different runs and review attempts');
}
function validateAccepted(lesson, repository) {
  validateSupport(lesson, repository);
  const evidence = lesson.decisions.at(-1).evidence;
  if (readFile(evidence.path, 16384).reference.sha256 !== evidence.sha256) fail('accepted decision evidence changed; reconcile the lesson');
}

function load(file, repository, validateProofs = true) {
  if (!fs.existsSync(file)) return { schema: 1, repository, lessons: [], observations: [] };
  const bytes = fs.readFileSync(file);
  if (bytes.length > 8 * 1024 * 1024) fail('store exceeds 8MB; archive explicitly before collecting more');
  const store = JSON.parse(bytes);
  if (store?.schema !== 1 || store.repository !== repository || !Array.isArray(store.lessons) || !Array.isArray(store.observations)) fail('store schema or repository disagrees');
  for (const lesson of store.lessons) {
    if (!lesson || !/^[a-f0-9]{64}$/.test(lesson.id) || !CATEGORIES.includes(lesson.category) || !STAGES.includes(lesson.stage)
      || !['candidate', 'accepted', 'rejected', 'retired'].includes(lesson.status) || !Array.isArray(lesson.occurrences) || !Array.isArray(lesson.decisions)) fail('malformed lesson');
    text(lesson.rule, 'rule'); text(lesson.rationale, 'rationale'); tags(lesson.tags);
    text(lesson.pattern, 'pattern', 64);
    if (typeof lesson.earlierAvailable !== 'boolean' || typeof lesson.preventable !== 'boolean' || lesson.occurrences.length > 100 || lesson.decisions.length > 100) fail('malformed prevention judgments or history');
    const ref = value => { if (!value || typeof value.path !== 'string' || !path.isAbsolute(value.path) || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('malformed evidence reference'); };
    for (const o of lesson.occurrences) {
      if (!o || typeof o.confirmed !== 'boolean') fail('malformed occurrence');
      text(o.runKey, 'runKey', 200); text(o.attemptId, 'attemptId', 200); text(o.findingId, 'findingId', 200); ref(o.ledger); ref(o.evidence);
    }
    for (const d of lesson.decisions) {
      member(d?.decision, ['accept', 'reject', 'retire'], 'decision'); text(d.reviewedBy, 'reviewedBy', 200); text(d.reason, 'reason'); ref(d.evidence);
    }
    if (lesson.status === 'accepted') {
      if (lesson.decisions.at(-1)?.decision !== 'accept' || !ELIGIBLE.includes(lesson.category) || !lesson.earlierAvailable || !lesson.preventable || !supported(lesson)) fail('malformed accepted lesson');
      if (validateProofs) validateAccepted(lesson, repository);
    }
  }
  if (store.lessons.length > 1000 || store.observations.length > 10000 || new Set(store.lessons.map(l => l.id)).size !== store.lessons.length) fail('store limits or lesson identity are invalid');
  for (const entry of store.observations) {
    if (!entry || !Array.isArray(entry.outcomes) || !entry.outcomes.length || entry.outcomes.length > 3) fail('malformed outcome');
    text(entry.runKey, 'runKey', 200); text(entry.unit, 'unit', 200);
    for (const o of entry.outcomes) {
      if (!store.lessons.some(l => l.id === o?.id)) fail('unknown outcome lesson');
      member(o.outcome, ['recurred', 'not-observed', 'unmeasured'], 'outcome');
    }
  }
  return store;
}
function locked(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!reclaimStaleLock(lock)) fail('store lock is held; retry after the existing writer finishes');
    fs.mkdirSync(lock);
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);
    return fn();
  } finally { if (lockOwner(lock) === process.pid) fs.rmSync(lock, { recursive: true, force: true }); }
}
function record(store, packet, directory) {
  const proposal = { pattern: text(packet.pattern, 'pattern', 64), category: member(packet.category, CATEGORIES, 'category'),
    stage: member(packet.stage, STAGES, 'stage'), tags: tags(packet.tags), rule: text(packet.rule, 'rule'), rationale: text(packet.rationale, 'rationale'),
    earlierAvailable: packet.earlierAvailable, preventable: packet.preventable };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(proposal.pattern) || typeof proposal.earlierAvailable !== 'boolean' || typeof proposal.preventable !== 'boolean') fail('pattern or prevention judgments are invalid');
  const runKey = text(packet.runKey, 'runKey', 200);
  const findingId = text(packet.findingId, 'findingId', 200);
  const { ledger, reference } = target(packet.ledgerPath);
  assertRepository(ledger, runKey, store.repository);
  const f = finding(ledger, findingId);
  const attemptId = text(ledger.attemptId, 'attemptId', 200);
  const id = digest(JSON.stringify([proposal.pattern, proposal.category, proposal.stage, proposal.tags]));
  let lesson = store.lessons.find(l => l.id === id);
  if (lesson && Object.entries(proposal).some(([key, value]) => JSON.stringify(lesson[key]) !== JSON.stringify(value))) fail('existing proposal differs; use a new pattern for a revised rule');
  const proof = readFile(packet.evidencePath, 16384);
  const existing = lesson?.occurrences.find(o => o.runKey === runKey && o.attemptId === attemptId && o.findingId === findingId);
  if (existing) {
    const saved = readOccurrence(existing, store.repository);
    if (reference.path !== existing.ledger.originalPath || proof.reference.sha256 !== existing.evidence.sha256
      || canonicalPath(saved.ledger.initiative_binding.stateDir) !== canonicalPath(ledger.initiative_binding.stateDir)
      || JSON.stringify(saved.finding) !== JSON.stringify(findingReceipt(f))) fail('occurrence evidence changed; reconcile and record under a revised pattern');
    // The full ledger hash may change with telemetry; keep the original receipt.
  } else {
    if (!lesson) {
      if (store.lessons.length >= 1000) fail('lesson limit reached; archive explicitly');
      lesson = { id, ...proposal, status: 'candidate', judgmentSource: 'caller-reported', occurrences: [], decisions: [] };
      store.lessons.push(lesson);
    }
    if (lesson.occurrences.length >= 100) fail('occurrence limit reached');
    lesson.occurrences.push({ runKey, attemptId, findingId,
      ledger: ledgerSnapshot(directory, ledger, reference, [f], store.repository),
      evidence: snapshot(directory, proof.bytes, proof.reference, 'md'), findingStatus: f.status || 'open', confirmed: confirmed(f) });
  }
  return { id, status: lesson.status, supportRuns: new Set(lesson.occurrences.filter(o => o.confirmed).map(o => o.runKey)).size };
}
function decide(store, packet, directory) {
  const lesson = store.lessons.find(l => l.id === packet.id);
  if (!lesson) fail('unknown lesson');
  const decision = member(packet.decision, ['accept', 'reject', 'retire'], 'decision');
  const attribution = { decision, reviewedBy: text(packet.reviewedBy, 'reviewedBy', 200), reason: text(packet.reason, 'reason'), evidence: proofSnapshot(directory, packet.evidencePath) };
  if (decision === 'accept') {
    if (!ELIGIBLE.includes(lesson.category) || !lesson.earlierAvailable || !lesson.preventable) fail('lesson is ineligible for preventive reuse');
    if (!supported(lesson)) fail('acceptance needs confirmed support from two different runs and review attempts');
    validateSupport(lesson, store.repository);
  }
  const status = { accept: 'accepted', reject: 'rejected', retire: 'retired' }[decision];
  if (lesson.status !== status || JSON.stringify(lesson.decisions.at(-1)) !== JSON.stringify(attribution)) {
    if (lesson.decisions.length >= 100) fail('decision history limit reached');
    lesson.decisions.push(attribution); lesson.status = status;
  }
  return { id: lesson.id, status };
}
function select(store, packet) {
  const stage = member(packet.stage, STAGES, 'stage');
  const applicable = tags(packet.tags);
  const score = lesson => lesson.tags.filter(tag => applicable.includes(tag)).length;
  const lessons = store.lessons.filter(l => l.status === 'accepted' && ELIGIBLE.includes(l.category) && l.preventable && l.earlierAvailable && l.stage === stage && score(l))
    .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, 3)
    .map(l => ({ id: l.id, category: l.category, rule: l.rule, tags: l.tags,
      evidence: l.decisions.at(-1).evidence }));
  return { lessons, authority: 'advisory; verify applicability against current approved sources' };
}
function observe(store, packet, directory) {
  const runKey = text(packet.runKey, 'runKey', 200); const unit = text(packet.unit, 'unit', 200);
  const { ledger, reference } = target(packet.ledgerPath);
  assertRepository(ledger, runKey, store.repository);
  const evidence = proofSnapshot(directory, packet.evidencePath);
  if (!Array.isArray(packet.outcomes) || !packet.outcomes.length || packet.outcomes.length > 3) fail('record 1 to 3 applied lesson outcomes');
  const outcomes = packet.outcomes.map(o => {
    const lesson = store.lessons.find(l => l.id === o.id);
    if (!lesson || !lesson.decisions.some(d => d.decision === 'accept')) fail('outcome must refer to a previously accepted lesson');
    const outcome = member(o.outcome, ['recurred', 'not-observed', 'unmeasured'], 'outcome');
    if (outcome === 'not-observed' && ledger.status !== 'clean') fail('not-observed needs a completed clean review');
    if (outcome === 'recurred') {
      const f = finding(ledger, text(o.findingId, 'findingId', 200));
      if (f.status === 'killed') fail('killed findings do not establish recurrence');
    }
    return { id: o.id, outcome, ...(outcome === 'recurred' ? { findingId: o.findingId } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(outcomes.map(o => o.id)).size !== outcomes.length) fail('duplicate lesson outcome');
  const receipt = ledgerSnapshot(directory, ledger, reference, outcomes.filter(o => o.outcome === 'recurred').map(o => finding(ledger, o.findingId)), store.repository);
  const entry = { runKey, unit, outcomes, ledger: receipt, evidence, observationSource: 'caller-reported' };
  const prior = store.observations.find(o => o.runKey === runKey && o.unit === unit);
  if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) fail('existing outcome differs; reconcile instead of silently replacing it');
  if (!prior) { if (store.observations.length >= 10000) fail('observation limit reached'); store.observations.push(entry); }
  return { recorded: outcomes.length, duplicate: !!prior };
}
function report(store) {
  const categories = {}; const statuses = {};
  for (const l of store.lessons) { categories[l.category] = (categories[l.category] || 0) + 1; statuses[l.status] = (statuses[l.status] || 0) + 1; }
  const outcomes = { applied: 0, recurred: 0, notObserved: 0, unmeasured: 0 };
  for (const entry of store.observations) for (const o of entry.outcomes) { outcomes.applied++; outcomes[{ recurred: 'recurred', 'not-observed': 'notObserved', unmeasured: 'unmeasured' }[o.outcome]]++; }
  return { categories, statuses, outcomes, observationSource: 'caller-reported', limitation: 'Reported review outcomes do not prove absence, causal improvement or token savings. Round count alone is not a design-quality measure.' };
}
function runFeedback(args, repository) {
  try {
    const [verb, directory, packetPath, ...extra] = args;
    if (!['record', 'decide', 'select', 'observe', 'report'].includes(verb) || !directory || !path.isAbsolute(directory) || extra.length || (verb === 'report' ? packetPath !== undefined : !packetPath)) fail('use feedback <record|decide|select|observe|report> <absolute-store-dir> [absolute-packet.json]');
    const identity = repositoryIdentity(repository); const file = path.join(canonicalPath(directory), 'review-feedback.json');
    const packet = verb === 'report' ? null : JSON.parse(readFile(packetPath, 65536).bytes);
    if (verb !== 'report' && (!packet || typeof packet !== 'object' || Array.isArray(packet))) fail('packet must be an object');
    const dispatch = store => ({ record, decide, select, observe, report })[verb](store, packet, path.dirname(file));
    if (['select', 'report'].includes(verb)) return dispatch(load(file, identity));
    return locked(file, () => {
      // Explicit disabling permits sequential cleanup of shared invalid proof.
      // Every store shape and repository check still applies; reuse validates proof.
      const disabling = verb === 'decide' && ['reject', 'retire'].includes(packet.decision);
      const store = load(file, identity, !disabling); const result = dispatch(store);
      const json = `${JSON.stringify(store, null, 2)}\n`;
      if (Buffer.byteLength(json) > 8 * 1024 * 1024) fail('store limit reached; archive explicitly');
      writeFileAtomic(file, json, { mode: 0o600 });
      if (fs.readFileSync(file, 'utf8') !== json) fail('store read-back failed');
      return result;
    });
  } catch (error) { if (error.message.startsWith('feedback:')) throw error; fail(error.message); }
}
module.exports = { runFeedback };
