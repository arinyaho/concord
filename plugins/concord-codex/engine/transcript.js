'use strict';
const fs = require('node:fs');
// Dual-resolve: this file is vendored byte-identical into plugins/concord-codex/engine/
// (see bin/bundle.mjs + the drift-guard test), where `../../core/ports` would resolve to
// the wrong place (engine/ports.js is a sibling, not two levels up). Try the vendored
// sibling path first, fall back to the in-source relative path.
let normalizeEntry;
try {
  ({ normalizeEntry } = require('./ports'));
} catch (e) {
  ({ normalizeEntry } = require('../../core/ports'));
}

// Read new JSONL entries appended since `offset` bytes. Advances the offset only
// to the last complete line, so a partial line mid-write is re-read next time.
// Treats a file smaller than `offset` as rewritten and re-reads from 0.
// Copied verbatim from adapters/claude-code/transcript.js -- the byte-offset
// delta-reading logic is harness-agnostic, only the entry mapping below differs.
function readDelta(transcriptPath, offset) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (e) {
    return { entries: [], newOffset: offset };
  }
  const start = offset > stat.size ? 0 : offset;
  if (stat.size - start <= 0) return { entries: [], newOffset: stat.size };

  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { entries: [], newOffset: start };
    const complete = text.slice(0, lastNl + 1);
    const consumed = Buffer.byteLength(complete, 'utf8');
    const entries = [];
    for (const line of complete.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t));
      } catch (e) {
        /* skip malformed line */
      }
    }
    return { entries, newOffset: start + consumed };
  } finally {
    fs.closeSync(fd);
  }
}

// Codex rollout entry -> NeutralEntry. Only `type === 'response_item'` entries
// carry conversation content; everything else (session_meta, event_msg,
// reasoning, world_state, turn_context, custom_tool_call_output) is skipped.
function mapEntries(rawEntries) {
  const out = [];
  for (const e of rawEntries || []) {
    if (!e || e.type !== 'response_item') continue;
    const payload = e.payload;
    if (!payload) continue;

    if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
      let text = '';
      if (Array.isArray(payload.content)) {
        for (const item of payload.content) {
          if (!item) continue;
          if ((item.type === 'output_text' || item.type === 'input_text') && typeof item.text === 'string') {
            text += (text ? '\n' : '') + item.text;
          }
        }
      }
      out.push(normalizeEntry({ role: payload.role, text, toolCalls: [] }));
    } else if (payload.type === 'custom_tool_call' || payload.type === 'local_shell_call') {
      const name = payload.name || payload.type;
      const input = payload.input || payload.arguments || payload.action || {};
      out.push(normalizeEntry({ role: 'assistant', text: '', toolCalls: [{ name, input }] }));
    }
  }
  return out;
}

function parseDelta(transcriptPath, offset) {
  const { entries, newOffset } = readDelta(transcriptPath, offset);
  return { entries: mapEntries(entries), newOffset };
}

module.exports = { readDelta, mapEntries, parseDelta };
