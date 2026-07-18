import { isAuthorized } from "./identity.mjs";
import { parseCommand } from "./message.mjs";
import { formatAck, formatQueueFull } from "./reply.mjs";
import { makeProgressRelay } from "./progress_relay.mjs";

// The testable message path: identity gate -> parse -> mint id -> submit -> ack. Injectable deps
// (queue/mintId/reply) so it runs with no live gateway. The gate is fail-closed and silent for
// unauthorized messages (no reply -- do not confirm the bot exists).
export function makeHandler({ cfg, deps }) {
  const { queue, mintId, reply } = deps;
  return async function handle(msg) {
    if (msg.author?.bot) return;
    if (!isAuthorized({ authorId: msg.author?.id, channelId: msg.channelId, guildId: msg.guildId }, cfg)) return;
    const parsed = parseCommand(msg.content, cfg);
    if (parsed.error) { await reply(msg, parsed.error); return; }
    const jobId = mintId();
    const progressRelay = makeProgressRelay({ send: (payload) => msg.reply(payload) });
    const job = {
      jobId, task: parsed.task, repoPath: parsed.repoPath, alias: parsed.alias, msg,
      onStart: () => progressRelay.start(),
      onProgress: (event) => progressRelay.progress(event),
      onTerminal: (outcome) => progressRelay.terminal(outcome),
    };
    if (!queue.submit(job)) { await reply(msg, formatQueueFull()); return; }
    await reply(msg, formatAck({ jobId, alias: parsed.alias, task: parsed.task }));
  };
}
