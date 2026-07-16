'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { NORTH_STAR_MAX, MIN_MSG_LEN, SESSIONS_MERGE_CAP, ACTIVE_SKIP_MINUTES } = require('./config');
const { emptyModel, mergeModel } = require('./state');
const { readDelta, mapEntries } = require('../../adapters/claude-code/transcript');
const { extractFacts, extractRationale } = require('../../core/extract');

function charterPath(stateDir) {
  return path.join(stateDir, 'charter.md');
}

// Returns the north-star text, or null if the file is absent/empty.
function readNorthStar(stateDir) {
  try {
    const t = fs.readFileSync(charterPath(stateDir), 'utf8').trim();
    return t ? t : null;
  } catch (e) {
    return null;
  }
}

// Write the draft with an atomic create-exclusive open (flag 'wx'): if charter.md
// does not exist, exactly one parallel fresh session wins the create and the rest
// get EEXIST -> false. This closes the cross-process TOCTOU a read-then-write leaves
// open. If the file exists but is empty/whitespace (a degenerate state — this
// function never writes an empty body), treat it as absent and overwrite.
function writeNorthStarIfAbsent(stateDir, text) {
  const body = String(text || '').trim();
  if (!body) return false;
  fs.mkdirSync(stateDir, { recursive: true });
  const capped = body.slice(0, NORTH_STAR_MAX);
  try {
    fs.writeFileSync(charterPath(stateDir), capped, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
    if (readNorthStar(stateDir) === null) {
      fs.writeFileSync(charterPath(stateDir), capped);
      return true;
    }
    return false;
  }
}

// Deliberate overwrite (from the /charter command). LWW is safe here: rare, user-driven.
function setNorthStar(stateDir, text) {
  const body = String(text || '').trim();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(charterPath(stateDir), body.slice(0, NORTH_STAR_MAX));
}

// Substrings/prefixes that mark harness-injected or tooling text, not user framing.
// Harness-fragile by nature: extend as new injection wrappers appear.
const BOILERPLATE = [
  'base directory for this skill',
  'caveat:',
  'plugins/cache',
  'sessionstart',
  'userpromptsubmit hook',
  'local-command',
  'caveman mode',
  '<system-reminder',
  '<command-',
  '<local-command',
];

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function isBoilerplate(text) {
  const low = text.trim().toLowerCase();
  if (low.startsWith('<')) return true;
  return BOILERPLATE.some((p) => low.includes(p));
}

// The first user message that is real framing, not harness/tooling boilerplate.
function firstSubstantiveUserMessage(entries) {
  for (const e of entries) {
    const msg = (e && e.message) || {};
    if (msg.role !== 'user') continue;
    const text = messageText(msg.content).trim();
    if (text.length < MIN_MSG_LEN) continue;
    if (isBoilerplate(text)) continue;
    return text;
  }
  return null;
}

// List `<sid>.json` session model files, most-recent first, capped.
function sessionModelFiles(stateDir, cap) {
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch (e) {
    return [];
  }
  const files = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      const p = path.join(stateDir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch (e) {
        /* ignore */
      }
      return { sid: n.slice(0, -5), path: p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, cap);
}

// Union the most-recent sessions' models into one, reusing mergeModel's dedup/cap/topic
// logic. Fold oldest-first so the newest session wins per topic.
function mergeSessions(stateDir, { excludeSid } = {}) {
  const files = sessionModelFiles(stateDir, SESSIONS_MERGE_CAP)
    .filter((f) => f.sid !== excludeSid)
    .reverse(); // oldest first
  let acc = emptyModel();
  for (const f of files) {
    let sm;
    try {
      sm = JSON.parse(fs.readFileSync(f.path, 'utf8'));
    } catch (e) {
      continue;
    }
    acc = mergeModel(acc, {
      openLoops: sm.openLoops || [],
      decisions: sm.decisions || [],
      nexts: sm.nexts || [],
      resolved: [],
      facts: sm.facts || [],
    });
  }
  return acc;
}

function section(title, items) {
  if (!items || items.length === 0) return '';
  return [`## ${title}`, ...items.map((x) => `- ${x}`), ''].join('\n');
}

// The charter view: the north-star framing plus the merged cross-session rationale.
// Facts (activity) are deliberately excluded — the charter carries intent, not log.
function renderCharter(northStar, model) {
  const parts = ['# Task charter', ''];
  parts.push(northStar ? `**North star:** ${northStar}` : '_No north star set — use `/charter set` to pin the task framing._');
  parts.push('');
  const secs = [
    section('Open loops', model.openLoops),
    section('Decisions', model.decisions),
    section('Next', model.nexts),
  ].filter(Boolean);
  return parts.concat(secs).join('\n').trimEnd() + '\n';
}

// Re-process any session whose model watermark lags its transcript (e.g. a session
// abandoned before its Stop hook flushed the final turn). Skips the current session
// and any transcript touched within ACTIVE_SKIP_MINUTES to avoid racing a live writer.
function catchUpSessions(stateDir, { currentSid, now = Date.now() } = {}) {
  const projDir = path.dirname(stateDir);
  const activeCutoff = now - ACTIVE_SKIP_MINUTES * 60 * 1000;
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch (e) {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const sid = n.slice(0, -5);
    if (sid === currentSid) continue;
    const tpath = path.join(projDir, `${sid}.jsonl`);
    let tstat;
    try {
      tstat = fs.statSync(tpath);
    } catch (e) {
      continue; // no transcript for this model
    }
    if (tstat.mtimeMs > activeCutoff) continue; // likely live

    const jsonPath = path.join(stateDir, n);
    let model;
    try {
      model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      continue;
    }
    if ((model.offset || 0) >= tstat.size) continue; // already caught up

    try {
      const { entries, newOffset } = readDelta(tpath, model.offset || 0);
      if (entries.length === 0) continue;
      // extract.js now consumes NeutralEntry[]; readDelta still returns raw Claude
      // JSONL objects, so map them through the adapter first. (Interim: Task 4
      // moves this file to core and pushes transcript reading to the caller.)
      const neutralEntries = mapEntries(entries);
      const facts = extractFacts(neutralEntries);
      const rationale = extractRationale(neutralEntries);
      const merged = mergeModel(model, { ...rationale, facts });
      merged.offset = newOffset;
      fs.writeFileSync(jsonPath, JSON.stringify(merged));
    } catch (e) {
      // One malformed model or transient IO must not abort the whole scan —
      // skip this session and keep catching up the rest.
      continue;
    }
  }
}

module.exports = {
  charterPath,
  readNorthStar,
  writeNorthStarIfAbsent,
  setNorthStar,
  firstSubstantiveUserMessage,
  mergeSessions,
  renderCharter,
  catchUpSessions,
};
