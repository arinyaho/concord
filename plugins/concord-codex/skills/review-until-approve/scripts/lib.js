'use strict';
// Pure decisions of review-until-approve. Nothing here touches the network, the
// filesystem or a live session, so a CI-driven variant can reuse it unchanged.
const crypto = require('node:crypto');

const DAY = 24 * 3600 * 1000;
const NUDGE_AFTER_MS = DAY;
const TIMEOUT_MS = 7 * DAY;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const collapse = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const last = (ledger) => ledger.rounds[ledger.rounds.length - 1];

// The diff a new round reviews. Only a plain push on the same merge base has an
// isolatable delta; a rewrite or a merged-in base branch reviews the whole PR
// diff, and only a changed title or body re-runs the broad gate.
function chooseRange(lastRound, live, isAncestor) {
  if (live.intent !== lastRound.intent) return { base: live.mergeBase, broad: true };
  // A submodule range that could not be read is tried again, with the rest of the pull request, until it can.
  if (lastRound.unreviewed?.length) return { base: live.mergeBase, broad: false };
  if (live.mergeBase === lastRound.mergeBase && isAncestor(lastRound.head, live.head)) return { base: lastRound.head, broad: false };
  return { base: live.mergeBase, broad: false };
}

// A renamed id does not hide a published finding: the span identifies it.
const findingKey = (f) => collapse(f.span) ? sha(`${f.file}\0${collapse(f.span)}`) : `${f.file}\0${f.id}`;

// The reviewer is told to raise a still-present finding again with the same id, so a raised finding
// that matches no known one by span is the known finding of the same file and id, quoting another span.
const matches = (known, f) => {
  const bySpan = known.filter((p) => findingKey(p) === findingKey(f));
  return bySpan.length ? bySpan : known.filter((p) => p.file === f.file && p.id === f.id);
};

// A fixed finding that comes back is a new finding; a waived one stays dismissed.
function isPublished(ledger, f) {
  return matches(ledger.findings.filter((p) => p.status !== 'fixed'), f).length > 0;
}

// The renames (old path -> new path) and the paths still present (everything but a deletion) of `git diff -z --name-status -M`.
function parseNameStatus(raw) {
  const t = raw.split('\0');
  const renames = new Map(), live = new Set();
  for (let i = 0; i + 1 < t.length; i += 2) {
    if (/^[RC]/.test(t[i])) {
      live.add(t[i + 2]);
      if (t[i][0] === 'R') renames.set(t[i + 1], t[i + 2]);
      i++;
    } else if (t[i][0] !== 'D') live.add(t[i + 1]);
  }
  return { renames, live };
}

// A finding is fixed only on evidence in git objects, never on the reviewer's silence. `resolve(p)` is the
// name-status delta (`{ renames, live }`) from the head where the span was last verified to the new head,
// or null when it cannot be computed. `read(path)` is the file at the new head: a Buffer, null when the path
// is absent, 'other' when it is not a regular file, 'big' when it is too large to read. An open finding is
// fixed when its span was verified verbatim earlier and no longer occurs at its path, following a rename,
// nor in any other path the push left in place. Anything else stays open with a reason: `unverified` (no
// verbatim span was ever recorded), `raised` (the reviewer raised it again), `path-unresolved`, `span-present`.
// A span that occurs at the head moves the anchor (`file`, `spanVerified`) to the new head.
function classifyPrior(open, raised, resolve, read, head) {
  const ctx = open.map((p) => typeof p.spanVerified === 'string' && p.span ? resolve(p) : null);
  const moved = open.map((p, i) => ({ ...p, file: ctx[i]?.renames.get(p.file) || p.file }));
  return open.map((p, i) => {
    const q = moved[i], keep = (reason, extra = {}) => ({ key: p.key, id: p.id, status: 'open', reason, ...extra });
    if (typeof p.spanVerified !== 'string' || !p.span) return keep('unverified');
    if (raised.some((f) => matches(moved, f).includes(q))) return keep('raised');
    if (!ctx[i]) return keep('path-unresolved');
    const span = Buffer.from(p.span, 'utf8');
    const here = read(q.file);
    if (here === 'other' || here === 'big') return keep('path-unresolved');
    if (here && here.includes(span)) return keep('span-present', { file: q.file, spanVerified: head });
    for (const other of ctx[i].live) {
      if (other === q.file) continue;
      const b = read(other);
      if (b === 'big') return keep('path-unresolved');
      if (Buffer.isBuffer(b) && b.includes(span)) return keep('span-present', { file: other, spanVerified: head });
    }
    return { key: p.key, id: p.id, status: 'fixed' };
  });
}

