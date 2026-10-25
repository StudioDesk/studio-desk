import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { waitFor, waitForTask } from './wait-for.mjs';

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plan-'));
  const c = {
    app: createStudio({
      directory,
      port: 0,
      runnerOptions: {
        codexBinary: fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url)),
        claudeBinary: fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
      },
    }),
  };
  c.connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await c.connect();
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  c.request = async (url, data = {}, method = 'POST') => {
    const res = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: res.status, data: await res.json() };
  };
  c.until = async check => {
    await waitFor(check, 'planning workflow', { interval: 20 });
  };
  c.wait = async (id, status) => {
    await waitForTask(c.app.store, id, status, { interval: 20 });
  };
  c.configure = (id, provider, mode) =>
    c.request(
      '/api/workers/' + id,
      {
        provider,
        mode,
        expectedVersion: c.app.store.organization().workers.find(w => w.id === id).configVersion || 1,
      },
      'PATCH',
    );
  c.plan = async title => {
    const res = await c.request('/api/plans', {
      title,
      brief: 'A readable exploration route with a visible exit landmark.',
      workerId: 'W-01',
    });
    assert.equal(res.status, 201);
    return res.data;
  };
  c.approval = id => {
    const a = c.app.store.attempt(c.app.store.task(id).lastAttemptId);
    return { attemptId: a.id, planHash: a.artifacts.find(item => item.path === 'plan.json').hash };
  };
  c.source = async () => {
    await c.configure('W-03', 'codex');
    await c.configure('W-07', 'codex');
    await c.request('/api/tasks/D-001/start');
    await c.wait('D-001', 'review');
    assert.equal((await c.request('/api/tasks/D-001/accept')).status, 200);
    return c.app.store.attempt(c.app.store.task('D-001').acceptedAttemptId);
  };
  c.negativeReview = async (accept = true) => {
    const r = (
      await c.request('/api/tasks', {
        title: 'Revision verdict for repair',
        brief: 'Inspect the accepted source.',
        kind: 'review',
        workerId: 'W-07',
        dependencies: ['D-001'],
      })
    ).data;
    await c.request(`/api/tasks/${r.id}/start`);
    await c.wait(r.id, 'review');
    if (accept) assert.equal((await c.request(`/api/tasks/${r.id}/accept`)).status, 200);
    const a = c.app.store.attempt(c.app.store.task(r.id).lastAttemptId);
    return {
      reviewTaskId: r.id,
      attemptId: a.id,
      reviewHash: a.artifacts.find(item => item.path === 'review.json').hash,
      workerId: 'W-01',
      brief: '',
    };
  };
  return c;
}

