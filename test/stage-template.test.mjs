import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';

// Neutral fixtures (MP-015 G3d): a writer drafts, a reviewer independently reviews the exact
// accepted draft, and a review of a task titled REWORK sends its first draft back.
const kind = (id, fields) => ({
  kind: id,
  version: `${id.split(':')[1]}-v1`,
  label: `Stage ${id.split(':')[1]}`,
  creatable: true,
  requiredCapabilities: ['text-output'],
  requiredResources: [],
  instructions: () => ({ scopeNote: 'Model-free stage template fixture.' }),
  validateOutput: () => {},
  ...fields,
});
const draftFormat = { id: 'stage-draft-v1', label: 'Stage draft', artifactKind: 'stage-draft' };
const template = {
  stages: [
    { key: 'draft', label: 'Draft' },
    {
      key: 'review',
      label: 'Independent review',
      kind: 'stg:review',
      role: 'reviewer',
      tier: 'light',
      maxSeconds: 60,
      maxAttempts: 2,
      sendBack: { to: 'draft', artifact: 'review.json', field: 'verdict', equals: ['needs-work'] },
    },
  ],
};
const pack = {
  id: 'stage-fixtures',
  version: 'stage-fixtures-v1',
  formats: [draftFormat],
  roles: [
    { id: 'writer', label: 'Writer' },
    { id: 'reviewer', label: 'Reviewer' },
  ],
  tasks: [
    kind('stg:draft', {
      role: 'writer',
      produces: ['stage-draft-v1'],
      stageTemplate: template,
      simulate: ({ attempt }) => ({
        artifact: 'draft.json',
        kind: 'stage-draft',
        data: { revision: /sent this back/.test(attempt.assignment.direction || '') ? 2 : 1 },
        checks: [],
      }),
    }),
    kind('stg:review', {
      role: 'reviewer',
      distinctFromInputs: true,
      consumes: ['stage-draft-v1'],
      simulate: ({ attempt, output }) => {
        const staged = attempt.inputReferences[0].artifacts[0].path,
          { revision } = JSON.parse(fs.readFileSync(path.join(output, staged), 'utf8'));
        return {
          artifact: 'review.json',
          data: {
            verdict: attempt.assignment.title.includes('REWORK') && revision === 1 ? 'needs-work' : 'pass',
            revision,
          },
          checks: [],
        };
      },
    }),
  ],
};
const shapes = {
  // Few people: one writes and reviews, one more reviews.
  pair: { 'W-03': ['writer', 'reviewer'], 'W-04': ['reviewer'] },
  // A larger bench of specialists.
  bench: { 'W-02': ['writer'], 'W-03': ['writer'], 'W-04': ['reviewer'], 'W-05': ['reviewer'], 'W-06': ['reviewer'] },
};

