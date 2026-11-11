// Reconcile puts queued work back in the queue (src/core/orchestrator.mjs, Runner.holdQueue, restoreQueue and
// afterReconcile): a restart or a quarantine takes queued work out of the queue and records on the cut-off attempt that
// it was queued, with the director's Start it ran; Reconcile queues it again in the transaction that makes it ready,
// the house rules then act on it as after approval, and dispatch starts it when its project runs. Reconcile also waits
// for the agent's own run of the whole suite (employeeTestPid). Each case runs through both Reconciles: the default one and
// the measured-source breakdown adapter's (src/adapters/source-breakdown.mjs), reached through Runner.reconcile as the
// director's button reaches it. Model-free: temporary studios, the simulator's attempts and fixture node processes; a
// stop is the controller closing without seeing its attempt end, so its records read running as a crash leaves them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { describeTask, waitFor } from './wait-for.mjs';

const fixture = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url)),
  project = 'project-legacy',
  paused = 'Waiting for the project to resume: this project is paused.',
  implementations = ['default', 'source-breakdown'];

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-requeue-')),
    delay = process.env.STUDIO_MOCK_DELAY_MS;
  const c = { directory };
  c.open = async () => {
    c.app = createStudio({ directory, port: 0, runnerOptions: { codexBinary: fixture } });
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await c.open();
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
  });
  c.request = async (url, body = {}, method = 'POST') => {
    const res = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  c.ok = async (url, body = {}) => {
    const answer = await c.request(url, body);
    assert.ok(answer.status < 300, `${url}: ${JSON.stringify(answer.data)}`);
    return answer.data;
  };
  c.until = (check, label) => waitFor(check, label, { interval: 20 });
  c.wait = (id, status) =>
    waitFor(() => c.app.store.task(id).status === status, `task ${id} to be ${status}`, {
      interval: 20,
      detail: () => {
        const task = c.app.store.task(id);
        return describeTask(task, task.lastAttemptId && c.app.store.attempt(task.lastAttemptId));
      },
    });
  // The first attempt runs until the controller stops; the ones after it finish at once.
  c.slow = () => (process.env.STUDIO_MOCK_DELAY_MS = '600000');
  c.quick = () => (process.env.STUDIO_MOCK_DELAY_MS = '15');
  c.slow();
  return c;
}

// The controller stops without seeing the attempt end, as a crash or a power loss leaves it, and starts again on the
// same records.
async function stopAndStart(c, attemptId) {
  const runner = c.app.runner,
    entry = runner.active.get(attemptId);
  if (entry) {
    clearTimeout(entry.mockTimer);
    clearTimeout(entry.timer);
    runner.active.delete(attemptId);
  }
  await c.app.close();
  c.quick();
  await c.open();
}

// The director's Reconcile. The breakdown adapter's is reached through Runner.reconcile, as the button reaches it for a
// breakdown story: only the adapter the task resolves to is chosen here, and only for this call.
async function reconcile(c, implementation, taskId) {
  if (implementation === 'default') {
    const answer = await c.request(`/api/tasks/${taskId}/reconcile`);
    if (answer.status >= 300) throw new Error(JSON.stringify(answer.data));
    return;
  }
  const runner = c.app.runner,
    adapter = runner.adapters.find('source-breakdown');
  runner.adapterFor = () => adapter;
  try {
    await runner.reconcile(taskId);
  } finally {
    delete runner.adapterFor;
  }
}

// A running attempt of D-001 that the director's queue started.
async function queuedAndRunning(c) {
  await c.ok('/api/pipeline', { action: 'queue', taskIds: ['D-001'] });
  const running = () => c.app.store.attempts('D-001').find(a => a.status === 'running');
  await c.until(running, 'the queued work to start');
  return running().id;
}

// An earlier attempt of D-001 that failed, and so counts toward its attempt limit.
function failedEarlier(store) {
  store.insertAttempt(
    {
      id: 'attempt-failed-earlier',
      taskId: 'D-001',
      projectId: project,
      workerId: 'W-03',
      provider: 'mock',
      status: 'failed',
      error: 'Earlier fixture failure.',
      startedAt: '2026-11-03T09:00:00.000Z',
      finishedAt: '2026-11-03T09:01:00.000Z',
      artifacts: [],
      inputReferences: [],
      pid: null,
    },
    { hash: 'snapshot', text: 'Instructions.' },
  );
}

// A process that runs until the test stops it, with its true start time, as the controller records one.
function liveProcess(t, { leader }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: leader && process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  const startedAt = new Date().toISOString(),
    ended = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    child.kill();
    await ended;
  };
  t.after(stop);
  return { pid: child.pid, startedAt, stop };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 150));
