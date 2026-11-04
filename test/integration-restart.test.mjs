// The recovery drill (v1.0 criterion 3): a controller that stops at once during a source integration, as closing its
// window does, leaves the integration's journal where it was. When it starts again, that integration becomes
// uncertain and waits for Reconcile source integration, keeping the state it reached and the resources it held;
// one only waiting, or already settled, stays as it is. No git, model or integration runs.
//
// The computer's test turn is the exception (November 3, 2026): a verification records on its journal the process
// of the step it runs under the turn, and a restart gives back that one lease once the process is confirmed gone, so
// another project's suite runs; its other resources stay held until it is reconciled. Those tests run the fixture
// studio's integration (a disposable git repository, the fixture test command, no model) to shape the journal a stop
// would leave; the restart itself runs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createStudio } from './model-free-studio.mjs';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import {
  integrateSource,
  restoreSourceIntegration,
  sourceIntegrationResources,
} from '../src/connectors/source-changes.mjs';
import { testTurnResource } from '../src/core/test-turn.mjs';

const journal = (attemptId, state) => ({
  id: 'source-integration:' + attemptId,
  state,
  method: 'merge',
  startedAt: '2026-10-24T09:20:18.189Z',
});

test('an integration a stopped controller left running is uncertain once it starts again, and keeps its resources', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-integration-restart-'));
  let again;
  t.after(async () => {
    await again?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = createStudio({ directory, port: 0 });
  for (const [taskId, attemptId, state] of [
    ['T-verifying', 'attempt-verifying', 'verifying'],
    ['T-committing', 'attempt-committing', 'committing'],
    ['T-waiting', 'attempt-waiting', 'waiting'],
    ['T-abandoned', 'attempt-abandoned', 'abandoned'],
  ]) {
    first.store.putTask({
      id: taskId,
      title: taskId,
      kind: 'studio-development:change',
      status: 'done',
      dependencies: [],
    });
    first.store.insertAttempt(
      {
        id: attemptId,
        taskId,
        workerId: 'W-07',
        provider: 'claude',
        status: 'accepted',
        startedAt: '2026-10-24T09:19:00.000Z',
        finishedAt: '2026-10-24T09:20:00.000Z',
        artifacts: [],
        inputReferences: [],
        sourceIntegration: journal(attemptId, state),
      },
      { hash: 'snapshot', text: 'Instructions.' },
    );
  }
  first.store.claim(['source:project-x:integration', 'source:project-x:tests'], 'source-integration:attempt-verifying');
  // No integration process of the controller runs them, as when its window closed during each; a close finds
  // nothing to stop and leaves the journals as they are.
  await first.close();

  again = createStudio({ directory, port: 0 });
  const recorded = id => again.store.attempt(id).sourceIntegration;
  for (const [id, was] of [
    ['attempt-verifying', 'verifying'],
    ['attempt-committing', 'committing'],
  ]) {
    assert.equal(recorded(id).state, 'needs-reconciliation', id);
    assert.equal(recorded(id).interrupted, was, id);
    assert.equal(recorded(id).error, 'The controller stopped while this integration was running.', id);
  }
  assert.equal(recorded('attempt-waiting').state, 'waiting');
  assert.equal(recorded('attempt-abandoned').state, 'abandoned');
  assert.match(
    again.store
      .events()
      .filter(event => event.kind === 'source_attention' && event.task_id === 'T-verifying')
      .at(-1).message,
    /stopped part-way when the controller stopped \(during verifying\).*Use Reconcile source integration/,
  );
  // Its resources stay held until the director reconciles it.
  assert.deepEqual(
    again.store
      .leases()
      .filter(lease => lease.attemptId === 'source-integration:attempt-verifying')
      .map(lease => lease.resource)
      .sort(),
    ['source:project-x:integration', 'source:project-x:tests'],
  );
});

const tap = [
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
// A process that marks that it started (<gate>.started), then ends once its gate file exists, printing a passing run.
const gatedScript = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1] + '.started', ''); const wait = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(wait); console.log(${JSON.stringify(tap)}); } }, 20);`;
const gated = gate => ({ executable: process.execPath, args: ['-e', gatedScript, gate] });
const holder = store => store.leases().find(lease => lease.resource === testTurnResource)?.attemptId ?? null;
const leasesOf = (store, owner) =>
  store
    .leases()
    .filter(lease => lease.attemptId === owner)
    .map(lease => lease.resource)
    .sort();
const turnEvents = (store, attemptId) => store.events(attemptId).filter(event => event.kind === 'test_turn');
const turnFreed =
  "The test turn was freed: the integration's test run that held it had ended when the controller started again. Only the run's own process was checked; processes it started are not tracked yet and may outlive it.";

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
  return { journal, settled: runner.sourceIntegrationRun.promise };
}
// An idea's checks, as intake creates them: another full suite that takes the test turn.
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

// The settled integration shaped as a controller that stopped at once during its tests leaves it: in verification,
// the development copy not moved, holding the repository and the test turn, with testProcess as its journal recorded
// it. Then the controller starts again.
async function cutOffInVerification(c, review, integrated, testProcess) {
  const { finishedAt, commit, ...journal } = integrated,
    store = c.app.store,
    attempt = store.attempt(review.id);
  assert.ok(finishedAt && commit);
  git(c.root, ['reset', '--quiet', '--hard', integrated.repository.head]);
  attempt.sourceIntegration = {
    ...journal,
    state: 'verifying',
    repository: { branch: integrated.repository.branch, head: integrated.repository.head },
    testProcess,
  };
  const story = store.task(c.taskId);
  Object.assign(story.sourceStage, {
    phase: 'integration',
    current: 'waiting-for-integration',
    integration: { attemptId: review.id, id: journal.id, state: 'verifying' },
  });
  store.tx(() => {
    store.claim([...sourceIntegrationResources, testTurnResource], journal.id);
    store.updateAttempt(attempt);
    store.putTask(story);
  });
  await c.app.close();
  c.app = createStudio(c.options);
  const recorded = c.app.store.attempt(review.id).sourceIntegration;
  assert.deepEqual([recorded.state, recorded.interrupted], ['needs-reconciliation', 'verifying']);
  assert.deepEqual(recorded.testProcess, testProcess, 'The recorded process stays on the journal.');
  return journal.id;
}

test("a verification records its test run's process on its journal while it holds the turn, and once that run has ended a restart frees the turn alone", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true);
  let { store, runner } = c.app;
  const gate = path.join(c.directory, 'verification-gate'),
    review = await reviewed(c);
  runner.sourceCheckCommand = gated(gate);
  const { journal, settled } = integrate(c, review);
  await waitFor(() => fs.existsSync(gate + '.started'), "the verification's test run to start");
  // While the test run holds the turn, its process is recorded where the journal is kept, with when it started.
  assert.equal(holder(store), journal.id);
  const recorded = store.attempt(review.id).sourceIntegration.testProcess;
  assert.equal(recorded.pid, runner.integrationProcess.pid);
  assert.ok(Date.parse(recorded.startedAt) <= Date.now(), JSON.stringify(recorded));
  fs.writeFileSync(gate, '');
  const integrated = await settled;
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  // Giving the turn back clears it.
  assert.equal(integrated.testProcess, undefined);
  assert.equal(store.attempt(review.id).sourceIntegration.testProcess, undefined);
  assert.equal(holder(store), null);
  assert.deepEqual(turnEvents(store, review.id), []);

  // The same journal as a stop during that test run leaves it; the run's process has ended.
  const id = await cutOffInVerification(c, review, integrated, recorded);
  ({ store, runner } = c.app);
  assert.equal(holder(store), null, 'The test turn is free.');
  assert.deepEqual(leasesOf(store, id), [...sourceIntegrationResources].sort(), 'Its repository stays held.');
  assert.deepEqual(
    turnEvents(store, review.id).map(event => event.message),
    [turnFreed],
  );
  // Another project's checks take the turn and run.
  const after = path.join(c.directory, 'checks-gate');
  fs.writeFileSync(after, '');
  runner.sourceCheckCommand = gated(after);
  const check = runner.start(addChecks(c, 'T-check-after-restart')).attemptId,
    done = await c.wait('T-check-after-restart');
  assert.equal(done.result.checks[0].status, 'pass');
  assert.deepEqual(turnEvents(store, check), [], 'It never waited.');
  assert.equal(store.attempt(review.id).sourceIntegration.state, 'needs-reconciliation');
  assert.deepEqual(leasesOf(store, id), [...sourceIntegrationResources].sort());
});

test('a restart leaves the turn with an integration whose test run may still be going, and Reconcile frees it for the waiting suite', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true);
  let { store, runner } = c.app;
  const review = await reviewed(c),
    { settled } = integrate(c, review),
    integrated = await settled;
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  // A test run still going: its own process group on macOS and Linux, as the verification's steps are.
  const gate = path.join(c.directory, 'still-running-gate'),
    child = spawn(process.execPath, ['-e', gatedScript, gate], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    }),
    exited = new Promise(resolve => child.once('exit', resolve)),
    testProcess = { pid: child.pid, startedAt: new Date().toISOString() };
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await waitFor(() => fs.existsSync(gate + '.started'), 'the test run to start');
  const id = await cutOffInVerification(c, review, integrated, testProcess);
  ({ store, runner } = c.app);
  assert.equal(holder(store), id, 'The turn stays with the journal.');
  assert.deepEqual(leasesOf(store, id), [...sourceIntegrationResources, testTurnResource].sort());
  assert.deepEqual(turnEvents(store, review.id), []);
  // Another suite waits for it.
  const after = path.join(c.directory, 'checks-gate');
  fs.writeFileSync(after, '');
  runner.sourceCheckCommand = gated(after);
  const check = runner.start(addChecks(c, 'T-check-waits')).attemptId,
    waiting = await waitFor(() => store.attempt(check).testTurn, 'the checks to wait for the turn');
  assert.equal(waiting.holder, id);
  // The run ends, and Reconcile source integration settles the journal; the waiting suite then runs.
  fs.writeFileSync(gate, '');
  await exited;
  const reconciled = restoreSourceIntegration(runner, store.task(c.taskId));
  assert.equal(reconciled.state, 'abandoned', JSON.stringify(reconciled));
  assert.deepEqual(leasesOf(store, id), []);
  const done = await c.wait('T-check-waits');
  assert.equal(done.result.checks[0].status, 'pass');
  assert.equal(done.testTurn, undefined);
  assert.equal(holder(store), null);
});
