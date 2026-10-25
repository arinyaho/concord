'use strict';

function nonempty(value) { return typeof value === 'string' && !!value.trim(); }

function isDocumentFollowUp(finding) {
  return !!finding && typeof finding === 'object'
    && typeof finding.id === 'string' && finding.id.startsWith('docreview:')
    && Array.isArray(finding.releaseBlocking) && finding.releaseBlocking.length === 0
    && nonempty(finding.rationale)
    && finding.minorVerified === true && nonempty(finding.minorReason)
    && !finding.blockingReason;
}

function validMinor(finding) {
  return finding && typeof finding === 'object' && !Array.isArray(finding)
    && Array.isArray(finding.releaseBlocking) && finding.releaseBlocking.length === 0
    && nonempty(finding.rationale)
    && !finding.unverifiable && !finding.rejected && !finding.blockingReason;
}

function sameIdentity(a, b) {
  return ['id', 'file', 'span', 'summary'].every((key) => typeof a[key] === 'string' && a[key] === b[key]);
}

function classifyDocumentFindings(findings, finderFindings, verifier = {}) {
  const originals = new Map((Array.isArray(finderFindings) ? finderFindings : [])
    .filter((finding) => finding && typeof finding.id === 'string' && finding.id.startsWith('docreview:'))
    .map((finding) => [finding.id, finding]));
  const confirmations = new Map();
  const conflicting = new Set();
  const blockingReasons = new Map();
  for (const list of [verifier && verifier.rejected, verifier && verifier.unverifiable, verifier && verifier.blocking]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : entry && entry.id;
      if (typeof id === 'string' && id.startsWith('docreview:')) {
        conflicting.add(id);
        if (list === verifier.blocking && nonempty(entry && entry.reason)) blockingReasons.set(id, entry.reason.trim());
      }
    }
  }
  const counts = new Map();
  if (verifier && Array.isArray(verifier.minor)) for (const entry of verifier.minor) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.startsWith('docreview:') || !nonempty(entry.reason)) continue;
    counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
    confirmations.set(entry.id, entry.reason.trim());
  }
  return (Array.isArray(findings) ? findings : []).map((finding) => {
    const original = finding && originals.get(finding.id);
    const reason = finding && confirmations.get(finding.id);
    const blockingReason = finding && blockingReasons.get(finding.id);
    const eligible = !!original && !!reason && counts.get(finding.id) === 1 && !conflicting.has(finding.id)
      && sameIdentity(original, finding) && validMinor(original) && validMinor(finding);
    const { minorVerified: _minorVerified, minorReason: _minorReason, ...clean } = finding || {};
    return { ...clean, minorVerified: eligible, ...(eligible ? { minorReason: reason } : {}), ...(blockingReason ? { blockingReason } : {}) };
  });
}

module.exports = { isDocumentFollowUp, classifyDocumentFindings };
