// An attempt's trace (v1.0 item 21): what its CLI did, step by step, read from the attempt's activity file.
// Model-free: the fixture lines have the shapes Claude Code 2.1 and Codex CLI print (read from real attempts
// through the controller's log routes on October 23, 2026), shortened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { claudeAdapter, recordClaudeEvent } from '../src/adapters/claude.mjs';
import { codexAdapter, codexCommand } from '../src/adapters/codex.mjs';
import { recordLine } from '../src/adapters/native-process.mjs';
import { attemptTrace, flushSay, noteSay, sayLimits, traceLimits } from '../src/core/attempt-trace.mjs';
import { dashboardAttempt, dashboardOpenPhases } from '../src/core/dashboard-state.mjs';
import { jobDirectory } from '../src/core/projects.mjs';

let attempts = 0;
// A stand-in store: the job folder under a temporary directory, phase events and activity rows as given.
function fixture(t, { phases = [], rows = [], ...fields } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-trace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const attempt = {
      id: `attempt-trace-${++attempts}`,
      taskId: 'T-trace',
      provider: 'claude',
      requestedModel: 'opus',
      reportedModel: 'claude-opus-5-5',
      requestedEffort: 'high',
      status: 'review',
      startedAt: '2026-10-23T03:26:07.000Z',
      finishedAt: '2026-10-23T03:28:25.000Z',
      ...fields,
    },
    store = {
      directory,
      phaseEvents: () => phases.map((payload, index) => ({ time: payload.timestamp, payload, seq: index })),
      attemptEventPage: () => ({ events: rows, nextCursor: null, snapshot: rows.length }),
    },
    job = jobDirectory(store, attempt);
  fs.mkdirSync(job, { recursive: true });
  const write = records =>
    fs.appendFileSync(
      path.join(job, 'activity.jsonl'),
      records
        .map(([time, data, channel = 'stdout']) =>
          JSON.stringify({ time, channel, line: typeof data === 'string' ? data : JSON.stringify(data) }),
        )
        .join('\n') + '\n',
    );
  return { attempt, store, job, write };
}