const leasesOf = (store, id) =>
  store
    .leases()
    .filter(lease => lease.attemptId === id)
    .map(lease => lease.resource);

for (const implementation of implementations) {
  test(`${implementation} Reconcile: queued work a restart cut off is queued again and starts once its project runs`, async t => {
    const c = await setup(t),
      first = await queuedAndRunning(c);
    await stopAndStart(c, first);
    const { store } = c.app;
    // After the restart, as before: blocked, out of the queue, its project paused by the restart.
    assert.equal(store.attempt(first).status, 'interrupted');
    assert.equal(store.task('D-001').status, 'blocked');
    assert.equal(store.task('D-001').queued, false);
    assert.deepEqual(store.attempt(first).requeue, {}, 'The attempt records that its task was queued.');
    assert.equal(store.project(project).restartPaused, true);
    // The director resumes the project; nothing starts before Reconcile.
    await c.ok('/api/pipeline', { action: 'resume' });
    await settle();
    assert.equal(store.attempts('D-001').length, 1);
    await reconcile(c, implementation, 'D-001');
    assert.equal(store.task('D-001').queued, true);
    assert.ok(store.attempt(first).reconciledAt);
    assert.deepEqual(leasesOf(store, first), []);
    // A new attempt starts with no Start pressed, and reaches Review.
    await c.wait('D-001', 'review');
    const attempts = store.attempts('D-001');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].status, 'review');
    assert.equal(attempts[1].directorOverride, undefined);
  });

  test(`${implementation} Reconcile before Resume leaves the work queued, and it starts when the director resumes`, async t => {
    const c = await setup(t),
      first = await queuedAndRunning(c);
    await stopAndStart(c, first);
    const { store } = c.app;
    await reconcile(c, implementation, 'D-001');
    // The restart's pause still lifts only on Resume; the queued work says what it waits for.
    assert.equal(store.project(project).dispatchPaused, true);
    assert.equal(store.project(project).restartPaused, true);
    assert.equal(store.task('D-001').queued, true);
    assert.equal(store.task('D-001').reason, paused);
    await settle();
    assert.equal(store.attempts('D-001').length, 1, 'Nothing starts while the project is paused.');
    await c.ok('/api/pipeline', { action: 'resume' });
    await c.wait('D-001', 'review');
    assert.equal(store.attempts('D-001').length, 2);
  });

  test(`${implementation} Reconcile: a quarantined attempt's queued work is queued again once its process ends, and starts by itself`, async t => {
    const c = await setup(t),
      first = await queuedAndRunning(c),
      alive = liveProcess(t, { leader: true }),
      { runner, store } = c.app,
      entry = runner.active.get(first);
    clearTimeout(entry.mockTimer);
    // Its process may still run when the adapter finishes: the attempt is quarantined, its task leaves the queue.
    Object.assign(entry.attempt, { pid: alive.pid, pidStartedAt: alive.startedAt });
    runner.finish(entry, null, 'Adapter failed after spawning.');
    assert.equal(store.attempt(first).status, 'quarantined');
    assert.equal(store.task('D-001').status, 'blocked');
    assert.equal(store.task('D-001').queued, false);
    assert.deepEqual(store.attempt(first).requeue, {});
    const leases = leasesOf(store, first);
    assert.ok(leases.length);
    // The controller lets go of it with the stop, as the restart case: it is in the same state before Reconcile.
    await stopAndStart(c, first);
    assert.equal(c.app.store.attempt(first).status, 'quarantined');
    assert.equal(
      c.app.store.project(project).dispatchPaused,
      false,
      'No queued work was left for the restart to pause.',
    );
    await assert.rejects(reconcile(c, implementation, 'D-001'), /still has a live process\/group/);
    assert.deepEqual(leasesOf(c.app.store, first), leases);
    assert.equal(c.app.store.task('D-001').queued, false);
    // Its process then ends.
    await alive.stop();
    await reconcile(c, implementation, 'D-001');
    assert.equal(c.app.store.task('D-001').queued, true);
    await c.wait('D-001', 'review');
    assert.equal(c.app.store.attempts('D-001').length, 2);
  });

  test(`${implementation} Reconcile leaves work that was not queued ready when no house rules are enabled`, async t => {
    const c = await setup(t),
      first = c.app.runner.start('D-001').attemptId;
    await stopAndStart(c, first);
    const { store } = c.app;
    assert.equal(store.attempt(first).requeue, undefined);
    assert.equal(store.project(project).dispatchPaused, false);
    await reconcile(c, implementation, 'D-001');
    await settle();
    assert.equal(store.task('D-001').status, 'ready');
    assert.ok(!store.task('D-001').queued);
    assert.equal(store.attempts('D-001').length, 1);
  });

  test(`${implementation} Reconcile lets enabled house rules queue the ready work, and it starts`, async t => {
    const c = await setup(t),
      first = c.app.runner.start('D-001').attemptId;
    await stopAndStart(c, first);
    const { store } = c.app;
    await c.ok(`/api/projects/${project}/autonomy`, {
      expectedRevision: 0,
      enabled: true,
      retries: 0,
      kinds: {},
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
    });
    await settle();
    assert.equal(store.attempts('D-001').length, 1, 'Interrupted work waits for Reconcile.');
    await reconcile(c, implementation, 'D-001');
    await c.wait('D-001', 'review');
    assert.equal(store.attempts('D-001').length, 2);
  });

  test(`${implementation} Reconcile: an interrupted director Start keeps the director's override`, async t => {
    const c = await setup(t);
    let { store, runner } = c.app;
    // One attempt that counts already used the work's limit for automatic runs (a reconciled interrupted one never
    // counts), so only the director's Start runs it again.
    store.putTask({ ...store.task('D-001'), maxAttempts: 1 });
    failedEarlier(store);
    // Start waits for the work's resource, so it is queued as the director's Start.
    store.claim(['layout:prototype'], 'fixture-holder');
    assert.equal((await c.ok('/api/tasks/D-001/start')).queued, true);
    const directorStart = store.task('D-001').directorStart;
    assert.ok(directorStart);
    store.release('fixture-holder');
    runner.schedule();
    await c.until(() => store.attempts('D-001')[1]?.status === 'running', 'the director Start to run');
    const first = store.attempts('D-001')[1];
    assert.deepEqual(first.directorStart, directorStart, "The attempt records the director's Start it runs.");
    assert.deepEqual(first.directorOverride, { attemptLimit: 1, attemptNumber: 2 });
    assert.equal(store.task('D-001').directorStart, undefined);
    await stopAndStart(c, first.id);
    ({ store, runner } = c.app);
    assert.deepEqual(store.attempt(first.id).requeue, { directorStart });
    await c.ok('/api/pipeline', { action: 'resume' });
    await reconcile(c, implementation, 'D-001');
    // Past the limit for automatic runs, the director's Start still runs it, and the new attempt records the override.
    await c.wait('D-001', 'review');
    const attempts = store.attempts('D-001');
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts[2].directorOverride, { attemptLimit: 1, attemptNumber: 2 });
    assert.deepEqual(attempts[2].directorStart, directorStart);
  });

  test(`${implementation} Reconcile: queued work over its attempt limit is stopped by dispatch with its usual message`, async t => {
    const c = await setup(t);
    c.app.store.putTask({ ...c.app.store.task('D-001'), maxAttempts: 2 });
    failedEarlier(c.app.store);
    const first = await queuedAndRunning(c);
    await stopAndStart(c, first);
    const { store } = c.app;
    // The limit is lowered meanwhile, so the counted attempt alone reaches it.
    store.putTask({ ...store.task('D-001'), maxAttempts: 1 });
    await c.ok('/api/pipeline', { action: 'resume' });
    await reconcile(c, implementation, 'D-001');
    await c.until(() => store.task('D-001').reason.includes('attempt limit'), 'dispatch to stop the work');
    assert.equal(store.task('D-001').status, 'blocked');
    assert.equal(
      store.task('D-001').reason,
      'Assignment reached its 1-attempt limit for automatic runs. Press Start to run it again.',
    );
    assert.equal(store.task('D-001').queued, false);
    assert.equal(store.attempts('D-001').length, 2);
  });

  test(`${implementation} Reconcile refuses while the agent's run of the whole suite may still run, then releases`, async t => {
    const c = await setup(t),
      first = c.app.runner.start('D-001').attemptId,
      suite = liveProcess(t, { leader: false });
    // Its own process has ended (it recorded none); its agent's run of the whole suite still runs.
    const a = c.app.store.attempt(first);
    Object.assign(a, { employeeTestPid: suite.pid, employeeTestStartedAt: suite.startedAt });
    c.app.store.updateAttempt(a);
    await stopAndStart(c, first);
    const { store } = c.app,
      leases = leasesOf(store, first);
    assert.ok(leases.length);
    await assert.rejects(
      reconcile(c, implementation, 'D-001'),
      new RegExp(`Attempt ${first} still has a live process: its agent's run of the whole test suite`),
    );
    assert.equal(store.attempt(first).reconciledAt, undefined);
    assert.deepEqual(leasesOf(store, first), leases);
    await suite.stop();
    await reconcile(c, implementation, 'D-001');
    assert.ok(store.attempt(first).reconciledAt);
    assert.deepEqual(leasesOf(store, first), []);
    assert.equal(store.task('D-001').status, 'ready');
  });
}
