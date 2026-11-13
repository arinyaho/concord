'use strict';
// One review round of a pull request checkout: the reviewer roles in order, each artifact validated and sealed,
// the surviving findings folded into one list. Nothing is fixed and no state outlives the call.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const artifactContract = require('./artifact-contract');
const gateContract = require('./gate-contract');
const { writeFileAtomic } = require('./atomic-write');
const { captureArtifactRoot, hashArtifact, readArtifactBytes } = require('./bounded-artifact');
const { artifactDestinationFromPrompt } = require('./review-artifact');
const { readCommittedSource, prepareAnchors, applyAnchors } = require('./review-anchors');
const { reviewerPrompt } = require('./round-plan');
const { gitReviewSnapshot, gitHeadSha, gitDirty, trackedCheckoutInventory, changedTrackedPath } = require('./target');
const { canonicalPath, providerExec, invoke, reviewCodexConfig } = require('./launch');
const { providerFailure } = require('./provider-failure');
const { readReviewSource, unexaminedPaths, roundCandidates, foldGateFindings, gateFollowUpEligible, targetSlug, readIntentFile } = require('./fold');

const ROUND = 1;
const harness = (message) => new Error(/^harness-failure:/.test(message) ? message : `harness-failure: ${message}`);

// The findings of the round and the earlier findings the verify pass found answered, from the sealed artifacts.
// `artifacts` holds the normalized artifact of every role that ran; `verify` is absent when no finder raised anything.
function foldRound({ repoRoot, artifacts, changed, intentApplied, gateApplied }) {
  const cJson = artifacts.correctness;
  const vJson = artifacts.verify || { status: 'ok', rejected: [], findings: [] };
  const candidates = roundCandidates(gateContract, cJson, vJson);
  for (const c of candidates) {
    if (c.id.startsWith('intent:')) throw harness(`intent-prefixed id "${c.id}" in the correctness or verify artifact -- intent findings must come from the intent detector`);
    if (c.id.startsWith('gate:')) throw harness(`gate-prefixed id "${c.id}" in the correctness or verify artifact -- gate findings must come from the gate reviewer`);
  }
  const killed = new Set(gateContract.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates).rejectedIds);
  const confirmed = candidates.filter((f) => !killed.has(f.id));
  const fixes = confirmed.map((f) => ({ id: f.id, file: f.file, span: f.span, summary: f.summary }));
  const classified = new Map(confirmed.map((f) => [f.id, f]));

  let intentParked = [];
  if (intentApplied) {
    const intentFindings = gateContract.parseGateFindings(JSON.stringify(artifacts.intent.findings || []));
    for (const f of intentFindings) if (!f.id.startsWith('intent:')) throw harness(`non-intent id "${f.id}" in the intent artifact`);
    const changedSet = new Set(changed);
    intentParked = intentFindings.filter((f) => changedSet.has(f.file))
      .map((f) => ({ id: f.id, file: f.file, span: f.span, requirement: f.requirement || '', summary: f.summary }));
  }

  let gateOpen = [];
  if (gateApplied) {
    let gFindings;
    try { gFindings = gateContract.parseGateFindings(JSON.stringify(artifacts.gate.findings || [])); }
    catch (e) { throw harness(`gate artifact invalid: ${e.message}`); }
    for (const f of gFindings) if (!f.id.startsWith('gate:')) throw harness(`non-gate id "${f.id}" in the gate artifact`);
    const gvRaw = artifacts['gate-verify'];
    const verifyFindings = gateContract.parseGateFindings(JSON.stringify(gvRaw.findings));
    for (const f of verifyFindings) if (!f.id.startsWith('gate:')) throw harness(`non-gate id "${f.id}" in the gate-verify artifact`);
    // A finding gate-verify adds joins the candidates; on an id collision the gate reviewer's entry stands.
    const byId = new Map();
    for (const f of verifyFindings) byId.set(f.id, f);
    for (const f of gFindings) byId.set(f.id, f);
    const merged = Array.from(byId.values());
    // A gate duplicate of a correctness finding drops out only while that correctness finding survives its own verifier.
    const survivingCorrectness = new Set(confirmed.map((f) => f.id));
    const duplicateIds = (gvRaw.duplicates || []).filter((d) => survivingCorrectness.has(d.of)).map((d) => d.id);
    const rejected = gateContract.parseVerifyVerdict(JSON.stringify({ rejected: gvRaw.rejected }), merged).rejectedIds.concat(duplicateIds);
    // gate-verify's `blocking` ids override a finder's claim that nothing blocks.
    const blockingReasons = new Map();
    for (const b of gvRaw.blocking || []) {
      if (!byId.has(b.id)) throw harness(`gate-verify blocking id "${b.id}" is not a gate candidate`);
      blockingReasons.set(b.id, b.reason);
    }
    gateOpen = foldGateFindings({ gateFindings: merged, verifyRejectedIds: rejected })
      .map((f) => (blockingReasons.has(f.id) ? { ...f, blockingReason: blockingReasons.get(f.id) } : f));
  }

  // The file name comes from a reviewer, so it is read only when its real path stays inside the checkout.
  // A span that occurs more than once does not say which occurrence was meant, so it gets no line.
  const lineOf = (file, span) => {
    if (!span) return null;
    try {
      const text = readReviewSource(repoRoot, file);
      if (text === null) return null;
      const at = text.indexOf(span);
      if (at === -1 || text.indexOf(span, at + 1) !== -1) return null;
      return text.slice(0, at).split('\n').length;
    } catch (_) { return null; }
  };
  // Gate findings carry their span as `evidence` and their lens as `class`.
  const findings = [...fixes, ...intentParked, ...gateOpen].map((g) => {
    const classification = classified.get(g.id);
    const f = { ...g, ...(classification && { releaseBlocking: classification.releaseBlocking, rationale: classification.rationale }) };
    const span = f.span ?? f.evidence ?? '';
    return { id: f.id, category: f.class || f.id.split(':', 1)[0], file: f.file, line: lineOf(f.file, span), span, summary: f.summary, requirement: f.requirement || '', class: gateFollowUpEligible(f) ? 'minor' : 'blocker', ...(f.releaseBlocking !== undefined && { releaseBlocking: f.releaseBlocking }), ...(f.rationale !== undefined && { rationale: f.rationale }), ...(f.blockingReason && { blockingReason: f.blockingReason }) };
  });
  return { findings, addressed: vJson.addressed || [] };
}

