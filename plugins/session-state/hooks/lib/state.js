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

// Merge a delta into the model, applying compaction so the file stays bounded.
function mergeModel(prev, d) {
  const m = {
    offset: prev.offset,
    openLoops: prev.openLoops.slice(),
    decisions: prev.decisions.slice(),
    nexts: prev.nexts.slice(),
    facts: prev.facts.slice(),
  };

  // Keep the most-recent occurrence of each distinct fact, then cap, so edit
  // churn on one file cannot evict higher-signal facts (commits, PRs).
  const combined = m.facts.concat(d.facts);
  const seen = new Set();
  const distinct = [];
  for (let i = combined.length - 1; i >= 0; i--) {
    if (seen.has(combined[i])) continue;
    seen.add(combined[i]);
    distinct.unshift(combined[i]);
  }
  m.facts = distinct.slice(-FACTS_CAP);

  m.openLoops = m.openLoops.concat(d.openLoops);
  for (const r of d.resolved) {
    m.openLoops = m.openLoops.filter(
      (o) => !(o === r || o.includes(r) || r.includes(o))
    );
  }
  m.openLoops = m.openLoops.slice(-OPEN_LOOPS_CAP);

  for (const dec of d.decisions) {
    const k = topicKey(dec);
    m.decisions = m.decisions.filter((x) => topicKey(x) !== k);
    m.decisions.push(dec);
  }
  m.decisions = m.decisions.slice(-DECISIONS_CAP);

  m.nexts = m.nexts.concat(d.nexts).slice(-NEXTS_CAP);
  return m;
}

function section(title, items) {
  return [`## ${title}`, ...items.map((x) => `- ${x}`), ''].join('\n');
}

function renderMarkdown(sessionId, m) {
  return [
    `# Session state — ${sessionId}`,
    '# machine-owned - do not hand-edit',
    '',
    section('Open loops', m.openLoops),
    section('Decisions', m.decisions),
    section('Next', m.nexts),
    section('Recent activity', m.facts),
  ].join('\n');
}

module.exports = { emptyModel, topicKey, mergeModel, renderMarkdown };
