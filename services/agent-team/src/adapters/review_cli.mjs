import { spawn } from "node:child_process";

// Real runCli: drives review-cli.js as a child process. Threads REVIEW_REPO_ROOT and
// REVIEW_STATE_DIR explicitly (not inherited), parses stdout JSON on success, and maps
// any non-zero exit / unparseable stdout to a { harnessFailure } object the runner
// surfaces as outcome "error" -- never a false converged/parked.
export function makeRunCli({ repoRoot, stateDir, cliPath }) {
  return function runCli(verb, args = []) {
    return new Promise((resolve) => {
      const child = spawn("node", [cliPath, verb, ...args], {
        env: { ...process.env, REVIEW_REPO_ROOT: repoRoot, REVIEW_STATE_DIR: stateDir },
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        if (code !== 0) return resolve({ harnessFailure: true, message: err.trim() || `exit ${code}` });
        try {
          resolve(JSON.parse(out.trim()));
        } catch {
          resolve({ harnessFailure: true, message: `non-JSON stdout: ${out.slice(0, 200)}` });
        }
      });
      child.on("error", (e) => resolve({ harnessFailure: true, message: e.message }));
    });
  };
}
