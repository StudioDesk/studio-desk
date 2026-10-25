import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { describeTask, waitFor } from './wait-for.mjs';
import { CLAUDE_UNBOUNDED_TOOLS } from '../src/adapters/claude.mjs';
import {
  MAX_COMMAND_DENIALS,
  agentPermissions,
  allowedToolRules,
  applyAgentPermissions,
  attemptPermissions,
  commandRule,
  permissionsPrompt,
  recordDenial,
} from '../src/core/agent-permissions.mjs';

// Model-free: the Claude Code protocol fixture records the arguments it receives and, for a task titled
// "Refused command", reports a refused command as Claude Code does.
const codexFixture = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url)),
  claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url));
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../public/runs.js', import.meta.url), 'utf8'), context);
const { taskExplanation } = context.StudioRuns;
const plain = value => JSON.parse(JSON.stringify(value));

test('an approved command is a plain prefix, and auto mode follows the task, then the Settings', () => {
  assert.equal(commandRule('  node   --test '), 'node --test');
  for (const bad of [
    '',
    '-rf',
    'node --test && rm -rf .',
    'node; rm x',
    'echo $HOME',
    'node "x"',
    'git *',
    'cmd | tee out',
    'a,b',
    'x'.repeat(201),
    42,
    null,
  ])
    assert.throws(() => commandRule(bad), /cannot be an approved command/, String(bad));

  const org = {};
  assert.deepEqual(agentPermissions(org), { auto: false, commands: [] });
  applyAgentPermissions(org, { commands: ['node --test', 'node  --test', 'npm run lint'] });
  assert.deepEqual(org.agentPermissions, { auto: false, commands: ['node --test', 'npm run lint'] });
  applyAgentPermissions(org, { auto: true });
  assert.deepEqual(org.agentPermissions, { auto: true, commands: ['node --test', 'npm run lint'] });
  assert.throws(() => applyAgentPermissions(org, { auto: 'yes' }), /true or false/);
  assert.throws(() => applyAgentPermissions(org, { tools: [] }), /take auto and commands/);
  assert.throws(
    () => applyAgentPermissions(org, { commands: Array.from({ length: 51 }, (_, i) => 'tool' + i) }),
    /at most 50/,
  );
  assert.deepEqual(org.agentPermissions, { auto: true, commands: ['node --test', 'npm run lint'] });

  assert.deepEqual(allowedToolRules(['node --test']), ['Bash(node --test)', 'Bash(node --test *)']);
  assert.deepEqual(attemptPermissions(org, {}), {
    mode: 'auto',
    autoFrom: 'settings',
    commands: ['node --test', 'npm run lint'],
  });
  assert.deepEqual(attemptPermissions(org, { autoMode: false }), {
    mode: 'acceptEdits',
    autoFrom: 'task',
    commands: ['node --test', 'npm run lint'],
  });
  assert.equal(attemptPermissions({}, { autoMode: true }).mode, 'auto');

  assert.match(
    permissionsPrompt({ mode: 'acceptEdits', commands: ['node --test'] }),
    /approved these commands.*`node --test`/,
  );
  assert.match(
    permissionsPrompt({ mode: 'acceptEdits', commands: [] }),
    /approved no commands.*return outcome blocked/,
  );
  // Claude Code refuses a command chained, piped or after cd, as idea 19's first editor found with the test command.
  assert.match(permissionsPrompt({ mode: 'acceptEdits', commands: [] }), /follows cd.*run each command on its own/);
  assert.match(permissionsPrompt({ mode: 'auto', commands: [] }), /auto mode/);

  const attempt = {};
  for (let i = 0; i < 30; i++)
    recordDenial(attempt, { tool: 'Bash', command: 'cmd ' + (i % 25), reason: i < 25 ? 'x'.repeat(400) : 'later' });
  assert.equal(attempt.commandDenials.length, MAX_COMMAND_DENIALS);
  assert.equal(attempt.commandDenials[0].reason.length, 300);
  assert.equal(attempt.commandDenials.filter(item => item.command === 'cmd 0').length, 1, 'A repeat is kept once.');
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-permissions-'));
  const app = createStudio({
    directory,
    port: 0,
    runnerOptions: { codexBinary: codexFixture, claudeBinary: claudeFixture },
  });
  const origin = await app.start(),
    token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = async (url, body = {}, method = 'POST') => {
    const res = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const until = async (check, label) => {
    await waitFor(check, label, { interval: 20 });
  };
  const finish = async id => {
    const task = await waitFor(
      () => {
        const task = app.store.task(id);
        return task.lastAttemptId && !['running', 'stopping'].includes(task.status) && task;
      },
      `task ${id} to stop running`,
      {
        interval: 20,
        detail: () => {
          const task = app.store.task(id);
          return describeTask(task, task.lastAttemptId && app.store.attempt(task.lastAttemptId));
        },
      },
    );
    return app.store.attempt(task.lastAttemptId);
  };
  const args = attempt =>
    JSON.parse(fs.readFileSync(path.join(attempt.outputFolder, '..', 'fixture-args.json'), 'utf8'));
  const flag = (argv, name) => argv[argv.indexOf(name) + 1];
  const create = async title =>
    (await request('/api/tasks', { title, workerId: 'W-03', kind: 'general', brief: 'Bounded model-free work.' })).data;
  const run = async title => {
    const task = await create(title);
    app.runner.start(task.id);
    return { task, attempt: await finish(task.id) };
  };
  const employee = async change => {
    const version = app.store.organization().workers.find(w => w.id === 'W-03').configVersion || 1;
    assert.equal((await request('/api/workers/W-03', { ...change, expectedVersion: version }, 'PATCH')).status, 200);
  };
  const explain = async id => {
    const state = await (await fetch(origin + '/api/state?mode=dashboard')).json();
    return taskExplanation(
      state.tasks.find(task => task.id === id),
      state,
    );
  };
  return { app, origin, request, until, finish, args, flag, create, run, employee, explain };
}

test('Claude employees run with the approved commands and auto mode from the Settings, and a task can turn auto mode on or off', async t => {
  const c = await setup(t);
  await c.employee({ provider: 'claude' });
  let { attempt } = await c.run('Default permissions');
  assert.deepEqual(attempt.configuration.permissions, { mode: 'acceptEdits', autoFrom: 'settings', commands: [] });
  let argv = c.args(attempt);
  assert.equal(c.flag(argv, '--permission-mode'), 'acceptEdits');
  assert.ok(!argv.includes('--allowedTools'));

  for (const bad of [{ commands: ['node --test', 'rm -rf / ; echo'] }, { auto: 'yes' }, { auto: true, extra: 1 }])
    assert.equal((await c.request('/api/control', { agentPermissions: bad })).status, 400);
  assert.equal(c.app.store.organization().agentPermissions, undefined, 'A refused edit saves nothing.');
  assert.equal(
    (await c.request('/api/control', { agentPermissions: { auto: true, commands: ['node --test', 'npm run lint'] } }))
      .status,
    200,
  );
  ({ attempt } = await c.run('Auto by default'));
  assert.deepEqual(attempt.configuration.permissions, {
    mode: 'auto',
    autoFrom: 'settings',
    commands: ['node --test', 'npm run lint'],
  });
  argv = c.args(attempt);
  assert.equal(c.flag(argv, '--permission-mode'), 'auto');
  const at = argv.indexOf('--allowedTools');
  assert.deepEqual(argv.slice(at + 1, at + 6), [
    'Bash(node --test)',
    'Bash(node --test *)',
    'Bash(npm run lint)',
    'Bash(npm run lint *)',
    '--disallowedTools',
  ]);
  // An attempt is one bounded turn: nothing it schedules or starts in the background outlives its result
  // (the stand-in also refuses to run unless background tasks are off).
  assert.deepEqual(argv.slice(at + 6, at + 12), CLAUDE_UNBOUNDED_TOOLS);
  assert.equal(argv[at + 12], '--add-dir');

  // A task's own choice wins for its future attempts; null follows the Settings again.
  const off = await c.create('Auto off here');
  assert.equal((await c.request(`/api/tasks/${off.id}`, { autoMode: 'yes' }, 'PATCH')).status, 400);
  assert.equal((await c.request(`/api/tasks/${off.id}`, { autoMode: false }, 'PATCH')).status, 200);
  c.app.runner.start(off.id);
  attempt = await c.finish(off.id);
  assert.deepEqual(attempt.configuration.permissions, {
    mode: 'acceptEdits',
    autoFrom: 'task',
    commands: ['node --test', 'npm run lint'],
  });
  assert.equal(c.flag(c.args(attempt), '--permission-mode'), 'acceptEdits');
  const follow = await c.create('Follow the Settings');
  await c.request(`/api/tasks/${follow.id}`, { autoMode: true }, 'PATCH');
  assert.equal(c.app.store.task(follow.id).autoMode, true);
  await c.request(`/api/tasks/${follow.id}`, { autoMode: null }, 'PATCH');
  assert.equal(Object.hasOwn(c.app.store.task(follow.id), 'autoMode'), false);

  // The dashboards read what each attempt ran with.
  const state = await (await fetch(c.origin + '/api/state?mode=dashboard')).json();
  assert.deepEqual(plain(state.attempts.find(a => a.id === attempt.id).configuration.permissions), {
    mode: 'acceptEdits',
    autoFrom: 'task',
    commands: ['node --test', 'npm run lint'],
  });

  // Text mode has no tools, and Codex runs its commands in its own sandbox: neither records permissions.
  await c.employee({ mode: 'text' });
  ({ attempt } = await c.run('Text mode'));
  assert.equal(attempt.configuration.permissions, undefined);
  await c.employee({ provider: 'codex' });
  ({ attempt } = await c.run('Codex'));
  assert.equal(attempt.configuration.permissions, undefined);
});

test('a command Claude Code refuses is recorded, and the director approves it and the work starts again', async t => {
  const c = await setup(t);
  await c.employee({ provider: 'claude' });
  const { task, attempt } = await c.run('Blocked Refused command');
  assert.equal(attempt.status, 'blocked');
  assert.deepEqual(attempt.commandDenials, [
    { tool: 'Bash', command: 'node --test test/a.test.mjs', reason: 'This command requires approval' },
  ]);
  const explanation = await c.explain(task.id);
  assert.equal(explanation.kind, 'command-request');
  assert.equal(explanation.action, 'Allow commands');
  assert.equal(explanation.requiresDirector, true);
  assert.equal(explanation.attemptId, attempt.id);
  assert.deepEqual(plain(explanation.commands), ['node --test test/a.test.mjs']);
  assert.ok(explanation.details.includes('Refused: node --test test/a.test.mjs (This command requires approval)'));

  const allow = body => c.request(`/api/tasks/${task.id}/allow-commands`, body);
  assert.equal((await allow({ attemptId: 'attempt-other', commands: ['node --test'] })).status, 409);
  assert.equal((await allow({ attemptId: attempt.id, commands: ['node --test; rm x'] })).status, 400);
  assert.equal((await allow({ attemptId: attempt.id, commands: [] })).status, 400);
  assert.equal((await allow({ attemptId: attempt.id, commands: ['node --test'], note: 'x' })).status, 400);
  assert.equal(c.app.store.organization().agentPermissions, undefined, 'A refused approval changes nothing.');

  const allowed = await allow({ attemptId: attempt.id, commands: ['node  --test'] });
  assert.equal(allowed.status, 202);
  assert.deepEqual(allowed.data.agentPermissions, { auto: false, commands: ['node --test'] });
  assert.deepEqual(
    c.app.store.task(task.id).commandApprovals.map(item => [item.attemptId, item.commands]),
    [[attempt.id, ['node --test']]],
  );
  await c.until(() => c.app.store.task(task.id).lastAttemptId !== attempt.id, 'the next attempt');
  const next = await c.finish(task.id);
  assert.deepEqual(next.configuration.permissions.commands, ['node --test']);
  assert.ok(c.args(next).includes('Bash(node --test *)'), 'The approved command applies to the next attempt.');
  assert.equal(
    (await allow({ attemptId: attempt.id, commands: ['node --test'] })).status,
    409,
    'Only the latest attempt can be answered.',
  );
});

test('only a stopped attempt that Claude Code refused commands in, and that nobody answered, asks for commands', () => {
  const denial = { tool: 'Bash', command: 'node --test', reason: 'This command requires approval' },
    state = (task, attempt) => ({ tasks: [task], attempts: [attempt], autonomy: { policy: {} }, taskKinds: {} }),
    task = { id: 'T-1', kind: 'general', status: 'blocked', lastAttemptId: 'a-1', maxAttempts: 3 },
    attempt = {
      id: 'a-1',
      taskId: 'T-1',
      status: 'blocked',
      startedAt: '2026-10-22T10:00:00.000Z',
      finishedAt: '2026-10-22T10:01:00.000Z',
      result: { summary: 'The tests need node --test.' },
      commandDenials: [denial],
    },
    kind = (t, a) => taskExplanation(t, state(t, a)).kind;
  assert.equal(kind(task, attempt), 'command-request');
  assert.notEqual(
    kind({ ...task, commandApprovals: [{ attemptId: 'a-1', commands: ['node --test'] }] }, attempt),
    'command-request',
  );
  assert.notEqual(kind(task, { ...attempt, commandDenials: [{ ...denial, tool: 'WebFetch' }] }), 'command-request');
  assert.notEqual(
    kind({ ...task, status: 'review' }, { ...attempt, status: 'completed' }),
    'command-request',
    'Work handed on despite a refusal is not a request.',
  );
});
