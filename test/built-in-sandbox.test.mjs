// The built-in sandbox (1.0.1): Anthropic's sandbox runtime, run as a program of its own, where candidate tests
// and an idea's checks run once it is set up on this computer. Model-free: the sandbox itself is never started
// here; its setup and status are fakes, and the commands are checked as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import {
  builtInSandboxCommand,
  builtInSandboxCommandLine,
  builtInSandboxEnvironment,
  builtInSandboxRunner,
  builtInSandboxSettings,
  builtInSandboxState,
  builtInSandboxVersion,
  readBuiltInSandboxStatus,
} from '../src/adapters/built-in-sandbox.mjs';
import {
  candidateTestCommand,
  chosenTestSandbox,
  sandboxLabel,
  sandboxRecord,
} from '../src/adapters/source-test-sandbox.mjs';

const claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
  plan = { root: '/candidate', command: { executable: process.execPath, args: ['--test', 'test/a.test.mjs'] } };
// A fake for the controller's view of the sandbox: its state and a setup that finishes when told to.
function fakeSandbox(state) {
  const sandbox = {
    state,
    setups: 0,
    finish: null,
    status: () => ({ state: sandbox.state }),
    setup(done) {
      if (!['not-set-up', 'outdated'].includes(sandbox.state)) return false;
      sandbox.setups++;
      sandbox.finish = next => {
        sandbox.state = next;
        done({ state: next });
      };
      return true;
    },
  };
  return sandbox;
}

test('the built-in sandbox comes first once it is set up, and its tests run through its runner', () => {
  // Once set up, it is where the next tests run unless the director chose; before that, Codex's, then none.
  assert.equal(chosenTestSandbox({}, 'codex.exe', true), 'built-in');
  assert.equal(chosenTestSandbox({}, undefined, true), 'built-in');
  assert.equal(chosenTestSandbox({}, 'codex.exe', false), 'codex');
  assert.equal(chosenTestSandbox({}, undefined, false), 'none');
  assert.equal(chosenTestSandbox({ testSandbox: 'codex' }, 'codex.exe', true), 'codex', 'A choice stands.');
  assert.equal(chosenTestSandbox({ testSandbox: 'built-in' }, undefined, false), 'built-in');
  // The recorded command runs the runner, which gets the folder the tests may write and the plan's command.
  const command = candidateTestCommand(undefined, plan, { testSandbox: 'built-in' });
  assert.deepEqual(command, builtInSandboxCommand(plan));
  assert.deepEqual(command, {
    executable: process.execPath,
    args: [builtInSandboxRunner, '--root', '/candidate', '--', process.execPath, '--test', 'test/a.test.mjs'],
  });
  assert.deepEqual(sandboxRecord({ testSandbox: 'built-in' }), {
    provider: 'sandbox-runtime',
    version: builtInSandboxVersion,
    network: 'loopback-tests',
  });
  assert.equal(sandboxLabel({ testSandbox: 'built-in' }), 'in the built-in sandbox');
  assert.equal(sandboxLabel({ testSandbox: 'none' }), 'without a sandbox');
  assert.equal(sandboxLabel({}), 'in the Codex sandbox');
});

test("the runtime's status reads as not set up, out of date or ready", () => {
  // As the runtime's helper printed it on a computer where it had never been set up (October 25).
  const fresh = {
    user: {
      cred_present: false,
      marker_version: null,
      setup_version: 3,
      user: { exists: false, name: 'srt-sandbox' },
    },
    wfp: { state: 'cannot-read' },
  };
  assert.deepEqual(builtInSandboxState(fresh), { state: 'not-set-up' });
  const installed = structuredClone(fresh);
  Object.assign(installed.user, { cred_present: true, marker_version: 3 });
  installed.user.user.exists = true;
  assert.deepEqual(builtInSandboxState(installed), { state: 'ready' });
  installed.user.marker_version = 2;
  assert.deepEqual(builtInSandboxState(installed), { state: 'outdated' }, 'Set up by another release.');
  assert.deepEqual(builtInSandboxState(undefined), { state: 'not-set-up' });
});

