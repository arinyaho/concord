'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const core = require('../../adapters/claude-code/review-telemetry');
const reviewTelemetry = require('../../core/review-telemetry');
const HOOK = path.join(__dirname, '..', 'review-telemetry.js');

function setup(round = 2) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-review-telemetry-'));
  const transcript = path.join(project, 'session.jsonl');
  const stateDir = path.join(project, 'state');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(path.join(stateDir, 'review-feat-x.json'), JSON.stringify({
    target: { ref: 'feat/x' },
    status: 'converging',
    phase: 'gates',
    round,
  }));
  return { transcript, stateDir };
}

function event({ transcript, id = 'toolu_01', tool = 'Agent', hook = 'PostToolUse', prompt, response, durationMs } = {}) {
  return {
    hook_event_name: hook,
    session_id: 'session',
    transcript_path: transcript,
    tool_name: tool,
    tool_use_id: id,
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    tool_input: {
      model: 'sonnet',
      prompt,
    },
    ...(response === undefined ? {} : { tool_response: response }),
  };
}

function successfulResponse() {
  return {
    agentId: 'agent-7',
    resolvedModel: 'claude-sonnet-4-5-20250929',
    status: 'completed',
    totalDurationMs: 1250,
    totalTokens: 165,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 15,
    },
  };
}

function writeSubagentTranscript(parentTranscript, rows) {
  const directory = path.join(path.dirname(parentTranscript), 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const transcript = path.join(directory, 'agent-agent-7.jsonl');
  fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return transcript;
}

function assistantRow({ requestId, messageId, model = 'claude-sonnet-4-5-20250929', input, create, read, output, content = [{ type: 'text', text: 'done' }] }) {
  return {
    type: 'assistant',
    agentId: 'agent-7',
    requestId,
    version: '2.1.268',
    message: {
      id: messageId,
      model,
      content,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: create,
        cache_read_input_tokens: read,
        output_tokens: output,
      },
    },
  };
}

test('joins SubagentStop transcript totals but stays partial without a telemetry slot', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 10, create: 20, read: 30, output: 1, content: [{ type: 'tool_use' }] }),
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 10, create: 20, read: 30, output: 5, content: [{ type: 'tool_use' }] }),
    assistantRow({ requestId: 'req-2', messageId: 'msg-2', input: 3, create: 4, read: 5, output: 6 }),
  ]);
  const response = successfulResponse();
  Object.assign(response, {
    totalTokens: 18,
    usage: { input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5, output_tokens: 6 },
  });
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, hook: 'PreToolUse', prompt }), stateDir));
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response }), stateDir));
  const stopped = core.recordForEvent({
    hook_event_name: 'SubagentStop',
    session_id: 'session',
    transcript_path: transcript,
    agent_id: 'agent-7',
    agent_type: 'general-purpose',
    agent_transcript_path: childTranscript,
  }, stateDir);

  assert.strictEqual(core.writeRecord(stateDir, stopped), true);
  const ledger = reviewTelemetry.foldTelemetry(stateDir, JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8')));
  assert.deepStrictEqual(ledger.telemetry.entries[0], {
    engine: 'claude-code',
    targetRef: 'feat/x',
    role: 'correctness',
    round: 2,
    artifactPath: path.join(stateDir, 'round-2-correctness.json'),
    attempt: null,
    invocationId: 'toolu_01',
    agentId: 'agent-7',
    requestedModel: 'sonnet',
    resolvedModel: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    providerSchema: 'claude-subagent-transcript-2.1.268-v1',
    status: 'completed',
    elapsedMs: 1250,
    inputTokens: 13,
    cacheWriteInputTokens: 24,
    cachedInputTokens: 35,
    reasoningOutputTokens: null,
    outputTokens: 11,
    totalTokens: 83,
    usagePartial: true,
    providerUsage: {
      input_tokens: 13,
      cache_creation_input_tokens: 24,
      cache_read_input_tokens: 35,
      output_tokens: 11,
    },
  });

  const escapedTranscript = path.join(path.dirname(transcript), 'agent-outside.jsonl');
  fs.writeFileSync(escapedTranscript, JSON.stringify(assistantRow({ requestId: 'req-x', messageId: 'msg-x', input: 1, create: 0, read: 0, output: 1 })));
  const stoppedEvent = {
    hook_event_name: 'SubagentStop', session_id: 'session', transcript_path: transcript,
    agent_id: 'agent-7', agent_type: 'general-purpose', agent_transcript_path: escapedTranscript,
  };
  assert.strictEqual(core.recordForEvent(stoppedEvent, stateDir).usagePartial, true);

  const malformedTranscript = writeSubagentTranscript(transcript, ['not-json']);
  fs.writeFileSync(malformedTranscript, 'not-json\n');
  assert.strictEqual(core.recordForEvent({ ...stoppedEvent, agent_transcript_path: malformedTranscript }, stateDir).usagePartial, true);
});