// The `owner/repo` on GitHub that a `.gitmodules` url names, or null. Only GitHub urls qualify, in the forms
// below; the caller builds the fetch url from the result, so the url string itself never reaches git.
// `prRepo` is the pull request's `owner/repo`, the base of a relative url.
function submoduleRepo(url, prRepo) {
  const [prOwner] = prRepo.split('/');
  const forms = [
    [/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/, (m) => [m[1], m[2]]],
    [/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/, (m) => [m[1], m[2]]],
    [/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/, (m) => [m[1], m[2]]],
    [/^\.\.\/([^/]+?)(?:\.git)?$/, (m) => [prOwner, m[1]]],
    [/^\.\.\/\.\.\/([^/]+)\/([^/]+?)(?:\.git)?$/, (m) => [m[1], m[2]]],
  ];
  for (const [re, pick] of forms) {
    const m = re.exec(url);
    if (!m) continue;
    const [owner, name] = pick(m);
    return /^[A-Za-z0-9-]+$/.test(owner) && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..' ? `${owner}/${name}` : null;
  }
  return null;
}

// A finding is a blocker unless it is explicitly minor: a missing or malformed class blocks. The engine reports `minor` only for an
// empty `releaseBlocking` with a rationale; the same is required here, so a ledger or runner that says less blocks.
const isBlocker = (f) => f.class !== 'minor';
function classOf(f) {
  const reason = collapse(f.rationale);
  if (f.class === 'minor' && !collapse(f.blockingReason) && Array.isArray(f.releaseBlocking) && f.releaseBlocking.length === 0 && reason) return { class: 'minor', reason, releaseBlocking: [] };
  const categories = Array.isArray(f.releaseBlocking) ? f.releaseBlocking.filter((c) => typeof c === 'string') : [];
  // gate-verify's reason for overriding a minor claim is the reason the finding blocks.
  return { class: 'blocker', reason: collapse(f.blockingReason) || reason || 'unclassified', ...(categories.length && { releaseBlocking: categories }) };
}
// Of several raised findings with one key the strictest class stands.
const strictest = (list) => list.map(classOf).find((c) => c.class === 'blocker') || classOf(list[0]);

// An open blocker blocks. An open minor does not: the approving review lists it as a follow-up. A user
// waives a disputed finding with `waive` and changes its class with `reclass`.
function evaluateApproval(ledger, live, reviewedHead) {
  const no = (reason) => ({ approve: false, reason });
  if (reviewedHead !== live.head) return no('head-moved');
  if (live.state !== 'OPEN') return no('not-open');
  if (live.isDraft) return no('draft');
  if (live.author === ledger.reviewer) return no('self-review');
  if (ledger.approval?.head === live.head) return no('already-approved');
  const round = last(ledger);
  if (round?.head === reviewedHead && round.unreviewed?.length) return no('unreviewed-submodule');
  if (ledger.findings.some((f) => f.status === 'open' && isBlocker(f))) return no('open-blockers');
  return { approve: true };
}

// Author replies after the last review: in a thread of a review we published, or
// on the PR conversation (the only way to answer a finding posted in a review body).
function repliesSince(ledger, pullComments, issueComments, author) {
  if (!ledger.rounds.length) return [];
  const ours = new Set(ledger.rounds.flatMap((r) => r.commentIds));
  const since = Date.parse(last(ledger).submittedAt);
  return [
    ...pullComments.filter((c) => ours.has(c.in_reply_to_id)),
    ...issueComments,
  ].filter((c) => c.user?.login === author && Date.parse(c.created_at) > since).map((c) => c.created_at).sort();
}

// The one event the watch prints, or null to keep waiting. `stable` means the head
// was the same on two consecutive polls, so a burst of pushes wakes the session once.
function wakeDecision({ ledger, live, replies, now, stable }) {
  if (live.state === 'MERGED') return { event: 'merged' };
  if (live.state === 'CLOSED') return { event: 'closed' };
  // No round was published (the first one failed): there is no review to answer, so only a head newer than the attempt asks for a round.
  if (!ledger.rounds.length) return ledger.attempt && live.head !== ledger.attempt.head && stable ? { event: 'round', head: live.head } : null;
  const lastRound = last(ledger);
  const age = now - Date.parse(lastRound.submittedAt);
  if (age >= TIMEOUT_MS) return { event: 'timeout' };
  const pushed = live.head !== lastRound.head;
  // A round that failed at this head used every reply up to its time: only a newer head or reply asks for another.
  const attempt = ledger.attempt;
  if (attempt && live.head === attempt.head && !replies.some((at) => Date.parse(at) > Date.parse(attempt.at))) return null;
  const replied = replies.length > 0;
  if (pushed && replied) return stable ? { event: 'round', head: live.head } : null;
  if (!pushed && !replied) return null;
  const kind = pushed ? 'push-only' : 'reply-only';
  const replyAt = replies[replies.length - 1] ?? null;
  const n = ledger.nudged;
  if (age < NUDGE_AFTER_MS || (n && n.kind === kind && n.head === live.head && n.replyAt === replyAt)) return null;
  return { event: 'nudge', kind, head: live.head, replyAt };
}

module.exports = { submoduleRepo, chooseRange, findingKey, matches, isPublished, parseNameStatus, classifyPrior, isBlocker, classOf, strictest, evaluateApproval, repliesSince, wakeDecision, sha, NUDGE_AFTER_MS, TIMEOUT_MS };
