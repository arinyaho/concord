'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE_STATUSES = new Set(['converging', 'gate-panel-pending', 'intent-review']);
const TRANSCRIPT_VERSION = '2.1.268';
const TRANSCRIPT_SCHEMA = `claude-subagent-transcript-${TRANSCRIPT_VERSION}-v1`;
const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function activeLedger(stateDir, round) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return null; }
  const matches = [];
  for (const name of names) {
    if (!/^review-(?!telemetry-).+\.json$/.test(name)) continue;
    try {
      const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
      const doingReviewWork = ledger.phase === 'gates' || ledger.phase === 'fixes' || ledger.status === 'gate-panel-pending';
      if (ledger.round === round && ACTIVE_STATUSES.has(ledger.status) && doingReviewWork && typeof ledger.target?.ref === 'string') matches.push(ledger);
    } catch {
      // Ignore unrelated or incomplete state files.
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function artifactFromPrompt(prompt, stateDir) {
  if (typeof prompt !== 'string') return null;
  const escaped = path.resolve(stateDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directive = new RegExp(`(?:\\bwrite\\s+ONLY\\b[\\s\\S]{0,1000}?\\bto|\\bwrite\\s+a\\s+JSON\\s+file\\s+to)\\s+${escaped}[/\\\\](round-(\\d+)-([A-Za-z0-9:._-]+)\\.json)`, 'gi');
  const matches = Array.from(prompt.matchAll(directive));
  if (matches.length !== 1) return null;
  const match = matches[0];
  const artifactPath = path.resolve(stateDir, match[1]);
  if (path.dirname(artifactPath) !== path.resolve(stateDir)) return null;
  const round = Number(match[2]);
  const ledger = activeLedger(stateDir, round);
  if (!ledger) return null;
  const suffix = match[3];
  return { round, role: suffix.startsWith('fix-') ? 'fix' : suffix, targetRef: ledger.target.ref, artifactPath };
}

function attemptFor(stateDir, artifactPath, invocationId) {
  const digest = crypto.createHash('sha256').update(`tool:${invocationId}`).digest('hex');
  try {
    const existing = JSON.parse(fs.readFileSync(path.join(stateDir, `review-telemetry-${digest}.json`), 'utf8'));
    if (existing.artifactPath === artifactPath && Number.isInteger(existing.attempt)) return existing.attempt;
  } catch {}
  const used = new Set();
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!/^review-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (record.artifactPath === artifactPath && Number.isInteger(record.attempt)) used.add(record.attempt);
      } catch {}
    }
  } catch {}
  try {
    const ledger = activeLedger(stateDir, Number(path.basename(artifactPath).match(/^round-(\d+)-/)?.[1]));
    return (ledger?.telemetrySlots || []).find((slot) => slot.artifactPath === artifactPath && !used.has(slot.attempt))?.attempt || null;
  } catch { return null; }
}

