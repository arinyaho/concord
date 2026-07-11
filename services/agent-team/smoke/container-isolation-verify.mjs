// MANUAL / NETWORK. Under the container launch, a role's Bash cannot reach host creds; git+node
// work; apiKeySource is none. Fail-closed: any probe returning a real credential fails the run.
// NOT under test/ so `node --test` never globs it.
import { spawnSync } from "node:child_process";

const credsDir = process.argv[process.argv.indexOf("--creds-dir") + 1];
if (!credsDir) { console.error("need --creds-dir <dir with only .credentials.json>"); process.exit(2); }
const concord = new URL("../../..", import.meta.url).pathname;
const probe = [
  "cat /root/.aws/credentials 2>&1 || true",
  "cat " + process.env.HOME + "/.aws/credentials 2>&1 || true",
  "command -v aws gh security 2>&1 || echo NO_CLOUD_CLIS",
  "ls / 2>&1 | tr '\\n' ' '",
  "git --version; node --version",
].join(" ; ");
const args = [
  "run", "--rm",
  "-v", `${concord}:/concord-ro:ro`,
  "-v", `${credsDir}:/root/.claude:ro`,
  "-e", "HOME=/root",
  "--entrypoint", "bash", "agent-team:3a", "-c", probe,
];
const r = spawnSync("docker", args, { encoding: "utf8" });
const out = (r.stdout || "") + (r.stderr || "");
console.log(out);
const bad = /aws_access_key_id|BEGIN [A-Z ]*PRIVATE KEY|ASIA[0-9A-Z]{16}|AKIA[0-9A-Z]{16}/i.test(out);
const cloudAbsent = /NO_CLOUD_CLIS/.test(out);
const toolsWork = /git version/.test(out) && /v\d+\./.test(out);
if (bad || !cloudAbsent || !toolsWork) { console.error("ISOLATION SMOKE FAILED"); process.exit(1); }
console.log("ISOLATION SMOKE PASSED");
