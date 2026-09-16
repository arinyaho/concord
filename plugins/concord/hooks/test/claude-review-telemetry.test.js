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

function recordActiveTool(transcript, stateDir) {
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir));
}

function writeSubagentTranscript(parentTranscript, rows) {
  const directory = path.join(path.dirname(parentTranscript), path.basename(parentTranscript, '.jsonl'), 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const transcript = path.join(directory, 'agent-agent-7.jsonl');
  fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return transcript;
}

function assistantRow({ requestId, messageId, model = 'claude-sonnet-4-5-20250929', version = '2.1.268', input, create, read, output, content = [{ type: 'text', text: 'done' }], iterations = [{}] }) {
  return {
    type: 'assistant',
    agentId: 'agent-7',
    requestId,
    version,
    message: {
      id: messageId,
      model,
      content,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: create,
        cache_read_input_tokens: read,
        output_tokens: output,
        ...(iterations === null ? {} : { iterations }),
      },
    },
  };
}

test('surfaces an unsupported Claude CLI transcript version separately from generic partial usage', () => {
  const { transcript, stateDir } = setup();
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(path.join(stateDir, 'review-feat-x.json'), JSON.stringify(ledger));
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt: `Write ONLY to ${artifactPath}`, response: successfulResponse() }), stateDir));
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', version: '2.1.269', input: 1, create: 0, read: 0, output: 1 }),
  ]);
  core.writeRecord(stateDir, core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir));

  const telemetry = reviewTelemetry.foldTelemetry(stateDir, ledger).telemetry;

  assert.strictEqual(telemetry.entries[0].usageStatus, 'unsupported-cli-version');
  assert.strictEqual(telemetry.entries[0].cliVersion, '2.1.269');
  assert.deepStrictEqual(telemetry.unsupportedCliVersions, ['2.1.269']);
  assert.strictEqual(telemetry.unsupportedCliVersionCalls, 1);
});

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

test('audits multi-request transcript totals against final-request Agent hook usage', () => {
  const { transcript, stateDir } = setup();
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const prompt = `Write ONLY to ${artifactPath}`;
  const response = successfulResponse();
  response.totalTokens = 15;
  response.usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 };
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response }), stateDir));
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 90, create: 20, read: 30, output: 10, content: [{ type: 'tool_use' }] }),
    assistantRow({ requestId: 'req-2', messageId: 'msg-2', input: 10, create: 0, read: 0, output: 5 }),
  ]);
  core.writeRecord(stateDir, core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir));

  const entry = reviewTelemetry.foldTelemetry(stateDir, ledger).telemetry.entries[0];

  assert.deepStrictEqual({ totalTokens: entry.totalTokens, usagePartial: entry.usagePartial }, {
    totalTokens: 165, usagePartial: false,
  });
});

test('uses only the exact single Write ONLY destination, never an earlier input path', () => {
  const { transcript, stateDir } = setup();
  const correctness = path.join(stateDir, 'round-2-correctness.json');
  const verify = path.join(stateDir, 'round-2-verify.json');
  const prompt = `Re-review candidates in ${correctness}. Write ONLY {"status":"ok"} to ${verify}`;
  assert.strictEqual(core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir).role, 'verify');
  assert.strictEqual(core.recordForEvent(event({ transcript, prompt: `${prompt}. Write ONLY JSON to ${correctness}`, response: successfulResponse() }), stateDir), null);
});

test('accepts the driver documented backtick-quoted output path', () => {
  const { transcript, stateDir } = setup();
  const verify = path.join(stateDir, 'round-2-verify.json');
  const prompt = `Write ONLY {"status":"ok"} to \`${verify}\``;

  const record = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);

  assert.strictEqual(record.role, 'verify');
  assert.strictEqual(record.artifactPath, verify);
});

test('accepts a real ledger whose target slug begins with telemetry-', () => {
  const { transcript, stateDir } = setup();
  fs.unlinkSync(path.join(stateDir, 'review-feat-x.json'));
  fs.writeFileSync(path.join(stateDir, 'review-telemetry-cleanup.json'), JSON.stringify({
    target: { ref: 'telemetry-cleanup' }, status: 'converging', phase: 'gates', round: 2,
  }));
  const correctness = path.join(stateDir, 'round-2-correctness.json');

  const record = core.recordForEvent(event({ transcript, prompt: `Write ONLY to ${correctness}`, response: successfulResponse() }), stateDir);

  assert.strictEqual(record.targetRef, 'telemetry-cleanup');
});

