// The computer's test turn after a restart (src/core/orchestrator.mjs, Runner's constructor): an attempt the stopped
// controller left running is interrupted and keeps its reservations until it is reconciled, except the test turn when
// every process it recorded is gone, so the other suites need not wait for the director. A run that may still be going
// keeps the turn, and nothing is started again. Model-free: records in a temporary store, reopened as a restart
// does, with the pid and start time of a process that has exited or of one still running (or of a running one recorded
// as started an hour before it did, as a later process that now has a recorded ID reads); the agent's own run uses the
// protocol fixtures. An attempt whose own process ran in a job of its own (processJob, src/adapters/process-job.mjs) is
// over once the controller that held the job's only handle has stopped, so after a restart its recorded ID, which may be
// another program's by then, is not checked; its agent's run of the whole suite, outside that job, still is. A carry or
// release the stop cut off while it was tested keeps the turn only while the test run it recorded under it may still
// go on (a real sleeping process stands for that run), and gives it back once that run has ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { testTurnResource } from '../src/core/test-turn.mjs';
import { attemptResource } from '../src/core/store.mjs';
import { recordedProcessesEnded } from '../src/core/orchestrator.mjs';
import { live, processStartTimes } from '../src/adapters/process.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { sourceResources } from '../src/connectors/source-projects.mjs';
import { keptTurnChecks } from '../src/core/autonomy-runtime.mjs';

const tests = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
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
  ].join('\n'),
  // A passing test run that ends once its gate file exists, so the test sees which attempt holds the turn meanwhile.
  gated = gate => ({
    executable: process.execPath,
    args: [
      '-e',
      `const fs = require('node:fs'); const wait = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(wait); console.log(${JSON.stringify(tap)}); } }, 20);`,
      gate,
    ],
  });
const holder = store => store.leases().find(lease => lease.resource === testTurnResource)?.attemptId ?? null;
const leasesOf = (store, id) =>
  store
    .leases()
    .filter(lease => lease.attemptId === id)
    .map(lease => lease.resource);
const turnEvents = (store, attemptId) =>
  store.events().filter(event => event.kind === 'test_turn' && event.attempt_id === attemptId);
const freed =
  /^The test turn was freed: the run that held it had ended when the controller started again\. Only the run's own process was checked; processes it started are not tracked yet and may outlive it\.$/;
// The same, for an attempt whose own process ran in a job of its own.
const freedWithJob =
  /^The test turn was freed: the run that held it ran in a job of its own, which ended with the controller, so nothing it started still runs\.$/;
const freedWithJobAndSuite =
  /^The test turn was freed: the run that held it ran in a job of its own, which ended with the controller, so nothing it started still runs\. Its agent's run of the whole suite ran outside that job: only that run's own process was checked; processes it started are not tracked yet and may outlive it\.$/;
const project = 'source:project-legacy:fixture-held';

const hour = 60 * 60 * 1000;
// A process that has exited: its pid and start time are recorded, and nothing answers to it. As a stopped controller's
// record reads, it started well before the restart (here a minute before the fixture ran it, more than the check's
// slack): a later process the operating system hands its ID meanwhile, as Windows does quickly while other suites run,
// started after it and is not taken for it. The start of a process that has exited cannot be checked anyway.
function exited() {
  const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
  return { pid: spawnSync(process.execPath, ['-e', '']).pid, startedAt };
}
// A process that runs until the test stops it. As the controller starts an attempt's own process (a.pid), a leader
// leads a process group of its own on macOS and Linux, which is what the liveness check looks for there; an agent's run
// of the whole suite (employeeTestPid) is started without one, as connectors/employee-tests.mjs starts it. Its start
// time is taken right after the spawn returns, as the controller records it: its true start.
function liveProcess(t, { leader }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: leader && process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  const startedAt = new Date().toISOString();
  const ended = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    child.kill();
    await ended;
  };
  t.after(stop);
  return { pid: child.pid, startedAt, stop };
}
// The same running process as a later one that now has a recorded ID reads: recorded as started an hour before it did.
const reused = process => ({ ...process, startedAt: new Date(Date.parse(process.startedAt) - hour).toISOString() });
// An attempt's recorded processes: its own (pid) and its agent's run of the whole suite (employeeTestPid).
const recorded = ({ own, suite }) => ({
  pid: own.pid,
  pidStartedAt: own.startedAt,
  employeeTestPid: suite.pid,
  employeeTestStartedAt: suite.startedAt,
});

