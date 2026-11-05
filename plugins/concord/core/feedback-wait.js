'use strict';
const collector = require('./review-collector');

const FINGERPRINT_QUERY = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid state isDraft updatedAt reviewDecision mergeStateStatus reviews(last:1){nodes{id lastEditedAt}} comments(last:1){nodes{id lastEditedAt}} reviewThreads(last:20){nodes{comments(last:1){nodes{id lastEditedAt}}}}}}}`;

async function waitFeedback({ pr, graphql, state, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), intervalMs = 60000, maxWaitMs = Infinity, once = false, sidecar, rateLimitResetMs = async () => null }) {
  const number = Number(pr), windowEnd = now() + maxWaitMs;
  const head = state.lastWaitHead();
  const wait = head && state.humanWait(head);
  if (!head || !wait) return { event: 'error', pr: number, detail: 'no human wait is open for this PR' };
  let saved;
  try { saved = sidecar.read(); } catch (_) { saved = {}; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  let failures = Number.isInteger(saved.failures) && saved.failures >= 0 ? saved.failures : 0;
  const persist = () => { try { sidecar.write({ ...saved, failures }); } catch (_) { /* A lost sidecar only repeats a poll. */ } };
  const result = (event, extra = {}) => ({ event, pr: number, head, ...extra });
  for (;;) {
    let delay = intervalMs;
    try {
      const response = await graphql(FINGERPRINT_QUERY, { pr: number });
      const live = response && response.data && response.data.repository && response.data.repository.pullRequest;
      if (!live || !live.headRefOid) throw new Error('feedback-wait: fingerprint has no pull request');
      const liveHead = live.headRefOid.toLowerCase();
      const { reviewDecision, mergeStateStatus, ...activity } = live;
      const fingerprint = JSON.stringify(activity);
      let event;
      if (live.state === 'MERGED') event = result('merged', { head: liveHead });
      else if (live.state === 'CLOSED') event = result('closed', { head: liveHead });
      else if (liveHead !== head && liveHead === saved.previousHead) event = result('head-moved', { head: liveHead });
      else if (saved.isDraft === true && live.isDraft === false) event = result('ready', { head: liveHead });
      else {
        if (fingerprint !== saved.fingerprint) {
          const packet = await collector.collect({ pr: number, head, graphql, selection: state.selection() || [], answered: state.answered(head) });
          if (!packet.stale) {
            const items = [...new Set(packet.observations.flatMap((observation) => observation.findings.map((finding) => finding.itemId).filter(Boolean)))];
            if (items.length > 0) event = result('feedback', { items });
            else saved.fingerprint = fingerprint;
          }
        }
        if (!event && (Object.hasOwn(saved, 'reviewDecision') || Object.hasOwn(saved, 'mergeStateStatus')) && (saved.reviewDecision !== reviewDecision || saved.mergeStateStatus !== mergeStateStatus)) event = result('rules-changed', { head: liveHead });
        if (!event && now() >= wait.deadlineMs) event = result('deadline');
      }
      saved = { ...saved, previousHead: liveHead, isDraft: live.isDraft, reviewDecision, mergeStateStatus };
      failures = 0;
      persist();
      if (event) return event;
    } catch (error) {
      if (/rate limit/i.test(error.message)) {
        let reset;
        try { reset = await rateLimitResetMs(); } catch (_) { /* Retry at the regular interval when the reset endpoint fails. */ }
        delay = Number.isFinite(reset) && reset > now() ? reset - now() : intervalMs;
      } else {
        failures += 1;
        delay = intervalMs * Math.min(2 ** failures, 8);
      }
      persist();
      if (failures >= 10) return result('error', { detail: error.message });
    }
    if (once || now() >= windowEnd) return result('idle');
    await sleep(Math.min(delay, windowEnd - now()));
    if (now() >= windowEnd) return result('idle');
  }
}

module.exports = { FINGERPRINT_QUERY, waitFeedback };
