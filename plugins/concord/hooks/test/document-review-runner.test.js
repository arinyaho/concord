'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');
const { tempDir } = require('./temp-dir');

test('runner skips the plan launch for a confirmed file follow-up round', async () => {
  const repoRoot = tempDir('document-runner-repo-');
  const stateDir = tempDir('document-runner-state-');
  fs.writeFileSync(path.join(repoRoot, 'note.md'), 'word\n');
  const roles = [], commands = [];
  const result = await runReviewUntilGreen({
    ref: 'file:note.md', repoRoot, targetIdentity: () => 'fixed-file-head',
    reviewer: 'claude', fixer: 'claude',
    runCli: ([verb]) => {
      commands.push(verb);
      if (verb === 'round-start') return { decision: 'work', round: 2, stateDir, targetType: 'file', documentReviewPolicy: 'single-pass-confirmation', head: 'fixed-file-head', dodPassed: true, dodDeferred: true, intentApplied: false, gateApplied: false };
      if (verb === 'artifact-normalize') return { status: 'ok' };
      if (verb === 'verify-needed') return { verify: 'required', plan: 'required' };
      if (verb === 'findings') return { findings: [], planRequired: false, documentFollowUps: [{ id: 'docreview:wording', minorReason: 'Verified as minor.' }] };
      if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty', transactionScope: 'group', fixes: [], fixGroups: [] };
      if (verb === 'record') return { decision: { continue: false, reviewedWithFollowUps: true, followUps: ['docreview:wording'] }, handoff: 'follow-up recorded' };
      return {};
    },
    spawn: async ({ role }) => {
      roles.push(role);
      const file = path.join(stateDir, `round-2-${role}.json`);
      const artifact = role === 'correctness'
        ? { status: 'ok', examined: ['note.md'], findings: [] }
        : { status: 'ok', rejected: [], findings: [], minor: [], blocking: [] };
      fs.writeFileSync(file, JSON.stringify(artifact));
      return { status: 0 };
    },
  });
  assert.deepEqual(roles, ['correctness', 'verify']);
  assert.ok(commands.indexOf('findings') > commands.indexOf('verify-needed'));
  assert.ok(commands.indexOf('findings') < commands.indexOf('plan-fixes'));
  assert.equal(commands.includes('artifact-normalize') && roles.includes('plan'), false);
  assert.equal(result.handoff, 'follow-up recorded');
});
