// A general work step continues from its latest trustworthy work: after a failed check and a
// requested revision, after an independent review sends it back, and after a stop: a time limit, a
// usage limit, a cancellation or a controller restart that was reconciled. The carried files are
// seeded at their paths before the CLI runs, kept in the result when not returned, and go through the
// same validation, review and acceptance as any file. Model-free: the work runs through the Claude
// protocol fixture (fixture-general-work.mjs), the review through the Simulator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { hash } from '../src/core/contracts.mjs';
import { readContinuation } from '../src/core/attempt-continuation.mjs';

const fixture = fileURLToPath(new URL('./fixture-general-work.mjs', import.meta.url));

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-carry-')),
    options = () => ({ directory, port: 0, runnerOptions: { registries: createRegistries(), claudeBinary: fixture } }),
    delay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '15';
  const c = { app: createStudio(options()) };
  c.connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
    c.store = c.app.store;
  };
  await c.connect();
  // The controller stops without seeing the CLI stop, as a crash would leave it: the attempt stays
  // running in its database with its reservations, and the CLI ends with the controller. The
  // controller then opens again on the same folder.
  c.crash = async attemptId => {
    const entry = c.app.runner.active.get(attemptId),
      closed = new Promise(resolve => entry.child.once('close', resolve));
    clearTimeout(entry.timer);
    c.app.runner.active.delete(attemptId);
    entry.child.kill('SIGKILL');
    await closed;
    await c.app.close();
    c.app = createStudio(options());
    await c.connect();
  };
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
  });
  c.request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.until = (check, label) =>
    waitFor(check, label, { interval: 10, detail: () => JSON.stringify(c.store.tasks().slice(-2)) });
  // A project where one employee does the work and another reviews it.
  c.project = async name => {
    const created = await c.request('/api/projects', { name });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const saved = await c.request(
      `/api/projects/${created.data.id}/organization`,
      {
        projectId: created.data.id,
        expectedRevision: c.store.setting('project-organization:' + created.data.id).revision,
        teams: [{ id: 'team', name: 'Team', purpose: 'Bounded work that is not code.' }],
        members: [
          ['W-03', 'worker'],
          ['W-04', 'reviewer'],
        ].map(([workerId, role]) => ({
          workerId,
          teamId: 'team',
          role: 'Contributor',
          responsibility: 'Bounded work that is not code.',
          roles: [role],
        })),
        taskKinds: ['general', 'general:work', 'general:review'],
        kindOwners: {},
      },
      'PATCH',
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return created.data.id;
  };
  // An approved Do the work step, done on the Claude fixture in the given delivery mode.
  c.work = async (projectId, title, mode, direction, fields = {}) => {
    const created = await c.request('/api/tasks', {
      projectId,
      kind: 'general:work',
      workerId: 'W-03',
      title,
      brief: 'Write the files the direction names.',
      acceptance: 'The files hold what the direction says.',
      planned: true,
      execution: { provider: 'claude', mode },
      ...fields,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    assert.equal((await c.request(`/api/tasks/${id}`, { projectId, direction }, 'PATCH')).status, 200);
    assert.equal((await c.request(`/api/tasks/${id}/approve-work`, { projectId })).status, 200);
    return id;
  };
  c.start = async (projectId, id) => {
    const started = await c.request(`/api/tasks/${id}/start`, { projectId });
    assert.equal(started.status, 202, JSON.stringify(started.data));
  };
  // The attempt in Review once it is there.
  c.reviewed = async id => {
    await c.until(() => c.store.task(id).status === 'review', `${id} in review`);
    return c.store.attempt(c.store.task(id).lastAttemptId);
  };
  c.accept = async (projectId, id) => {
    const attempt = await c.reviewed(id),
      accepted = await c.request(`/api/tasks/${id}/accept`, { projectId });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    return c.store.attempt(attempt.id);
  };
  c.revise = async (projectId, id, direction) => {
    const revised = await c.request(`/api/tasks/${id}/revise`, { projectId, direction });
    assert.equal(revised.status, 200, JSON.stringify(revised.data));
  };
  // What the fixture found before it did anything: work files on disk, or its editable files.
  c.seen = attempt =>
    JSON.parse(fs.readFileSync(path.join(path.dirname(attempt.outputFolder), 'fixture-general-work.json'), 'utf8'));
  c.recorded = (attempt, file) => {
    const bytes = fs.readFileSync(path.join(attempt.outputFolder, file));
    return { path: file, hash: hash(bytes), bytes: bytes.length };
  };
  c.continuation = attempt => c.store.events(attempt.id).find(event => event.kind === 'work_continuation');
  // The running attempt once its CLI says it has written its work (the fixture's stop modes).
  c.written = id =>
    c.until(() => {
      const attempt = c.store.attempts(id).at(-1),
        said = event => event.kind === 'log' && event.message.includes('fixture.work-written');
      return attempt?.status === 'running' && c.store.events(attempt.id).some(said) && attempt;
    }, `${id} work written`);
  // The attempt once the controller has finished it with the given status.
  c.stopped = (attemptId, status) =>
    c.until(() => {
      const attempt = c.store.attempt(attemptId);
      return attempt.status === status && !c.app.runner.active.has(attemptId) && attempt;
    }, `${attemptId} ${status}`);
  return c;
}

// Work the stop modes write before they stop, and the direction that writes it and then stops.
const before = { 'draft/plan.md': 'Plan before the stop.\n', 'notes.md': 'Notes before the stop.\n' },
  stopping = mode => `write notes.md Notes before the stop.\nwrite draft/plan.md Plan before the stop.\n${mode}`;

// After a stop the step starts again, and its next attempt continues from the stopped attempt's
// checkpoint: the record names that attempt and the checkpoint's files with no fresh reason, the CLI
// finds their checkpoint bytes at their paths before it runs, and its result keeps them with the same
// hashes. Nothing is accepted or replayed because the work was carried.
async function continuesAfterStop(c, projectId, id, stopped) {
  const job = path.dirname(stopped.outputFolder),
    checkpoint = readContinuation(c.store, stopped);
  assert.equal(checkpoint.status, 'complete', JSON.stringify(checkpoint));
  assert.equal(checkpoint.evidence, 'checkpoint');
  assert.equal(checkpoint.terminal.status, stopped.status);
  const files = Object.keys(before).map(file => {
    const bytes = fs.readFileSync(path.join(job, 'continuation', 'files', file));
    return { path: file, hash: hash(bytes), bytes: bytes.length };
  });
  assert.deepEqual(checkpoint.files, files);
  const redirected = await c.request(
    `/api/tasks/${id}`,
    { projectId, direction: 'write summary.md Summary after the stop.' },
    'PATCH',
  );
  assert.equal(redirected.status, 200, JSON.stringify(redirected.data));
  await c.start(projectId, id);
  const next = await c.reviewed(id);
  assert.notEqual(next.id, stopped.id);
  assert.deepEqual(next.continueFrom, { attemptId: stopped.id, files });
  assert.deepEqual(c.seen(next).found, before);
  assert.match(c.continuation(next).message, /^Continues from the work of .*: draft\/plan\.md, notes\.md\.$/);
  assert.deepEqual(
    next.result.artifacts.map(item => item.path),
    ['summary.md', 'draft/plan.md', 'notes.md'],
  );
  for (const file of files) {
    const kept = next.artifacts.find(item => item.path === file.path);
    assert.deepEqual([kept.kind, kept.hash, kept.bytes], ['work-file', file.hash, file.bytes]);
  }
  const after = c.store.attempt(stopped.id);
  assert.deepEqual([after.status, after.artifacts, after.result], [stopped.status, [], stopped.result]);
  assert.deepEqual(
    c.store.attempts(id).map(a => a.id),
    [stopped.id, next.id],
  );
  assert.equal(c.store.task(id).acceptedAttemptId, undefined);
  assert.equal(next.status, 'review');
  return next;
}

const work = attempt => attempt.assignment.kind === 'general:work';
const inputs = attempt =>
  attempt.inputReferences.map(ref => [ref.taskId, ref.attemptId, ref.artifacts.map(item => item.hash)]);

for (const mode of ['workspace', 'text'])
  test(`a failed check and a requested revision continue from the earlier work at its paths (${mode} delivery)`, async t => {
    const c = await setup(t),
      projectId = await c.project(`Field notes (${mode})`),
      id = await c.work(
        projectId,
        'Write field notes',
        mode,
        'fail-check\nwrite notes.md First notes.\nwrite draft/outline.md Outline.',
      );
    await c.start(projectId, id);
    const first = await c.reviewed(id);
    assert.equal(first.configuration.mode, mode);
    assert.equal(first.continueFrom, undefined, 'The first attempt has nothing to continue from.');
    assert.ok(first.result.checks.some(check => check.status === 'fail'));
    const refused = await c.request(`/api/tasks/${id}/accept`, { projectId });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /failed check/);
    await c.revise(projectId, id, 'write notes.md Second notes.');
    await c.start(projectId, id);
    const second = await c.reviewed(id),
      earlier = ['draft/outline.md', 'notes.md'].map(file => c.recorded(first, file));
    // The record names the earlier attempt and its files; the CLI found them before it ran.
    assert.deepEqual(second.continueFrom, { attemptId: first.id, files: earlier });
    assert.deepEqual(c.seen(second).found, { 'draft/outline.md': 'Outline.\n', 'notes.md': 'First notes.\n' });
    if (mode === 'text') assert.deepEqual(c.seen(second).editable.sort(), ['draft/outline.md', 'notes.md']);
    assert.match(c.continuation(second).message, /Continues from the work of .*: draft\/outline\.md, notes\.md\./);
    assert.ok(fs.existsSync(path.join(path.dirname(second.outputFolder), 'history', 'README.md')));
    // The returned file replaces the earlier one; the unreturned one stays in the result unchanged.
    assert.equal(fs.readFileSync(path.join(second.outputFolder, 'notes.md'), 'utf8'), 'Second notes.\n');
    assert.deepEqual(
      second.result.artifacts.map(item => item.path),
      ['notes.md', 'draft/outline.md'],
    );
    const outline = second.artifacts.find(item => item.path === 'draft/outline.md');
    assert.deepEqual([outline.kind, outline.hash, outline.bytes], ['work-file', earlier[0].hash, earlier[0].bytes]);
    // The carried file went through the same work file validation as the returned one.
    assert.equal(
      second.controllerChecks.find(check => check.name === 'Work files returned').evidence,
      'notes.md, draft/outline.md',
    );
    // The recorded Work contract says a stop keeps the work, so the step need not stop early.
    assert.match(
      second.instructions.text,
      /stops this attempt at its time limit[^.]*the files you have written so far are kept for the next attempt, so work until the step is done rather than stopping early/,
    );
    // Accepting the revision accepts the carried file with it, through the normal review stage.
    assert.equal(second.status, 'review');
    await c.accept(projectId, id);
    const review = await c.accept(projectId, id);
    assert.equal(review.workReviewVerdict, 'pass');
    assert.deepEqual(inputs(review), [[id, second.id, second.artifacts.map(item => item.hash)]]);
    assert.equal(c.store.task(id).acceptedAttemptId, second.id);
  });

test('a review that asks for changes continues the work from the accepted work attempt; untouched work is accepted with the revision', async t => {
  const c = await setup(t),
    projectId = await c.project('Park guide'),
    id = await c.work(
      projectId,
      'REWORK the park guide',
      'workspace',
      'write guide.md Revision 1.\nwrite sources.md Sources.',
    );
  await c.start(projectId, id);
  const firstWork = await c.accept(projectId, id),
    firstReview = await c.accept(projectId, id);
  // The Simulator review asks for changes to a first revision, which sends the work back.
  assert.equal(firstReview.assignment.kind, 'general:review');
  assert.equal(firstReview.workReviewVerdict, 'needs-work');
  assert.deepEqual(inputs(firstReview), [[id, firstWork.id, firstWork.artifacts.map(item => item.hash)]]);
  assert.equal(firstReview.continueFrom, undefined, 'A review attempt carries nothing.');
  assert.equal(c.store.task(id).status, 'blocked');
  const redirected = await c.request(
    `/api/tasks/${id}`,
    { projectId, direction: 'write guide.md Revision 2.' },
    'PATCH',
  );
  assert.equal(redirected.status, 200, JSON.stringify(redirected.data));
  await c.start(projectId, id);
  const revised = await c.accept(projectId, id),
    passed = await c.accept(projectId, id);
  assert.ok(work(revised));
  assert.deepEqual(revised.continueFrom, {
    attemptId: firstWork.id,
    files: ['guide.md', 'sources.md'].map(file => c.recorded(firstWork, file)),
  });
  assert.deepEqual(c.seen(revised).found, { 'guide.md': 'Revision 1.\n', 'sources.md': 'Sources.\n' });
  // The file the revision neither changed nor returned is registered with the same hash and accepted.
  const carried = revised.artifacts.find(item => item.path === 'sources.md');
  assert.deepEqual(
    [carried.kind, carried.hash],
    ['work-file', firstWork.artifacts.find(item => item.path === 'sources.md').hash],
  );
  assert.equal(passed.workReviewVerdict, 'pass');
  assert.deepEqual(inputs(passed), [[id, revised.id, revised.artifacts.map(item => item.hash)]]);
  const task = c.store.task(id);
  assert.equal(task.status, 'done');
  assert.equal(task.acceptedAttemptId, revised.id);
  assert.ok(c.store.attempt(task.acceptedAttemptId).artifacts.some(item => item.hash === carried.hash));
  assert.deepEqual(
    task.stageState.history.map(entry => [entry.key, entry.outcome]),
    [
      ['work', 'accepted'],
      ['review', 'sent-back'],
      ['work', 'accepted'],
      ['review', 'accepted'],
    ],
  );
  // A review's file is never seeded into, or carried by, a work attempt.
  for (const attempt of c.store.attempts(id).filter(work)) {
    assert.equal(fs.existsSync(path.join(attempt.outputFolder, 'review.json')), false);
    assert.ok(!(attempt.continueFrom?.files || []).some(item => item.path === 'review.json'));
  }
});

test('an altered checkpoint starts the next attempt with no carried work; the reason and the earlier attempt stay recorded', async t => {
  const c = await setup(t),
    projectId = await c.project('Altered notes'),
    id = await c.work(projectId, 'Write notes', 'workspace', 'fail-check\nwrite notes.md First notes.');
  await c.start(projectId, id);
  const first = await c.reviewed(id);
  fs.appendFileSync(path.join(path.dirname(first.outputFolder), 'continuation', 'files', 'notes.md'), 'Altered.\n');
  await c.revise(projectId, id, 'write other.md Other notes.');
  await c.start(projectId, id);
  const second = await c.reviewed(id);
  assert.equal(second.continueFrom.attemptId, first.id);
  assert.deepEqual(second.continueFrom.files, []);
  assert.match(second.continueFrom.fresh.reason, /could not be verified \(Continuation hash\/size mismatch\.\)/);
  assert.match(
    c.continuation(second).message,
    /^Starts without the work of .*: its recorded work could not be verified \(Continuation hash/,
  );
  assert.deepEqual(c.seen(second).found, {}, 'Nothing was seeded.');
  assert.deepEqual(
    second.artifacts.map(item => item.path),
    ['other.md'],
  );
  // The earlier attempt and its history entry remain.
  assert.equal(c.store.attempt(first.id).status, 'revision_requested');
  assert.equal(fs.readFileSync(path.join(first.outputFolder, 'notes.md'), 'utf8'), 'First notes.\n');
  const history = path.join(path.dirname(second.outputFolder), 'history');
  assert.match(fs.readFileSync(path.join(history, 'README.md'), 'utf8'), new RegExp(first.id));
  assert.ok(fs.readdirSync(history).some(name => name.endsWith(`-${first.id}.md`)));
});

test('work that stops verifying while it is seeded is removed, and the attempt starts fresh instead of failing', async t => {
  const c = await setup(t),
    projectId = await c.project('Changed while seeding'),
    id = await c.work(projectId, 'Write two notes', 'workspace', 'fail-check\nwrite draft/a.md A.\nwrite z.md Z.');
  await c.start(projectId, id);
  const first = await c.reviewed(id),
    insert = c.store.insertAttempt;
  // The selection verified the checkpoint; the second file changes before it is seeded.
  t.mock.method(c.store, 'insertAttempt', function (attempt, snapshot) {
    insert.call(this, attempt, snapshot);
    if (attempt.continueFrom?.files.length)
      fs.appendFileSync(path.join(path.dirname(first.outputFolder), 'continuation', 'files', 'z.md'), '!');
  });
  await c.revise(projectId, id, 'write c.md C.');
  await c.start(projectId, id);
  const second = await c.reviewed(id);
  assert.deepEqual(second.continueFrom.files, []);
  assert.match(second.continueFrom.fresh.reason, /did not verify when this attempt started/);
  assert.deepEqual(c.seen(second).found, {}, 'The file seeded before the failure was removed.');
  assert.equal(fs.existsSync(path.join(second.outputFolder, 'draft')), false);
  assert.deepEqual(
    second.artifacts.map(item => item.path),
    ['c.md'],
  );
  assert.match(c.continuation(second).message, /did not verify when this attempt started/);
});

test('a carried file the CLI deletes in its workspace leaves the result', async t => {
  const c = await setup(t),
    projectId = await c.project('Deleted notes'),
    id = await c.work(projectId, 'Write notes', 'workspace', 'fail-check\nwrite keep.md Keep.\nwrite drop.md Drop.');
  await c.start(projectId, id);
  await c.reviewed(id);
  await c.revise(projectId, id, 'delete drop.md\nwrite keep.md Kept.');
  await c.start(projectId, id);
  const second = await c.reviewed(id);
  assert.deepEqual(
    second.continueFrom.files.map(item => item.path),
    ['drop.md', 'keep.md'],
  );
  assert.deepEqual(
    second.artifacts.map(item => item.path),
    ['keep.md'],
  );
});

test('work written before the time limit stops an attempt is carried into the next attempt', async t => {
  const c = await setup(t),
    projectId = await c.project('Time limit'),
    id = await c.work(projectId, 'Write notes until stopped', 'workspace', stopping('hang'), { maxSeconds: 9 });
  // The attempt's own 9-second time limit, released once the work is written instead of after 9 seconds.
  const timer = globalThis.setTimeout;
  let limit;
  const timers = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== 9000) return timer(callback, delay, ...args);
    limit = callback;
    return timer(() => {}, 0);
  });
  await c.start(projectId, id);
  const running = await c.written(id);
  timers.mock.restore();
  assert.equal(running.assignment.maxSeconds, 9);
  assert.equal(typeof limit, 'function', 'The attempt set its time limit.');
  limit();
  const stopped = await c.stopped(running.id, 'failed');
  assert.equal(stopped.error, 'Assignment time limit reached.');
  assert.equal(stopped.stopContext.reason, 'time-limit');
  assert.equal(c.store.task(id).status, 'failed');
  await continuesAfterStop(c, projectId, id, stopped);
});