test('uses the artifact telemetry slot when another ref has a stale active ledger at the same round', () => {
  const { transcript, stateDir } = setup();
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  fs.writeFileSync(path.join(stateDir, 'review-stale.json'), JSON.stringify({
    target: { ref: 'feat/stale' }, status: 'converging', phase: 'gates', round: 2,
  }));

  const record = core.recordForEvent(event({ transcript, prompt: `Write ONLY to ${artifactPath}`, response: successfulResponse() }), stateDir);

  assert.strictEqual(record.targetRef, 'feat/x');
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
  recordActiveTool(transcript, stateDir);
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 1, create: 0, read: 0, output: 1, content: [{ type: 'tool_use' }] }),
  ]);
  const record = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
  }, stateDir);
  assert.strictEqual(record.usagePartial, true);
});

test('marks a stable terminal request partial when its final usage snapshot lacks iterations', () => {
  const { transcript, stateDir } = setup();
  recordActiveTool(transcript, stateDir);
  const row = assistantRow({ requestId: 'req-stream', messageId: 'msg-stream', input: 9, create: 0, read: 0, output: 2 });
  delete row.message.usage.iterations;
  const childTranscript = writeSubagentTranscript(transcript, [row]);

  const record = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir);

  assert.strictEqual(record.usagePartial, true);
});

test('waits within the bound for a delayed stable terminal transcript append', async () => {
  const { transcript, stateDir } = setup();
  recordActiveTool(transcript, stateDir);
  const directory = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const childTranscript = path.join(directory, 'agent-agent-7.jsonl');
  fs.writeFileSync(childTranscript, '');
  const row = JSON.stringify(assistantRow({ requestId: 'req-late', messageId: 'msg-late', input: 2, create: 0, read: 0, output: 1 })) + '\n';
  const writer = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").appendFileSync(process.argv[1], process.argv[2]), 140)', childTranscript, row]);

  const record = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
    last_assistant_message: 'done',
  }, stateDir);
  await new Promise((resolve) => writer.once('exit', resolve));

  assert.strictEqual(record.usagePartial, false);
  assert.strictEqual(record.totalTokens, 3);
});

test('waits for the transcript row matching SubagentStop last_assistant_message', async () => {
  const { transcript, stateDir } = setup();
  recordActiveTool(transcript, stateDir);
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-stream', messageId: 'msg-stream', input: 1, create: 0, read: 0, output: 1, content: [{ type: 'text', text: 'draft' }] }),
  ]);
  const finalRow = JSON.stringify(assistantRow({ requestId: 'req-stream', messageId: 'msg-stream', input: 1, create: 0, read: 0, output: 5, content: [{ type: 'text', text: 'final' }] })) + '\n';
  const writer = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").appendFileSync(process.argv[1], process.argv[2]), 140)', childTranscript, finalRow]);

  const record = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
    last_assistant_message: 'final',
  }, stateDir);
  await new Promise((resolve) => writer.once('exit', resolve));

  assert.strictEqual(record.usagePartial, false);
  assert.strictEqual(record.totalTokens, 6);
});

test('marks inconsistent repeated request rows partial', () => {
  const { transcript, stateDir } = setup();
  recordActiveTool(transcript, stateDir);
  const cases = [
    ['model change',
      assistantRow({ requestId: 'req-model', messageId: 'msg-model', model: 'model-a', input: 10, create: 2, read: 3, output: 4, content: [{ type: 'text', text: 'draft' }] }),
      assistantRow({ requestId: 'req-model', messageId: 'msg-model', model: 'model-b', input: 10, create: 2, read: 3, output: 5 })],
    ['usage decrease',
      assistantRow({ requestId: 'req-usage', messageId: 'msg-usage', input: 10, create: 2, read: 3, output: 4, content: [{ type: 'text', text: 'draft' }] }),
      assistantRow({ requestId: 'req-usage', messageId: 'msg-usage', input: 9, create: 2, read: 3, output: 5 })],
  ];

  for (const [label, first, second] of cases) {
    const childTranscript = writeSubagentTranscript(transcript, [first, second]);
    const record = core.recordForEvent({
      hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
      agent_transcript_path: childTranscript, last_assistant_message: 'done',
    }, stateDir);

    assert.strictEqual(record.usagePartial, true, label);
  }
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

  assert.strictEqual(record, null);
  assert.deepStrictEqual(fs.readdirSync(stateDir).filter((name) => name.startsWith('review-agent-telemetry-')), []);
});

