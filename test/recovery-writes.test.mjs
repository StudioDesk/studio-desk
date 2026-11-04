// An attempt and its task are saved in one step whenever restart recovery, a stop, a quarantine or Reconcile changes
// both (src/core/orchestrator.mjs, src/adapters/source-breakdown.mjs). Each test simulates a crash between the two
// writes by making the second store write throw once, then checks that nothing of the step was saved, and that the
// same step without the fault records what it always has. Model-free: temporary records, the simulated adapter, and no
// model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { Runner } from '../src/runner.mjs';

const restartReason = 'Controller restarted. Reconcile the previous attempt before retrying.',
  quarantineReason = 'Process/group is still live or unknown. Reservations retained until reconciliation.';

function studio(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-recovery-writes-')),
    app = createStudio({ directory, port: 0 }),
    org = app.store.organization();
  org.maxParallel = 10;
  app.store.setOrganization(org);
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return app;
}

// Makes the store write `name` throw on its call number `at` (0 is the first) and pass every other call through.
function crashOn(t, store, name, at = 0) {
  const original = store[name];
  let calls = 0;
  return t.mock.method(store, name, function (...args) {
    if (calls++ === at) throw new Error('Simulated crash between writes.');
    return original.apply(this, args);
  });
}

const eventsOf = (store, kind, taskId) =>
  store.events().filter(event => event.kind === kind && event.task_id === taskId);
const leasesOf = (store, attemptId) =>
  store
    .leases()
    .filter(lease => lease.attemptId === attemptId)
    .map(lease => lease.resource);

// A task with attempts recorded as `status`, each holding a resource of its own.
function recorded(store, { taskId, taskStatus, attempts }) {
  store.putTask({
    ...store.task('D-001'),
    id: taskId,
    title: `Fixture ${taskId}`,
    kind: 'general',
    dependencies: [],
    resources: [],
    status: taskStatus,
    reason: taskStatus === 'blocked' ? 'Earlier reason.' : '',
    queued: true,
    lastAttemptId: attempts.at(-1).id,
  });
  for (const { id, status } of attempts) {
    store.insertAttempt(
      { id, taskId, workerId: 'W-02', status, pid: null, assignment: store.task(taskId) },
      { text: 'Fixture instructions' },
    );
    store.claim([`fixture:${id}`], id);
  }
}

test('restart recovery saves the interrupted attempt and its blocked task together', t => {
  const { store, runner } = studio(t);
  recorded(store, {
    taskId: 'T-restart',
    taskStatus: 'running',
    attempts: [{ id: 'attempt-restart', status: 'running' }],
  });

  const crash = crashOn(t, store, 'putTask');
  assert.throws(() => new Runner(store, { registries: runner.registries }), /Simulated crash/);
  crash.mock.restore();
  assert.equal(store.attempt('attempt-restart').status, 'running');
  assert.equal(store.attempt('attempt-restart').finishedAt, undefined);
  assert.equal(store.task('T-restart').status, 'running');
  assert.equal(store.task('T-restart').queued, true);
  assert.deepEqual(eventsOf(store, 'interrupted', 'T-restart'), []);
  assert.deepEqual(leasesOf(store, 'attempt-restart'), ['fixture:attempt-restart']);

  new Runner(store, { registries: runner.registries });
  const attempt = store.attempt('attempt-restart'),
    task = store.task('T-restart');
  assert.equal(attempt.status, 'interrupted');
  assert.ok(attempt.finishedAt);
  assert.equal(task.status, 'blocked');
  assert.equal(task.queued, false);
  assert.equal(task.reason, restartReason);
  assert.deepEqual(
    eventsOf(store, 'interrupted', 'T-restart').map(event => [event.attempt_id, event.message]),
    [['attempt-restart', restartReason]],
  );
  // Restart keeps every reservation until Reconcile.
  assert.deepEqual(leasesOf(store, 'attempt-restart'), ['fixture:attempt-restart']);
});

test('a stop saves the stopping attempt, its stop context and its stopping task together', t => {
  const { store, runner } = studio(t),
    { attemptId } = runner.start('D-001'),
    entry = runner.active.get(attemptId);
  clearTimeout(entry.mockTimer);
  // A process that the fixture terminates without signalling anything, so the stop waits for its close.
  entry.child = { pid: undefined, unref() {} };
  runner.fixtureProcessTermination = () => {};
  entry.timedOut = true;

  const crash = crashOn(t, store, 'putTask');
  assert.throws(() => runner.stop(attemptId), /Simulated crash/);
  crash.mock.restore();
  assert.equal(store.attempt(attemptId).status, 'running');
  assert.equal(store.attempt(attemptId).stopContext, undefined);
  assert.equal(store.task('D-001').status, 'running');
  assert.deepEqual(eventsOf(store, 'stopping', 'D-001'), []);
  // The attempt in memory matches its record, so the stop can be asked again.
  assert.equal(entry.cancelled, false);
  assert.equal(entry.attempt.status, 'running');

  runner.stop(attemptId);
  const attempt = store.attempt(attemptId);
  assert.equal(attempt.status, 'stopping');
  assert.equal(attempt.stopContext.reason, 'time-limit');
  assert.equal(store.task('D-001').status, 'stopping');
  assert.deepEqual(
    eventsOf(store, 'stopping', 'D-001').map(event => event.message),
    ['Time limit reached; stopping the process.'],
  );
  assert.equal(entry.cancelled, true);
  // The process closes, and the attempt leaves before the studio shuts down.
  clearTimeout(entry.killTimer);
  entry.child = null;
  runner.finish(entry, null);
  assert.equal(runner.active.has(attemptId), false);
});

