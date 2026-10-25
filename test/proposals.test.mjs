import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { describeTask, waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { hash, validateComplexity } from '../src/core/contracts.mjs';
import { stageProposedWork, startSprint, approveWork, denyWork, closeStartedWork } from '../src/core/proposals.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { validatePlan } from '../src/core/planning.mjs';
import { validateBreakdown, validateStoryPaths } from '../src/connectors/source-changes.mjs';
import { sourcePlan, sourceContext, checkReport } from '../src/connectors/source-checks.mjs';
import { measuredSourceEvidence } from '../src/connectors/source-changes.mjs';
import { acceptedReference } from '../src/core/artifacts.mjs';
import { saveProjectOrganization } from '../src/core/project-organization.mjs';

const jobs = [
  {
    key: 'first',
    title: 'First bounded fixture',
    kind: 'general',
    workerId: 'W-03',
    brief: 'Write fixture notes.',
    acceptance: 'Recorded staged evidence.',
    dependencies: [],
    resources: ['document:sprint-fixture'],
    maxSeconds: 30,
    maxAttempts: 1,
  },
  {
    key: 'second',
    title: 'Follow up on accepted fixture',
    kind: 'general',
    workerId: 'W-04',
    brief: 'Use the accepted fixture.',
    acceptance: 'Traceable staged evidence.',
    dependencies: ['first'],
    resources: ['document:sprint-fixture'],
    maxSeconds: 30,
    maxAttempts: 1,
  },
];
const proposer = {
  kind: 'test:proposer',
  version: 'proposer-v1',
  label: 'Model-free proposal',
  creatable: true,
  autoProposeWork: true,
  requiredCapabilities: ['text-output'],
  requiredResources: [],
  instructions: () => ({ scopeNote: 'Model-free proposal fixture.' }),
  simulate: () => ({ artifact: 'proposal.json', data: { tasks: jobs }, checks: [] }),
  validateOutput: ({ readArtifact }) => {
    assert.deepEqual(JSON.parse(readArtifact('proposal.json')).tasks, jobs);
  },
  proposeWork: ({ readArtifact }) => ({
    path: 'proposal.json',
    tasks: JSON.parse(readArtifact('proposal.json')).tasks,
  }),
};
async function setup(t, backendOnly = false, tasks = [proposer]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-proposals-')),
    registries = createRegistries();
  registries.workflows.register({ id: 'proposal-fixtures', version: 'proposal-fixtures-v1', tasks });
  const delay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '15';
  const c = { directory, registries, app: createStudio({ directory, port: 0, runnerOptions: { registries } }) };
  c.connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  if (!backendOnly) await c.connect();
  t.after(async () => {
    await c.app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
  });
  c.request = async (url, data = {}) => {
    if (backendOnly) {
      try {
        const [, , , id, action] = url.split('/'),
          task = c.app.store.task(id);
        const result =
          action === 'approve-work'
            ? approveWork(c.app.store, c.registries, task)
            : action === 'deny-work'
              ? denyWork(c.app.store, task, data.reason)
              : action === 'accept'
                ? acceptAttempt(c.app.store, c.registries, task)
                : c.app.runner.start(id);
        return { status: 200, data: result };
      } catch (error) {
        return { status: 400, data: { error: error.message } };
      }
    }
    const response = await fetch(c.origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  // A task blocked before dispatch has no attempt to return.
  c.wait = async (id, status = 'review') => {
    const task = await waitFor(
      () => {
        const task = c.app.store.task(id);
        return task.status === status && task;
      },
      `task ${id} to be ${status}`,
      {
        interval: 10,
        detail: () => {
          const task = c.app.store.task(id);
          return describeTask(task, task.lastAttemptId && c.app.store.attempt(task.lastAttemptId));
        },
      },
    );
    return task.lastAttemptId && c.app.store.attempt(task.lastAttemptId);
  };
  c.source = async (kind = proposer.kind) => {
    const created = await c.request('/api/tasks', {
      title: 'Team proposal fixture',
      brief: 'Propose two bounded tasks.',
      kind,
      workerId: 'W-01',
    });
    assert.equal(created.status, 201);
    assert.equal((await c.request(`/api/tasks/${created.data.id}/start`)).status, 202);
    const attempt = await c.wait(created.data.id),
      task = c.app.store.task(created.data.id);
    return {
      task,
      attempt,
      ids: task.proposedTaskIds,
      evidence: { attemptId: attempt.id, proposalHash: attempt.artifacts[0].hash },
    };
  };
  c.accept = async id => {
    const result = await c.request(`/api/tasks/${id}/accept`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
  };
  return c;
}

test('validated team proposals appear in Planned before acceptance and cannot dispatch or approve themselves', async t => {
  const c = await setup(t),
    { task, attempt, ids, evidence } = await c.source();
  assert.equal(ids.length, 2);
  assert.equal(c.app.store.leases().length, 0);
  for (const id of ids) {
    const draft = c.app.store.task(id);
    assert.equal(draft.status, 'backlog');
    assert.equal(draft.approval.status, 'pending');
    assert.equal(draft.queued, false);
    assert.equal((await c.request(`/api/tasks/${id}/start`)).status, 400);
    const early = await c.request(`/api/tasks/${id}/approve-work`);
    assert.equal(early.status, 400);
    assert.match(
      early.data.error,
      new RegExp(`^Accept ${task.id} \\(.+\\) first\\. This proposed work uses its accepted result\\.$`),
    );
    assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: [id] })).status, 400);
    assert.equal(c.app.store.attempts(id).length, 0);
  }
  await c.accept(task.id);
  assert.deepEqual((await c.request(`/api/tasks/${task.id}/propose-work`, evidence)).data.taskIds, ids);
  assert.equal(c.app.store.tasks().filter(task => task.proposalReference).length, 2);
  assert.equal(c.app.store.task(ids[0]).status, 'backlog');
  assert.equal(c.app.store.attempt(attempt.id).instructions.hash, attempt.instructions.hash);
});

