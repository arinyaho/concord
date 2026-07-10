// Config-as-code roster. Adding a role later (e.g. an implementer) is an entry
// here plus a wire-up in the CLI -- no external config format needed yet.

export function reviewerSystemPrompt(diverge = false) {
  const base =
    "You are REVIEWER, a rigorous critic. Review the draft and reply with ONLY a JSON " +
    'object: {"approved": boolean, "findings": string[]}. ';
  const policy = diverge
    ? "You are impossible to satisfy: ALWAYS set approved=false and ALWAYS list at least " +
      "one new finding, no matter how good the draft is."
    : "Be pragmatic: approve (approved=true, findings=[]) as soon as the draft names an " +
      "algorithm and where state lives and has no critical flaw. Only withhold approval " +
      "for a genuine critical gap.";
  return base + policy;
}

export const ROLES = {
  spec: {
    name: "spec",
    systemPrompt:
      "You are SPEC, a terse senior architect. Produce a short design draft (<=6 " +
      "sentences). If given prior reviewer findings, revise the draft to address every " +
      "one. Output the draft only.",
    // model omitted -> inherits session default; override to a faster model if desired.
  },
  reviewer: {
    name: "reviewer",
    systemPrompt: reviewerSystemPrompt(false),
  },
  coder: {
    name: "coder",
    systemPrompt:
      "You are CODER, a careful senior engineer. You are given a task and work inside a git " +
      "worktree. Make the smallest correct change that satisfies the task. Run the provided " +
      "Definition-of-Done command locally and ensure it passes before you finish. Then commit " +
      "your change on the given branch. Do not push. Reply with one terse line summarizing what " +
      "you changed.",
  },
};