// A task with an attempt the controller recorded as running when it stopped, and the leases it held.
function running(store, { taskId, attemptId, workerId = 'W-07', fields = {}, resources = [] }) {
  const worker = store.organization().workers.find(item => item.id === workerId);
  store.putTask({
    id: taskId,
    projectId: 'project-legacy',
    title: `Fixture ${taskId}`,
    brief: 'Measure the current commit.',
    acceptance: '',
    kind: 'studio-development:checks',
    workerId,
    team: worker.team,
    dependencies: [],
    resources: [],
    maxSeconds: 120,
    maxAttempts: 3,
    direction: '',
    status: 'running',
    reason: '',
    hold: false,
    lastAttemptId: attemptId,
    createdAt: '2026-11-03T09:00:00.000Z',
  });
  store.insertAttempt(
    {
      id: attemptId,
      taskId,
      projectId: 'project-legacy',
      workerId,
      provider: 'codex',
      status: 'running',
      contracts: { adapter: { id: 'source-checks', version: 'source-checks-adapter-v1' } },
      startedAt: '2026-11-03T09:00:00.000Z',
      artifacts: [],
      inputReferences: [],
      pid: null,
      ...fields,
    },
    { hash: 'snapshot', text: 'Instructions.' },
  );
  store.claim([attemptResource(attemptId), ...resources], attemptId);
}

