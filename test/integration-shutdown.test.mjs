// A controller stop during a merge's verification (review finding RF-002): the verification is cancelled before its
// step's process is ended, no later step starts, and the computer's test turn stays held, with the step's process
// recorded on the journal (testProcess), until that step's close is observed while the records are open. A stop
// request that returned is not taken for the process being gone: on Windows a launcher that already exited is passed
// over (C-41) while a helper it started may run on, and taskkill may fail or time out. What the controller does not
// see end is left for its restart (interruptedSourceIntegrations), which frees the turn once the process is gone. Each
// step's stop cancels its own verification only: another project's verification waiting for the turn goes on.
//
// Model-free and without git: a temporary store, the verification's held steps alone (verifyMergedSource) on a folder
// holding the profile's files, and fake child processes through the spawn seam, so each test decides when a step's
// close arrives. The journal is kept as a release's is, in its milestone's setting, so what it records is read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { bootstrapFactory } from '../src/core/bootstrap.mjs';
import { createRegistries } from '../src/registry.mjs';
import { stopIntegrationProcess, verifyMergedSource } from '../src/connectors/source-integration.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { testTurnResource } from '../src/core/test-turn.mjs';
import { waitFor } from './wait-for.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const openStore = directory =>
  new Store(
    directory,
    bootstrapFactory(createRegistries(), { organizationPreset: 'game-studio', workflowPresets: [] }),
  );
const holder = store => store.leases().find(lease => lease.resource === testTurnResource)?.attemptId ?? null;
const milestones = 'milestones:project-legacy';
const kept = (store, id = 'source-release:project-legacy:milestone-shutdown') =>
  store.setting(milestones, []).find(item => item.release.id === id).release;

// A child process as run() reads one; close(exitCode, signal) delivers its close, as Node does once its output ends.
let nextPid = 2_000_000;
function fakeChild(file, args) {
  const child = Object.assign(new EventEmitter(), {
    pid: nextPid++,
    exitCode: null,
    signalCode: null,
    spawnargs: [file, ...args],
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    closed: false,
    close(exitCode, signal = null) {
      if (child.closed) return;
      child.closed = true;
      Object.assign(child, { exitCode, signalCode: signal });
      child.emit('close', exitCode, signal);
    },
  });
  return child;
}

