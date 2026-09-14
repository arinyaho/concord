#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const telemetry = require('../adapters/claude-code/review-telemetry');

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const stateDir = path.join(path.dirname(String(event.transcript_path || '')), 'state');
  const record = telemetry.recordForEvent(event, stateDir);
  if (record) telemetry.writeRecord(stateDir, record);
} catch {
  // Telemetry is observational and must never block the tool result.
}
process.exit(0);
