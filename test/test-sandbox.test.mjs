// Where candidate tests run (v1.0 items 20 and 25, 1.0.1): the built-in sandbox, or this computer by the director's
// explicit choice, so changing code never requires one particular CLI. Attempts recorded before 1.0.1 may name the
// Codex CLI sandbox, which candidate tests no longer use. Model-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import { readyBuiltInSandbox } from './model-free-studio.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { artifactPath } from '../src/core/artifacts.mjs';
import { validateSourceChange } from '../src/connectors/source-changes.mjs';
import { builtInSandboxRunner, builtInSandboxVersion } from '../src/adapters/built-in-sandbox.mjs';
import {
  candidateTestCommand,
  chosenTestSandbox,
  codexSandboxRecord,
  sandboxLabel,
  sandboxRecord,
  testSandboxOf,
  testSandboxes,
} from '../src/adapters/source-test-sandbox.mjs';

const claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
  plan = { root: '/candidate', command: { executable: process.execPath, args: ['--test', 'test/a.test.mjs'] } },
  notSetUp = { status: () => ({ state: 'not-set-up' }), setup: () => false },
  unready =
    /^Candidate tests run in the built-in sandbox, and it isn't set up on this computer\. Set it up under Settings → Candidate tests, or choose No sandbox there\.$/;

test('the recorded choice names the test command and the sandbox record; earlier attempts used Codex', () => {
  assert.deepEqual(testSandboxes, ['built-in', 'none']);
  assert.equal(testSandboxOf({}), 'codex', 'An attempt recorded before the choice existed used Codex.');
  assert.equal(testSandboxOf(undefined), 'codex');
  const builtIn = candidateTestCommand(plan, { testSandbox: 'built-in' });
  assert.deepEqual(builtIn, {
    executable: process.execPath,
    args: [builtInSandboxRunner, '--root', '/candidate', '--', process.execPath, '--test', 'test/a.test.mjs'],
  });
  assert.deepEqual(sandboxRecord({ testSandbox: 'built-in' }), {
    provider: 'sandbox-runtime',
    version: builtInSandboxVersion,
    network: 'loopback-tests',
  });
  assert.equal(sandboxLabel({ testSandbox: 'built-in' }), 'in the built-in sandbox');
  // An attempt recorded under the Codex sandbox has its tests run again in the built-in one.
  for (const codex of [{}, { testSandbox: 'codex', windowsSandbox: 'mxc' }]) {
    assert.deepEqual(candidateTestCommand(plan, codex), builtIn);
    assert.deepEqual(sandboxRecord(codex), sandboxRecord({ testSandbox: 'built-in' }));
    assert.equal(sandboxLabel(codex), 'in the built-in sandbox');
  }
  // Its own record, from before 1.0.1, stays readable for its review.
  assert.deepEqual(codexSandboxRecord({ testSandbox: 'codex', windowsSandbox: 'mxc' }), {
    provider: 'codex',
    implementation: 'mxc',
    profile: 'studio-source-tests',
    network: 'loopback-tests',
  });
  const plain = candidateTestCommand(plan, { testSandbox: 'none' });
  assert.deepEqual(plain, plan.command);
  assert.notEqual(plain, plan.command, 'The recorded command is a copy of the plan, never the plan itself.');
  assert.deepEqual(sandboxRecord({ testSandbox: 'none' }), { provider: 'none', network: 'unrestricted' });
  assert.equal(sandboxLabel({ testSandbox: 'none' }), 'without a sandbox');
  // The next attempt's choice: the built-in sandbox, unless the director chose none; a saved Codex choice means it.
  assert.equal(chosenTestSandbox({}), 'built-in');
  assert.equal(chosenTestSandbox(undefined), 'built-in');
  assert.equal(chosenTestSandbox({ testSandbox: 'codex' }), 'built-in');
  assert.equal(chosenTestSandbox({ testSandbox: 'none' }), 'none');
});

test('a story edited by Claude waits for the built-in sandbox to be set up, then runs its tests there without Codex CLI', async t => {
  const c = await setup(t, 'pass', undefined, { claudeBinary: claudeFixture, builtInSandbox: notSetUp }, true),
    { store, runner } = c.app;
  runner.codexBinary = undefined;
  const task = store.task(c.taskId);
  task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(task);
  assert.throws(() => runner.start(task.id), { message: unready });
  const blocked = store.task(task.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, unready);
  assert.equal(blocked.controllerWait, true, 'The controller rechecks the story; no other answer is needed.');
  assert.equal(store.attempts(task.id).length, 0);
  // A saved choice of the Codex sandbox waits the same way.
  const org = store.organization();
  org.testSandbox = 'codex';
  store.setOrganization(org);
  runner.refreshReadiness();
  assert.match(store.task(task.id).reason, unready);
  // Once the sandbox is set up the story is ready again, and its tests run there.
  runner.builtInSandbox = readyBuiltInSandbox;
  runner.refreshReadiness();
  assert.equal(store.task(task.id).status, 'ready');
  assert.equal(store.task(task.id).reason, '');
  runner.start(task.id);
  const attempt = await c.wait(task.id);
  assert.equal(attempt.status, 'review', attempt.error);
  assert.equal(attempt.configuration.provider, 'claude');
  assert.equal(attempt.configuration.testSandbox, 'built-in');
  assert.equal(Object.hasOwn(attempt.configuration, 'windowsSandbox'), false);
  assert.deepEqual(attempt.sourceCandidate.sandbox, sandboxRecord({ testSandbox: 'built-in' }));
  // The protocol fixture stands in for the tests here; the recorded command is what the sandbox would run.
  assert.equal(attempt.sourceCandidate.command.args[0], builtInSandboxRunner);
  assert.equal(attempt.sourceCandidate.command.args[2], attempt.sourceCandidate.root);
  // The candidate is validated against the sandbox its attempt recorded.
  const read = name => fs.readFileSync(artifactPath(store, attempt, name));
  assert.doesNotThrow(() => validateSourceChange(attempt, read));
  const forged = structuredClone(attempt);
  forged.configuration.testSandbox = 'none';
  assert.throws(() => validateSourceChange(forged, read), /Candidate tests require the recorded source sandbox./);
});