function toolRecord(event, stateDir) {
  if (!['Agent', 'Task'].includes(event.tool_name)) return null;
  if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)) return null;
  if (typeof event.tool_use_id !== 'string' || !event.tool_use_id) return null;
  const artifact = artifactFromPrompt(event.tool_input && event.tool_input.prompt, stateDir);
  if (!artifact) return null;

  const started = event.hook_event_name === 'PreToolUse';
  const response = event.tool_response && typeof event.tool_response === 'object' ? event.tool_response : {};
  const usage = response.usage && typeof response.usage === 'object' ? response.usage : {};
  const values = Object.fromEntries(USAGE_FIELDS.map((field) => [field, nonnegativeInteger(usage[field])]));
  const totalTokens = nonnegativeInteger(response.totalTokens);
  const failed = event.hook_event_name === 'PostToolUseFailure';
  const hookUsagePartial = started || failed || Object.values(values).includes(null) || totalTokens === null
    || totalTokens !== Object.values(values).reduce((sum, value) => sum + value, 0);

  return {
    kind: 'tool-use',
    engine: 'claude-code',
    targetRef: artifact.targetRef,
    role: artifact.role,
    round: artifact.round,
    artifactPath: artifact.artifactPath,
    attempt: attemptFor(stateDir, artifact.artifactPath, event.tool_use_id),
    invocationId: event.tool_use_id,
    agentId: typeof response.agentId === 'string' ? response.agentId : null,
    requestedModel: typeof event.tool_input.model === 'string' ? event.tool_input.model : null,
    resolvedModel: typeof response.resolvedModel === 'string' ? response.resolvedModel : null,
    provider: 'anthropic',
    providerSchema: 'claude-agent-hook-v1',
    status: started ? 'started' : (failed ? 'failed' : (typeof response.status === 'string' ? response.status : 'completed')),
    elapsedMs: nonnegativeInteger(failed ? event.duration_ms : response.totalDurationMs),
    inputTokens: values.input_tokens,
    cacheWriteInputTokens: values.cache_creation_input_tokens,
    cachedInputTokens: values.cache_read_input_tokens,
    reasoningOutputTokens: null,
    outputTokens: values.output_tokens,
    totalTokens,
    usagePartial: true,
    hookUsagePartial,
    providerUsage: Object.fromEntries(Object.entries(usage).filter(([, value]) => nonnegativeInteger(value) !== null)),
  };
}

function emptyAgentRecord(agentId) {
  return {
    kind: 'agent-usage',
    engine: 'claude-code',
    agentId,
    observationId: crypto.randomUUID(),
    provider: 'anthropic',
    providerSchema: TRANSCRIPT_SCHEMA,
    status: 'stopped',
    resolvedModel: null,
    inputTokens: null,
    cacheWriteInputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usagePartial: true,
    providerUsage: {},
    lastRequestUsage: null,
  };
}

function hasUniqueTerminalSnapshot(text, agentId) {
  const rows = new Map(); let order = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { return false; }
    if (row?.type !== 'assistant' || row.agentId !== agentId) continue;
    const requestId = row.requestId; const messageId = row.message?.id; const content = row.message?.content;
    if (typeof requestId !== 'string' || typeof messageId !== 'string' || !Array.isArray(content)) return false;
    rows.set(`${requestId}\0${messageId}`, { terminal: content.length > 0 && !content.some((block) => block?.type === 'tool_use'), order: order++ });
  }
  const values = [...rows.values()]; const terminals = values.filter((row) => row.terminal);
  return terminals.length === 1 && terminals[0].order === Math.max(...values.map((row) => row.order));
}

