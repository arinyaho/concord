// Shared: resolve settingSources from the AGENT_TEAM_SETTING_SOURCES env var (the container
// launcher sets ["user"] so repo-committed project/local settings do NOT auto-execute -- SM6).
// Returns the parsed array, or undefined when the env var is unset (SDK default, for local runs).
export function settingSourcesFromEnv(env = process.env) {
  const ss = env.AGENT_TEAM_SETTING_SOURCES;
  if (!ss) return undefined;
  let parsed;
  try { parsed = JSON.parse(ss); }
  catch { throw new Error(`AGENT_TEAM_SETTING_SOURCES must be a JSON array of strings, got: ${ss}`); }
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string")) {
    throw new Error(`AGENT_TEAM_SETTING_SOURCES must be a JSON array of strings, got: ${ss}`);
  }
  return parsed;
}