test('individual work decisions preserve denied history and project boundaries without starting attempts', async t => {
  const c = await setup(t),
    source = await c.source();
  await c.accept(source.task.id);
  const project = (await c.request('/api/projects', { name: 'Other project', goal: '', direction: '' })).data;
  for (const id of source.ids) c.app.runner.autonomy.attention(c.app.store.task(id), 'Approve or deny proposed work.');
  assert.equal((await c.request(`/api/tasks/${source.ids[0]}/approve-work`, { projectId: project.id })).status, 400);
  assert.equal(c.app.store.task(source.ids[0]).autonomyNote, 'Approve or deny proposed work.');
  assert.equal(
    (await c.request(`/api/tasks/${source.ids[1]}/deny-work`, { reason: 'Outside this sprint.' })).status,
    200,
  );
  assert.equal((await c.request(`/api/tasks/${source.ids[1]}/start`)).status, 400);
  assert.equal(c.app.store.task(source.ids[1]).autonomyNote, undefined);
  assert.equal(c.app.store.task(source.ids[1]).reason, 'Outside this sprint.');
  assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: [source.ids[1]] })).status, 400);
  assert.equal((await c.request(`/api/tasks/${source.ids[0]}/approve-work`)).status, 200);
  assert.equal(c.app.store.task(source.ids[0]).status, 'ready');
  assert.equal(c.app.store.task(source.ids[0]).autonomyNote, undefined);
  assert.equal(c.app.store.task(source.ids[0]).reason, '');
  assert.equal(c.app.store.attempts(source.ids[0]).length, 0);
  assert.equal((await c.request(`/api/tasks/${source.ids[1]}/approve-work`)).status, 400);
  // Approved work that never started can still be withdrawn; its approval is retained as history.
  assert.equal((await c.request(`/api/tasks/${source.ids[0]}/deny-work`, { reason: 'Stale.' })).status, 200);
  const withdrawn = c.app.store.task(source.ids[0]);
  assert.equal(withdrawn.status, 'denied');
  assert.equal(withdrawn.approval.previous.status, 'approved');
  assert.equal((await c.request(`/api/tasks/${source.ids[0]}/start`)).status, 400);
  assert.equal((await c.request(`/api/tasks/${source.ids[0]}/deny-work`)).status, 400);
  await c.app.close();
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { registries: c.registries } });
  await c.connect();
  assert.equal(c.app.store.task(source.ids[1]).approval.reason, 'Outside this sprint.');
  assert.equal(c.app.store.task(source.ids[1]).status, 'denied');
  assert.equal(c.app.store.task(source.ids[0]).proposalReference.hash, source.evidence.proposalHash);
  assert.equal(c.app.store.task(source.ids[0]).status, 'denied');
});

test('sprint selection is atomic, starts only selected eligible work and pins exact accepted proposal inputs', async t => {
  const c = await setup(t),
    source = await c.source();
  await c.accept(source.task.id);
  const sprint = taskIds => c.request('/api/sprints', { name: 'Bounded sprint', taskIds });
  assert.equal(
    (await sprint([source.ids[1]])).status,
    400,
    'An unapproved planned prerequisite must also be selected.',
  );
  assert.equal((await sprint([source.ids[0], 'missing-task'])).status, 400);
  assert.equal(c.app.store.task(source.ids[0]).approval.status, 'pending');
  assert.equal(c.app.store.setting('sprint-missing'), null);
  const selected = await sprint([source.ids[0]]);
  assert.equal(selected.status, 201, JSON.stringify(selected.data));
  const first = await c.wait(source.ids[0]);
  assert.equal(first.inputReferences[0].attemptId, source.attempt.id);
  assert.equal(first.inputReferences[0].artifacts[0].hash, source.evidence.proposalHash);
  assert.equal(c.app.store.task(source.ids[1]).status, 'backlog');
  assert.equal(c.app.store.attempts(source.ids[1]).length, 0);
  assert.equal((await sprint([source.ids[0]])).status, 400, 'A retry cannot duplicate sprint membership.');
  const secondSprint = await sprint([source.ids[1]]);
  assert.equal(secondSprint.status, 201);
  assert.equal(
    c.app.store.attempts(source.ids[1]).length,
    0,
    'An approved sprint still waits for accepted prerequisite results.',
  );
  await c.accept(source.ids[0]);
  await c.wait(source.ids[1]);
  const state = await (await fetch(c.origin + '/api/state')).json();
  assert.equal(state.sprints.length, 2);
  await c.app.close();
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { registries: c.registries } });
  await c.connect();
  assert.equal(c.app.store.task(source.ids[1]).status, 'review');
  assert.equal(c.app.store.organization().pipelineEnabled, false);
});

test('changed proposal artifacts and changed employee scope reject sprint approval without partial state', async t => {
  const c = await setup(t),
    source = await c.source();
  await c.accept(source.task.id);
  const file = path.join(source.attempt.outputFolder, 'proposal.json'),
    original = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ tasks: [] }));
  assert.equal((await c.request('/api/sprints', { name: 'Reject corruption', taskIds: source.ids })).status, 400);
  assert.ok(source.ids.every(id => c.app.store.task(id).approval.status === 'pending'));
  assert.equal((await c.request(`/api/tasks/${source.task.id}/propose-work`, source.evidence)).status, 400);
  fs.writeFileSync(file, original);
  const org = c.app.store.organization();
  org.workers.find(worker => worker.id === 'W-04').model = 'changed';
  c.app.store.setOrganization(org);
  assert.equal((await c.request('/api/sprints', { name: 'Reject changed scope', taskIds: source.ids })).status, 400);
  assert.ok(source.ids.every(id => c.app.store.task(id).approval.status === 'pending'));
  assert.equal(c.app.store.leases().length, 0);
});

test('director-created Planned work supports bounded sprint selection without inventing worker evidence', async t => {
  const c = await setup(t),
    create = title =>
      c.request('/api/tasks', {
        title,
        brief: 'Bounded fixture notes.',
        acceptance: 'Inspect fixture notes.',
        kind: 'general',
        workerId: 'W-03',
        planned: true,
        maxSeconds: 600,
      });
  const first = (await create('Director draft one')).data,
    second = (await create('Director draft two')).data;
  assert.equal(first.status, 'backlog');
  assert.equal(first.proposalReference, undefined);
  assert.equal(
    (await c.request('/api/sprints', { name: 'Excessive budget', taskIds: [first.id, second.id] })).status,
    400,
  );
  assert.equal(c.app.store.task(first.id).approval.status, 'pending');
  assert.equal((await c.request(`/api/tasks/${second.id}/deny-work`)).status, 200);
  assert.equal(
    (await c.request('/api/sprints', { name: 'Atomic denial', taskIds: [first.id, second.id] })).status,
    400,
  );
  assert.equal(c.app.store.task(first.id).approval.status, 'pending');
  assert.equal((await c.request(`/api/tasks/${first.id}/approve-work`)).status, 200);
  assert.equal(c.app.store.attempts(first.id).length, 0);
});

