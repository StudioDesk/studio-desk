import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createStudio } from './model-free-studio.mjs';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { fixture, setup } from './studio-setup.mjs';
import { closeStartedWork } from '../src/core/proposals.mjs';
import { readContinuation } from '../src/core/attempt-continuation.mjs';

test('finish retains ownership and avoids checkpoint/cleanup while an adapter process may still run', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-finish-')),
    app = createStudio({ directory, port: 0 }),
    { runner, store } = app;
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { attemptId } = runner.start('D-001'),
    entry = runner.active.get(attemptId);
  clearTimeout(entry.mockTimer);
  entry.attempt.assignment.kind = 'general:work';
  fs.writeFileSync(path.join(entry.output, 'draft.txt'), 'Recoverable stopped work.\n');
  let cleaned = false;
  entry.cleanup.push(() => {
    cleaned = true;
  });
  entry.attempt.pid = 12345;
  const kill = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('Unknown process ownership'), { code: 'EPERM' });
  });
  runner.finish(entry, null, 'Adapter failed after spawning.');
  assert.equal(store.attempt(attemptId).status, 'quarantined');
  assert.ok(store.leases().length);
  assert.equal(cleaned, false);
  assert.equal(fs.existsSync(path.join(entry.job, 'continuation')), false);
  assert.throws(() => runner.start('D-001'), /Reconcile|running|blocked|quarantined/i);
  kill.mock.restore();
  entry.attempt.pid = null; // the process boundary now independently confirms no process
  runner.finish(entry, null, 'Adapter failed after spawning.');
  const a = store.attempt(attemptId);
  assert.equal(a.status, 'failed');
  assert.equal(a.error, 'Adapter failed after spawning.');
  assert.equal(readContinuation(store, a).status, 'complete');
  assert.equal(cleaned, true);
  assert.equal(store.leases().length, 0);
  assert.equal(store.attempts('D-001').length, 1);
});

test('the assignment deadline records unknown activity when only the enclosing phase was observed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stop-context-')),
    app = createStudio({ directory, port: 0 }),
    { store, runner } = app;
  t.after(async () => {
    await app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const task = store.task('D-001');
  task.maxSeconds = 5;
  store.putTask(task);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    timer(callback, delay === 5000 ? 30 : delay, ...args),
  );
  const { attemptId } = runner.start(task.id);
  for (let i = 0; i < 100 && runner.active.has(attemptId); i++) await new Promise(resolve => timer(resolve, 15));
  const attempt = store.attempt(attemptId),
    phases = store.phaseEvents(attemptId).map(event => event.payload);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.error, 'Assignment time limit reached.');
  assert.equal(attempt.stopContext.activity, 'unknown');
  assert.equal(attempt.stopContext.taskKind, attempt.assignment.kind);
  assert.equal(attempt.stopContext.phaseId, 'attempt');
  assert.equal(attempt.stopContext.occurrenceId, phases[0].occurrenceId);
  assert.equal(Object.hasOwn(attempt.stopContext, 'testEvidence'), false);
  assert.equal(Object.hasOwn(attempt, 'failedTests'), false);
  assert.deepEqual(
    phases.map(phase => phase.phaseId),
    ['attempt', 'attempt'],
  );
  assert.equal(phases[1].outcome, 'failed');
  assert.equal(store.leases().length, 0);
});