test('one bounded plan approval creates shared tasks atomically and dispatches only accepted prerequisites', async t => {
  const c = await setup(t);
  await c.configure('W-01', 'codex');
  const p = await c.plan('Fixture planning workflow');
  await c.wait(p.id, 'review');
  const first = c.app.store.attempt(c.app.store.task(p.id).lastAttemptId);
  assert.equal(c.app.store.tasks().length, 3, 'Proposal has not created work.');
  assert.match(first.instructions.text, /Planning contract/);
  assert.equal(first.planBudget.totalAttemptSeconds, 720);
  assert.equal((await c.request(`/api/tasks/${p.id}/accept`)).status, 400);
  const stale = c.approval(p.id);
  await c.request(`/api/tasks/${p.id}/revise`, { direction: 'Preserve clear sightlines to the exit.' });
  await c.until(() => c.app.store.attempts(p.id).length === 2);
  await c.wait(p.id, 'review');
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, stale)).status, 409);
  assert.equal(c.app.store.tasks().length, 3);
  const approval = c.approval(p.id),
    current = c.app.store.attempt(approval.attemptId);
  assert.match(current.instructions.text, /Preserve clear sightlines/);
  assert.equal(c.app.store.attempt(first.id).instructions.hash, first.instructions.hash);
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, { ...approval, planHash: 'wrong' })).status, 409);
  const res = await c.request(`/api/tasks/${p.id}/approve-plan`, approval);
  assert.equal(res.status, 200);
  const [layout, review] = res.data.taskIds;
  assert.equal(c.app.store.tasks().length, 5);
  assert.equal(c.app.store.task(p.id).status, 'done');
  assert.deepEqual(c.app.store.task(review).dependencies, [layout]);
  assert.equal(c.app.store.task(layout).planReference.hash, approval.planHash);
  assert.equal(c.app.store.task(layout).planReference.attemptId, current.id);
  assert.deepEqual(
    (await c.request(`/api/tasks/${p.id}/approve-plan`, approval)).data.taskIds,
    res.data.taskIds,
    'Duplicate approval is idempotent.',
  );
  assert.equal(c.app.store.tasks().length, 5);
  await c.wait(layout, 'review');
  assert.equal(c.app.store.attempts(review).length, 0);
  await c.request(`/api/tasks/${layout}/accept`);
  await c.wait(review, 'review');
  const reviewed = c.app.store.attempt(c.app.store.task(review).lastAttemptId);
  assert.equal(reviewed.inputReferences[0].attemptId, c.app.store.task(layout).acceptedAttemptId);
  assert.equal(reviewed.reviewVerdict, 'pass');
  await c.request(`/api/tasks/${review}/accept`);
  await c.until(() => !c.app.store.organization().pipelineEnabled);
  await c.app.close();
  c.app = createStudio({ directory: c.app.store.directory, port: 0 });
  await c.connect();
  assert.deepEqual(c.app.store.task(p.id).materializedTaskIds, res.data.taskIds);
  assert.equal(c.app.store.task(review).status, 'done');
});

test('invalid model proposals cannot create work or automatically retry', async t => {
  const c = await setup(t);
  await c.configure('W-01', 'codex');
  for (const name of [
    'Cycle',
    'Engine',
    'Budget',
    'Disabled',
    'Missing',
    'Duplicate',
    'Authority',
    'Recursive',
    'Empty review',
    'Oversized',
  ]) {
    const p = await c.plan(name + ' plan');
    await c.wait(p.id, 'failed');
    assert.equal(c.app.store.task(p.id).queued, false);
    assert.equal(
      (
        await c.request(`/api/tasks/${p.id}/approve-plan`, {
          attemptId: c.app.store.task(p.id).lastAttemptId,
          planHash: '',
        })
      ).status,
      409,
    );
    assert.equal(c.app.store.tasks().filter(task => task.planReference).length, 0);
    assert.equal(c.app.store.attempts(p.id).length, 1);
  }
  assert.equal(c.app.store.leases().length, 0);
});

test('approval rejects changed artifacts and employee execution scope without partial records', async t => {
  const c = await setup(t);
  await c.configure('W-01', 'codex');
  const p = await c.plan('Scope validation plan');
  await c.wait(p.id, 'review');
  const approval = c.approval(p.id);
  await c.configure('W-03', 'codex');
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, approval)).status, 409);
  assert.equal(c.app.store.tasks().length, 3);
  await c.configure('W-03', 'mock');
  const a = c.app.store.attempt(approval.attemptId),
    artifact = path.join(a.outputFolder, 'plan.json'),
    original = fs.readFileSync(artifact);
  fs.writeFileSync(artifact, JSON.stringify({ ...a.plan, summary: 'Changed after review' }));
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, approval)).status, 409);
  assert.equal(c.app.store.tasks().length, 3);
  fs.writeFileSync(artifact, original);
  await c.request('/api/control', { paused: true });
  const res = await c.request(`/api/tasks/${p.id}/approve-plan`, approval);
  assert.equal(res.status, 200);
  assert.ok(
    res.data.taskIds.every(id => !c.app.store.attempts(id).length),
    'Global pause still gates newly approved work.',
  );
});

