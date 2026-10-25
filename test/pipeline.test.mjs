import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { describeTask, waitFor } from './wait-for.mjs';
import { Store } from '../src/core/store.mjs';
import { Runner } from '../src/runner.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { readContinuation } from '../src/core/attempt-continuation.mjs';
import { jobDirectory } from '../src/core/projects.mjs';

const fixture = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url)),
  claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url));
async function setup(t, runnerOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pipeline-'));
  const c = {
    directory,
    app: createStudio({ directory, port: 0, runnerOptions: { codexBinary: fixture, ...runnerOptions } }),
  };
  const connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await connect();
  c.connect = connect;
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  c.request = async (url, body = {}, method = 'POST') => {
    const res = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  c.until = async (check, label = 'pipeline state') => {
    await waitFor(check, label, { interval: 20 });
  };
  // Some waited-for states, such as cancelled or blocked before dispatch, have no attempt.
  c.wait = async (id, status) => {
    await waitFor(() => c.app.store.task(id).status === status, `task ${id} to be ${status}`, {
      interval: 20,
      detail: () => {
        const task = c.app.store.task(id);
        return describeTask(task, task.lastAttemptId && c.app.store.attempt(task.lastAttemptId));
      },
    });
  };
  c.create = async (title, workerId, extra = {}) =>
    (await c.request('/api/tasks', { title, workerId, kind: 'general', brief: 'Bounded model-free work.', ...extra }))
      .data;
  return c;
}

test('one pipeline approval dispatches eligible work and revisions, with director acceptance gates', async t => {
  const c = await setup(t);
  assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001', 'missing'] })).status, 400);
  assert.ok(
    c.app.store.tasks().every(task => !task.queued),
    'Invalid plans do not partially queue work.',
  );
  assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001', 'R-001'] })).status, 200);
  await c.wait('D-001', 'review');
  const first = c.app.store.attempts('D-001')[0];
  c.app.runner.autonomy.attention(c.app.store.task('D-001'), 'Inspect the reviewed output.');
  assert.equal(c.app.store.attempts('R-001').length, 0);
  assert.equal((await c.request('/api/tasks/R-001/accept')).status, 400);
  await c.request('/api/tasks/D-001/revise', { direction: 'Explain the exit landmark.' });
  assert.equal(c.app.store.task('D-001').autonomyNote, undefined);
  await c.until(() => c.app.store.attempts('D-001').length === 2);
  await c.wait('D-001', 'review');
  const second = c.app.store.attempts('D-001')[1];
  assert.match(second.instructions.text, /Explain the exit landmark/);
  assert.equal(c.app.store.attempt(first.id).instructions.hash, first.instructions.hash);
  assert.equal(c.app.store.attempts('R-001').length, 0);
  assert.equal((await c.request('/api/tasks/D-001/accept')).status, 200);
  await c.wait('R-001', 'review');
  const reviewer = c.app.store.attempts('R-001')[0];
  assert.equal(reviewer.inputReferences[0].attemptId, second.id);
  assert.equal(reviewer.status, 'review');
  assert.equal(reviewer.reviewVerdict, 'pass');
  assert.equal((await c.request('/api/tasks/R-001/accept')).status, 200);
  await c.until(() => !c.app.store.organization().pipelineEnabled);
  assert.ok(c.app.store.tasks().every(task => task.status === 'done' && !task.queued));
  assert.equal(c.app.store.leases().length, 0);
  assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001'] })).status, 400);
});

test('BOM review JSON stops queued work; explicit bounded retry preserves failed evidence and accepted inputs', async t => {
  const c = await setup(t);
  for (const id of ['W-03', 'W-07'])
    await c.request('/api/workers/' + id, { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
  await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001'] });
  await c.wait('D-001', 'review');
  await c.request('/api/tasks/D-001/accept');
  const source = c.app.store.attempt(c.app.store.task('D-001').acceptedAttemptId);
  const sourceBytes = fs.readFileSync(path.join(source.outputFolder, 'layout.json'));
  const review = await c.create('BOM review', 'W-07', { kind: 'review', dependencies: ['D-001'] });
  await c.request('/api/pipeline', { action: 'queue', taskIds: [review.id] });
  await c.wait(review.id, 'failed');
  const failed = c.app.store.attempts(review.id)[0],
    failedBytes = fs.readFileSync(path.join(failed.outputFolder, 'review.json'));
  assert.deepEqual([...failedBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(failed.error, /JSON|Unexpected token/);
  c.app.runner.autonomy.attention(c.app.store.task(review.id), failed.error);
  assert.match(failed.instructions.text, /Write JSON artifacts as UTF-8 without BOM/);
  assert.equal(c.app.store.task(review.id).queued, false);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal((await c.request(`/api/tasks/${review.id}/accept`)).status, 400);
  assert.equal(c.app.store.task(review.id).autonomyNote, failed.error);
  assert.equal(c.app.store.task(review.id).reason, failed.error);
  await c.request('/api/control', { paused: false });
  assert.equal(c.app.store.attempts(review.id).length, 1, 'A parsing failure does not authorize another attempt.');
  await c.request(
    `/api/tasks/${review.id}`,
    { direction: 'Write UTF-8 without BOM; preserve accepted source bytes.' },
    'PATCH',
  );
  await c.request('/api/pipeline', { action: 'queue', taskIds: [review.id] });
  await c.until(() => c.app.store.attempts(review.id).length === 2);
  await c.wait(review.id, 'review');
  assert.equal(c.app.store.task(review.id).autonomyNote, undefined);
  assert.equal(c.app.store.task(review.id).reason, '');
  const current = c.app.store.attempts(review.id)[1];
  assert.notEqual(current.outputFolder, failed.outputFolder);
  assert.equal(current.reviewVerdict, 'pass');
  assert.equal(current.inputReferences[0].attemptId, source.id);
  assert.match(current.instructions.text, /preserve accepted source bytes/);
  assert.deepEqual(fs.readFileSync(path.join(failed.outputFolder, 'review.json')), failedBytes);
  assert.equal(c.app.store.attempt(failed.id).instructions.hash, failed.instructions.hash);
  assert.deepEqual(fs.readFileSync(path.join(source.outputFolder, 'layout.json')), sourceBytes);
  assert.equal((await c.request(`/api/tasks/${review.id}/accept`)).status, 200);
  assert.equal(c.app.store.leases().length, 0);
});

test('queued dispatch respects pause, atomic slots/resources, and cancellation without replay', async t => {
  const c = await setup(t);
  const resource = await c.create('Waiting for shared layout resource', 'W-04', { resources: ['layout:prototype'] });
  const employee = await c.create('Waiting for Rowan', 'W-03');
  const independent = await c.create('Independent work', 'W-02');
  await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001', resource.id, employee.id, independent.id] });
  await c.until(() => c.app.runner.active.size === 2);
  assert.equal(c.app.store.attempts(resource.id).length, 0);
  assert.equal(c.app.store.attempts(employee.id).length, 0);
  assert.equal(c.app.store.leases().filter(lease => lease.resource === 'layout:prototype').length, 1);
  await c.request('/api/control', { paused: true });
  await c.request('/api/tasks/D-001/cancel');
  await c.wait('D-001', 'cancelled');
  await c.wait(independent.id, 'review');
  assert.equal(c.app.store.task('D-001').queued, false);
  assert.equal(c.app.store.attempts(resource.id).length, 0);
  assert.equal(c.app.store.leases().length, 0);
  await c.request('/api/control', { paused: false });
  await c.until(() => c.app.store.attempts(resource.id).length === 1 && c.app.store.attempts(employee.id).length === 1);
  await c.wait(resource.id, 'review');
  await c.wait(employee.id, 'review');
  assert.equal(c.app.store.attempts('D-001').length, 1, 'Cancellation does not authorize another attempt.');
  assert.equal(c.app.store.leases().length, 0);
  await c.request('/api/pipeline', { action: 'pause' });
  await c.request(`/api/tasks/${employee.id}/revise`, { direction: 'Bounded revision while pipeline paused.' });
  assert.equal(c.app.store.attempts(employee.id).length, 1);
  await c.request('/api/pipeline', { action: 'resume' });
  await c.until(() => c.app.store.attempts(employee.id).length === 2);
  await c.wait(employee.id, 'review');
});

function conflictFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-conflict-')),
    app = createStudio({ directory, port: 0 }),
    { store, runner } = app,
    org = store.organization();
  org.maxParallel = 10;
  org.workers.find(worker => worker.id === 'W-02').displayName = 'Eli';
  store.setOrganization(org);
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const task = (id, workerId, resources = []) => ({
    ...store.task('D-001'),
    id,
    title: id === 'T-holder' ? 'Preserve idea drafts' : 'Waiting work',
    kind: 'general',
    workerId,
    team: org.workers.find(worker => worker.id === workerId).team,
    dependencies: [],
    resources,
    status: 'ready',
    queued: true,
  });
  store.putTask({ ...task('T-holder', 'W-02'), status: 'running' });
  const owner = 'attempt-holding-edit';
  store.insertAttempt(
    { id: owner, taskId: 'T-holder', workerId: 'W-02', status: 'running', assignment: store.task('T-holder') },
    { text: 'Fixture instructions' },
  );
  return { store, runner, task, owner, app, directory };
}

test('retry and start resolve current failure attention while retaining original attempt evidence', async t => {
  const { store, runner, owner } = conflictFixture(t),
    failed = store.attempt(owner);
  Object.assign(failed, { status: 'failed', error: 'Original fixture failure.' });
  store.updateAttempt(failed);
  store.putTask({
    ...store.task('T-holder'),
    status: 'failed',
    lastAttemptId: owner,
    reason: failed.error,
    autonomyNote: failed.error,
    queued: false,
  });
  runner.autonomy.retry(store.task('T-holder'), failed.error, { revision: 1, retries: 1 });
  assert.equal(store.task('T-holder').autonomyNote, undefined);
  assert.equal(store.task('T-holder').reason, '');
  assert.equal(store.task('T-holder').autoRetries, 1);
  runner.autonomy.attention(store.task('T-holder'), 'Check the previous attempt.');
  runner.start('T-holder');
  assert.equal(store.task('T-holder').autonomyNote, undefined);
  assert.equal(store.task('T-holder').reason, '');
  await waitFor(() => store.task('T-holder').status !== 'running', 'task T-holder to stop running', { interval: 10 });
  assert.equal(store.task('T-holder').status, 'review');
  runner.autonomy.attention(store.task('T-holder'), 'Inspect this result.');
  acceptAttempt(store, runner.registries, store.task('T-holder'));
  assert.equal(store.task('T-holder').autonomyNote, undefined);
  assert.equal(store.task('T-holder').reason, '');
  assert.equal(store.attempt(owner).error, failed.error);
  assert.equal(store.attempt(owner).instructions.text, 'Fixture instructions');
});

test('reconciliation clears interruption attention and retains an unresolved hold', t => {
  const { store, runner, owner } = conflictFixture(t);
  store.putTask({ ...store.task('T-holder'), hold: true, lastAttemptId: owner, autonomyNote: 'Earlier failure.' });
  store.claim(['employee:W-02'], owner);
  const restarted = new Runner(store, { registries: runner.registries });
  const interrupted = store.task('T-holder');
  assert.match(interrupted.reason, /Reconcile the previous attempt/);
  assert.equal(interrupted.autonomyNote, interrupted.reason);
  assert.throws(() => restarted.pipeline('queue', ['T-holder']), /Reconcile interrupted work/);
  assert.equal(store.task('T-holder').autonomyNote, interrupted.reason);
  restarted.reconcile('T-holder');
  restarted.refreshReadiness();
  assert.equal(store.task('T-holder').autonomyNote, undefined);
  assert.equal(store.task('T-holder').reason, 'Assignment is deliberately on hold.');
  assert.equal(store.leases().length, 0);
  assert.ok(store.attempt(owner).reconciledAt);
});

test('reconciliation preserves retained general work before releasing ownership without replay or acceptance', t => {
  const { store, runner, owner } = conflictFixture(t),
    a = store.attempt(owner);
  a.assignment.kind = 'general:work';
  a.status = 'quarantined';
  a.pid = 12345;
  store.updateAttempt(a);
  store.putTask({ ...store.task('T-holder'), status: 'blocked' });
  const job = jobDirectory(store, a),
    output = path.join(job, 'output');
  fs.mkdirSync(path.join(output, 'draft'), { recursive: true });
  fs.writeFileSync(path.join(output, 'draft/notes.md'), 'Work retained across restart.\n');
  fs.writeFileSync(path.join(output, 'AGENTS.md'), 'Protected instructions, excluded.');
  store.claim(['employee:W-02'], owner);
  const restarted = new Runner(store, { registries: runner.registries });
  assert.equal(fs.existsSync(path.join(job, 'continuation')), false);
  assert.throws(() => restarted.pipeline('queue', ['T-holder']), /Reconcile/);
  assert.equal(store.leases().length, 1);
  const kill = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('Unknown process'), { code: 'EPERM' });
  });
  assert.throws(() => restarted.reconcile('T-holder'), /live process/);
  assert.equal(fs.existsSync(path.join(job, 'continuation')), false);
  assert.equal(store.leases().length, 1);
  kill.mock.restore();
  a.pid = null;
  store.updateAttempt(a);
  restarted.reconcile('T-holder');
  const checkpoint = readContinuation(store, store.attempt(owner));
  assert.equal(checkpoint.status, 'complete', JSON.stringify(checkpoint));
  assert.deepEqual(
    checkpoint.files.map(item => item.path),
    ['draft/notes.md'],
  );
  assert.equal(
    fs.readFileSync(path.join(job, 'continuation/files/draft/notes.md'), 'utf8'),
    'Work retained across restart.\n',
  );
  assert.equal(checkpoint.terminal.status, 'interrupted');
  assert.equal(store.leases().length, 0);
  assert.equal(store.attempts('T-holder').length, 1);
  assert.equal(store.task('T-holder').acceptedAttemptId, undefined);
  assert.equal(store.attempt(owner).instructions.text, 'Fixture instructions');
});

test('employee and resource waits name the holder in readiness, starts and transactional claims', async t => {
  for (const resource of ['employee:W-02', 'layout:prototype']) {
    await t.test(resource, t => {
      const { store, runner, task, owner } = conflictFixture(t),
        id = 'T-waiting',
        reason = "Waiting for Eli's work on T-holder (Preserve idea drafts) to finish.";
      const directorStart = { at: 'fixture-director-queued' };
      store.putTask({
        ...task(id, resource.startsWith('employee:') ? 'W-02' : 'W-04', ['aaa:unclaimed', resource]),
        directorStart,
      });
      store.tx(() => store.claim(['employee:W-02', 'layout:prototype'], owner));
      const leases = store.leases();
      runner.refreshReadiness();
      assert.equal(store.task(id).reason, reason);
      assert.equal(store.task(id).status, 'blocked');
      assert.equal(store.task(id).queued, true);
      const events = () => store.events().filter(event => event.task_id === id && event.kind === 'resource_conflict');
      assert.equal(events()[0].message, `${reason} [${resource} held by ${owner}]`);
      assert.equal(store.state().events.find(event => event.seq === events()[0].seq).message, events()[0].message);
      runner.refreshReadiness();
      assert.equal(events().length, 1, 'An unchanged wait does not flood the event history.');
      assert.throws(
        () => store.tx(() => store.claim(['aaa:unclaimed', resource], 'attempt-refused-claim')),
        error => {
          assert.equal(error.message, reason);
          assert.deepEqual(error.conflict, { reason, resource, ownerAttemptId: owner });
          return true;
        },
      );
      assert.throws(() => runner.start(id), { message: reason });
      assert.equal(events()[1].message, `${reason} [${resource} held by ${owner}]`);
      assert.deepEqual(store.leases(), leases, 'A refused claim rolls back even resources sorted before the conflict.');
      assert.equal(store.attempts(id).length, 0);
      assert.equal(store.task(id).queued, true);
      assert.deepEqual(store.task(id).directorStart, directorStart);
      assert.ok(!store.task(id).reason.includes(resource));
      assert.ok(!store.task(id).reason.includes(owner));
      store.release(owner);
      runner.refreshReadiness();
      assert.equal(store.task(id).status, 'ready');
      assert.equal(store.task(id).reason, '');
      assert.equal(store.task(id).queued, true);
      assert.equal(store.leases().length, 0);
    });
  }
});

test('incomplete holding records keep useful waits and retain their lease until release', async t => {
  for (const missing of ['attempt', 'task', 'employee', 'employee identity', 'display name', 'blank display name']) {
    await t.test(missing, t => {
      const { store, runner, task, owner } = conflictFixture(t),
        resource = 'layout:prototype',
        reason = ['attempt', 'task'].includes(missing)
          ? `Waiting for resource ${resource} to become available.`
          : 'Waiting for work on T-holder (Preserve idea drafts) to finish.',
        id = 'T-waiting';
      if (missing === 'attempt') store.db.prepare('DELETE FROM attempts WHERE id=?').run(owner);
      else if (missing === 'task') store.db.prepare('DELETE FROM tasks WHERE id=?').run('T-holder');
      else if (missing === 'employee') {
        const org = store.organization();
        org.workers = org.workers.filter(worker => worker.id !== 'W-02');
        store.setOrganization(org);
      } else if (missing === 'employee identity') {
        const attempt = store.attempt(owner);
        delete attempt.workerId;
        store.updateAttempt(attempt);
      } else {
        const org = store.organization();
        const worker = org.workers.find(worker => worker.id === 'W-02');
        if (missing === 'blank display name') worker.displayName = '   ';
        else delete worker.displayName;
        store.setOrganization(org);
      }
      store.putTask(task(id, 'W-04', ['aaa:unclaimed', resource]));
      store.claim([resource], owner);
      const leases = store.leases();
      runner.refreshReadiness();
      assert.equal(store.task(id).reason, reason);
      assert.ok(!reason.includes(owner));
      assert.ok(!reason.includes('undefined'));
      assert.throws(() => runner.start(id), { message: reason });
      assert.deepEqual(store.leases(), leases);
      assert.equal(store.task(id).queued, true);
      assert.equal(store.attempts(id).length, 0);
      const events = store.events().filter(event => event.task_id === id && event.kind === 'resource_conflict');
      assert.equal(events.length, 2);
      for (const event of events) assert.equal(event.message, `${reason} [${resource} held by ${owner}]`);
      store.release(owner);
      runner.refreshReadiness();
      assert.equal(store.task(id).status, 'ready');
      assert.equal(store.task(id).queued, true);
    });
  }
});

test('a changed lease owner is recorded even when its readable waiting reason stays the same', t => {
  const { store, runner, task, owner } = conflictFixture(t),
    id = 'T-waiting',
    resource = 'layout:prototype',
    nextOwner = 'attempt-next-edit';
  store.putTask(task(id, 'W-04', [resource]));
  store.claim([resource], owner);
  runner.refreshReadiness();
  const reason = store.task(id).reason;
  const events = () =>
    store.db.prepare("SELECT message FROM events WHERE kind='resource_conflict' AND task_id=? ORDER BY seq").all(id);
  for (let index = 0; index < 160; index++) store.event('fixture_activity', null, null, 'Unrelated history');
  runner.refreshReadiness();
  assert.equal(events().length, 1, 'Unchanged waits do not repeat when older events leave the dashboard window.');
  store.insertAttempt({ ...store.attempt(owner), id: nextOwner }, { text: 'Next fixture attempt' });
  store.tx(() => {
    store.release(owner);
    store.claim([resource], nextOwner);
  });
  runner.refreshReadiness();
  assert.equal(store.task(id).reason, reason);
  assert.deepEqual(
    events().map(event => event.message),
    [owner, nextOwner].map(holder => `${reason} [${resource} held by ${holder}]`),
  );
  assert.equal(store.leases()[0].attemptId, nextOwner);
  runner.refreshReadiness();
  assert.equal(events().length, 2);
});

test('readable and legacy waits deduplicate persisted history across reopen and distinguish resources', async t => {
  for (const legacy of [false, true]) {
    await t.test(legacy ? 'legacy JSON' : 'readable text', async t => {
      const { store, runner, task, owner, app, directory } = conflictFixture(t),
        id = 'T-waiting',
        resource = 'layout:prototype',
        nextResource = 'layout:another',
        nextOwner = 'attempt-next-edit',
        reason = "Waiting for Eli's work on T-holder (Preserve idea drafts) to finish.";
      store.putTask({ ...task(id, 'W-04', [resource]), status: 'blocked', reason, controllerWait: true });
      store.claim([resource], owner);
      const original = legacy
        ? JSON.stringify({ ownerAttemptId: owner, resource, reason })
        : `${reason} [${resource} held by ${owner}]`;
      store.event('resource_conflict', id, null, original);
      const events = current =>
        current.db
          .prepare("SELECT message FROM events WHERE kind='resource_conflict' AND task_id=? ORDER BY seq")
          .all(id)
          .map(event => event.message);
      runner.refreshReadiness();
      assert.deepEqual(events(store), [original], 'The same wait preserves the original persisted message.');
      for (let index = 0; index < 160; index++) store.event('fixture_activity', id, null, 'Unrelated history');
      assert.ok(!store.events().some(event => event.kind === 'resource_conflict'));
      runner.refreshReadiness();
      assert.deepEqual(events(store), [original], 'Deduplication is independent of the dashboard window.');

      await app.close();
      const reopened = new Store(directory);
      try {
        reopened.recordResourceConflict(id, reopened.resourceConflict(resource, owner));
        assert.deepEqual(events(reopened), [original], 'Reopening retains canonical and legacy wait identity.');
        reopened.insertAttempt({ ...reopened.attempt(owner), id: nextOwner }, { text: 'Next fixture attempt' });
        reopened.tx(() => {
          reopened.release(owner);
          reopened.claim([resource, nextResource], nextOwner);
        });
        const conflict = reopened.resourceConflict(resource, nextOwner);
        assert.equal(conflict.reason, reason);
        reopened.recordResourceConflict(id, conflict);
        reopened.recordResourceConflict(id, conflict);
        const nextMessage = `${reason} [${resource} held by ${nextOwner}]`;
        assert.deepEqual(events(reopened), [original, nextMessage]);
        const changedResource = reopened.resourceConflict(nextResource, nextOwner);
        assert.equal(changedResource.reason, reason);
        reopened.recordResourceConflict(id, changedResource);
        reopened.recordResourceConflict(id, changedResource);
        assert.deepEqual(events(reopened), [original, nextMessage, `${reason} [${nextResource} held by ${nextOwner}]`]);
        reopened.recordResourceConflict(id, conflict);
        assert.equal(events(reopened).length, 4, 'Only the latest relevant conflict suppresses a repeated wait.');
        reopened.release(nextOwner);
        assert.equal(reopened.leases().length, 0);
      } finally {
        reopened.close();
      }
    });
  }
});

test('queued native failures stop retries and preserve subscription holds and attempt limits', async t => {
  const c = await setup(t);
  await c.request('/api/workers/W-03', { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
  const oldAuth = process.env.STUDIO_FIXTURE_AUTH;
  t.after(() => {
    if (oldAuth === undefined) delete process.env.STUDIO_FIXTURE_AUTH;
    else process.env.STUDIO_FIXTURE_AUTH = oldAuth;
  });
  process.env.STUDIO_FIXTURE_AUTH = 'api';
  await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001'] });
  await c.until(() => !c.app.store.task('D-001').queued);
  assert.equal(c.app.store.attempts('D-001').length, 0);
  delete process.env.STUDIO_FIXTURE_AUTH;
  const invalid = await c.create('Disconnected route', 'W-03', { kind: 'layout' });
  await c.request('/api/pipeline', { action: 'queue', taskIds: [invalid.id] });
  await c.wait(invalid.id, 'failed');
  assert.equal(c.app.store.task(invalid.id).queued, false);
  await c.request('/api/control', { paused: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.attempts(invalid.id).length, 1);
  const quota = await c.create('Quota limit', 'W-03');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [quota.id] });
  await c.wait(quota.id, 'blocked');
  assert.equal(c.app.store.organization().quota.codex, true);
  assert.equal(c.app.store.task(quota.id).queued, false);
  const held = await c.create('Wait for subscription', 'W-03');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [held.id] });
  await c.until(() => c.app.store.task(held.id).status === 'blocked');
  assert.equal(c.app.store.attempts(held.id).length, 0);
  await c.request('/api/control', { clearQuota: 'codex' });
  await c.wait(held.id, 'review');
  for (const direction of ['Second attempt', 'Final attempt']) {
    const before = c.app.store.attempts(held.id).length;
    await c.request(`/api/tasks/${held.id}/revise`, { direction });
    await c.until(() => c.app.store.attempts(held.id).length > before);
    await c.wait(held.id, 'review');
  }
  // At the limit a revision is recorded, but automatic dispatch stops and waits for the director.
  assert.equal(
    (await c.request(`/api/tasks/${held.id}/revise`, { direction: 'Fourth attempt needs the director' })).status,
    200,
  );
  await c.wait(held.id, 'blocked');
  assert.match(c.app.store.task(held.id).reason, /limit for automatic runs. Press Start/);
  assert.equal(c.app.store.attempts(held.id).length, 3);
});