test('does not read a subagent transcript when no review ledger is active', () => {
  const { transcript, stateDir } = setup();
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  fs.writeFileSync(ledgerPath, JSON.stringify({ ...ledger, status: 'clean' }));
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 1, create: 0, read: 0, output: 1 }),
  ]);
  const resolvedChildTranscript = fs.realpathSync(childTranscript);
  const readFileSync = fs.readFileSync;
  let transcriptReads = 0;
  fs.readFileSync = (...args) => {
    if (args[0] === resolvedChildTranscript) transcriptReads++;
    return readFileSync(...args);
  };
  try {
    assert.strictEqual(core.recordForEvent({
      hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
    }, stateDir), null);
  } finally {
    fs.readFileSync = readFileSync;
  }
  assert.strictEqual(transcriptReads, 0);
});

test('preserves a foreground SubagentStop until PostToolUse supplies the exact agent identity', () => {
  const { transcript, stateDir } = setup();
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const prompt = `Write ONLY to ${artifactPath}`;

  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, hook: 'PreToolUse', prompt }), stateDir)), true);
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 1, create: 2, read: 3, output: 4 }),
  ]);
  const stopped = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir);
  assert.strictEqual(core.writeRecord(stateDir, stopped), true);

  const beforePost = reviewTelemetry.foldTelemetry(stateDir, ledger).telemetry.entries;
  assert.deepStrictEqual(beforePost.map(({ invocationId, agentId, status, usagePartial }) => ({ invocationId, agentId, status, usagePartial })), [{
    invocationId: 'toolu_01', agentId: null, status: 'started', usagePartial: true,
  }]);

  const response = successfulResponse();
  response.totalTokens = 10;
  response.usage = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response }), stateDir)), true);
  const afterPost = reviewTelemetry.foldTelemetry(stateDir, ledger).telemetry.entries;
  assert.deepStrictEqual(afterPost.map(({ invocationId, agentId, status, totalTokens, usagePartial }) => ({ invocationId, agentId, status, totalTokens, usagePartial })), [{
    invocationId: 'toolu_01', agentId: 'agent-7', status: 'completed', totalTokens: 10, usagePartial: false,
  }]);
});

test('defers pending SubagentStop parsing and discards a concurrent unrelated agent once PostToolUse identifies the reviewer', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, hook: 'PreToolUse', prompt }), stateDir)), true);

  const unrelatedTranscript = writeSubagentTranscript(transcript, [
    { ...assistantRow({ requestId: 'req-other', messageId: 'msg-other', input: 50, create: 0, read: 0, output: 5 }), agentId: 'agent-other' },
  ]);
  const unrelated = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-other',
    agent_transcript_path: unrelatedTranscript, last_assistant_message: 'done',
  }, stateDir);
  assert.deepStrictEqual({ totalTokens: unrelated.totalTokens, usagePartial: unrelated.usagePartial }, { totalTokens: null, usagePartial: true });
  assert.strictEqual(core.writeRecord(stateDir, unrelated), true);

  const reviewerTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-review', messageId: 'msg-review', input: 1, create: 2, read: 3, output: 4 }),
  ]);
  const reviewer = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
    agent_transcript_path: reviewerTranscript, last_assistant_message: 'done',
  }, stateDir);
  assert.strictEqual(core.writeRecord(stateDir, reviewer), true);

  const response = successfulResponse();
  response.totalTokens = 10;
  response.usage = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response }), stateDir)), true);

  const agents = fs.readdirSync(stateDir).filter((name) => name.startsWith('review-agent-telemetry-'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')));
  assert.deepStrictEqual(agents.map(({ agentId, totalTokens }) => ({ agentId, totalTokens })), [{ agentId: 'agent-7', totalTokens: 10 }]);
});

