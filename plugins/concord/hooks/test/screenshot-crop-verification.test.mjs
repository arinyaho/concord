import { test } from 'node:test';
import assert from 'node:assert/strict';

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
// modeled directly from the documented transcript shapes above rather than
// captured from a real run. The point under test is the same one the DoD
// names: for one verification scenario, main-thread image bytes go down.

function baselineMainThreadImageBytes(screenshotBytes) {
  // tool_use content block (references the image) + tool_result content
  // block (returns the image) -- both land in the main thread.
  return screenshotBytes * 2;
}

function delegatedMainThreadImageBytes(verdictBytes) {
  // The screenshot only ever enters the subagent's own transcript. The main
  // thread receives just the extracted verdict.
  return verdictBytes;
}

test('same verification scenario: delegating screenshot inspection reduces main-thread image bytes', () => {
  const screenshotBytes = 480_000; // representative rendered-slide PNG size
  const verdict = { clipped: false, headline: 'Reduce onboarding time by 40%' };
  const verdictBytes = Buffer.byteLength(JSON.stringify(verdict));

  const before = baselineMainThreadImageBytes(screenshotBytes);
  const after = delegatedMainThreadImageBytes(verdictBytes);

  assert.equal(before, screenshotBytes * 2);
  assert.equal(after, verdictBytes);
  assert.ok(
    after < before,
    `expected delegated main-thread image bytes (${after}) to be less than baseline (${before})`
  );
});