// A usage limit whose message names its reset time clears itself then. The fixture's 'Quota soon'
// names one a few seconds ahead and limits only its task's first run ('twice': its first two).
const holdWait = /^Waiting for the Codex usage limit to reset at \d{1,2}:\d{2} [AP]M( on \w{3} \d{1,2})?\.$/,
  selfCleared =
    /^Codex hold cleared itself at its reset time, \d{1,2}:\d{2} [AP]M( on \w{3} \d{1,2})?, read from the CLI's message\. Actual provider availability is not inferred\.$/;
// Read from the records, beyond the dashboard's window of recent events.
const controlEvents = c =>
  c.app.store.db
    .prepare("SELECT message FROM events WHERE kind='control' ORDER BY seq")
    .all()
    .map(event => event.message);
const onCodex = c => c.request('/api/workers/W-03', { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');

test('queued work a usage limit stopped starts again by itself once the hold clears at its named reset time', async t => {
  const c = await setup(t);
  await onCodex(c);
  const task = await c.create('Quota soon', 'W-03');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'blocked');
  const [stopped] = c.app.store.attempts(task.id),
    waiting = c.app.store.task(task.id),
    held = c.app.store.organization();
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.subscriptionHold, 'codex');
  assert.ok(Date.parse(stopped.subscriptionReset) > Date.parse(stopped.startedAt));
  assert.equal(held.quota.codex, true);
  assert.equal(held.quotaResets.codex, stopped.subscriptionReset);
  assert.equal(held.quotaResetSources.codex, 'message');
  // It stays queued and waits on the hold, as it would for a slot.
  assert.equal(waiting.queued, true);
  assert.equal(waiting.controllerWait, true);
  assert.match(waiting.reason, holdWait);
  assert.equal(held.pipelineEnabled, true);
  await c.wait(task.id, 'review');
  const attempts = c.app.store.attempts(task.id),
    cleared = c.app.store.organization();
  assert.equal(attempts.length, 2);
  assert.ok(Date.parse(attempts[1].startedAt) >= Date.parse(stopped.subscriptionReset));
  assert.equal(cleared.quota.codex, false);
  assert.equal(Object.hasOwn(cleared.quotaResets, 'codex'), false);
  assert.equal(Object.hasOwn(cleared.quotaResetSources, 'codex'), false);
  assert.equal(controlEvents(c).filter(message => selfCleared.test(message)).length, 1);
  assert.ok(!controlEvents(c).some(message => /cleared by director/.test(message)), 'No director request was made.');
});

