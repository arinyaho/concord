// Manual substrate check (NOT a node --test file): does query() run on Max OAuth
// with no ANTHROPIC_API_KEY? Prints PONG on success. Run: npm run smoke
import { query } from "@anthropic-ai/claude-agent-sdk";

if (process.env.ANTHROPIC_API_KEY) {
  console.error("FAIL: ANTHROPIC_API_KEY is set; unset it so this proves OAuth, not the key.");
  process.exit(1);
}

let result = null;
for await (const m of query({
  prompt: "Reply with exactly the word: PONG",
  options: { maxTurns: 1, allowedTools: [] },
})) {
  if ("result" in m) result = m.result;
}

const ok = (result || "").trim() === "PONG" && !process.env.ANTHROPIC_API_KEY;
console.log(JSON.stringify({ ok, result, apiKeyPresent: !!process.env.ANTHROPIC_API_KEY }));
process.exit(ok ? 0 : 1);