const at = second => `2026-10-23T03:26:${String(second).padStart(2, '0')}.000Z`;
const assistant = (content, extra = {}) => ({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', role: 'assistant', content },
  ...extra,
});
const result = (id, content, tool_use_result, is_error = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error }] },
  tool_use_result,
});
function claudeLines(job) {
  const inJob = name => path.join(job, ...name.split('/'));
  return [
    [
      at(8),
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-5-5',
        permissionMode: 'acceptEdits',
        claude_code_version: '2.1.309',
        tools: ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'StructuredOutput'],
        mcp_servers: [{ name: 'claude.ai Notion', status: 'pending' }],
        apiKeySource: 'none',
      },
    ],
    [at(9), { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 }],
    [at(10), { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 210, estimated_tokens_delta: 160 }],
    [at(11), assistant([{ type: 'thinking', thinking: '', signature: 'c2ln' }], { thinking_duration_ms: 1840 })],
    [
      at(12),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_ls',
          name: 'Bash',
          input: { command: 'ls ../inputs', description: 'List the inputs' },
        },
      ]),
    ],
    [
      at(12),
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: 1792731600,
          rateLimitType: 'five_hour',
          unifiedWindows: {
            five_hour: { utilization: 0.41, resetsAt: 1792731600 },
            seven_day: { utilization: 0.34, resetsAt: 1792969200 },
          },
        },
      },
    ],
    [
      at(13),
      result('toolu_ls', '0-source-change.json\n1-check-report.json', {
        stdout: '0-source-change.json\n1-check-report.json',
        stderr: '',
        interrupted: false,
      }),
    ],
    [
      at(14),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_test',
          name: 'Bash',
          input: { command: 'node --test', description: 'Run tests' },
        },
      ]),
    ],
    [at(15), result('toolu_test', 'Exit code 1\nnot ok 1 - the folder list', 'Error: Exit code 1', true)],
    [at(16), assistant([{ type: 'text', text: 'One test fails. Reading the report.' }])],
    [
      at(17),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_read',
          name: 'Read',
          input: { file_path: inJob('inputs/1-check-report.json'), offset: 10, limit: 5 },
        },
      ]),
    ],
    [
      at(17),
      result('toolu_read', '10\t"exitCode": 1', {
        type: 'text',
        file: {
          filePath: inJob('inputs/1-check-report.json'),
          content: '"exitCode": 1',
          numLines: 5,
          startLine: 10,
          totalLines: 40,
        },
      }),
    ],
    [
      at(18),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_grep',
          name: 'Grep',
          input: { pattern: 'folders', path: inJob('inputs'), output_mode: 'content' },
        },
      ]),
    ],
    [
      at(18),
      result('toolu_grep', '3:folders', {
        mode: 'content',
        numFiles: 0,
        filenames: [],
        content: '3:folders',
        numLines: 1,
      }),
    ],
    [
      at(19),
      assistant([{ type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: { pattern: '**/*.json', path: job } }]),
    ],
    [
      at(19),
      result('toolu_glob', inJob('inputs/0-source-change.json'), {
        filenames: [inJob('inputs/0-source-change.json')],
        numFiles: 1,
        truncated: false,
      }),
    ],
    [
      at(20),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_chain',
          name: 'Bash',
          input: { command: 'cd .. && grep -v x a.txt', description: 'Filter the file' },
        },
      ]),
    ],
    [
      at(20),
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'toolu_chain',
        message:
          'This Bash command contains multiple operations. The following part requires approval: grep -v x a.txt',
      },
    ],
    [
      at(20),
      result(
        'toolu_chain',
        'This Bash command contains multiple operations. The following part requires approval: grep -v x a.txt',
        'Error: This Bash command contains multiple operations.',
        true,
      ),
    ],
    [
      at(21),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_write',
          name: 'Write',
          input: { file_path: inJob('output/review.json'), content: '{\n  "verdict": "pass"\n}' },
        },
      ]),
    ],
    [
      at(21),
      result('toolu_write', 'File created successfully', {
        type: 'create',
        filePath: inJob('output/review.json'),
        content: '{\n  "verdict": "pass"\n}',
        structuredPatch: [],
      }),
    ],
    [
      at(22),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_edit',
          name: 'Edit',
          input: { file_path: inJob('output/review.json'), old_string: '"pass"', new_string: '"pass",\n  "notes": []' },
        },
      ]),
    ],
    [
      at(22),
      result('toolu_edit', 'The file has been updated.', {
        filePath: inJob('output/review.json'),
        structuredPatch: [{ oldStart: 2, lines: ['-  "verdict": "pass"', '+  "verdict": "pass",', '+  "notes": []'] }],
      }),
    ],
    [
      at(23),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_same',
          name: 'Edit',
          input: { file_path: inJob('output/review.json'), old_string: 'a', new_string: 'a' },
        },
      ]),
    ],
    [at(23), result('toolu_same', 'No changes to make: old_string and new_string are exactly the same.', null, true)],
    [
      at(24),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_done',
          name: 'StructuredOutput',
          input: { taskId: 'T-trace', outcome: 'completed', summary: 'Pass.' },
        },
      ]),
    ],
    [at(24), 'not JSON from the CLI', 'stderr'],
    [
      at(25),
      assistant([
        { type: 'tool_use', id: 'toolu_late', name: 'Bash', input: { command: 'sleep 1', description: 'Wait' } },
      ]),
    ],
    [
      at(26),
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: {
          input_tokens: 12,
          output_tokens: 3400,
          cache_read_input_tokens: 90000,
          cache_creation_input_tokens: 18000,
        },
      },
    ],
  ];
}