test('work written before a usage limit is carried once the director clears the subscription hold', async t => {
  const c = await setup(t),
    projectId = await c.project('Usage limit'),
    id = await c.work(projectId, 'Write notes until the usage limit', 'workspace', stopping('quota'));
  await c.start(projectId, id);
  const stopped = await c.until(() => {
    const attempt = c.store.attempts(id)[0];
    return attempt?.status === 'blocked' && !c.app.runner.active.has(attempt.id) && attempt;
  }, 'the usage limit');
  assert.equal(stopped.subscriptionHold, 'claude');
  assert.match(stopped.error, /usage limit reached/);
  assert.equal(c.store.organization().quota.claude, true);
  assert.equal(c.store.task(id).status, 'blocked');
  assert.equal((await c.request('/api/control', { clearQuota: 'claude' })).status, 200);
  assert.equal(c.store.organization().quota.claude, false);
  await continuesAfterStop(c, projectId, id, stopped);
});

test('work written before a director cancellation is carried into the next attempt', async t => {
  const c = await setup(t),
    projectId = await c.project('Cancellation'),
    id = await c.work(projectId, 'Write notes until cancelled', 'workspace', stopping('hang'));
  await c.start(projectId, id);
  const running = await c.written(id);
  assert.equal((await c.request(`/api/tasks/${id}/cancel`, { projectId })).status, 202);
  const stopped = await c.stopped(running.id, 'cancelled');
  assert.equal(c.store.task(id).status, 'cancelled');
  assert.equal(stopped.stopContext, undefined, 'A cancellation is not a time limit.');
  await continuesAfterStop(c, projectId, id, stopped);
});