test('the status is read from the runtime’s helper, and a copy without the packages says so', t => {
  if (process.platform !== 'win32') {
    assert.deepEqual(readBuiltInSandboxStatus(), { state: 'unsupported' });
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = { cli: path.join(directory, 'cli.js'), srtWin: path.join(directory, 'srt-win.exe') };
  assert.deepEqual(readBuiltInSandboxStatus(files), { state: 'missing' });
  for (const file of Object.values(files)) fs.writeFileSync(file, '');
  const calls = [];
  const reply = stdout => (binary, args) => (calls.push([binary, args]), { stdout, stderr: '' });
  const ready = { user: { cred_present: true, marker_version: 3, setup_version: 3, user: { exists: true } } };
  assert.deepEqual(readBuiltInSandboxStatus(files, reply(JSON.stringify(ready))), { state: 'ready' });
  assert.deepEqual(calls[0], [files.srtWin, ['status']]);
  assert.equal(readBuiltInSandboxStatus(files, reply('not json')).state, 'not-set-up');
});

test('a run writes only the copy it tests, reads the packages above it, and reaches only this computer', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'))),
    root = path.join(directory, 'data', 'wt', 'v-1');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(directory, 'data', 'node_modules'));
  const settings = builtInSandboxSettings({
    root,
    nodeDirectory: path.join(directory, 'node'),
    launcherDirectory: path.join(directory, 'adapters'),
    runDirectory: path.join(directory, 'run'),
  });
  assert.deepEqual(settings.network, { allowedDomains: [], deniedDomains: [], allowLocalBinding: true });
  assert.deepEqual(settings.filesystem.allowWrite, [root]);
  assert.deepEqual(settings.filesystem.allowRead.slice(0, 3), [
    path.join(directory, 'node'),
    path.join(directory, 'adapters'),
    path.join(directory, 'run'),
  ]);
  assert.ok(settings.filesystem.allowRead.includes(path.join(directory, 'data', 'node_modules')));
  assert.equal(settings.filesystem.allowRead.includes(path.join(root, 'node_modules')), false);
  // The command line quotes each path for the shell the runtime starts; the test command is not on it.
  assert.equal(
    builtInSandboxCommandLine('C:\\Program Files\\node\\node.exe', 'C:\\a b\\launch.mjs', 'C:\\t\\run.json'),
    '"C:\\Program Files\\node\\node.exe" "C:\\a b\\launch.mjs" "C:\\t\\run.json"',
  );
  // Only the controller's variables for the tests go in; nothing else from its environment, which may hold sign-ins.
  assert.deepEqual(
    builtInSandboxEnvironment({ STUDIO_MODEL_FREE_LEAF_FIXTURES: '1', GH_TOKEN: 'secret', PATH: 'C:\\bin' }),
    { STUDIO_MODEL_FREE_LEAF_FIXTURES: '1' },
  );
});

test('the director sets up the built-in sandbox from Settings, one setup at a time', async t => {
  const sandbox = fakeSandbox('not-set-up'),
    c = await setup(t, 'pass', undefined, { builtInSandbox: sandbox }),
    projectId = c.app.store.projects()[0].id,
    read = async route => (await fetch(c.origin + route, { headers: { 'X-Studio-Token': c.token } })).json();
  assert.deepEqual((await read(`/api/projects/${projectId}/shell`)).builtInSandbox, { state: 'not-set-up' });
  assert.deepEqual(
    (await read('/api/templates')).builtInSandbox,
    { state: 'not-set-up' },
    'The first run reads it too.',
  );
  assert.equal((await c.request('/api/built-in-sandbox', { setting: true })).status, 400);
  assert.equal((await c.request('/api/built-in-sandbox', {})).status, 200);
  assert.equal(sandbox.setups, 1);
  sandbox.finish('ready');
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message,
    /is set up/,
  );
  assert.equal((await c.request('/api/built-in-sandbox', {})).status, 409, 'Set up already.');
  // Ready, it is where the next tests run unless the director chose; the director may choose it.
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'built-in');
  assert.equal((await c.request('/api/control', { testSandbox: 'none' })).status, 200);
  assert.equal((await c.request('/api/control', { testSandbox: 'built-in' })).status, 200);
  assert.equal(c.app.store.organization().testSandbox, 'built-in');
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message,
    /built-in sandbox/,
  );
});

test('a story waits for the built-in sandbox the director chose, and records it once it is set up', async t => {
  const sandbox = fakeSandbox('not-set-up'),
    c = await setup(t, 'pass', undefined, { claudeBinary: claudeFixture, builtInSandbox: sandbox }, true),
    { store, runner } = c.app;
  runner.codexBinary = undefined;
  const task = store.task(c.taskId);
  task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(task);
  const org = store.organization();
  org.testSandbox = 'built-in';
  store.setOrganization(org);
  assert.throws(() => runner.start(task.id), {
    message:
      /^Candidate tests run in the built-in sandbox, and it isn't set up on this computer\. Set it up under Settings → Candidate tests, or choose another place for the tests there\.$/,
  });
  sandbox.state = 'ready';
  runner.refreshReadiness();
  runner.start(task.id);
  // The protocol fixture stands in for the tests here; the recorded command is what the sandbox would run.
  const attempt = await c.wait(task.id);
  assert.equal(attempt.status, 'review', attempt.error);
  assert.equal(attempt.configuration.testSandbox, 'built-in');
  assert.deepEqual(attempt.sourceCandidate.sandbox, sandboxRecord({ testSandbox: 'built-in' }));
  assert.equal(attempt.sourceCandidate.command.args[0], builtInSandboxRunner);
  assert.equal(attempt.sourceCandidate.command.args[2], attempt.sourceCandidate.root);
});
