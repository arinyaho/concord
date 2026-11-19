#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseDelta } = require('../adapters/claude-code/transcript');
const { readStdinEvent } = require('../adapters/claude-code/event');
const { extractFacts, extractRationale, extractRationaleText } = require('../core/extract');
const { emptyModel, mergeModel } = require('../core/state');
const { writeNorthStarIfAbsent, firstSubstantiveUserMessage, readNorthStar } = require('../core/charter');
const { readMode, confinedCwd } = require('../core/read-only');
const { dataDir, sessionRoot } = require('../runtime/data-dir');

// A session in explain-pr's read-only mode has read a pull request written by someone else: nothing it says is
// carried into later sessions. A mode file that cannot be read counts as the mode.
function inReadOnlyMode(sid) {
  try {
    return readMode(dataDir('explain-pr', 'claude'), sid) !== null;
  } catch {
    return true;
  }
}

// A confined agent or headless session a script started: its mode file is of a confined kind, or its working directory
// is a confined one. Nothing of it is harvested. A mode file that cannot be read counts as confined.
function confined(sid) {
  const dir = dataDir('explain-pr', 'claude');
  if (confinedCwd(process.cwd(), { sessionRoot: sessionRoot('claude'), prsRoot: path.join(dir, 'prs') })) return true;
  try {
    const mode = readMode(dir, sid);
    return mode !== null && mode.kind !== 'read';
  } catch {
    return true;
  }
}

function main() {
  const { sessionId, transcriptPath, lastAssistantMessage } = readStdinEvent('stop');
  if (!sessionId || !transcriptPath) return;

  const sid = path.basename(String(sessionId));
  if (confined(sid)) return;
  const stateDir = path.join(path.dirname(transcriptPath), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonPath = path.join(stateDir, `${sid}.json`);

  let model = emptyModel();
  try {
    model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    /* first run for this session */
  }

  // parseDelta returns NeutralEntry[] (raw Claude JSONL mapped through the
  // adapter); extractFacts/extractRationale consume that shape directly.
  const { entries: neutralEntries, newOffset } = parseDelta(transcriptPath, model.offset || 0);
  if (inReadOnlyMode(sid)) {
    model.offset = newOffset;
    fs.writeFileSync(jsonPath, JSON.stringify(model));
    return;
  }
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