// What a reviewer wrote, as the contract's canonical artifact, and whether it took the repair. A status spelling, a disposition
// of another role's id, a kept candidate listed without its evidence and a mis-spelled slug are repaired without a model, once
// per role and only while `repair` is allowed; anything else fails.
function normalizeRole(role, raw, { repair = true } = {}) {
  try { return { canonical: artifactContract.normalizeArtifact(role, raw), repaired: false }; } catch (e) {
    if (!repair || !(e instanceof artifactContract.ArtifactError) || e.kind !== 'retry') throw harness(e.message);
    let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const statusSpelling = parsed && typeof parsed.status === 'string' && ['ok', 'findings', 'clean'].includes(parsed.status.toLowerCase()) && parsed.status !== parsed.status.toLowerCase();
    const prefixes = artifactContract.allowedFindingPrefixes(role);
    const items = parsed ? ['rejected', 'findings', 'unverifiable'].flatMap((key) => Array.isArray(parsed[key]) ? parsed[key] : []) : [];
    const idOf = (item) => typeof item === 'string' ? item : item && item.id;
    const mixedNamespaces = /invalid id/.test(e.message)
      && items.map(idOf).some((id) => typeof id === 'string' && prefixes.some((prefix) => id.startsWith(prefix)))
      && items.map(idOf).some((id) => typeof id === 'string' && !prefixes.some((prefix) => id.startsWith(prefix)));
    const invalidFinding = artifactContract.dropsInvalidFindings(role) && /finding\[\d+\] is missing "/.test(e.message);
    const repairableSlug = /invalid id|must name the/.test(e.message) && artifactContract.repairsSlugs(role, raw);
    if (!statusSpelling && !mixedNamespaces && !invalidFinding && !repairableSlug) throw harness(e.message);
    let candidate;
    try {
      candidate = artifactContract.repairCandidate(role, raw);
      if (!artifactContract.preservesArtifact(role, raw, candidate)) throw new Error(`${role} repair candidate does not preserve the original evidence`);
      return { canonical: artifactContract.normalizeArtifact(role, `${JSON.stringify(candidate)}\n`), repaired: true };
    } catch (again) { throw harness(again.message); }
  }
}

