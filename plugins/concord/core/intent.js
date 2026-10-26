'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const crossPlatform = require('./spawn-cross-platform');

// Intent-source fetch for case-3 intent-aware review. Mirrors dod-exec's config
// trust model: a project-authored command string the CLI runs, never the agent.
// ref/base reach the shell only via env (REVIEW_REF/REVIEW_BASE), never interpolated.

const CONFIG_FILENAME = 'review.config.json';
const KNOWN_TOP_KEYS = new Set(['dod', 'intent', 'gate']);
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

// Read the intent from a file the caller supplied (round-start --intent-file),
// for a caller that already holds the requirements -- a CI reviewer passing a
// pull request's body -- rather than a repository-configured command. Same
// substance checks as fetchIntent: unreadable, empty, or oversized fails closed.
function readIntentFile(file, readFileFn = fs.readFileSync) {
  let text;
  try { text = String(readFileFn(file, 'utf8')); } catch (e) {
    throw new Error(`harness-failure: intent file ${file} is unreadable: ${e && e.message ? e.message : e}`);
  }
  if (text.trim() === '') throw new Error(`harness-failure: intent file ${file} is empty`);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > INTENT_MAX_BYTES) throw new Error(`harness-failure: intent file ${bytes} bytes exceeds cap ${INTENT_MAX_BYTES}`);
  return { text, sha: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), bytes };
}

function committedGit(repoRoot, args, options = {}) {
  const command = crossPlatform.crossPlatformCommand('git', repoRoot);
  const escapeShimArgs = crossPlatform.needsDoubleEscape('git', repoRoot);
  return execFileSync(command, crossPlatform.crossPlatformArgs(args, escapeShimArgs), crossPlatform.crossPlatformOpts({
    cwd: repoRoot,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer || INTENT_MAX_BYTES + 1,
    timeout: INTENT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

// Read an immutable Git blob at an explicitly reviewed commit. This never
// consults the index or worktree, so dirty and missing working files are safe.
function readCommittedIntent({ repoRoot, path: relativePath, head }) {
  try {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0') || relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
      throw new Error('invalid relative path');
    }
    const parts = relativePath.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('invalid relative path');
    if (typeof head !== 'string' || !head.trim()) throw new Error('missing commit');

    const commit = String(committedGit(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`], { encoding: 'utf8' })).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) throw new Error('invalid resolved commit');

    const listing = committedGit(repoRoot, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', relativePath]);
    const entries = listing.toString('utf8').split('\0').filter(Boolean);
    if (entries.length !== 1) throw new Error('committed path not found');
    const tab = entries[0].indexOf('\t');
    if (tab < 0 || entries[0].slice(tab + 1) !== relativePath) throw new Error('committed path not found');
    const [mode, type, blob] = entries[0].slice(0, tab).split(' ');
    if ((mode !== '100644' && mode !== '100755') || type !== 'blob' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(blob || '')) {
      throw new Error('committed path is not a regular file');
    }
    const bytesBuffer = committedGit(repoRoot, ['cat-file', 'blob', blob], { maxBuffer: INTENT_MAX_BYTES + 1 });
    if (bytesBuffer.length > INTENT_MAX_BYTES) throw new Error(`intent blob exceeds cap ${INTENT_MAX_BYTES}`);
    const text = bytesBuffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytesBuffer)) throw new Error('intent blob is not valid UTF-8 text');
    if (text.trim() === '') throw new Error('intent blob is empty');
    return {
      text,
      sha: crypto.createHash('sha256').update(bytesBuffer).digest('hex'),
      bytes: bytesBuffer.length,
      source: { kind: 'committed-file', path: relativePath, commit, blob },
    };
  } catch (e) {
    if (e && typeof e.message === 'string' && e.message.startsWith('harness-failure:')) throw e;
    throw new Error(`harness-failure: committed intent is unavailable or invalid: ${e && e.message ? e.message : e}`);
  }
}

module.exports = { CONFIG_FILENAME, INTENT_MAX_BYTES, INTENT_TIMEOUT_MS, loadIntentConfig, intentExecFn, fetchIntent, readIntentFile, readCommittedIntent };
