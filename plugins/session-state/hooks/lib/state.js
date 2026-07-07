'use strict';
const { FACTS_CAP, OPEN_LOOPS_CAP, DECISIONS_CAP, NEXTS_CAP } = require('./config');

function emptyModel() {
  return { offset: 0, openLoops: [], decisions: [], nexts: [], facts: [] };
}

function topicKey(decision) {
  const bracket = decision.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1].trim().toLowerCase();
  return decision.split(/\s+/).slice(0, 4).join(' ').toLowerCase();
}

// Normalize for exact open-loop/resolved matching (whitespace + case).
function normalizeText(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Keep the most-recent occurrence of each distinct item (by key), order preserved.
function dedupeLatest(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const k = keyFn(items[i]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.unshift(items[i]);
  }
  return out;
}

// Merge a delta into the model, applying compaction so the file stays bounded.
function mergeModel(prev, d) {
  const m = {
    offset: prev.offset,
    openLoops: prev.openLoops.slice(),
    decisions: prev.decisions.slice(),
    nexts: prev.nexts.slice(),
    facts: prev.facts.slice(),
  };

  // Keep the most-recent occurrence of each distinct item, then cap, so churn
  // (repeated edits, or a tag harvested from both the transcript and the Stop
  // hook's last_assistant_message) cannot evict higher-signal entries.
  m.facts = dedupeLatest(m.facts.concat(d.facts), (f) => f).slice(-FACTS_CAP);

  m.openLoops = m.openLoops.concat(d.openLoops);
  for (const r of d.resolved) {
    const rn = normalizeText(r);
    m.openLoops = m.openLoops.filter((o) => normalizeText(o) !== rn);
  }
  m.openLoops = dedupeLatest(m.openLoops, normalizeText).slice(-OPEN_LOOPS_CAP);

  for (const dec of d.decisions) {
    const k = topicKey(dec);
    m.decisions = m.decisions.filter((x) => topicKey(x) !== k);
    m.decisions.push(dec);
  }
  m.decisions = m.decisions.slice(-DECISIONS_CAP);

  m.nexts = dedupeLatest(m.nexts.concat(d.nexts), normalizeText).slice(-NEXTS_CAP);
  return m;
}

module.exports = { emptyModel, topicKey, mergeModel };
