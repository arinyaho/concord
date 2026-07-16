'use strict';

// The five harness seams every adapter implements. See
// docs/superpowers/specs/2026-07-16-vendor-agnostic-harness-adapter-design.md.
const PORT_NAMES = ['lifecycle', 'transcript', 'reviewer', 'command', 'statedir'];

/**
 * @typedef {{ role: 'user'|'assistant', text: string, toolCalls: Array<{name:string,input:object}> }} NeutralEntry
 * @typedef {{ sessionId: string, transcriptPath: string, lastAssistantMessage?: string, source: 'startup'|'resume'|'compact'|'stop' }} NeutralEvent
 */

// Coerce a raw entry into the canonical NeutralEntry shape.
function normalizeEntry(raw) {
  const role = raw && raw.role;
  if (role !== 'user' && role !== 'assistant') {
    throw new Error(`normalizeEntry: invalid role ${JSON.stringify(role)}`);
  }
  return {
    role,
    text: typeof raw.text === 'string' ? raw.text : '',
    toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls : [],
  };
}

module.exports = { PORT_NAMES, normalizeEntry };