test('a quarantine saves the quarantined attempt and its blocked task together and keeps its leases', t => {
  const { store, runner } = studio(t),
    { attemptId } = runner.start('D-001'),
    entry = runner.active.get(attemptId);
  clearTimeout(entry.mockTimer);
  const leases = leasesOf(store, attemptId),
    finishedAt = store.attempt(attemptId).finishedAt;
  assert.ok(leases.length);
  // A recorded process whose ownership cannot be confirmed counts as live.
  entry.attempt.pid = 12345;
  const kill = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('Unknown process ownership'), { code: 'EPERM' });
  });

  const crash = crashOn(t, store, 'putTask');
  assert.throws(() => runner.finish(entry, null, 'Adapter failed after spawning.'), /Simulated crash/);
  crash.mock.restore();
  assert.equal(store.attempt(attemptId).status, 'running');
  assert.equal(store.attempt(attemptId).finishedAt, finishedAt);
  assert.equal(store.task('D-001').status, 'running');
  assert.deepEqual(eventsOf(store, 'quarantined', 'D-001'), []);
  assert.deepEqual(leasesOf(store, attemptId), leases);
  assert.equal(entry.attempt.status, 'running');

  runner.finish(entry, null, 'Adapter failed after spawning.');
  assert.equal(store.attempt(attemptId).status, 'quarantined');
  assert.ok(store.attempt(attemptId).finishedAt);
  assert.equal(store.task('D-001').status, 'blocked');
  assert.equal(store.task('D-001').reason, quarantineReason);
  assert.deepEqual(
    eventsOf(store, 'quarantined', 'D-001').map(event => [event.attempt_id, event.message]),
    [[attemptId, quarantineReason]],
  );
  assert.deepEqual(leasesOf(store, attemptId), leases);
  // The process is then confirmed gone, and the attempt leaves before the studio shuts down.
  kill.mock.restore();
  entry.attempt.pid = null;
  runner.finish(entry, null);
  assert.equal(runner.active.has(attemptId), false);
});

for (const [name, reconcile, message] of [
  [
    'the default Reconcile',
    (runner, taskId) => runner.reconcile(taskId),
    'Previous process is no longer live; reservations released.',
  ],
  [
    "the breakdown adapter's Reconcile",
    (runner, taskId) => runner.adapters.find('source-breakdown').reconcile(runner, taskId),
    'Previous process is no longer live; source reference removed and reservations released.',
  ],
])
  test(`${name} saves every attempt, its leases and the ready task together`, t => {
    const { store, runner } = studio(t),
      ids = ['attempt-first', 'attempt-second'];
    recorded(store, {
      taskId: 'T-reconcile',
      taskStatus: 'blocked',
      attempts: [
        { id: ids[0], status: 'interrupted' },
        { id: ids[1], status: 'quarantined' },
      ],
    });

    // The first attempt's write succeeds; the second fails.
    const crash = crashOn(t, store, 'updateAttempt', 1);
    assert.throws(() => reconcile(runner, 'T-reconcile'), /Simulated crash/);
    crash.mock.restore();
    assert.deepEqual(
      ids.map(id => [store.attempt(id).status, store.attempt(id).reconciledAt]),
      [
        ['interrupted', undefined],
        ['quarantined', undefined],
      ],
    );
    for (const id of ids) assert.deepEqual(leasesOf(store, id), [`fixture:${id}`]);
    assert.equal(store.task('T-reconcile').status, 'blocked');
    assert.equal(store.task('T-reconcile').reason, 'Earlier reason.');
    assert.deepEqual(eventsOf(store, 'reconciled', 'T-reconcile'), []);

    reconcile(runner, 'T-reconcile');
    for (const id of ids) {
      assert.equal(store.attempt(id).status, 'interrupted');
      assert.ok(store.attempt(id).reconciledAt);
      assert.deepEqual(leasesOf(store, id), []);
    }
    assert.equal(store.task('T-reconcile').status, 'ready');
    assert.equal(store.task('T-reconcile').reason, '');
    assert.deepEqual(
      eventsOf(store, 'reconciled', 'T-reconcile').map(event => event.message),
      [message],
    );
  });
