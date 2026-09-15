'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SUM_FIELDS = ['elapsedMs', 'inputTokens', 'cacheWriteInputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'outputTokens', 'totalTokens'];
const HOOK_USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

function summary(entries) {
  const result = { calls: entries.length, partialCalls: entries.filter((entry) => entry.usagePartial).length };
  const unsupported = entries.filter((entry) => entry.usageStatus === 'unsupported-cli-version');
  if (unsupported.length) {
    result.unsupportedCliVersionCalls = unsupported.length;
    result.unsupportedCliVersions = Array.from(new Set(unsupported.map((entry) => entry.cliVersion).filter(Boolean))).sort();
  }
  for (const field of SUM_FIELDS) {
    const values = entries.map((entry) => entry[field]).filter((value) => Number.isSafeInteger(value) && value >= 0);
    result[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return result;
}

function aggregate(entries) {
  const byRole = {};
  for (const role of new Set(entries.map((entry) => entry.role))) byRole[role] = summary(entries.filter((entry) => entry.role === role));
  const engines = new Set(entries.map((entry) => entry.engine));
  return { engine: engines.size === 1 ? entries[0].engine : 'mixed', ...summary(entries), byRole, entries };
}

function roleFromArtifactSuffix(suffix) {
  if (suffix.startsWith('fix-')) return 'fix';
  const panel = /^gate-panel-\d+-(.+)$/.exec(suffix);
  if (!panel) return suffix;
  return panel[1].startsWith('vote-') ? 'gate-panel-verify' : `gate-panel-${panel[1]}`;
}

function publicToolRecord(tool) {
  const { kind, hookUsagePartial, parentTranscriptPath, startedAtMs, ...record } = tool;
  return record;
}

function agentAssociation(record) {
  return typeof record?.agentId === 'string' && typeof record.parentTranscriptPath === 'string'
    ? JSON.stringify([record.agentId, record.parentTranscriptPath])
    : null;
}

function joinAgentUsage(tool, agent) {
  const output = publicToolRecord(tool);
  if (!agent || tool.status === 'failed') return { ...output, usagePartial: true };
  const hookHasUsage = HOOK_USAGE_FIELDS.some((field) => Number.isSafeInteger(tool.providerUsage?.[field])) || Number.isSafeInteger(tool.totalTokens);
  const hookDisagrees = hookHasUsage && (tool.hookUsagePartial
    || (agent.finalRequestUsage && HOOK_USAGE_FIELDS.some((field) => tool.providerUsage[field] !== agent.finalRequestUsage[field])));
  const modelDisagrees = tool.resolvedModel && agent.resolvedModel && tool.resolvedModel !== agent.resolvedModel;
  const observedElapsedMs = Number.isSafeInteger(tool.startedAtMs) && Number.isSafeInteger(agent.stoppedAtMs) && agent.stoppedAtMs >= tool.startedAtMs
    ? agent.stoppedAtMs - tool.startedAtMs
    : null;
  const elapsedMs = Number.isSafeInteger(tool.elapsedMs) ? tool.elapsedMs : observedElapsedMs;
  const {
    observationId, parentTranscriptPath, transcriptWaitMs, stoppedAtMs, finalRequestUsage,
    pendingInvocationId, pendingTargetRef, agentTranscriptPath, lastAssistantMessageHash, ...agentUsage
  } = agent;
  return {
    ...output,
    resolvedModel: agentUsage.resolvedModel || tool.resolvedModel,
    providerSchema: agentUsage.providerSchema,
    status: 'completed',
    elapsedMs,
    inputTokens: agentUsage.inputTokens,
    cacheWriteInputTokens: agentUsage.cacheWriteInputTokens,
    cachedInputTokens: agentUsage.cachedInputTokens,
    reasoningOutputTokens: null,
    outputTokens: agentUsage.outputTokens,
    totalTokens: agentUsage.totalTokens,
    usagePartial: agentUsage.usagePartial || hookDisagrees || modelDisagrees || tool.duplicateEvidence === true || !Number.isSafeInteger(tool.attempt) || tool.attempt < 1 || elapsedMs === null,
    ...(agentUsage.usageStatus ? { usageStatus: agentUsage.usageStatus, cliVersion: agentUsage.cliVersion } : {}),
    providerUsage: agentUsage.providerUsage,
  };
}

function reconcileSlots(entries, slots) {
  if (!slots.length) return entries;
  const keyed = new Map();
  for (const entry of entries) {
    const key = `${entry.artifactPath}\0${entry.attempt}`;
    const matches = keyed.get(key) || [];
    matches.push(entry);
    keyed.set(key, matches);
  }
  const reconciled = [];
  const consumed = new Set();
  for (const slot of slots) {
    const matches = keyed.get(`${slot.artifactPath}\0${slot.attempt}`) || [];
    if (!matches.length) {
      reconciled.push({
        ...slot, invocationId: null, status: 'missing', usagePartial: true,
        elapsedMs: null, inputTokens: null, cacheWriteInputTokens: null, cachedInputTokens: null,
        reasoningOutputTokens: null, outputTokens: null, totalTokens: null,
      });
    } else {
      for (const entry of matches) reconciled.push(matches.length === 1 ? entry : { ...entry, usagePartial: true, duplicateEvidence: true });
      for (const entry of matches) consumed.add(entry);
    }
  }
  for (const entry of entries) if (!consumed.has(entry)) reconciled.push({ ...entry, usagePartial: true, orphan: true });
  return reconciled;
}

function codexEntries(stateDir, ledger, slug) {
  const entries = new Map((ledger.telemetry?.entries || [])
    .filter((entry) => entry?.engine === 'codex' && typeof entry.invocationId === 'string')
    .map((entry) => [entry.invocationId, entry]));
  if (slug) {
    const file = path.join(stateDir, `telemetry-${slug}.json`);
    try {
      const telemetry = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const entry of telemetry.invocations || []) if (entry?.engine === 'codex' && typeof entry.invocationId === 'string') entries.set(entry.invocationId, entry);
    } catch (error) {
      if (error?.code !== 'ENOENT') entries.set('malformed', {
        engine: 'codex', provider: 'openai', role: 'unknown', round: null, invocationId: null,
        status: 'malformed', usagePartial: true, artifactPath: file, elapsedMs: null,
        inputTokens: null, cacheWriteInputTokens: null, cachedInputTokens: null,
        reasoningOutputTokens: null, outputTokens: null, totalTokens: null,
      });
    }
  }
  const slots = Array.isArray(ledger.telemetrySlots)
    ? ledger.telemetrySlots.filter((slot) => slot?.engine === 'codex' && slot.provider === 'openai')
    : [];
  return reconcileSlots([...entries.values()], slots);
}

function foldTelemetry(stateDir, ledger, slug) {
  if (!ledger || typeof ledger.target?.ref !== 'string') return ledger;
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return ledger; }
  const tools = new Map((ledger.telemetry?.entries || []).filter((entry) => entry?.engine === 'claude-code' && entry.provider === 'anthropic' && typeof entry.invocationId === 'string').map((entry) => [entry.invocationId, { kind: 'tool-use', ...entry }]));
  const agents = new Map();
  const malformed = [];
  for (const name of names) {
    try {
      if (/^review-telemetry-[0-9a-f]{64}\.json$/.test(name)) {
        const entry = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (entry.engine === 'claude-code' && entry.provider === 'anthropic' && entry.targetRef === ledger.target.ref && typeof entry.invocationId === 'string') tools.set(entry.invocationId, entry);
      } else if (/^review-agent-telemetry-[0-9a-f]{64}\.json$/.test(name)) {
        const entry = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (entry.engine === 'claude-code' && entry.provider === 'anthropic' && typeof entry.agentId === 'string') {
          const observations = agents.get(entry.agentId) || [];
          observations.push(entry);
          agents.set(entry.agentId, observations);
        }
      }
    } catch {
      if (/^review-(?:agent-)?telemetry-[0-9a-f]{64}\.json$/.test(name)) malformed.push({
        engine: 'claude-code', role: 'unknown', round: null, invocationId: null, status: 'malformed', usagePartial: true,
        artifactPath: path.join(stateDir, name), elapsedMs: null, inputTokens: null, cacheWriteInputTokens: null,
        cachedInputTokens: null, reasoningOutputTokens: null, outputTokens: null, totalTokens: null,
      });
    }
  }
  const targetAgentIds = new Set(Array.from(tools.values(), (tool) => tool.agentId).filter((agentId) => typeof agentId === 'string'));
  for (const agentId of agents.keys()) if (!targetAgentIds.has(agentId)) agents.delete(agentId);
  let entries = Array.from(tools.values(), (tool) => {
    const observations = (agents.get(tool.agentId) || []).filter((agent) => (
      typeof tool.parentTranscriptPath === 'string' && agent.parentTranscriptPath === tool.parentTranscriptPath
    ));
    const joined = joinAgentUsage(tool, observations.length === 1 ? observations[0] : observations.at(-1));
    return observations.length > 1 ? { ...joined, usagePartial: true } : joined;
  }).concat(malformed);
  const slots = Array.isArray(ledger.telemetrySlots)
    ? ledger.telemetrySlots.filter((slot) => slot?.engine === 'claude-code' && slot.provider === 'anthropic')
    : [];
  if (slots.length) {
    entries = reconcileSlots(entries, slots);
  }
  entries = entries.concat(codexEntries(stateDir, ledger, slug));
  entries.sort((a, b) => `${a.artifactPath || ''}\0${a.attempt || 0}\0${a.invocationId || ''}`.localeCompare(`${b.artifactPath || ''}\0${b.attempt || 0}\0${b.invocationId || ''}`));
  return entries.length ? { ...ledger, telemetry: aggregate(entries) } : ledger;
}

function deleteTelemetry(stateDir, targetRef, targetSlug) {
  if (typeof targetSlug === 'string' && targetSlug) {
    try { fs.unlinkSync(path.join(stateDir, `telemetry-${targetSlug}.json`)); } catch {}
  }
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return; }
  const usedAgentAssociations = new Set();
  for (const name of names) {
    if (!/^review-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
    const file = path.join(stateDir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.targetRef === targetRef) {
        const association = agentAssociation(entry);
        if (association) usedAgentAssociations.add(association);
        fs.unlinkSync(file);
      }
    } catch {
      // Leave unrelated or malformed artifacts for operator inspection.
    }
  }
  for (const name of fs.readdirSync(stateDir)) {
    if (!/^review-agent-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
    const file = path.join(stateDir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.pendingTargetRef === targetRef || usedAgentAssociations.has(agentAssociation(entry))) fs.unlinkSync(file);
    } catch {}
  }
}

module.exports = { foldTelemetry, deleteTelemetry, roleFromArtifactSuffix };
