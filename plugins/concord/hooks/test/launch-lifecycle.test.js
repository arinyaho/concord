'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLaunchLifecycle } = require('../../core/launch-lifecycle');

function result(provider = 'codex', supportedSchema = true) {
  return createLaunchLifecycle({ provider, supportedSchema });
}
function error(code) { return { type: 'error', error: { code } }; }
function finish(tracker, extra = {}) {
  return tracker.finish({ status: 1, signal: null, timedOut: false, interrupted: false, ...extra });
}

test('trusted pre-spawn errors refund for all providers', () => {
  for (const provider of ['codex', 'claude', 'copilot']) {
    for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
      assert.deepEqual(result(provider).spawnError(code), { lifecycle: 'not-started', reason: `spawn-${code.toLowerCase()}`, failed: true });
    }
  }
});

test('spawned errors and unrecognized errors stay charged', () => {
  const tracker = result('claude');
  tracker.spawned();
  assert.equal(tracker.spawnError('ENOENT').lifecycle, 'unknown');
  assert.equal(result().spawnError('EIO').lifecycle, 'unknown');
});

test('recognized complete Codex structured rejections qualify before a turn', () => {
  for (const code of ['model_not_found', 'unsupported_model', 'sandbox_denied']) {
    const tracker = result(); tracker.spawned(); tracker.observe(error(code));
    const outcome = finish(tracker);
    assert.equal(outcome.lifecycle, 'not-started');
    assert.equal(outcome.reason, code === 'sandbox_denied' ? 'sandbox-denied' : 'unsupported-model');
    assert.equal(outcome.failed, true);
  }
});

test('thread initialization does not prevent a structured rejection refund', () => {
  const tracker = result(); tracker.spawned(); tracker.observe({ type: 'thread.started' }); tracker.observe(error('model_not_found'));
  assert.equal(finish(tracker).lifecycle, 'not-started');
});

test('unsupported schema and any supported start evidence remain charged', () => {
  let tracker = result('codex', false); tracker.spawned(); tracker.observe(error('model_not_found'));
  assert.equal(finish(tracker).lifecycle, 'unknown');
  for (const event of [{ type: 'turn.started' }, { type: 'item.started', item: { type: 'agent_message' } }, { type: 'item.updated', item: { type: 'command_execution' } }, { type: 'item.completed', item: { type: 'agent_message' } }]) {
    tracker = result(); tracker.spawned(); tracker.observe(event); tracker.observe(error('model_not_found'));
    assert.equal(finish(tracker).lifecycle, 'started');
  }
});

test('only known Codex work items prove start, while unknown items block refund', () => {
  for (const itemType of ['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'collaboration_tool_call', 'collab_agent_tool_call']) {
    const tracker = result(); tracker.spawned(); tracker.observe({ type: 'item.started', item: { type: itemType } });
    assert.equal(finish(tracker).lifecycle, 'started', itemType);
  }
  for (const item of [{ type: 'future_item' }, { type: 'agent_message', error: { code: 'model_not_found' } }]) {
    const tracker = result(); tracker.spawned(); tracker.observe({ type: 'item.started', item }); tracker.observe(error('model_not_found'));
    assert.equal(finish(tracker).lifecycle, 'unknown');
  }
  const afterStart = result(); afterStart.spawned();
  afterStart.observe({ type: 'turn.started' }); afterStart.observe({ type: 'item.updated', item: { type: 'future_item' } });
  afterStart.observe(error('model_not_found'));
  assert.equal(finish(afterStart).lifecycle, 'started');
});

test('turn.failed remains nonrefundable but can preserve its recognized environment reason', () => {
  const tracker = result(); tracker.spawned(); tracker.observe({ type: 'turn.started' });
  tracker.observe({ type: 'turn.failed', error: { code: 'model_not_found' } });
  assert.deepEqual(finish(tracker), { lifecycle: 'started', reason: 'unsupported-model', failed: true });
  const beforeTurn = result(); beforeTurn.spawned(); beforeTurn.observe({ type: 'turn.failed', error: { code: 'sandbox_denied' } });
  assert.deepEqual(finish(beforeTurn), { lifecycle: 'unknown', reason: 'sandbox-denied', failed: true });
});

test('recognized rejection reason is retained on started failures', () => {
  const tracker = result(); tracker.spawned(); tracker.observe({ type: 'turn.started' }); tracker.observe(error('model_not_found'));
  assert.deepEqual(finish(tracker), { lifecycle: 'started', reason: 'unsupported-model', failed: true });
  const other = result(); other.spawned(); other.observe({ type: 'turn.started' });
  assert.deepEqual(finish(other), { lifecycle: 'started', reason: 'unknown', failed: true });
});

test('malformed, unknown, failed-turn-only, multiple-error, or nonfailure finishes never refund', () => {
  const cases = [
    t => t.malformed(),
    t => t.observe({ type: 'unexpected' }),
    t => t.observe({ type: 'turn.failed', error: { code: 'model_not_found' } }),
    t => { t.observe(error('model_not_found')); t.observe(error('sandbox_denied')); },
    t => t.observe(error('model_not_found')),
  ];
  for (let i = 0; i < cases.length; i++) {
    const tracker = result(); tracker.spawned(); cases[i](tracker);
    const outcome = finish(tracker, i === 4 ? { status: 0 } : {});
    assert.notEqual(outcome.lifecycle, 'not-started');
  }
  for (const fields of [{ signal: 'SIGTERM' }, { timedOut: true }, { interrupted: true }]) {
    const tracker = result(); tracker.spawned(); tracker.observe(error('model_not_found'));
    assert.equal(finish(tracker, fields).lifecycle, 'unknown');
  }
});

test('normal Codex completion proves started and provider prose cannot trigger refund', () => {
  const tracker = result(); tracker.spawned(); tracker.observe({ type: 'turn.completed' });
  assert.deepEqual(finish(tracker, { status: 0 }), { lifecycle: 'started', reason: 'none', failed: false });
  const prose = result(); prose.spawned(); prose.observe({ type: 'error', message: 'model_not_found' });
  assert.equal(finish(prose).lifecycle, 'unknown');
});

test('mirrored provider engine modules preserve the same lifecycle decisions', () => {
  for (const path of ['../../../concord-codex/engine/launch-lifecycle', '../../../concord-copilot/engine/launch-lifecycle']) {
    const tracker = require(path).createLaunchLifecycle({ provider: 'codex', supportedSchema: true });
    tracker.spawned(); tracker.observe(error('sandbox_denied'));
    assert.equal(finish(tracker).lifecycle, 'not-started');
    assert.equal(finishAfterClose(tracker).lifecycle, 'unknown');
  }
});

function finishAfterClose(tracker) {
  return tracker.finish({ status: 1, signal: null, timedOut: false, interrupted: false });
}
