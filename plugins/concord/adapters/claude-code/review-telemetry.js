'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { roleFromArtifactSuffix } = require('../../core/review-telemetry');

const ACTIVE_STATUSES = new Set(['converging', 'gate-panel-pending', 'intent-review']);
const TRANSCRIPT_VERSION = '2.1.268';
const TRANSCRIPT_SCHEMA = `claude-subagent-transcript-${TRANSCRIPT_VERSION}-v1`;
const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function activeLedger(stateDir, round, artifactPath) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return null; }
  const matches = [];
  for (const name of names) {
    if (/^review-(?:agent-)?telemetry-[0-9a-f]{64}\.json$/.test(name) || !/^review-.+\.json$/.test(name)) continue;
    try {
      const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
      const doingReviewWork = ledger.phase === 'gates' || ledger.phase === 'fixes' || ledger.status === 'gate-panel-pending';
      if ((round === undefined || ledger.round === round) && ACTIVE_STATUSES.has(ledger.status) && doingReviewWork && typeof ledger.target?.ref === 'string') matches.push(ledger);
    } catch {
      // Ignore unrelated or incomplete state files.
    }
  }
  if (round === undefined) return matches[0] || null;
  const slotted = artifactPath
    ? matches.filter((ledger) => (ledger.telemetrySlots || []).some((slot) => slot?.artifactPath === artifactPath))
    : [];
  return slotted.length === 1 ? slotted[0] : matches.length === 1 ? matches[0] : null;
}

function artifactFromPrompt(prompt, stateDir) {
  if (typeof prompt !== 'string') return null;
  const escaped = path.resolve(stateDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directive = new RegExp(`(?:\\bwrite\\s+ONLY\\b[\\s\\S]{0,1000}?\\bto|\\bwrite\\s+a\\s+JSON\\s+file\\s+to)\\s+[\`'"]?${escaped}[/\\\\](round-(\\d+)-([A-Za-z0-9:._-]+)\\.json)[\`'"]?`, 'gi');
  const matches = Array.from(prompt.matchAll(directive));
  if (matches.length !== 1) return null;
  const match = matches[0];
  const artifactPath = path.resolve(stateDir, match[1]);
  if (path.dirname(artifactPath) !== path.resolve(stateDir)) return null;
  const round = Number(match[2]);
  const ledger = activeLedger(stateDir, round, artifactPath);
  if (!ledger) return null;
  const suffix = match[3];
  return { round, role: roleFromArtifactSuffix(suffix), targetRef: ledger.target.ref, artifactPath };
}

function attemptFor(stateDir, artifactPath, invocationId, targetRef) {
  const digest = crypto.createHash('sha256').update(`tool:${invocationId}`).digest('hex');
  try {
    const existing = JSON.parse(fs.readFileSync(path.join(stateDir, `review-telemetry-${digest}.json`), 'utf8'));
    if (existing.targetRef === targetRef && existing.artifactPath === artifactPath && Number.isInteger(existing.attempt)) return existing.attempt;
  } catch {}
  const used = new Set();
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!/^review-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (record.targetRef === targetRef && record.artifactPath === artifactPath && Number.isInteger(record.attempt)) used.add(record.attempt);
      } catch {}
    }
  } catch {}
  try {
    const ledger = activeLedger(stateDir, Number(path.basename(artifactPath).match(/^round-(\d+)-/)?.[1]), artifactPath);
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
    attempt: attemptFor(stateDir, artifact.artifactPath, event.tool_use_id, artifact.targetRef),
    invocationId: event.tool_use_id,
    agentId: typeof response.agentId === 'string' ? response.agentId : null,
    parentTranscriptPath: typeof event.transcript_path === 'string' ? path.resolve(event.transcript_path) : null,
    requestedModel: typeof event.tool_input.model === 'string' ? event.tool_input.model : null,
    resolvedModel: typeof response.resolvedModel === 'string' ? response.resolvedModel : null,
    provider: 'anthropic',
    providerSchema: 'claude-agent-hook-v1',
    status: started ? 'started' : (failed ? 'failed' : (typeof response.status === 'string' ? response.status : 'completed')),
    ...(started ? { startedAtMs: Date.now() } : {}),
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

function emptyAgentRecord(agentId, parentTranscriptPath) {
  return {
    kind: 'agent-usage',
    engine: 'claude-code',
    agentId,
    parentTranscriptPath,
    observationId: crypto.randomUUID(),
    provider: 'anthropic',
    providerSchema: TRANSCRIPT_SCHEMA,
    status: 'stopped',
    stoppedAtMs: Date.now(),
    resolvedModel: null,
    inputTokens: null,
    cacheWriteInputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usagePartial: true,
    providerUsage: {},
  };
}

function hasUniqueTerminalSnapshot(text, agentId, lastAssistantMessage, lastAssistantMessageHash) {
  const rows = new Map(); let order = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { return false; }
    if (row?.type !== 'assistant' || row.agentId !== agentId) continue;
    const requestId = row.requestId; const messageId = row.message?.id; const content = row.message?.content;
    if (typeof requestId !== 'string' || typeof messageId !== 'string' || !Array.isArray(content)) return false;
    const textBlocks = content.filter((block) => block?.type === 'text');
    const terminal = content.length > 0 && !content.some((block) => block?.type === 'tool_use');
    const message = textBlocks.length > 0 && textBlocks.every((block) => typeof block.text === 'string') ? textBlocks.map((block) => block.text).join('') : null;
    const messageMatches = (typeof lastAssistantMessage !== 'string' || !lastAssistantMessage || message === lastAssistantMessage)
      && (typeof lastAssistantMessageHash !== 'string' || !lastAssistantMessageHash
        || (message !== null && crypto.createHash('sha256').update(message).digest('hex') === lastAssistantMessageHash));
    rows.set(`${requestId}\0${messageId}`, { terminal, messageMatches, order: order++ });
  }
  const values = [...rows.values()]; const terminals = values.filter((row) => row.terminal);
  return terminals.length === 1 && terminals[0].messageMatches && terminals[0].order === Math.max(...values.map((row) => row.order));
}