test('uses the agent transcript prompt to associate a stop with one of several parallel review tools', () => {
  const { transcript, stateDir } = setup();
  const correctness = path.join(stateDir, 'round-2-correctness.json');
  const gate = path.join(stateDir, 'round-2-gate.json');
  const correctnessPrompt = `Write ONLY to ${correctness}`;
  const gatePrompt = `Write ONLY to ${gate}`;
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, id: 'tool-correctness', hook: 'PreToolUse', prompt: correctnessPrompt }), stateDir)), true);
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, id: 'tool-gate', hook: 'PreToolUse', prompt: gatePrompt }), stateDir)), true);
  const childTranscript = writeSubagentTranscript(transcript, [
    { type: 'user', agentId: 'agent-7', message: { role: 'user', content: gatePrompt } },
    assistantRow({ requestId: 'req-gate', messageId: 'msg-gate', input: 1, create: 2, read: 3, output: 4 }),
  ]);

  const stopped = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir);

  assert.strictEqual(stopped.pendingInvocationId, 'tool-gate');
  assert.strictEqual(core.writeRecord(stateDir, stopped), true);
});

test('deleteTelemetry removes a deferred agent observation when its pending tool never completes', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, hook: 'PreToolUse', prompt }), stateDir)), true);
  const childTranscript = writeSubagentTranscript(transcript, [
    { ...assistantRow({ requestId: 'req-other', messageId: 'msg-other', input: 1, create: 0, read: 0, output: 1 }), agentId: 'agent-other' },
  ]);
  const stopped = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-other',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir);
  assert.strictEqual(core.writeRecord(stateDir, stopped), true);

  reviewTelemetry.deleteTelemetry(stateDir, 'feat/x', 'feat-x');

  assert.deepStrictEqual(fs.readdirSync(stateDir).filter((name) => name.startsWith('review-agent-telemetry-')), []);
});

test('does not let a pending review tool preserve a stop from another parent transcript', () => {
  const { transcript, stateDir } = setup();
  const foreign = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  assert.strictEqual(core.writeRecord(stateDir, core.recordForEvent(event({ transcript, hook: 'PreToolUse', prompt }), stateDir)), true);
  const childTranscript = writeSubagentTranscript(foreign.transcript, [
    assistantRow({ requestId: 'req-foreign', messageId: 'msg-foreign', input: 1, create: 0, read: 0, output: 1 }),
  ]);
  const stopped = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: foreign.transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir);

  assert.strictEqual(core.writeRecord(stateDir, stopped), false);
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

test('retains successful PostToolUse usage as a partial aggregate audit', () => {
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
    parentTranscriptPath: path.resolve(transcript),
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

test('joins a background launch with observed completion status and elapsed time', () => {
  const { transcript, stateDir } = setup();
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const prompt = `Write ONLY to ${artifactPath}`;
  const started = core.recordForEvent(event({ transcript, hook: 'PreToolUse', prompt }), stateDir);
  assert.ok(Number.isSafeInteger(started.startedAtMs));
  started.startedAtMs = 100;
  core.writeRecord(stateDir, started);
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response: { agentId: 'agent-7', status: 'async_launched' } }), stateDir));
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 1, create: 0, read: 0, output: 1 }),
  ]);
  const stopped = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7', agent_transcript_path: childTranscript,
    last_assistant_message: 'done',
  }, stateDir);
  assert.ok(Number.isSafeInteger(stopped.stoppedAtMs));
  stopped.stoppedAtMs = 350;
  core.writeRecord(stateDir, stopped);

  const entry = reviewTelemetry.foldTelemetry(stateDir, ledger).telemetry.entries[0];
  assert.deepStrictEqual({ status: entry.status, elapsedMs: entry.elapsedMs, usagePartial: entry.usagePartial }, {
    status: 'completed', elapsedMs: 250, usagePartial: false,
  });
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
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath: path.join(stateDir, 'round-2-correctness.json'), attempt: 1, role: 'correctness', round: 2 }];
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

