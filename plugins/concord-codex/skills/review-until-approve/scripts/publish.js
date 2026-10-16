'use strict';
// Rendering of one review. Pure, so an unattended variant can reuse it.
// The contract is that of services/pr-review/review-one.sh: a finding is posted
// inline only where its line is inside a diff hunk (GitHub rejects the whole
// review otherwise), the rest go in the body, and `body` mode puts them all there.

// The path of a `+++ ` header: git quotes one with special characters as "b/..." with C escapes.
function headerPath(raw) {
  const m = /^"b\/((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (!m) return raw.startsWith('b/') ? raw.slice(2) : '';
  const bytes = [];
  const esc = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c !== '\\') bytes.push(...Buffer.from(c));
    else if (/[0-7]/.test(m[1][i + 1])) { bytes.push(parseInt(m[1].slice(i + 1, i + 4), 8)); i += 3; }
    else { i++; bytes.push(m[1][i] in esc ? esc[m[1][i]] : m[1].charCodeAt(i)); }
  }
  return Buffer.from(bytes).toString('utf8');
}

function hunksOf(diff) {
  const hunks = [];
  let file = '';
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = ''; }
    else if (line.startsWith('@@')) header = false;
    if (header && line.startsWith('+++ ')) file = headerPath(line.slice(4).replace(/\t$/, ''));
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file && (m[2] === undefined || Number(m[2]) > 0)) hunks.push({ file, from: Number(m[1]), to: Number(m[1]) + (m[2] === undefined ? 1 : Number(m[2])) - 1 });
  }
  return hunks;
}

const text = (f) => `**${f.category}** ${f.summary}${f.requirement ? `\n\n> ${f.requirement}` : ''}\n\n\`${f.id}\``;
const ids = (list) => list.map((id) => `\`${id}\``).join(', ');

// `how` is "inline" or "body". Event is APPROVE only for a clean round, never REQUEST_CHANGES.
function renderReview({ head, round, rangeBase, reviewer, hunks, findings, fixed, stillOpen, previousHead, approve }, how) {
  const inDiff = (f) => f.line != null && hunks.some((h) => h.file === f.file && f.line >= h.from && f.line <= h.to);
  const inline = how === 'inline' ? findings.filter(inDiff) : [];
  const rest = findings.filter((f) => !inline.includes(f));
  const lines = [
    `<!-- concord-approve: ${head} round:${round} base:${rangeBase} -->`,
    `reviewed by ${reviewer}`,
    findings.length === 0 && stillOpen.length === 0 ? (approve ? 'LGTM — no finding survived verification.' : 'No finding survived verification; this review does not approve.') : `${findings.length} new finding(s), ${stillOpen.length} still open.`,
  ];
  if (fixed.length) lines.push(`Fixed since \`${previousHead.slice(0, 7)}\`: ${ids(fixed)}`);
  if (stillOpen.length) lines.push(`Still open: ${ids(stillOpen)}`);
  for (const f of rest) lines.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` ${text(f)}`);
  return {
    commit_id: head,
    event: approve ? 'APPROVE' : 'COMMENT',
    body: lines.join('\n\n'),
    comments: inline.map((f) => ({ path: f.file, line: f.line, side: 'RIGHT', body: text(f) })),
  };
}

const containsSecret = (payload, secrets) => secrets.some((s) => s && payload.includes(s));

module.exports = { hunksOf, renderReview, containsSecret };