function resolvedAgentTranscriptPath(event) {
  if (typeof event.transcript_path !== 'string' || typeof event.agent_transcript_path !== 'string') return null;
  try {
    const parent = path.resolve(event.transcript_path);
    const expectedDirectory = fs.realpathSync(path.join(path.dirname(parent), path.basename(parent, '.jsonl'), 'subagents'));
    const transcriptPath = fs.realpathSync(event.agent_transcript_path);
    return path.dirname(transcriptPath) === expectedDirectory ? transcriptPath : null;
  } catch { return null; }
}

function artifactPathFromAgentTranscript(event, stateDir) {
  const transcriptPath = resolvedAgentTranscriptPath(event);
  if (!transcriptPath) return null;
  try {
    const row = JSON.parse(fs.readFileSync(transcriptPath, 'utf8').split('\n').find(Boolean));
    if (row?.type !== 'user' || row.agentId !== event.agent_id) return null;
    const content = row.message?.content;
    const prompt = typeof content === 'string' ? content
      : (Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('') : null);
    return artifactFromPrompt(prompt, stateDir)?.artifactPath || null;
  } catch { return null; }
}

function subagentRecord(event, pendingTool) {
  if (event.hook_event_name !== 'SubagentStop' || typeof event.agent_id !== 'string' || !event.agent_id) return null;
  const parentTranscriptPath = typeof event.transcript_path === 'string' ? path.resolve(event.transcript_path) : null;
  const partial = emptyAgentRecord(event.agent_id, parentTranscriptPath);
  const transcriptPath = resolvedAgentTranscriptPath(event);
  if (!transcriptPath) return partial;
  if (pendingTool) return {
    ...partial,
    pendingInvocationId: pendingTool.invocationId,
    pendingTargetRef: pendingTool.targetRef,
    agentTranscriptPath: transcriptPath,
    lastAssistantMessageHash: typeof event.last_assistant_message === 'string' && event.last_assistant_message
      ? crypto.createHash('sha256').update(event.last_assistant_message).digest('hex')
      : null,
  };

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
        && text.endsWith('\n') && identity === previousIdentity
        && hasUniqueTerminalSnapshot(text, event.agent_id, event.last_assistant_message, event.last_assistant_message_hash)) {
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
  const unsupportedVersions = new Set();
  let invalid = !(typeof event.last_assistant_message === 'string' && event.last_assistant_message)
    && !(typeof event.last_assistant_message_hash === 'string' && event.last_assistant_message_hash);
  let order = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { invalid = true; continue; }
    if (row?.type !== 'assistant' || !row.message?.usage) continue;
    const requestId = typeof row.requestId === 'string' && row.requestId ? row.requestId : null;
    const messageId = typeof row.message.id === 'string' && row.message.id ? row.message.id : null;
    const model = typeof row.message.model === 'string' && row.message.model ? row.message.model : null;
    const usage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, nonnegativeInteger(row.message.usage[field])]));
    if (row.version !== TRANSCRIPT_VERSION) unsupportedVersions.add(typeof row.version === 'string' && row.version ? row.version : 'unknown');
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
    const requestKey = `${requestId}\0${messageId}`;
    const finalUsage = terminal || (typeof row.message.stop_reason === 'string' && !!row.message.stop_reason);
    if (!finalUsage) continue;
    const previous = requests.get(requestKey);
    if (previous && (previous.model !== model || USAGE_FIELDS.some((field) => usage[field] < previous.usage[field]))) invalid = true;
    requests.set(requestKey, { model, usage, terminal, order: order++ });
  }
  const unsupported = unsupportedVersions.size ? {
    usageStatus: 'unsupported-cli-version', cliVersion: Array.from(unsupportedVersions).sort().join(','),
  } : {};
  if (!requests.size) return { ...partial, ...unsupported };

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
    ...unsupported,
    providerUsage: totals,
    finalRequestUsage: terminalRows.length === 1 ? terminalRows[0].usage : null,
    transcriptWaitMs: waitMs,
  };
}