test('real HTTP workflow: prerequisites, revision, immutable instructions, independent review, and restart persistence', async t => {
  const c = await setup(t);
  // Starting work that waits for a prerequisite queues it (MP-012); nothing runs yet.
  const queued = await c.request('/api/tasks/R-001/start');
  assert.equal(queued.status, 202);
  assert.equal(queued.data.queued, true);
  assert.match(queued.data.reason, /^Waiting for accepted work: D-001/);
  assert.equal(c.app.store.attempts('R-001').length, 0);
  assert.equal((await c.request('/api/tasks/R-001/accept')).status, 400);
  const start = await c.request('/api/tasks/D-001/start');
  assert.equal(start.status, 202);
  assert.equal((await c.request('/api/tasks/D-001/accept')).status, 400);
  assert.equal((await c.request('/api/tasks/D-001/reconcile')).status, 400);
  const initial = (await c.state()).attempts[0].instructions;
  const nextText = 'Updated company rules: preserve scope and return evidence.';
  assert.equal(
    (await c.request('/api/instructions/company/company/draft', { baseRevision: 1, text: nextText })).status,
    200,
  );
  assert.equal((await c.state()).instructions.company.revision, 1);
  assert.equal(
    (await c.request('/api/instructions/company/company/publish', { baseRevision: 1, text: 'unsaved changes' })).status,
    409,
  );
  assert.equal(
    (await c.request('/api/instructions/company/company/publish', { baseRevision: 1, text: nextText })).status,
    200,
  );
  assert.equal(
    (await c.request('/api/instructions/company/company/draft', { baseRevision: 1, text: 'stale' })).status,
    409,
  );
  const first = await c.wait('D-001');
  assert.equal(first.task.status, 'review');
  assert.deepEqual(first.attempt.instructions, initial);
  const artifact = await fetch(c.origin + `/api/attempts/${first.attempt.id}/artifact?path=layout.json`);
  assert.equal(artifact.status, 200);
  assert.equal((await artifact.json()).rooms.length, 3);
  assert.equal(
    (
      await c.request('/api/tasks/D-001/revise', {
        direction: 'Keep the route; explain the exit landmark more clearly.',
      })
    ).status,
    200,
  );
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
  const second = await c.wait('D-001');
  assert.equal(second.task.status, 'review');
  assert.equal(second.attempt.instructions.layers[0].revision, 2);
  assert.match(second.attempt.instructions.text, /exit landmark/);
  assert.notEqual(second.attempt.id, first.attempt.id);
  assert.equal(second.s.attempts.find(a => a.id === first.attempt.id).instructions.hash, initial.hash);
  assert.equal((await c.request('/api/tasks/D-001/accept')).status, 200);
  // The review queued earlier starts by itself once its prerequisite is accepted.
  const reviewed = await c.wait('R-001');
  assert.equal(reviewed.task.status, 'review');
  assert.equal(reviewed.attempt.reviewVerdict, 'pass');
  assert.equal(reviewed.attempt.inputReferences[0].attemptId, second.attempt.id);
  assert.equal((await c.request('/api/tasks/R-001/accept')).status, 200);
  const reopened = new Store(c.dir);
  assert.equal(reopened.task('R-001').status, 'done');
  assert.equal(reopened.attempt(first.attempt.id).instructions.hash, initial.hash);
  reopened.close();
});
test('director assignments use complexity policy limits and preserve legacy creation defaults', async t => {
  const c = await setup(t);
  const create = fields =>
    c.request('/api/tasks', {
      title: 'Bounded director assignment',
      brief: 'Return a model-free bounded result.',
      kind: 'general',
      workerId: 'W-02',
      ...fields,
    });
  const numeric = await create({ complexity: 2 });
  assert.equal(numeric.status, 201);
  assert.equal(numeric.data.complexity, 2);
  assert.equal(numeric.data.maxSeconds, 900);
  assert.equal(numeric.data.maxAttempts, 2);
  for (const [complexity, maxSeconds, maxAttempts] of [
    [1, 600, 2],
    [2, 900, 2],
    [3, 1200, 3],
    [5, 1800, 3],
    [8, 2700, 3],
  ]) {
    const result = await create({ complexity, maxSeconds: 9999, maxAttempts: 99, planned: true });
    assert.equal(result.status, 201);
    const recorded = c.app.store.task(result.data.id);
    assert.equal(recorded.complexity, complexity);
    assert.equal(recorded.maxSeconds, maxSeconds, 'Caller time limits cannot override complexity.');
    assert.equal(recorded.maxAttempts, maxAttempts, 'Caller attempt limits cannot override complexity.');
    assert.equal(recorded.status, 'backlog');
    assert.equal(recorded.approval.status, 'pending', 'Complexity does not bypass work approval.');
  }
  for (const complexity of [13, '2', null, 2.5, 0, false]) {
    const count = c.app.store.tasks().length;
    const result = await create({ complexity });
    assert.equal(result.status, 400);
    assert.equal(
      result.data.error,
      'Invalid complexity: use numeric 1, 2, 3, 5 or 8; the work must be split into smaller stories.',
    );
    assert.equal(c.app.store.tasks().length, count, 'Invalid complexity creates no task.');
  }
  for (const fields of [
    {},
    { maxSeconds: null },
    { maxSeconds: 75, maxAttempts: 1 },
    { maxSeconds: 5 },
    { maxSeconds: 600 },
  ]) {
    const result = await create(fields);
    assert.equal(result.status, 201);
    const recorded = c.app.store.task(result.data.id);
    assert.equal(Object.hasOwn(recorded, 'complexity'), false);
    assert.equal(recorded.maxSeconds, fields.maxSeconds ?? 120);
    assert.equal(recorded.maxAttempts, 3, 'Legacy creation still uses its default attempt limit.');
    assert.equal(recorded.status, 'ready');
  }
  for (const maxSeconds of [4, 601, '120', 12.5]) {
    const count = c.app.store.tasks().length;
    const result = await create({ maxSeconds });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, 'Time limit must be 5 to 600 seconds.');
    assert.equal(c.app.store.tasks().length, count);
  }
});
test('atomic employee/resource ownership, pause behavior, cancellation, and unsupported editor access', async t => {
  const c = await setup(t);
  const create = (workerId, resource = 'layout:prototype') =>
    c.request('/api/tasks', {
      title: 'Separate layout',
      brief: 'Three-room layout.',
      acceptance: 'Connected rooms.',
      kind: 'layout',
      workerId,
      resources: [resource],
    });
  const other = (await create('W-04')).data;
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
  // A held resource is a wait, not an error (MP-012): Start queues the task and claims nothing.
  const queued = await c.request(`/api/tasks/${other.id}/start`);
  assert.equal(queued.status, 202);
  assert.equal(queued.data.queued, true);
  assert.equal(c.app.store.leases().filter(l => l.resource === 'layout:prototype').length, 1);
  assert.equal(c.app.store.attempts(other.id).length, 0);
  await c.request('/api/control', { paused: true });
  assert.equal(c.app.store.task('D-001').status, 'running');
  await c.request('/api/tasks/D-001/cancel');
  const cancelled = await c.wait('D-001');
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(c.app.store.leases().length, 0);
  // Pause is the director's control, so Start refuses rather than queues; queued work waits.
  assert.equal((await c.request(`/api/tasks/${other.id}/start`)).status, 400);
  assert.equal(c.app.store.attempts(other.id).length, 0);
  await c.request('/api/control', { paused: false });
  await c.until(() => c.app.store.attempts(other.id).length === 1, 'queued work starts after resume');
  const sameEmployee = (await create('W-04', 'layout:alternative')).data;
  // A busy employee also queues; it starts when that employee's attempt ends.
  assert.equal((await c.request(`/api/tasks/${sameEmployee.id}/start`)).status, 202);
  assert.equal(c.app.store.attempts(sameEmployee.id).length, 0);
  await c.wait(other.id);
  await c.until(() => c.app.store.attempts(sameEmployee.id).length === 1, 'busy employee frees up');
  await c.wait(sameEmployee.id);
  const editor = (await create('W-06', 'unreal:integration-session')).data;
  assert.equal((await c.request(`/api/tasks/${editor.id}/start`)).status, 400);
  assert.match(c.app.store.task(editor.id).reason, /not connected/);
});
test('Codex protocol adapter: subscription gate, streamed session, scope validation, quota holds, and cancellation', async t => {
  const c = await setup(t, true);
  const oldKey = process.env.OPENAI_API_KEY,
    oldAuth = process.env.STUDIO_FIXTURE_AUTH;
  process.env.OPENAI_API_KEY = 'test-must-not-reach-worker';
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldAuth === undefined) delete process.env.STUDIO_FIXTURE_AUTH;
    else process.env.STUDIO_FIXTURE_AUTH = oldAuth;
  });
  await c.request('/api/workers/W-03', { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
  process.env.STUDIO_FIXTURE_AUTH = 'api';
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 400);
  assert.equal(c.app.store.attempts('D-001').length, 0);
  delete process.env.STUDIO_FIXTURE_AUTH;
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
  const good = await c.wait('D-001');
  assert.equal(good.task.status, 'review');
  assert.equal(good.attempt.sessionId, 'fixture-session');
  assert.equal(good.attempt.reportedModel, 'fixture-model');
  const create = async title =>
    (await c.request('/api/tasks', { title, brief: 'Return the layout contract.', kind: 'layout', workerId: 'W-03' }))
      .data;
  for (const title of ['Disconnected route', 'Collapsed route', 'Escape artifact', 'Tamper instructions']) {
    const x = await create(title);
    assert.equal((await c.request(`/api/tasks/${x.id}/start`)).status, 202);
    const result = await c.wait(x.id);
    assert.equal(result.task.status, 'failed');
    assert.equal((await c.request(`/api/tasks/${x.id}/accept`)).status, 400);
  }
  // A limit message that names its reset time records it with the hold and the stopped attempt.
  const readable = await create('Quota with a reset time');
  await c.request(`/api/tasks/${readable.id}/start`);
  const limited = await c.wait(readable.id),
    resetAt = new Date(Number(limited.attempt.error.match(/\|(\d+)$/)[1]) * 1000).toISOString();
  assert.equal(limited.task.status, 'blocked');
  assert.equal(limited.s.quota.codex, true);
  assert.equal(limited.s.quotaResets.codex, resetAt);
  assert.equal(limited.attempt.subscriptionHold, 'codex');
  assert.equal(limited.attempt.subscriptionReset, resetAt);
  const compact = await (await fetch(c.origin + '/api/state?mode=dashboard')).json();
  assert.equal(compact.attempts.find(a => a.id === limited.attempt.id).subscriptionReset, resetAt);
  assert.equal((await c.request('/api/control', { clearQuota: 'codex' })).status, 200);
  assert.equal(c.app.store.organization().quota.codex, false);
  assert.equal(Object.hasOwn(c.app.store.organization().quotaResets, 'codex'), false);
  // An unreadable message records no time, and does not keep one left from an earlier hold.
  const earlier = c.app.store.organization();
  earlier.quotaResets.codex = resetAt;
  c.app.store.setOrganization(earlier);
  const quota = await create('Quota test');
  await c.request(`/api/tasks/${quota.id}/start`);
  const held = await c.wait(quota.id);
  assert.equal(held.task.status, 'blocked');
  assert.equal(held.s.quota.codex, true);
  assert.equal(Object.hasOwn(held.s.quotaResets, 'codex'), false);
  assert.equal(held.attempt.subscriptionHold, 'codex');
  assert.equal(Object.hasOwn(held.attempt, 'subscriptionReset'), false);
  const afterQuota = await create('No paid fallback');
  assert.equal((await c.request(`/api/tasks/${afterQuota.id}/start`)).status, 400);
  assert.equal(c.app.store.attempts(afterQuota.id).length, 0);
  await c.request('/api/control', { clearQuota: 'codex' });
  const hang = await create('Hang for cancellation');
  await c.request(`/api/tasks/${hang.id}/start`);
  await c.request(`/api/tasks/${hang.id}/cancel`);
  const stopped = await c.wait(hang.id);
  assert.equal(stopped.task.status, 'cancelled');
  assert.equal(c.app.store.leases().length, 0);
});
test('Codex model-free reviews use accepted inputs and reject reports without usable evidence', async t => {
  const c = await setup(t, true);
  await c.request('/api/workers/W-03', { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
  await c.request('/api/workers/W-07', { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
  const layout = await c.wait('D-001');
  assert.equal(layout.task.status, 'review');
  await c.request('/api/tasks/D-001/accept');
  assert.equal((await c.request('/api/tasks/R-001/start')).status, 202);
  const report = await c.wait('R-001');
  assert.equal(report.task.status, 'review');
  assert.equal(report.attempt.reviewVerdict, 'pass');
  const input = report.attempt.inputReferences[0];
  assert.equal(input.attemptId, layout.attempt.id);
  const file = JSON.parse(fs.readFileSync(path.join(report.attempt.outputFolder, 'review.json'), 'utf8'));
  assert.ok(
    file.evidence.some(item => item.includes(layout.attempt.id) && item.includes(layout.attempt.artifacts[0].hash)),
  );
  assert.equal((await c.request('/api/tasks/R-001/accept')).status, 200);
  for (const title of [
    'Empty evidence',
    'Non-text evidence',
    'Non-text findings',
    'Whitespace evidence',
    'Missing findings',
    'No supplied input',
  ]) {
    const job = (
      await c.request('/api/tasks', {
        title,
        brief: 'Review the supplied accepted work.',
        kind: 'review',
        workerId: 'W-07',
        dependencies: title === 'No supplied input' ? [] : ['D-001'],
      })
    ).data;
    assert.equal((await c.request(`/api/tasks/${job.id}/start`)).status, 202);
    const failed = await c.wait(job.id);
    assert.equal(failed.task.status, 'failed', title);
    if (title === 'No supplied input') assert.match(failed.attempt.error, /requires supplied accepted input artifacts/);
    assert.equal((await c.request(`/api/tasks/${job.id}/accept`)).status, 400, title);
    assert.equal(c.app.store.leases().length, 0);
  }
  const revision = (
    await c.request('/api/tasks', {
      title: 'Revision verdict',
      brief: 'Report a bounded repair request.',
      kind: 'review',
      workerId: 'W-07',
      dependencies: ['D-001'],
    })
  ).data;
  await c.request(`/api/tasks/${revision.id}/start`);
  const negative = await c.wait(revision.id);
  assert.equal(negative.task.status, 'review');
  assert.equal(negative.attempt.reviewVerdict, 'revise');
  assert.equal(
    (await c.request(`/api/tasks/${revision.id}/accept`)).status,
    200,
    'The director can accept a completed negative review report.',
  );
  assert.equal(c.app.store.task('D-001').acceptedAttemptId, layout.attempt.id);
});

test('Simulator reviews every accepted layout with provenance and labels missing-input checks accurately', async t => {
  const c = await setup(t, true);
  await c.request('/api/tasks/D-001/start');
  const source = await c.wait('D-001');
  await c.request('/api/tasks/D-001/accept');
  await c.request('/api/workers/W-04', { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
  // General files may contain candidate layouts; the independent review must inspect each one.
  const candidate = (
    await c.request('/api/tasks', {
      title: 'Collapsed candidate layout',
      brief: 'Stage a candidate for independent checks.',
      kind: 'general',
      workerId: 'W-04',
    })
  ).data;
  await c.request(`/api/tasks/${candidate.id}/start`);
  const badLayout = await c.wait(candidate.id);
  assert.equal(badLayout.task.status, 'review');
  await c.request(`/api/tasks/${candidate.id}/accept`);
  const review = (
    await c.request('/api/tasks', {
      title: 'Review both candidates',
      brief: 'Inspect every supplied layout.',
      kind: 'review',
      workerId: 'W-07',
      dependencies: ['D-001', candidate.id],
    })
  ).data;
  await c.request(`/api/tasks/${review.id}/start`);
  const checked = await c.wait(review.id);
  assert.equal(checked.task.status, 'review');
  assert.equal(checked.attempt.reviewVerdict, 'revise');
  const report = JSON.parse(fs.readFileSync(path.join(checked.attempt.outputFolder, 'review.json'), 'utf8'));
  for (const produced of [source, badLayout]) {
    const ref = checked.attempt.inputReferences.find(input => input.attemptId === produced.attempt.id);
    assert.ok(
      report.evidence.some(item =>
        [ref.taskId, ref.attemptId, ref.artifacts[0].path, ref.artifacts[0].hash].every(value => item.includes(value)),
      ),
    );
  }
  assert.ok(report.findings.some(item => item.includes(candidate.id) && item.includes('distinct')));
  assert.equal(
    checked.attempt.result.checks.filter(check => check.name.startsWith('Logical layout review:')).length,
    2,
  );
  assert.deepEqual(
    checked.attempt.result.checks
      .filter(check => check.name.startsWith('Logical layout review:'))
      .map(check => check.status),
    ['pass', 'fail'],
  );
  assert.equal(
    checked.attempt.result.checks.find(check => check.name === 'Engine traversal and playtest').status,
    'not-run',
  );
  assert.equal((await c.request(`/api/tasks/${review.id}/accept`)).status, 200);
  const missing = (
    await c.request('/api/tasks', {
      title: 'Review without a layout',
      brief: 'Report missing supplied context.',
      kind: 'review',
      workerId: 'W-07',
    })
  ).data;
  await c.request(`/api/tasks/${missing.id}/start`);
  const blockedReport = await c.wait(missing.id);
  assert.equal(blockedReport.task.status, 'review');
  assert.equal(blockedReport.attempt.reviewVerdict, 'blocked');
  assert.ok(blockedReport.attempt.result.checks.every(check => check.status === 'not-run'));
  const missingFile = JSON.parse(fs.readFileSync(path.join(blockedReport.attempt.outputFolder, 'review.json'), 'utf8'));
  assert.match(missingFile.evidence[0], /no layout checks were run/);
  assert.equal(
    (await c.request(`/api/tasks/${missing.id}/accept`)).status,
    200,
    'Accepting a blocked review records the report, not a passing source result.',
  );
  assert.equal(c.app.store.task(candidate.id).acceptedAttemptId, badLayout.attempt.id);
  assert.equal(c.app.store.leases().length, 0);
});

test(
  'Windows Codex attempts retain their selected sandbox and reject weaker future selections',
  { skip: process.platform !== 'win32' },
  async t => {
    const c = await setup(t, true);
    c.app.runner.codexWindowsSandbox = 'mxc';
    await c.request('/api/workers/W-03', { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
    const policy = id =>
      c.app.store
        .events(id)
        .filter(e => e.kind === 'log' && e.message.startsWith('stdout: {'))
        .map(e => JSON.parse(e.message.slice(8)))
        .find(e => e.type === 'fixture.policy').windowsSandbox;
    assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
    c.app.runner.codexWindowsSandbox = 'unelevated';
    const first = await c.wait('D-001');
    assert.equal(first.task.status, 'review');
    assert.equal(first.attempt.configuration.windowsSandbox, 'mxc');
    assert.equal(policy(first.attempt.id), 'windows.sandbox="mxc"');
    await c.request('/api/tasks/D-001/revise', { direction: 'Use the same isolated output contract.' });
    assert.equal((await c.request('/api/tasks/D-001/start')).status, 400);
    assert.match(c.app.store.task('D-001').reason, /must be mxc or elevated/);
    assert.equal(c.app.store.attempts('D-001').length, 1);
    assert.equal(c.app.store.leases().length, 0);
    c.app.runner.codexWindowsSandbox = 'elevated';
    assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
    const second = await c.wait('D-001');
    assert.equal(second.task.status, 'review');
    assert.equal(second.attempt.configuration.windowsSandbox, 'elevated');
    assert.equal(policy(second.attempt.id), 'windows.sandbox="elevated"');
    assert.equal(c.app.store.attempt(first.attempt.id).configuration.windowsSandbox, 'mxc');
  },
);

test('Claude subscription adapter: isolated text delivery, immutable snapshots, revision and accepted review inputs', async t => {
  const c = await setup(t, 'claude');
  const injected = {
    ANTHROPIC_API_KEY: 'fixture-secret',
    ANTHROPIC_AUTH_TOKEN: 'fixture-secret',
    ANTHROPIC_BASE_URL: 'https://invalid.example',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-secret',
    CLAUDE_CODE_SIMPLE: '1',
    OPENAI_API_KEY: 'fixture-secret',
  };
  const previous = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  Object.assign(process.env, injected);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal(
    (
      await c.request(
        '/api/workers/W-03',
        { provider: 'claude', model: 'fixture-requested', mode: 'text', expectedVersion: 1 },
        'PATCH',
      )
    ).status,
    200,
  );
  const created = (
    await c.request('/api/tasks', {
      title: 'Slow layout delivery',
      brief: 'Three rooms using the supplied logical catalog.',
      kind: 'layout',
      workerId: 'W-03',
    })
  ).data;
  assert.equal((await c.request(`/api/tasks/${created.id}/start`)).status, 202);
  const initial = c.app.store.attempts(created.id)[0];
  const newText = 'Future company revision. Preserve scope and evidence.';
  await c.request('/api/instructions/company/company/draft', { baseRevision: 1, text: newText });
  await c.request('/api/instructions/company/company/publish', { baseRevision: 1, text: newText });
  await c.request('/api/workers/W-03', { provider: 'mock', model: 'future-model', expectedVersion: 2 }, 'PATCH');
  const first = await c.wait(created.id);
  assert.equal(first.task.status, 'review');
  assert.equal(first.attempt.provider, 'claude');
  assert.equal(first.attempt.configuration.model, 'fixture-requested');
  assert.equal(first.attempt.sessionId, 'fixture-claude-session');
  assert.equal(first.attempt.reportedModel, 'fixture-claude-model');
  assert.equal(first.attempt.instructions.hash, initial.instructions.hash);
  assert.equal(first.attempt.instructions.layers[0].revision, 1);
  assert.match(first.attempt.instructions.text, /No native shell, filesystem, or editor tools/);
  assert.match(first.attempt.delivery, /controller stages/);
  assert.equal(c.app.store.leases().length, 0);
  await c.request(`/api/tasks/${created.id}/revise`, { direction: 'Explain the exit clearly.' });
  await c.request('/api/workers/W-03', { provider: 'claude', model: '', mode: 'text', expectedVersion: 3 }, 'PATCH');
  await c.request(`/api/tasks/${created.id}/start`);
  const next = await c.wait(created.id);
  assert.equal(next.task.status, 'review');
  assert.equal(next.attempt.instructions.layers[0].revision, 2);
  assert.match(next.attempt.instructions.text, /Explain the exit clearly/);
  assert.notEqual(next.attempt.outputFolder, first.attempt.outputFolder);
  assert.equal(c.app.store.attempt(first.attempt.id).instructions.hash, initial.instructions.hash);
  assert.equal((await c.request(`/api/tasks/${created.id}/accept`)).status, 200);
  await c.request('/api/workers/W-05', { provider: 'claude', model: '', mode: 'text', expectedVersion: 1 }, 'PATCH');
  const review = (
    await c.request('/api/tasks', {
      title: 'Independent Claude review',
      brief: 'Review the supplied accepted layout.',
      kind: 'review',
      workerId: 'W-05',
      dependencies: [created.id],
    })
  ).data;
  await c.request(`/api/tasks/${review.id}/start`);
  const reviewed = await c.wait(review.id);
  assert.equal(reviewed.task.status, 'review');
  assert.equal(reviewed.attempt.reviewVerdict, 'pass');
  assert.equal(reviewed.attempt.inputReferences[0].attemptId, next.attempt.id);
  const report = JSON.parse(fs.readFileSync(path.join(reviewed.attempt.outputFolder, 'review.json'), 'utf8'));
  assert.match(report.evidence[0], new RegExp(next.attempt.artifacts[0].hash));
  assert.equal((await c.request(`/api/tasks/${review.id}/accept`)).status, 200);
  const large = (
    await c.request('/api/tasks', {
      title: 'Large streamed text',
      brief: 'Exercise a delivery larger than one stream buffer.',
      kind: 'general',
      workerId: 'W-03',
    })
  ).data;
  await c.request(`/api/tasks/${large.id}/start`);
  const delivered = await c.wait(large.id);
  assert.equal(delivered.task.status, 'review');
  assert.equal(delivered.attempt.artifacts[0].bytes, 140000);
  for (const title of ['Input limit delivery', 'Binary input delivery']) {
    const source = (
      await c.request('/api/tasks', { title, brief: 'Bounded fixture input.', kind: 'general', workerId: 'W-03' })
    ).data;
    await c.request(`/api/tasks/${source.id}/start`);
    assert.equal((await c.wait(source.id)).task.status, 'review');
    await c.request(`/api/tasks/${source.id}/accept`);
    const dependent = (
      await c.request('/api/tasks', {
        title: 'Require text input',
        brief: 'Use the accepted input.',
        kind: 'general',
        workerId: 'W-03',
        dependencies: [source.id],
      })
    ).data;
    await c.request(`/api/tasks/${dependent.id}/start`);
    const rejected = await c.wait(dependent.id);
    assert.equal(rejected.task.status, 'failed');
    assert.match(rejected.attempt.error, /512 KB of UTF-8/);
    assert.equal(rejected.attempt.pid, null);
    assert.equal(rejected.attempt.sessionId, null);
    assert.equal(c.app.store.leases().length, 0);
  }
});

test('Claude adapter rejects non-subscription login, unsafe deliveries and tooling; provider holds, cancellation and timeouts', async t => {
  const c = await setup(t, 'claude');
  const oldAuth = process.env.STUDIO_CLAUDE_FIXTURE_AUTH;
  t.after(() => {
    if (oldAuth === undefined) delete process.env.STUDIO_CLAUDE_FIXTURE_AUTH;
    else process.env.STUDIO_CLAUDE_FIXTURE_AUTH = oldAuth;
  });
  await c.request('/api/workers/W-03', { provider: 'claude', model: '', mode: 'text', expectedVersion: 1 }, 'PATCH');
  for (const auth of ['api', 'token', 'third-party', 'unknown-plan', 'malformed', 'none']) {
    process.env.STUDIO_CLAUDE_FIXTURE_AUTH = auth;
    assert.equal((await c.request('/api/tasks/D-001/start')).status, 400);
    assert.equal(c.app.store.attempts('D-001').length, 0);
    assert.equal(c.app.store.leases().length, 0);
    assert.equal(c.app.store.task('D-001').controllerWait, false);
  }
  delete process.env.STUDIO_CLAUDE_FIXTURE_AUTH;
  const create = async (title, kind = 'general', maxSeconds = 120) =>
    (
      await c.request('/api/tasks', {
        title,
        brief: 'Return a bounded text/JSON delivery.',
        kind,
        workerId: 'W-03',
        maxSeconds,
      })
    ).data;
  for (const title of [
    'Escape delivery',
    'Protected guidance',
    'Device path',
    'Alternate stream path',
    'Mismatch manifest',
    'Duplicate case paths',
    'Conflict directories',
    'Wrong task result',
    'Disconnected layout',
    'Malformed protocol',
    'Unexpected metadata',
    'Installed plugin',
    'Unexpected call',
    'Oversized delivery',
  ]) {
    const x = await create(title, title.includes('Disconnected') ? 'layout' : 'general');
    assert.equal((await c.request(`/api/tasks/${x.id}/start`)).status, 202);
    const failed = await c.wait(x.id);
    assert.equal(failed.task.status, 'failed', title);
    if (title === 'Installed plugin') assert.match(failed.attempt.error, /unexpected tools or customizations/);
    assert.equal((await c.request(`/api/tasks/${x.id}/accept`)).status, 400, title);
    assert.equal(c.app.store.leases().length, 0, title);
    assert.equal(
      fs.readFileSync(path.join(failed.attempt.outputFolder, 'AGENTS.md'), 'utf8'),
      failed.attempt.instructions.text,
    );
  }
  for (const title of ['Blocked context', 'Permission failure', 'Authentication failure']) {
    const x = await create(title);
    await c.request(`/api/tasks/${x.id}/start`);
    assert.equal((await c.wait(x.id)).task.status, 'blocked');
    assert.equal(!!c.app.store.organization().quota.claude, false);
  }
  const quota = await create('Quota subscription limit');
  await c.request(`/api/tasks/${quota.id}/start`);
  const held = await c.wait(quota.id);
  assert.equal(held.task.status, 'blocked');
  assert.equal(held.s.quota.claude, true);
  assert.equal(!!held.s.quota.codex, false);
  const sameProvider = await create('No fallback after hold');
  assert.equal((await c.request(`/api/tasks/${sameProvider.id}/start`)).status, 400);
  assert.equal(c.app.store.attempts(sameProvider.id).length, 0);
  assert.equal((await c.request('/api/control', { clearQuota: 'other' })).status, 400);
  await c.request('/api/control', { clearQuota: 'codex' });
  assert.equal(c.app.store.organization().quota.claude, true);
  await c.request('/api/tasks/D-001', { workerId: 'W-04' }, 'PATCH'); // Same-team simulator remains usable.
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
  await c.request('/api/tasks/D-001/cancel');
  await c.wait('D-001');
  await c.request('/api/control', { clearQuota: 'claude' });
  const hang = await create('Hang for cancellation');
  await c.request(`/api/tasks/${hang.id}/start`);
  assert.ok(c.app.store.leases().some(l => l.resource === 'employee:W-03'));
  await c.request(`/api/tasks/${hang.id}/cancel`);
  const stopped = await c.wait(hang.id);
  assert.equal(stopped.task.status, 'cancelled');
  assert.equal(c.app.store.leases().length, 0);
  const timeout = await create('Timeout bounded worker', 'general', 5);
  await c.request(`/api/tasks/${timeout.id}/start`);
  const timed = await c.wait(timeout.id);
  assert.equal(timed.task.status, 'failed');
  assert.match(timed.attempt.error, /time limit/);
  assert.equal(timed.attempt.stopContext.reason, 'time-limit');
  assert.equal(timed.attempt.stopContext.activity, 'unknown');
  assert.equal(timed.attempt.stopContext.taskKind, timed.attempt.assignment.kind);
  assert.equal(timed.attempt.stopContext.phaseId, 'attempt');
  assert.equal(timed.attempt.stopContext.phaseFinished, false);
  assert.equal(Object.hasOwn(timed.attempt.stopContext, 'testEvidence'), false);
  assert.equal(Object.hasOwn(timed.attempt, 'testEvidence'), false);
  assert.equal(c.app.store.leases().length, 0);
});

test('restarts quarantine unknown work; artifacts and local API boundaries reject bypasses', async t => {
  const c = await setup(t);
  const org = c.app.store.organization();
  const snapshot = { text: 'original', hash: 'test' };
  c.app.store.tx(() => {
    c.app.store.insertAttempt(
      {
        id: 'interrupted-test',
        taskId: 'D-001',
        workerId: 'W-03',
        provider: 'mock',
        status: 'running',
        pid: null,
        artifacts: [],
      },
      snapshot,
    );
    c.app.store.claim(['employee:W-03', 'layout:prototype'], 'interrupted-test');
    const job = c.app.store.task('D-001');
    job.status = 'running';
    job.lastAttemptId = 'interrupted-test';
    job.autonomyNote = 'Earlier failure needs attention.';
    c.app.store.putTask(job);
  });
  const restarted = new Runner(c.app.store);
  assert.equal(c.app.store.attempt('interrupted-test').status, 'interrupted');
  assert.equal(c.app.store.leases().length, 2);
  assert.throws(() => restarted.start('D-001'), /Reconcile/);
  assert.match(c.app.store.task('D-001').autonomyNote, /Reconcile the previous attempt/);
  restarted.reconcile('D-001');
  assert.equal(c.app.store.leases().length, 0);
  assert.equal(c.app.store.task('D-001').autonomyNote, undefined);
  assert.equal(c.app.store.task('D-001').reason, '');
  assert.equal(
    (
      await fetch(c.origin + '/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await fetch(c.origin + '/api/state', { headers: { Origin: 'https://outside.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(c.origin + '/api/state', { headers: { Host: 'outside.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  await c.request('/api/tasks/D-001/start');
  const done = await c.wait('D-001');
  const escape = await fetch(c.origin + `/api/attempts/${done.attempt.id}/artifact?path=../../studio.sqlite`);
  assert.equal(escape.status, 404);
  const file = path.join(done.attempt.outputFolder, 'layout.json');
  fs.writeFileSync(file, '{}');
  assert.equal((await c.request('/api/tasks/D-001/accept')).status, 400);
  assert.equal((await fetch(c.origin + `/api/attempts/${done.attempt.id}/artifact?path=layout.json`)).status, 409);
});
test('single controller ownership and genuine stop/reopen keep accepted records', async t => {
  const c = await setup(t);
  assert.throws(() => createStudio({ directory: c.dir, port: 0 }), /Another controller/);
  await c.request('/api/tasks/D-001/start');
  await c.wait('D-001');
  await c.request('/api/tasks/D-001/accept');
  const original = c.app.store.attempts('D-001')[0].instructions.hash;
  await c.app.close();
  const reopened = createStudio({ directory: c.dir, port: 0 });
  const origin = await reopened.start();
  const s = await (await fetch(origin + '/api/state')).json();
  assert.equal(s.tasks.find(t => t.id === 'D-001').status, 'done');
  assert.equal(s.attempts[0].instructions.hash, original);
  await reopened.close();
});
test('independent jobs use separate folders while the global concurrency limit blocks a third start', async t => {
  const c = await setup(t);
  const create = async workerId =>
    (
      await c.request('/api/tasks', {
        title: 'Independent staged work',
        brief: 'Return a bounded text file.',
        kind: 'general',
        workerId,
      })
    ).data;
  const second = await create('W-02'),
    third = await create('W-04');
  await c.request('/api/tasks/D-001/start');
  assert.equal((await c.request(`/api/tasks/${second.id}/start`)).status, 202);
  const a = (await c.state()).attempts;
  assert.equal(a.filter(x => x.status === 'running').length, 2);
  assert.notEqual(a[0].outputFolder, a[1].outputFolder);
  // A full studio is a wait (MP-012): the third Start queues and runs when a slot frees.
  const queued = await c.request(`/api/tasks/${third.id}/start`);
  assert.equal(queued.status, 202);
  assert.equal(queued.data.queued, true);
  assert.equal(c.app.store.attempts(third.id).length, 0);
  await c.request('/api/tasks/D-001/cancel');
  await c.until(() => c.app.store.attempts(third.id).length === 1, 'a freed slot starts the queued task');
  assert.equal(c.app.store.attempts(third.id)[0].directorOverride, undefined);
  await c.wait(second.id);
  await c.wait(third.id);
});

test('the director can close started work that has no accepted result; accepted and live work stay as they are', async t => {
  const c = await setup(t),
    store = c.app.store,
    registries = c.app.runner.registries;
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
  const first = await c.wait('D-001');
  assert.equal(first.task.status, 'review');
  // Live work must stop first (a copied record, so nothing is changed).
  assert.throws(
    () => closeStartedWork(store, registries, { ...store.task('D-001'), status: 'running' }),
    /Cancel the running attempt first/,
  );
  assert.equal((await c.request('/api/tasks/D-001/close', { reason: 'x', note: 'y' })).status, 400);
  // An approved integration waiting to run is never closed underneath it (a recorded setting only).
  store.putSetting('autonomy-integration', { taskId: 'D-001' });
  assert.equal((await c.request('/api/tasks/D-001/close')).status, 409);
  store.putSetting('autonomy-integration', null);
  const closed = await c.request('/api/tasks/D-001/close', { reason: 'Superseded by a new brief.' });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const task = store.task('D-001'),
    attempt = store.attempt(first.attempt.id);
  assert.equal(task.status, 'denied');
  assert.equal(task.queued, false);
  assert.equal(task.closed.status, 'review');
  assert.equal(task.closed.reason, 'Superseded by a new brief.');
  assert.equal(task.approval?.status, first.task.approval?.status, 'Closing started work keeps its approval record.');
  assert.equal(attempt.status, 'closed');
  assert.equal(attempt.closedBy.reason, 'Superseded by a new brief.');
  assert.deepEqual(attempt.artifacts, first.attempt.artifacts, 'The recorded result is kept.');
  assert.ok(store.events().some(event => event.kind === 'work_closed' && event.task_id === 'D-001'));
  for (const action of ['start', 'accept', 'revise'])
    assert.equal((await c.request(`/api/tasks/D-001/${action}`, { direction: 'Again.' })).status, 400, action);
  assert.match((await c.request('/api/tasks/D-001/close')).data.error, /already closed/);
  assert.notEqual(store.task('R-001').status, 'done', 'Dependents never see a closed result as accepted.');
  // Accepted work is final.
  const created = (
    await c.request('/api/tasks', {
      title: 'Bounded director assignment',
      brief: 'Return a model-free bounded result.',
      kind: 'general',
      workerId: 'W-02',
    })
  ).data;
  await c.request(`/api/tasks/${created.id}/start`);
  assert.equal((await c.wait(created.id)).task.status, 'review');
  assert.equal((await c.request(`/api/tasks/${created.id}/accept`)).status, 200);
  assert.match((await c.request(`/api/tasks/${created.id}/close`)).data.error, /Accepted work is final/);
});

test('a queued director Start keeps its attempt-limit override until it runs', async t => {
  const c = await setup(t),
    store = c.app.store;
  const once = (
    await c.request('/api/tasks', {
      title: 'Bounded once',
      brief: 'Return a model-free bounded result.',
      kind: 'general',
      workerId: 'W-02',
    })
  ).data;
  // A one-attempt limit (set on the record; director creation always allows three).
  store.putTask({ ...store.task(once.id), maxAttempts: 1 });
  await c.request(`/api/tasks/${once.id}/start`);
  assert.equal((await c.wait(once.id)).task.status, 'review');
  assert.equal((await c.request(`/api/tasks/${once.id}/revise`, { direction: 'Once more.' })).status, 200);
  // The employee is busy (a fixture reservation, not a running process).
  store.tx(() => store.claim(['employee:W-02'], 'fixture-owner'));
  const queued = await c.request(`/api/tasks/${once.id}/start`);
  assert.equal(queued.status, 202, JSON.stringify(queued.data));
  assert.equal(queued.data.queued, true);
  assert.ok(store.task(once.id).directorStart);
  store.release('fixture-owner');
  c.app.runner.schedule();
  await c.until(() => store.attempts(once.id).length === 2, 'the queued start runs past the limit');
  const second = store.attempt(store.task(once.id).lastAttemptId);
  assert.deepEqual(second.directorOverride, { attemptLimit: 1, attemptNumber: 2 });
  assert.equal(store.task(once.id).directorStart, undefined, 'The override is used once.');
  await c.wait(once.id);
});

// The dashboard's idea composer (dashboard/src/idea-composer.tsx, tested with the page) sends the director's
// files as base64; the controller keeps their original bytes and serves them only to their own project.
test('idea files sent with an idea are kept byte for byte and served only as downloads of their own project', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-'));
  const app = createStudio({ directory, port: 0, dashboardDirectory: path.join(directory, 'no-build') });
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Exercise the real local HTTP handler in-process, so this fixture needs no socket or model.
  const send = (url, options = {}) =>
    new Promise(resolve => {
      const req = Readable.from([Buffer.from(options.body || '')]);
      const headers = {};
      const res = {
        setHeader(name, value) {
          headers[name.toLowerCase()] = value;
        },
        writeHead(status, values = {}) {
          this.status = status;
          this.headersSent = true;
          Object.entries(values).forEach(([name, value]) => this.setHeader(name, value));
        },
        end(data) {
          const bytes = Buffer.from(data || '');
          resolve({
            ok: this.status < 400,
            status: this.status,
            headers,
            bytes,
            json: async () => JSON.parse(bytes.toString()),
          });
        },
      };
      Object.assign(req, {
        url,
        method: options.method || 'GET',
        headers: {
          host: '127.0.0.1:0',
          ...Object.fromEntries(
            Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
          ),
        },
      });
      app.server.emit('request', req, res);
    });
  const servedPage = await send('/');
  assert.equal(
    servedPage.headers['content-security-policy'],
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  const token = servedPage.bytes.toString().match(/name="studio-token" content="([^"]+)"/)[1];
  const theme = await send('/theme.js');
  assert.equal(theme.status, 200);
  assert.match(theme.headers['content-type'], /^text\/javascript/);
  // The shared scripts are built into the dashboard; the controller serves no other script.
  for (const unserved of [
    '/runs.js',
    '/source-diff.js',
    '/markdown-reader.js',
    '/app.js',
    '/unregistered-source-reader.js',
  ])
    assert.equal((await send(unserved)).status, 404, unserved);
  const provisioned = await send('/api/studio-development', {
    method: 'POST',
    body: '{}',
    headers: { 'x-studio-token': token },
  });
  assert.equal(provisioned.status, 201);
  const { project } = await provisioned.json(),
    org = app.store.organization();
  // The intake's employees run on a CLI, as a real project's do; nothing is dispatched here.
  for (const id of ['W-01', 'W-02']) org.workers.find(worker => worker.id === id).provider = 'codex';
  app.store.setOrganization(org);
  const files = [
    {
      name: 'reference.png',
      mediaType: 'image/png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=',
        'base64',
      ),
    },
    { name: 'settings.json', mediaType: 'application/json', bytes: Buffer.from('{"count":3}') },
    { name: 'brief.md', mediaType: 'text/markdown', bytes: Buffer.from('# Director reference\n') },
  ];
  const intake = await send('/api/intake', {
    method: 'POST',
    headers: { 'x-studio-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      idea: 'Use these original references.',
      files: files.map(file => ({ name: file.name, mediaType: file.mediaType, data: file.bytes.toString('base64') })),
    }),
  });
  const result = await intake.json();
  assert.equal(intake.status, 201, result.error);
  assert.deepEqual(
    result.directorInputs.map(item => item.name),
    files.map(file => file.name),
  );
  assert.deepEqual(app.store.run(result.runId).directorInputs, result.directorInputs);
  for (const [index, item] of result.directorInputs.entries()) {
    const url =
      '/api/projects/' + project.id + '/runs/' + result.runId + '/inputs/' + item.id + '?projectId=' + project.id;
    const download = await send(url);
    assert.equal(download.status, 200);
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    assert.match(download.headers['content-disposition'], /^attachment;/);
    assert.deepEqual(download.bytes, files[index].bytes);
    assert.equal((await send(url.replace('?projectId=' + project.id, '?projectId=project-legacy'))).status, 400);
  }
  assert.equal(app.store.allAttempts().length, 0, 'This intake fixture does not dispatch models.');
});
