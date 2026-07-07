'use strict';
const { TAG_RE, MEANINGFUL_BASH_RE } = require('./config');

// Flatten the content items of every assistant entry in the delta.
function assistantItems(entries) {
  const out = [];
  for (const e of entries) {
    if (e && e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const item of e.message.content) out.push(item);
    }
  }
  return out;
}

// Facts from tool_use items: edited files, meaningful commands, task changes.
function extractFacts(entries) {
  const facts = [];
  for (const item of assistantItems(entries)) {
    if (!item || item.type !== 'tool_use') continue;
    const input = item.input || {};
    if (item.name === 'Edit' || item.name === 'Write') {
      if (input.file_path) facts.push(`edited ${input.file_path}`);
    } else if (item.name === 'Bash') {
      // Split on &&/||/;/| and test each segment's leading token against the
      // allowlist, so "cd dir && git commit" is captured but a VAR="...tool..."
      // assignment (tool name only inside the value) is not.
      const cmd = String(input.command || '').split('\n')[0].trim();
      const segments = cmd.split(/&&|\|\||[;|]/).map((s) => s.trim());
      if (cmd && segments.some((s) => MEANINGFUL_BASH_RE.test(s))) {
        facts.push(`ran: ${cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd}`);
      }
    } else if (item.name === 'TaskCreate' || item.name === 'TaskUpdate') {
      const title = input.title || input.task || input.description || '(task)';
      const status = input.status ? ` [${input.status}]` : '';
      facts.push(`task: ${title}${status}`);
    }
  }
  return facts;
}

// Harvest tagged lines from a text blob into an accumulator.
function harvestTags(text, acc) {
  for (const raw of String(text).split('\n')) {
    const m = raw.trim().match(TAG_RE);
    if (!m) continue;
    const body = m[2].trim();
    if (!body) continue;
    const tag = m[1].toUpperCase();
    if (tag === 'DECISION') acc.decisions.push(body);
    else if (tag === 'OPEN-LOOP') acc.openLoops.push(body);
    else if (tag === 'NEXT') acc.nexts.push(body);
    else if (tag === 'RESOLVED') acc.resolved.push(body);
  }
  return acc;
}

function emptyRationale() {
  return { decisions: [], openLoops: [], nexts: [], resolved: [] };
}

// Rationale from tagged lines across all assistant-text items in the delta.
function extractRationale(entries) {
  const acc = emptyRationale();
  for (const item of assistantItems(entries)) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
    harvestTags(item.text, acc);
  }
  return acc;
}

// Rationale from a single text blob, e.g. the Stop hook's last_assistant_message
// (captures the just-finished turn even if it has not flushed to the transcript).
function extractRationaleText(text) {
  const acc = emptyRationale();
  if (text) harvestTags(text, acc);
  return acc;
}

module.exports = { extractFacts, extractRationale, extractRationaleText };
