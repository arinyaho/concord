import { readFileSync as rfs, writeFileSync as wfs, renameSync as rns } from "node:fs";

// Durable per-thread conversation sessions. One shared in-memory Map is the source of truth;
// saveThread mutates it and rewrites the whole file atomically (temp-then-rename, mode 0600).
// Load is graceful: a missing/unparseable file yields an empty map; a malformed single entry is
// dropped rather than crashing the daemon.
function validEntry(v) {
  return v && typeof v === "object" && v.roleSessions && typeof v.roleSessions === "object";
}

export function loadStore(path, deps = {}) {
  const readFileSync = deps.readFileSync ?? rfs;
  const map = new Map();
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return map; }
  let obj;
  try { obj = JSON.parse(raw); } catch { console.error(`session store unparseable at ${path}; starting empty`); return map; }
  if (!obj || typeof obj !== "object") return map;
  for (const [threadId, v] of Object.entries(obj)) {
    if (validEntry(v)) map.set(threadId, v);
    else console.error(`session store: dropping malformed entry ${threadId}`);
  }
  return map;
}

export function saveThread(map, path, threadId, state, deps = {}) {
  const writeFileSync = deps.writeFileSync ?? wfs;
  const renameSync = deps.renameSync ?? rns;
  map.set(threadId, state);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
  renameSync(tmp, path);
}
