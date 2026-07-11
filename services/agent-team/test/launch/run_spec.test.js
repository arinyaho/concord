import test from "node:test";
import assert from "node:assert/strict";
import { buildDockerArgs } from "../../src/launch/run_spec.mjs";

const CFG = {
  image: "agent-team:3a",
  concordDir: "/home/u/concord",
  workDir: "/home/u/work-1",
  credsDir: "/home/u/creds/.claude",
  skillsDir: "/home/u/.claude/skills",
  gitName: "agent-team-bot",
  gitEmail: "bot@agent-team.local",
  settingSources: ["user"],
  pipelineArgs: ["do the task", "--repo", "/work", "--base", "main"],
};

test("emits run --rm and the image", () => {
  const a = buildDockerArgs(CFG);
  assert.equal(a[0], "run");
  assert.ok(a.includes("--rm"));
  assert.ok(a.includes("agent-team:3a"));
});

test("mounts exactly the four allowlisted sources at the right targets", () => {
  const a = buildDockerArgs(CFG).join(" ");
  assert.ok(a.includes("-v /home/u/concord:/concord-ro:ro"));
  assert.ok(a.includes("-v /home/u/work-1:/work"));
  assert.ok(a.includes("-v /home/u/creds/.claude:/root/.claude:ro"));
  assert.ok(a.includes("-v /home/u/.claude/skills:/root/.claude/skills:ro"));
  assert.equal(buildDockerArgs(CFG).filter((x) => x === "-v").length, 4);
});

test("injects env allowlist: HOME, GIT_* identity, settingSources; no cloud vars", () => {
  const a = buildDockerArgs(CFG);
  const joined = a.join(" ");
  assert.ok(joined.includes("-e HOME=/root"));
  assert.ok(joined.includes("-e GIT_AUTHOR_NAME=agent-team-bot"));
  assert.ok(joined.includes("-e GIT_COMMITTER_EMAIL=bot@agent-team.local"));
  assert.ok(joined.includes(`-e AGENT_TEAM_SETTING_SOURCES=["user"]`));
  // every -e is KEY=value (never a bare -e that would pull from the launcher env)
  for (let i = 0; i < a.length; i++) if (a[i] === "-e") assert.ok(a[i + 1].includes("="), `bare -e at ${i}`);
  assert.equal(a.filter((x) => x === "-e").length, 6);
});

test("NEVER emits dangerous flags", () => {
  const a = buildDockerArgs(CFG).join(" ");
  for (const bad of ["--privileged", "--cap-add", "--security-opt", "--pid=host", "--ipc=host", "--network=host", "--device", "docker.sock"]) {
    assert.ok(!a.includes(bad), `must not contain ${bad}`);
  }
});

test("pipeline args pass through AFTER the image, order preserved", () => {
  const a = buildDockerArgs(CFG);
  const img = a.indexOf("agent-team:3a");
  assert.deepEqual(a.slice(img + 1), ["do the task", "--repo", "/work", "--base", "main"]);
});
