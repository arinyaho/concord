#!/usr/bin/env node
'use strict';
const { readStdinEvent, toNeutralEvent } = require('../engine/event');
const { ensureStateDir } = require('../engine/statedir');
const { setNorthStar } = require('../engine/charter');

function charterUpdate(prompt) {
  const text = String(prompt || '');
  const command = text.match(/(?:^|\n)\s*\/?charter\s+set\s+([\s\S]+)$/i);
  if (command) return command[1].trim();

  const marker = text.match(/(?:^|\n)\s*CONCORD_CHARTER_SET:\s*([\s\S]+)$/i);
  if (!marker) return null;
  const value = marker[1].trim();
  if (/^(?:show)?$/i.test(value)) return null;
  return value.replace(/^set\s+/i, '').trim() || null;
}

function handleUserPromptSubmit(payload, env = process.env) {
  const event = toNeutralEvent(payload);
  const update = charterUpdate(event.prompt);
  if (!update) return {};
  if (!event.cwd) {
    return { systemMessage: 'Concord could not save project state because Copilot did not provide a working directory.' };
  }

  const stateDir = ensureStateDir(event.cwd, env);
  setNorthStar(stateDir, update);
  return { systemMessage: 'Concord charter updated for this project.' };
}

function run() {
  try {
    process.stdout.write(JSON.stringify(handleUserPromptSubmit(readStdinEvent())));
  } catch (error) {
    process.stdout.write(JSON.stringify({ systemMessage: `Concord charter update failed: ${error.message}` }));
  }
}

if (require.main === module) run();

module.exports = { charterUpdate, handleUserPromptSubmit, run };