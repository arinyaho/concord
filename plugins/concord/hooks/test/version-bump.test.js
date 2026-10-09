'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');

// Compares SemVer versions; numeric prerelease identifiers compare as numbers.
function compare(a, b) {
  const [coreA, preA = ''] = a.split(/-(.*)/s);
  const [coreB, preB = ''] = b.split(/-(.*)/s);
  const core = coreA.split('.').map(Number);
  const other = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (core[i] !== other[i]) return Math.sign(core[i] - other[i]);
  if (!preA || !preB) return Math.sign((preB ? 1 : 0) - (preA ? 1 : 0));
  const idsA = preA.split('.');
  const idsB = preB.split('.');
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    if (idsA[i] === undefined) return -1;
    if (idsB[i] === undefined) return 1;
    const numeric = /^\d+$/.test(idsA[i]) && /^\d+$/.test(idsB[i]);
    const d = numeric ? Number(idsA[i]) - Number(idsB[i]) : idsA[i].localeCompare(idsB[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

function assertBumped(version, base) {
  assert.equal(compare(version, base) > 0, true, `VERSION ${version} must be higher than the base branch's ${base}; run node scripts/release-version.mjs <next> as the last commit`);
}

test('a PR whose VERSION equals or trails the base fails, a higher VERSION passes', () => {
  assert.throws(() => assertBumped('0.9.0-beta.8', '0.9.0-beta.8'));
  assert.throws(() => assertBumped('0.9.0-beta.7', '0.9.0-beta.8'));
  assert.throws(() => assertBumped('0.9.0-beta.9', '0.9.0'));
  assertBumped('0.9.0-beta.9', '0.9.0-beta.8');
  assertBumped('0.9.0-beta.10', '0.9.0-beta.9');
  assertBumped('0.9.0', '0.9.0-beta.9');
});

test('this branch raises VERSION above the base branch', { skip: !process.env.CONCORD_BASE_VERSION }, () => {
  assertBumped(fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim(), process.env.CONCORD_BASE_VERSION.trim());
});
