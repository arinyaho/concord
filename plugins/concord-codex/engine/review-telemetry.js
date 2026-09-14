'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SUM_FIELDS = ['elapsedMs', 'inputTokens', 'cacheWriteInputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'outputTokens', 'totalTokens'];
const HOOK_USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

function summary(entries) {
  const result = { calls: entries.length, partialCalls: entries.filter((entry) => entry.usagePartial).length };
  for (const field of SUM_FIELDS) {
    const values = entries.map((entry) => entry[field]).filter((value) => Number.isSafeInteger(value) && value >= 0);
    result[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return result;
}

function aggregate(entries) {
  const byRole = {};
  for (const role of new Set(entries.map((entry) => entry.role))) byRole[role] = summary(entries.filter((entry) => entry.role === role));
  return { engine: entries[0].engine, ...summary(entries), byRole, entries };
}

function publicToolRecord(tool) {
  const { kind, hookUsagePartial, ...record } = tool;
  return record;
}

function joinAgentUsage(tool, agent) {
  const output = publicToolRecord(tool);
  if (!agent || tool.status === 'failed') return { ...output, usagePartial: true };
  const hookHasUsage = HOOK_USAGE_FIELDS.some((field) => Number.isSafeInteger(tool.providerUsage?.[field])) || Number.isSafeInteger(tool.totalTokens);
  const hookDisagrees = hookHasUsage && (tool.hookUsagePartial || HOOK_USAGE_FIELDS.some((field) => tool.providerUsage[field] !== agent.lastRequestUsage?.[field]));
  const modelDisagrees = tool.resolvedModel && agent.resolvedModel && tool.resolvedModel !== agent.resolvedModel;
  const { observationId, transcriptWaitMs, ...agentUsage } = agent;
  return {
    ...output,
    resolvedModel: agentUsage.resolvedModel || tool.resolvedModel,
    providerSchema: agentUsage.providerSchema,
    status: tool.status === 'started' ? 'completed' : tool.status,
    inputTokens: agentUsage.inputTokens,
    cacheWriteInputTokens: agentUsage.cacheWriteInputTokens,
    cachedInputTokens: agentUsage.cachedInputTokens,
    reasoningOutputTokens: null,
    outputTokens: agentUsage.outputTokens,
    totalTokens: agentUsage.totalTokens,
    usagePartial: agentUsage.usagePartial || hookDisagrees || modelDisagrees || tool.duplicateEvidence === true,
    providerUsage: agentUsage.providerUsage,
  };
}

function foldTelemetry(stateDir, ledger) {
  if (!ledger || typeof ledger.target?.ref !== 'string') return ledger;
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return ledger; }
  const tools = new Map((ledger.telemetry?.entries || []).filter((entry) => typeof entry?.invocationId === 'string').map((entry) => [entry.invocationId, { kind: 'tool-use', ...entry }]));
  const agents = new Map();
  const malformed = [];
  for (const name of names) {
    try {
      if (/^review-telemetry-[0-9a-f]{64}\.json$/.test(name)) {
        const entry = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (entry.targetRef === ledger.target.ref && typeof entry.invocationId === 'string') tools.set(entry.invocationId, entry);
      } else if (/^review-agent-telemetry-[0-9a-f]{64}\.json$/.test(name)) {
        const entry = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (typeof entry.agentId === 'string') {
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
  let entries = Array.from(tools.values(), (tool) => {
    const observations = agents.get(tool.agentId) || [];
    const joined = joinAgentUsage(tool, observations.length === 1 ? observations[0] : observations.at(-1));
    return observations.length > 1 ? { ...joined, usagePartial: true } : joined;
  }).concat(malformed);
  const slots = Array.isArray(ledger.telemetrySlots) ? ledger.telemetrySlots : [];
  if (slots.length) {
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
      const key = `${slot.artifactPath}\0${slot.attempt}`;
      const matches = keyed.get(key) || [];
      if (!matches.length) {
        reconciled.push({
          engine: 'claude-code', ...slot, invocationId: null, status: 'missing', usagePartial: true,
          elapsedMs: null, inputTokens: null, cacheWriteInputTokens: null, cachedInputTokens: null,
          reasoningOutputTokens: null, outputTokens: null, totalTokens: null,
        });
      } else {
        for (const entry of matches) reconciled.push(matches.length === 1 ? entry : { ...entry, usagePartial: true });
        for (const entry of matches) consumed.add(entry);
      }
    }
    for (const entry of entries) if (!consumed.has(entry)) reconciled.push({ ...entry, usagePartial: true, orphan: true });
    const joinedAgentIds = new Set(entries.map((entry) => entry.agentId).filter(Boolean));
    for (const [agentId, observations] of agents) if (!joinedAgentIds.has(agentId)) {
      reconciled.push({
        engine: 'claude-code', role: 'unknown', round: null, invocationId: null, agentId, status: 'orphan', usagePartial: true,
        elapsedMs: null, inputTokens: null, cacheWriteInputTokens: null, cachedInputTokens: null,
        reasoningOutputTokens: null, outputTokens: null, totalTokens: null, orphanObservations: observations.length,
      });
    }
    entries = reconciled;
  }
  entries.sort((a, b) => `${a.artifactPath || ''}\0${a.attempt || 0}\0${a.invocationId || ''}`.localeCompare(`${b.artifactPath || ''}\0${b.attempt || 0}\0${b.invocationId || ''}`));
  return entries.length ? { ...ledger, telemetry: aggregate(entries) } : ledger;
}

function deleteTelemetry(stateDir, targetRef, targetSlug) {
  if (typeof targetSlug === 'string' && targetSlug) {
    try { fs.unlinkSync(path.join(stateDir, `telemetry-${targetSlug}.json`)); } catch {}
  }
  let names;
  try { names = fs.readdirSync(stateDir); } catch { return; }
  const usedAgentIds = new Set();
  for (const name of names) {
    if (!/^review-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
    const file = path.join(stateDir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.targetRef === targetRef) {
        if (typeof entry.agentId === 'string') usedAgentIds.add(entry.agentId);
        fs.unlinkSync(file);
      }
    } catch {
      // Leave unrelated or malformed artifacts for operator inspection.
    }
  }
  for (const name of fs.readdirSync(stateDir)) {
    if (!/^review-agent-telemetry-[0-9a-f]{64}\.json$/.test(name)) continue;
    const file = path.join(stateDir, name);
    try { if (usedAgentIds.has(JSON.parse(fs.readFileSync(file, 'utf8')).agentId)) fs.unlinkSync(file); } catch {}
  }
}

module.exports = { foldTelemetry, deleteTelemetry };