test('a rerun the limit stops again records its later reset and waits again; neither stopped attempt counts', async t => {
  const c = await setup(t);
  await onCodex(c);
  const task = await c.create('Quota soon twice', 'W-03'),
    stored = c.app.store.task(task.id);
  // One attempt: a stopped attempt that counted would leave no automatic rerun.
  stored.maxAttempts = 1;
  c.app.store.putTask(stored);
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.until(
    () => c.app.store.attempts(task.id).length === 2 && c.app.store.task(task.id).status === 'blocked',
    'the second limit',
  );
  const [first, second] = c.app.store.attempts(task.id),
    held = c.app.store.organization(),
    waiting = c.app.store.task(task.id);
  assert.deepEqual(
    [first, second].map(a => [a.status, a.subscriptionHold]),
    Array(2).fill(['blocked', 'codex']),
  );
  assert.ok(Date.parse(second.startedAt) >= Date.parse(first.subscriptionReset));
  assert.ok(Date.parse(second.subscriptionReset) > Date.parse(first.subscriptionReset));
  assert.equal(held.quota.codex, true);
  assert.equal(held.quotaResets.codex, second.subscriptionReset);
  assert.equal(waiting.queued, true);
  assert.match(waiting.reason, holdWait);
  assert.equal(c.app.runner.registries.workflows.stageAttempts(c.app.store, waiting).length, 0);
  await c.wait(task.id, 'review');
  const attempts = c.app.store.attempts(task.id);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[2].directorOverride, undefined);
  assert.deepEqual(
    c.app.runner.registries.workflows.stageAttempts(c.app.store, c.app.store.task(task.id)).map(a => a.id),
    [attempts[2].id],
  );
  assert.equal(controlEvents(c).filter(message => selfCleared.test(message)).length, 2);
});