// An idea's checks, as intake creates them.
function addChecks(store, id) {
  const worker = store.organization().workers.find(item => item.id === 'W-06');
  store.putTask({
    id,
    projectId: 'project-legacy',
    title: 'Check the current commit',
    brief: 'Measure the current commit.',
    acceptance: '',
    kind: 'studio-development:checks',
    workerId: 'W-06',
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

// A studio on temporary records. An interrupted attempt takes one of the studio's slots until it is reconciled, so there
// are slots enough for the attempts these tests leave interrupted and the checks that follow them.
async function restartStudio(t) {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    org = c.app.store.organization();
  org.maxParallel = 4;
  c.app.store.setOrganization(org);
  return c;
}

// The controller stops at once and starts again on the same records.
async function restart(c) {
  await c.app.close();
  c.app = createStudio(c.options);
  return c.app;
}

test('a turn whose run has ended is freed on restart; the attempt stays interrupted with its other leases, and another suite takes the turn', async t => {
  const c = await restartStudio(t);
  running(c.app.store, {
    taskId: 'T-held',
    attemptId: 'attempt-held',
    fields: recorded({ own: exited(), suite: exited() }),
    resources: [project, testTurnResource],
  });
  // One only waiting for the turn when the controller stopped, as a candidate's tests wait: no process, no turn.
  running(c.app.store, {
    taskId: 'T-waiting',
    attemptId: 'attempt-waiting',
    workerId: 'W-02',
    fields: {
      contracts: { adapter: { id: 'source-change', version: 'source-change-adapter-v2' } },
      testTurn: {
        reason:
          'Waiting for the tests of T-held (Fixture T-held) to finish: this computer runs one full test suite at a time.',
        since: '2026-11-03T09:01:00.000Z',
        holder: 'attempt-held',
      },
    },
  });
  const { store, runner } = await restart(c);

  const held = store.attempt('attempt-held');
  assert.equal(held.status, 'interrupted');
  assert.equal(store.task('T-held').status, 'blocked');
  assert.equal(store.task('T-held').reason, 'Controller restarted. Reconcile the previous attempt before retrying.');
  assert.equal(holder(store), null, 'The turn is free.');
  assert.deepEqual(leasesOf(store, 'attempt-held'), [attemptResource('attempt-held'), project].sort());
  assert.deepEqual(
    turnEvents(store, 'attempt-held').map(event => event.message),
    [turnFreedMessage(store)],
  );
  assert.match(turnFreedMessage(store), freed);
  // Nothing of it is started again.
  assert.equal(runner.active.has('attempt-held'), false);
  assert.deepEqual(
    store.attempts('T-held').map(a => a.id),
    ['attempt-held'],
  );
  assert.throws(() => runner.start('T-held'), /Reconcile the interrupted attempt before starting another\./);

  // The waiter holds no turn and no longer waits.
  const waiter = store.attempt('attempt-waiting');
  assert.equal(waiter.status, 'interrupted');
  assert.equal(waiter.testTurn, undefined);
  assert.deepEqual(leasesOf(store, 'attempt-waiting'), [attemptResource('attempt-waiting')]);
  assert.deepEqual(turnEvents(store, 'attempt-waiting'), []);

  // Another attempt's checks take the turn and run, without waiting for a reconciliation.
  const gate = path.join(c.directory, 'checks-gate');
  runner.sourceCheckCommand = gated(gate);
  const check = runner.start(addChecks(store, 'T-check')).attemptId;
  await waitFor(() => holder(store) === check, 'the checks to take the turn');
  assert.equal(store.attempt(check).testTurn, undefined);
  fs.writeFileSync(gate, '');
  const done = await c.wait('T-check');
  assert.equal(done.result.checks[0].status, 'pass');
  assert.deepEqual(turnEvents(store, check), [], 'It never waited.');
  assert.equal(holder(store), null);
  // The interrupted attempt still waits for the director, with its other leases.
  assert.equal(store.attempt('attempt-held').status, 'interrupted');
  assert.deepEqual(leasesOf(store, 'attempt-held'), [attemptResource('attempt-held'), project].sort());
});

function turnFreedMessage(store) {
  return turnEvents(store, 'attempt-held').at(-1)?.message;
}

test('an attempt whose recorded processes now belong to later processes has its turn freed on restart and can be reconciled', async t => {
  const c = await restartStudio(t),
    own = liveProcess(t, { leader: true }),
    suite = liveProcess(t, { leader: false });
  running(c.app.store, {
    taskId: 'T-held',
    attemptId: 'attempt-held',
    fields: recorded({ own: reused(own), suite: reused(suite) }),
    resources: [project, testTurnResource],
  });
  const { store, runner } = await restart(c);
  assert.equal(store.attempt('attempt-held').status, 'interrupted');
  assert.equal(holder(store), null, 'The turn is free.');
  assert.deepEqual(leasesOf(store, 'attempt-held'), [attemptResource('attempt-held'), project].sort());
  assert.match(turnFreedMessage(store), freed);
  assert.equal(turnEvents(store, 'attempt-held').length, 1);
  assert.equal(runner.active.has('attempt-held'), false, 'Nothing is started again.');
  // The processes holding its IDs started after the recorded ones, so they are not the attempt's: Reconcile goes ahead
  // while they still run.
  runner.reconcile('T-held');
  assert.equal(store.task('T-held').status, 'ready');
  assert.ok(store.attempt('attempt-held').reconciledAt);
  assert.deepEqual(leasesOf(store, 'attempt-held'), []);
});

for (const [label, field] of [
  ['its own process', 'pid'],
  ["its agent's run of the whole suite", 'employeeTestPid'],
])
  test(`an attempt whose recorded process may still run (${label}) keeps the turn after restart until it is reconciled`, async t => {
    const c = await restartStudio(t),
      alive = liveProcess(t, { leader: field === 'pid' });
    running(c.app.store, {
      taskId: 'T-held',
      attemptId: 'attempt-held',
      fields: recorded({ own: exited(), suite: exited(), [field === 'pid' ? 'own' : 'suite']: alive }),
      resources: [project, testTurnResource],
    });
    const { store, runner } = await restart(c);
    assert.equal(store.attempt('attempt-held').status, 'interrupted');
    assert.equal(holder(store), 'attempt-held', 'The turn stays held.');
    assert.deepEqual(
      leasesOf(store, 'attempt-held'),
      [attemptResource('attempt-held'), project, testTurnResource].sort(),
    );
    assert.deepEqual(turnEvents(store, 'attempt-held'), []);
    assert.equal(runner.active.has('attempt-held'), false, 'Nothing is started again.');
    // Another suite waits for it.
    const check = runner.start(addChecks(store, 'T-check')).attemptId;
    await waitFor(() => store.attempt(check).testTurn, 'the checks to wait for the turn');
    assert.equal(store.attempt(check).testTurn.holder, 'attempt-held');
    // Reconcile refuses while either recorded process may still run, naming which, and its leases stay held.
    assert.throws(
      () => runner.reconcile('T-held'),
      field === 'pid'
        ? /still has a live process\/group/
        : /still has a live process: its agent's run of the whole test suite/,
    );
    assert.equal(store.attempt('attempt-held').reconciledAt, undefined);
    assert.deepEqual(
      leasesOf(store, 'attempt-held'),
      [attemptResource('attempt-held'), project, testTurnResource].sort(),
    );
    // Once it ends, reconciling releases its leases with the turn, after which the waiting checks run.
    await alive.stop();
    runner.reconcile('T-held');
    assert.deepEqual(leasesOf(store, 'attempt-held'), []);
    const done = await c.wait('T-check');
    assert.equal(done.result.checks[0].status, 'pass');
    assert.equal(holder(store), null);
  });

test('the restart check reads every process an attempt recorded', async t => {
  const ended = exited(),
    gone = ended.pid,
    attempt = liveProcess(t, { leader: true }),
    // Not the leader of a process group, as an agent's run of the whole suite is not: it still counts as running.
    suite = liveProcess(t, { leader: false });
  assert.equal(recordedProcessesEnded({}), true, 'An attempt that recorded no process has none running.');
  // With the start times each process is recorded with.
  assert.equal(recordedProcessesEnded(recorded({ own: ended, suite: ended })), true);
  assert.equal(recordedProcessesEnded(recorded({ own: attempt, suite: ended })), false, 'Its true start: running.');
  assert.equal(recordedProcessesEnded(recorded({ own: ended, suite })), false, 'Its true start: running.');
  // A recorded ID that a later process now has: that process started after the recorded one, so it is not the one.
  assert.equal(recordedProcessesEnded(recorded({ own: reused(attempt), suite: ended })), true);
  assert.equal(recordedProcessesEnded(recorded({ own: ended, suite: reused(suite) })), true);
  assert.equal(recordedProcessesEnded(recorded({ own: reused(attempt), suite: reused(suite) })), true);
  assert.equal(recordedProcessesEnded(recorded({ own: reused(attempt), suite })), false, 'One really runs.');
  assert.equal(recordedProcessesEnded(recorded({ own: attempt, suite: reused(suite) })), false, 'One really runs.');
  // Records made before start times were recorded keep the answer by ID alone.
  assert.equal(recordedProcessesEnded({ pid: gone, employeeTestPid: gone }), true);
  assert.equal(recordedProcessesEnded({ pid: attempt.pid }), false);
  assert.equal(recordedProcessesEnded({ pid: attempt.pid, employeeTestPid: gone }), false);
  assert.equal(recordedProcessesEnded({ pid: gone, employeeTestPid: suite.pid }), false);
  assert.equal(recordedProcessesEnded({ employeeTestPid: suite.pid }), false);
  await suite.stop();
  assert.equal(recordedProcessesEnded({ pid: gone, employeeTestPid: suite.pid }), true, 'Once it exits, it is gone.');
  await attempt.stop();
  assert.equal(recordedProcessesEnded({ pid: attempt.pid, employeeTestPid: suite.pid }), true);
});

test("an agent's run of the whole suite records its process while it holds the turn; a run of named files does not", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], { claudeBinary: claudeFixture }),
    { store, runner } = c.app;
  const org = store.organization();
  Object.assign(
    org.workers.find(worker => worker.id === store.task(c.taskId).workerId),
    { provider: 'claude' },
  );
  store.setOrganization(org);
  const task = store.task(c.taskId);
  task.title = `Hang while editing: ${task.title}`;
  store.putTask(task);
  let mode = 'pass';
  Object.defineProperty(runner, 'sourceCheckCommand', {
    configurable: true,
    get: () => ({ executable: process.execPath, args: [tests, mode] }),
  });
  await c.start();
  const entry = await waitFor(
    () => [...runner.active.values()].find(item => item.employeeTests && item.child && item.attempt.pid),
    'the editor to run with its test endpoint open',
  );
  const id = entry.attempt.id,
    { STUDIO_TESTS_URL: url, STUDIO_TESTS_TOKEN: token } = entry.toolEnvironment,
    run = (files = [], signal) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Attempt-Token': token },
        body: JSON.stringify({ files }),
        signal,
      }).then(response => response.json());
  // Named test files take no turn, so their process is not recorded.
  mode = 'hang';
  const named = new AbortController(),
    namedRun = run(['test/bounded.test.mjs'], named.signal).catch(error => error.name);
  await waitFor(() => entry.employeeTests?.child?.pid, 'the named run to start');
  assert.equal(holder(store), null);
  assert.equal(store.attempt(id).employeeTestPid, undefined);
  named.abort();
  assert.equal(await namedRun, 'AbortError');
  await waitFor(() => !entry.employeeTests.busy, 'the named run to end');
  // The whole suite holds the turn, and its running process is on the attempt until it closes.
  const whole = new AbortController(),
    wholeRun = run([], whole.signal).catch(error => error.name);
  await waitFor(() => {
    const child = entry.employeeTests?.child;
    return holder(store) === id && child?.pid && store.attempt(id).employeeTestPid === child.pid;
  }, 'the whole suite to run with the turn and its process recorded');
  assert.notEqual(store.attempt(id).employeeTestPid, store.attempt(id).pid, "It is not the editor's own process.");
  // With when it started: after the editor's own process, and not later than now.
  const suiteStart = Date.parse(store.attempt(id).employeeTestStartedAt);
  assert.ok(Number.isFinite(suiteStart), 'Its start time is recorded.');
  assert.ok(suiteStart <= Date.now());
  assert.ok(suiteStart >= Date.parse(store.attempt(id).pidStartedAt), "It started after the editor's own process.");
  whole.abort();
  assert.equal(await wholeRun, 'AbortError');
  await waitFor(() => !entry.employeeTests.busy, 'the whole suite to end');
  assert.equal(store.attempt(id).employeeTestPid, undefined, 'The record clears when the run ends.');
  assert.equal(store.attempt(id).employeeTestStartedAt, undefined, 'With its start time.');
  assert.equal(holder(store), null);
  assert.equal((await c.request(`/api/tasks/${c.taskId}/cancel`)).status, 202);
  await c.wait(c.taskId, 'cancelled');
});

