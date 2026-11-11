// An idea's checks run on a copy in a short folder beside the candidates' working copies (<data>/wt/<name>), not deep
// inside their job folder, so a nested test stays within the Windows path limit. The folder is recorded on the attempt,
// removed when the attempt ends or is stopped, and kept by the leftover sweep only while its attempt holds it.
// Model-free: the protocol fixtures and trusted fixture test commands on disposable repositories, with no HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { createStudio } from './model-free-studio.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { leftoverWorktrees, worktreeName } from '../src/connectors/source-worktrees.mjs';
import { hash } from '../src/core/contracts.mjs';
import { realPath, samePath } from '../src/core/real-path.mjs';
import { testTurnResource } from '../src/core/test-turn.mjs';

const fixture = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  tap = [
    'TAP version 13',
    '1..1',
    'ok 1 - check folder fixture',
    '# tests 1',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n');
// A passing test run that writes its working directory to `where`, then ends once its gate file exists, so the test
// can look at the folder while the tests hold it.
const gated = (gate, where) => ({
  executable: process.execPath,
  args: [
    '-e',
    `const fs = require('node:fs'), [gate, where] = process.argv.slice(1); fs.writeFileSync(where, process.cwd()); const wait = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(wait); console.log(${JSON.stringify(tap)}); } }, 20);`,
    gate,
    where,
  ],
});
const holder = store => store.leases().find(lease => lease.resource === testTurnResource)?.attemptId ?? null;

// An idea's checks, as intake creates them.
function addChecks(c, id, { projectId = 'project-legacy', workerId = 'W-06', maxSeconds = 120 } = {}) {
  const worker = c.app.store.organization().workers.find(worker => worker.id === workerId);
  c.app.store.putTask({
    id,
    projectId,
    title: 'Check the current commit',
    brief: 'Measure the current commit.',
    acceptance: '',
    kind: 'studio-development:checks',
    workerId,
    team: worker.team,
    dependencies: [],
    resources: [],
    maxSeconds,
    maxAttempts: 3,
    direction: '',
    status: 'ready',
    reason: '',
    hold: false,
    lastAttemptId: null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

const inside = (folder, parent) => {
  const relative = path.relative(realPath(parent), folder);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

test("an idea's checks run on a short folder beside the candidates' folders, removed when they finish, with the same report", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner,
    data = store.directory,
    gate = path.join(c.directory, 'gate'),
    where = path.join(c.directory, 'cwd.txt');
  runner.sourceCheckCommand = gated(gate, where);
  const id = runner.start(addChecks(c, 'T-check-folder')).attemptId;
  await waitFor(() => fs.existsSync(where), 'the tests to start');
  const attempt = store.attempt(id),
    job = path.join(data, 'jobs', id),
    folder = attempt.sourceCheckFolder?.path;
  assert.ok(folder, 'The attempt records its check folder before its tests run.');
  const cwd = fs.readFileSync(where, 'utf8');
  assert.ok(samePath(cwd, folder), 'The tests run in the recorded folder.');
  for (const place of [folder, realPath(cwd)]) {
    assert.equal(inside(place, job), false, 'The copy is not inside the job folder.');
    assert.equal(path.dirname(place), realPath(path.join(data, 'wt')), 'It sits directly under the wt folder.');
  }
  // As short as a candidate's working copy, relative to the data folder.
  const relative = path.relative(realPath(data), folder),
    candidate = path.relative(data, path.join(data, 'wt', worktreeName(id)));
  assert.ok(relative.split(path.sep).length <= candidate.split(path.sep).length);
  assert.ok(relative.length <= candidate.length, `${relative} is no longer than ${candidate}`);
  assert.ok(fs.existsSync(path.join(folder, 'package.json')), 'The copy holds the measured source while tests run.');
  assert.equal(fs.existsSync(path.join(job, 'source')), false, 'The job folder holds no source copy.');
  // A concurrent story's leftover sweep keeps the folder while the checks run.
  assert.equal(
    leftoverWorktrees(runner, path.join(data, 'wt')).worktrees.some(item => samePath(item.path, folder)),
    false,
  );

  fs.writeFileSync(gate, '');
  const done = await c.wait('T-check-folder');
  assert.equal(done.id, id);
  assert.equal(fs.existsSync(folder), false, 'The folder is removed once the checks finish.');
  assert.equal(fs.existsSync(path.join(job, 'source')), false);
  assert.equal(
    store.events(id).some(event => event.kind === 'cleanup_failed'),
    false,
  );
  // The job's output and the recorded artifacts are as before.
  const output = path.join(job, 'output');
  for (const file of ['check-report.json', 'test-output.txt', 'test-errors.txt', 'source-context.json'])
    assert.ok(fs.existsSync(path.join(output, file)), `${file} is in the job's output`);
  for (const file of ['check-report.json', 'test-output.txt', 'test-errors.txt', 'source-context.json']) {
    const artifact = done.artifacts.find(item => item.path === file);
    assert.ok(artifact, `${file} is recorded`);
    assert.equal(artifact.hash, hash(fs.readFileSync(path.join(output, file))));
  }
  const report = JSON.parse(fs.readFileSync(path.join(output, 'check-report.json'), 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.source.root, done.sourceCheck.root);
  assert.ok(samePath(report.source.root, c.root), "The report names the development copy's root, not the copy.");
  assert.equal(report.source.commit, git(c.root, ['rev-parse', 'HEAD']));
  assert.equal(report.source.commit, done.sourceCheck.base.commit);
  assert.equal(report.source.hash, done.sourceCheck.sourceHash);
  assert.deepEqual(report.source.files, done.sourceCheck.files);
  assert.equal(JSON.stringify(report).includes(JSON.stringify(folder).slice(1, -1)), false);
  const context = JSON.parse(fs.readFileSync(path.join(output, 'source-context.json'), 'utf8'));
  assert.equal(context.sourceHash, done.sourceCheck.sourceHash);
});

test('checks stopped while their tests hold the turn end cancelled, and their folder is removed', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner;
  runner.sourceCheckCommand = { executable: process.execPath, args: [fixture, 'hang'] };
  const hanging = runner.start(addChecks(c, 'T-check-hang')).attemptId;
  await waitFor(
    () => holder(store) === hanging && store.phaseEvents(hanging).some(event => event.payload.phaseId === 'test'),
    'the hanging checks to run their tests',
  );
  const folder = store.attempt(hanging).sourceCheckFolder.path;
  assert.ok(fs.existsSync(folder), 'The copy is there while the tests run.');
  runner.stop(hanging);
  assert.equal((await c.wait('T-check-hang', 'cancelled')).id, hanging);
  await waitFor(() => !fs.existsSync(folder), 'the stopped checks to remove their folder');
  assert.equal(
    store.events(hanging).some(event => event.kind === 'cleanup_failed'),
    false,
  );
  assert.equal(holder(store), null);
});

test('the leftover sweep keeps a check folder while its attempt is active, quarantined or unreconciled, then lists it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-check-folder-')),
    app = createStudio({ directory, port: 0 }),
    store = app.store,
    parent = path.join(directory, 'wt');
  t.after(async () => {
    await app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const attempt = {
    id: 'attempt-abcdef12-check',
    taskId: 'T-check-leftover',
    projectId: 'project-legacy',
    workerId: 'W-06',
    status: 'running',
    artifacts: [],
    sourceCheckFolder: { path: path.join(parent, worktreeName('attempt-abcdef12-check')) },
  };
  fs.mkdirSync(attempt.sourceCheckFolder.path, { recursive: true });
  // Another folder nobody holds, which every sweep lists.
  fs.mkdirSync(path.join(parent, 'stale000'), { recursive: true });
  const listed = active =>
    leftoverWorktrees({ store, active, sourceChangeRoot: directory }, parent)
      .worktrees.map(item => path.basename(item.path))
      .sort();
  // Active: held by the controller, before or after the store has it.
  assert.deepEqual(listed(new Map([[attempt.id, { attempt }]])), ['stale000']);
  store.insertAttempt(attempt, { text: 'Fixture', hash: 'fixture' });
  assert.deepEqual(listed(new Map([[attempt.id, { attempt }]])), ['stale000']);
  // Quarantined.
  attempt.status = 'quarantined';
  store.updateAttempt(attempt);
  assert.deepEqual(listed(new Map()), ['stale000']);
  // Interrupted by a restart and not yet reconciled.
  attempt.status = 'interrupted';
  store.updateAttempt(attempt);
  assert.deepEqual(listed(new Map()), ['stale000']);
  // Once reconciled, a folder a restart left behind is a leftover.
  attempt.reconciledAt = new Date().toISOString();
  store.updateAttempt(attempt);
  assert.deepEqual(listed(new Map()), ['abcdef12', 'stale000']);
  // A settled attempt does not hold it either.
  delete attempt.reconciledAt;
  attempt.status = 'cancelled';
  store.updateAttempt(attempt);
  assert.deepEqual(listed(new Map()), ['abcdef12', 'stale000']);
});
