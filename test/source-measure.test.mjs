// A dispatch pass measures the sources its waiting stories' scope checks read in a process of its own
// (src/connectors/source-measure.mjs) and then checks them on those measurements: the controller keeps answering while
// the measuring is held, the started story records the measuring as its setup.scope phase before the setup process's
// steps, the process answers as measuring on the thread does for the checked-out line and another line, and a scope
// it refuses, or a measurement that failed there, blocks the story with the reason measuring on the thread gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { changeScope } from '../src/connectors/source-changes.mjs';
import { lineBase, lineFiles, lineTip, measuredLine, measureLine } from '../src/connectors/source-lines.mjs';
import { measureLines, measureSources } from '../src/connectors/source-measure.mjs';
import { profileOf } from '../src/connectors/source-profile.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  phases = (store, attemptId) => store.phaseEvents(attemptId).map(event => event.payload);

// The file whose presence holds the measuring process before it measures anything (the runner's sourceMeasureHold,
// a trusted test seam), in a folder of its own.
function holdFile(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-measure-hold-')),
    file = path.join(folder, 'hold');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(file, '');
  return file;
}

// How many times the live source was measured on this thread: each measurement visits package.json once.
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

const queue = (c, id) => {
  const task = c.app.store.task(id);
  task.queued = true;
  c.app.store.putTask(task);
};

test('the controller keeps answering while a dispatch pass’s measuring process is held, and the story then starts with its scope measured first', async t => {
  const hold = holdFile(t),
    c = await setup(t, 'pass', undefined, { sourceMeasureHold: hold }),
    { store, runner } = c.app;
  queue(c, c.taskId);
  runner.enablePipeline('project-legacy');
  const pass = runner.dispatchQueued(),
    began = performance.now(),
    answers = [];
  assert.ok(pass instanceof Promise, 'The pass waits for its measuring process.');
  const ask = async () => {
    const asked = performance.now(),
      response = await fetch(c.origin + '/theme.js');
    await response.arrayBuffer();
    assert.equal(response.status, 200);
    answers.push(performance.now() - asked);
  };
  await waitFor(() => runner.sourceMeasuring, 'the measuring process to start');
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    await ask();
  }
  assert.ok(
    answers.every(ms => ms < 250),
    `Every request answers within 250 ms: ${answers.map(Math.round).join(', ')} ms.`,
  );
  // Still held: nothing started.
  assert.ok(runner.sourceMeasuring, 'The measuring process is still held.');
  assert.equal(store.attempts(c.taskId).length, 0);
  assert.equal(store.task(c.taskId).status, 'ready');
  const heldMs = performance.now() - began;
  fs.rmSync(hold);
  await pass;
  const attemptId = store.task(c.taskId).lastAttemptId;
  assert.ok(attemptId, 'The story started once the measuring was let go.');
  const a = await c.wait(c.taskId),
    recorded = phases(store, a.id);
  assert.deepEqual(recorded.map(p => `${p.phaseId}:${p.boundary}`).slice(0, 9), [
    'attempt:start',
    'setup.scope:start',
    'setup.scope:finish',
    'setup.worktree:start',
    'setup.worktree:finish',
    'setup.snapshot:start',
    'setup.snapshot:finish',
    'setup.copy:start',
    'setup.copy:finish',
  ]);
  assert.ok(recorded.filter(p => p.boundary === 'finish').every(p => p.outcome === 'succeeded'));
  // The scope's time is the whole measuring, its hold included, from its start.
  const scope = recorded.find(p => p.phaseId === 'setup.scope' && p.boundary === 'finish');
  assert.ok(
    scope.durationMs > 0 && scope.durationMs >= heldMs,
    `Scope took ${scope.durationMs} ms, held ${heldMs} ms.`,
  );
  assert.deepEqual(a.sourceChange.allowedFiles, ['src/core/workflows.mjs']);
  assert.equal(runner.sourceMeasuring, null, 'The measuring process ended.');
});

test('a line that moved while its measuring was held is measured again, and the story starts from the new commit', async t => {
  const hold = holdFile(t),
    c = await setup(t, 'pass', undefined, { sourceMeasureHold: hold }),
    { store, runner } = c.app;
  queue(c, c.taskId);
  runner.enablePipeline('project-legacy');
  const before = git(c.root, ['rev-parse', 'HEAD']),
    pass = runner.dispatchQueued();
  await waitFor(() => fs.existsSync(hold + '.held'), 'the measuring process to have measured');
  // An integration lands on the line after the process measured it.
  fs.writeFileSync(path.join(c.root, 'landed.txt'), 'Integrated meanwhile.\n');
  git(c.root, ['add', 'landed.txt']);
  git(c.root, ['commit', '--quiet', '-m', 'Integrated meanwhile']);
  const moved = git(c.root, ['rev-parse', 'HEAD']);
  assert.notEqual(moved, before);
  fs.rmSync(hold);
  await pass;
  assert.equal(store.attempts(c.taskId).length, 0, 'Nothing started on the measurement made before the line moved.');
  const a = await c.wait(c.taskId);
  assert.equal(a.sourceWorktree.baseCommit, moved, 'The story starts from the commit the line moved to.');
});

