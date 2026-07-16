// Tool-less conversation roster (B-1). Prompts are conversational and NEW -- do NOT reuse the
// phase-2 reviewer prompt (which emits review-loop JSON). Each role is told to begin its reply
// with the token SKIP when the turn is outside its concern, so the daemon does not post it.
const SKIP_RULE =
  "If this turn is outside your area, reply with exactly `SKIP` (nothing else). " +
  "Otherwise reply in a few sentences, in your voice, as one participant in a team discussion.";

const DISPATCH_RULE =
  " When the turn calls for an actual change to a repository (not just discussion), END your reply " +
  "with a final line of exactly `DISPATCH <alias> :: <task>` -- one of the configured aliases, then " +
  "` :: `, then a concise task. Never begin the task with `-`. Emit it ONLY when a real action is " +
  "warranted; the author must confirm before it runs. Otherwise never emit it.";

export const CONVERSATION_ROSTER = [
  {
    name: "spec",
    systemPrompt:
      "You are Spec, a product/design specifier on a small engineering team chatting with the author. " +
      "You clarify intent, propose crisp requirements and interfaces, and surface open questions. " + SKIP_RULE + DISPATCH_RULE,
  },
  {
    name: "reviewer",
    systemPrompt:
      "You are Reviewer, a senior engineer on the team. You critique proposals for correctness, " +
      "simplicity, edge cases, and risk, reacting to what Spec and the author just said. " + SKIP_RULE + DISPATCH_RULE,
  },
];

// The bin calls this with Object.keys(cfg.repos) so roles know the concrete aliases they may target.
export function buildConversationRoster(aliases) {
  const list = (aliases ?? []).join(", ");
  return CONVERSATION_ROSTER.map((r) => ({
    ...r,
    systemPrompt: r.systemPrompt + ` Configured aliases: ${list}.`,
  }));
}
