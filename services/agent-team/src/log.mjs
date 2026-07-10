import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Append-only JSONL logger. `clock` is injectable for deterministic tests.
export function createLogger(filePath, clock = () => new Date().toISOString()) {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    path: filePath,
    event(type, data = {}) {
      const rec = { t: clock(), type, ...data };
      appendFileSync(filePath, JSON.stringify(rec) + "\n");
      process.stderr.write(`[${rec.t}] ${type} ${JSON.stringify(data)}\n`);
    },
  };
}
