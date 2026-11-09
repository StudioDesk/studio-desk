// The first reason a stop was asked for is the attempt's cause (src/core/orchestrator.mjs stop). A director's Cancel
// takes up to a grace period to end the process on Windows; a time limit that falls due in that gap leaves the Cancel a
// Cancel, and is never recorded as 'Assignment time limit reached.'. An attempt whose limit fell due first keeps the
// time limit as its cause, even when the director cancels it while it stops.
//
// Model-free: temporary records and the simulated adapter, whose result is held back. The attempt is given a process
// that is slow to stop: the fixture's termination is recorded and never closes it, so the test decides when the stop
// completes. The time limit is short: its delay is shortened, as test/studio.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';

const limitSeconds = 7,
  limitMs = 40,
  timer = globalThis.setTimeout,
  wait = ms => new Promise(resolve => timer(resolve, ms));
const timeLimitError = 'Assignment time limit reached.';

// A studio whose attempt for D-001 runs with a short time limit and a process that is slow to stop.
function slowToStop(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cancel-cause-')),
    app = createStudio({ directory, port: 0 }),
    { store, runner } = app;
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const task = store.task('D-001');
  task.maxSeconds = limitSeconds;
  store.putTask(task);
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    timer(callback, delay === limitSeconds * 1000 ? limitMs : delay, ...args),
  );
  const terminations = [];
  runner.fixtureProcessTermination = (entry, force) => terminations.push(force);
  const { attemptId } = runner.start(task.id),
    entry = runner.active.get(attemptId);
  // The simulator's result never comes; the attempt is its process until the stop completes.
  clearTimeout(entry.mockTimer);
  entry.child = { pid: undefined, unref() {} };
  // The process closes: the adapter's close ends the attempt as a native process's does.
  const closed = () => {
    clearTimeout(entry.killTimer);
    entry.child = null;
    runner.finish(entry, null);
  };
  return { store, runner, attemptId, entry, terminations, closed };
}

const stoppingMessages = (store, attemptId) =>
  store
    .events()
    .filter(event => event.kind === 'stopping' && event.attempt_id === attemptId)
    .map(event => event.message);

test("a director's Cancel stays a Cancel when the time limit falls due before the process stops", async t => {
  const { store, runner, attemptId, entry, terminations, closed } = slowToStop(t);
  runner.stop(attemptId);
  assert.equal(store.attempt(attemptId).status, 'stopping');
  assert.deepEqual(terminations, [false], 'The process was asked to stop.');
  // The limit falls due while the process is still stopping.
  await wait(limitMs * 4);
  assert.equal(runner.active.has(attemptId), true, 'The process has not stopped yet.');
  assert.equal(entry.timedOut, false);
  assert.equal(store.attempt(attemptId).stopContext, undefined);
  // A limit an adapter armed itself (source-change's candidate checks, the test turn) falling due does not change the
  // cause either.
  entry.timedOut = true;
  runner.stop(attemptId);
  assert.equal(entry.timedOut, false);
  assert.deepEqual(stoppingMessages(store, attemptId), [
    'Cancellation requested. Reservations remain until the process closes.',
  ]);
  assert.deepEqual(terminations, [false], 'Nothing else was asked of the process.');

  closed();
  const attempt = store.attempt(attemptId),
    task = store.task('D-001');
  assert.equal(attempt.status, 'cancelled');
  assert.notEqual(attempt.error, timeLimitError);
  assert.equal(attempt.stopContext, undefined, 'No time-limit stop is recorded.');
  assert.equal(task.status, 'cancelled');
  assert.notEqual(task.reason, timeLimitError);
  assert.equal(
    store.events().some(event => event.attempt_id === attemptId && event.message === timeLimitError),
    false,
    'No event records a time limit.',
  );
  assert.equal(store.leases().length, 0);
});

test('an attempt whose time limit fell due first records the time limit, even when the director cancels it while it stops', async t => {
  const { store, runner, attemptId, entry, terminations, closed } = slowToStop(t);
  await wait(limitMs * 4);
  assert.equal(entry.timedOut, true);
  assert.equal(store.attempt(attemptId).status, 'stopping');
  assert.equal(store.attempt(attemptId).stopContext.reason, 'time-limit');
  assert.deepEqual(terminations, [false]);
  // The director's Cancel while the process stops leaves the time limit's cause.
  runner.stop(attemptId);
  assert.equal(entry.timedOut, true);
  assert.deepEqual(stoppingMessages(store, attemptId), ['Time limit reached; stopping the process.']);

  closed();
  const attempt = store.attempt(attemptId),
    task = store.task('D-001');
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.error, timeLimitError);
  assert.equal(attempt.stopContext.reason, 'time-limit');
  assert.equal(task.status, 'failed');
  assert.equal(task.reason, timeLimitError);
  assert.equal(store.leases().length, 0);
});