// A running process of another program that now has the ID a jobbed attempt recorded, as Windows hands out a freed ID
// quickly: recorded with its true start time, so the process check alone would take it for the attempt's.
test('an attempt that ran in a job of its own is over after a restart: its turn is freed and Reconcile goes ahead without checking its process', async t => {
  const c = await restartStudio(t),
    other = liveProcess(t, { leader: true });
  running(c.app.store, {
    taskId: 'T-held',
    attemptId: 'attempt-held',
    fields: { pid: other.pid, pidStartedAt: other.startedAt, processJob: true },
    resources: [project, testTurnResource],
  });
  // Neither the start time reader nor a signal to the recorded ID decides it.
  const reads = t.mock.method(processStartTimes, 'read', () => 'unknown'),
    signals = t.mock.method(process, 'kill'),
    signalled = () => signals.mock.calls.filter(call => Math.abs(call.arguments[0]) === other.pid);
  const { store, runner } = await restart(c);
  const held = store.attempt('attempt-held');
  assert.equal(held.status, 'interrupted');
  assert.equal(held.processJob, true);
  assert.equal(held.processJobEndedAt, held.finishedAt, 'Its job ended with the previous controller.');
  assert.equal(store.task('T-held').status, 'blocked');
  assert.equal(holder(store), null, 'The turn is free.');
  assert.deepEqual(leasesOf(store, 'attempt-held'), [attemptResource('attempt-held'), project].sort());
  assert.equal(turnEvents(store, 'attempt-held').length, 1);
  assert.match(turnFreedMessage(store), freedWithJob);
  assert.equal(runner.active.has('attempt-held'), false, 'Nothing is started again.');
  runner.reconcile('T-held');
  assert.equal(store.task('T-held').status, 'ready');
  assert.ok(store.attempt('attempt-held').reconciledAt);
  assert.deepEqual(leasesOf(store, 'attempt-held'), [], 'Its reservations are released.');
  assert.equal(reads.mock.callCount(), 0, 'Its start time was never read.');
  assert.deepEqual(signalled(), [], 'Its recorded ID was never signalled.');
  // The process holding the ID still runs, and without the mark the process check would take it for the attempt's.
  signals.mock.restore();
  reads.mock.restore();
  assert.doesNotThrow(() => process.kill(other.pid, 0), 'The recorded ID still answers.');
  assert.equal(live({ ...store.attempt('attempt-held'), processJobEndedAt: undefined }), true);
  assert.equal(live(store.attempt('attempt-held')), false);
});

