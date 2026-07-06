#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readDelta } = require('./lib/transcript');
const { extractFacts, extractRationale } = require('./lib/extract');
const { emptyModel, mergeModel, renderMarkdown } = require('./lib/state');

function main() {
  const { session_id, transcript_path } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!session_id || !transcript_path) return;

  const stateDir = path.join(path.dirname(transcript_path), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonPath = path.join(stateDir, `${session_id}.json`);
  const mdPath = path.join(stateDir, `${session_id}.md`);
  const latestPath = path.join(stateDir, '_latest.md');

  let model = emptyModel();
  try {
    model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    /* first run for this session */
  }

  const { entries, newOffset } = readDelta(transcript_path, model.offset || 0);
  if (entries.length) {
    const facts = extractFacts(entries);
    const rationale = extractRationale(entries);
    model = mergeModel(model, { ...rationale, facts });
  }
  model.offset = newOffset;

  fs.writeFileSync(jsonPath, JSON.stringify(model));
  const md = renderMarkdown(session_id, model);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(latestPath, md);
}

try {
  main();
} catch (e) {
  /* never block the turn */
}
process.exit(0);