test('a hold with no readable reset time stays set and its work is not queued again until the director clears it', async t => {
  const c = await setup(t);
  await onCodex(c);
  const task = await c.create('Quota limit', 'W-03');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'blocked');
  // Past the time a readable 'Quota soon' reset would have cleared.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const held = c.app.store.organization(),
    stopped = c.app.store.task(task.id);
  assert.equal(held.quota.codex, true);
  assert.equal(Object.hasOwn(held.quotaResets, 'codex'), false);
  assert.equal(c.app.runner.quotaTimer, null);
  assert.equal(stopped.queued, false);
  assert.doesNotMatch(stopped.reason, /^Waiting for /);
  assert.equal(c.app.store.attempts(task.id).length, 1);
  assert.ok(!controlEvents(c).some(message => /cleared itself/.test(message)));
  const other = await c.create('Wait for subscription', 'W-03'),
    refused = await c.request(`/api/tasks/${other.id}/start`);
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'This CLI has a subscription hold. Clear it when usable again.');
  assert.equal((await c.request('/api/control', { clearQuota: 'codex' })).status, 200);
  assert.equal(c.app.store.organization().quota.codex, false);
  assert.ok(controlEvents(c).includes('Codex hold cleared by director. Actual provider availability is not inferred.'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.attempts(task.id).length, 1, 'Clearing the hold does not start the stopped work.');
});

