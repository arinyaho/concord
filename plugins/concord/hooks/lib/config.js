'use strict';

module.exports = {
  FACTS_CAP: 40,       // recent-activity ring buffer size
  OPEN_LOOPS_CAP: 20,  // max unresolved open loops kept
  DECISIONS_CAP: 20,   // max decisions kept (latest per topic)
  NEXTS_CAP: 5,        // max next-step lines kept
  SESSIONS_MERGE_CAP: 25, // merge-on-read unions at most this many most-recent sessions
  ACTIVE_SKIP_MINUTES: 5, // durability all-scan skips a session whose transcript changed this recently
  MIN_MSG_LEN: 12,        // a user message shorter than this is not a substantive framing
  NORTH_STAR_MAX: 4000,   // cap north-star length written to charter.md
  REVIEW_MAX_ROUNDS_DEFAULT: 5, // review-until-green: default round budget before parking
  REVIEW_PARK_BUDGET_DEFAULT: 3, // review-until-green: needs-decision parks before the circuit breaker stops the run early
  REVIEW_CLAUDE_TIMEOUT_MS_DEFAULT: 600 * 1000, // per-gate `claude -p` timeout: a deliberately high ceiling for a real-diff review, NOT a value tuned to one diff. Env REVIEW_CLAUDE_TIMEOUT_MS overrides. (Was 90s tuned to the toy e2e -- too short for real PRs, so runs aborted as harness-failure.)
  REVIEW_CLAUDE_RETRIES_DEFAULT: 1, // retry a gate call this many times on spawn timeout before declaring harness-failure. Env REVIEW_CLAUDE_RETRIES overrides.
  TAG_RE: /^(DECISION|OPEN-LOOP|NEXT|RESOLVED):\s*(.*)$/i,
  // High-signal build/test/deploy/infra tools. An allowlist (not a denylist)
  // because a bare denylist captures shell variable-assignment setup lines
  // (VAR=/path/...) that dominate multi-line commands; those carry no action.
  MEANINGFUL_BASH_RE: /^(git|gh|pytest|jest|vitest|npm|pnpm|yarn|pip|poetry|uv|cargo|go|mvn|gradle|make|cmake|bazel|docker|docker-compose|kubectl|helm|terraform|aws|gcloud|cdk|amplify|serverless|pulumi|ansible)\b/,
};
