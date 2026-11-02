// An integration requested while another is verifying waits for the source, then starts as soon as that one settles,
// passed or not, and one still waiting when the controller stops starts once it runs again (v1.0 item 30: on October
// 24 item 27's first story waited behind item 28's integration with no attempt left to settle and start it). The
// runner is a stand-in around a real store; no integration, git or model runs.
//
// An integration's verification tests take the computer's test turn (src/core/test-turn.mjs) as an idea's checks do,
// for the test run alone. Those tests run real integrations on the model-free fixture studio, with the fixture test
// command (runtime.sourceCheckCommand) on a disposable repository and no HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.mjs';
import { Autonomy } from '../src/core/autonomy-runtime.mjs';
import { bootstrapFactory } from '../src/core/bootstrap.mjs';
import { createRegistries } from '../src/registry.mjs';
import { createStudio } from './model-free-studio.mjs';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { integrateSource } from '../src/connectors/source-changes.mjs';
import { jobDirectory } from '../src/core/projects.mjs';
import { testTurnResource } from '../src/core/test-turn.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function studio(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-integration-queue-')),
    store = new Store(
      directory,
      bootstrapFactory(createRegistries(), { organizationPreset: 'game-studio', workflowPresets: [] }),
    );
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store.putSetting('project-autonomy:project-legacy', {
    revision: 1,
    enabled: true,
    kinds: {},
    retries: 0,
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  for (const id of ['T-first', 'T-second'])
    store.putTask({ id, title: id, kind: 'studio-development:change', status: 'done', dependencies: [] });
  // Each integration holds the repository's resource until it settles, as source integration does.
  const integrations = [];
  const integrate = (runner, task, attemptId, reviewHash, settled) => {
    store.claim(['source:repository'], 'source-integration:' + attemptId);
    integrations.push({
      taskId: task.id,
      settle(result) {
        store.release('source-integration:' + attemptId);
        settled(result);
      },
    });
    return { state: 'verifying' };
  };
  const runner = {
    store,
    closing: false,
    active: new Map(),
    selfHosted: false,
    schedule() {},
    integration: {
      target: (records, task) => task,
      resources: () => ['source:repository'],
      pauses: () => false,
      controllerSource: () => false,
      requested() {},
      failed() {},
    },
  };
  t.after(() => (runner.closing = true));
  return { store, runner, integrate, integrations };
}

test('an integration requested while another verifies starts as soon as that one settles, passed or not', async t => {
  const { store, runner, integrate, integrations } = studio(t),
    autonomy = new Autonomy(runner, { integrate });
  await tick();
  assert.equal(autonomy.requestIntegration(store.task('T-first'), 'attempt-first', 'hash-first').state, 'verifying');
  assert.equal(autonomy.requestIntegration(store.task('T-second'), 'attempt-second', 'hash-second').state, 'waiting');
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-first'],
  );
  assert.equal(autonomy.pendingIntegration().taskId, 'T-second');
  // The first settles; nothing else runs, and the waiting one starts by itself.
  integrations[0].settle({ state: 'integrated' });
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-first', 'T-second'],
  );
  assert.equal(autonomy.pendingIntegration(), null);
  // A failed integration frees the source too.
  assert.equal(autonomy.requestIntegration(store.task('T-first'), 'attempt-first-2', 'hash-first').state, 'waiting');
  integrations[1].settle({ state: 'failed', error: 'main moved during verification.' });
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-first', 'T-second', 'T-first'],
  );
  assert.match(store.task('T-second').autonomyNote, /main moved during verification/);
  integrations[2].settle({ state: 'integrated' });
  // What a settled integration schedules runs before the store closes.
  await tick();
});

test('an integration still waiting when the controller stopped starts once it runs again', async t => {
  const { store, runner, integrate, integrations } = studio(t);
  // As a stopped controller left it: a request recorded, nothing holding the source.
  store.putSetting('autonomy-integration', {
    taskId: 'T-second',
    attemptId: 'attempt-second',
    reviewHash: 'hash-second',
    projectId: 'project-legacy',
    requestedAt: new Date().toISOString(),
    paused: false,
    previousPaused: false,
    by: { type: 'policy', revision: 1, reason: 'Integrate after a passing review.' },
  });
  const autonomy = new Autonomy(runner, { integrate });
  assert.deepEqual(integrations, [], 'Not while the controller is still being built.');
  await tick();
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-second'],
  );
  assert.equal(autonomy.pendingIntegration(), null);
  integrations[0].settle({ state: 'integrated' });
  await tick();
});

