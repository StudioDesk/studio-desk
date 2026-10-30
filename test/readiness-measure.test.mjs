// A scheduler pass measures the live source at most once (measuringPass, src/connectors/source-changes.mjs): every
// story it checks and the scope a start records reuse that measurement until a story starts, which measures again for
// the checks after it. The next pass measures afresh, and a check outside a pass measures every time. Work that cannot
// start yet, with no free slot or one of its resources held, is not measured at all until it could start.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { changeScope, measureAgain, measuringPass } from '../src/connectors/source-changes.mjs';

// How many times the live source was measured: each measurement visits every file of it once, package.json among them.
function measurements(t, root) {
  const marker = path.join(fs.realpathSync(root), 'package.json'),
    lstat = fs.lstatSync,
    counted = { count: 0 };
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (typeof file === 'string' && path.resolve(file) === marker) counted.count++;
    return lstat(file, ...args);
  });
  return counted;
}

// The file whose presence holds a story's setup process once its working copy is made (the runner's sourceSetupHold,
// a trusted test seam), so the started story stays running while the passes are measured.
function holdFile(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-measure-hold-')),
    file = path.join(folder, 'hold');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(file, '');
  return file;
}

const uncommitted =
  'Approved source files changed since the proposal, and the changes are not committed: src/core/projects.mjs. Commit or discard them in the development copy, then try again.';

test('one dispatch pass measures the live source once until a story starts, stories that then have no slot are not measured, and the pass after it measures again', async t => {
  const hold = holdFile(t),
    c = await setup(t, 'pass', undefined, { sourceSetupHold: hold }, true),
    { store, runner } = c.app,
    first = c.taskId,
    second = await c.propose('second'),
    third = await c.propose('third', { files: ['src/core/projects.mjs'] });
  // One attempt at a time in this studio. Three approved stories wait for the same employee; the first two are queued.
  const org = store.organization();
  org.maxParallel = 1;
  store.setOrganization(org);
  for (const id of [first, second, third]) {
    assert.equal(store.task(id).status, 'ready');
    assert.equal(store.task(id).workerId, store.task(first).workerId);
  }
  for (const id of [first, second]) {
    const task = store.task(id);
    task.queued = true;
    store.putTask(task);
  }
  runner.enablePipeline('project-legacy');
  const measured = measurements(t, c.root),
    start = runner.start,
    startedAfter = [];
  t.mock.method(runner, 'start', function (...args) {
    try {
      return start.apply(this, args);
    } finally {
      startedAfter.push(measured.count);
    }
  });
  // The pass checks all three stories, then each queued one again before its start, and the start checks its scope
  // twice more: one measurement until the first story starts. The stories after it have no slot, so nothing is
  // measured for them (October 29: their git calls held the controller for seconds on each pass).
  runner.dispatchQueued();
  assert.deepEqual(startedAfter, [1], 'The first story started on the pass’s one measurement.');
  assert.equal(measured.count, 1, 'The checks after the start measured nothing.');
  const attempt = store.attempt(store.task(first).lastAttemptId);
  assert.equal(store.task(first).status, 'running');
  assert.deepEqual(attempt.sourceChange.allowedFiles, ['src/core/workflows.mjs']);
  // The second and third stories wait for a slot; the second stays queued.
  for (const id of [second, third]) {
    assert.equal(store.task(id).status, 'blocked');
    assert.equal(store.task(id).reason, 'Waiting for a studio execution slot.');
  }
  assert.equal(store.task(second).queued, true);
  await waitFor(
    () =>
      store
        .phaseEvents(attempt.id)
        .some(event => event.payload.phaseId === 'setup.snapshot' && event.payload.boundary === 'start'),
    'the first story’s setup to be held',
  );
  // A file the third story lists is edited between passes. While no slot is free, a pass measures nothing for it;
  // the first pass once one is free sees the edit.
  fs.appendFileSync(path.join(c.root, 'src/core/projects.mjs'), '// Edited between passes.\n');
  measured.count = 0;
  runner.dispatchQueued();
  assert.equal(measured.count, 0, 'A pass with no free slot measured nothing.');
  assert.equal(store.task(third).reason, 'Waiting for a studio execution slot.');
  assert.deepEqual(startedAfter, [1], 'Nothing else started.');
  // Let the first story finish with nothing queued after it.
  runner.pipeline('remove', [second], 'project-legacy');
  fs.rmSync(hold);
  await c.wait(first);
  measured.count = 0;
  runner.refreshReadiness();
  assert.equal(measured.count, 1, 'The pass after it measured the source once.');
  assert.equal(store.task(third).reason, uncommitted);
});

test('outside a measuring pass every scope check measures the live source, and inside one it measures once', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app,
    task = store.task(c.taskId),
    check = () => changeScope(store, task, runner.sourceChangeRoot, { dryRun: true }),
    measured = measurements(t, c.root);
  check();
  check();
  assert.equal(measured.count, 2, 'Each check outside a pass measured.');
  measured.count = 0;
  const scopes = measuringPass(() => [check(), measuringPass(() => check()), check()]);
  assert.equal(measured.count, 1, 'The checks in one pass, a joined pass included, measured once.');
  assert.deepEqual(scopes[1], scopes[0]);
  // Each check gets its own copy of the measurement.
  assert.notEqual(scopes[1].source, scopes[0].source);
  measured.count = 0;
  measuringPass(() => {
    check();
    measureAgain();
    check();
    check();
  });
  assert.equal(measured.count, 2, 'A start ends the reuse: the pass measured again after it, once.');
  // A pass that ends with an error closes, so the checks after it measure again.
  measured.count = 0;
  assert.throws(
    () =>
      measuringPass(() => {
        check();
        throw new Error('Fixture failure inside the pass.');
      }),
    /Fixture failure inside the pass/,
  );
  check();
  assert.equal(measured.count, 2);
  // A file edited after a pass is seen by the next check.
  fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// Edited after the pass.\n');
  assert.throws(check, /changed since the proposal, and the changes are not committed: src\/core\/workflows\.mjs\./);
});
