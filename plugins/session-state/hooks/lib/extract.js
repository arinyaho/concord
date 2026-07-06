'use strict';
const { TAG_RE, MEANINGFUL_BASH_RE, NOISE_BASH_RE } = require('./config');

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
      const cmd = String(input.command || '').split('\n')[0].trim();
      if (cmd && MEANINGFUL_BASH_RE.test(cmd) && !NOISE_BASH_RE.test(cmd)) {
        facts.push(`ran: ${cmd}`);
      }
    } else if (item.name === 'TaskCreate' || item.name === 'TaskUpdate') {
      const title = input.title || input.task || input.description || '(task)';
      const status = input.status ? ` [${input.status}]` : '';
      facts.push(`task: ${title}${status}`);
    }
  }
  return facts;
}

// Rationale from tagged assistant-text lines.
function extractRationale(entries) {
  const decisions = [];
  const openLoops = [];
  const nexts = [];
  const resolved = [];
  for (const item of assistantItems(entries)) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
    for (const raw of item.text.split('\n')) {
      const m = raw.trim().match(TAG_RE);
      if (!m) continue;
      const body = m[2].trim();
      if (!body) continue;
      const tag = m[1].toUpperCase();
      if (tag === 'DECISION') decisions.push(body);
      else if (tag === 'OPEN-LOOP') openLoops.push(body);
      else if (tag === 'NEXT') nexts.push(body);
      else if (tag === 'RESOLVED') resolved.push(body);
    }
  }
  return { decisions, openLoops, nexts, resolved };
}

module.exports = { extractFacts, extractRationale };