test('producer plan evidence can be accepted into Planned without dispatch, while legacy bulk approval reuses draft identities', async t => {
  const c = await setup(t);
  const create = async () => {
    const result = await c.request('/api/plans', {
      title: 'Model-free planning ceremony fixture',
      brief: 'Propose bounded logical work.',
      workerId: 'W-01',
    });
    const attempt = await c.wait(result.data.id),
      item = attempt.artifacts.find(item => item.path === 'plan.json');
    return { id: result.data.id, attemptId: attempt.id, proposalHash: item.hash };
  };
  const first = await create(),
    body = { attemptId: first.attemptId, proposalHash: first.proposalHash };
  const staged = await c.request(`/api/tasks/${first.id}/accept-proposal`, body);
  assert.equal(staged.status, 200, JSON.stringify(staged.data));
  assert.equal(c.app.store.task(first.id).status, 'done');
  assert.ok(staged.data.taskIds.every(id => c.app.store.task(id).status === 'backlog' && !c.app.store.task(id).queued));
  assert.equal(c.app.store.attempts(staged.data.taskIds[0]).length, 0);
  const second = await create(),
    drafts = await c.request(`/api/tasks/${second.id}/propose-work`, {
      attemptId: second.attemptId,
      proposalHash: second.proposalHash,
    });
  const approved = await c.request(`/api/tasks/${second.id}/approve-plan`, {
    attemptId: second.attemptId,
    planHash: second.proposalHash,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.deepEqual(approved.data.taskIds, drafts.data.taskIds);
  await c.wait(approved.data.taskIds[0]);
});

function seedSourceReview(c, complexity, version = 'source-review-v2', suffix = 'default') {
  const source = {
    id: 'fixture-morgan-' + suffix,
    kind: 'studio-development:review',
    workerId: 'W-07',
    title: 'Accepted source review fixture',
    brief: 'Fixture evidence only.',
    dependencies: [],
    resources: [],
    status: 'done',
    acceptedAttemptId: 'fixture-morgan-attempt-' + suffix,
    lastAttemptId: 'fixture-morgan-attempt-' + suffix,
    maxSeconds: 30,
    maxAttempts: 1,
  };
  const identity = {
    taskId: 'fixture-check',
    attemptId: 'fixture-check-attempt',
    path: 'check-report.json',
    hash: hash('fixture-report'),
    sourceHash: hash('fixture-source'),
  };
  const report = {
    schemaVersion: 'source-review-v1',
    source: identity,
    verdict: 'needs-work',
    summary: 'Model-free proposal fixture.',
    findings: ['Fixture finding.'],
    proposal: {
      ...(complexity !== undefined ? { complexity } : {}),
      title: 'Correct a bounded source check',
      reason: 'Fixture source behavior.',
      files: ['src/core/workflows.mjs'],
      scope: 'One bounded comparison.',
      acceptance: 'Relevant model-free behavior passes.',
    },
    unperformedChecks: ['Browser layout', 'Engine integration', 'Playtest'],
  };
  const output = path.join(c.directory, 'jobs', source.acceptedAttemptId, 'output');
  fs.mkdirSync(output, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(report));
  fs.writeFileSync(path.join(output, 'source-review.json'), bytes);
  const attempt = {
    id: source.acceptedAttemptId,
    taskId: source.id,
    workerId: source.workerId,
    status: 'accepted',
    assignment: source,
    contracts: { task: { kind: source.kind, version } },
    sourceReview: { ...identity, passed: true, files: report.proposal.files },
    artifacts: [{ path: 'source-review.json', kind: 'source-review', hash: hash(bytes), bytes: bytes.length }],
    result: {
      taskId: source.id,
      outcome: 'completed',
      summary: 'Model-free source proposal fixture.',
      artifacts: [{ path: 'source-review.json', kind: 'source-review' }],
      checks: [],
      issues: [],
      handoff: 'Fixture only.',
    },
  };
  c.app.store.putTask(source);
  c.app.store.insertAttempt(attempt, { text: 'Fixture instructions.', hash: hash('fixture-instructions') });
  return { source, attempt: c.app.store.attempt(attempt.id), report, bytes, output };
}

test('Morgan source proposals create one Planned improvement; approval cannot bypass exact source-check evidence', async t => {
  const c = await setup(t),
    { source, attempt } = seedSourceReview(c, 1);
  let ids;
  c.app.store.tx(() => {
    ids = stageProposedWork(c.app.store, c.registries, source, attempt);
  });
  assert.equal(ids.length, 1);
  assert.equal(c.app.store.task(ids[0]).status, 'backlog');
  const sprint = await c.request('/api/sprints', { name: 'Source scope fixture', taskIds: ids });
  assert.equal(sprint.status, 201, JSON.stringify(sprint.data));
  await c.wait(ids[0], 'blocked');
  assert.match(c.app.store.task(ids[0]).reason, /source-check evidence is missing/);
  assert.equal(c.app.store.attempts(ids[0]).length, 0);
  assert.equal(c.app.store.leases().length, 0);
});

test('source story complexity materializes exact Planned limits and invalid complexity creates no drafts', async t => {
  const c = await setup(t);
  for (const complexity of [1, 2, 3, 5, 8]) {
    const { source, attempt } = seedSourceReview(c, complexity, 'source-review-v2', String(complexity)),
      [id] = stageProposedWork(c.app.store, c.registries, source, attempt),
      draft = c.app.store.task(id);
    assert.equal(draft.status, 'backlog');
    assert.equal(draft.approval.status, 'pending');
    assert.equal(draft.complexity, complexity);
    assert.equal(draft.maxSeconds, validateComplexity(complexity).maxSeconds);
    assert.equal(draft.maxAttempts, validateComplexity(complexity).maxAttempts);
    assert.equal(draft.proposalReference.hash, attempt.artifacts[0].hash);
    assert.equal(c.app.store.attempts(id).length, 0);
  }
  for (const [index, complexity] of [undefined, 13, '2', null].entries()) {
    const { source, attempt } = seedSourceReview(c, complexity, 'source-review-v2', 'invalid-' + index),
      count = c.app.store.tasks().length;
    assert.throws(() => stageProposedWork(c.app.store, c.registries, source, attempt), /complexity.*smaller stories/);
    assert.equal(c.app.store.tasks().length, count);
    assert.equal(c.app.store.task(source.id).proposedTaskIds, undefined);
  }
});

test('recorded historical source-review-v1 proposals remain approvable and selectable without rewriting evidence', async t => {
  const c = await setup(t);
  for (const mode of ['approve', 'sprint']) {
    const { source, attempt, bytes, output } = seedSourceReview(c, undefined, 'source-review-v1', mode),
      original = JSON.stringify(c.app.store.attempt(attempt.id)),
      [id] = stageProposedWork(c.app.store, c.registries, source, attempt),
      draft = c.app.store.task(id);
    assert.equal(draft.complexity, undefined);
    assert.equal(draft.maxSeconds, 600);
    assert.equal(draft.maxAttempts, 2);
    // Approval must still revalidate the exact accepted artifact.
    fs.appendFileSync(path.join(output, 'source-review.json'), ' ');
    assert.equal((await c.request(`/api/tasks/${id}/approve-work`)).status, 400);
    assert.equal(c.app.store.task(id).approval.status, 'pending');
    fs.writeFileSync(path.join(output, 'source-review.json'), bytes);
    if (mode === 'approve') {
      const result = await c.request(`/api/tasks/${id}/approve-work`);
      assert.equal(result.status, 200, JSON.stringify(result.data));
    } else {
      const result = await c.request('/api/sprints', { name: 'Historical proposal', taskIds: [id] });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal(result.data.totalAttemptSeconds, 1200);
    }
    assert.equal(c.app.store.task(id).approval.status, 'approved');
    assert.deepEqual(c.app.store.task(id).proposalReference, draft.proposalReference);
    assert.equal(JSON.stringify(c.app.store.attempt(attempt.id)), original);
    assert.deepEqual(fs.readFileSync(path.join(output, 'source-review.json')), bytes);
  }
  const { source, attempt } = seedSourceReview(c, 13, 'source-review-v1', 'bad-legacy');
  assert.throws(() => stageProposedWork(c.app.store, c.registries, source, attempt), /complexity.*smaller stories/);
});

test('plan complexity limits are per story while legacy attempt products retain their aggregate budget', () => {
  const context = {
    workers: [{ id: 'W-03' }],
    kinds: ['general'],
    reviewKinds: [],
    resourcePrefixes: [''],
    acceptedInputs: [],
    proposalSource: 'T-source',
    limits: { maxTasks: 10, maxSeconds: 600, maxAttempts: 3, totalAttemptSeconds: 1800 },
  };
  const story = { ...jobs[0], complexity: 8, ...validateComplexity(8) },
    plan = tasks => ({
      version: 'studio-plan-v1',
      summary: 'Bounded fixture',
      assumptions: [],
      directorDecisions: [],
      tasks,
    });
  assert.equal(validatePlan(plan([story]), context).totalAttemptSeconds, 8100);
  for (const changes of [
    { maxSeconds: 2701 },
    { maxSeconds: 900 },
    { maxAttempts: 4 },
    { maxAttempts: 2 },
    { complexity: 13 },
    { complexity: '8' },
  ])
    assert.throws(() => validatePlan(plan([{ ...story, ...changes }]), context), /complexity/);
  const stories = Array.from({ length: 10 }, (_, i) => ({ ...story, key: 'story-' + i }));
  assert.deepEqual(validatePlan(plan(stories), context), { tasks: 10, totalAttemptSeconds: 81000 });
  for (const limit of [undefined, 1800, 900, 2400]) {
    const limits = { ...context.limits },
      budget = limit ?? 1800;
    if (limit === undefined) delete limits.totalAttemptSeconds;
    else limits.totalAttemptSeconds = limit;
    const configured = { ...context, limits },
      legacy = ['legacy-first', 'legacy-second'].map(key => ({
        ...jobs[0],
        key,
        maxSeconds: budget / 6,
        maxAttempts: 3,
      }));
    for (const prefix of [[], stories.slice(0, 2)]) {
      const tasks = [...prefix, ...legacy];
      assert.deepEqual(validatePlan(plan(tasks), configured), {
        tasks: tasks.length,
        totalAttemptSeconds: prefix.length * 8100 + budget,
      });
      assert.throws(() => validatePlan(plan([...tasks, { ...jobs[0], key: 'extra' }]), configured), {
        message: `Plan exceeds the ${budget}-second total attempt time budget.`,
      });
    }
  }
  for (const changes of [
    { maxSeconds: 601 },
    { maxSeconds: 4 },
    { maxSeconds: 30.5 },
    { maxAttempts: 4 },
    { maxAttempts: 0 },
    { maxAttempts: 1.5 },
  ])
    assert.throws(() => validatePlan(plan([story, { ...jobs[0], key: 'extra', ...changes }]), context), {
      message: 'Plan exceeds a task execution limit.',
    });
  assert.throws(() => validatePlan(plan([story]), { ...context, proposalSource: undefined }), /unsupported fields/);
});

function seedSprintTask(c, id, overrides = {}) {
  const task = {
    ...jobs[0],
    id,
    team: c.app.store.organization().workers.find(worker => worker.id === jobs[0].workerId).team,
    status: 'backlog',
    approval: { status: 'pending' },
    queued: false,
    ...overrides,
  };
  c.app.store.putTask(task);
  return task;
}

test('resolved work decisions clear current attention while rejected decisions and history retain it', async t => {
  const c = await setup(t, true),
    { store, runner } = c.app,
    task = seedSprintTask(c, 'attention', {
      reason: 'Awaiting approval.',
      autonomyNote: 'Approve or deny proposed work.',
    });
  runner.autonomy.attention(task, task.autonomyNote);
  const history = store.events().find(event => event.task_id === task.id && event.kind === 'autonomy_attention');
  const invalid = { ...store.task(task.id), workerId: 'missing' };
  store.putTask(invalid);
  assert.throws(() => approveWork(store, c.registries, invalid));
  assert.equal(store.task(task.id).autonomyNote, task.autonomyNote);
  store.putTask(task);
  approveWork(store, c.registries, store.task(task.id));
  assert.equal(store.task(task.id).autonomyNote, undefined);
  assert.equal(store.task(task.id).reason, '');
  runner.autonomy.attention(store.task(task.id), 'This work needs a decision.');
  denyWork(store, store.task(task.id), 'No longer needed.');
  assert.equal(store.task(task.id).autonomyNote, undefined);
  assert.equal(store.task(task.id).reason, 'No longer needed.');
  assert.ok(store.events().some(event => event.seq === history.seq && event.message === history.message));

  const reviewed = seedSprintTask(c, 'review-attention', {
    approval: { status: 'approved' },
    status: 'review',
    lastAttemptId: 'review-attention-attempt',
    reason: 'Inspect the result.',
    autonomyNote: 'Inspect the result.',
  });
  store.insertAttempt(
    {
      id: reviewed.lastAttemptId,
      taskId: reviewed.id,
      workerId: reviewed.workerId,
      status: 'review',
      assignment: reviewed,
      result: { outcome: 'completed', checks: [] },
      artifacts: [],
    },
    { text: 'Original instructions' },
  );
  closeStartedWork(store, c.registries, store.task(reviewed.id), 'Stopped deliberately.');
  assert.equal(store.task(reviewed.id).autonomyNote, undefined);
  assert.equal(store.task(reviewed.id).reason, 'Stopped deliberately.');
  assert.equal(store.attempt(reviewed.lastAttemptId).status, 'closed');
  assert.equal(store.attempt(reviewed.lastAttemptId).instructions.text, 'Original instructions');
});

test('sprint selection validates exact complexity and legacy per-task limits before any write', async t => {
  const c = await setup(t, true),
    store = c.app.store,
    task = seedSprintTask(c, 'complexity', { complexity: 8, ...validateComplexity(8) });
  // Exercise selection without enabling asynchronous execution.
  let enabled = 0;
  const runner = { registries: c.registries, enablePipeline: () => enabled++ },
    select = ids => startSprint(store, runner, 'project-legacy', 'Complexity sprint', ids);
  for (const approval of ['pending', 'approved']) {
    for (const changes of [
      { maxSeconds: 2701 },
      { maxSeconds: 900 },
      { maxAttempts: 4 },
      { maxAttempts: 2 },
      { complexity: 13 },
      { complexity: '8' },
    ]) {
      const invalid = {
        ...task,
        status: approval === 'pending' ? 'backlog' : 'ready',
        approval: { status: approval },
        ...changes,
      };
      store.putTask(invalid);
      assert.throws(() => select([task.id]), /complexity/);
      assert.deepEqual(store.task(task.id), invalid);
    }
  }
  store.putTask(task);
  const extra = seedSprintTask(c, 'legacy', { maxSeconds: 600, maxAttempts: 3 });
  for (const changes of [
    { maxSeconds: 601 },
    { maxSeconds: 4 },
    { maxSeconds: 30.5 },
    { maxAttempts: 4 },
    { maxAttempts: 0 },
    { maxAttempts: 1.5 },
  ]) {
    const invalid = { ...extra, ...changes };
    store.putTask(invalid);
    assert.throws(() => select([task.id, extra.id]), { message: 'Sprint exceeds a task execution limit.' });
    assert.deepEqual(store.task(task.id), task);
    assert.deepEqual(store.task(extra.id), invalid);
  }
  assert.equal(enabled, 0);
  assert.deepEqual(store.state().sprints, []);
  store.putTask(extra);
  const selected = select([task.id, extra.id]);
  assert.equal(selected.totalAttemptSeconds, 9900);
  assert.equal(enabled, 1);
  for (const id of [task.id, extra.id]) {
    assert.equal(store.task(id).approval.status, 'approved');
    assert.equal(store.task(id).sprintId, selected.id);
    assert.equal(store.task(id).queued, true);
  }
  assert.equal(store.attempts(task.id).length, 0);
  assert.equal(store.leases().length, 0);
});

test('a sprint can select three 5-point stories with their exact individual limits', async t => {
  const c = await setup(t, true),
    store = c.app.store,
    ids = Array.from(
      { length: 3 },
      (_, i) => seedSprintTask(c, 'five-' + i, { complexity: 5, ...validateComplexity(5) }).id,
    );
  let enabled = 0;
  const selected = startSprint(
    store,
    { registries: c.registries, enablePipeline: () => enabled++ },
    'project-legacy',
    'Three stories',
    ids,
  );
  assert.equal(selected.totalAttemptSeconds, 16200);
  assert.deepEqual(selected.taskIds, ids);
  assert.deepEqual(store.setting(selected.id), selected);
  assert.equal(enabled, 1);
  for (const id of ids) {
    assert.equal(store.task(id).approval.status, 'approved');
    assert.equal(store.task(id).queued, true);
    assert.equal(store.attempts(id).length, 0);
  }
});

test('sprints retain the 1800-second legacy aggregate in legacy-only and mixed selections atomically', async t => {
  const c = await setup(t, true),
    store = c.app.store;
  for (const mixed of [false, true]) {
    const prefix = mixed ? 'mixed-' : 'legacy-',
      legacy = [0, 1].map(i => seedSprintTask(c, prefix + i, { maxSeconds: 300, maxAttempts: 3 }).id),
      complexity = mixed ? [seedSprintTask(c, 'eight', { complexity: 8, ...validateComplexity(8) }).id] : [],
      extra = seedSprintTask(c, prefix + 'extra', { maxSeconds: 5, maxAttempts: 1 }),
      ids = [...complexity, ...legacy],
      before = { tasks: store.tasks(), sprints: store.state().sprints, events: store.events() };
    let enabled = 0;
    const runner = { registries: c.registries, enablePipeline: () => enabled++ };
    assert.throws(() => startSprint(store, runner, 'project-legacy', 'Over budget', [...ids, extra.id]), {
      message: 'Sprint exceeds the 1800-second attempt budget.',
    });
    assert.deepEqual({ tasks: store.tasks(), sprints: store.state().sprints, events: store.events() }, before);
    assert.equal(enabled, 0);
    const selected = startSprint(store, runner, 'project-legacy', 'At budget', ids);
    assert.equal(selected.totalAttemptSeconds, mixed ? 9900 : 1800);
    assert.equal(enabled, 1);
    assert.deepEqual(store.task(extra.id), extra);
  }
});

test('sprints reject eleven tasks without partial state and accept ten complexity stories', async t => {
  const c = await setup(t, true),
    store = c.app.store,
    ids = Array.from(
      { length: 11 },
      (_, i) => seedSprintTask(c, 'story-' + i, { complexity: 8, ...validateComplexity(8) }).id,
    ),
    before = store.tasks();
  let enabled = 0;
  const runner = { registries: c.registries, enablePipeline: () => enabled++ };
  assert.throws(() => startSprint(store, runner, 'project-legacy', 'Too many stories', ids), /1 to 10 distinct tasks/);
  assert.deepEqual(store.tasks(), before);
  assert.deepEqual(store.state().sprints, []);
  assert.equal(enabled, 0);
  const selected = startSprint(store, runner, 'project-legacy', 'Ten stories', ids.slice(0, 10));
  assert.equal(selected.totalAttemptSeconds, 81000);
  assert.equal(enabled, 1);
  assert.deepEqual(
    store.task(ids[10]),
    before.find(task => task.id === ids[10]),
  );
});

function seedBreakdown(c, mutate = () => {}) {
  const store = c.app.store,
    suffix = String((c.breakdownCount = (c.breakdownCount || 0) + 1)),
    plan = sourcePlan();
  const seed = (kind, prefix, artifacts, extra = {}, status = 'accepted') => {
    const task = {
        id: prefix + '-task-' + suffix,
        kind,
        workerId: 'W-01',
        team: store.organization().workers[0].team,
        title: 'Model-free breakdown evidence',
        brief: 'Implement the director idea.',
        direction: 'Director fixture idea',
        acceptance: 'Validated evidence.',
        dependencies: [],
        resources: [],
        status: status === 'accepted' ? 'done' : 'review',
        maxSeconds: 180,
        maxAttempts: 2,
      },
      id = prefix + '-attempt-' + suffix,
      output = path.join(c.directory, 'jobs', id, 'output');
    task.lastAttemptId = id;
    if (status === 'accepted') task.acceptedAttemptId = id;
    fs.mkdirSync(output, { recursive: true });
    const items = Object.entries(artifacts).map(([name, { data, kind }]) => {
      const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      fs.writeFileSync(path.join(output, name), bytes);
      return { path: name, kind, hash: hash(bytes), bytes: bytes.length };
    });
    const attempt = {
      id,
      taskId: task.id,
      workerId: task.workerId,
      status,
      assignment: structuredClone(task),
      outputFolder: output,
      artifacts: items,
      ...extra,
      result: {
        taskId: task.id,
        outcome: 'completed',
        summary: 'Protocol fixture, no model calls.',
        artifacts: items.map(({ path, kind }) => ({ path, kind })),
        checks: [],
        issues: [],
        handoff: 'Independent review.',
      },
    };
    store.putTask(task);
    store.insertAttempt(attempt, { text: 'Fixture instructions.', hash: hash('fixture') });
    return { task, attempt: store.attempt(id), output };
  };
  const stdout = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
    execution = { exitCode: 0, signal: null, fixture: false },
    checked = seed(
      'studio-development:checks',
      'breakdown-check',
      {
        'check-report.json': { data: checkReport(plan, execution, stdout, ''), kind: 'source-check-report' },
        'source-context.json': { data: sourceContext(plan, plan.root), kind: 'source-context' },
        'test-output.txt': { data: stdout, kind: 'test-log' },
        'test-errors.txt': { data: '', kind: 'test-log' },
      },
      { sourceCheck: plan, checkExecution: execution },
    ),
    source = measuredSourceEvidence(store, checked.task.id, checked.attempt.id, 'project-legacy'),
    { files, profile, ...identity } = source,
    report = {
      schemaVersion: 'source-breakdown-v1',
      source: identity,
      summary: 'Two linked executable stories.',
      stories: [
        {
          key: 'validate',
          kind: 'studio-development:change',
          workerId: 'W-02',
          title: 'Validate intent',
          scope: 'Implement bounded validation.',
          acceptance: 'Invalid intent creates zero records.',
          complexity: 1,
          dependencies: [],
          files: ['src/core/planning.mjs'],
        },
        {
          key: 'document',
          kind: 'studio-development:change',
          workerId: 'W-02',
          title: 'Document intent',
          scope: 'Explain validated behavior.',
          acceptance: 'The documented contract matches accepted evidence.',
          complexity: 2,
          dependencies: ['validate'],
          files: ['docs/module-contracts.md'],
        },
      ],
    };
  mutate(report, source);
  const proposed = seed(
    'studio-development:breakdown',
    'breakdown',
    {
      'source-breakdown.json': { data: report, kind: 'source-breakdown' },
    },
    {
      sourceBreakdown: source,
      contracts: { task: { kind: 'studio-development:breakdown', version: 'source-breakdown-v1' } },
    },
    'review',
  );
  proposed.task.dependencies = [checked.task.id];
  proposed.attempt.assignment.dependencies = [checked.task.id];
  store.putTask(proposed.task);
  store.updateAttempt(proposed.attempt);
  return { source: proposed.task, attempt: proposed.attempt, output: proposed.output, checked, report };
}

test('breakdown intake creates linked pending Planned stories with exact keyed provenance and retains individual decisions', async t => {
  const c = await setup(t, true),
    store = c.app.store,
    { source, attempt, checked } = seedBreakdown(c),
    ids = stageProposedWork(store, c.registries, source, attempt);
  assert.equal(ids.length, 2);
  for (const [index, id] of ids.entries()) {
    const story = store.task(id);
    assert.equal(story.status, 'backlog');
    assert.equal(story.approval.status, 'pending');
    assert.equal(story.queued, false);
    assert.deepEqual(story.proposalReference, {
      taskId: source.id,
      attemptId: attempt.id,
      path: 'source-breakdown.json',
      hash: attempt.artifacts[0].hash,
      key: ['validate', 'document'][index],
    });
    assert.deepEqual(story.acceptedInputs, [acceptedReference(store, checked.task.id)]);
    assert.equal(story.maxSeconds, validateComplexity(index + 1).maxSeconds);
    assert.equal(story.maxAttempts, validateComplexity(index + 1).maxAttempts);
    assert.equal((await c.request(`/api/tasks/${id}/approve-work`)).status, 400);
    assert.equal((await c.request(`/api/tasks/${id}/start`)).status, 400);
  }
  assert.deepEqual(store.task(ids[1]).dependencies, [source.id, ids[0], checked.task.id]);
  await c.accept(source.id);
  assert.equal(store.task(ids[0]).approval.status, 'pending');
  assert.equal(store.attempts(ids[0]).length, 0);
  assert.equal((await c.request(`/api/tasks/${ids[0]}/approve-work`)).status, 200);
  assert.equal(
    (await c.request(`/api/tasks/${ids[1]}/deny-work`, { reason: 'Director deferred this story.' })).status,
    200,
  );
  const decisions = ids.map(id => store.task(id));
  assert.deepEqual(stageProposedWork(store, c.registries, store.task(source.id), store.attempt(attempt.id)), ids);
  assert.deepEqual(
    ids.map(id => store.task(id)),
    decisions,
  );
  assert.equal(store.leases().length, 0);
});

test('breakdowns accept four 3-point stories and ten 8-point stories without an aggregate time cap', async t => {
  const c = await setup(t, true),
    store = c.app.store;
  for (const [count, complexity] of [
    [4, 3],
    [10, 8],
  ]) {
    const { source, attempt, checked } = seedBreakdown(c, report => {
      report.stories = Array.from({ length: count }, (_, i) => ({
        ...report.stories[0],
        key: 'story-' + i,
        complexity,
        dependencies: i ? ['story-' + (i - 1)] : [],
      }));
    });
    const ids = stageProposedWork(store, c.registries, source, attempt);
    assert.equal(ids.length, count);
    for (const [i, id] of ids.entries()) {
      const task = store.task(id);
      assert.equal(task.complexity, complexity);
      assert.equal(task.maxSeconds, validateComplexity(complexity).maxSeconds);
      assert.equal(task.maxAttempts, validateComplexity(complexity).maxAttempts);
      assert.equal(task.status, 'backlog');
      assert.equal(task.approval.status, 'pending');
      assert.equal(task.queued, false);
      assert.deepEqual(task.dependencies, [source.id, ...(i ? [ids[i - 1]] : []), checked.task.id]);
      assert.deepEqual(task.acceptedInputs, [acceptedReference(store, checked.task.id)]);
      assert.equal(task.proposalReference.hash, attempt.artifacts[0].hash);
      assert.equal(task.proposalReference.key, 'story-' + i);
      assert.equal(store.attempts(id).length, 0);
    }
    assert.deepEqual(stageProposedWork(store, c.registries, source, attempt), ids);
  }
  assert.equal(store.leases().length, 0);
});

test('invalid breakdown intent, graph, execution fields and file scopes create zero drafts', async t => {
  const c = await setup(t, true),
    store = c.app.store;
  const cases = [
    [p => (p.stories = []), /1 to 10 stories/],
    [
      p => (p.stories = Array.from({ length: 11 }, (_, i) => ({ ...p.stories[0], key: 'story-' + i }))),
      /1 to 10 stories/,
    ],
    [p => (p.stories[0].complexity = '2'), /numeric/],
    [p => (p.stories[0].complexity = 13), /smaller stories/],
    [p => (p.stories[1].key = p.stories[0].key), /unique/],
    [p => (p.stories[0].key = '../escape'), /safe identifiers/],
    [p => (p.stories[0].key = '__proto__'), /safe identifiers/],
    [p => (p.stories[0].dependencies = ['document']), /cycle/],
    [p => (p.stories[1].dependencies = ['missing']), /missing prerequisite/],
    [p => (p.stories[0].kind = 'general'), /kind must/],
    [p => (p.stories[0].workerId = 'missing'), /enabled employees/],
    [p => (p.stories[0].maxSeconds = 5), /unsupported fields/],
    [p => (p.stories[0].resources = []), /unsupported fields/],
    [p => (p.command = 'execute'), /unsupported fields/],
    [p => (p.stories[0].title = 'x'.repeat(161)), /title/],
    [p => (p.stories[0].scope = 'x'.repeat(8001)), /scope/],
    [p => (p.stories[0].files = []), /1 to 100 source paths/],
    [p => (p.stories[0].files = Array(101).fill('src/core/planning.mjs')), /1 to 100 source paths/],
    [p => (p.stories[0].files = ['src/core/planning.mjs', 'src/core/planning.mjs']), /each source path once/],
    [p => (p.stories[0].newFiles = ['src/core/planning.mjs']), /each source path once/],
    [p => (p.stories[0].newFiles = 'src/core/new.mjs'), /as arrays/],
    // New files must be new, ignoring case, and never instructions, manifests or formatter configuration.
    ...[
      'src/core/proposals.mjs',
      'src/core/Proposals.mjs',
      'src/core/proposals.mjs/inner.mjs',
      'src/core',
      'docs/CLAUDE.md',
      'docs/agents.md',
      'src/package.json',
      'src/prettier.config.mjs',
      'src/.prettierrc.json',
      'src/.hidden/tool.mjs',
      'data/new.json',
      'README.txt',
      // Route-folder look-alikes of a protected name or a dot segment.
      'src/[A]GENTS.md',
      'src/app/[..]/page.mjs',
    ].map(file => [p => (p.stories[0].newFiles = [file]), /cannot create/]),
    [p => (p.stories[0].deleteFiles = ['AGENTS.md']), /unsupported or unrecorded/],
    [p => (p.stories[0].deleteFiles = ['src/not-present.mjs']), /unsupported or unrecorded/],
    ...[
      '../README.md',
      'src/../README.md',
      'src//core/planning.mjs',
      'src/./core/planning.mjs',
      'C:/source/test.mjs',
      'data/record.json',
      'AGENTS.md',
      'docs/AGENTS.md',
      'src/not-present.mjs',
      'src\\core\\planning.mjs',
    ].map(file => [p => (p.stories[0].files = [file]), /Unsupported|unrecorded/]),
  ];
  for (const [mutate, expected] of cases) {
    const { source, attempt } = seedBreakdown(c, mutate),
      count = store.tasks().length;
    assert.throws(() => stageProposedWork(store, c.registries, source, attempt), expected);
    assert.equal(store.tasks().length, count);
    assert.equal(store.task(source.id).proposedTaskIds, undefined);
  }
  const { source, attempt } = seedBreakdown(c),
    org = store.organization();
  org.workers.find(w => w.id === 'W-02').enabled = false;
  store.setOrganization(org);
  const count = store.tasks().length;
  assert.throws(() => stageProposedWork(store, c.registries, source, attempt), /enabled employees/);
  assert.equal(store.tasks().length, count);
});

test('a breakdown story may list route folders with parentheses and square brackets, never their unsafe look-alikes', async t => {
  const c = await setup(t, true),
    { attempt, report } = seedBreakdown(c),
    page = 'src/app/(frontend)/[member]/page.mjs',
    // The measured manifest of a repository that already holds a route folder and a protected-name look-alike.
    source = {
      ...attempt.sourceBreakdown,
      files: [
        ...attempt.sourceBreakdown.files,
        ...[page, 'src/[A]GENTS.md'].map(file => ({ path: file, bytes: 11, hash: hash('export {};\n') })),
      ],
    },
    breakdown = paths => {
      const plan = structuredClone(report);
      Object.assign(plan.stories[0], paths);
      return plan;
    },
    refused = (paths, message) => assert.throws(() => validateBreakdown(breakdown(paths), source), message);
  assert.doesNotThrow(() =>
    validateBreakdown(breakdown({ files: [page], newFiles: ['src/app/[...slug]/page.mjs'] }), source),
  );
  for (const file of [
    'src/[A]GENTS.md',
    'src/app/[..]/page.mjs',
    'src/app/(.)/page.mjs',
    'src/app/[slug]./page.mjs',
    'src/app/nul.mjs',
    'src/app/[slug]:x.mjs',
    'src/app/［slug］/page.mjs',
    'dashboard/[t]sconfig.json',
  ])
    refused({ files: [page], newFiles: [file] }, error =>
      error.message.startsWith(`Story validate cannot create ${file}: new files go under`),
    );
  // A new path that differs from an existing route folder only in case collides with it (Windows).
  refused(
    { files: [page], newFiles: ['src/app/(Frontend)/[member]/page.mjs'] },
    /cannot create src\/app\/\(Frontend\)\/\[member\]\/page\.mjs: it already exists or collides/,
  );
  // A measured look-alike of a protected name cannot be edited either.
  refused({ files: ['src/[A]GENTS.md'] }, /unsupported or unrecorded source file src\/\[A\]GENTS\.md/);
});

test('breakdown approval rechecks accepted planning/check/context identities and rejects altered story keys', async t => {
  const c = await setup(t, true),
    store = c.app.store,
    fixture = seedBreakdown(c),
    ids = stageProposedWork(store, c.registries, fixture.source, fixture.attempt);
  await c.accept(fixture.source.id);
  for (const [output, name] of [
    [fixture.output, 'source-breakdown.json'],
    [fixture.checked.output, 'check-report.json'],
    [fixture.checked.output, 'source-context.json'],
    [fixture.checked.output, 'test-output.txt'],
  ]) {
    const file = path.join(output, name),
      bytes = fs.readFileSync(file);
    fs.appendFileSync(file, ' ');
    assert.equal((await c.request(`/api/tasks/${ids[0]}/approve-work`)).status, 400);
    assert.equal(store.task(ids[0]).approval.status, 'pending');
    fs.writeFileSync(file, bytes);
  }
  const originalCheck = store.task(fixture.checked.task.id),
    unaccepted = { ...originalCheck, status: 'review' };
  store.putTask(unaccepted);
  assert.equal((await c.request(`/api/tasks/${ids[0]}/approve-work`)).status, 400);
  store.putTask(originalCheck);
  const original = store.task(ids[0]),
    altered = structuredClone(original);
  altered.proposalReference.key = 'document';
  store.putTask(altered);
  const response = await c.request(`/api/tasks/${ids[0]}/approve-work`);
  assert.equal(response.status, 400);
  assert.match(response.data.error, /exact recorded proposal key/);
  store.putTask(original);
  assert.equal((await c.request(`/api/tasks/${ids[0]}/approve-work`)).status, 200);
});

test('breakdown intake respects the current project catalog and validates all stories before any write', async t => {
  const c = await setup(t, true),
    store = c.app.store,
    { source, attempt } = seedBreakdown(c),
    org = store.organization(),
    count = store.tasks().length;
  const teams = org.teams.map(({ id, name }) => ({ id, name }));
  saveProjectOrganization(store, c.registries, 'project-legacy', {
    expectedRevision: 0,
    teams,
    members: org.workers.map(worker => ({
      workerId: worker.id,
      teamId: org.teams.find(team => team.name === worker.team).id,
      role: worker.role,
      responsibility: 'Fixture member.',
    })),
    taskKinds: ['general', 'studio-development:breakdown'],
    kindOwners: {},
  });
  assert.throws(() => stageProposedWork(store, c.registries, source, attempt), /unsupported task kind/);
  assert.equal(store.tasks().length, count);
});

test('breakdown preflight uses the effective subscription model contract and rejects ambiguous or fixture inputs', async t => {
  const c = await setup(t, true),
    { source, checked } = seedBreakdown(c),
    store = c.app.store,
    definition = c.registries.workflows.get('studio-development:breakdown'),
    org = store.organization(),
    before = structuredClone(org);
  for (const provider of ['codex', 'claude']) {
    const task = { ...source, execution: { provider } };
    assert.doesNotThrow(() => definition.validateInputs({ store, task, runtime: c.app.runner }));
    const snapshot = definition.prepareAttempt({ store, task });
    assert.equal(snapshot.sourceBreakdown.taskId, checked.task.id);
    assert.equal(
      snapshot.sourceBreakdown.contextHash,
      checked.attempt.artifacts.find(item => item.kind === 'source-context').hash,
    );
  }
  assert.deepEqual(store.organization(), before);
  assert.throws(() => definition.validateInputs({ store, task: source, runtime: c.app.runner }), /model delivery mode/);
  assert.throws(() => definition.prepareAttempt({ store, task: { ...source, dependencies: [] } }), /exactly one/);
  assert.throws(
    () => definition.prepareAttempt({ store, task: { ...source, dependencies: [checked.task.id, checked.task.id] } }),
    /exactly one/,
  );
  const attempt = store.attempt(checked.attempt.id);
  attempt.checkExecution.fixture = true;
  store.updateAttempt(attempt);
  assert.throws(() => definition.prepareAttempt({ store, task: source }), /not fixture evidence/);
  // Scope is the approved list of paths, not a size: a large file may be edited (MP-016 slice 2).
  validateStoryPaths({ files: ['src/large.mjs'] }, [{ path: 'src/large.mjs', bytes: 900 * 1024 }]);
  validateStoryPaths(
    {
      files: [],
      newFiles: ['src/core/fresh/helper.mjs', 'test/fresh.test.mjs'],
      deleteFiles: ['docs/old.md'],
    },
    [{ path: 'docs/old.md' }, { path: 'src/core/planning.mjs' }],
  );
  assert.throws(
    () =>
      validateStoryPaths({ files: [], newFiles: ['src/core/dup.mjs', 'src/core/DUP.mjs'] }, [{ path: 'src/a.mjs' }]),
    /cannot create src\/core\/DUP\.mjs: it already exists or collides/,
  );
});

test('invalid asynchronous task proposals fail before creating drafts and release the producing attempt reservations', async t => {
  const c = await setup(t);
  c.registries.workflows.register({
    id: 'invalid-proposal-fixture',
    version: 'invalid-v1',
    tasks: [
      { ...proposer, kind: 'test:async-proposer', proposeWork: async () => ({ path: 'proposal.json', tasks: jobs }) },
    ],
  });
  const source = (
    await c.request('/api/tasks', {
      title: 'Invalid proposal protocol',
      brief: 'Model-free invalid hook fixture.',
      kind: 'test:async-proposer',
      workerId: 'W-01',
    })
  ).data;
  await c.request(`/api/tasks/${source.id}/start`);
  const attempt = await c.wait(source.id, 'failed');
  assert.match(attempt.error, /synchronous/);
  assert.equal(c.app.store.tasks().filter(task => task.proposalReference).length, 0);
  assert.equal(c.app.store.leases().length, 0);
});

test('exact proposals make approval recheck the recorded proposal for any proposer kind', async t => {
  const exact = { ...proposer, kind: 'test:exact-proposer', exactProposals: true };
  const c = await setup(t, false, [proposer, exact]);
  for (const [kind, status] of [
    [proposer.kind, 200],
    [exact.kind, 400],
  ]) {
    const source = await c.source(kind);
    await c.accept(source.task.id);
    const first = c.app.store.task(source.ids[0]);
    first.title = 'Edited after the proposal was recorded';
    c.app.store.putTask(first);
    const response = await c.request(`/api/tasks/${first.id}/approve-work`);
    assert.equal(response.status, status, JSON.stringify(response.data));
    if (status === 400) {
      assert.match(response.data.error, /exact recorded proposal key/);
      assert.equal(c.app.store.task(first.id).approval.status, 'pending');
    }
  }
});

test('breakdown stories may name a staffing role, which intake staffs from the project organization', async t => {
  const c = await setup(t, true),
    store = c.app.store,
    org = store.organization();
  org.workers.find(worker => worker.id === 'W-02').roles = ['engineer'];
  store.setOrganization(org);
  const { source, attempt } = seedBreakdown(c, report => {
      delete report.stories[0].workerId;
      report.stories[0].role = 'engineer';
    }),
    [first, second] = stageProposedWork(store, c.registries, source, attempt).map(id => store.task(id));
  assert.equal(first.workerId, 'W-02');
  assert.deepEqual(first.staffing, { by: 'role', role: 'engineer' });
  assert.equal(second.staffing, undefined, 'A story naming an employee keeps that employee.');
  const both = seedBreakdown(c, report => {
    report.stories[0].role = 'engineer';
  });
  assert.throws(
    () => stageProposedWork(store, c.registries, both.source, both.attempt),
    /Story validate: name either a staffing role or one employee \(workerId\)/,
  );
});
