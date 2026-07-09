'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Intent-source fetch for case-3 intent-aware review. Mirrors dod-exec's config
// trust model: a project-authored command string the CLI runs, never the agent.
// ref/base reach the shell only via env (REVIEW_REF/REVIEW_BASE), never interpolated.

const CONFIG_FILENAME = 'review.config.json';
const KNOWN_TOP_KEYS = new Set(['dod', 'intent']);
const INTENT_MAX_BYTES = 256 * 1024;
const INTENT_TIMEOUT_MS = 60 * 1000;

// Reads review.config.json's `intent`. An ABSENT file or ABSENT `intent` key is
// benign -> null (opt-out; the loop stays diff-local, exactly as v0.5.0). A
// PRESENT-BUT-BROKEN config (unreadable/malformed, or `intent` not an object
// with a non-empty string command) fails closed -- reviewing without the intent
// the user configured would manufacture a false "design was reviewed" signal.
function loadIntentConfig(repoRoot, readFileFn = fs.readFileSync) {
  let raw;
  try {
    raw = readFileFn(path.join(repoRoot, CONFIG_FILENAME), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but unreadable: ${e && e.message ? e.message : e}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but malformed: ${e && e.message ? e.message : e}`);
  }
  if (!parsed || typeof parsed !== 'object') return null;
  for (const k of Object.keys(parsed)) {
    if (!KNOWN_TOP_KEYS.has(k)) {
      process.stderr.write(`review-cli: warning: unrecognized ${CONFIG_FILENAME} top-level key "${k}"\n`);
    }
  }
  if (parsed.intent === undefined) return null;
  const intent = parsed.intent;
  if (!intent || typeof intent !== 'object' || typeof intent.command !== 'string' || !intent.command.trim()) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} "intent" must be an object with a non-empty string "command"`);
  }
  return { command: intent.command };
}

module.exports = { CONFIG_FILENAME, INTENT_MAX_BYTES, INTENT_TIMEOUT_MS, loadIntentConfig };
