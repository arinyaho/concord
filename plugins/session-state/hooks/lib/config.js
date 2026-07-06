'use strict';

module.exports = {
  RECENCY_HOURS: 48,   // startup injection skips a _latest.md older than this
  FACTS_CAP: 40,       // recent-activity ring buffer size
  OPEN_LOOPS_CAP: 20,  // max unresolved open loops kept
  DECISIONS_CAP: 20,   // max decisions kept (latest per topic)
  NEXTS_CAP: 5,        // max next-step lines kept
  TAG_RE: /^(DECISION|OPEN-LOOP|NEXT|RESOLVED):\s*(.*)$/i,
  // High-signal build/test/deploy/infra tools. An allowlist (not a denylist)
  // because a bare denylist captures shell variable-assignment setup lines
  // (VAR=/path/...) that dominate multi-line commands; those carry no action.
  MEANINGFUL_BASH_RE: /^(git|gh|pytest|jest|vitest|npm|pnpm|yarn|pip|poetry|uv|cargo|go|mvn|gradle|make|cmake|bazel|docker|docker-compose|kubectl|helm|terraform|aws|gcloud|cdk|amplify|serverless|pulumi|ansible)\b/,
};
