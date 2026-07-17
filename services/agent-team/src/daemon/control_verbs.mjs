// Author-gated control verbs (matched only past isAuthorizedThread). Pure parser + status formatter
// + an injected-deps handler. No LLM, no query, no new host command: /cancel reuses the queue's
// existing kill, /rename is a Discord API call, /status + /clear are queue/store reads+writes.
const RE = {
  cancel: /^\/cancel\s+(\S+)$/,
  status: /^\/status$/,
  clear: /^\/clear$/,
  rename: /^\/rename\s+(.+)$/,
};

export function parseControlVerb(content) {
  const s = (content ?? "").trim();
  let m;
  if ((m = s.match(RE.cancel))) return { verb: "cancel", arg: m[1] };
  if (RE.status.test(s)) return { verb: "status", arg: undefined };
  if (RE.clear.test(s)) return { verb: "clear", arg: undefined };
  if ((m = s.match(RE.rename))) return { verb: "rename", arg: m[1].trim() || undefined };
  return null;
}

// Collapse newlines/control chars to a space BEFORE truncating: a task comes from raw multi-line
// Discord content, and an embedded \n would inject a phantom prefix-less row into the single-message
// /status readout. allowedMentions covers pings, not layout.
const clip = (t, n = 60) => { const x = String(t ?? "").replace(/[\r\n\x00-\x1f]+/g, " "); return x.length > n ? x.slice(0, n) + "..." : x; };

export function formatStatus({ pendings, jobs }) {
  const lines = ["status:"];
  if (pendings.length === 0 && jobs.running.length === 0 && jobs.queued.length === 0) {
    lines.push("  nothing pending, no jobs running");
  } else {
    for (const p of pendings) lines.push(`  pending ${p.id} (thread ${p.threadId ?? "-"}) ${p.alias}: ${clip(p.task)}`);
    for (const j of jobs.running) lines.push(`  running ${j.jobId} (thread ${j.threadId ?? "-"}) ${j.alias}: ${clip(j.task)}`);
    for (const j of jobs.queued) lines.push(`  queued ${j.jobId} (thread ${j.threadId ?? "-"}) ${j.alias}: ${clip(j.task)}`);
  }
  return lines.join("\n").slice(0, 2000);
}

export async function handleControlVerb({ verb, arg }, deps) {
  const { threadId, channel, cfg, queue, postSystem, getPending, clearPending, listPendings } = deps;
  if (verb === "cancel") {
    const { found } = queue.cancel(arg);
    // arg is user-supplied, so the ack echoes it back; mentions disabled + channel.send (not
    // postSystem) so `/cancel @everyone` cannot resolve into a live ping.
    const content = (found ? `cancelled ${arg}` : `no such job ${arg}`).slice(0, 2000);
    try { await channel.send({ content, allowedMentions: { parse: [] } }); }
    catch (e) { console.error(`[agent-team] /cancel ack post failed for thread ${threadId}:`, e); }
    return;
  }
  if (verb === "status") {
    const text = formatStatus({ pendings: listPendings(), jobs: queue.list() });
    // Mentions disabled so an author task in the tally cannot @everyone; channel.send is used
    // directly (not postSystem) to pass allowedMentions.
    try { await channel.send({ content: text, allowedMentions: { parse: [] } }); }
    catch (e) { console.error(`[agent-team] /status post failed for thread ${threadId}:`, e); }
    return;
  }
  if (verb === "clear") {
    if (getPending(threadId)) { clearPending(cfg.sessionStorePath, threadId); await postSystem(threadId, "cleared"); }
    else await postSystem(threadId, "nothing pending");
    return;
  }
  if (verb === "rename") {
    try { await channel.setName(arg.slice(0, 100)); await postSystem(threadId, `renamed`); }
    catch (e) { console.error(`[agent-team] /rename failed for thread ${threadId}:`, e); await postSystem(threadId, "rename failed"); }
    return;
  }
}