async function setup(t, extra = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stages-')),
    registries = createRegistries();
  registries.workflows.register(pack);
  for (const more of extra) registries.workflows.register(more);
  const delay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '15';
  const c = { registries, app: createStudio({ directory, port: 0, runnerOptions: { registries } }) };
  c.origin = await c.app.start();
  c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
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
  c.until = (check, label) => waitFor(check, label, { interval: 10 });
  c.project = async (name, roles, kinds = []) => {
    const created = await c.request('/api/projects', { name });
    const saved = await c.request(
      `/api/projects/${created.data.id}/organization`,
      {
        projectId: created.data.id,
        expectedRevision: c.app.store.setting('project-organization:' + created.data.id).revision,
        teams: [{ id: 'team', name: 'Team', purpose: 'Bounded fixture work.' }],
        members: Object.entries(roles).map(([workerId, memberRoles]) => ({
          workerId,
          teamId: 'team',
          role: 'Contributor',
          responsibility: 'Bounded fixture work.',
          roles: memberRoles,
        })),
        taskKinds: ['general', ...pack.tasks.map(task => task.kind), ...kinds],
        kindOwners: {},
      },
      'PATCH',
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return created.data.id;
  };
  c.create = async (projectId, title, workerId) => {
    const created = await c.request('/api/tasks', {
      projectId,
      title,
      brief: 'Draft one bounded item.',
      kind: 'stg:draft',
      workerId,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.id;
  };
  c.accept = async (projectId, id) => {
    await c.until(() => c.app.store.task(id).status === 'review', `${id} in review`);
    return c.request(`/api/tasks/${id}/accept`, { projectId });
  };
  return c;
}

test('a stage template is validated against the registered task types', () => {
  const registries = createRegistries();
  registries.workflows.register(pack);
  const described = registries.workflows.describe()['stg:draft'].stageTemplate;
  assert.deepEqual(described, [
    { key: 'draft', label: 'Draft', kind: 'stg:draft' },
    { key: 'review', label: 'Independent review', kind: 'stg:review' },
  ]);
  assert.ok(Object.isFrozen(registries.workflows.get('stg:draft').stageTemplate.stages[1]));
  const refused = (stages, fields = {}) =>
    assert.throws(() =>
      createRegistries().workflows.register({
        ...pack,
        tasks: [{ ...pack.tasks[0], stageTemplate: { stages }, ...fields }, pack.tasks[1]],
      }),
    );
  const [draft, review] = template.stages;
  refused([draft]);
  refused([draft, { ...review, kind: 'stg:missing' }]);
  refused([draft, { ...review, kind: 'stg:draft' }], {}, 'a stage view is recognized by its kind');
  refused([{ ...draft, kind: 'stg:review' }, review]);
  refused([draft, { ...review, sendBack: { ...review.sendBack, to: 'later' } }]);
  refused([draft, { ...review, maxAttempts: 9 }]);
  refused([draft, review], { stages: { view: task => task } });
  // Typed ports: the review consumes a draft, which a draft stage that produces nothing lacks.
  refused([draft, review], { produces: [] });
  // The result stage must deliver what the task type produces; the review produces no draft.
  assert.throws(
    () =>
      createRegistries().workflows.register({
        ...pack,
        tasks: [{ ...pack.tasks[0], stageTemplate: { ...template, result: 'review' } }, pack.tasks[1]],
      }),
    /the result stage must produce what stg:draft produces/,
  );
});

test('one stage template runs in two organizations: staffed by role, independent, exact input', async t => {
  const c = await setup(t);
  for (const [shape, writer, reviewer] of [
    ['pair', 'W-03', 'W-04'],
    ['bench', 'W-02', 'W-04'],
  ]) {
    const projectId = await c.project(`${shape} studio`, shapes[shape]),
      id = await c.create(projectId, `Plain item (${shape})`, writer);
    assert.equal((await c.request(`/api/tasks/${id}/start`, { projectId })).status, 202);
    const draft = await c.until(
      () => c.app.store.task(id).status === 'review' && c.app.store.attempt(c.app.store.task(id).lastAttemptId),
      'draft in review',
    );
    assert.equal(c.app.store.task(id).stageState.current, 'draft');
    c.app.runner.autonomy.attention(c.app.store.task(id), 'Inspect this draft.');
    assert.equal((await c.request(`/api/tasks/${id}/accept`, { projectId })).status, 200);
    // Acceptance advanced the same task to its review stage and queued it.
    const advanced = c.app.store.task(id);
    assert.equal(advanced.stageState.current, 'review');
    assert.equal(advanced.autonomyNote, undefined);
    assert.equal(advanced.reason, '');
    assert.equal(advanced.stageState.staffed.review.workerId, reviewer, shape);
    assert.deepEqual(advanced.stageState.outputs.draft, { attemptId: draft.id });
    const review = await c.until(
      () => c.app.store.task(id).status === 'review' && c.app.store.attempt(c.app.store.task(id).lastAttemptId),
      'review in review',
    );
    assert.equal(review.assignment.kind, 'stg:review');
    c.app.runner.autonomy.attention(c.app.store.task(id), 'Inspect this independent review.');
    assert.equal(review.workerId, reviewer, 'The reviewer is not the writer, even when the writer holds the role.');
    assert.equal(review.requestedTier, 'light');
    assert.equal(review.assignment.maxSeconds, 60);
    assert.deepEqual(
      review.inputReferences.map(ref => [ref.taskId, ref.attemptId]),
      [[id, draft.id]],
    );
    assert.equal((await c.request(`/api/tasks/${id}/accept`, { projectId })).status, 200);
    const done = c.app.store.task(id);
    assert.equal(done.status, 'done');
    assert.equal(done.autonomyNote, undefined);
    assert.equal(done.reason, '');
    assert.ok(done.stageState.complete);
    assert.equal(done.acceptedAttemptId, draft.id, 'The task delivers its accepted draft.');
    assert.deepEqual(
      done.stageState.history.map(entry => [entry.key, entry.outcome]),
      [
        ['draft', 'accepted'],
        ['review', 'accepted'],
      ],
    );
  }
});

test('a review stage sends its task back to the draft, which runs again when the director starts it', async t => {
  const c = await setup(t),
    projectId = await c.project('bench studio', shapes.bench),
    id = await c.create(projectId, 'REWORK item', 'W-02');
  await c.request(`/api/tasks/${id}/start`, { projectId });
  await c.accept(projectId, id);
  await c.until(() => c.app.store.task(id).stageState.current === 'review', 'the review stage');
  const firstReview = await c.until(
    () => c.app.store.task(id).status === 'review' && c.app.store.attempt(c.app.store.task(id).lastAttemptId),
    'first review',
  );
  assert.equal((await c.accept(projectId, id)).status, 200);
  const sentBack = c.app.store.task(id);
  assert.equal(sentBack.status, 'blocked');
  assert.equal(sentBack.queued, false, 'The director decides when the draft runs again.');
  assert.equal(sentBack.stageState.current, 'draft');
  assert.match(sentBack.direction, /Independent review sent this back/);
  assert.match(sentBack.reason, /Start it to run Draft again\./);
  assert.equal(c.app.store.attempt(firstReview.id).status, 'accepted', 'The review that sent it back stays recorded.');
  assert.equal((await c.request(`/api/tasks/${id}/start`, { projectId })).status, 202);
  await c.accept(projectId, id);
  const secondReview = await c.until(
    () =>
      c.app.store.task(id).stageState.current === 'review' &&
      c.app.store.task(id).status === 'review' &&
      c.app.store.attempt(c.app.store.task(id).lastAttemptId),
    'second review',
  );
  // Only attempts since the task re-entered the review stage count toward its limit.
  assert.equal(
    c.registries.workflows.stageAttempts(c.app.store, c.registries.workflows.stageView(c.app.store.task(id))).length,
    1,
  );
  assert.notEqual(secondReview.inputReferences[0].attemptId, firstReview.inputReferences[0].attemptId);
  // A revision requested in the review stage directs the review, not the draft.
  const draftDirection = c.app.store.task(id).direction;
  assert.equal(
    (await c.request(`/api/tasks/${id}/revise`, { projectId, direction: 'Check the exit landmark too.' })).status,
    200,
  );
  assert.equal(c.app.store.task(id).direction, draftDirection);
  assert.equal(c.app.store.task(id).stageState.direction, 'Check the exit landmark too.');
  // The stage is still queued, so its revised attempt starts by itself.
  const revised = await c.until(
    () =>
      c.app.store.task(id).status === 'review' &&
      c.app.store.task(id).lastAttemptId !== secondReview.id &&
      c.app.store.attempt(c.app.store.task(id).lastAttemptId),
    'revised review',
  );
  assert.equal(revised.assignment.kind, 'stg:review');
  assert.equal(revised.assignment.direction, 'Check the exit landmark too.');
  assert.equal((await c.request(`/api/tasks/${id}/accept`, { projectId })).status, 200);
  assert.deepEqual(
    c.app.store.task(id).stageState.history.map(entry => [entry.key, entry.outcome]),
    [
      ['draft', 'accepted'],
      ['review', 'sent-back'],
      ['draft', 'accepted'],
      ['review', 'accepted'],
    ],
  );
  assert.equal(c.app.store.task(id).status, 'done');
});

test('a stage no one can staff refuses the acceptance that would enter it', async t => {
  const c = await setup(t),
    // The only reviewer is the writer, and the review must be independent of the draft.
    projectId = await c.project('solo studio', { 'W-03': ['writer', 'reviewer'] }),
    id = await c.create(projectId, 'Solo item', 'W-03');
  await c.request(`/api/tasks/${id}/start`, { projectId });
  const refused = await c.accept(projectId, id);
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /No enabled employee holding role reviewer can run Stage review other than W-03/);
  const task = c.app.store.task(id);
  assert.equal(task.status, 'review', 'Nothing advanced.');
  assert.equal(c.app.store.attempt(task.lastAttemptId).status, 'review');
});

test('each fan-out child runs the stage template of its kind', async t => {
  const splitter = {
    id: 'stage-split-fixtures',
    version: 'stage-split-fixtures-v1',
    roles: [{ id: 'planner', label: 'Planner' }],
    tasks: [
      kind('stg:split', {
        role: 'planner',
        produces: ['item-list-v1'],
        simulate: () => ({
          artifact: 'items.json',
          kind: 'item-list',
          data: {
            schemaVersion: 'item-list-v1',
            items: ['alpha', 'beta'].map(key => ({ key, title: key, brief: `Draft ${key}.` })),
          },
          checks: [],
        }),
      }),
      kind('stg:collect', {
        role: 'planner',
        simulate: ({ attempt }) => ({
          artifact: 'collected.json',
          data: { inputs: attempt.inputReferences.map(ref => ref.taskId) },
          checks: [],
        }),
      }),
    ],
  };
  const c = await setup(t, [splitter]),
    projectId = await c.project('bench studio', { ...shapes.bench, 'W-07': ['planner'] }, ['stg:split', 'stg:collect']);
  const graph = {
    schemaVersion: 'graph-v1',
    nodes: [
      {
        key: 'split',
        title: 'Split',
        kind: 'stg:split',
        role: 'planner',
        brief: 'Split.',
        acceptance: 'Recorded.',
        resources: [],
        maxSeconds: 30,
        maxAttempts: 1,
      },
      {
        key: 'draft',
        title: 'Draft',
        kind: 'stg:draft',
        role: 'writer',
        brief: 'Draft.',
        acceptance: 'Recorded.',
        resources: [],
        maxSeconds: 30,
        maxAttempts: 1,
        map: { from: 'split', maxWidth: 2 },
      },
    ],
    edges: [
      { from: 'split', to: 'draft' },
      { from: 'draft', to: 'collect' },
    ],
  };
  graph.nodes.push({
    key: 'collect',
    title: 'Collect',
    kind: 'stg:collect',
    role: 'planner',
    brief: 'Collect.',
    acceptance: 'Recorded.',
    resources: [],
    maxSeconds: 30,
    maxAttempts: 1,
    join: { from: 'draft', rule: 'all' },
  });
  const saved = await c.request('/api/workflows', { projectId, name: 'Staged fan-out', graph });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const run = await c.request(`/api/workflows/${saved.data.id}/run`, { projectId, expectedVersion: 1 });
  assert.equal(run.status, 201, JSON.stringify(run.data));
  const [split, collect] = run.data.taskIds;
  assert.equal((await c.accept(projectId, split)).status, 200);
  const children = c.app.store.run(run.data.runId).revisions[1].map.children;
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal((await c.accept(projectId, child)).status, 200);
    await c.until(() => c.app.store.task(child).stageState.current === 'review', `${child} review stage`);
    const review = await c.until(
      () => c.app.store.task(child).status === 'review' && c.app.store.attempt(c.app.store.task(child).lastAttemptId),
      `${child} review`,
    );
    assert.equal(review.assignment.kind, 'stg:review');
    assert.notEqual(review.workerId, c.app.store.attempt(review.inputReferences[0].attemptId).workerId);
    // The join still waits: a child counts once its last stage is accepted.
    assert.equal(c.app.store.attempts(collect).length, 0);
    assert.equal((await c.request(`/api/tasks/${child}/accept`, { projectId })).status, 200);
    assert.ok(c.app.store.task(child).stageState.complete);
  }
  const joined = await c.until(
    () => c.app.store.task(collect).status === 'review' && c.app.store.attempt(c.app.store.task(collect).lastAttemptId),
    'the join runs',
  );
  assert.deepEqual(joined.inputReferences.map(ref => ref.taskId).sort(), [...children].sort());
  // Each child's accepted result is its draft, the format its kind produces; the join
  // checked it consumes nothing else, and each review stays in the child's stage history.
  for (const ref of joined.inputReferences) {
    assert.equal(c.app.store.attempt(ref.attemptId).assignment.kind, 'stg:draft');
    assert.ok(ref.artifacts.some(item => item.kind === 'stage-draft'));
  }
});