const checkFixture = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  command = mode => ({ executable: process.execPath, args: [checkFixture, mode] }),
  tap = [
    'TAP version 13',
    '1..1',
    'ok 1 - gated fixture',
    '# tests 1',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n');
// A passing test run that ends once its gate file exists, so a test decides when a run holding the turn ends. It marks
// that it started (<gate>.started), since a verification takes the turn before its install and reads its test command
// only then.
const gated = gate => ({
  executable: process.execPath,
  args: [
    '-e',
    `const fs = require('node:fs'); fs.writeFileSync(process.argv[1] + '.started', ''); const wait = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(wait); console.log(${JSON.stringify(tap)}); } }, 20);`,
    gate,
  ],
});
const turnSentence = holder => `Waiting for ${holder} to finish: this computer runs one full test suite at a time.`;
const holder = store => store.leases().find(lease => lease.resource === testTurnResource)?.attemptId ?? null;
const leasesOf = (store, owner) =>
  store
    .leases()
    .filter(lease => lease.attemptId === owner)
    .map(lease => lease.resource);
const testPhases = (store, attemptId) => store.phaseEvents(attemptId).filter(event => event.payload.phaseId === 'test');
const turnEvents = (store, attemptId) => store.events(attemptId).filter(event => event.kind === 'test_turn');

// Each change of the turn's holder from now on, with null when it comes free; it is free now.
function turnHolders(t, store) {
  const seen = [];
  t.after(
    store.watchLeases(() => {
      const current = holder(store);
      if ((seen.at(-1) ?? null) !== current) seen.push(current);
    }),
  );
  return seen;
}

// An idea's checks, as intake creates them.
function addChecks(c, id) {
  const worker = c.app.store.organization().workers.find(worker => worker.id === 'W-06');
  c.app.store.putTask({
    id,
    projectId: 'project-legacy',
    title: 'Check the current commit',
    brief: 'Measure the current commit.',
    acceptance: '',
    kind: 'studio-development:checks',
    workerId: worker.id,
    team: worker.team,
    dependencies: [],
    resources: [],
    maxSeconds: 120,
    maxAttempts: 3,
    direction: '',
    status: 'ready',
    reason: '',
    hold: false,
    lastAttemptId: null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

// The fixture story run to an accepted, passing review, ready to integrate.
async function reviewed(c) {
  c.app.runner.start(c.taskId);
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  return review;
}
// Starts the story's integration; its verification goes on in the background.
function integrate(c, review) {
  const { store, runner } = c.app,
    journal = integrateSource(runner, store.task(c.taskId), review.id, store.attempt(review.id).artifacts[0].hash);
  return { journal, settled: runner.sourceIntegrationRun.promise, source: leasesOf(store, journal.id) };
}

test("an integration's verification waits for an idea check's test run, then tests and integrates; its journal records the wait until it takes the turn", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    gate = path.join(c.directory, 'checks-gate'),
    review = await reviewed(c),
    holders = turnHolders(t, store);
  runner.sourceCheckCommand = gated(gate);
  const check = runner.start(addChecks(c, 'T-check-a')).attemptId;
  await waitFor(() => holder(store) === check, "the checks' test run to take the turn");
  runner.sourceCheckCommand = command('pass');
  const { journal, settled, source } = integrate(c, review);
  assert.ok(source.length, "The integration holds its project's source.");
  const waiting = await waitFor(
    () => store.attempt(review.id).sourceIntegration.testTurn,
    'the verification to wait for the turn',
  );
  assert.equal(waiting.reason, turnSentence('the tests of T-check-a (Check the current commit)'));
  assert.equal(waiting.holder, check);
  assert.ok(Date.parse(waiting.since) <= Date.now());
  assert.deepEqual(
    turnEvents(store, review.id).map(event => event.message),
    [waiting.reason],
  );
  // It merged, formatted and installed, and keeps its project's source while no test process of its own runs.
  assert.equal(runner.integrationProcess ?? null, null);
  assert.equal(
    fs.existsSync(path.join(jobDirectory(store, review), 'integration', 'test-output-full.txt')),
    false,
    'Its test run has not started.',
  );
  assert.deepEqual(leasesOf(store, journal.id), source);
  assert.equal(holder(store), check);
  fs.writeFileSync(gate, '');
  const result = await settled;
  assert.equal(result.state, 'integrated', JSON.stringify(result));
  assert.equal(result.verification.totals.pass, 1);
  assert.equal(store.attempt(review.id).sourceIntegration.testTurn, undefined, 'Taking the turn clears the record.');
  assert.deepEqual(holders, [check, null, journal.id, null], "Its tests ran once the check's had ended.");
  assert.equal(turnEvents(store, review.id).length, 1);
  assert.equal((await c.wait('T-check-a')).result.checks[0].status, 'pass');
  assert.deepEqual(store.leases(), []);
});

test("an idea's checks wait while an integration's verification runs its tests, then run", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    gate = path.join(c.directory, 'verification-gate'),
    review = await reviewed(c),
    holders = turnHolders(t, store);
  runner.sourceCheckCommand = gated(gate);
  const { journal, settled } = integrate(c, review);
  await waitFor(() => holder(store) === journal.id, 'the verification to take the turn');
  assert.equal(store.attempt(review.id).sourceIntegration.testTurn, undefined, 'A free turn is taken with no wait.');
  assert.deepEqual(turnEvents(store, review.id), []);
  // It holds the turn from its install on; its gated test run reads the command once the install is done.
  await waitFor(() => fs.existsSync(gate + '.started'), "the verification's test run to start");
  runner.sourceCheckCommand = command('pass');
  const check = runner.start(addChecks(c, 'T-check-b')).attemptId;
  const waiting = await waitFor(() => store.attempt(check).testTurn, 'the checks to wait for the turn');
  assert.equal(waiting.reason, turnSentence(`the tests of ${c.taskId} (${store.task(c.taskId).title})`));
  assert.equal(waiting.holder, journal.id);
  assert.deepEqual(testPhases(store, check), [], 'No test process starts while it waits.');
  fs.writeFileSync(gate, '');
  assert.equal((await settled).state, 'integrated');
  const done = await c.wait('T-check-b');
  assert.equal(done.testTurn, undefined);
  assert.equal(done.result.checks[0].status, 'pass');
  assert.deepEqual(holders, [journal.id, null, check, null]);
  assert.deepEqual(store.leases(), []);
});

test('a verification gives the turn back when its tests fail and when its test run cannot start, so a later check runs', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    review = await reviewed(c),
    holders = turnHolders(t, store);
  for (const [mode, testCommand, error] of [
    ['fail', command('fail'), /^0\/1 tests passed/],
    ['missing', { executable: path.join(c.directory, 'no-such-test-command'), args: [] }, /ENOENT/],
  ]) {
    runner.sourceCheckCommand = testCommand;
    holders.length = 0;
    const { journal, settled } = integrate(c, review),
      result = await settled;
    assert.equal(result.state, 'rejected', mode);
    assert.match(result.error, error);
    assert.deepEqual(holders, [journal.id, null], `The ${mode} test run took the turn and gave it back.`);
    runner.sourceCheckCommand = command('pass');
    const id = addChecks(c, `T-check-after-${mode}`),
      check = runner.start(id).attemptId,
      done = await c.wait(id);
    assert.equal(done.result.checks[0].status, 'pass');
    assert.deepEqual(turnEvents(store, check), [], 'It never waited.');
    assert.deepEqual(store.leases(), []);
  }
});

test('a controller stop while the verification waits for the turn records it as interrupted, holding no turn', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true);
  let { store, runner } = c.app;
  const review = await reviewed(c);
  // The turn is held, as by a run whose holder is not yet reconciled.
  store.claim([testTurnResource], 'held-suite');
  const { journal, settled, source } = integrate(c, review);
  await waitFor(() => store.attempt(review.id).sourceIntegration.testTurn, 'the verification to wait for the turn');
  await c.app.close();
  assert.equal((await settled).state, 'verifying');
  c.app = createStudio(c.options);
  ({ store, runner } = c.app);
  const recorded = store.attempt(review.id).sourceIntegration;
  assert.deepEqual([recorded.state, recorded.interrupted], ['needs-reconciliation', 'verifying']);
  assert.equal(recorded.testTurn, undefined, 'It no longer waits.');
  const verification = store
    .phaseEvents(review.id)
    .map(event => event.payload)
    .filter(
      payload =>
        payload.integrationOccurrenceId === journal.phaseOccurrenceId && payload.phaseId === 'integration.verification',
    );
  assert.deepEqual(
    verification.map(payload => [payload.boundary, payload.outcome, payload.completionConfirmed]),
    [
      ['start', null, undefined],
      ['finish', 'interrupted', false],
    ],
  );
  // Its source stays held for reconciliation, as an integration cut off in verification keeps it; the turn is not.
  assert.deepEqual(leasesOf(store, journal.id), source);
  assert.notEqual(holder(store), journal.id);
});