async function runRound(options, stateDir, codexHome) {
  const { ref, base } = options;
  if (!ref || !base) throw new Error('review-until-approve: the review needs a ref and a base');
  const reviewer = options.reviewer || 'codex';
  if (!['claude', 'codex'].includes(reviewer)) throw new Error(`review-until-approve: unsupported reviewer "${reviewer}"`);
  const repoRoot = canonicalPath(options.repoRoot || process.cwd());
  const spawn = options.spawn || ((input) => providerExec(input));
  const abortController = options.handleSignals ? new AbortController() : null;
  const signalHandlers = abortController ? Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => abortController.abort(signal)])) : {};
  for (const [signal, handler] of Object.entries(signalHandlers)) process.once(signal, handler);
  const throwIfAborted = () => {
    if (abortController?.signal.aborted) throw harness(`review runner interrupted by ${String(abortController.signal.reason || 'signal')}`);
  };
  try {
    // The review describes one commit: a checkout that is already modified is not that commit.
    if (gitDirty(repoRoot)) throw harness('the review checkout is modified before the review starts');
    const head = gitHeadSha(repoRoot);
    const baseSha = execFileSync('git', ['rev-parse', base], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const snapshot = gitReviewSnapshot(repoRoot, baseSha, head);
    const slug = targetSlug(ref);
    fs.writeFileSync(path.join(stateDir, `round-${ROUND}-diff.txt`), snapshot.reviewText);
    const intentApplied = !!options.intentFile;
    if (intentApplied) writeFileAtomic(path.join(stateDir, `intent-${slug}.md`), readIntentFile(path.resolve(options.intentFile)).text);
    // The broad pair (gate, gate-verify) reads the whole repository; a round that reviews only a delta skips it.
    const gateApplied = !options.noBroad;
    const context = { stateDir, round: ROUND, priorIntentIds: [], slug, gateApplied, priorFindings: options.priorFindings || [], reviewLanguage: options.reviewLanguage || null, addressable: options.addressable || [], description: options.description || '' };
    const roles = [...(intentApplied ? ['intent'] : []), 'correctness', ...(gateApplied ? ['gate'] : []), 'verify', ...(gateApplied ? ['gate-verify'] : [])];
    const roleArtifacts = new Map(roles.map((role) => [role, artifactDestinationFromPrompt(reviewerPrompt(role, context), stateDir)]));
    const anchorArtifact = path.join(stateDir, `round-${ROUND}-anchors.json`);
    roleArtifacts.set('anchors', anchorArtifact);
    if ([...roleArtifacts.values()].some((file) => !file)) throw harness('review artifact destination is missing');

    // The index can hide an edit from git status, so an index-independent inventory of the tracked paths is taken before any reviewer starts.
    const trackedBefore = trackedCheckoutInventory(repoRoot, head);
    const checkReviewCheckout = (compareContent = false) => {
      if (gitDirty(repoRoot)) throw harness('a reviewer left the checkout modified; the review reports only on the commit as it was');
      if (gitHeadSha(repoRoot) !== head) throw harness('a reviewer moved HEAD; the review reports only on the commit it was started on');
      if (compareContent) {
        let changed;
        try { changed = changedTrackedPath(trackedBefore, trackedCheckoutInventory(repoRoot, gitHeadSha(repoRoot))); }
        catch (_) { changed = true; }
        if (changed) throw harness('a reviewer left the checkout modified; the review reports only on the commit as it was');
      }
    };
    // Every input and every accepted artifact is sealed by hash; a reviewer may change only the one file it is asked to write.
    const stateRoot = captureArtifactRoot(path.resolve(stateDir));
    const sealed = new Map();
    const fileHash = (file) => {
      try { return hashArtifact(file, stateRoot, { allowMissing: true }); }
      catch (_) { throw harness(`protected review artifact changed: ${path.basename(file)}`); }
    };
    const protect = (file) => sealed.set(file, fileHash(file));
    const checkProtected = (allowedOutput = null) => {
      for (const [file, expected] of sealed) {
        if (file === allowedOutput) continue;
        if (fileHash(file) !== expected) throw harness(`protected review artifact changed: ${path.basename(file)}`);
      }
    };
    for (const file of [path.join(stateDir, `round-${ROUND}-diff.txt`), path.join(stateDir, `intent-${slug}.md`), ...roleArtifacts.values()]) protect(file);

    const launch = async (input) => {
      const ownOutput = roleArtifacts.get(input.role);
      checkReviewCheckout();
      checkProtected(ownOutput);
      const launched = {
        ...input, repoRoot, stateDir, provider: reviewer,
        ...(options.reviewerModel ? { requestedModel: options.reviewerModel } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.subprocessTimeoutMs ? { timeoutMs: options.subprocessTimeoutMs } : {}),
        ...(abortController ? { abortSignal: abortController.signal } : {}),
        ...(codexHome && reviewer === 'codex' ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}),
      };
      // A launch that could not start is reported by its class, never by the raw error text.
      try { await invoke(spawn, launched); } catch (error) {
        if (error.reviewFailure) throw error;
        throw harness(providerFailure(launched, error).message);
      }
      checkReviewCheckout(true);
      checkProtected(ownOutput);
      fileHash(ownOutput);
    };

    const artifacts = {};
    const accept = (role, allow) => {
      const file = roleArtifacts.get(role);
      let raw;
      try { raw = readArtifactBytes(file, stateRoot).toString('utf8'); } catch (_) { throw harness(`missing or unsafe gate artifact ${role} for round ${ROUND}`); }
      return normalizeRole(role, raw, allow);
    };
    const seal = (role, canonical) => {
      const file = roleArtifacts.get(role);
      writeFileAtomic(file, `${JSON.stringify(canonical)}\n`, { flag: 'wx', mode: 0o600 });
      checkProtected(file);
      protect(file);
      artifacts[role] = canonical;
    };
    const runRole = async (role) => {
      throwIfAborted();
      const prompt = reviewerPrompt(role, role === 'verify' ? { ...context, examined: (artifacts.correctness.examined || []).filter((item) => typeof item === 'string') } : context);
      await launch({ role, prompt });
      let { canonical, repaired } = accept(role);
      if (role === 'correctness') {
        // Every changed path must be listed as examined. Only the reviewer can say it read a file, so one re-run names the paths it left out.
        // A role gets one correction: an artifact that took the repair is not re-run, and the re-run's artifact is not repaired.
        const missingAfter = (artifact) => unexaminedPaths(repoRoot, head, snapshot.paths, artifact.examined, snapshot.leftSha);
        let missing = missingAfter(canonical);
        if (missing.length && repaired) throw harness(`correctness coverage is incomplete; missing changed file(s): ${missing.join(', ')}; the artifact was already repaired once`);
        if (missing.length) {
          await launch({ role, prompt: `${prompt}\nThe previous correctness artifact omitted changed path(s): ${missing.join(', ')}. Examine them and list every changed path in "examined", including the old path of every renamed file and every deleted file.` });
          ({ canonical } = accept(role, { repair: false }));
          missing = missingAfter(canonical);
          if (missing.length) throw harness(`correctness coverage is incomplete; missing changed file(s): ${missing.join(', ')}; correctness coverage retry exhausted for this round`);
        }
      }
      seal(role, canonical);
    };

    for (const role of roles) {
      // With no candidate from any finder there is nothing for the verify pass to rule on, so it does not run.
      if (role === 'verify' && ['correctness', ...(gateApplied ? ['gate'] : [])].every((finder) => !artifacts[finder].findings.length)) continue;
      await runRole(role);
    }
    checkProtected();
    // The reviewers can write to the checkout. Findings describe the commit, so a tree a reviewer modified is not one to report on.
    checkReviewCheckout(true);
    let { findings, addressed } = foldRound({ repoRoot, artifacts, changed: snapshot.paths, intentApplied, gateApplied });

    // One optional extraction call gives a finding whose quote is not in the committed file a verbatim one. It can fail without losing the findings.
    const request = prepareAnchors(findings, (file) => readCommittedSource(repoRoot, head, file));
    if (request.candidates.length) {
      let failed = false;
      try { await launch({ role: 'anchors', prompt: `${request.prompt}\nWrite ONLY JSON to ${anchorArtifact}.` }); } catch (_) { failed = true; }
      checkReviewCheckout(true);
      checkProtected(anchorArtifact);
      fileHash(anchorArtifact);
      throwIfAborted();
      if (!failed) {
        const bytes = readArtifactBytes(anchorArtifact, stateRoot, { allowMissing: true });
        let response = null;
        try { response = bytes === null ? null : JSON.parse(bytes.toString('utf8')); } catch (_) { /* malformed evidence keeps the originals */ }
        findings = applyAnchors(findings, request, response);
      }
      protect(anchorArtifact);
      checkProtected();
    }
    return { decision: 'review-only', round: ROUND, findings, ...(addressed.length && { addressed }) };
  } finally {
    for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
  }
}

// The round runs in a state directory of its own, removed afterwards. A Codex reviewer also gets a CODEX_HOME of its own
// that holds a copy of the login and the configuration that keeps the account's home out of reach.
async function runReview(options) {
  const made = [];
  try {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-review-only-'));
    made.push(stateDir);
    let codexHome = null;
    if ((options.reviewer || 'codex') === 'codex') {
      const accountHome = canonicalPath(options.reviewRealHome || os.homedir());
      codexHome = fs.mkdtempSync(path.join(accountHome, '.concord-review-codex-home-'));
      made.push(codexHome);
      const sourceAuth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
      if (fs.existsSync(sourceAuth)) fs.copyFileSync(sourceAuth, path.join(codexHome, 'auth.json'));
      fs.writeFileSync(path.join(codexHome, 'config.toml'), reviewCodexConfig({ home: codexHome, sourceAuth, checkout: canonicalPath(options.repoRoot || process.cwd()), stateDir, denyRead: options.reviewDenyRead || [], realHome: accountHome }));
    }
    return await runRound(options, stateDir, codexHome);
  } finally {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runReview, foldRound, normalizeRole };
