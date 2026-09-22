'use strict';
// Same verification scenario, two ways of running it:
//
// "Baseline" is the pattern this guidance replaces (see
// references/delivery.md, "Verify at risk boundaries and milestones"): the
// main thread itself renders/reads a slide screenshot to check it against
// spec. A prior transcript analysis (ALC-4) found that path lands the full
// image in the main-thread transcript TWICE -- once in the tool_use/message
// content block that references it, once again in the tool_result block
// that returns it.
//
// "Delegated" is the guidance added by this change: the main thread hands
// the screenshot and the exact check to a subagent; the subagent's own
// transcript holds the image, and the main thread only ever receives the
// small verdict it returns.
//
// This scenario has no live multi-agent harness to capture from in this
// repo (concord ships skills, not an application), so the two paths are
// modeled mechanically: two independent ledgers stand in for "main thread"
// and "dispatched subagent". The reduction the test asserts falls out of
// which ledger the image bytes land on, not from a hand-picked return
// value -- both paths run the identical inspectScreenshot() call; only
// where its image-bytes cost is charged differs.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SCREENSHOT_BYTES = 480_000; // representative rendered-slide PNG size
const VERDICT = { clipped: false, headline: 'Reduce onboarding time by 40%' };
const VERDICT_BYTES = Buffer.byteLength(JSON.stringify(VERDICT));

function inspectScreenshot() {
  // Stands in for actually reading/rendering the screenshot: the caller
  // pays for the image bytes wherever this is invoked from.
  return { imageBytes: SCREENSHOT_BYTES, verdict: VERDICT };
}

function runVerification({ delegate }) {
  let mainThreadImageBytes = 0;
  let subagentImageBytes = 0;

  function subagentSession() {
    // Runs on the subagent's own ledger; the screenshot's bytes are charged
    // here twice (tool_use + tool_result), same as the main thread would
    // pay if it inspected the image itself -- only the verdict crosses back.
    const { imageBytes } = inspectScreenshot();
    subagentImageBytes += imageBytes * 2;
    return VERDICT_BYTES;
  }

  if (delegate) {
    mainThreadImageBytes += subagentSession(); // only the small verdict crosses over
  } else {
    const { imageBytes } = inspectScreenshot();
    mainThreadImageBytes += imageBytes * 2; // tool_use + tool_result, both on the main thread
  }

  return { mainThreadImageBytes, subagentImageBytes };
}

test('baseline verification pays the full image bytes on the main thread', () => {
  const before = runVerification({ delegate: false });
  assert.equal(before.mainThreadImageBytes, SCREENSHOT_BYTES * 2);
  assert.equal(before.subagentImageBytes, 0);
});

test('delegating screenshot inspection moves the image bytes off the main thread', () => {
  const before = runVerification({ delegate: false });
  const after = runVerification({ delegate: true });
  // The image bytes still get paid in full -- just on the subagent's ledger
  // instead of the main thread's, so the reduction isn't a discarded value.
  assert.equal(after.subagentImageBytes, SCREENSHOT_BYTES * 2);
  assert.equal(after.mainThreadImageBytes, VERDICT_BYTES);
  assert.ok(
    after.mainThreadImageBytes < before.mainThreadImageBytes,
    `expected fewer main-thread image bytes after delegating (${after.mainThreadImageBytes} >= ${before.mainThreadImageBytes})`
  );
});