test("a Claude attempt's trace gives each step's facts: messages, thinking, commands, reads, searches, edits, refusals and errors", async t => {
  const { attempt, store, job, write } = fixture(t, {
    result: { outcome: 'completed', summary: 'The review passes.', handoff: 'Integration is the policy’s decision.' },
    phases: [
      { schemaVersion: 'source-phase-v1', phaseId: 'attempt', boundary: 'start', timestamp: at(7) },
      {
        schemaVersion: 'source-phase-v1',
        phaseId: 'attempt',
        boundary: 'finish',
        timestamp: '2026-10-23T03:28:25.000Z',
        outcome: 'succeeded',
        durationMs: 138000,
      },
    ],
  });
  const lines = claudeLines(job);
  write(lines);
  const trace = await attemptTrace(store, attempt, claudeAdapter);
  assert.equal(trace.schemaVersion, 'attempt-trace-v1');
  assert.deepEqual(
    [trace.source, trace.model, trace.effort, trace.durationMs, trace.lines, trace.unreadLines],
    ['activity-file', 'claude-opus-5-5', 'high', 138000, lines.length, 0],
  );
  assert.deepEqual(trace.setup, {
    tools: 7,
    mcpServers: ['claude.ai Notion'],
    permissionMode: 'acceptEdits',
    version: '2.1.309',
  });
  // Usage as Claude Code reports it: each window's first and latest percentage in the attempt, and the tokens.
  assert.deepEqual(trace.usage.windows.five_hour, { before: 41, after: 41, resetsAt: '2026-10-23T05:00:00.000Z' });
  assert.equal(trace.usage.windows.seven_day.before, 34);
  assert.deepEqual(trace.usage.tokens, { input: 12, output: 3400, cacheRead: 90000, cacheWrite: 18000 });
  const steps = trace.steps.map(({ seq, at, ...facts }) => facts);
  assert.deepEqual(
    trace.steps.map(step => step.seq),
    trace.steps.map((step, index) => index),
  );
  assert.deepEqual(steps, [
    { kind: 'think', durationMs: 1840, tokens: 210 },
    {
      kind: 'shell',
      command: 'ls ../inputs',
      description: 'List the inputs',
      exitCode: 0,
      output: { head: '0-source-change.json\n1-check-report.json', tail: '', bytes: 40, cut: false },
    },
    {
      kind: 'shell',
      command: 'node --test',
      description: 'Run tests',
      exitCode: 1,
      output: { head: 'not ok 1 - the folder list', tail: '', bytes: 26, cut: false },
    },
    { kind: 'say', text: 'One test fails. Reading the report.' },
    {
      kind: 'read',
      path: 'inputs/1-check-report.json',
      startLine: 10,
      lines: 5,
      totalLines: 40,
      output: { head: '"exitCode": 1', tail: '', bytes: 13, cut: false },
    },
    {
      kind: 'search',
      tool: 'Grep',
      pattern: 'folders',
      path: 'inputs',
      glob: null,
      matches: 1,
      output: { head: '3:folders', tail: '', bytes: 9, cut: false },
    },
    {
      kind: 'search',
      tool: 'Glob',
      pattern: '**/*.json',
      path: job,
      glob: null,
      matches: 1,
      output: { head: 'inputs/0-source-change.json', tail: '', bytes: 27, cut: false },
    },
    {
      kind: 'blocked',
      tool: 'Bash',
      detail: 'cd .. && grep -v x a.txt',
      // Claude's own words for the command it tried, as on a shell step.
      description: 'Filter the file',
      reason: 'This Bash command contains multiple operations. The following part requires approval: grep -v x a.txt',
    },
    { kind: 'edit', path: 'output/review.json', change: 'create', added: 3, removed: 0 },
    { kind: 'edit', path: 'output/review.json', change: 'edit', added: 2, removed: 1 },
    {
      kind: 'error',
      tool: 'Edit',
      detail: path.join(job, 'output', 'review.json'),
      description: null,
      reason: 'No changes to make: old_string and new_string are exactly the same.',
    },
    { kind: 'shell', command: 'sleep 1', description: 'Wait', exitCode: null, output: null, pending: true },
  ]);
  assert.deepEqual(trace.counts, {
    say: 1,
    think: 1,
    shell: 3,
    read: 1,
    search: 2,
    edit: 2,
    blocked: 1,
    error: 1,
    tool: 0,
    thinkTokens: 210,
  });
  assert.deepEqual(trace.phases[1], {
    at: '2026-10-23T03:28:25.000Z',
    phaseId: 'attempt',
    boundary: 'finish',
    outcome: 'succeeded',
    durationMs: 138000,
  });
  // The handoff is the recorded result, never the structured output read back from the CLI's lines.
  assert.deepEqual(trace.handoff, {
    at: attempt.finishedAt,
    outcome: 'completed',
    summary: 'The review passes.',
    handoff: 'Integration is the policy’s decision.',
  });
  assert.equal(trace.omitted, null);

  // Refusals come from the code that records the attempt's command denials, so the two agree.
  const recorded = { ...attempt },
    runtime = { store: { updateAttempt() {} }, stop() {}, nativeFailure() {} },
    entry = { attempt: recorded, claudeMode: 'workspace' };
  for (const [, data, channel] of lines)
    if (!channel && typeof data === 'object') recordClaudeEvent.call(runtime, entry, data);
  assert.deepEqual(
    recorded.commandDenials,
    trace.steps
      .filter(step => step.kind === 'blocked')
      .map(step => ({ tool: step.tool, command: step.detail, reason: step.reason })),
  );
});

