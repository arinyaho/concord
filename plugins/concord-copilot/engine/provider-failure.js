'use strict';

// Provider output is untrusted and can contain opaque credentials. Classify it
// in memory; only closed metadata and fixed summaries cross the durable boundary.
const IDENTITIES = {
  claude: { engine: 'claude', provider: 'anthropic', providerSchema: 'claude-print-json-v1' },
  codex: { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1' },
  copilot: { engine: 'copilot', provider: 'github', providerSchema: 'copilot-prompt-v1' },
};
const MESSAGES = {
  authentication: 'Provider authentication failed.',
  'rate-limit': 'Provider rate limit exceeded.',
  transient: 'Provider execution failed temporarily.',
  'malformed-response': 'Provider returned a malformed response.',
  unknown: 'Provider execution failed without a recognized diagnostic.',
};
const KINDS = new Set(['subprocess-exit', 'timeout', 'signal', 'interrupted', 'provider-error']);
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGQUIT', 'SIGPIPE', 'SIGBUS', 'SIGILL', 'SIGFPE']);
const ROLES = new Set(['plan', 'correctness', 'verify', 'intent', 'gate', 'gate-verify', 'gate-review', 'fix', 'certify', 'artifact-repair', 'gate-panel-ac-coverage', 'gate-panel-design-conformance', 'gate-panel-silent-gap', 'gate-panel-threat-model', 'gate-panel-cross-context', 'gate-panel-verify']);

function normalizeProviderFailure(failure) {
  const role = ROLES.has(failure.role) ? failure.role : 'provider';
  const kind = KINDS.has(failure.kind) ? failure.kind : 'provider-error';
  const classification = Object.hasOwn(MESSAGES, failure.diagnostic?.classification) ? failure.diagnostic.classification : 'unknown';
  const identity = Object.hasOwn(IDENTITIES, failure.diagnostic?.engine) ? IDENTITIES[failure.diagnostic.engine] : { engine: 'unknown', provider: 'unknown', providerSchema: 'unknown' };
  const exitCode = Number.isSafeInteger(failure.exitCode) ? failure.exitCode : null;
  const signal = SIGNALS.has(failure.signal) ? failure.signal : null;
  const diagnostic = { classification, message: MESSAGES[classification], ...identity };
  const retryable = ['rate-limit', 'transient'].includes(classification) && !['interrupted', 'signal'].includes(kind);
  const summary = kind === 'subprocess-exit' ? `${role} subprocess exited ${exitCode === null ? 'unknown' : exitCode}`
    : kind === 'timeout' ? `${role} subprocess timed out`
      : kind === 'interrupted' ? `${role} subprocess interrupted`
        : kind === 'signal' ? `${role} subprocess ended from ${signal || 'a signal'}` : `${role} provider execution failed`;
  return { role, kind, message: `${summary}; ${diagnostic.message}`, ...(exitCode !== null ? { exitCode } : {}), ...(signal ? { signal } : {}), diagnostic, retryable };
}

function errorFields(record, engine) {
  const fields = (value) => {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return ['type', 'code', 'message'].map((key) => value[key]).filter((value) => typeof value === 'string');
  };
  if (engine === 'codex') {
    if (record.type === 'error') return [...fields(record.error), ...fields(record.message)];
    if (record.type === 'turn.failed') return fields(record.error);
    if (record.type === 'item.completed' && record.item?.type === 'error') return [...fields(record.item.error), ...fields(record.item.message)];
  }
  if (engine === 'claude') {
    if (record.type === 'error') return fields(record.error);
    if (record.type === 'result' && record.is_error === true) {
      return [...fields(record.error), ...fields(record.result), ...(Array.isArray(record.errors) ? record.errors.flatMap(fields) : [])];
    }
  }
  return [];
}

function classify(result, engine) {
  // Only error records from stdout are diagnostic evidence, never arbitrary
  // model prose. stderr is an invocation error channel, bounded by the caller.
  const stderr = String(result instanceof Error ? result.message : result?.stderr || '').slice(0, 8192);
  const stdout = String(result?.diagnosticText || result?.stdout || '').slice(0, 8192);
  const records = [];
  let malformed = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!/^\s*[\[{]/.test(line)) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(...errorFields(record, engine));
    } catch (_) { malformed = true; }
  }
  const evidence = `${records.join('\n')}\n${stderr}`;
  if (/authentication_error|unauthorized|invalid[ _-]api[ _-]key|authentication failed|invalid[_ -]?(?:token|credentials)|\bHTTP\s*401\b/i.test(evidence)) return 'authentication';
  if (/rate_limit_error|rate[ _-]limit(?:ed| exceeded)|too many requests|\bHTTP\s*429\b/i.test(evidence)) return 'rate-limit';
  if (result?.timedOut || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(result?.code)
    || /overloaded_error|server_error|service unavailable|temporarily unavailable|connection (?:reset|timed out)|\b(?:HTTP|API Error:|status(?: code)?[:=]?)\s*50[234]\b/i.test(evidence)) return 'transient';
  if (malformed || /invalid json|malformed (?:provider )?response|invalid provider response/i.test(evidence)) return 'malformed-response';
  return 'unknown';
}

function providerFailure(input, result) {
  const kind = result?.interrupted || result?.reviewFailure?.kind === 'interrupted' ? 'interrupted' : result?.timedOut || result?.reviewFailure?.kind === 'timeout' ? 'timeout' : result?.signal ? 'signal' : result instanceof Error ? 'provider-error' : 'subprocess-exit';
  return normalizeProviderFailure({ role: input.role, kind, exitCode: result?.status, signal: result?.signal,
    diagnostic: { classification: classify(result, input.provider), engine: input.provider } });
}

function reviewContinuation(ledger) {
  const execution = ledger?.execution;
  const retry = execution?.planRetry;
  const transport = execution?.planTransportRetry;
  const planEvidence = execution?.normalizedPlan || execution?.completed?.includes('plan') || execution?.planRepairPending;
  const terminal = retry?.state === 'exhausted'
    || transport?.state === 'exhausted'
    || (retry?.launched && retry.state !== 'accepted' && !planEvidence
      && !(transport?.state === 'pending' && transport.attempts === 0));
  return { nextAction: terminal ? 'terminal-handoff' : 'resume', retryable: !terminal };
}

module.exports = { providerFailure, normalizeProviderFailure, reviewContinuation };