test('work written before a controller restart is carried from the checkpoint reconciliation captured', async t => {
  const c = await setup(t),
    projectId = await c.project('Restart'),
    id = await c.work(projectId, 'Write notes until the controller restarts', 'workspace', stopping('hang'));
  await c.start(projectId, id);
  const running = await c.written(id),
    job = path.dirname(running.outputFolder);
  await c.crash(running.id);
  const interrupted = c.store.attempt(running.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.reconciledAt, undefined);
  assert.match(c.store.task(id).reason, /Reconcile the previous attempt/);
  assert.equal(
    fs.existsSync(path.join(job, 'continuation')),
    false,
    'Nothing is captured while the stop is uncertain.',
  );
  // Starting is refused until the director reconciles the interrupted attempt.
  const refused = await c.request(`/api/tasks/${id}/start`, { projectId });
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  assert.match(refused.data.error, /Reconcile the interrupted attempt/);
  assert.equal(c.store.attempts(id).length, 1);
  const reconciled = await c.request(`/api/tasks/${id}/reconcile`, { projectId });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  const stopped = c.store.attempt(running.id);
  assert.equal(stopped.status, 'interrupted');
  assert.ok(stopped.reconciledAt);
  assert.equal(c.store.leases().length, 0);
  assert.deepEqual(
    c.store
      .events(stopped.id)
      .filter(event => event.kind === 'continuation_checkpoint')
      .map(event => JSON.parse(event.message).status),
    ['complete'],
  );
  // The output folder changes after the checkpoint; the next attempt carries the checkpoint's bytes.
  fs.appendFileSync(path.join(stopped.outputFolder, 'notes.md'), 'Written after the checkpoint.\n');
  await continuesAfterStop(c, projectId, id, stopped);
});