test("a running attempt's trace reads only what its CLI wrote since, and `after` returns only newer steps", async t => {
  const { attempt, store, job, write } = fixture(t, { status: 'running', finishedAt: null }),
    lines = claudeLines(job);
  write(lines.slice(0, 5));
  const first = await attemptTrace(store, attempt, claudeAdapter);
  assert.deepEqual(
    first.steps.map(step => [step.seq, step.kind, !!step.pending]),
    [
      [0, 'think', false],
      [1, 'shell', true],
    ],
  );
  assert.equal(first.handoff, null);
  // A line still being written is left for the next read.
  fs.appendFileSync(path.join(job, 'activity.jsonl'), JSON.stringify({ time: at(12), channel: 'stdout' }).slice(0, 20));
  const unchanged = await attemptTrace(store, attempt, claudeAdapter);
  assert.equal(unchanged.lines, 5);
  assert.equal(unchanged.unreadLines, 0);
  fs.writeFileSync(
    path.join(job, 'activity.jsonl'),
    fs.readFileSync(path.join(job, 'activity.jsonl'), 'utf8').slice(0, -20),
  );
  write(lines.slice(5, 10));
  // The pending command at seq 1 got its result, so the page asks from just before it.
  const next = await attemptTrace(store, attempt, claudeAdapter, { after: 0 });
  assert.deepEqual(
    next.steps.map(step => [step.seq, step.kind, step.exitCode ?? null]),
    [
      [1, 'shell', 0],
      [2, 'shell', 1],
      [3, 'say', null],
    ],
  );
  assert.equal(next.lines, 10);
  assert.equal(next.counts.shell, 2);
  // Concurrent requests share one read; each sees the whole file.
  write(lines.slice(10));
  const [a, b] = await Promise.all([
    attemptTrace(store, attempt, claudeAdapter),
    attemptTrace(store, attempt, claudeAdapter),
  ]);
  assert.equal(a.lines, lines.length);
  assert.deepEqual(a.steps, b.steps);
  assert.equal(a.steps.length, 12);
});