// A controller's store and runtime, with fake child processes through the spawn seam.
function controller(t, { termination } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-integration-shutdown-')),
    store = openStore(directory),
    spawned = [];
  const runtime = {
    store,
    closing: false,
    integrationProcess: null,
    integrationTurn: null,
    packageInstallCommand: { executable: 'fixture-npm', args: ['ci'] },
    sourceCheckCommand: { executable: 'fixture-tests', args: [] },
    integrationSpawn(file, args) {
      const child = fakeChild(file, args);
      spawned.push(child);
      return child;
    },
    ...(termination ? { fixtureProcessTermination: termination } : {}),
  };
  const state = { store, directory };
  t.after(() => {
    // Whatever a test left running ends, starting nothing more, so no step's time limit outlives it.
    runtime.closing = true;
    for (const child of spawned) child.close(null, 'SIGKILL');
    if (state.store.db.isOpen) state.store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { state, store, runtime, spawned };
}

// Starts a verification's held steps for a release journal kept in its milestone's setting, on a folder of its own.
function verification({ state, store, runtime }, name) {
  const worktree = path.join(state.directory, name, 'worktree'),
    output = path.join(state.directory, name, 'integration');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(output);
  for (const file of studioDeskProfile.files) fs.writeFileSync(path.join(worktree, file), '{}\n');
  // Studio desk's plan always measures a test file.
  fs.mkdirSync(path.join(worktree, 'test'));
  fs.writeFileSync(path.join(worktree, 'test', 'fixture.test.mjs'), '');
  const journal = { id: `source-release:project-legacy:milestone-${name}` };
  store.putSetting(milestones, [
    ...store.setting(milestones, []),
    { id: `milestone-${name}`, release: { id: journal.id, state: 'verifying' } },
  ]);
  const outcome = verifyMergedSource(runtime, journal, {
    worktree,
    directory: output,
    configuration: {},
    profile: studioDeskProfile,
    environment: {},
    files: [],
    kept: [],
    formatter: null,
    startedAt: new Date().toISOString(),
    keep: () => {},
    outputs: {},
  }).then(
    value => ({ value }),
    error => ({ error }),
  );
  return { journal, outcome };
}

// A verification holding the test turn, as a merge's is once its turn is taken, with its install running.
async function verifying(t, options) {
  const { state, store, runtime, spawned } = controller(t, options),
    { journal, outcome } = verification({ state, store, runtime }, 'shutdown');
  let ended = null;
  outcome.then(result => (ended = result));
  await waitFor(() => {
    if (ended)
      throw new Error(
        `The verification ended before its install started: ${ended.error?.stack ?? JSON.stringify(ended.value)}`,
      );
    return spawned.length === 1;
  }, 'the install to start');
  assert.equal(holder(store), journal.id, 'The verification holds the test turn.');
  assert.equal(journal.testProcess.pid, spawned[0].pid);
  assert.deepEqual(kept(store).testProcess, journal.testProcess, 'Its install is recorded where the journal is kept.');
  return { state, store, runtime, journal, spawned, outcome };
}

// The turn and the recorded process are still the journal's, in memory and where the journal is kept.
function stillHeld(store, journal, child, label) {
  assert.equal(holder(store), journal.id, `${label}: the test turn stays held.`);
  assert.equal(journal.testProcess?.pid, child.pid, `${label}: the journal keeps the step's process.`);
  assert.equal(kept(store).testProcess?.pid, child.pid, `${label}: the kept journal keeps it too.`);
}

test('a controller stop leaves the turn and the recorded process with a verification whose launcher exited but whose close has not come, as when a helper it started runs on', async t => {
  // On Windows the exited launcher is passed over (C-41) and nothing is ended; elsewhere its process group is sent
  // SIGKILL, here recorded rather than sent, and its close has not come yet either.
  const kills = [];
  if (process.platform !== 'win32') t.mock.method(process, 'kill', (pid, signal) => (kills.push([pid, signal]), true));
  const { store, runtime, journal, spawned, outcome } = await verifying(t),
    [install] = spawned;
  install.exitCode = 0; // The launcher exited; a helper holding its output keeps its close from coming.
  runtime.closing = true;
  stopIntegrationProcess(runtime);
  assert.deepEqual(kills, process.platform === 'win32' ? [] : [[-install.pid, 'SIGKILL']]);
  stillHeld(store, journal, install, 'After the stop');
  // The restart checks only the launcher's own process, so the record says a process it started may still run.
  assert.equal(journal.testProcess.helpersUnconfirmed, true);
  assert.equal(kept(store).testProcess.helpersUnconfirmed, true, 'The kept journal says so too.');
  await tick();
  stillHeld(store, journal, install, 'While no close has come');
  assert.equal(spawned.length, 1);
  // Its close, observed while the records are open, ends the verification and gives the turn back.
  install.close(0);
  const { error } = await outcome;
  assert.match(error?.message, /verification was stopped/);
  assert.equal(spawned.length, 1, 'No later step started.');
  assert.equal(holder(store), null);
  assert.equal(journal.testProcess, undefined);
});

test('a stop whose termination fails or times out leaves the turn and the recorded process with the still running step', async t => {
  for (const [label, termination] of [
    [
      'taskkill failed',
      () => {
        throw new Error('ERROR: The process could not be terminated.');
      },
    ],
    ['taskkill timed out', () => {}],
  ]) {
    await t.test(label, async t => {
      const { store, runtime, journal, spawned, outcome } = await verifying(t, { termination }),
        [install] = spawned;
      runtime.closing = true;
      stopIntegrationProcess(runtime);
      stillHeld(store, journal, install, label);
      assert.equal(journal.testProcess.helpersUnconfirmed, undefined, 'Its launcher was still running.');
      await tick();
      stillHeld(store, journal, install, label);
      assert.equal(spawned.length, 1);
      install.close(1);
      assert.match((await outcome).error?.message, /verification was stopped/);
      assert.equal(spawned.length, 1);
    });
  }
});

test('a successful close that was already on its way when the controller stopped starts no later step, and the verification ends as stopped', async t => {
  const { store, runtime, journal, spawned, outcome } = await verifying(t, { termination: () => {} }),
    [install] = spawned;
  runtime.closing = true;
  stopIntegrationProcess(runtime);
  // The install's close says it succeeded.
  install.close(0);
  await tick();
  assert.equal(spawned.length, 1, 'Neither the build nor the tests started.');
  const { value, error } = await outcome;
  assert.equal(value, undefined, JSON.stringify(value));
  assert.match(error.message, /verification was stopped, so it started no further step/);
  assert.equal(spawned.length, 1, 'Neither the build nor the tests started.');
  // Its close was observed while the records were open, so the turn is given back.
  assert.equal(holder(store), null);
  assert.equal(journal.testProcess, undefined);
  assert.equal(kept(store).testProcess, undefined);
});

test("once the stopped step's close is observed while the records are open, the turn is given back and the recorded process cleared", async t => {
  const { store, runtime, journal, spawned, outcome } = await verifying(t, {
      // The stop ends the process; its close comes a moment later, as a real one does.
      termination: ({ child }) => setImmediate(() => child.close(null, 'SIGKILL')),
    }),
    [install] = spawned;
  install.close(0);
  await waitFor(() => spawned.length === 2, 'the tests to start');
  const tests = spawned[1];
  assert.deepEqual(tests.spawnargs, ['fixture-tests']);
  stillHeld(store, journal, tests, 'While the tests run');
  runtime.closing = true;
  stopIntegrationProcess(runtime);
  stillHeld(store, journal, tests, 'Before the close is observed');
  assert.match((await outcome).error?.message, /verification was stopped/);
  assert.equal(holder(store), null, 'The turn is free.');
  assert.equal(journal.testProcess, undefined);
  assert.equal(kept(store).testProcess, undefined, 'The kept journal no longer records it.');
  assert.equal(spawned.length, 2);
  assert.deepEqual(store.leases(), []);
});

test('a close that comes after the records closed leaves the turn and the recorded process for the restart', async t => {
  const { state, store, runtime, journal, spawned, outcome } = await verifying(t, { termination: () => {} }),
    [install] = spawned;
  runtime.closing = true;
  stopIntegrationProcess(runtime);
  store.close();
  install.close(0);
  assert.match((await outcome).error?.message, /verification was stopped/);
  assert.equal(spawned.length, 1);
  // As the next start finds them: the journal holds the turn, with its install recorded.
  state.store = openStore(state.directory);
  assert.equal(holder(state.store), journal.id);
  assert.equal(kept(state.store).testProcess?.pid, install.pid);
});

test("one verification's stop leaves another project's verification, waiting for the turn, to go on and be recorded as its own", async t => {
  const terminated = [],
    started = controller(t, { termination: ({ child }) => terminated.push(child) }),
    { store, runtime, spawned } = started,
    first = verification(started, 'first');
  await waitFor(() => spawned.length === 1, "the first verification's install to start");
  const [firstInstall] = spawned;
  assert.equal(holder(store), first.journal.id);
  // The second project's verification waits for the turn the first holds.
  const second = verification(started, 'second');
  await waitFor(() => kept(store, second.journal.id).testTurn, 'the second verification to wait for the turn');
  assert.equal(spawned.length, 1);
  // The first's install closes and its tests start, recorded on the first's journal, not on the waiting one's.
  firstInstall.close(0);
  await waitFor(() => spawned.length === 2, "the first verification's tests to start");
  const firstTests = spawned[1];
  assert.equal(first.journal.testProcess?.pid, firstTests.pid);
  assert.equal(kept(store, first.journal.id).testProcess?.pid, firstTests.pid);
  assert.equal(second.journal.testProcess, undefined, 'The waiting verification ran nothing.');
  // The first's tests reach their time limit, which stops that step (run() passes its own child).
  stopIntegrationProcess(runtime, firstTests);
  assert.deepEqual(terminated, [firstTests]);
  firstTests.close(null, 'SIGKILL');
  assert.match((await first.outcome).error?.message, /verification was stopped/);
  // The second takes the freed turn and its install starts: nothing stopped it.
  await waitFor(() => spawned.length === 3, "the second verification's install to start", {
    limit: 5000,
    detail: () => JSON.stringify(kept(store, second.journal.id)),
  });
  const [, , secondInstall] = spawned;
  assert.equal(holder(store), second.journal.id);
  assert.equal(second.journal.testProcess?.pid, secondInstall.pid);
  secondInstall.close(0);
  await waitFor(() => spawned.length === 4, "the second verification's tests to start", { limit: 5000 });
  spawned[3].close(1);
  const { value, error } = await second.outcome;
  assert.equal(error, undefined, error?.stack);
  assert.equal(value.passed, false, 'Its tests ended as they did, with no totals.');
  assert.equal(holder(store), null);
});
