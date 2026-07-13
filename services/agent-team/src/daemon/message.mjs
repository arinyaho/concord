// PURE: parse "alias: task" into a trusted repo path + task. The repo NEVER comes from the
// message body (only an alias selecting a config-allowlisted path). A leading-dash task is
// rejected: passed as argv[0] it would mis-slot the launcher's own trusted flags (self-DoS).
export function parseCommand(content, cfg) {
  const text = (content ?? "").trim();
  const idx = text.indexOf(":");
  if (idx <= 0) return { error: "expected 'alias: task'" };
  const alias = text.slice(0, idx).trim();
  const task = text.slice(idx + 1).trim();
  const repoPath = cfg?.repos?.[alias];
  if (!repoPath) return { error: `unknown alias '${alias}', valid: ${Object.keys(cfg?.repos ?? {}).join(", ")}` };
  if (!task) return { error: "empty task" };
  if (task.startsWith("-")) return { error: "task must not begin with '-'" };
  return { alias, repoPath, task };
}