test('a Codex hold never stops a Claude employee, and clearing itself leaves the Claude hold set', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onCodex(c);
  await c.request('/api/workers/W-02', { provider: 'claude', model: '', mode: 'text', expectedVersion: 1 }, 'PATCH');
  const limited = await c.create('Quota soon', 'W-03', { brief: 'Reset in 4 seconds.' });
  await c.request('/api/pipeline', { action: 'queue', taskIds: [limited.id] });
  await c.wait(limited.id, 'blocked');
  const codexReset = c.app.store.organization().quotaResets.codex,
    other = await c.create('Claude work', 'W-02');
  assert.equal((await c.request(`/api/tasks/${other.id}/start`)).status, 202);
  await c.wait(other.id, 'review');
  const [claude] = c.app.store.attempts(other.id);
  assert.equal(claude.provider, 'claude');
  assert.ok(Date.parse(claude.startedAt) < Date.parse(codexReset), 'The Claude work started while Codex was held.');
  // A Claude hold with a later reset time is a separate hold.
  const later = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    org = c.app.store.organization();
  org.quota.claude = true;
  org.quotaResets.claude = later;
  c.app.store.setOrganization(org);
  await c.wait(limited.id, 'review');
  const after = c.app.store.organization();
  assert.equal(after.quota.codex, false);
  assert.equal(Object.hasOwn(after.quotaResets, 'codex'), false);
  assert.equal(after.quota.claude, true);
  assert.equal(after.quotaResets.claude, later);
  assert.ok(!controlEvents(c).some(message => /^Claude hold/.test(message)));
  assert.ok(c.app.runner.quotaTimer, 'The timer now waits for the Claude reset.');
});

test('a director Start while a hold names its reset time queues the work, which starts once the hold clears', async t => {
  const c = await setup(t);
  await onCodex(c);
  const limited = await c.create('Quota soon', 'W-03', { brief: 'Reset in 3 seconds.' });
  // Started directly rather than queued, the stopped work waits for the director as before.
  assert.equal((await c.request(`/api/tasks/${limited.id}/start`)).status, 202);
  await c.wait(limited.id, 'blocked');
  assert.equal(c.app.store.task(limited.id).queued, false);
  const held = await c.create('Wait for the reset', 'W-03'),
    started = await c.request(`/api/tasks/${held.id}/start`);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(started.data.queued, true);
  assert.match(started.data.reason, holdWait);
  assert.equal(c.app.store.attempts(held.id).length, 0);
  assert.ok(c.app.store.task(held.id).directorStart);
  await c.wait(held.id, 'review');
  const [stopped] = c.app.store.attempts(limited.id);
  assert.ok(Date.parse(c.app.store.attempts(held.id)[0].startedAt) >= Date.parse(stopped.subscriptionReset));
  assert.equal(c.app.store.task(limited.id).status, 'blocked');
  assert.equal(c.app.store.attempts(limited.id).length, 1);
});

test('a hold whose reset time passed while the controller was stopped clears when it starts', async t => {
  const c = await setup(t);
  await onCodex(c);
  const task = await c.create('Quota soon', 'W-03', { brief: 'Reset in 300 seconds.' });
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'blocked');
  assert.equal(c.app.store.task(task.id).queued, true);
  assert.ok(c.app.runner.quotaTimer, 'The timer waits for the recorded reset.');
  // A Claude hold with no recorded time, which startup leaves alone.
  const org = c.app.store.organization();
  org.quota.claude = true;
  c.app.store.setOrganization(org);
  const runner = c.app.runner;
  await c.app.close();
  assert.equal(runner.quotaTimer, null, 'Closing the controller clears its timer.');
  // The recorded reset passes while the controller is stopped.
  const stopped = new Store(c.directory),
    recorded = stopped.organization();
  assert.equal(recorded.quota.codex, true);
  assert.equal(recorded.quotaResetSources.codex, 'message');
  recorded.quotaResets.codex = new Date(Date.now() - 60 * 1000).toISOString();
  stopped.setOrganization(recorded);
  stopped.close();
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { codexBinary: fixture } });
  await c.connect();
  const restarted = c.app.store.organization();
  assert.equal(restarted.quota.codex, false);
  assert.equal(Object.hasOwn(restarted.quotaResets, 'codex'), false);
  assert.equal(Object.hasOwn(restarted.quotaResetSources, 'codex'), false);
  assert.equal(restarted.quota.claude, true);
  assert.equal(c.app.runner.quotaTimer, null);
  assert.equal(controlEvents(c).filter(message => selfCleared.test(message)).length, 1);
  // A restart still pauses the queue; resuming it starts the work with no hold to clear.
  assert.equal(restarted.pipelineEnabled, false);
  assert.equal(c.app.store.task(task.id).queued, true);
  await c.request('/api/pipeline', { action: 'resume' });
  await c.wait(task.id, 'review');
  assert.equal(c.app.store.attempts(task.id).length, 2);
});

