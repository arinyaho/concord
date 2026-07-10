// Manual check (not node --test): does createRole give a persistent thread that
// retains prior turns across send()? Plants a secret, resumes, asks for it back.
import { createRole } from "../src/role.mjs";

const SECRET = "BANANA-42";
const role = createRole({ name: "probe", systemPrompt: "Answer tersely." });
await role.send(`Remember this code for later: ${SECRET}. Reply "ok".`);
const back = await role.send("What was the code I gave you? Reply with only the code.");
const ok = back.includes(SECRET) && !process.env.ANTHROPIC_API_KEY;
console.log(JSON.stringify({ ok, back, apiKeyPresent: !!process.env.ANTHROPIC_API_KEY }));
process.exit(ok ? 0 : 1);
