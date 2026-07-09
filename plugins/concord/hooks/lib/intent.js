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

// Real exec: shell so a composed "cat a && cmd b" works; timeout because intent
// sources are network/auth-bound (gh, tracker CLIs) unlike local DoD tests -- a
// blocked fetch must not hang round-start with no terminus.
function intentExecFn(cmd, cwd, env) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: INTENT_TIMEOUT_MS, env });
  if (r.error && r.error.code === 'ETIMEDOUT') return { status: 124, stdout: r.stdout, stderr: 'intent fetch timed out' };
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout, stderr: r.stderr };
}

// Fetch the intent blob, fail-closed on substance not just transport. ref/base
// go through the child ENV (REVIEW_REF/REVIEW_BASE), never string-interpolated
// into `command` -- on an untrusted PR the branch name is contributor-controlled
// and interpolation would be a command-injection primitive.
function fetchIntent({ command, cwd, ref, base, execFn = intentExecFn }) {
  const env = { ...process.env, REVIEW_REF: ref == null ? '' : String(ref), REVIEW_BASE: base == null ? '' : String(base) };
  const { status, stdout } = execFn(command, cwd, env);
  if (status !== 0) throw new Error(`harness-failure: intent fetch command exited ${status}`);
  const text = String(stdout == null ? '' : stdout);
  if (text.trim() === '') throw new Error('harness-failure: intent fetch produced empty output');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > INTENT_MAX_BYTES) throw new Error(`harness-failure: intent output ${bytes} bytes exceeds cap ${INTENT_MAX_BYTES}`);
  const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return { text, sha, bytes };
}

module.exports = { CONFIG_FILENAME, INTENT_MAX_BYTES, INTENT_TIMEOUT_MS, loadIntentConfig, intentExecFn, fetchIntent };
