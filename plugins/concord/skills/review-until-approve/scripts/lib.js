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
  if (live.mergeBase === lastRound.mergeBase && isAncestor(lastRound.head, live.head)) return { base: lastRound.head, broad: false };
  return { base: live.mergeBase, broad: false };
}

// A renamed id does not hide a published finding: the span identifies it.
const findingKey = (f) => collapse(f.span) ? sha(`${f.file}\0${collapse(f.span)}`) : `${f.file}\0${f.id}`;

// The reviewer is told to raise a still-present finding again with the same id, so the same
// file and id is the same finding even when it quotes another span.
const sameFinding = (a, b) => findingKey(a) === findingKey(b) || (a.file === b.file && a.id === b.id);

// A fixed finding that comes back is a new finding; a waived one stays dismissed.
function isPublished(ledger, f) {
  return ledger.findings.some((p) => p.status !== 'fixed' && sameFinding(p, f));
}

// The changed paths and the renames (old path -> new path) of `git diff -z --name-status -M`.
function parseNameStatus(raw) {
  const t = raw.split('\0');
  const changed = new Set(), renames = new Map();
  for (let i = 0; i + 1 < t.length; i += 2) {
    if (/^[RC]/.test(t[i])) { changed.add(t[i + 2]); if (t[i][0] === 'R') renames.set(t[i + 1], t[i + 2]); i++; } else changed.add(t[i + 1]);
  }
  return { changed, renames };
}

// An earlier open finding stays open when this round raised it again, or when its
// file is untouched and the span still occurs at the new head. A finding on a renamed
// file follows the rename: it stays open while the span occurs at the new path, and
// `moved` lists the new path for the ledger.
function classifyPrior(open, raised, changedFiles, spanAtHead, renames = new Map()) {
  const out = { open: [], fixed: [], fixedKeys: [], moved: [] };
  for (const p of open) {
    const file = renames.get(p.file) || p.file;
    const q = { ...p, file };
    const again = raised.some((f) => sameFinding(f, q));
    if (again || (file !== p.file ? spanAtHead(file, p.span) : !changedFiles.has(p.file) && spanAtHead(p.file, p.span))) {
      out.open.push(p.id);
      if (file !== p.file) out.moved.push({ key: p.key, file });
    } else { out.fixed.push(p.id); out.fixedKeys.push(findingKey(p)); }
  }
  return out;
}

// Every verified finding blocks: the review engine emits no severity. A user
// waives a disputed one with the `waive` verb.
function evaluateApproval(ledger, live, reviewedHead) {
  const no = (reason) => ({ approve: false, reason });
  if (reviewedHead !== live.head) return no('head-moved');
  if (live.state !== 'OPEN') return no('not-open');
  if (live.isDraft) return no('draft');
  if (live.author === ledger.reviewer) return no('self-review');
  if (ledger.approval?.head === live.head) return no('already-approved');
  if (ledger.findings.some((f) => f.status === 'open')) return no('open-findings');
  return { approve: true };
}

// Author replies after the last review: in a thread of a review we published, or
// on the PR conversation (the only way to answer a finding posted in a review body).
function repliesSince(ledger, pullComments, issueComments, author) {
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
  const lastRound = last(ledger);
  const age = now - Date.parse(lastRound.submittedAt);
  if (age >= TIMEOUT_MS) return { event: 'timeout' };
  const pushed = live.head !== lastRound.head;
  const replied = replies.length > 0;
  if (pushed && replied) return stable ? { event: 'round', head: live.head } : null;
  if (!pushed && !replied) return null;
  const kind = pushed ? 'push-only' : 'reply-only';
  const replyAt = replies[replies.length - 1] ?? null;
  const n = ledger.nudged;
  if (age < NUDGE_AFTER_MS || (n && n.kind === kind && n.head === live.head && n.replyAt === replyAt)) return null;
  return { event: 'nudge', kind, head: live.head, replyAt };
}

module.exports = { chooseRange, findingKey, isPublished, parseNameStatus, classifyPrior, evaluateApproval, repliesSince, wakeDecision, sha, NUDGE_AFTER_MS, TIMEOUT_MS };