test('uses only the exact single Write ONLY destination, never an earlier input path', () => {
  const { transcript, stateDir } = setup();
  const correctness = path.join(stateDir, 'round-2-correctness.json');
  const verify = path.join(stateDir, 'round-2-verify.json');
  const prompt = `Re-review candidates in ${correctness}. Write ONLY {"status":"ok"} to ${verify}`;
  assert.strictEqual(core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir).role, 'verify');
  assert.strictEqual(core.recordForEvent(event({ transcript, prompt: `${prompt}. Write ONLY JSON to ${correctness}`, response: successfulResponse() }), stateDir), null);
});

test('recognizes the manual Claude intent output directive', () => {
  const { transcript, stateDir } = setup();
  const intent = path.join(stateDir, 'round-2-intent.json');
  const prompt = `You are a design-conformance detector. Write a JSON file to ${intent} of the form {"status":"ok","findings":[]}.`;
  const record = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);

  assert.strictEqual(record.role, 'intent');
  assert.strictEqual(record.artifactPath, intent);
});

test('marks a transcript ending at an assistant tool-use response partial', () => {
  const { transcript, stateDir } = setup();
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 1, create: 0, read: 0, output: 1, content: [{ type: 'tool_use' }] }),
  ]);
  const record = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
  }, stateDir);
  assert.strictEqual(record.usagePartial, true);
});

test('waits within the bound for a delayed stable terminal transcript append', async () => {
  const { transcript, stateDir } = setup();
  const directory = path.join(path.dirname(transcript), 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const childTranscript = path.join(directory, 'agent-agent-7.jsonl');
  fs.writeFileSync(childTranscript, '');
  const row = JSON.stringify(assistantRow({ requestId: 'req-late', messageId: 'msg-late', input: 2, create: 0, read: 0, output: 1 })) + '\n';
  const writer = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").appendFileSync(process.argv[1], process.argv[2]), 140)', childTranscript, row]);

  const record = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
  }, stateDir);
  await new Promise((resolve) => writer.once('exit', resolve));

  assert.strictEqual(record.usagePartial, false);
  assert.strictEqual(record.totalTokens, 3);
});

test('stores repeated SubagentStop observations append-only and folds the invocation as partial', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 1, create: 0, read: 0, output: 1 }),
  ]);
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir));
  const stop = { hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript };
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(stop, stateDir)), true);
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(stop, stateDir)), true);
  assert.strictEqual(fs.readdirSync(stateDir).filter((name) => name.startsWith('review-agent-telemetry-')).length, 2);
  const ledger = reviewTelemetry.foldTelemetry(stateDir, JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8')));
  assert.strictEqual(ledger.telemetry.entries[0].usagePartial, true);
});

test('does not persist a SubagentStop without a matching review tool', () => {
  const { transcript, stateDir } = setup();
  const record = core.recordForEvent({ hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'unrelated-agent' }, stateDir);

  assert.strictEqual(core.writeRecord(stateDir, record), false);
  assert.deepStrictEqual(fs.readdirSync(stateDir).filter((name) => name.startsWith('review-agent-telemetry-')), []);
});

