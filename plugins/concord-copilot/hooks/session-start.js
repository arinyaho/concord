#!/usr/bin/env node
'use strict';
const { readStdinEvent, toNeutralEvent } = require('../engine/event');
const { ensureStateDir } = require('../engine/statedir');
const { readNorthStar, mergeSessions, renderCharter } = require('../engine/charter');

const CONVENTION = 'Concord persistence is active. Persist durable project framing with `/charter set <north star>`.';

function handleSessionStart(payload, env = process.env) {
  const event = toNeutralEvent(payload);
  if (!event.cwd) {
    return { systemMessage: 'Concord could not load project state because Copilot did not provide a working directory.' };
  }

  const stateDir = ensureStateDir(event.cwd, env);
  const northStar = readNorthStar(stateDir);
  const merged = mergeSessions(stateDir);
  const hasContext = northStar || merged.openLoops.length || merged.decisions.length || merged.nexts.length;
  const parts = [];
  if (hasContext) {
    parts.push('# Prior task context in this project - verify relevance before relying on it\n\n' + renderCharter(northStar, merged));
  }
  parts.push(CONVENTION);

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n\n'),
    },
  };
}

function run() {
  try {
    process.stdout.write(JSON.stringify(handleSessionStart(readStdinEvent())));
  } catch (error) {
    process.stdout.write(JSON.stringify({ systemMessage: `Concord state injection failed: ${error.message}` }));
  }
}

if (require.main === module) run();

module.exports = { CONVENTION, handleSessionStart, run };