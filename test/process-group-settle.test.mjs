// A stopped CLI's process group may still be ending when its main process closes (macOS and Linux). The controller
// looks at it again for a moment before quarantining the attempt (src/adapters/native-process.mjs, waitForGroup).
// Found in the 1.2 release proof on Linux, November 4, 2026: under load, a stopped attempt was quarantined in 4 of 10
// runs. Model-free: the group's liveness is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { groupSettleMs, groupSettleStepMs, waitForGroup } from '../src/adapters/native-process.mjs';
import { processStartTimes } from '../src/adapters/process.mjs';
import { attemptResource } from '../src/core/store.mjs';
import { createRegistries } from '../src/registry.mjs';

const settled = (isLive, entry = {}) =>
  new Promise(resolve => {
    const started = Date.now();
    waitForGroup(isLive, entry, () => resolve({ ms: Date.now() - started, live: isLive() }));
  });

test('a group that empties a moment after its main process closes is not taken for one still running', async () => {
  let checks = 0;
  const { ms, live } = await settled(() => ++checks < 4);
  assert.equal(live, false, 'the decision is made once the group has emptied');
  assert.ok(ms >= 2 * groupSettleStepMs && ms < groupSettleMs, `decided after ${ms} ms`);
});

test('a group already empty at the close is decided at once', async () => {
  const { ms } = await settled(() => false);
  assert.ok(ms < groupSettleStepMs, `decided after ${ms} ms`);
});

test('a group that keeps running is still decided once the wait runs out, so it is quarantined', async () => {
  const { ms, live } = await settled(() => true);
  assert.equal(live, true);
  assert.ok(ms >= groupSettleMs - groupSettleStepMs, `decided after ${ms} ms`);
});

test('shutdown letting go of the attempt ends the wait at once', async () => {
  const entry = {};
  let checks = 0;
  const done = settled(() => {
    if (++checks === 2) entry.abandoned = true;
    return true;
  }, entry);
  const { ms } = await done;
  assert.ok(ms < groupSettleMs / 2, `decided after ${ms} ms`);
});

// RF-015: a run set aside because its group is still live records that its work stopped, at the moment it is set aside,
// whether the controller waited for the group first (macOS and Linux) or not (Windows). Driven through the runner with a
// fixture child process; the group's liveness is a stand-in (process.kill's signal 0 and the start-time reader), and
// the platform the close is decided on is set for the close alone, so both paths run on every computer.
async function quarantinedRun(t, closesOn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-group-settle-')),
    registries = createRegistries(),
    pids = new Set(),
    platform = Object.getOwnPropertyDescriptor(process, 'platform'),
    restorePlatform = () => Object.defineProperty(process, 'platform', platform);
  t.after(restorePlatform);
  const kill = process.kill,
    read = processStartTimes.read;
  t.mock.method(process, 'kill', function (target, signal, ...rest) {
    if (signal === 0 && pids.has(Math.abs(target))) return true;
    return kill.call(this, target, signal, ...rest);
  });
  t.mock.method(processStartTimes, 'read', pid => (pids.has(pid) ? 'unknown' : read(pid)));
  registries.adapters.register({
    id: 'group-fixture',
    version: 'group-fixture-v1',
    name: 'Process group fixture',
    workerSelectable: true,
    capabilities: ['text-output'],
    modes: ['workspace'],
    status: () => ({ available: true, label: 'Protocol fixture' }),
    blockReason: () => '',
    configuration: () => ({ mode: 'workspace' }),
    requestedModel: () => 'No model',
    delivery: 'Model-free process fixture.',
    deliveryScope: 'Private fixture workspace.',
    start(runtime, entry) {
      this.run(runtime, entry);
    },
    run(runtime, entry) {
      // The main process ends at once; its group answers as live for as long as the test runs.
      runtime.runNative(entry, process.execPath, ['-e', ''], '', () => assert.fail('a live group reads no result'), {
        environment: process.env,
      });
      pids.add(entry.attempt.pid);
      Object.defineProperty(process, 'platform', { ...platform, value: closesOn });
    },
  });
  const app = createStudio({ directory, port: 0, runnerOptions: { registries } }),
    org = app.store.organization(),
    worker = org.workers.find(item => item.id === 'W-03');
  worker.provider = 'group-fixture';
  app.store.setOrganization(org);
  // No job wrapper: the fixture's group is the stand-in above.
  app.runner.processJobs = false;
  t.after(async () => {
    restorePlatform();
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  app.store.putTask({
    id: 'group-task',
    projectId: 'project-legacy',
    kind: 'general',
    workerId: worker.id,
    team: worker.team,
    title: 'Leaves its group running',
    brief: 'Exit while the group stays live.',
    acceptance: 'Quarantined.',
    status: 'ready',
    dependencies: [],
    resources: [],
    maxSeconds: 60,
    maxAttempts: 2,
  });
  const started = Date.now(),
    { attemptId } = app.runner.start('group-task');
  await waitFor(() => app.store.attempt(attemptId).status === 'quarantined', 'the attempt to be quarantined', {
    interval: 20,
  });
  const quarantinedAfter = Date.now() - started;
  restorePlatform();
  // Anything still due on the close (a second finish) has had its turn.
  await new Promise(resolve => setTimeout(resolve, 2 * groupSettleStepMs));
  const { store, runner } = app,
    finishes = store
      .phaseEvents(attemptId)
      .map(event => event.payload)
      .filter(payload => payload.phaseId === 'attempt' && payload.boundary === 'finish');
  return { store, runner, attemptId, finishes, quarantinedAfter };
}

function assertSetAside({ store, runner, attemptId, finishes }) {
  const a = store.attempt(attemptId),
    task = store.task(a.taskId);
  assert.equal(a.status, 'quarantined');
  assert.equal(task.status, 'blocked');
  assert.match(task.reason, /process group is still live/);
  assert.equal(store.events(attemptId).filter(event => event.kind === 'quarantined').length, 1);
  assert.equal(finishes.length, 1, 'the attempt phase is finished exactly once');
  assert.equal(finishes[0].outcome, 'interrupted');
  assert.equal(finishes[0].timing, 'process-group-unconfirmed');
  assert.ok(
    store.leases().some(lease => lease.attemptId === attemptId && lease.resource === attemptResource(attemptId)),
    'its reservations are retained until reconciliation',
  );
  assert.equal(runner.active.has(attemptId), false);
}

test('a run set aside after the settling wait records that its work stopped, once', async t => {
  const run = await quarantinedRun(t, 'linux');
  assert.ok(
    run.quarantinedAfter >= groupSettleMs - groupSettleStepMs,
    `set aside after ${run.quarantinedAfter} ms, so the group was waited for`,
  );
  assertSetAside(run);
});

test('a run set aside at its close still records that its work stopped exactly once', async t => {
  const run = await quarantinedRun(t, 'win32');
  assert.ok(run.quarantinedAfter < groupSettleMs, `set aside after ${run.quarantinedAfter} ms, without the wait`);
  assertSetAside(run);
});
