'use strict';
// Rendering of one review. Pure, so an unattended variant can reuse it.
// A finding is posted as a line comment where its line is inside a diff hunk, as a file comment where its file is in the
// diff but the line is not, and in the body otherwise. `body` mode puts them all in the body, and so does a finding
// listed in `rejected` (a comment GitHub refused).

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

// The line a finding's span starts on, for the occurrence that lies inside a hunk of its file: the engine gives none for a
// span that occurs more than once, and an inline comment needs one. A multi-line span takes its first line inside a hunk.
function placeLine(content, span, file, hunks) {
  const body = (span || '').replace(/^\n+|\n+$/g, '');
  if (!body) return null;
  const mine = hunks.filter((h) => h.file === file);
  const rows = body.split('\n').length;
  let line = 1;
  let seen = 0;
  for (let at = content.indexOf(body); at !== -1; at = content.indexOf(body, at + 1)) {
    for (; seen < at; seen++) if (content.charCodeAt(seen) === 10) line++;
    for (let l = line; l < line + rows; l++) if (mine.some((h) => l >= h.from && l <= h.to)) return l;
  }
  return null;
}

// Every file the diff names, including one with no added line (a deletion, a mode change, a pure rename, a binary) that has no
// hunk. The path is the b-side of the `diff --git` line, which is never /dev/null.
function filesOf(diff) {
  const files = new Set();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const q = /("b\/(?:[^"\\]|\\.)*")$/.exec(line);
    const i = line.lastIndexOf(' b/');
    const file = q ? headerPath(q[1]) : i === -1 ? '' : line.slice(i + 3);
    if (file) files.add(file);
  }
  return [...files];
}

// Anything but an explicit minor is labeled a blocker, with the release-blocking categories the reviewer named.
const label = (f) => f.class === 'minor' ? 'minor' : `blocker${f.releaseBlocking?.length ? `: ${f.releaseBlocking.join(', ')}` : ''}`;
const text = (f) => `**${f.category}** (${label(f)}) ${f.summary}${f.reason ? ` — ${f.reason}` : ''}${f.requirement ? `\n\n> ${f.requirement}` : ''}\n\n\`${f.id}\``;
const ids = (list) => list.map((id) => `\`${id}\``).join(', ');

// `how` is "inline" or "body". Event is APPROVE only for a clean round, never REQUEST_CHANGES.
function renderReview({ unconfined, head, round, rangeBase, reviewer, hunks, files = [], findings, fixed, addressed = [], stillOpen, previousHead, approve, followUps = [], rejected = [] }, how) {
  const inDiff = (f) => f.line != null && hunks.some((h) => h.file === f.file && f.line >= h.from && f.line <= h.to);
  const inFile = (f) => files.includes(f.file) || hunks.some((h) => h.file === f.file);
  const threads = how === 'inline' ? findings.filter((f) => !rejected.includes(f) && inFile(f)).map((f) => inDiff(f)
    ? { finding: f, subject: 'LINE', path: f.file, line: f.line, body: text(f) }
    : { finding: f, subject: 'FILE', path: f.file, body: `${f.line ? `Line ${f.line}: ` : ''}${text(f)}` }) : [];
  const rest = findings.filter((f) => !threads.some((t) => t.finding === f));
  const minors = new Set(followUps.map((f) => f.key));
  const lines = [
    `<!-- concord-approve: ${head} round:${round} base:${rangeBase} -->`,
    `reviewed by concord (${reviewer})`,
    ...(unconfined ? [`reviewed unconfined on the reviewing account's trust declaration (recorded ${unconfined})`] : []),
    findings.length === 0 && stillOpen.length === 0 ? (approve ? 'LGTM — no finding survived verification.' : 'No finding survived verification; this review does not approve.') : `${findings.length} new finding(s) (${findings.filter((f) => f.class !== 'minor').length} blocking), ${stillOpen.length} still open (${stillOpen.filter((f) => !minors.has(f.key)).length} blocking).${approve ? ' No blocking finding is open.' : ''}`,
  ];
  if (fixed.length) lines.push(`Fixed since \`${previousHead.slice(0, 7)}\`: ${ids(fixed)}`);
  if (addressed.length) lines.push(`Addressed since \`${previousHead.slice(0, 7)}\`: ${ids(addressed)}`);
  if (stillOpen.length) lines.push(`Still open: ${stillOpen.map((f) => `\`${f.id}\`${minors.has(f.key) ? ' (minor)' : ''}`).join(', ')}`);
  for (const f of rest) lines.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` ${text(f)}`);
  if (approve && followUps.length) lines.push(`Follow-ups (not blocking):\n${followUps.map((f) => `- \`${f.file}${f.line ? `:${f.line}` : ''}\` ${f.summary} — ${f.reason} (\`${f.id}\`)`).join('\n')}`);
  return {
    commit_id: head,
    event: approve ? 'APPROVE' : 'COMMENT',
    body: lines.join('\n\n'),
    threads,
  };
}

const containsSecret = (payload, secrets) => secrets.some((s) => s && payload.includes(s));

module.exports = { hunksOf, filesOf, placeLine, renderReview, containsSecret };
