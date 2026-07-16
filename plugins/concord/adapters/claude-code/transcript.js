'use strict';
const fs = require('node:fs');
const { normalizeEntry } = require('../../core/ports');

// Read new JSONL entries appended since `offset` bytes. Advances the offset only
// to the last complete line, so a partial line mid-write is re-read next time.
// Treats a file smaller than `offset` as rewritten and re-reads from 0.
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

// Claude Code transcript entry -> NeutralEntry. Concatenates text items,
// collects tool_use items as toolCalls. Entries without a message are dropped.
function mapEntries(rawEntries) {
  const out = [];
  for (const e of rawEntries || []) {
    const msg = e && e.message;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    let text = '';
    const toolCalls = [];
    for (const item of content) {
      if (!item) continue;
      if (item.type === 'text' && typeof item.text === 'string') text += (text ? '\n' : '') + item.text;
      else if (item.type === 'tool_use') toolCalls.push({ name: item.name, input: item.input || {} });
    }
    out.push(normalizeEntry({ role: msg.role, text, toolCalls }));
  }
  return out;
}

function parseDelta(transcriptPath, offset) {
  const { entries, newOffset } = readDelta(transcriptPath, offset);
  return { entries: mapEntries(entries), newOffset };
}

module.exports = { readDelta, mapEntries, parseDelta };