test("a Codex attempt's trace shows each command without its shell wrapper, its file changes and its token usage", async t => {
  const { attempt, store, job, write } = fixture(t, { provider: 'codex', reportedModel: 'gpt-5.5-codex' }),
    wrapped = command => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${command}'`;
  write([
    [at(1), { type: 'thread.started', thread_id: '01a160dc' }],
    [at(1), { type: 'turn.started' }],
    [at(2), { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll read the inputs.' } }],
    [
      at(3),
      {
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: wrapped("Get-Content -LiteralPath AGENTS.md; Write-Output ''done''"),
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      },
    ],
    [
      at(4),
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: wrapped("Get-Content -LiteralPath AGENTS.md; Write-Output ''done''"),
          aggregated_output: '# company\ndone',
          exit_code: 0,
          status: 'completed',
        },
      },
    ],
    [
      at(5),
      {
        type: 'item.started',
        item: { id: 'item_2', type: 'command_execution', command: wrapped('node --test'), status: 'in_progress' },
      },
    ],
    [
      at(6),
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: wrapped('node --test'),
          aggregated_output: 'not ok 1',
          exit_code: 1,
          status: 'failed',
        },
      },
    ],
    [
      at(7),
      {
        type: 'item.started',
        item: {
          id: 'item_3',
          type: 'file_change',
          changes: [{ path: path.join(job, 'output', 'review.json'), kind: 'add' }],
          status: 'in_progress',
        },
      },
    ],
    [
      at(7),
      {
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'file_change',
          changes: [{ path: path.join(job, 'output', 'review.json'), kind: 'add' }],
          status: 'completed',
        },
      },
    ],
    [
      at(8),
      {
        type: 'turn.completed',
        usage: { input_tokens: 400, cached_input_tokens: 300, output_tokens: 40, reasoning_output_tokens: 10 },
      },
    ],
    [
      at(9),
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 5, reasoning_output_tokens: 2 },
      },
    ],
  ]);
  const trace = await attemptTrace(store, attempt, codexAdapter);
  assert.deepEqual(
    trace.steps.map(({ seq, at, ...facts }) => facts),
    [
      { kind: 'say', text: 'I’ll read the inputs.' },
      {
        kind: 'shell',
        command: "Get-Content -LiteralPath AGENTS.md; Write-Output 'done'",
        description: null,
        exitCode: 0,
        output: { head: '# company\ndone', tail: '', bytes: 14, cut: false },
      },
      {
        kind: 'shell',
        command: 'node --test',
        description: null,
        exitCode: 1,
        output: { head: 'not ok 1', tail: '', bytes: 8, cut: false },
      },
      // Codex names the file and the kind of change, not the lines.
      { kind: 'edit', path: 'output/review.json', change: 'create', added: null, removed: null },
    ],
  );
  assert.deepEqual(trace.usage, { tokens: { input: 500, cachedInput: 350, output: 45, reasoningOutput: 12 } });
  assert.equal(trace.setup, null);
  assert.equal(codexCommand("bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(codexCommand(['bash', '-lc', 'ls -la']), 'ls -la');
  assert.equal(codexCommand('rg folders src'), 'rg folders src');
});

test('a trace bounds each output, all outputs together and the number of steps', async t => {
  const { attempt, store, write } = fixture(t),
    big = 'a'.repeat(5000) + 'z'.repeat(5000),
    records = [];
  for (let i = 0; i < 1000; i++) {
    records.push([
      at(1),
      assistant([{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `step ${i}` } }]),
    ]);
    records.push([at(1), result(`toolu_${i}`, 'ok', { stdout: big, stderr: '' })]);
    records.push([at(1), assistant([{ type: 'text', text: `done ${i}` }])]);
  }
  write(records);
  const trace = await attemptTrace(store, attempt, claudeAdapter);
  const shell = trace.steps[0];
  assert.equal(shell.output.cut, true);
  assert.equal(shell.output.bytes, 10000);
  assert.equal(shell.output.head, 'a'.repeat(traceLimits.outputEnd));
  assert.equal(shell.output.tail, 'z'.repeat(traceLimits.outputEnd));
  // 2,000 steps: the first 750 and the last 750 are kept, the 500 between are counted.
  assert.equal(trace.steps.length, traceLimits.headSteps + traceLimits.tailSteps);
  assert.deepEqual(trace.omitted, { afterSeq: traceLimits.headSteps - 1, count: 500 });
  assert.equal(trace.steps.at(-1).seq, 1999);
  assert.equal(trace.counts.shell + trace.counts.say, 2000);
  // About 3 KB an output against a 1.5 MB budget: later outputs keep their facts and drop the text.
  assert.equal(trace.outputOmitted, true);
  assert.equal(trace.steps.at(-2).output, null);
  assert.equal(trace.steps.at(-2).exitCode, 0);
  assert.ok(JSON.stringify(trace).length < 2.5 * 1024 * 1024);
});

