// Whatever a test starts, the studio, its simulated CLIs and their timers, stops when the test ends, even
// when it fails partway. Model-free: the simulated CLI is the source-edit fixture's hanging mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { live } from '../src/adapters/process.mjs';
import { sourcePlan } from '../src/connectors/source-checks.mjs';

// Set when this file runs as the inner run of the first test below; it names the file its observations go to.
const innerRun = 'STUDIO_TEST_CLEANUP_REPORT',
  report = process.env[innerRun],
  failing = 'fails partway while its simulated CLI runs',
  // Below the suite's 120-second per-test bound.
  runLimit = 100000;

// Every timer armed while it is installed that has neither fired nor been cleared and keeps the process
// running (an unreferenced timer never does), by its delay.
function trackTimers() {
  const { setTimeout: arm, clearTimeout: clear } = globalThis,
    armed = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = arm(
      (...values) => {
        armed.delete(timer);
        callback(...values);
      },
      delay,
      ...args,
    );
    armed.set(timer, delay);
    return timer;
  };
  globalThis.clearTimeout = timer => {
    armed.delete(timer);
    clear(timer);
  };
  return {
    pending: () => [...armed].filter(([timer]) => timer.hasRef()).map(([, delay]) => delay),
    restore() {
      globalThis.setTimeout = arm;
      globalThis.clearTimeout = clear;
    },
  };
}

// A source story whose simulated CLI writes its work and then keeps running until it is stopped.
async function hanging(t, runnerOptions = {}) {
  const c = await setup(t, 'pass', undefined, runnerOptions, true),
    { store } = c.app,
    task = store.task(c.taskId);
  task.direction = 'hang';
  store.putTask(task);
  // What the controller leaves on record as it closes its store.
  const close = store.close.bind(store);
  store.close = () => {
    const id = store.task(c.taskId).lastAttemptId;
    c.closing = {
      status: store.attempt(id).status,
      leases: store
        .leases()
        .filter(lease => lease.attemptId === id)
        .map(lease => lease.resource)
        .sort(),
      events: store.events().filter(event => event.attempt_id === id),
    };
    close();
  };
  return c;
}
async function startHanging(c) {
  const { store, runner } = c.app,
    { attemptId } = runner.start(c.taskId),
    entry = runner.active.get(attemptId);
  await waitFor(
    () => store.events().some(event => event.attempt_id === attemptId && /fixture\.work-written/.test(event.message)),
    'the simulated CLI to write its work and keep running',
  );
  return { attemptId, entry, child: entry.child };
}