// Claude Code reports each usage limit in a rate_limit_event; a reached limit ('rejected') names its reset
// time, which comes before the one its message names. The stand-in's cases are described in
// test/fixture-claude.mjs; each limits only its task's first run.
const claudeWait = /^Waiting for the Claude usage limit to reset at \d{1,2}:\d{2} [AP]M( on \w{3} \d{1,2})?\.$/,
  // The self-clearing event names where the hold's reset time came from.
  reportCleared =
    /^Claude hold cleared itself at its reset time, \d{1,2}:\d{2} [AP]M( on \w{3} \d{1,2})?, from the CLI's own report\. Actual provider availability is not inferred\.$/,
  messageCleared =
    /^Claude hold cleared itself at its reset time, \d{1,2}:\d{2} [AP]M( on \w{3} \d{1,2})?, read from the CLI's message\. Actual provider availability is not inferred\.$/,
  readFromMessage = /read from the CLI's message/;
// Reset times stay ISO strings beside their recorded sources.
const isoResets = org =>
  Object.values(org.quotaResets || {}).every(
    at => typeof at === 'string' && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at,
  );
const onClaude = c =>
  c.request('/api/workers/W-02', { provider: 'claude', model: '', mode: 'text', expectedVersion: 1 }, 'PATCH');
// The rate_limit_event reports an attempt's recorded output carries, in order.
const rateLimitReports = (c, attempt) =>
  c.app.store
    .events(attempt.id)
    .filter(event => event.kind === 'log' && event.message.startsWith('stdout: {"type":"rate_limit_event"'))
    .map(event => JSON.parse(event.message.slice('stdout: '.length)).rate_limit_info);
const epochTime = seconds => new Date(seconds * 1000).toISOString();

test('a Claude hold uses the reset time Claude Code reports for the reached limit, and queued work starts again then', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onClaude(c);
  const task = await c.create('Limit reported soon', 'W-02'),
    stored = c.app.store.task(task.id);
  // One attempt: a stopped attempt that counted would leave no automatic rerun.
  stored.maxAttempts = 1;
  c.app.store.putTask(stored);
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'blocked');
  const [stopped] = c.app.store.attempts(task.id),
    waiting = c.app.store.task(task.id),
    held = c.app.store.organization(),
    reports = rateLimitReports(c, stopped),
    [earlier, later] = reports.filter(report => report.status === 'rejected'),
    notReached = reports.find(report => report.status === 'allowed'),
    reset = epochTime(later.resetsAt);
  // Two limits reached and one not; the hold waits for the later reached one, not the later unreached one.
  assert.equal(reports.length, 3);
  assert.ok(later.resetsAt > earlier.resetsAt);
  assert.ok(notReached.resetsAt > later.resetsAt);
  // The message names no time.
  assert.equal(stopped.error, 'rate_limit: You have hit your limit');
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.subscriptionHold, 'claude');
  assert.equal(stopped.subscriptionReset, reset);
  assert.equal(held.quota.claude, true);
  assert.equal(held.quotaResets.claude, reset);
  assert.equal(held.quotaResetSources.claude, 'report');
  assert.ok(isoResets(held));
  assert.equal(waiting.queued, true);
  assert.equal(waiting.controllerWait, true);
  assert.match(waiting.reason, claudeWait);
  await c.wait(task.id, 'review');
  const attempts = c.app.store.attempts(task.id),
    cleared = c.app.store.organization();
  assert.equal(attempts.length, 2);
  assert.ok(Date.parse(attempts[1].startedAt) >= Date.parse(reset));
  assert.equal(cleared.quota.claude, false);
  assert.equal(Object.hasOwn(cleared.quotaResets, 'claude'), false);
  assert.equal(Object.hasOwn(cleared.quotaResetSources, 'claude'), false);
  assert.ok(isoResets(cleared));
  assert.equal(controlEvents(c).filter(message => reportCleared.test(message)).length, 1);
  assert.ok(!controlEvents(c).some(message => readFromMessage.test(message)), 'The time came from the report.');
  assert.ok(!controlEvents(c).some(message => /cleared by director/.test(message)), 'No director request was made.');
});

test('a Claude hold with no reported reset uses the reset time its limit message names', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onClaude(c);
  const task = await c.create('Limit message soon', 'W-02');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'blocked');
  const [stopped] = c.app.store.attempts(task.id),
    held = c.app.store.organization(),
    named = epochTime(Number(stopped.error.match(/^Claude AI usage limit reached\|(\d+)$/)[1]));
  assert.deepEqual(rateLimitReports(c, stopped), []);
  assert.equal(stopped.subscriptionHold, 'claude');
  assert.equal(stopped.subscriptionReset, named);
  assert.equal(held.quota.claude, true);
  assert.equal(held.quotaResets.claude, named);
  assert.equal(held.quotaResetSources.claude, 'message');
  assert.match(c.app.store.task(task.id).reason, claudeWait);
  await c.wait(task.id, 'review');
  const cleared = c.app.store.organization();
  assert.equal(c.app.store.attempts(task.id).length, 2);
  assert.equal(Object.hasOwn(cleared.quotaResetSources, 'claude'), false);
  assert.equal(controlEvents(c).filter(message => messageCleared.test(message)).length, 1);
  assert.ok(!controlEvents(c).some(message => reportCleared.test(message)));
});

test('the director clearing a hold removes its reset time and the recorded source of that time', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onClaude(c);
  // Started directly and far from its reset, so only the director clears it.
  const task = await c.create('Limit reported soon', 'W-02', { brief: 'Reset in 300 seconds.' });
  assert.equal((await c.request(`/api/tasks/${task.id}/start`)).status, 202);
  await c.wait(task.id, 'blocked');
  const [stopped] = c.app.store.attempts(task.id),
    held = c.app.store.organization();
  assert.equal(held.quotaResets.claude, stopped.subscriptionReset);
  assert.equal(held.quotaResetSources.claude, 'report');
  assert.equal((await c.request('/api/control', { clearQuota: 'claude' })).status, 200);
  const cleared = c.app.store.organization();
  assert.equal(cleared.quota.claude, false);
  assert.equal(Object.hasOwn(cleared.quotaResets, 'claude'), false);
  assert.equal(Object.hasOwn(cleared.quotaResetSources, 'claude'), false);
  assert.ok(isoResets(cleared));
  assert.equal(c.app.runner.quotaTimer, null);
  assert.ok(
    controlEvents(c).includes('Claude hold cleared by director. Actual provider availability is not inferred.'),
  );
  assert.ok(!controlEvents(c).some(message => /cleared itself/.test(message)));
});