function recordForEvent(event, stateDir) {
  if (!event || typeof event !== 'object') return null;
  if (event.hook_event_name !== 'SubagentStop') return toolRecord(event, stateDir);
  if (!activeLedger(stateDir)) return null;
  const probe = {
    agentId: event.agent_id,
    parentTranscriptPath: typeof event.transcript_path === 'string' ? path.resolve(event.transcript_path) : null,
    artifactPath: artifactPathFromAgentTranscript(event, stateDir),
  };
  const tool = activeReviewTool(stateDir, probe);
  return tool ? subagentRecord(event, tool.agentId === null ? tool : null) : null;
}

function activeReviewTool(stateDir, record) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return null; }
  let exact = null;
  const pending = [];
  for (const name of names) {
    if (!/^review-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
    try {
      const tool = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
      const sameParent = typeof record.parentTranscriptPath === 'string' && tool.parentTranscriptPath === record.parentTranscriptPath;
      const matchingAgent = tool.agentId === record.agentId;
      const pendingAgent = tool.status === 'started' && tool.agentId === null
        && (!record.pendingInvocationId || tool.invocationId === record.pendingInvocationId)
        && (!record.artifactPath || tool.artifactPath === record.artifactPath);
      if (!sameParent || (!matchingAgent && !pendingAgent) || activeLedger(stateDir, tool.round, tool.artifactPath)?.target.ref !== tool.targetRef) continue;
      if (matchingAgent) exact = tool;
      else pending.push(tool);
    } catch {}
  }
  return exact || (pending.length === 1 ? pending[0] : null);
}

function settlePendingAgentRecords(stateDir, tool) {
  if (tool.kind !== 'tool-use' || tool.status === 'started' || typeof tool.agentId !== 'string') return;
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return; }
  for (const name of names) {
    if (!/^review-agent-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
    const file = path.join(stateDir, name);
    let temporary;
    try {
      const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pending.pendingInvocationId !== tool.invocationId) continue;
      if (pending.agentId !== tool.agentId) {
        fs.unlinkSync(file);
        continue;
      }
      const parsed = subagentRecord({
        hook_event_name: 'SubagentStop',
        transcript_path: pending.parentTranscriptPath,
        agent_id: pending.agentId,
        agent_transcript_path: pending.agentTranscriptPath,
        last_assistant_message_hash: pending.lastAssistantMessageHash,
      });
      temporary = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ ...parsed, observationId: pending.observationId }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {
      // Preserve malformed evidence for operator inspection.
    } finally { if (temporary) try { fs.unlinkSync(temporary); } catch {} }
  }
}

function writeRecord(stateDir, record) {
  if (!record) return false;
  const activeTool = record.kind === 'agent-usage' ? activeReviewTool(stateDir, record) : null;
  if (record.kind === 'agent-usage' && !activeTool) return false;
  fs.mkdirSync(stateDir, { recursive: true });
  const identity = record.kind === 'agent-usage' ? `agent:${record.agentId}:${record.observationId}` : `tool:${record.invocationId}`;
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  const prefix = record.kind === 'agent-usage' ? 'review-agent-telemetry' : 'review-telemetry';
  const destination = path.join(stateDir, `${prefix}-${digest}.json`);
  const temporary = path.join(stateDir, `.${prefix}-${digest}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temporary, destination);
    settlePendingAgentRecords(stateDir, activeTool || record);
    return true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    try {
      const existing = JSON.parse(fs.readFileSync(destination, 'utf8'));
      if ((existing.status === 'started' && record.status !== 'started') || (existing.usagePartial && !record.usagePartial)) {
        const replacement = existing.status === 'started' && nonnegativeInteger(existing.startedAtMs) !== null
          ? { ...record, startedAtMs: existing.startedAtMs }
          : record;
        fs.writeFileSync(temporary, JSON.stringify(existing.duplicateEvidence ? { ...replacement, duplicateEvidence: true, usagePartial: true } : replacement));
        fs.renameSync(temporary, destination);
        settlePendingAgentRecords(stateDir, activeTool || record);
        return true;
      }
      if (record.kind === 'tool-use') {
        fs.writeFileSync(temporary, JSON.stringify({ ...existing, duplicateEvidence: true, usagePartial: true }));
        fs.renameSync(temporary, destination);
        settlePendingAgentRecords(stateDir, activeTool || record);
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
