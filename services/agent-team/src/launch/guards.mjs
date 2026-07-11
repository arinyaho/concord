// PURE refusals + runtime resolution. Filesystem/env are injected so these are unit-testable
// with no side effects. Fail-closed: any doubt refuses rather than proceeding.
export function assertNoApiKey(env) {
  if (env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is set; 3a proves OAuth-only. Unset it before launching.");
  }
}

export function assertCredsDir(dir, readdir) {
  const entries = readdir(dir);
  const ok = entries.length === 1 && entries[0] === ".credentials.json";
  if (!ok) {
    throw new Error(`creds dir ${dir} must contain only .credentials.json (found: ${entries.join(", ") || "nothing"})`);
  }
}

export function resolveRuntime(env, exists) {
  const bin = env.AGENT_TEAM_RUNTIME || "docker";
  if (!exists(bin)) throw new Error(`container runtime '${bin}' not found (install colima+docker / OrbStack / Podman)`);
  return bin;
}