// A hold recorded before reset-time sources were kept has a time and no source; its event claims none.
const sourceFreeCleared =
  /^Claude hold cleared itself at its reset time, \d{1,2}:\d{2} [AP]M( on \w{3} \d{1,2})?\. Actual provider availability is not inferred\.$/;

test('a hold with a reset time and no recorded source clears itself without naming a source, also at startup', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  const org = c.app.store.organization();
  org.quota.claude = true;
  org.quotaResets = { ...org.quotaResets, claude: new Date(Date.now() + 200).toISOString() };
  c.app.store.setOrganization(org);
  c.app.runner.armQuotaTimer();
  await c.until(() => c.app.store.organization().quota.claude === false, 'the hold clearing itself');
  const cleared = c.app.store.organization();
  assert.equal(Object.hasOwn(cleared.quotaResets, 'claude'), false);
  assert.equal(Object.hasOwn(cleared.quotaResetSources || {}, 'claude'), false);
  assert.equal(controlEvents(c).filter(message => sourceFreeCleared.test(message)).length, 1);
  // The same record whose time passed while the controller was stopped clears when it starts.
  await c.app.close();
  const stopped = new Store(c.directory),
    recorded = stopped.organization();
  recorded.quota.claude = true;
  recorded.quotaResets.claude = new Date(Date.now() - 60 * 1000).toISOString();
  stopped.setOrganization(recorded);
  stopped.close();
  c.app = createStudio({
    directory: c.directory,
    port: 0,
    runnerOptions: { codexBinary: fixture, claudeBinary: claudeFixture },
  });
  await c.connect();
  const restarted = c.app.store.organization();
  assert.equal(restarted.quota.claude, false);
  assert.equal(Object.hasOwn(restarted.quotaResets, 'claude'), false);
  assert.equal(controlEvents(c).filter(message => sourceFreeCleared.test(message)).length, 2);
  assert.ok(!controlEvents(c).some(message => /from the CLI's own report|read from the CLI's message/.test(message)));
});

for (const [title, reached, label] of [
  ['Quota limit', 0, 'no reported reset and a message that names no time'],
  ['Limit reported past', 1, 'a reached limit reported to reset in the past'],
  ['Limit reported far', 1, 'a reached limit reported to reset more than 8 days ahead'],
  ['Limits not reached, then stopped', 0, 'only reports of limits not reached'],
])
  test(`a Claude hold with ${label} records no reset time and waits for the director`, async t => {
    const c = await setup(t, { claudeBinary: claudeFixture });
    await onClaude(c);
    const task = await c.create(title, 'W-02');
    await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
    await c.wait(task.id, 'blocked');
    // Longer than a hold with a reported past time would take to clear itself.
    await new Promise(resolve => setTimeout(resolve, 500));
    const [stopped] = c.app.store.attempts(task.id),
      held = c.app.store.organization(),
      waiting = c.app.store.task(task.id);
    assert.equal(rateLimitReports(c, stopped).filter(report => report?.status === 'rejected').length, reached);
    assert.equal(stopped.error, 'rate_limit: You have hit your limit');
    assert.equal(stopped.status, 'blocked');
    assert.equal(stopped.subscriptionHold, 'claude');
    assert.equal(stopped.subscriptionReset, undefined);
    assert.equal(held.quota.claude, true);
    assert.equal(Object.hasOwn(held.quotaResets, 'claude'), false);
    assert.equal(Object.hasOwn(held.quotaResetSources, 'claude'), false);
    assert.equal(c.app.runner.quotaTimer, null);
    assert.equal(waiting.queued, false);
    assert.doesNotMatch(waiting.reason, /^Waiting for /);
    assert.equal(c.app.store.attempts(task.id).length, 1);
    assert.ok(!controlEvents(c).some(message => /cleared itself/.test(message)));
    assert.equal((await c.request('/api/control', { clearQuota: 'claude' })).status, 200);
    assert.equal(c.app.store.organization().quota.claude, false);
    assert.ok(
      controlEvents(c).includes('Claude hold cleared by director. Actual provider availability is not inferred.'),
    );
  });

test('reports of Claude usage limits not reached leave a successful run without a hold', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onClaude(c);
  const task = await c.create('Limits not reached', 'W-02');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'review');
  const [done] = c.app.store.attempts(task.id),
    org = c.app.store.organization();
  // Two records without a readable report, then an allowed and an allowed_warning report.
  assert.deepEqual(
    rateLimitReports(c, done).map(report => report?.status),
    [undefined, undefined, 'allowed', 'allowed_warning'],
  );
  assert.equal(done.status, 'review');
  assert.equal(done.subscriptionHold, undefined);
  assert.equal(!!org.quota.claude, false);
  assert.equal(Object.hasOwn(org.quotaResets || {}, 'claude'), false);
  assert.equal(c.app.runner.quotaTimer, null);
});

// After Claude Code reports a limit as reached, a failure it reports is the usage limit whatever its wording,
// except a sign-in, login or permission failure.
const unrecognized = 'Claude stopped unexpectedly.';
const queueLimitedOnce = async (c, title, extra) => {
  const task = await c.create(title, 'W-02', extra),
    stored = c.app.store.task(task.id);
  // One attempt: a stopped attempt that counted would leave no automatic rerun.
  stored.maxAttempts = 1;
  c.app.store.putTask(stored);
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'blocked');
  return task;
};

test('a Claude attempt that fails in any wording after a reached limit is a hold, and queued work starts again at its reset', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onClaude(c);
  const task = await queueLimitedOnce(c, 'Limit reached then failed'),
    [stopped] = c.app.store.attempts(task.id),
    waiting = c.app.store.task(task.id),
    held = c.app.store.organization(),
    [reached] = rateLimitReports(c, stopped),
    reset = epochTime(reached.resetsAt);
  assert.equal(reached.status, 'rejected');
  // The failure's own text, which names no usage limit.
  assert.equal(stopped.error, unrecognized);
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.subscriptionHold, 'claude');
  assert.equal(stopped.subscriptionReset, reset);
  assert.equal(held.quota.claude, true);
  assert.equal(held.quotaResets.claude, reset);
  assert.equal(held.quotaResetSources.claude, 'report');
  assert.equal(waiting.queued, true);
  assert.equal(waiting.controllerWait, true);
  assert.match(waiting.reason, claudeWait);
  await c.wait(task.id, 'review');
  const attempts = c.app.store.attempts(task.id),
    cleared = c.app.store.organization();
  assert.equal(attempts.length, 2);
  assert.ok(Date.parse(attempts[1].startedAt) >= Date.parse(reset));
  assert.equal(cleared.quota.claude, false);
  assert.equal(Object.hasOwn(cleared.quotaResets, 'claude'), false);
  assert.equal(Object.hasOwn(cleared.quotaResetSources, 'claude'), false);
  assert.equal(controlEvents(c).filter(message => reportCleared.test(message)).length, 1);
  assert.ok(!controlEvents(c).some(message => readFromMessage.test(message)), 'The time came from the report.');
  assert.ok(!controlEvents(c).some(message => /cleared by director/.test(message)), 'No director request was made.');
});

