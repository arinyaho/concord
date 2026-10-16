'use strict';
// Rendering of one review. Pure, so an unattended variant can reuse it.
// The contract is that of services/pr-review/review-one.sh: a finding is posted
// inline only where its line is inside a diff hunk (GitHub rejects the whole
// review otherwise), the rest go in the body, and `body` mode puts them all there.

function hunksOf(diff) {
  const hunks = [];
  let file = '';
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) header = true;
    else if (line.startsWith('@@')) header = false;
    if (header && line.startsWith('+++ b/')) file = line.slice(6);
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && (m[2] === undefined || Number(m[2]) > 0)) hunks.push({ file, from: Number(m[1]), to: Number(m[1]) + (m[2] === undefined ? 1 : Number(m[2])) - 1 });
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
    findings.length === 0 && stillOpen.length === 0 ? 'LGTM — no finding survived verification.' : `${findings.length} new finding(s), ${stillOpen.length} still open.`,
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