test('allocates the same attempt slot independently for sequential review targets', () => {
  const { transcript, stateDir } = setup();
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const firstLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  firstLedger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(ledgerPath, JSON.stringify(firstLedger));
  const prompt = `Write ONLY to ${artifactPath}`;
  const first = core.recordForEvent(event({ transcript, id: 'target-a', prompt, response: successfulResponse() }), stateDir);
  assert.deepStrictEqual({ targetRef: first.targetRef, attempt: first.attempt }, { targetRef: 'feat/x', attempt: 1 });
  assert.strictEqual(core.writeRecord(stateDir, first), true);

  fs.writeFileSync(ledgerPath, JSON.stringify({ ...firstLedger, target: { ref: 'feat/y' } }));
  const second = core.recordForEvent(event({ transcript, id: 'target-b', prompt, response: successfulResponse() }), stateDir);

  assert.deepStrictEqual({ invocationId: second.invocationId, targetRef: second.targetRef, attempt: second.attempt }, {
    invocationId: 'target-b', targetRef: 'feat/y', attempt: 1,
  });
});

test('hook writes one atomic record per tool-use identity and emits no output', () => {
  const { transcript, stateDir } = setup();
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;
  for (const id of ['parallel-a', 'parallel-b', 'parallel-a']) {
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, REVIEW_STATE_DIR: '' },
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

test('hook writes telemetry to an explicit REVIEW_STATE_DIR override', () => {
  const { transcript, stateDir: transcriptStateDir } = setup();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-review-override-'));
  fs.copyFileSync(path.join(transcriptStateDir, 'review-feat-x.json'), path.join(stateDir, 'review-feat-x.json'));
  const prompt = `Write ONLY to ${path.join(stateDir, 'round-2-correctness.json')}`;

  const result = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    env: { ...process.env, REVIEW_STATE_DIR: stateDir },
    input: JSON.stringify(event({ transcript, id: 'override-record', prompt, response: successfulResponse() })),
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
  const records = fs.readdirSync(stateDir)
    .filter((name) => name.startsWith('review-telemetry-'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')).invocationId);
  assert.deepStrictEqual(records, ['override-record']);
  assert.deepStrictEqual(fs.readdirSync(transcriptStateDir).filter((name) => name.startsWith('review-telemetry-')), []);
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

test('ignores agent observations belonging to another review target', () => {
  const { transcript, stateDir } = setup();
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(path.join(stateDir, 'review-feat-x.json'), JSON.stringify(ledger));
  const prompt = `Write ONLY to ${artifactPath}`;
  const tool = core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir);
  core.writeRecord(stateDir, tool);
  const childTranscript = writeSubagentTranscript(transcript, [
    assistantRow({ requestId: 'req-1', messageId: 'msg-1', input: 100, create: 20, read: 30, output: 15 }),
  ]);
  const agent = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir);
  core.writeRecord(stateDir, agent);
  fs.writeFileSync(path.join(stateDir, `review-telemetry-${'d'.repeat(64)}.json`), JSON.stringify({
    ...tool, targetRef: 'feat/other', invocationId: 'other-tool', agentId: 'other-agent',
  }));
  fs.writeFileSync(path.join(stateDir, `review-agent-telemetry-${'e'.repeat(64)}.json`), JSON.stringify({
    ...agent, agentId: 'other-agent', observationId: 'other-observation',
  }));

  const folded = reviewTelemetry.foldTelemetry(stateDir, ledger);

  assert.deepStrictEqual(folded.telemetry.entries.map((entry) => entry.agentId), ['agent-7']);
  assert.strictEqual(folded.telemetry.partialCalls, 0);
});

test('does not join a reused agent identity from another parent transcript', () => {
  const { transcript, stateDir } = setup();
  const foreign = setup();
  const artifactPath = path.join(stateDir, 'round-2-correctness.json');
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'review-feat-x.json'), 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath, attempt: 1, role: 'correctness', round: 2 }];
  fs.writeFileSync(path.join(stateDir, 'review-feat-x.json'), JSON.stringify(ledger));
  const prompt = `Write ONLY to ${artifactPath}`;
  core.writeRecord(stateDir, core.recordForEvent(event({ transcript, prompt, response: successfulResponse() }), stateDir));
  const childTranscript = writeSubagentTranscript(foreign.transcript, [
    assistantRow({ requestId: 'req-foreign', messageId: 'msg-foreign', input: 1, create: 0, read: 0, output: 1 }),
  ]);
  const foreignAgent = core.recordForEvent({
    hook_event_name: 'SubagentStop', transcript_path: foreign.transcript, agent_id: 'agent-7',
    agent_transcript_path: childTranscript, last_assistant_message: 'done',
  }, stateDir);
  assert.strictEqual(foreignAgent, null);

  const entry = reviewTelemetry.foldTelemetry(stateDir, ledger).telemetry.entries[0];

  assert.deepStrictEqual({ providerSchema: entry.providerSchema, totalTokens: entry.totalTokens, usagePartial: entry.usagePartial }, {
    providerSchema: 'claude-agent-hook-v1', totalTokens: 165, usagePartial: true,
  });
});

test('deleteTelemetry retains a reused agent identity owned by another target', () => {
  const { transcript, stateDir } = setup();
  const foreignTranscript = path.join(path.dirname(transcript), 'foreign.jsonl');
  const usage = { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };
  const tool = (targetRef, invocationId, parentTranscriptPath) => ({
    kind: 'tool-use', engine: 'claude-code', provider: 'anthropic', targetRef, role: 'correctness', round: 2,
    artifactPath: path.join(stateDir, `round-2-${invocationId}.json`), attempt: 1, invocationId,
    agentId: 'agent-reused', parentTranscriptPath, startedAtMs: 1, status: 'completed',
    hookUsagePartial: false, elapsedMs: null, totalTokens: 19, providerUsage: usage,
  });
  const agent = (observationId, parentTranscriptPath) => ({
    kind: 'agent-usage', engine: 'claude-code', provider: 'anthropic', agentId: 'agent-reused', observationId,
    parentTranscriptPath, stoppedAtMs: 13, providerSchema: 'claude-subagent-transcript-2.1.268-v1',
    status: 'stopped', resolvedModel: 'claude-sonnet-4-5-20250929', inputTokens: 10,
    cacheWriteInputTokens: 2, cachedInputTokens: 3, reasoningOutputTokens: null, outputTokens: 4,
    totalTokens: 19, usagePartial: false, providerUsage: usage,
  });
  const records = {
    targetTool: path.join(stateDir, `review-telemetry-${'a'.repeat(64)}.json`),
    foreignTool: path.join(stateDir, `review-telemetry-${'b'.repeat(64)}.json`),
    targetAgent: path.join(stateDir, `review-agent-telemetry-${'c'.repeat(64)}.json`),
    foreignAgent: path.join(stateDir, `review-agent-telemetry-${'d'.repeat(64)}.json`),
  };
  const targetTool = tool('feat/x', 'tool-target', transcript);
  const foreignTool = tool('feat/y', 'tool-foreign', foreignTranscript);
  fs.writeFileSync(records.targetTool, JSON.stringify(targetTool));
  fs.writeFileSync(records.foreignTool, JSON.stringify(foreignTool));
  fs.writeFileSync(records.targetAgent, JSON.stringify(agent('observation-target', transcript)));
  fs.writeFileSync(records.foreignAgent, JSON.stringify(agent('observation-foreign', foreignTranscript)));

  reviewTelemetry.deleteTelemetry(stateDir, 'feat/x', 'feat-x');

  assert.deepStrictEqual(Object.fromEntries(Object.entries(records).map(([name, file]) => [name, fs.existsSync(file)])), {
    targetTool: false, foreignTool: true, targetAgent: false, foreignAgent: true,
  });
  const foreignLedger = {
    target: { ref: 'feat/y' },
    telemetrySlots: [{ engine: 'claude-code', provider: 'anthropic', artifactPath: foreignTool.artifactPath, attempt: 1, role: 'correctness', round: 2 }],
  };
  const folded = reviewTelemetry.foldTelemetry(stateDir, foreignLedger);
  assert.deepStrictEqual(folded.telemetry.entries.map(({ invocationId, agentId, totalTokens, usagePartial }) => ({ invocationId, agentId, totalTokens, usagePartial })), [{
    invocationId: 'tool-foreign', agentId: 'agent-reused', totalTokens: 19, usagePartial: false,
  }]);
});

test('a persisted attempt slot with its entire hook missing remains visible and partial', () => {
  const { stateDir } = setup();
  const ledgerPath = path.join(stateDir, 'review-feat-x.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.telemetrySlots = [{ engine: 'claude-code', provider: 'anthropic', artifactPath: path.join(stateDir, 'round-2-correctness.json'), attempt: 1, role: 'correctness', round: 2 }];

  const folded = reviewTelemetry.foldTelemetry(stateDir, ledger);

  assert.strictEqual(folded.telemetry.calls, 0);
  assert.strictEqual(folded.telemetry.missingCalls, 1);
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
