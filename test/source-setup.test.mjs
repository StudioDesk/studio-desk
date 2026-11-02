// A code story's setup runs in a process of its own (src/connectors/source-setup.mjs): the controller keeps answering
// while the working copy is made, checked and copied, a stop ends that process and removes the working copy, and a
// base commit other than the approved snapshot still fails the attempt with the same message, which a test's wait for
// the task then repeats with the end of the attempt's log. A setup process that ends without a failed step or an error
// line says how it ended, in which step and with its last output line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor, waitForTask } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { runSourceSetup, setupEndedMessage } from '../src/connectors/source-setup.mjs';
import {
  createSourceWorktree,
  leftoverWorktrees,
  removeSourceWorktree,
  removeWorktrees,
} from '../src/connectors/source-worktrees.mjs';
import { jobDirectory } from '../src/core/projects.mjs';

const snapshotMismatch = 'The base commit does not match the approved source snapshot. Start a new attempt.',
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The file whose presence holds a story's setup process once its working copy is made (the runner's sourceSetupHold,
// a trusted test seam), in a folder of its own.
function holdFile(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-setup-hold-')),
    file = path.join(folder, 'hold');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(file, '');
  return file;
}

const phases = (store, attemptId) => store.phaseEvents(attemptId).map(event => event.payload);

// The setup phases an attempt has started and not finished, from its phase events.
function openSetup(store, attemptId) {
  const open = new Map();
  for (const p of phases(store, attemptId))
    if (p.phaseId.startsWith('setup.'))
      if (p.boundary === 'start') open.set(p.occurrenceId, p.phaseId);
      else open.delete(p.occurrenceId);
  return [...open.values()];
}

test('the controller keeps answering while a story’s setup process is held, and the story then edits, tests and reaches review', async t => {
  const hold = holdFile(t),
    c = await setup(t, 'pass', undefined, { sourceSetupHold: hold }),
    { store } = c.app;
  await c.start();
  const attemptId = store.task(c.taskId).lastAttemptId,
    answers = [];
  // A small controller file, every 200 ms until the setup is held and ten times more while it stays held.
  const ask = async () => {
    const began = performance.now(),
      response = await fetch(c.origin + '/theme.js');
    await response.arrayBuffer();
    assert.equal(response.status, 200);
    answers.push(performance.now() - began);
  };
  await waitFor(
    async () => {
      await ask();
      return openSetup(store, attemptId).includes('setup.snapshot');
    },
    'the setup process to be held',
    { interval: 200 },
  );
  const heldAt = performance.now();
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    await ask();
  }
  assert.ok(
    answers.every(ms => ms < 1000),
    `Every request answers within a second: ${answers.map(Math.round).join(', ')} ms.`,
  );
  // Still held: the snapshot step is open on a working copy already made, and no editor has started.
  assert.deepEqual(openSetup(store, attemptId), ['setup.snapshot']);
  assert.ok(fs.existsSync(store.attempt(attemptId).sourceWorktree.path));
  assert.ok(!phases(store, attemptId).some(p => p.phaseId === 'source.edit'));
  assert.equal(store.task(c.taskId).status, 'running');
  fs.rmSync(hold);
  const heldMs = performance.now() - heldAt,
    a = await c.wait(c.taskId),
    recorded = phases(store, a.id);
  assert.deepEqual(
    recorded.map(p => `${p.phaseId}:${p.boundary}`),
    [
      'attempt:start',
      'setup.scope:start',
      'setup.scope:finish',
      'setup.worktree:start',
      'setup.worktree:finish',
      'setup.snapshot:start',
      'setup.snapshot:finish',
      'setup.copy:start',
      'setup.copy:finish',
      'source.edit:start',
      'source.edit:finish',
      'candidate.commit:start',
      'candidate.commit:finish',
      'install:start',
      'install:finish',
      'test:start',
      'test:finish',
      'attempt:finish',
    ],
  );
  assert.ok(recorded.filter(p => p.boundary === 'finish').every(p => p.outcome === 'succeeded'));
  // The snapshot step's time is the one its process measured, the hold included.
  const snapshot = recorded.find(p => p.phaseId === 'setup.snapshot' && p.boundary === 'finish');
  assert.ok(snapshot.durationMs >= heldMs, `The snapshot step took ${snapshot.durationMs} ms, held ${heldMs} ms.`);
  // The setup process staged the approved file, the editor edited it, the candidate was tested in the working copy,
  // and that is gone.
  assert.equal(
    fs.readFileSync(path.join(a.outputFolder, 'changes/src/core/workflows.mjs'), 'utf8'),
    '// Fixture source: src/core/workflows.mjs\n\n// Bounded fixture improvement.\n',
  );
  assert.ok(a.artifacts.some(item => item.path === 'changes/src/core/workflows.mjs' && item.kind === 'source-file'));
  assert.equal(a.sourceCandidate.root, a.sourceWorktree.path);
  assert.equal(fs.existsSync(a.sourceWorktree.path), false);
  assert.equal(store.leases().length, 0);
});