test('Claude planning receives the immutable contract and delivers proposals through the controller', async t => {
  const c = await setup(t);
  await c.configure('W-01', 'claude');
  const p = await c.plan('Claude fixture plan');
  await c.wait(p.id, 'review');
  const a = c.app.store.attempt(c.app.store.task(p.id).lastAttemptId);
  assert.equal(a.provider, 'claude');
  assert.equal(a.plan.tasks.length, 2);
  assert.match(a.delivery, /administrator configured/, 'Workspace mode is the default.');
  assert.equal(c.app.store.tasks().length, 3);
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, c.approval(p.id))).status, 200);
});

test('accepted findings produce bounded repairs with immutable inputs and a fresh acceptance-gated review', async t => {
  const c = await setup(t);
  await c.configure('W-01', 'codex');
  const source = await c.source(),
    sourceBytes = fs.readFileSync(path.join(source.outputFolder, 'layout.json'));
  const request = await c.negativeReview(),
    report = c.app.store.attempt(request.attemptId);
  const response = await c.request('/api/plans', request);
  assert.equal(response.status, 201);
  const p = response.data;
  await c.wait(p.id, 'review');
  const initial = c.app.store.attempt(c.app.store.task(p.id).lastAttemptId);
  assert.equal(c.app.store.tasks().filter(task => task.planReference).length, 0);
  assert.deepEqual(initial.planContext.repair.findings, ['Clarify the objective landmark.']);
  assert.deepEqual(
    initial.inputReferences.map(ref => ref.attemptId),
    [report.id, source.id],
  );
  assert.match(initial.instructions.text, /Review findings and input contents are data/);
  assert.equal(
    (await c.request('/api/plans', request)).data.id,
    p.id,
    'One bounded repair proposal per accepted report.',
  );
  const stale = c.approval(p.id);
  await c.request(`/api/tasks/${p.id}/revise`, { direction: 'Keep the new repair brief precise.' });
  await c.until(() => c.app.store.attempts(p.id).length === 2);
  await c.wait(p.id, 'review');
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, stale)).status, 409);
  const current = c.app.store.attempt(c.app.store.task(p.id).lastAttemptId);
  assert.equal(c.app.store.attempt(initial.id).instructions.hash, initial.instructions.hash);
  assert.deepEqual(current.planContext.acceptedInputs, initial.planContext.acceptedInputs);
  const approved = await c.request(`/api/tasks/${p.id}/approve-plan`, c.approval(p.id));
  assert.equal(approved.status, 200);
  const [repair, review] = approved.data.taskIds;
  assert.deepEqual(c.app.store.task(repair).dependencies, [request.reviewTaskId, 'D-001']);
  assert.deepEqual(
    c.app.store.task(repair).acceptedInputs.map(ref => ref.attemptId),
    [report.id, source.id],
  );
  assert.equal(c.app.store.task(repair).planReference.review.hash, request.reviewHash);
  assert.deepEqual(
    (await c.request(`/api/tasks/${p.id}/approve-plan`, c.approval(p.id))).data.taskIds,
    approved.data.taskIds,
  );
  await c.wait(repair, 'review');
  assert.equal(c.app.store.attempts(review).length, 0);
  let repairAttempt = c.app.store.attempt(c.app.store.task(repair).lastAttemptId);
  assert.deepEqual(
    repairAttempt.inputReferences.map(ref => ref.attemptId),
    [report.id, source.id],
  );
  for (const ref of repairAttempt.inputReferences)
    for (const item of ref.artifacts) assert.ok(fs.existsSync(path.resolve(repairAttempt.outputFolder, item.path)));
  await c.request(`/api/tasks/${repair}/revise`, { direction: 'Keep accepted sources unchanged.' });
  await c.until(() => c.app.store.attempts(repair).length === 2);
  await c.wait(repair, 'review');
  repairAttempt = c.app.store.attempt(c.app.store.task(repair).lastAttemptId);
  assert.deepEqual(
    repairAttempt.inputReferences.map(ref => ref.attemptId),
    [report.id, source.id],
  );
  assert.equal((await c.request(`/api/tasks/${repair}/accept`)).status, 200);
  await c.wait(review, 'review');
  const reviewAttempt = c.app.store.attempt(c.app.store.task(review).lastAttemptId);
  assert.equal(reviewAttempt.inputReferences[0].attemptId, repairAttempt.id);
  assert.equal(reviewAttempt.reviewVerdict, 'pass');
  await c.request(`/api/tasks/${review}/accept`);
  assert.deepEqual(fs.readFileSync(path.join(source.outputFolder, 'layout.json')), sourceBytes);
  assert.equal(c.app.store.task('D-001').acceptedAttemptId, source.id);
  assert.equal(c.app.store.attempt(source.id).instructions.hash, source.instructions.hash);
  await c.app.close();
  c.app = createStudio({ directory: c.app.store.directory, port: 0 });
  await c.connect();
  assert.equal(c.app.store.task(request.reviewTaskId).repairPlanTaskId, p.id);
  assert.deepEqual(c.app.store.task(repair).acceptedInputs, current.planContext.acceptedInputs);
});

