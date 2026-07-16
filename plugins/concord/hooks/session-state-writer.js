#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readDelta, mapEntries } = require('../adapters/claude-code/transcript');
const { extractFacts, extractRationale, extractRationaleText } = require('../core/extract');
const { emptyModel, mergeModel } = require('./lib/state');
const { writeNorthStarIfAbsent, firstSubstantiveUserMessage, readNorthStar } = require('../core/charter');

function main() {
  const { session_id, transcript_path, last_assistant_message } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!session_id || !transcript_path) return;

  const sid = path.basename(String(session_id));
  const stateDir = path.join(path.dirname(transcript_path), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonPath = path.join(stateDir, `${sid}.json`);

  let model = emptyModel();
  try {
    model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    /* first run for this session */
  }

  const { entries, newOffset } = readDelta(transcript_path, model.offset || 0);
  // extract.js now consumes NeutralEntry[]; readDelta still returns raw Claude
  // JSONL objects, so map them through the adapter first. (Interim: Task 4/5
  // rewires this hook onto adapters/claude-code/transcript.js's parseDelta.)
  const neutralEntries = mapEntries(entries);
  const facts = extractFacts(neutralEntries);
  const rationale = extractRationale(neutralEntries);
  // Also harvest tags from the just-finished turn via stdin, in case it has not
  // yet flushed to the transcript; downstream dedup absorbs the overlap.
  const msgRationale = extractRationaleText(last_assistant_message);
  for (const key of ['decisions', 'openLoops', 'nexts', 'resolved']) {
    rationale[key].push(...msgRationale[key]);
  }
  model = mergeModel(model, { ...rationale, facts });
  model.offset = newOffset;

  fs.writeFileSync(jsonPath, JSON.stringify(model));

  // Auto-draft the north-star from the first substantive user message, but ONLY when
  // no charter.md exists yet. The absence guard is essential: without it, the full
  // readDelta(..., 0) below would re-read and parse the ENTIRE transcript on every Stop
  // (the full-transcript-read waste this plugin's delta-offset design exists to kill).
  // Once the north-star exists, skip the read entirely. A wrong draft is fixed by `/charter set`.
  if (!readNorthStar(stateDir)) {
    const head = readDelta(transcript_path, 0).entries;
    const firstMsg = firstSubstantiveUserMessage(mapEntries(head));
    if (firstMsg) writeNorthStarIfAbsent(stateDir, firstMsg);
  }
}

try {
  main();
} catch (e) {
  /* never block the turn */
}
process.exit(0);