test('an attempt without a job keeps its process check after a restart: a live recorded ID keeps the turn and refuses Reconcile', async t => {
  const c = await restartStudio(t),
    alive = liveProcess(t, { leader: true });
  running(c.app.store, {
    taskId: 'T-held',
    attemptId: 'attempt-held',
    fields: { pid: alive.pid, pidStartedAt: alive.startedAt },
    resources: [project, testTurnResource],
  });
  const { store, runner } = await restart(c);
  const held = store.attempt('attempt-held');
  assert.equal(held.status, 'interrupted');
  assert.equal(held.processJobEndedAt, undefined, 'Only an attempt that ran in a job is marked.');
  assert.equal(holder(store), 'attempt-held', 'The turn stays held.');
  assert.deepEqual(turnEvents(store, 'attempt-held'), []);
  assert.throws(
    () => runner.reconcile('T-held'),
    /^Error: Attempt attempt-held still has a live process\/group\. Stop it in your terminal before reconciling\.$/,
  );
  assert.equal(store.task('T-held').status, 'blocked');
  assert.deepEqual(
    leasesOf(store, 'attempt-held'),
    [attemptResource('attempt-held'), project, testTurnResource].sort(),
  );
  await alive.stop();
  runner.reconcile('T-held');
  assert.deepEqual(leasesOf(store, 'attempt-held'), []);
});

