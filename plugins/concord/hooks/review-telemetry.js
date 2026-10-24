#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const telemetry = require('../adapters/claude-code/review-telemetry');
const { resolveStateDirFromTranscript } = require('../adapters/claude-code/statedir');

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const override = process.env.REVIEW_STATE_DIR;
  const trusted = override && override.trim() ? override : resolveStateDirFromTranscript(event.transcript_path || '');
  const prompt = telemetry.promptForEvent(event);
  const stateDir = telemetry.stateDirForPrompt(prompt, trusted);
  const record = telemetry.recordForEvent(event, stateDir, prompt);
  if (record) telemetry.writeRecord(stateDir, record);
} catch {
  // Telemetry is observational and must never block the tool result.
}
process.exit(0);
