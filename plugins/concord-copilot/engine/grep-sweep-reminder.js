'use strict';

// Design note: this hook exists because delegate-verbose-work (the LLM-self-recognition-based
// delegation guidance this reminder backs up) was reported ineffective in practice — sessions
// were observed still running 10+ consecutive grep/rg calls on the main thread after that skill
// shipped, because nothing forces the model to notice its own trigger condition. This hook
// forces the reminder into context instead of relying on the model to ask for it.
//
// Decision: warn, never block. A hard gate on grep/rg would also stop a legitimate large
// sweep the model has correctly decided not to delegate (e.g. its answer feeds the very
// next tool call, per the skill's own "when not to" list); a non-blocking reminder costs
// nothing when the model was already right to proceed.
//
// Trade-off: the word-boundary match on `grep`/`rg` accepts occasional false positives
// (the words appearing inside an unrelated command string) in exchange for a single cheap
// regex instead of a real shell-command parser — acceptable because a false positive only
// ever adds a reminder, never blocks anything.
//
// Residual exposure: per-session counters persist under the transcript's state dir
// (adapters/claude-code/grep-sweep-reminder.js) and are never cleaned up, matching the
// existing review-telemetry state files in the same directory — not a new gap, but not
// solved here either.
const THRESHOLD = 10;

// grep/egrep/fgrep/rg as a standalone command word, not a substring of an
// unrelated word (e.g. "program"). False positives (grep quoted inside an
// unrelated string) are acceptable: this only ever adds a non-blocking
// reminder.
const SEARCH_SWEEP_PATTERN = /\b(?:e?grep|fgrep|rg)\b/;

function isSearchSweepCommand(command) {
  return typeof command === 'string' && SEARCH_SWEEP_PATTERN.test(command);
}

// Reminds at the threshold and then periodically thereafter (every
// `threshold` matching calls) rather than once, so a sweep that blows past
// 10 and keeps going gets nudged again instead of going quiet after the
// first reminder.
function shouldRemind(count, threshold = THRESHOLD) {
  return Number.isInteger(count) && count > 0 && count % threshold === 0;
}

function reminderText(count, threshold = THRESHOLD) {
  return (
    `This session has made ${count} grep/rg-style Bash calls. If this is a broad sweep ` +
    `answering one question (roughly ${threshold}+ calls), consider routing it to a subagent per the ` +
    'delegate-verbose-work skill and keeping only its conclusion.'
  );
}

module.exports = { THRESHOLD, isSearchSweepCommand, shouldRemind, reminderText };