if (report) {
  // The inner run: one test whose subtest fails partway while its simulated CLI runs. Its observations
  // after the subtest's own cleanup go to the report file; node:test reports the failure.
  test('a studio test that fails partway', async t => {
    const seen = {},
      timers = trackTimers();
    try {
      await t.test(failing, async t => {
        const c = await hanging(t);
        seen.c = c;
        Object.assign(seen, await startHanging(c));
        fs.writeFileSync(report, JSON.stringify({ pid: seen.child.pid }));
        assert.equal(
          c.app.store.task(c.taskId).status,
          'review',
          'Deliberate failure partway, while its simulated CLI runs.',
        );
      });
    } finally {
      timers.restore();
      fs.writeFileSync(
        report,
        JSON.stringify({
          pid: seen.child?.pid,
          exited: !!seen.child && (seen.child.exitCode !== null || seen.child.signalCode !== null),
          live: !!seen.child && live({ pid: seen.child.pid }),
          active: seen.c?.app.runner.active.size ?? null,
          pending: timers.pending(),
          closing: seen.c?.closing && { status: seen.c.closing.status, leases: seen.c.closing.leases },
        }),
      );
    }
  });
} else {
  test('a studio test that fails partway stops what it started, and its run ends by itself', async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cleanup-')),
      file = path.join(folder, 'report.json');
    t.after(() => {
      // The simulated CLI never outlives this test, even when its run had to be ended here.
      const pid = fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).pid;
      if (pid && live({ pid })) process.kill(pid, 'SIGKILL');
      fs.rmSync(folder, { recursive: true, force: true });
    });
    // Without --test-force-exit: anything the test left running or armed would keep its process from ending.
    // A run of its own reports TAP, not the protocol a test runner's child file speaks (NODE_TEST_CONTEXT).
    const env = { ...process.env, [innerRun]: file };
    delete env.NODE_TEST_CONTEXT;
    const run = spawn(process.execPath, ['--test-reporter=tap', fileURLToPath(import.meta.url)], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [run.stdout, run.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => (output += chunk));
    }
    const ended = await new Promise(resolve => {
      const limit = setTimeout(() => {
        run.kill('SIGKILL');
        resolve(null);
      }, runLimit);
      run.on('close', code => {
        clearTimeout(limit);
        resolve({ code });
      });
    });
    assert.ok(ended, `The test's run did not end by itself within ${runLimit / 1000} seconds:\n${output}`);
    // node:test observed the deliberate failure; it is the only one.
    assert.equal(ended.code, 1, output);
    assert.match(output, new RegExp(`^\\s*not ok \\d+ - ${failing}$`, 'm'), output);
    assert.match(output, /Deliberate failure partway, while its simulated CLI runs\./);
    assert.equal(output.match(/^\s*not ok /gm).length, 2, 'Only the subtest and its parent failed.\n' + output);
    const seen = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(seen.exited, true, 'The simulated CLI exited.');
    assert.equal(seen.live, false);
    assert.equal(seen.active, 0, 'The runner has no active attempt.');
    assert.deepEqual(seen.pending, [], 'No timer armed during the test is still pending.');
    // Its stop was confirmed, so the attempt finished as cancelled and released its reservations.
    assert.deepEqual(seen.closing, { status: 'cancelled', leases: [] });
  });

  test('closing the studio lets go of a process it cannot confirm stopped; its reservations wait for reconciliation', async t => {
    let child;
    t.after(() => {
      if (child && live({ pid: child.pid })) process.kill(child.pid, 'SIGKILL');
    });
    // Termination is refused at its boundary, as a process that ignores it would.
    const c = await hanging(t, { fixtureProcessTermination: () => {} }),
      before = sourcePlan(c.root).sourceHash,
      timers = trackTimers();
    t.after(timers.restore);
    const { attemptId, entry } = await startHanging(c);
    child = entry.child;
    const held = c.app.store
      .leases()
      .filter(lease => lease.attemptId === attemptId)
      .map(lease => lease.resource)
      .sort();
    assert.ok(held.length);
    const runner = c.app.runner;
    await c.app.close();
    timers.restore();
    assert.equal(runner.active.size, 0);
    assert.deepEqual(timers.pending(), [], 'Neither its time limit nor its forced stop is still armed.');
    assert.ok(live({ pid: child.pid }), 'The simulated CLI ignored termination and still runs.');
    assert.ok(
      [child.stdin, child.stdout, child.stderr].every(stream => stream.destroyed),
      'The controller holds none of its pipes.',
    );
    // Recorded as uncertain: still stopping, every reservation kept.
    assert.equal(c.closing.status, 'stopping');
    assert.deepEqual(c.closing.leases, held);
    assert.ok(
      c.closing.events.some(
        event =>
          event.kind === 'interrupted' && /before this attempt's process was confirmed stopped/.test(event.message),
      ),
      JSON.stringify(c.closing.events.map(event => event.message)),
    );
    // Started again, the controller records the interruption and keeps the reservations while it runs.
    c.app = createStudio(c.options);
    const { store } = c.app;
    assert.equal(store.attempt(attemptId).status, 'interrupted');
    assert.equal(store.task(c.taskId).status, 'blocked');
    assert.deepEqual(
      store
        .leases()
        .map(lease => lease.resource)
        .sort(),
      held,
    );
    assert.throws(() => c.app.runner.reconcile(c.taskId), /live process/);
    process.kill(child.pid, 'SIGKILL');
    await waitFor(() => !live({ pid: child.pid }), 'the simulated CLI to stop');
    c.app.runner.reconcile(c.taskId);
    assert.equal(store.leases().length, 0);
    assert.ok(store.attempt(attemptId).reconciledAt);
    assert.equal(store.attempts(c.taskId).length, 1, 'Reconciliation never replays the work.');
    assert.equal(sourcePlan(c.root).sourceHash, before, 'Nothing reached the live source.');
  });

  test('closing the studio forces a process a cancellation could not stop, and its stop releases the reservations', async t => {
    // Termination works only once the studio closes, as a forced kill that timed out before would.
    let closing = false;
    const calls = [],
      c = await hanging(t, {
        fixtureProcessTermination: (entry, force) => {
          calls.push({ force, closing });
          if (force && closing) entry.child.kill('SIGKILL');
        },
      }),
      { store, runner } = c.app;
    const { attemptId, child } = await startHanging(c);
    runner.stop(attemptId);
    await waitFor(() => calls.some(call => call.force), 'the cancellation to force its process');
    assert.equal(store.attempt(attemptId).status, 'stopping');
    assert.ok(live({ pid: child.pid }));
    closing = true;
    const timers = trackTimers();
    t.after(timers.restore);
    await c.app.close();
    timers.restore();
    assert.ok(
      calls.some(call => call.force && call.closing),
      'Shutdown forced the cancelled process.',
    );
    assert.notEqual(child.exitCode ?? child.signalCode, null, 'The simulated CLI exited.');
    assert.equal(runner.active.size, 0);
    assert.deepEqual(timers.pending(), []);
    assert.deepEqual({ status: c.closing.status, leases: c.closing.leases }, { status: 'cancelled', leases: [] });
  });
}