test("a jobbed attempt whose agent's run of the whole suite may still run keeps the turn after restart", async t => {
  const c = await restartStudio(t),
    suite = liveProcess(t, { leader: false });
  running(c.app.store, {
    taskId: 'T-held',
    attemptId: 'attempt-held',
    fields: { ...recorded({ own: exited(), suite }), processJob: true },
    resources: [project, testTurnResource],
  });
  const { store, runner } = await restart(c);
  const held = store.attempt('attempt-held');
  assert.equal(held.status, 'interrupted');
  assert.ok(held.processJobEndedAt);
  assert.equal(holder(store), 'attempt-held', 'The suite ran outside the job: the turn stays held.');
  assert.deepEqual(turnEvents(store, 'attempt-held'), []);
  assert.equal(recordedProcessesEnded(held), false);
  await suite.stop();
  assert.equal(recordedProcessesEnded(held), true, 'Once it exits, it is gone.');
  runner.reconcile('T-held');
  assert.deepEqual(leasesOf(store, 'attempt-held'), []);
});

test("a jobbed attempt's freed turn says its agent's run of the whole suite was checked by its own process only", async t => {
  const c = await restartStudio(t);
  running(c.app.store, {
    taskId: 'T-held',
    attemptId: 'attempt-held',
    fields: { ...recorded({ own: exited(), suite: exited() }), processJob: true },
    resources: [project, testTurnResource],
  });
  const { store } = await restart(c);
  assert.equal(holder(store), null, 'The turn is free.');
  assert.equal(turnEvents(store, 'attempt-held').length, 1);
  assert.match(turnFreedMessage(store), freedWithJobAndSuite);
});

// Carries and releases the stop cut off while they were tested (1.1 steps 4 and 5, keepStoppedTurn in
// src/connectors/source-carries.mjs): their other leases are released as before, and the test turn is kept while the
// test run each recorded under it (testProcess) may still go on, then given back once that run has ended.
const legacy = 'project-legacy',
  tick = () => new Promise(resolve => setImmediate(resolve)),
  count = (store, kind) => store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind=?').get(kind).n,
  // A carry's or release's test_turn events, read from the records themselves.
  turnMessages = (store, taskId) =>
    store.db
      .prepare("SELECT message FROM events WHERE kind='test_turn' AND task_id=? ORDER BY seq")
      .all(taskId)
      .map(event => event.message),
  freedCarry =
    /^The test turn was freed: the carry's test run that held it has ended\. Only the run's own process was checked; processes it started are not tracked yet and may outlive it\.$/,
  freedCarryOnRestart =
    /^The test turn was freed: the carry's test run that held it had ended when the controller started again\. Only the run's own process was checked; processes it started are not tracked yet and may outlive it\.$/,
  freedCarryWithoutRun =
    /^The test turn was freed: the carry had started no test run under it when the controller stopped, so nothing it started still runs\.$/,
  freedRelease =
    /^The test turn was freed: the release's test run that held it has ended\. Only the run's own process was checked; processes it started are not tracked yet and may outlive it\.$/;

