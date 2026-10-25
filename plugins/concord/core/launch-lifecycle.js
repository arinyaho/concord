'use strict';

function createLaunchLifecycle({ provider, supportedSchema = false }) {
  let didSpawn = false;
  let observed = false;
  let started = false;
  let invalid = false;
  let terminalErrors = 0;
  let rejectionReason = 'none';
  let closed = false;

  const result = (lifecycle, reason, failed) => ({ lifecycle, reason, failed });
  const close = (value) => { closed = true; return value; };
  const knownItemTypes = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'collaboration_tool_call', 'collab_agent_tool_call']);
  const recognizedCode = (event) => {
    const error = event.error && typeof event.error === 'object' ? event.error : {};
    const code = error.code || error.type || event.code;
    if (code === 'model_not_found' || code === 'unsupported_model') return 'unsupported-model';
    if (code === 'sandbox_denied') return 'sandbox-denied';
    return 'unknown';
  };

  return {
    spawned() { didSpawn = true; },
    observe(event) {
      observed = true;
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
        invalid = true;
        return;
      }
      if (provider !== 'codex' || !supportedSchema) return;
      if (event.type === 'turn.started' || event.type === 'turn.completed') {
        started = true;
        return;
      }
      if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
        const item = event.item;
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            typeof item.type !== 'string' || !knownItemTypes.has(item.type) ||
            Object.prototype.hasOwnProperty.call(item, 'error')) {
          invalid = true;
          return;
        }
        started = true;
        return;
      }
      if (event.type === 'thread.started') return;
      if (event.type === 'turn.failed') {
        rejectionReason = recognizedCode(event);
        invalid = true;
        return;
      }
      if (event.type === 'error') {
        terminalErrors++;
        rejectionReason = terminalErrors === 1 ? recognizedCode(event) : 'unknown';
        return;
      }
      invalid = true;
    },
    malformed() { observed = true; invalid = true; },
    spawnError(code) {
      const cause = ({ ENOENT: 'spawn-enoent', EACCES: 'spawn-eacces', EPERM: 'spawn-eperm' })[code];
      const reason = cause || 'unknown';
      return close(!didSpawn && !observed && cause
        ? result('not-started', reason, true)
        : result('unknown', cause ? reason : 'unknown', true));
    },
    finish({ status, signal, timedOut, interrupted }) {
      if (closed) return result('unknown', 'unknown', true);
      const failed = status !== 0 || Boolean(signal) || Boolean(timedOut) || Boolean(interrupted);
      if (provider === 'codex' && supportedSchema && started) {
        const reason = failed ? (rejectionReason === 'none' ? 'unknown' : rejectionReason) : 'none';
        return close(result('started', reason, failed));
      }
      if (provider === 'codex' && supportedSchema && didSpawn && failed && !signal && !timedOut && !interrupted &&
          !invalid && !started && terminalErrors === 1 && rejectionReason !== 'unknown') {
        return close(result('not-started', rejectionReason, true));
      }
      return close(result('unknown', failed ? (rejectionReason === 'none' ? 'unknown' : rejectionReason) : 'none', failed));
    },
  };
}

module.exports = { createLaunchLifecycle };
