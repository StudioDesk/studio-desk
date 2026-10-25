// Where candidate tests run (v1.0 items 20 and 25): the Codex CLI sandbox where Codex CLI is installed, otherwise
// this computer, and either by the director's explicit choice, so changing code never requires one particular
// CLI. Model-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { artifactPath } from '../src/core/artifacts.mjs';
import { validateSourceChange } from '../src/connectors/source-changes.mjs';
import {
  candidateTestCommand,
  chosenTestSandbox,
  sandboxRecord,
  sourceTestSandboxProfile,
  testSandboxOf,
} from '../src/adapters/source-test-sandbox.mjs';

const claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
  plan = { root: '/candidate', command: { executable: process.execPath, args: ['--test', 'test/a.test.mjs'] } };

test('the recorded choice names the test command and the sandbox record; earlier attempts used Codex', () => {
  const codex = { testSandbox: 'codex', windowsSandbox: 'mxc' };
  assert.equal(testSandboxOf({}), 'codex', 'An attempt recorded before the choice existed used Codex.');
  assert.equal(testSandboxOf(undefined), 'codex');
  const sandboxed = candidateTestCommand('codex', plan, codex);
  assert.equal(sandboxed.executable, 'codex');
  assert.equal(sandboxed.args[0], 'sandbox');
  assert.deepEqual(sandboxed.args.slice(-4), ['--', process.execPath, '--test', 'test/a.test.mjs']);
  assert.deepEqual(sandboxRecord(codex), {
    provider: 'codex',
    implementation: 'mxc',
    profile: sourceTestSandboxProfile,
    network: 'loopback-tests',
  });
  assert.deepEqual(sandboxRecord({}), sandboxRecord({ testSandbox: 'codex' }));
  const plain = candidateTestCommand(undefined, plan, { testSandbox: 'none' });
  assert.deepEqual(plain, plan.command);
  assert.notEqual(plain, plan.command, 'The recorded command is a copy of the plan, never the plan itself.');
  assert.deepEqual(sandboxRecord({ testSandbox: 'none' }), { provider: 'none', network: 'unrestricted' });
  // The next attempt's choice: the director's, or with none made, the Codex sandbox only where Codex CLI is installed.
  assert.equal(chosenTestSandbox({}, 'codex.exe'), 'codex');
  assert.equal(chosenTestSandbox({}, undefined), 'none');
  assert.equal(chosenTestSandbox(undefined, null), 'none');
  assert.equal(chosenTestSandbox({ testSandbox: 'none' }, 'codex.exe'), 'none');
  assert.equal(chosenTestSandbox({ testSandbox: 'codex' }, undefined), 'codex');
});

test('a story edited by Claude runs its candidate tests without a sandbox where Codex CLI is not installed, unless the director chose its sandbox', async t => {
  const c = await setup(t, 'pass', undefined, { claudeBinary: claudeFixture }, true),
    { store, runner } = c.app;
  runner.codexBinary = undefined;
  const task = store.task(c.taskId);
  task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(task);
  const org = store.organization();
  org.testSandbox = 'codex';
  store.setOrganization(org);
  assert.throws(
    () => runner.start(task.id),
    {
      message:
        /^Candidate tests run in the Codex CLI sandbox, and Codex CLI isn't installed\. Install Codex CLI and restart the controller, or choose No sandbox under Settings → Candidate tests\.$/,
    },
    'A director who chose the Codex sandbox is told how to choose otherwise.',
  );
  // With no choice made, a Claude-only install runs the tests on this computer (v1.0 item 25).
  delete org.testSandbox;
  store.setOrganization(org);
  runner.refreshReadiness();
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
  assert.equal(attempt.configuration.provider, 'claude');
  assert.equal(attempt.configuration.testSandbox, 'none');
  assert.equal(Object.hasOwn(attempt.configuration, 'windowsSandbox'), false);
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
  forged.configuration.testSandbox = 'codex';
  assert.throws(() => validateSourceChange(forged, read), /Candidate tests require the recorded source sandbox./);
  const back = store.organization();
  back.testSandbox = 'codex';
  store.setOrganization(back);
  acceptAttempt(store, runner.registries, store.task(task.id));
  assert.equal(store.attempt(attempt.id).status, 'accepted');
  assert.equal(store.attempt(attempt.id).configuration.testSandbox, 'none');
});

test('a candidate test sandbox that fails its isolation check stops the story with what to do, until it passes or No sandbox is chosen', async t => {
  const c = await setup(t, 'pass', undefined, { claudeBinary: claudeFixture }, true),
    { store, runner } = c.app;
  // A supported Windows sandbox mode, so the isolation check is what stops the story.
  runner.codexWindowsSandbox = 'mxc';
  // Text delivery has no workspace of its own, so only the candidate test sandbox is checked.
  const task = store.task(c.taskId);
  task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(task);
  runner.sourceReviewSandbox = () => ({ passed: false });
  const isolation =
    /^The candidate test sandbox did not pass its isolation check\. Check the sandbox from a normal terminal \(node scripts\/check-codex-sandbox\.mjs\), or choose No sandbox under Settings → Candidate tests\.$/;
  assert.throws(() => runner.start(task.id), { message: isolation });
  const blocked = store.task(task.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, isolation);
  assert.equal(blocked.controllerWait, true, 'The controller rechecks the story; no other answer is needed.');
  assert.equal(store.attempts(task.id).length, 0);
  // Readiness uses the recorded check, so the story stays stopped while nothing has changed.
  runner.refreshReadiness();
  assert.match(store.task(task.id).reason, isolation);
  const choose = testSandbox => {
    const org = store.organization();
    org.testSandbox = testSandbox;
    store.setOrganization(org);
    runner.refreshReadiness();
    return store.task(task.id);
  };
  let ready = choose('none');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reason, '');
  // Back on the Codex sandbox, the recorded failed check stops it again until a check passes.
  assert.match(choose('codex').reason, isolation);
  runner.sourceReviewSandbox = () => ({ passed: true, implementation: 'protocol-fixture' });
  assert.equal(runner.blockReason(store.task(task.id), true), '', 'A verified check records the passing sandbox.');
  runner.refreshReadiness();
  ready = store.task(task.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reason, '');
});

test('the director chooses the test sandbox through the controller, and only from the known choices', async t => {
  const c = await setup(t);
  assert.equal((await c.request('/api/control', { testSandbox: 'none' })).status, 200);
  assert.equal(c.app.store.organization().testSandbox, 'none');
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message,
    /without a sandbox/,
  );
  const rejected = await c.request('/api/control', { testSandbox: 'docker' });
  assert.equal(rejected.status, 400);
  assert.equal(c.app.store.organization().testSandbox, 'none');
  assert.equal((await c.request('/api/control', { testSandbox: 'codex' })).status, 200);
  assert.equal(c.app.store.organization().testSandbox, 'codex');
  // The dashboard reads where the next tests run: the choice, or what having Codex CLI makes it.
  const read = async route => (await fetch(c.origin + route, { headers: { 'X-Studio-Token': c.token } })).json(),
    projectId = c.app.store.projects()[0].id;
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'codex');
  const org = c.app.store.organization();
  delete org.testSandbox;
  c.app.store.setOrganization(org);
  c.app.runner.codexBinary = undefined;
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'none');
  assert.equal((await read('/api/templates')).testSandbox, 'none', 'The first run reads it too.');
});
