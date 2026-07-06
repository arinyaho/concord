'use strict';

module.exports = {
  RECENCY_HOURS: 48,   // startup injection skips a _latest.md older than this
  FACTS_CAP: 40,       // recent-activity ring buffer size
  OPEN_LOOPS_CAP: 20,  // max unresolved open loops kept
  DECISIONS_CAP: 20,   // max decisions kept (latest per topic)
  NEXTS_CAP: 5,        // max next-step lines kept
  TAG_RE: /^(DECISION|OPEN-LOOP|NEXT|RESOLVED):\s*(.*)$/i,
  MEANINGFUL_BASH_RE: /\b(git (commit|push|mv|rebase|merge|tag)|gh (pr|issue|release)|pytest|npm (run|test|ci|install)|pip install|cdk (deploy|synth)|amplify|make )\b/,
  NOISE_BASH_RE: /^\s*(ls|cd|cat|echo|grep|pwd|which|head|tail|sed|awk|find)\b/,
};