test('marks repeated terminal tool hooks partial instead of discarding the duplicate', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 100, create: 20, read: 30, output: 15 }),
  ]);
  const completed = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);
  assert.strictEqual(core.writeRecord(stateDir, completed), true);
  assert.strictEqual(core.writeRecord(stateDir, completed), false);
  core.writeRecord(stateDir, core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
  }, stateDir));

  const ledger = reviewTelemetry.foldTelemetry(stateDir, JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8')));

  assert.strictEqual(ledger.telemetry.entries[0].usagePartial, true);
});

test('retains successful PostToolUse usage as a partial final-request audit', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  const record = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);

  assert.deepStrictEqual(record, {
    kind: 'tool-use',
    engine: 'claude-code',
    targetRef: 'feat/x',
    role: 'correctness',
    round: 2,
    artifactPath: path.join(stateDir, 'round-2-correctness.json'),
    attempt: null,
    invocationId: 'toolu_01',
    agentId: 'agent-7',
    requestedModel: 'sonnet',
    resolvedModel: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    providerSchema: 'claude-agent-hook-v1',
    status: 'completed',
    elapsedMs: 1250,
    inputTokens: 100,
    cacheWriteInputTokens: 20,
    cachedInputTokens: 30,
    reasoningOutputTokens: null,
    outputTokens: 15,
    totalTokens: 165,
    usagePartial: true,
    hookUsagePartial: false,
    providerUsage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 15,
    },
  });
});

test('records launch and terminal hook evidence as partial until SubagentStop arrives', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  const started = core.recordForEvent(event({ transcript, hook: 'PreToolUse', prompt }), stateDir);

  assert.strictEqual(started.status, 'started');
  assert.strictEqual(started.usagePartial, true);
  assert.strictEqual(started.totalTokens, null);
  assert.strictEqual(core.writeRecord(stateDir, started), true);

  const completed = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);
  assert.strictEqual(core.writeRecord(stateDir, completed), true);
  const ledger = reviewTelemetry.foldTelemetry(stateDir, JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8')));
  assert.strictEqual(ledger.telemetry.calls, 1);
  assert.strictEqual(ledger.telemetry.partialCalls, 1);
  assert.strictEqual(ledger.telemetry.entries[0].status, 'completed');
});

test('retains failed and inconsistent invocations as partial telemetry', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-verify.json')}`;
  const failed = core.recordForEvent(event({ transcript, id: 'failure-1', tool: 'Task', hook: 'PostToolUseFailure', prompt, durationMs: 42 }), stateDir);
  assert.strictEqual(failed.role, 'verify');
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.elapsedMs, 42);
  assert.strictEqual(failed.usagePartial, true);
  assert.strictEqual(failed.totalTokens, null);

  const response = successfulResponse();
  response.totalTokens = 999;
  const inconsistent = core.recordForEvent(event({ transcript, id: 'bad-total', prompt, response }), stateDir);
  assert.strictEqual(inconsistent.usagePartial, true);
  assert.strictEqual(inconsistent.totalTokens, 999);
});

test('folding a complete hook with an unreadable transcript is fail-soft and partial', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir));
  const partial = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: path.join(path.dirname(transcript), 'missing.jsonl'),
  }, stateDir);
  core.writeRecord(stateDir, partial);

  const ledger = reviewTelemetry.foldTelemetry(stateDir, JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8')));

  assert.strictEqual(ledger.telemetry.calls, 1);
  assert.strictEqual(ledger.telemetry.partialCalls, 1);
});