// The checked-out line changes in its folder, without a commit, after the process measured it: the measurement is not
// reused, and the story gets the refusal measuring on the thread gives.
async function changedWhileHeld(t, allowedFiles, change, reason) {
  const hold = holdFile(t),
    c = await setup(t, 'pass', allowedFiles, { sourceMeasureHold: hold }, true),
    { store, runner } = c.app;
  queue(c, c.taskId);
  runner.enablePipeline('project-legacy');
  const before = git(c.root, ['rev-parse', 'HEAD']),
    pass = runner.dispatchQueued();
  await waitFor(() => fs.existsSync(hold + '.held'), 'the measuring process to have measured');
  change(c.root);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), before, 'Nothing was committed.');
  let expected;
  assert.throws(
    () => changeScope(store, store.task(c.taskId), runner.sourceChangeRoot, { dryRun: true }),
    error => (expected = error.message) && true,
  );
  assert.match(expected, reason);
  fs.rmSync(hold);
  await pass;
  await waitFor(() => store.task(c.taskId).reason === expected, 'the story to be refused');
  assert.equal(store.attempts(c.taskId).length, 0, 'No story was claimed on the measurement made before the change.');
  assert.notEqual(store.task(c.taskId).status, 'working');
}

test('an uncommitted edit to an approved file while the measuring was held blocks the story with the reason measuring on the thread gives', async t => {
  await changedWhileHeld(
    t,
    ['src/core/workflows.mjs'],
    root => fs.appendFileSync(path.join(root, 'src/core/workflows.mjs'), '// Uncommitted, while held.\n'),
    /changed since the proposal, and the changes are not committed: src\/core\/workflows\.mjs\./,
  );
});

test('an untracked file a story would create, added while the measuring was held, blocks the story with the reason measuring on the thread gives', async t => {
  await changedWhileHeld(
    t,
    { files: ['src/core/workflows.mjs'], newFiles: ['src/core/fresh.mjs'] },
    root => fs.writeFileSync(path.join(root, 'src/core/fresh.mjs'), '// Added, while held.\n'),
    /src\/core\/fresh\.mjs now exists or collides with an existing path, so it cannot be created\./,
  );
});

test('a checked-out line’s tip moves with each uncommitted edit and new file, and another line’s only with its commit', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    root = c.root;
  git(root, ['branch', 'other']);
  const tips = () => [lineTip(root, undefined), lineTip(root, 'main'), lineTip(root, 'other')],
    clean = tips();
  assert.deepEqual(tips(), clean, 'Nothing changed, so nothing moved.');
  fs.appendFileSync(path.join(root, 'src/core/workflows.mjs'), '// First edit.\n');
  const edited = tips();
  assert.notEqual(edited[0], clean[0]);
  assert.notEqual(edited[1], clean[1]);
  assert.equal(edited[2], clean[2], 'A line not checked out keeps its tip.');
  fs.appendFileSync(path.join(root, 'src/core/workflows.mjs'), '// Second edit to the same file.\n');
  const again = tips();
  assert.notEqual(again[0], edited[0], 'A second edit to a file already changed counts.');
  assert.notEqual(again[1], edited[1]);
  fs.writeFileSync(path.join(root, 'src/core/fresh.mjs'), '// New.\n');
  assert.notEqual(tips()[0], again[0], 'An untracked file counts.');
  // Ignored files are left out.
  fs.writeFileSync(path.join(root, '.git/info/exclude'), 'scratch/\n');
  const excluded = tips();
  fs.mkdirSync(path.join(root, 'scratch'));
  fs.writeFileSync(path.join(root, 'scratch/notes.txt'), 'ignored\n');
  assert.deepEqual(tips(), excluded, 'An ignored file does not move the tip.');
});