test('an attempt recorded before the activity file is traced from its activity rows, with the lines they cut counted', async t => {
  const rows = [
      {
        kind: 'log',
        time: at(1),
        message: 'stdout: ' + JSON.stringify(assistant([{ type: 'text', text: 'Starting.' }])),
      },
      // Rows keep at most 6,000 characters of a line, which cuts long JSON.
      {
        kind: 'log',
        time: at(2),
        message: ('stdout: ' + JSON.stringify(assistant([{ type: 'text', text: 'x'.repeat(7000) }]))).slice(0, 6000),
      },
      { kind: 'log', time: at(3), message: 'stderr: a warning' },
      { kind: 'phase', time: at(3), message: '{"schemaVersion":"source-phase-v1"}' },
    ],
    { attempt, store } = fixture(t, { rows });
  const trace = await attemptTrace(store, attempt, claudeAdapter);
  assert.deepEqual([trace.source, trace.lines, trace.unreadLines], ['log-rows', 3, 1]);
  assert.deepEqual(
    trace.steps.map(step => step.text),
    ['Starting.'],
  );
  const empty = fixture(t, { provider: 'simulator' });
  assert.equal((await attemptTrace(empty.store, empty.attempt, undefined)).source, 'none');
});

test("Today's latest message is written at most once every 10 seconds, the newest winning, and only while the attempt works", () => {
  const writes = [],
    runtime = {
      store: {
        updateAttempt: attempt => writes.push(attempt.lastSay.text),
        event() {},
      },
      stop() {},
      nativeFailure() {},
      recordLine,
    },
    entry = {
      attempt: { id: 'attempt-say', taskId: 'T-say', status: 'running' },
      buffers: {},
      adapter: { recordEvent: (rt, e, data) => recordClaudeEvent.call(rt, e, data) },
      claudeMode: 'workspace',
    };
  const line = text => JSON.stringify(assistant([{ type: 'text', text }]));
  // A burst of short messages writes the record once.
  for (const text of ['One.', 'Two.', 'Three.']) recordLine.call(runtime, entry, 'stdout', line(text));
  assert.deepEqual(writes, ['One.']);
  assert.equal(entry.pendingSay.text, 'Three.');
  // Once the floor has passed, the newest held message goes out with the next line of any kind.
  entry.sayWrittenAt -= sayLimits.floorMs;
  recordLine.call(runtime, entry, 'stdout', JSON.stringify({ type: 'system', subtype: 'thinking_tokens' }));
  assert.deepEqual(writes, ['One.', 'Three.']);
  assert.equal(entry.attempt.lastSay.text, 'Three.');
  assert.equal(flushSay.call(runtime, entry), false);
  noteSay(entry, '  ' + 'w'.repeat(400));
  assert.equal(entry.pendingSay.text.length, sayLimits.text);

  // The compact attempt carries it, and the open phase, only while the attempt works.
  const working = dashboardAttempt({ ...entry.attempt, lastSay: { text: 'Three.', at: at(5) } }, [], 'test');
  assert.deepEqual(working.lastSay, { text: 'Three.', at: at(5) });
  assert.equal(working.openPhase, 'test');
  const finished = dashboardAttempt(
    { ...entry.attempt, status: 'review', lastSay: { text: 'Three.', at: at(5) } },
    [],
    'test',
  );
  assert.equal(Object.hasOwn(finished, 'lastSay'), false);
  assert.equal(Object.hasOwn(finished, 'openPhase'), false);
});

