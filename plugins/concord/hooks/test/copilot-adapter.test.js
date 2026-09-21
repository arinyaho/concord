'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const copilotEvent = require('../../adapters/copilot/event');
const copilotStateDir = require('../../adapters/copilot/statedir');
const { handleSessionStart } = require('../../../concord-copilot/hooks/session-start');
const { handleUserPromptSubmit } = require('../../../concord-copilot/hooks/user-prompt-submit');

function temporaryProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'concord-copilot-project-'));
}

function temporaryData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'concord-copilot-data-'));
}

test('Copilot event adapter uses documented hook fields only', () => {
  assert.deepEqual(copilotEvent.toNeutralEvent({
    session_id: 'session-1',
    cwd: '/workspace/project',
    hook_event_name: 'SessionStart',
    source: 'new',
    prompt: '/charter set Keep the release reversible',
    transcript_path: '/unstable/transcript.jsonl',
  }), {
    sessionId: 'session-1',
    cwd: '/workspace/project',
    source: 'new',
    prompt: '/charter set Keep the release reversible',
  });
});

test('Copilot state directories are stable and isolated by canonical project root', () => {
  const dataRoot = temporaryData();
  const firstProject = temporaryProject();
  const secondProject = temporaryProject();
  const env = { PLUGIN_DATA: dataRoot };

  const first = copilotStateDir.resolveStateDir(firstProject, env);
  assert.equal(first, copilotStateDir.resolveStateDir(firstProject, env));
  assert.notEqual(first, copilotStateDir.resolveStateDir(secondProject, env));
  assert.equal(path.dirname(path.dirname(first)), path.join(dataRoot, 'projects'));
  assert.equal(path.basename(first), 'state');
});

test('UserPromptSubmit persists an explicit charter update for the current project', () => {
  const cwd = temporaryProject();
  const dataRoot = temporaryData();
  const env = { PLUGIN_DATA: dataRoot };

  const output = handleUserPromptSubmit({
    cwd,
    hook_event_name: 'UserPromptSubmit',
    prompt: '/charter set Keep the release reversible',
  }, env);

  assert.equal(output.systemMessage, 'Concord charter updated for this project.');
  const stateDir = copilotStateDir.resolveStateDir(cwd, env);
  assert.equal(fs.readFileSync(path.join(stateDir, 'charter.md'), 'utf8'), 'Keep the release reversible');
});

test('SessionStart injects persisted charter through the documented hook output', () => {
  const cwd = temporaryProject();
  const dataRoot = temporaryData();
  const env = { PLUGIN_DATA: dataRoot };
  handleUserPromptSubmit({ cwd, prompt: '/charter set Preserve project intent' }, env);

  const output = handleSessionStart({ cwd, hook_event_name: 'SessionStart', source: 'new' }, env);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /Prior task context/);
  assert.match(output.hookSpecificOutput.additionalContext, /Preserve project intent/);
});

test('Copilot hooks report missing cwd without reading or writing shared state', () => {
  const env = { PLUGIN_DATA: temporaryData() };
  assert.match(handleUserPromptSubmit({ prompt: '/charter set Unsafe' }, env).systemMessage, /working directory/);
  assert.match(handleSessionStart({ source: 'new' }, env).systemMessage, /working directory/);
});