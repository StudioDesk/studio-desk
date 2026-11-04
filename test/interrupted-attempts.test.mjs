// The recovery drill (v1.0 criterion 3): an attempt the controller's own stop interrupted says nothing about the work.
// One found running at restart records that the controller stopped it (endCause environment/controller-stop) and does
// not count toward an attempt limit, though it still waits to be reconciled; one recorded before endCause counts as it
// did: not once reconciled, like one a usage limit stopped. A fixed limit counts every attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { createRegistries } from '../src/registry.mjs';
import { countsTowardLimit } from '../src/core/registry.mjs';
import { attemptResource } from '../src/core/store.mjs';

test('a reconciled interruption does not count toward an attempt limit, except a fixed one', () => {
  const { workflows } = createRegistries(),
    reconciled = { id: 'attempt-reconciled', status: 'interrupted', reconciledAt: '2026-10-24T09:10:00.000Z' },
    unsettled = { id: 'attempt-unsettled', status: 'interrupted' },
    failed = { id: 'attempt-failed', status: 'failed' },
    store = {
      task: id => ({ id, kind: 'layout' }),
      attempts: () => [reconciled, unsettled, failed],
    };
  // Recorded before endCause, one not yet reconciled still counts: its task cannot start again until it is.
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'layout' }), [unsettled, failed]);
  store.task = id => ({ id, kind: 'unreal-integration' });
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'unreal-integration' }), [
    reconciled,
    unsettled,
    failed,
  ]);
  assert.equal(countsTowardLimit({ status: 'blocked', subscriptionHold: 'claude' }), false);
  assert.equal(countsTowardLimit({ status: 'failed', reconciledAt: '2026-10-24T09:10:00.000Z' }), true);
  // One a restart interrupted records that the controller stopped it, and does not count, reconciled or not.
  const stopped = { status: 'interrupted', endCause: { cause: 'environment', detail: 'controller-stop' } };
  assert.equal(countsTowardLimit(stopped), false);
  assert.equal(countsTowardLimit({ ...stopped, reconciledAt: '2026-10-24T09:10:00.000Z' }), false);
});

test('an attempt a restart interrupts records the controller stop, keeps its reservation until reconciled, and does not count', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-interrupted-')),
    open = () => createStudio({ directory, port: 0 });
  let app = open();
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = () => app.store,
    worker = store()
      .organization()
      .workers.find(item => item.id === 'W-03');
  store().putTask({
    id: 'T-restart',
    projectId: 'project-legacy',
    kind: 'general',
    workerId: worker.id,
    team: worker.team,
    title: 'Interrupted by a restart',
    brief: 'Bounded model-free work.',
    acceptance: '',
    status: 'running',
    reason: '',
    dependencies: [],
    resources: [],
    maxSeconds: 30,
    maxAttempts: 2,
    lastAttemptId: 'attempt-running',
  });
  // A finished attempt the work itself ended, and one the stopped controller left running with no process.
  store().insertAttempt(
    {
      id: 'attempt-failed',
      taskId: 'T-restart',
      projectId: 'project-legacy',
      workerId: worker.id,
      provider: 'mock',
      status: 'failed',
      endCause: { cause: 'work' },
      startedAt: '2026-11-03T08:00:00.000Z',
      finishedAt: '2026-11-03T08:01:00.000Z',
      artifacts: [],
      inputReferences: [],
    },
    { hash: 'snapshot', text: 'Instructions.' },
  );
  store().insertAttempt(
    {
      id: 'attempt-running',
      taskId: 'T-restart',
      projectId: 'project-legacy',
      workerId: worker.id,
      provider: 'mock',
      status: 'running',
      startedAt: '2026-11-03T09:00:00.000Z',
      artifacts: [],
      inputReferences: [],
      pid: null,
    },
    { hash: 'snapshot', text: 'Instructions.' },
  );
  store().claim([attemptResource('attempt-running')], 'attempt-running');
  const counted = () =>
    app.runner.registries.workflows.stageAttempts(store(), store().task('T-restart')).map(attempt => attempt.id);
  // While it runs it holds one of the two attempts.
  assert.deepEqual(counted(), ['attempt-failed', 'attempt-running']);
  await app.close();
  app = open();
  const interrupted = store().attempt('attempt-running');
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.endCause, { cause: 'environment', detail: 'controller-stop' });
  // Nothing is released or started again before the director reconciles it.
  assert.ok(
    store()
      .leases()
      .some(lease => lease.attemptId === 'attempt-running'),
  );
  assert.equal(store().task('T-restart').status, 'blocked');
  assert.throws(() => app.runner.start('T-restart'), /Reconcile the interrupted attempt/);
  assert.deepEqual(counted(), ['attempt-failed']);
  app.runner.reconcile('T-restart');
  assert.equal(store().attempt('attempt-running').reconciledAt !== undefined, true);
  assert.deepEqual(store().attempt('attempt-running').endCause, { cause: 'environment', detail: 'controller-stop' });
  assert.equal(
    store()
      .leases()
      .some(lease => lease.attemptId === 'attempt-running'),
    false,
  );
  // Still one of two: the scheduler may start it again without the director.
  assert.deepEqual(counted(), ['attempt-failed']);
  assert.ok(counted().length < store().task('T-restart').maxAttempts);
});