function subagentRecord(event) {
  if (event.hook_event_name !== 'SubagentStop' || typeof event.agent_id !== 'string' || !event.agent_id) return null;
  const partial = emptyAgentRecord(event.agent_id);
  if (typeof event.transcript_path !== 'string' || typeof event.agent_transcript_path !== 'string') return partial;
  let expectedDirectory;
  let transcriptPath;
  try {
    expectedDirectory = fs.realpathSync(path.join(path.dirname(path.resolve(event.transcript_path)), 'subagents'));
    transcriptPath = fs.realpathSync(event.agent_transcript_path);
  } catch { return partial; }
  if (path.dirname(transcriptPath) !== expectedDirectory) return partial;

  let snapshot;
  const waitMs = 500;
  const deadline = Date.now() + waitMs;
  let previousIdentity = null;
  while (Date.now() <= deadline) {
    try {
      const before = fs.statSync(transcriptPath);
      const text = fs.readFileSync(transcriptPath, 'utf8');
      const after = fs.statSync(transcriptPath);
      const identity = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}`;
      if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs
        && text.endsWith('\n') && identity === previousIdentity && hasUniqueTerminalSnapshot(text, event.agent_id)) {
        snapshot = text;
        break;
      }
      previousIdentity = identity;
    } catch { return { ...partial, transcriptWaitMs: waitMs }; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (snapshot === undefined) return { ...partial, transcriptWaitMs: waitMs };
  const lines = snapshot.split('\n').filter(Boolean);
  const requests = new Map();
  const requestToMessage = new Map();
  const messageToRequest = new Map();
  let lastRequestUsage = null;
  let invalid = false;
  let order = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { invalid = true; continue; }
    if (row?.type !== 'assistant' || !row.message?.usage) continue;
    const requestId = typeof row.requestId === 'string' && row.requestId ? row.requestId : null;
    const messageId = typeof row.message.id === 'string' && row.message.id ? row.message.id : null;
    const model = typeof row.message.model === 'string' && row.message.model ? row.message.model : null;
    const usage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, nonnegativeInteger(row.message.usage[field])]));
    if (!requestId || !messageId || !model || row.version !== TRANSCRIPT_VERSION || row.agentId !== event.agent_id || Object.values(usage).includes(null)) {
      invalid = true;
      continue;
    }
    if ((requestToMessage.has(requestId) && requestToMessage.get(requestId) !== messageId)
      || (messageToRequest.has(messageId) && messageToRequest.get(messageId) !== requestId)) invalid = true;
    requestToMessage.set(requestId, messageId);
    messageToRequest.set(messageId, requestId);
    const content = Array.isArray(row.message.content) ? row.message.content : null;
    const terminal = !!content && content.length > 0 && !content.some((block) => block?.type === 'tool_use');
    if (!content) invalid = true;
    requests.set(`${requestId}\0${messageId}`, { model, usage, terminal, order: order++ });
    lastRequestUsage = usage;
  }
  if (!requests.size) return partial;

  const models = new Set();
  const totals = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
  const terminalRows = [];
  for (const request of requests.values()) {
    const { model, usage } = request;
    models.add(model);
    for (const field of USAGE_FIELDS) totals[field] += usage[field];
    if (request.terminal) terminalRows.push(request);
  }
  const lastOrder = Math.max(...Array.from(requests.values(), (request) => request.order));
  if (terminalRows.length !== 1 || terminalRows[0].order !== lastOrder) invalid = true;
  return {
    ...partial,
    resolvedModel: models.size === 1 ? Array.from(models)[0] : null,
    inputTokens: totals.input_tokens,
    cacheWriteInputTokens: totals.cache_creation_input_tokens,
    cachedInputTokens: totals.cache_read_input_tokens,
    outputTokens: totals.output_tokens,
    totalTokens: Object.values(totals).reduce((sum, value) => sum + value, 0),
    usagePartial: invalid || models.size !== 1,
    providerUsage: totals,
    lastRequestUsage,
    transcriptWaitMs: waitMs,
  };
}

function recordForEvent(event, stateDir) {
  if (!event || typeof event !== 'object') return null;
  return event.hook_event_name === 'SubagentStop' ? subagentRecord(event) : toolRecord(event, stateDir);
}

function writeRecord(stateDir, record) {
  if (!record) return false;
  fs.mkdirSync(stateDir, { recursive: true });
  const identity = record.kind === 'agent-usage' ? `agent:${record.agentId}:${record.observationId}` : `tool:${record.invocationId}`;
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  const prefix = record.kind === 'agent-usage' ? 'review-agent-telemetry' : 'review-telemetry';
  const destination = path.join(stateDir, `${prefix}-${digest}.json`);
  const temporary = path.join(stateDir, `.${prefix}-${digest}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temporary, destination);
    return true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    try {
      const existing = JSON.parse(fs.readFileSync(destination, 'utf8'));
      if ((existing.status === 'started' && record.status !== 'started') || (existing.usagePartial && !record.usagePartial)) {
        if (existing.duplicateEvidence) fs.writeFileSync(temporary, JSON.stringify({ ...record, duplicateEvidence: true, usagePartial: true }));
        fs.renameSync(temporary, destination);
        return true;
      }
      if (record.kind === 'tool-use') {
        fs.writeFileSync(temporary, JSON.stringify({ ...existing, duplicateEvidence: true, usagePartial: true }));
        fs.renameSync(temporary, destination);
      }
    } catch {
      // Preserve malformed evidence for operator inspection.
    }
    return false;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

module.exports = { artifactFromPrompt, recordForEvent, writeRecord };