test('the measuring process answers as measuring on the thread does, for the checked-out line and for another line', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    root = c.root,
    profile = profileOf({}),
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-measure-wt-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // Ignore rules and another line whose tip changed a file; on the checked-out line, an uncommitted edit.
  fs.writeFileSync(path.join(root, '.gitignore'), 'src/core/*.tmp\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '--quiet', '-m', 'Ignore rules']);
  git(root, ['branch', 'other']);
  git(root, ['checkout', '--quiet', 'other']);
  fs.writeFileSync(path.join(root, 'src/core/projects.mjs'), '// Changed on the other line.\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'src/core/*.tmp\nsrc/core/other-*.mjs\n');
  git(root, ['commit', '--quiet', '-am', 'Other line']);
  git(root, ['checkout', '--quiet', 'main']);
  fs.appendFileSync(path.join(root, 'src/core/workflows.mjs'), '// Uncommitted.\n');
  const asked = [
      ['src/core/workflows.mjs', 'src/core/projects.mjs', 'src/core/new.mjs'],
      ['src/core/a.tmp', 'src/core/other-x.mjs', 'src/core/new.mjs'],
    ],
    lines = [undefined, 'other'],
    measured = await measureSources({
      lines: lines.map(line => ({ root, ...(line ? { line } : {}), ignored: asked })),
      parent,
    });
  assert.equal(measured.length, 2);
  for (const [i, line] of lines.entries()) {
    const thread = { current: measureLine(root, line, profile, parent), files: lineFiles(root, line, profile, parent) },
      process = measuredLine(root, line, profile, parent, measured[i]);
    assert.deepEqual(process.current, thread.current, `The plan of ${line ?? 'the checked-out line'}.`);
    const answered = new Map(measured[i].ignored);
    for (const files of asked) {
      assert.deepEqual(process.files.committed(files), thread.files.committed(files));
      // The process's own answer (a line's answers are also kept here, which the thread would then reuse).
      assert.deepEqual(answered.get(JSON.stringify(files)).value, thread.files.ignored(files));
      assert.deepEqual(process.files.ignored(files), thread.files.ignored(files));
      assert.deepEqual(process.files.gone(files), thread.files.gone(files));
    }
    assert.ok(thread.files.ignored(asked[1]).length, 'Some of the paths are ignored.');
    // A list the process was not asked about is answered here.
    assert.deepEqual(process.files.ignored(['src/core/b.tmp']), thread.files.ignored(['src/core/b.tmp']));
    assert.deepEqual(process.files.read('src/core/projects.mjs'), thread.files.read('src/core/projects.mjs'));
    let base;
    try {
      base = { value: lineBase(root, line, profile) };
    } catch (error) {
      base = { error: error.message };
    }
    assert.deepEqual(
      measured[i].base.error ? { error: measured[i].base.error.message } : measured[i].base,
      base,
      `The base of ${line ?? 'the checked-out line'}.`,
    );
  }
  // The answers differ between the lines, so each was measured where it is.
  assert.notDeepEqual(measured[0].plan.value.files, measured[1].plan.value.files);
  assert.match(
    measured[0].base.error.message,
    /./,
    'The checked-out line with an uncommitted edit cannot start a story.',
  );
  assert.deepEqual(measured[1].base.value, { commit: git(root, ['rev-parse', 'other']), branch: 'other' });
  // A commit the controller already measured is not measured again, and its answer is the one kept here.
  const again = measureLines({
    lines: [{ root, line: 'other', ignored: asked }],
    parent,
    known: [measured[1].plan.key, ...measured[1].ignored.map(([, item]) => item.key)],
  })[0];
  assert.equal(again.plan.value, undefined);
  assert.ok(again.ignored.every(([, item]) => item.value === undefined));
  assert.deepEqual(
    measuredLine(root, 'other', profile, parent, again).current,
    measureLine(root, 'other', profile, parent),
  );
});

test('a dispatch pass blocks a story whose scope is refused with the reason measuring on the thread gives, and measures nothing on the thread', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// Uncommitted.\n');
  let expected;
  assert.throws(
    () => changeScope(store, store.task(c.taskId), runner.sourceChangeRoot, { dryRun: true }),
    error => (expected = error.message) && true,
  );
  assert.match(expected, /changed since the proposal, and the changes are not committed: src\/core\/workflows\.mjs\./);
  queue(c, c.taskId);
  runner.enablePipeline('project-legacy');
  const measured = measurements(t, c.root);
  await runner.dispatchQueued();
  assert.equal(measured.count, 0, 'Nothing was measured on the controller’s thread.');
  assert.equal(store.task(c.taskId).status, 'blocked');
  assert.equal(store.task(c.taskId).reason, expected);
  assert.equal(store.attempts(c.taskId).length, 0);
});

test('a measurement that failed in the measuring process blocks the story with the message measuring on the thread gives', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  // A file larger than a story may edit fails the source's plan.
  fs.writeFileSync(path.join(c.root, 'src/core/large.mjs'), '//' + 'x'.repeat(1024 * 1024 + 16));
  let expected;
  assert.throws(
    () => changeScope(store, store.task(c.taskId), runner.sourceChangeRoot, { dryRun: true }),
    error => (expected = error.message) && true,
  );
  assert.match(expected, /src\/core\/large\.mjs is larger than/);
  queue(c, c.taskId);
  runner.enablePipeline('project-legacy');
  const measured = measurements(t, c.root);
  await runner.dispatchQueued();
  assert.equal(measured.count, 0, 'Nothing was measured on the controller’s thread.');
  assert.equal(store.task(c.taskId).status, 'blocked');
  assert.equal(store.task(c.taskId).reason, expected);
});