test("a working attempt's open phase is its innermost phase without a finish", () => {
  const row = (phaseId, boundary, timestamp, occurrenceId = phaseId, attemptId = 'attempt-a') => ({
    schemaVersion: 'source-phase-v1',
    attempt_id: attemptId,
    task_id: 'T-a',
    attemptId,
    taskId: 'T-a',
    phaseId,
    occurrenceId,
    integrationOccurrenceId: null,
    boundary,
    timestamp,
  });
  const owner = attemptId => JSON.stringify([attemptId, 'T-a']);
  const open = dashboardOpenPhases([
    row('attempt', 'start', at(1)),
    row('source.edit', 'start', at(2)),
    row('source.edit', 'finish', at(5)),
    row('candidate.commit', 'start', at(5)),
    row('candidate.commit', 'finish', at(6)),
    row('test', 'start', at(6)),
    row('attempt', 'start', at(1), 'attempt', 'attempt-b'),
    row('source.edit', 'start', at(2), 'source.edit', 'attempt-b'),
    row('attempt', 'start', at(1), 'attempt', 'attempt-c'),
    row('attempt', 'start', at(1), 'attempt', 'attempt-d'),
    row('test', 'start', at(2), 'test', 'attempt-d'),
    row('attempt', 'finish', at(3), 'attempt', 'attempt-d'),
    // Another attempt's row recorded under this one's ID does not count.
    { ...row('install', 'start', at(9)), attemptId: 'attempt-x' },
  ]);
  assert.equal(open.get(owner('attempt-a')), 'test');
  assert.equal(open.get(owner('attempt-b')), 'source.edit');
  assert.equal(open.get(owner('attempt-c')), 'attempt');
  assert.equal(open.has(owner('attempt-d')), false);
});

test('the trace route serves an attempt of the selected project, with `after` checked', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-trace-route-')),
    app = createStudio({ directory, port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = await app.start(),
    attempt = {
      id: 'attempt-trace-route',
      taskId: 'T-trace-route',
      projectId: 'project-legacy',
      workerId: 'W-03',
      provider: 'claude',
      status: 'review',
      startedAt: at(1),
      finishedAt: at(9),
      artifacts: [],
      inputReferences: [],
    },
    job = jobDirectory(app.store, attempt);
  app.store.insertAttempt(attempt, { hash: 'snapshot', text: 'Instructions.' });
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(
    path.join(job, 'activity.jsonl'),
    [assistant([{ type: 'text', text: 'First.' }]), assistant([{ type: 'text', text: 'Second.' }])]
      .map((data, index) => JSON.stringify({ time: at(index + 2), channel: 'stdout', line: JSON.stringify(data) }))
      .join('\n') + '\n',
  );
  const base = `${origin}/api/attempts/${attempt.id}/trace?projectId=project-legacy`;
  const whole = await (await fetch(base)).json();
  assert.deepEqual(
    whole.steps.map(step => step.text),
    ['First.', 'Second.'],
  );
  assert.deepEqual(
    (await (await fetch(`${base}&after=0`)).json()).steps.map(step => step.text),
    ['Second.'],
  );
  for (const after of ['-1', '1.5', 'x']) assert.equal((await fetch(`${base}&after=${after}`)).status, 400);
  assert.equal((await fetch(`${base}&after=0&after=1`)).status, 400);
  // The state carries no trace.
  const state = await (await fetch(`${origin}/api/state?mode=dashboard&projectId=project-legacy`)).text();
  assert.doesNotMatch(state, /First\./);
  // A source adapter runs the employee's model; that model's adapter reads the lines, as for an editor's attempt.
  const editor = {
      ...attempt,
      id: 'attempt-trace-route-editor',
      provider: 'source-change',
      configuration: { executionAdapter: 'source-change', model: 'claude' },
    },
    editorJob = jobDirectory(app.store, editor);
  app.store.insertAttempt(editor, { hash: 'snapshot', text: 'Instructions.' });
  fs.mkdirSync(editorJob, { recursive: true });
  fs.writeFileSync(
    path.join(editorJob, 'activity.jsonl'),
    JSON.stringify({
      time: at(2),
      channel: 'stdout',
      line: JSON.stringify(assistant([{ type: 'text', text: 'Edited.' }])),
    }) + '\n',
  );
  const edited = await (await fetch(`${origin}/api/attempts/${editor.id}/trace?projectId=project-legacy`)).json();
  assert.equal(edited.provider, 'source-change');
  assert.deepEqual(
    edited.steps.map(step => step.text),
    ['Edited.'],
  );
});
