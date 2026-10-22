'use strict';
// The hand-off between a running round and the Claude Code session that drives it. The round cannot call the Agent tool, so the
// runner's `spawn` becomes a request the session answers: the runner writes the role's prompt and `request.json`, then waits for
// `done-<id>`, which only `approve.js next --done <id>` writes. The subagent's artifact is read by the runner as for any reviewer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// A subagent has no shell, so a prompt that says "run it" or "write blocked if you cannot" would fail the round for the tool, not for the code.
const NO_SHELL = '\n\nIn this run you cannot run any command: you have Read, Grep and Glob on the checkout and Write for the one artifact named above. Where this prompt asks you to run, measure or execute something, judge by reading the code and tests instead, and say in the finding or rejection what you read. Do not write "blocked" for a command you cannot run; write "blocked" only for a file you must read and cannot.';
const POLL_MS = 250;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const write = (file, value) => { fs.writeFileSync(`${file}.tmp`, value); fs.renameSync(`${file}.tmp`, file); };

// The runner reduces a failed `spawn` to a generic provider failure, so the reason is said first, on stderr, where `approve.js` relays it.
function fail(message) {
  process.stderr.write(`${message}\n`);
  throw new Error(message);
}

// Used inside the runner process as its `spawn`.
// `parentPid` is the round process that started the runner: when it is gone (killed), nobody will answer, so the attempt's directory is removed and the runner ends.
function requester(dir, { timeoutMs = 3600000, parentPid } = {}) {
  let counter = 0;
  return async (input) => {
    const id = ++counter;
    const promptFile = path.join(dir, `prompt-${id}.md`);
    const text = `${input.prompt}${NO_SHELL}\n\nThe pull request is checked out at ${input.repoRoot}: read the code there, not in your own working directory.`;
    write(promptFile, text);
    write(path.join(dir, 'request.json'), JSON.stringify({ id, role: input.role, promptFile, sha: sha(text), ...(input.requestedModel && { model: input.requestedModel }) }));
    const done = path.join(dir, `done-${id}`);
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(done)) {
      if (input.abortSignal?.aborted) fail(`the round was stopped while waiting for a subagent (${input.role})`);
      if (parentPid && !alive(parentPid)) { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); fail('the round that started this runner is gone'); }
      if (Date.now() > deadline) fail(`no subagent answered the ${input.role} request in time`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (sha(fs.readFileSync(promptFile, 'utf8')) !== sha(text)) fail(`the ${input.role} prompt file was changed while the subagent ran`);
    return { status: 0 };
  };
}

// Used by `approve.js next`: the open request, or null.
function openRequest(dir) {
  let request;
  try { request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')); } catch (_) { return null; }
  return fs.existsSync(path.join(dir, `done-${request.id}`)) ? null : request;
}

// Marks the open request answered; refuses any other id.
function markDone(dir, id) {
  const request = openRequest(dir);
  if (!request || String(request.id) !== String(id)) throw new Error(`request ${id} is not open`);
  write(path.join(dir, `done-${request.id}`), '');
}

module.exports = { requester, openRequest, markDone };
