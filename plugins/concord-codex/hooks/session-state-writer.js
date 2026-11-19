#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseDelta } = require('../engine/transcript');
const { readStdinEvent } = require('../engine/event');
const { extractFacts, extractRationale, extractRationaleText } = require('../engine/extract');
const { emptyModel, mergeModel } = require('../engine/state');
const { writeNorthStarIfAbsent, firstSubstantiveUserMessage, readNorthStar } = require('../engine/charter');
const { resolveStateDirFromCwd } = require('../engine/statedir');
const { confinedCwd } = require('../engine/read-only');
const { dataDir, sessionRoot } = require('../runtime/data-dir');

// A confined agent or headless session a script started: its working directory is under pr-to-merge's
// session-worktree root or in a marked round directory. Codex loads this plugin's hooks there too; they do nothing.
const confined = (cwd) => confinedCwd(cwd || process.cwd(), { sessionRoot: sessionRoot('codex'), prsRoot: path.join(dataDir('explain-pr', 'codex'), 'prs') });

function main() {
  const { sessionId, transcriptPath, lastAssistantMessage, cwd } = readStdinEvent('stop');
  if (!sessionId || !transcriptPath || confined(cwd)) return;

  const sid = path.basename(String(sessionId));
  // State dir = cwd-derived (~/.codex/concord/projects/<slug>/state), NOT the
  // transcript-sibling the Claude Code writer uses -- the hook runs with
  // process.cwd() = the session cwd, so this matches what the review loop reads.
  const stateDir = resolveStateDirFromCwd();
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonPath = path.join(stateDir, `${sid}.json`);

  let model = emptyModel();
  try {
    model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    /* first run for this session */
  }

  // parseDelta returns NeutralEntry[] (raw Codex rollout mapped through the
  // adapter); extractFacts/extractRationale consume that shape directly.
  const { entries: neutralEntries, newOffset } = parseDelta(transcriptPath, model.offset || 0);
  const facts = extractFacts(neutralEntries);
  const rationale = extractRationale(neutralEntries);
  // Also harvest tags from the just-finished turn via stdin, in case it has not
  // yet flushed to the transcript; downstream dedup absorbs the overlap.
  const msgRationale = extractRationaleText(lastAssistantMessage);
  for (const key of ['decisions', 'openLoops', 'nexts', 'resolved']) {
    rationale[key].push(...msgRationale[key]);
  }
  model = mergeModel(model, { ...rationale, facts });
  model.offset = newOffset;

  fs.writeFileSync(jsonPath, JSON.stringify(model));

  // Auto-draft the north-star from the first substantive user message, but ONLY when
  // no charter.md exists yet. The absence guard is essential: without it, the full
  // parseDelta(..., 0) below would re-read and parse the ENTIRE transcript on every Stop
  // (the full-transcript-read waste this plugin's delta-offset design exists to kill).
  // Once the north-star exists, skip the read entirely. A wrong draft is fixed by `/charter set`.
  if (!readNorthStar(stateDir)) {
    const head = parseDelta(transcriptPath, 0).entries;
    const firstMsg = firstSubstantiveUserMessage(head);
    if (firstMsg) writeNorthStarIfAbsent(stateDir, firstMsg);
  }
}

try {
  main();
} catch (e) {
  /* never block the turn */
}
process.exit(0);