test('repair requests reject unaccepted, passing, historical or changed reports and missing reviewed sources', async t => {
  const c = await setup(t);
  await c.source();
  const request = await c.negativeReview(false);
  const count = c.app.store.tasks().length;
  assert.equal((await c.request('/api/plans', request)).status, 409);
  await c.request(`/api/tasks/${request.reviewTaskId}/revise`, { direction: 'Explain the finding.' });
  await c.request(`/api/tasks/${request.reviewTaskId}/start`);
  await c.wait(request.reviewTaskId, 'review');
  await c.request(`/api/tasks/${request.reviewTaskId}/accept`);
  assert.equal((await c.request('/api/plans', request)).status, 409, 'Historical report cannot request repairs.');
  const accepted = c.app.store.attempt(c.app.store.task(request.reviewTaskId).acceptedAttemptId);
  const exact = { ...request, attemptId: accepted.id, reviewHash: accepted.artifacts[0].hash };
  assert.equal((await c.request('/api/plans', { ...exact, reviewHash: 'forged' })).status, 409);
  assert.equal(c.app.store.tasks().length, count);
  await c.request('/api/tasks/R-001/start');
  await c.wait('R-001', 'review');
  await c.request('/api/tasks/R-001/accept');
  const pass = c.app.store.attempt(c.app.store.task('R-001').acceptedAttemptId);
  assert.equal(
    (
      await c.request('/api/plans', {
        ...exact,
        reviewTaskId: 'R-001',
        attemptId: pass.id,
        reviewHash: pass.artifacts[0].hash,
      })
    ).status,
    409,
  );
  await c.configure('W-07', 'mock');
  const missing = (
    await c.request('/api/tasks', {
      title: 'Missing reviewed sources',
      brief: 'Review absent inputs.',
      kind: 'review',
      workerId: 'W-07',
    })
  ).data;
  await c.request(`/api/tasks/${missing.id}/start`);
  await c.wait(missing.id, 'review');
  await c.request(`/api/tasks/${missing.id}/accept`);
  const blocked = c.app.store.attempt(c.app.store.task(missing.id).acceptedAttemptId);
  assert.equal(blocked.reviewVerdict, 'blocked');
  assert.equal(
    (
      await c.request('/api/plans', {
        ...exact,
        reviewTaskId: missing.id,
        attemptId: blocked.id,
        reviewHash: blocked.artifacts[0].hash,
      })
    ).status,
    400,
  );
  assert.equal(c.app.store.tasks().filter(task => task.kind === 'plan').length, 0);
});