// A fix integrated on release/1.0 whose carry to main the director approved, recorded as the stop found it: being
// tested in a project that was running, holding its project's source and the test turn, with the test process it
// recorded under the turn (testProcess), if any.
async function stoppedCarry(t, testProcess) {
  const c = await setup(t);
  git(c.root, ['branch', 'release/1.0']);
  const added = await c.request(`/api/projects/${legacy}/lines`, { projectId: legacy, branch: 'release/1.0' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  c.taskId = await c.propose('fix', { branch: 'release/1.0' });
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  await c.settled(review, ['integrated']);
  const pipeline = action => c.request('/api/pipeline', { projectId: legacy, action });
  assert.equal((await pipeline('pause')).status, 200);
  const approved = await c.request(`/api/tasks/${c.taskId}/carry`, { projectId: legacy, line: 'main' });
  assert.equal(approved.status, 202, JSON.stringify(approved.data));
  const carryId = stopWhileTesting(c, review, testProcess);
  return { c, review, carryId, pipeline, mainTip: git(c.root, ['rev-parse', 'main']) };
}
function stopWhileTesting(c, review, testProcess) {
  const store = c.app.store,
    attempt = store.attempt(review.id),
    journal = attempt.sourceCarries[0];
  Object.assign(journal, { state: 'verifying', startedAt: new Date().toISOString() });
  if (testProcess) journal.testProcess = testProcess;
  store.tx(() => {
    store.claim([...sourceResources(store, store.task(c.taskId)), testTurnResource], journal.id);
    store.updateAttempt(attempt);
  });
  const running = store.project(legacy);
  running.dispatchPaused = false;
  store.putProject(running);
  return journal.id;
}
const carryOf = (store, review) => store.attempt(review.id).sourceCarries[0];
// Another full suite, an idea's checks, whose test run ends once its gate file exists.
function waitingChecks(c, id) {
  const runner = c.app.runner,
    gate = path.join(c.directory, `${id}-gate`),
    original = runner.sourceCheckCommand;
  runner.sourceCheckCommand = gated(gate);
  const attemptId = runner.start(addChecks(c.app.store, id)).attemptId;
  return {
    attemptId,
    finish: async () => {
      fs.writeFileSync(gate, '');
      const done = await c.wait(id);
      runner.sourceCheckCommand = original;
      return done;
    },
  };
}

test('a carry stopped while it was tested keeps the test turn while its test run goes on, and gives it back at the next try once the run has ended', async t => {
  const run = liveProcess(t, { leader: true });
  const { c, review, carryId } = await stoppedCarry(t, { pid: run.pid, startedAt: run.startedAt });
  await c.app.close();
  await c.reopen();
  const { store, runner } = c.app;
  assert.equal(carryOf(store, review).state, 'waiting');
  assert.equal(holder(store), carryId, 'The turn stays held while its run may still go on.');
  assert.deepEqual(leasesOf(store, carryId), [testTurnResource], 'Its other leases are released, as before.');
  assert.deepEqual(turnMessages(store, review.taskId), []);
  // Another suite waits for the turn and does not get it, however often carries and releases are tried.
  const checks = waitingChecks(c, 'T-check');
  await waitFor(() => store.attempt(checks.attemptId).testTurn, 'the checks to wait for the turn');
  assert.equal(store.attempt(checks.attemptId).testTurn.holder, carryId);
  for (let i = 0; i < 2; i++) {
    runner.autonomy.tryCarries();
    runner.autonomy.tryReleases();
    await tick();
  }
  assert.equal(holder(store), carryId);
  assert.equal(runner.keptTurns.size, 1);
  // Once the run has ended, the next try gives the turn back, once, and the waiting suite takes it.
  await run.stop();
  runner.autonomy.tryCarries();
  assert.notEqual(holder(store), carryId);
  assert.equal(carryOf(store, review).testProcess, undefined, 'Its recorded process is cleared.');
  const messages = turnMessages(store, review.taskId);
  assert.equal(messages.length, 1);
  assert.match(messages[0], freedCarry);
  await waitFor(() => holder(store) === checks.attemptId, 'the checks to take the turn');
  assert.equal((await checks.finish()).result.checks[0].status, 'pass');
  runner.autonomy.tryCarries();
  assert.equal(turnMessages(store, review.taskId).length, 1, 'It is given back once.');
  assert.equal(runner.keptTurns.size, 0);
  assert.equal(runner.autonomy.keptTurnTimer, null, 'No timer runs while no turn is kept.');
  // The carry still waits for the project's Resume.
  assert.deepEqual([carryOf(store, review).state, store.project(legacy).dispatchPaused], ['waiting', true]);
  assert.equal(count(store, 'carry_verifying'), 0);
});

test("a carry whose recorded test run had ended, or that recorded none, gives the turn back during the restart's recovery", async t => {
  const { c, review, carryId } = await stoppedCarry(t, exited());
  await c.app.close();
  await c.reopen();
  let store = c.app.store;
  assert.equal(holder(store), null, 'The turn is free.');
  assert.deepEqual(leasesOf(store, carryId), []);
  assert.equal(carryOf(store, review).testProcess, undefined);
  assert.equal(carryOf(store, review).state, 'waiting');
  let messages = turnMessages(store, review.taskId);
  assert.equal(messages.length, 1);
  assert.match(messages[0], freedCarryOnRestart);
  assert.equal(c.app.runner.keptTurns?.size ?? 0, 0);
  assert.equal(c.app.runner.autonomy.keptTurnTimer, null);
  // Stopped again while it held the turn before any test run had started under it.
  stopWhileTesting(c, review, null);
  await c.app.close();
  await c.reopen();
  store = c.app.store;
  assert.equal(holder(store), null);
  assert.deepEqual(leasesOf(store, carryId), []);
  messages = turnMessages(store, review.taskId);
  assert.equal(messages.length, 2);
  assert.match(messages[1], freedCarryWithoutRun);
});

test('a held carry does not start while its own old turn is kept; the timer gives the turn back once its run has ended, and the resumed carry lands once', async t => {
  const every = keptTurnChecks.everyMs;
  keptTurnChecks.everyMs = 50;
  t.after(() => {
    keptTurnChecks.everyMs = every;
  });
  const run = liveProcess(t, { leader: true });
  const { c, review, carryId, pipeline, mainTip } = await stoppedCarry(t, { pid: run.pid, startedAt: run.startedAt });
  await c.app.close();
  await c.reopen();
  const { store, runner } = c.app;
  assert.ok(runner.autonomy.keptTurnTimer, 'A timer runs while the turn is kept.');
  // Resumed while its turn is kept: the carry is busy, waiting for its own old run, with no note for the director.
  assert.equal((await pipeline('resume')).status, 200);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(holder(store), carryId);
  assert.equal(carryOf(store, review).state, 'waiting');
  assert.equal(count(store, 'carry_verifying'), 0);
  assert.ok(!runner.sourceIntegrationRun);
  assert.equal(store.task(c.taskId).autonomyNote, undefined);
  assert.equal(count(store, 'autonomy_attention'), 0);
  assert.equal(git(c.root, ['rev-parse', 'main']), mainTip);
  // Once the run has ended, the timer gives the turn back and the carry starts, once, and lands.
  await run.stop();
  const carry = await waitFor(
    () =>
      ['carried', 'rejected', 'needs-reconciliation'].includes(carryOf(store, review).state) &&
      !runner.sourceIntegrationRun &&
      carryOf(store, review),
    'the carry to settle',
    { detail: () => JSON.stringify(carryOf(store, review)) },
  );
  assert.equal(carry.state, 'carried', JSON.stringify(carry));
  const messages = turnMessages(store, review.taskId);
  assert.equal(messages.length, 1);
  assert.match(messages[0], freedCarry);
  assert.equal(count(store, 'carry_verifying'), 1);
  assert.equal(git(c.root, ['rev-parse', 'main']), carry.commit);
  assert.equal(git(c.root, ['rev-parse', 'main~1']), mainTip);
  assert.equal(store.leases().length, 0);
  assert.equal(runner.autonomy.keptTurnTimer, null, 'The timer stops once no turn is kept.');
});

test('a release stopped while it was tested keeps the test turn while its test run goes on, and gives it back at the next try once the run has ended', async t => {
  const c = await restartStudio(t),
    run = liveProcess(t, { leader: true }),
    id = `source-release:${legacy}:milestone-held`;
  // A release recorded as the stop found it: being tested, holding its project's source and the test turn.
  c.app.store.tx(() => {
    c.app.store.putSetting(`milestones:${legacy}`, [
      {
        id: 'milestone-held',
        version: '1.0.1',
        state: 'open',
        release: {
          id,
          state: 'verifying',
          reviewTaskId: 'T-notes',
          root: c.root,
          repository: { branch: 'main' },
          testProcess: { pid: run.pid, startedAt: run.startedAt },
          startedAt: new Date().toISOString(),
        },
      },
    ]);
    c.app.store.claim([project, testTurnResource], id);
  });
  const { store, runner } = await restart(c);
  const release = () => store.setting(`milestones:${legacy}`)[0].release;
  assert.equal(release().state, 'ready');
  assert.equal(holder(store), id, 'The turn stays held while its run may still go on.');
  assert.deepEqual(leasesOf(store, id), [testTurnResource], 'Its other leases are released, as before.');
  assert.deepEqual(turnMessages(store, 'T-notes'), []);
  const checks = waitingChecks(c, 'T-check');
  await waitFor(() => store.attempt(checks.attemptId).testTurn, 'the checks to wait for the turn');
  assert.equal(store.attempt(checks.attemptId).testTurn.holder, id);
  for (let i = 0; i < 2; i++) {
    runner.autonomy.tryReleases();
    await tick();
  }
  assert.equal(holder(store), id);
  await run.stop();
  runner.autonomy.tryReleases();
  assert.notEqual(holder(store), id);
  assert.equal(release().testProcess, undefined, 'Its recorded process is cleared.');
  assert.equal(release().state, 'ready', 'It still waits for the Resume.');
  const messages = turnMessages(store, 'T-notes');
  assert.equal(messages.length, 1);
  assert.match(messages[0], freedRelease);
  await waitFor(() => holder(store) === checks.attemptId, 'the checks to take the turn');
  assert.equal((await checks.finish()).result.checks[0].status, 'pass');
  assert.equal(turnMessages(store, 'T-notes').length, 1);
});
