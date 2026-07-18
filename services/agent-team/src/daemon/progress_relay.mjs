const PHASES = new Set(["coding", "reviewing", "committing"]);
const OUTCOMES = new Set(["done", "failed", "timeout", "cancelled"]);
const SAFE_MENTIONS = { parse: [] };

const timelineContent = (timeline) => timeline.join("\n");

// Owns one Discord progress message. Every mutation joins the same chain, so an edit can never
// overtake the initial send or run beside another edit.
export function makeProgressRelay({ send, deadlineMs = 2000 }) {
  let message;
  let started = false;
  let terminal = false;
  let abandoned = false;
  let chain = Promise.resolve();
  const timeline = ["cloning"];
  const seen = new Set(timeline);

  function payload() {
    return { content: timelineContent(timeline), allowedMentions: SAFE_MENTIONS };
  }

  function enqueue(write) {
    const next = chain.then(async () => {
      if (abandoned) return;
      try {
        await write();
      } catch {
        // Progress is advisory; a Discord failure must not break job completion.
      }
    });
    chain = next;
    return next;
  }

  function start() {
    if (started || terminal) return chain;
    started = true;
    const update = payload();
    return enqueue(async () => { message = await send(update); });
  }

  function progress(event) {
    const phase = event?.type === "progress" ? event.phase : undefined;
    if (terminal || !started || !PHASES.has(phase) || seen.has(phase)) return chain;
    seen.add(phase);
    timeline.push(phase);
    const update = payload();
    return enqueue(async () => { if (message) await message.edit(update); });
  }

  function terminalOutcome(outcome) {
    const kind = outcome?.kind;
    if (terminal || !OUTCOMES.has(kind)) return chain;
    terminal = true;
    seen.add(kind);
    timeline.push(kind);
    const update = payload();
    const write = enqueue(async () => { if (message) await message.edit(update); });
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        abandoned = true;
        resolve();
      }, deadlineMs);
    });
    return Promise.race([write, deadline]).finally(() => clearTimeout(timer));
  }

  return { start, progress, terminal: terminalOutcome };
}