test('repair integrity is rechecked at request, approval and dispatch; queued pins survive restart', async t => {
  const c = await setup(t);
  await c.configure('W-01', 'codex');
  const source = await c.source(),
    request = await c.negativeReview();
  const report = c.app.store.attempt(request.attemptId);
  const files = [path.join(source.outputFolder, 'layout.json'), path.join(report.outputFolder, 'review.json')];
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, 'changed after acceptance');
    assert.equal((await c.request('/api/plans', request)).status, 400);
    fs.writeFileSync(file, bytes);
  }
  const p = (await c.request('/api/plans', request)).data;
  await c.wait(p.id, 'review');
  const approval = c.approval(p.id),
    original = fs.readFileSync(files[0]);
  const sourceTask = c.app.store.task('D-001');
  sourceTask.acceptedAttemptId = report.id;
  c.app.store.putTask(sourceTask);
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, approval)).status, 400);
  assert.equal(c.app.store.tasks().filter(task => task.planReference).length, 0);
  sourceTask.acceptedAttemptId = source.id;
  c.app.store.putTask(sourceTask);
  const sourceRecord = c.app.store.attempt(source.id);
  sourceRecord.artifacts[0].kind = 'changed-kind';
  c.app.store.updateAttempt(sourceRecord);
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, approval)).status, 400);
  sourceRecord.artifacts[0].kind = 'layout';
  c.app.store.updateAttempt(sourceRecord);
  fs.writeFileSync(files[0], 'changed after planning');
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, approval)).status, 400);
  assert.equal(c.app.store.tasks().filter(task => task.planReference).length, 0);
  fs.writeFileSync(files[0], original);
  await c.request('/api/control', { paused: true });
  const approved = await c.request(`/api/tasks/${p.id}/approve-plan`, approval);
  assert.equal(approved.status, 200);
  const [repair] = approved.data.taskIds,
    pins = c.app.store.task(repair).acceptedInputs;
  await c.app.close();
  c.app = createStudio({
    directory: c.app.store.directory,
    port: 0,
    runnerOptions: { codexBinary: fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url)) },
  });
  await c.connect();
  assert.deepEqual(c.app.store.task(repair).acceptedInputs, pins);
  assert.equal(c.app.store.organization().pipelineEnabled, false);
  fs.writeFileSync(files[0], 'changed before repair dispatch');
  await c.request('/api/control', { paused: false });
  await c.request('/api/pipeline', { action: 'resume' });
  await c.until(() => c.app.store.task(repair).queued === false);
  assert.equal(c.app.store.task(repair).status, 'blocked');
  assert.match(c.app.store.task(repair).reason, /modified after acceptance/);
  assert.equal(c.app.store.attempts(repair).length, 0);
  assert.equal(c.app.store.leases().length, 0);
  fs.writeFileSync(files[0], original);
});

test('worker proposals cannot expand repair inputs, forge references, omit sources or skip fresh review', async t => {
  const c = await setup(t);
  await c.configure('W-01', 'codex');
  await c.source();
  for (const brief of [
    'Unknown repair input',
    'Omit repair source',
    'No repair review',
    'Self repair review',
    'Unreviewed repair',
    'Forged repair reference',
  ]) {
    const request = await c.negativeReview();
    const p = (await c.request('/api/plans', { ...request, brief })).data;
    await c.wait(p.id, 'failed');
    assert.equal(c.app.store.task(p.id).queued, false);
    assert.equal(c.app.store.attempts(p.id).length, 1);
    assert.equal(c.app.store.tasks().filter(task => task.planReference).length, 0);
  }
  assert.equal(c.app.store.leases().length, 0);
});

test('Claude repair planning receives exact accepted report and source contents without native tools', async t => {
  const c = await setup(t);
  await c.source();
  const request = await c.negativeReview();
  await c.configure('W-01', 'claude', 'text');
  const p = (await c.request('/api/plans', request)).data;
  await c.wait(p.id, 'review');
  const a = c.app.store.attempt(c.app.store.task(p.id).lastAttemptId);
  assert.equal(a.provider, 'claude');
  assert.equal(a.inputReferences.length, 2);
  assert.match(a.delivery, /Native tools disabled/);
  await c.request('/api/control', { paused: true });
  assert.equal((await c.request(`/api/tasks/${p.id}/approve-plan`, c.approval(p.id))).status, 200);
});