test('stopping a story while its setup is held ends the setup process and leaves no working copy', async t => {
  const hold = holdFile(t),
    c = await setup(t, 'pass', undefined, { sourceSetupHold: hold }),
    { store, runner } = c.app;
  await c.start();
  const attemptId = store.task(c.taskId).lastAttemptId;
  await waitFor(() => openSetup(store, attemptId).includes('setup.snapshot'), 'the setup process to be held');
  const child = runner.active.get(attemptId).child,
    worktree = store.attempt(attemptId).sourceWorktree.path;
  assert.ok(fs.existsSync(worktree), 'The working copy was made before the hold.');
  assert.equal((await c.request(`/api/tasks/${c.taskId}/cancel`)).status, 202);
  const a = await c.wait(c.taskId, 'cancelled'),
    recorded = phases(store, a.id),
    snapshot = recorded.find(p => p.phaseId === 'setup.snapshot' && p.boundary === 'finish');
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The setup process ended.');
  assert.ok(['cancelled', 'failed'].includes(snapshot.outcome), `The snapshot step finished ${snapshot.outcome}.`);
  assert.deepEqual(openSetup(store, a.id), []);
  assert.ok(!recorded.some(p => ['setup.copy', 'source.edit'].includes(p.phaseId)));
  assert.equal(fs.existsSync(worktree), false);
  assert.deepEqual(fs.readdirSync(path.join(store.directory, 'wt')), []);
  assert.equal(git(c.root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  assert.equal(store.leases().length, 0);
});

test('a base commit that does not match the snapshot fails the attempt in its setup process', async t => {
  const c = await setup(t),
    { store, runner } = c.app;
  // A commit holding other files than the snapshot the story's scope measures, off the checked-out branch.
  fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// Not the approved snapshot.\n');
  git(c.root, ['commit', '--quiet', '-am', 'A commit the scope did not measure']);
  const other = git(c.root, ['rev-parse', 'HEAD']);
  git(c.root, ['reset', '--quiet', '--hard', 'HEAD~1']);
  // The story's measured scope names that commit as its base.
  const applyMetadata = runner.applyMetadata;
  t.mock.method(runner, 'applyMetadata', function (attempt, definition, metadata) {
    const scope = metadata?.sourceChange;
    return applyMetadata.call(
      this,
      attempt,
      definition,
      scope ? { ...metadata, sourceChange: { ...scope, base: { ...scope.base, commit: other } } } : metadata,
    );
  });
  await c.start();
  const a = await c.wait(c.taskId, 'failed'),
    recorded = phases(store, a.id);
  assert.equal(a.sourceChange.base.commit, other);
  assert.equal(a.error, snapshotMismatch);
  assert.deepEqual(
    recorded.filter(p => p.phaseId.startsWith('setup.') && p.boundary === 'finish').map(p => [p.phaseId, p.outcome]),
    [
      ['setup.scope', 'succeeded'],
      ['setup.worktree', 'succeeded'],
      ['setup.snapshot', 'failed'],
    ],
  );
  assert.equal(recorded.find(p => p.phaseId === 'setup.snapshot' && p.boundary === 'finish').error, snapshotMismatch);
  // Nothing was copied for the editor, no editor ran, and the working copy and reservations are gone.
  assert.ok(!recorded.some(p => p.phaseId === 'source.edit'));
  assert.equal(fs.existsSync(path.join(jobDirectory(store, a), 'source')), false);
  assert.equal(fs.existsSync(a.sourceWorktree.path), false);
  assert.deepEqual(fs.readdirSync(path.join(store.directory, 'wt')), []);
  assert.equal(store.leases().length, 0);
  // A wait for a status the failed task never reaches says why from the attempt's own records: its setup error (here
  // also the task's reason) and the end of its log, which holds the lines the setup process wrote.
  await assert.rejects(waitForTask(store, c.taskId, 'review', { limit: 50 }), error => {
    const [status, log] = error.message.split('its log ends:');
    assert.ok(status.includes(snapshotMismatch), error.message);
    assert.ok(log?.includes('stdout: {"phase":"setup.snapshot"'), error.message);
    assert.ok(log.includes(`stderr: ${snapshotMismatch}`), error.message);
    return true;
  });
});

test('the setup process leaves a listed worktree that was made again under its name since the controller listed it', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    parent = path.join(c.directory, 'wt'),
    head = git(c.root, ['rev-parse', 'HEAD']);
  for (const name of ['left', 'i-retried']) createSourceWorktree(c.root, parent, name, head);
  // The controller lists both as left by settled work (no attempt or release keeps either).
  const listed = leftoverWorktrees(
    {
      store: {
        liveAttempts: () => [],
        integrationJournals: () => [],
        carryJournals: () => [],
        projects: () => [],
        setting: () => undefined,
      },
      active: new Map(),
      sourceChangeRoot: c.root,
    },
    parent,
  );
  assert.deepEqual(listed.worktrees.map(item => path.basename(item.path)).sort(), ['i-retried', 'left']);
  // Before the setup process removes them, a retried integration of the same review replaces its worktree.
  removeSourceWorktree(c.root, path.join(parent, 'i-retried'));
  createSourceWorktree(c.root, parent, 'i-retried', head);
  removeWorktrees(listed);
  assert.deepEqual(fs.readdirSync(parent), ['i-retried']);
  assert.equal(git(c.root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 2);
  removeSourceWorktree(c.root, path.join(parent, 'i-retried'));
});

// The message for a setup process that ended without a failed step or an error line, which never points at the log.
function ended(fields) {
  const message = setupEndedMessage(fields);
  assert.ok(!message.includes('See the attempt log'), message);
  return message;
}

test('a setup that ended without a reason names its exit code', () => {
  assert.equal(
    ended({ code: 1 }),
    'Setting up the attempt failed: the setup process ended with exit code 1 before reporting any step.',
  );
  assert.ok(!ended({ code: 255 }).includes('0x'));
});

test('a setup that ended with a large Windows status names it in hexadecimal too', () => {
  assert.ok(ended({ code: 3221225794 }).includes('ended with exit code 3221225794 (0xC0000142)'));
  assert.ok(ended({ code: 3221225477 }).includes('exit code 3221225477 (0xC0000005)'));
});

test('a setup stopped by a signal names the signal', () => {
  const message = ended({ code: null, signal: 'SIGKILL' });
  assert.ok(message.includes('the setup process was stopped by the signal SIGKILL'), message);
  assert.ok(!message.includes('exit code'), message);
});

test('a setup that ended inside a step names the step in plain words, or the last step that finished', () => {
  assert.ok(ended({ code: 1, step: 'setup.worktree' }).includes(' while making the working copy.'));
  assert.ok(ended({ code: 1, step: 'setup.snapshot' }).includes(' while checking the snapshot.'));
  assert.ok(ended({ code: 1, step: 'setup.copy' }).includes(' while copying the source.'));
  const between = ended({ code: 1, finished: 'setup.copy' });
  assert.ok(between.includes(' after copying the source.'), between);
  assert.ok(!between.includes('setup.copy'), between);
});

test('a setup that ended before reporting any step says so', () => {
  const message = ended({ code: 1, signal: null, step: '', finished: '' });
  assert.ok(message.endsWith(' before reporting any step.'), message);
});

test('a setup that ended without a reason ends its message with the last line it wrote', () => {
  const line = '{"phase":"setup.snapshot","boundary":"start"}',
    message = ended({ code: 1, step: 'setup.snapshot', output: `${line}\n` });
  assert.equal(
    message,
    `Setting up the attempt failed: the setup process ended with exit code 1 while checking the snapshot. Its last output line was: ${line}`,
  );
  assert.ok(!ended({ code: 1, output: '  ' }).includes('last output line'));
});

// runSourceSetup on a runtime that starts no process: the test writes the setup's output lines and ends it.
function fakeSetup() {
  const entry = {},
    finished = [];
  let complete,
    nexts = 0;
  const runtime = {
    runNative(target, binary, args, prompt, readResult, options) {
      target.child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
      complete = options.onComplete;
    },
    startPhase: (target, phaseId) => ({ phaseId }),
    store: { finishPhase: (phase, outcome, details) => finished.push([phase.phaseId, outcome, details.error]) },
  };
  runSourceSetup(runtime, entry, {}, () => nexts++);
  return {
    say: progress => entry.child.stdout.emit('data', JSON.stringify(progress) + '\n'),
    stderr: text => entry.child.stderr.emit('data', text),
    end: (code, signal = null) => complete(null, code, signal),
    finished,
    nexts: () => nexts,
  };
}

test('a setup process that ends non-zero without a failed step or an error line fails with how it ended', () => {
  const s = fakeSetup();
  s.say({ phase: 'setup.worktree', boundary: 'start' });
  assert.throws(
    () => s.end(3221225794),
    error => {
      assert.ok(error.message.includes('exit code 3221225794'), error.message);
      assert.ok(error.message.includes('0xC0000142'), error.message);
      assert.ok(error.message.includes('while making the working copy'), error.message);
      assert.ok(error.message.endsWith('Its last output line was: {"phase":"setup.worktree","boundary":"start"}'));
      assert.ok(!error.message.includes('See the attempt log'), error.message);
      return true;
    },
  );
  assert.equal(s.nexts(), 0);
  // Ended by a signal between steps: the last finished step is named, and no step is left open.
  const between = fakeSetup();
  between.say({ phase: 'setup.worktree', boundary: 'start' });
  between.say({ phase: 'setup.worktree', boundary: 'finish', outcome: 'succeeded', durationMs: 3 });
  assert.throws(() => between.end(null, 'SIGTERM'), {
    message:
      'Setting up the attempt failed: the setup process was stopped by the signal SIGTERM after making the working copy. ' +
      'Its last output line was: {"phase":"setup.worktree","boundary":"finish","outcome":"succeeded","durationMs":3}',
  });
  assert.deepEqual(between.finished, [['setup.worktree', 'succeeded', undefined]]);
});

test('a setup step’s own failure comes before the last error line, which comes before how the process ended', () => {
  const snapshotFailed = fakeSetup();
  snapshotFailed.say({ phase: 'setup.worktree', boundary: 'start' });
  snapshotFailed.say({ phase: 'setup.worktree', boundary: 'finish', outcome: 'succeeded', durationMs: 3 });
  snapshotFailed.say({ phase: 'setup.snapshot', boundary: 'start' });
  snapshotFailed.say({
    phase: 'setup.snapshot',
    boundary: 'finish',
    outcome: 'failed',
    durationMs: 2,
    error: snapshotMismatch,
  });
  snapshotFailed.stderr('A later error line.\n');
  assert.throws(() => snapshotFailed.end(1), { message: snapshotMismatch });
  assert.deepEqual(snapshotFailed.finished.at(-1), ['setup.snapshot', 'failed', snapshotMismatch]);
  const wrote = fakeSetup();
  wrote.say({ phase: 'setup.copy', boundary: 'start' });
  wrote.stderr('An earlier line.\n');
  wrote.stderr('ENOSPC: no space left on device\n');
  assert.throws(() => wrote.end(3221225794), { message: 'ENOSPC: no space left on device' });
  // A setup that ends with code 0 goes on to the editor.
  const done = fakeSetup();
  for (const phase of ['setup.worktree', 'setup.snapshot', 'setup.copy']) {
    done.say({ phase, boundary: 'start' });
    done.say({ phase, boundary: 'finish', outcome: 'succeeded', durationMs: 1 });
  }
  done.end(0);
  assert.equal(done.nexts(), 1);
  assert.equal(done.finished.length, 3);
});