test('a candidate tested in the Codex sandbox before 1.0.1 stays valid for its review', async t => {
  const c = await setup(t, 'pass', undefined, { claudeBinary: claudeFixture }, true),
    { store, runner } = c.app;
  const task = store.task(c.taskId);
  task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(task);
  runner.start(task.id);
  const attempt = await c.wait(task.id);
  assert.equal(attempt.status, 'review', attempt.error);
  // The same candidate as a 1.0.0 controller recorded it: the Codex sandbox's command and record.
  const read = name => fs.readFileSync(artifactPath(store, attempt, name)),
    earlier = structuredClone(attempt);
  earlier.configuration.testSandbox = 'codex';
  earlier.configuration.windowsSandbox = 'mxc';
  earlier.sourceCandidate.sandbox = codexSandboxRecord(earlier.configuration);
  earlier.sourceCandidate.command = { executable: 'codex', args: ['sandbox', '--', ...plan.command.args] };
  // Its sandbox passes; only its check report, which names this attempt's own command, then differs.
  assert.throws(() => validateSourceChange(earlier, read), /^Error: Source check report does not match/);
  // A Codex record on an attempt that recorded another sandbox is refused.
  const mixed = structuredClone(earlier);
  mixed.configuration.testSandbox = 'built-in';
  assert.throws(() => validateSourceChange(mixed, read), /Candidate tests require the recorded source sandbox./);
});

test("by the director's choice a story's candidate tests run without a sandbox, measured for real", async t => {
  const c = await setup(t, 'pass', undefined, { claudeBinary: claudeFixture }, true),
    { store, runner } = c.app;
  runner.codexBinary = undefined;
  const task = store.task(c.taskId);
  task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(task);
  const org = store.organization();
  org.testSandbox = 'none';
  store.setOrganization(org);
  // The candidate runs the real Node test command on its copy, not a protocol fixture.
  runner.sourceCheckCommand = undefined;
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousContext;
  });
  runner.start(task.id);
  const attempt = await c.wait(task.id);
  assert.equal(attempt.status, 'review', attempt.error);
  assert.equal(attempt.configuration.testSandbox, 'none');
  assert.deepEqual(attempt.sourceCandidate.sandbox, { provider: 'none', network: 'unrestricted' });
  assert.equal(attempt.sourceCandidate.command.executable, process.execPath);
  assert.equal(attempt.sourceCandidate.command.args[0], '--test');
  assert.equal(attempt.checkExecution.fixture, false);
  assert.equal(attempt.checkExecution.exitCode, 0);
  assert.ok(attempt.testEvidence.totals.tests >= 1);
  assert.equal(attempt.testEvidence.totals.fail, 0);
  assert.match(
    attempt.result.checks.find(check => check.name === 'Candidate Node test suite').evidence,
    /^Measured candidate tests without a sandbox: /,
    'The dashboard names where the tests ran.',
  );
  // The candidate is validated against the sandbox its attempt recorded, never the current choice.
  const read = name => fs.readFileSync(artifactPath(store, attempt, name)),
    forged = structuredClone(attempt);
  forged.configuration.testSandbox = 'built-in';
  assert.throws(() => validateSourceChange(forged, read), /Candidate tests require the recorded source sandbox./);
  const back = store.organization();
  delete back.testSandbox;
  store.setOrganization(back);
  acceptAttempt(store, runner.registries, store.task(task.id));
  assert.equal(store.attempt(attempt.id).status, 'accepted');
  assert.equal(store.attempt(attempt.id).configuration.testSandbox, 'none');
});

test('the director chooses the test sandbox through the controller, and only from the known choices', async t => {
  const c = await setup(t);
  assert.equal((await c.request('/api/control', { testSandbox: 'none' })).status, 200);
  assert.equal(c.app.store.organization().testSandbox, 'none');
  const lastControl = () =>
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message;
  assert.match(lastControl(), /without a sandbox/);
  for (const refused of ['docker', 'codex']) {
    const rejected = await c.request('/api/control', { testSandbox: refused });
    assert.equal(rejected.status, 400, refused);
    assert.match(rejected.data.error, /^Choose built-in or none for where candidate tests run\.$/);
  }
  assert.equal(c.app.store.organization().testSandbox, 'none');
  // The dashboard reads where the next tests run: the choice, or with none made, the built-in sandbox.
  const read = async route => (await fetch(c.origin + route, { headers: { 'X-Studio-Token': c.token } })).json(),
    projectId = c.app.store.projects()[0].id;
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'none');
  assert.equal((await c.request('/api/control', { testSandbox: 'built-in' })).status, 200);
  assert.match(lastControl(), /^Candidate tests now run in the built-in sandbox from the next attempt\.$/);
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'built-in');
  // A Codex choice saved before 1.0.1 reads as the built-in sandbox, on the first run too.
  const org = c.app.store.organization();
  org.testSandbox = 'codex';
  c.app.store.setOrganization(org);
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'built-in');
  assert.equal((await read('/api/templates')).testSandbox, 'built-in', 'The first run reads it too.');
});
