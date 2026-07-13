import { copyFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

// Atomically refresh the daemon's seeded OAuth creds from the host's live file. Copies ONLY
// .credentials.json (never the whole ~/.claude -- an extra settings.json would break the
// launcher's sole-entry assertCredsDir). Stages the temp OUTSIDE destDir, in its PARENT dir
// (same filesystem, so the rename stays atomic), so credsDir never momentarily holds a second
// entry that the launcher's assertCredsDir would reject; the rename then replaces in place, and
// a container bind-mounting the file mid-write never sees a torn read.
export function refreshCredsOnce({ srcFile, destDir }, deps = {}) {
  const copyFile = deps.copyFile ?? copyFileSync;
  const rename = deps.rename ?? renameSync;
  const tmp = join(dirname(destDir), ".credentials.json.tmp");
  const dst = join(destDir, ".credentials.json");
  copyFile(srcFile, tmp);
  rename(tmp, dst);
}

export function startCredsRefresh({ srcFile, destDir, intervalMs }, deps = {}) {
  const setInt = deps.setInterval ?? setInterval;
  refreshCredsOnce({ srcFile, destDir }, deps);
  return setInt(() => {
    try { refreshCredsOnce({ srcFile, destDir }, deps); }
    catch (e) { console.error(`creds refresh failed: ${e.message}`); }
  }, intervalMs);
}