for (const [title, error, label] of [
  ['Limit reached after failure', unrecognized, 'a failure reported before the reached limit'],
  ['Limit reached then exited', 'CLI exited with code 1. See recorded logs.', 'a failing exit with no reported error'],
])
  test(`after a reached Claude limit, ${label} is a hold with the reported reset`, async t => {
    const c = await setup(t, { claudeBinary: claudeFixture });
    await onClaude(c);
    const task = await queueLimitedOnce(c, title),
      [stopped] = c.app.store.attempts(task.id),
      held = c.app.store.organization(),
      reset = epochTime(rateLimitReports(c, stopped)[0].resetsAt);
    assert.equal(stopped.error, error);
    assert.equal(stopped.subscriptionHold, 'claude');
    assert.equal(stopped.subscriptionReset, reset);
    assert.equal(held.quota.claude, true);
    assert.equal(held.quotaResets.claude, reset);
    assert.equal(held.quotaResetSources.claude, 'report');
    assert.ok(c.app.runner.quotaTimer, 'The timer waits for the reported reset.');
    assert.equal(c.app.store.task(task.id).queued, true);
    assert.match(c.app.store.task(task.id).reason, claudeWait);
  });

// A sign-in, login or permission failure comes to the director as it does with no reached limit.
for (const [title, error] of [
  ['Limit reached then sign-in failure', 'Authentication failed; sign in again'],
  ['Limit reached then permission failure', 'Permission denied by managed policy'],
])
  test(`after a reached Claude limit, the failure '${error}' stops for the director without a hold`, async t => {
    const c = await setup(t, { claudeBinary: claudeFixture });
    await onClaude(c);
    const task = await queueLimitedOnce(c, title, { brief: 'Reset in 1 seconds.' }),
      [stopped] = c.app.store.attempts(task.id),
      stoppedTask = c.app.store.task(task.id),
      org = c.app.store.organization(),
      reports = rateLimitReports(c, stopped);
    assert.deepEqual(
      reports.map(report => report.status),
      ['rejected'],
      'The limit was reported as reached.',
    );
    assert.equal(stopped.status, 'blocked');
    assert.equal(stopped.error, error);
    assert.equal(stopped.subscriptionHold, undefined);
    assert.equal(stopped.subscriptionReset, undefined);
    assert.equal(!!org.quota.claude, false);
    assert.equal(Object.hasOwn(org.quotaResets || {}, 'claude'), false);
    assert.equal(Object.hasOwn(org.quotaResetSources || {}, 'claude'), false);
    assert.equal(c.app.runner.quotaTimer, null);
    assert.equal(stoppedTask.queued, false);
    assert.doesNotMatch(stoppedTask.reason, /^Waiting for /);
    // Past the reported reset, nothing starts the work again.
    const reset = Date.parse(epochTime(reports[0].resetsAt));
    await c.until(() => Date.now() > reset + 500, 'the reported reset passing');
    assert.equal(c.app.store.attempts(task.id).length, 1);
    assert.equal(c.app.store.task(task.id).status, 'blocked');
    assert.ok(!controlEvents(c).some(message => /cleared itself/.test(message)));
  });

test('a Claude run that finishes after a reached limit is reviewed without a hold', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onClaude(c);
  const task = await c.create('Finished after a reached limit', 'W-02');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'review');
  const [done] = c.app.store.attempts(task.id),
    org = c.app.store.organization();
  assert.deepEqual(
    rateLimitReports(c, done).map(report => report.status),
    ['rejected'],
    'The limit was reported as reached.',
  );
  assert.equal(done.status, 'review');
  assert.equal(done.subscriptionHold, undefined);
  assert.equal(!!org.quota.claude, false);
  assert.equal(Object.hasOwn(org.quotaResets || {}, 'claude'), false);
  assert.equal(c.app.runner.quotaTimer, null);
});

test('a Claude failure in unrecognized wording with no reached limit fails the attempt without a hold', async t => {
  const c = await setup(t, { claudeBinary: claudeFixture });
  await onClaude(c);
  const task = await c.create('Unrecognized failure', 'W-02');
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(task.id, 'failed');
  const [failed] = c.app.store.attempts(task.id),
    org = c.app.store.organization();
  assert.deepEqual(rateLimitReports(c, failed), []);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, unrecognized);
  assert.equal(failed.subscriptionHold, undefined);
  assert.equal(failed.subscriptionReset, undefined);
  assert.equal(!!org.quota.claude, false);
  assert.equal(Object.hasOwn(org.quotaResets || {}, 'claude'), false);
  assert.equal(c.app.runner.quotaTimer, null);
  assert.equal(c.app.store.task(task.id).queued, false);
});

test('restart retains queue but pauses dispatch; uncertain attempts require reconciliation', async t => {
  const c = await setup(t),
    waiting = await c.create('Retained queued work', 'W-02');
  await c.request('/api/tasks/D-001', { hold: true }, 'PATCH');
  await c.request(`/api/tasks/${waiting.id}`, { hold: true }, 'PATCH');
  await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001', waiting.id] });
  c.app.store.tx(() => {
    c.app.store.insertAttempt(
      {
        id: 'uncertain-pipeline',
        taskId: 'D-001',
        workerId: 'W-03',
        provider: 'mock',
        status: 'running',
        pid: null,
        artifacts: [],
      },
      { text: 'original', hash: 'original' },
    );
    c.app.store.claim(['employee:W-03', 'layout:prototype'], 'uncertain-pipeline');
    const task = c.app.store.task('D-001');
    task.status = 'running';
    task.lastAttemptId = 'uncertain-pipeline';
    task.autonomyNote = 'Earlier failure needs attention.';
    c.app.store.putTask(task);
  });
  await c.app.close();
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { codexBinary: fixture } });
  await c.connect();
  assert.equal(c.app.store.organization().pipelineEnabled, false);
  assert.equal(c.app.store.task(waiting.id).queued, true);
  assert.equal(c.app.store.task('D-001').queued, false);
  assert.equal(c.app.store.attempt('uncertain-pipeline').status, 'interrupted');
  assert.equal(c.app.store.leases().length, 2);
  assert.match(c.app.store.task('D-001').reason, /Reconcile the previous attempt/);
  assert.equal(c.app.store.task('D-001').autonomyNote, c.app.store.task('D-001').reason);
  assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: ['D-001'] })).status, 400);
  assert.match(c.app.store.task('D-001').autonomyNote, /Reconcile the previous attempt/);
  await c.request(`/api/tasks/${waiting.id}`, { hold: false }, 'PATCH');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.attempts(waiting.id).length, 0);
  await c.request('/api/pipeline', { action: 'resume' });
  await c.wait(waiting.id, 'review');
  assert.equal(c.app.store.attempts('D-001').length, 1, 'Unknown work is never replayed.');
  assert.equal((await c.request('/api/tasks/D-001/reconcile')).status, 200);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal(c.app.store.task('D-001').autonomyNote, undefined);
  // Reconciliation resolves the unknown attempt, but the director's hold still applies.
  assert.equal(c.app.store.task('D-001').hold, true);
  assert.equal(c.app.store.task('D-001').reason, 'Assignment is deliberately on hold.');
});