test('a malformed telemetry artifact cannot disappear into a clean fold', () => {
  const { stateDir } = setup();
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8'));
  ledger.telemetrySlots = [{ artifactPath: path.join(stateDir, 'round-2-correctness.json'), attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(path.join(stateDir, `review-telemetry-${'f'.repeat(64)}.json`), 'not json');

  const folded = reviewTelemetry.foldTelemetry(stateDir, ledger);

  assert.strictEqual(folded.telemetry.partialCalls, 2);
  assert.ok(folded.telemetry.entries.some((entry) => entry.status === 'malformed'));
});

test('ignores unrelated prompts, inactive rounds, unsupported tools, and path traversal', () => {
  const { transcript, stateDir } = setup();
  const response = successfulResponse();
  assert.strictEqual(core.recordForEvent(event({ transcript, prompt: 'Investigate the repository', response }), stateDir), null);
  assert.strictEqual(core.recordForEvent(event({ transcript, tool: 'Read', prompt: `Write to ${path.join(stateDir, 'round-2-correctness.json')}`, response }), stateDir), null);
  assert.strictEqual(core.recordForEvent(event({ transcript, prompt: `Write to ${path.join(stateDir, 'round-3-correctness.json')}`, response }), stateDir), null);
  assert.strictEqual(core.recordForEvent(event({ transcript, prompt: `Write to ${path.join(stateDir, '..', 'round-2-correctness.json')}`, response }), stateDir), null);
});

test('ignores stale idle ledgers when associating an active invocation', () => {
  const { transcript, stateDir } = setup();
  fs.writeFileSync(path.join(stateDir, 'review-stale.json'), JSON.stringify({
    target: { ref: 'feat/stale' }, status: 'converging', phase: 'idle', round: 2,
  }));
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;

  const record = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);

  assert.strictEqual(record.targetRef, 'feat/x');
});

test('hook writes one atomic record per tool-use identity and emits no output', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  for (const id of ['parallel-a', 'parallel-b', 'parallel-a']) {
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      input: JSON.stringify(event({ transcript, id, prompt, response: successfulResponse() })),
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
  }

  const files = fs.readdirSync(stateDir).filter((name) => name.startsWith('review-telemetry-')).sort();
  assert.strictEqual(files.length, 2);
  const records = files.map((name) => JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')));
  assert.deepStrictEqual(records.map((record) => record.invocationId).sort(), ['parallel-a', 'parallel-b']);
});

test('folds matching records into the active ledger once', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  const record = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);
  core.writeRecord(stateDir, record);

  const ledger = reviewTelemetry.foldTelemetry(stateDir, JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8')));
  const replay = reviewTelemetry.foldTelemetry(stateDir, ledger);

  assert.strictEqual(replay.telemetry.calls, 1);
  assert.strictEqual(replay.telemetry.partialCalls, 1);
  assert.strictEqual(replay.telemetry.totalTokens, 165);
  assert.strictEqual(replay.telemetry.reasoningOutputTokens, null);
  assert.strictEqual(replay.telemetry.byRole.correctness.calls, 1);
  assert.deepStrictEqual(replay.telemetry.entries.map((entry) => entry.invocationId), ['toolu_01']);
});

test('a persisted attempt slot with its entire hook missing remains visible and partial', () => {
  const { stateDir } = setup();
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.telemetrySlots = [{ artifactPath: path.join(stateDir, 'round-2-correctness.json'), attempt: 1, role: 'correctness', round: 2 }];

  const folded = reviewTelemetry.foldTelemetry(stateDir, ledger);

  assert.strictEqual(folded.telemetry.calls, 1);
  assert.strictEqual(folded.telemetry.partialCalls, 1);
  assert.strictEqual(folded.telemetry.entries[0].status, 'missing');
  assert.strictEqual(folded.telemetry.entries[0].attempt, 1);
});

test('Claude hook manifest registers tool telemetry and SubagentStop', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8'));
  for (const hook of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    assert.strictEqual(manifest.hooks[hook].length, 1);
    assert.strictEqual(manifest.hooks[hook][0].matcher, 'Agent|Task');
    assert.match(manifest.hooks[hook][0].hooks[0].command, /review-telemetry\.js/);
  }
  assert.strictEqual(manifest.hooks.SubagentStop.length, 1);
  assert.match(manifest.hooks.SubagentStop[0].hooks[0].command, /review-telemetry\.js/);
});
