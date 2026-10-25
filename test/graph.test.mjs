import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStudio } from './model-free-studio.mjs';
import { waitForTask } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { Store } from '../src/core/store.mjs';
import { newRun, expandRun, projectRuns, runArchive, setRunArchived } from '../src/core/graph.mjs';

// Neutral fixtures: a draft, an independent check and a proposer. No domain or model.
const fixture = (kind, fields = {}) => ({
  kind,
  version: `${kind.split(':')[1]}-v1`,
  label: `Fixture ${kind.split(':')[1]}`,
  creatable: true,
  requiredCapabilities: ['text-output'],
  requiredResources: [],
  instructions: () => ({ scopeNote: 'Model-free graph fixture.' }),
  simulate: () => ({ artifact: 'notes.json', data: { kind }, checks: [] }),
  validateOutput: ({ readArtifact }) => {
    JSON.parse(readArtifact('notes.json'));
  },
  ...fields,
});
const followUp = {
  key: 'follow-up',
  title: 'Follow up on the proposal',
  kind: 'graph:draft',
  workerId: 'W-04',
  brief: 'Bounded fixture.',
  acceptance: 'Recorded.',
  dependencies: [],
  resources: [],
  maxSeconds: 30,
  maxAttempts: 1,
};
const pack = {
  id: 'graph-fixtures',
  version: 'graph-fixtures-v1',
  tasks: [
    fixture('graph:draft'),
    fixture('graph:check'),
    // A neutral milestone beyond acceptance, set by the test.
    fixture('graph:publish', { milestones: { published: task => task.published === true } }),
    fixture('graph:propose', {
      autoProposeWork: true,
      proposeWork: () => ({ path: 'notes.json', tasks: [followUp] }),
    }),
  ],
};
const node = (key, kind, workerId) => ({
  key,
  title: `Fixture ${key}`,
  kind,
  workerId,
  brief: 'Bounded fixture.',
  acceptance: 'Recorded fixture evidence.',
  resources: [],
  maxSeconds: 30,
  maxAttempts: 1,
});
const graph = (fields = {}) => ({
  schemaVersion: 'graph-v1',
  nodes: [node('draft', 'graph:draft', 'W-03'), node('check', 'graph:check', 'W-04')],
  edges: [{ from: 'draft', to: 'check' }],
  ...fields,
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-graph-')),
    registries = createRegistries();
  registries.workflows.register(pack);
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
  c.request = async (url, data = {}) => {
    const response = await fetch(c.origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.state = async () => (await fetch(c.origin + '/api/state')).json();
  c.wait = async (id, status = 'review') => waitForTask(c.app.store, id, status, { interval: 10 });
  return c;
}

test('a graph-v1 workflow runs with a run record, and saved step lists load as plain chains', async t => {
  const c = await setup(t);
  const spec = graph({ envelope: { nodes: 4, attemptSeconds: 600 } });
  const saved = await c.request('/api/workflows', { name: 'Draft and check', graph: spec });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.graph, spec);
  assert.equal(saved.data.steps, undefined);
  const steps = spec.nodes.map(item => ({ ...item, dependencies: item.key === 'check' ? ['draft'] : [] }));
  const legacy = await c.request('/api/workflows', { name: 'Draft and check as steps', steps });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.data));
  // The step list is stored as given and read as the same plain chain.
  assert.equal(c.app.store.workflow(legacy.data.id).graph, undefined);
  const listed = (await c.state()).workflows.find(workflow => workflow.id === legacy.data.id);
  assert.deepEqual(listed.graph, { schemaVersion: 'graph-v1', nodes: spec.nodes, edges: spec.edges });

  const started = await c.request(`/api/workflows/${saved.data.id}/run`, { expectedVersion: 1 });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const { runId, taskIds } = started.data,
    [draft, check] = taskIds.map(id => c.app.store.task(id));
  assert.deepEqual(check.dependencies, [draft.id]);
  assert.equal(check.workflowReference.runId, runId);
  const run = c.app.store.run(runId);
  assert.equal(run.schemaVersion, 'run-v1');
  assert.deepEqual(run.envelope, { nodes: 4, attemptSeconds: 600 });
  assert.deepEqual(run.revisions[0].graph, spec);
  assert.deepEqual(run.revisions[0].tasks, { draft: draft.id, check: check.id });
  const view = (await c.state()).runs.find(item => item.id === runId);
  assert.deepEqual(
    view.nodes.map(item => [item.key, item.taskId, item.dependencies, item.revision]),
    [
      ['draft', draft.id, [], 1],
      ['check', check.id, [draft.id], 1],
    ],
  );
  // A step list without a declared envelope is approved with exactly what it needs.
  const chained = await c.request(`/api/workflows/${legacy.data.id}/run`, { expectedVersion: 1 });
  assert.deepEqual(c.app.store.run(chained.data.runId).envelope, { nodes: 2, attemptSeconds: 60 });
});

test('graph structure, edges and envelopes are validated before anything is saved', async t => {
  const c = await setup(t);
  const cases = [
    [graph({ schemaVersion: 'graph-v2' }), /schemaVersion must be graph-v1/],
    [graph({ edges: [{ from: 'draft', to: 'missing' }] }), /connects two different nodes/],
    [graph({ edges: [{ from: 'draft', to: 'draft' }] }), /connects two different nodes/],
    [graph({ edges: [graph().edges[0], graph().edges[0]] }), /must be distinct/],
    [
      graph({ edges: [{ from: 'draft', to: 'check', milestone: 'integrated' }] }),
      /Edge draft → check waits for integrated, which graph:draft does not define; it defines accepted/,
    ],
    [
      graph({
        edges: [
          { from: 'draft', to: 'check' },
          { from: 'check', to: 'draft' },
        ],
      }),
      /cycle/,
    ],
    [graph({ envelope: { nodes: 1 } }), /needs 2 nodes and 60 attempt-seconds, more than its envelope allows/],
    [graph({ envelope: { attemptSeconds: 5000 } }), /at most 30 nodes and 3600 attempt-seconds/],
    [
      graph({ nodes: [{ ...node('draft', 'graph:draft', 'W-03'), dependencies: [] }, graph().nodes[1]] }),
      /Graph node contains unsupported fields/,
    ],
  ];
  for (const [spec, error] of cases) {
    const response = await c.request('/api/workflows', { name: 'Invalid graph', graph: spec });
    assert.equal(response.status, 400, JSON.stringify(spec));
    assert.match(response.data.error, error);
  }
  const both = await c.request('/api/workflows', { name: 'Both', graph: graph(), steps: [] });
  assert.match(both.data.error, /either a graph or a step list/);
  assert.equal((await c.state()).workflows.length, 0);
});

test("work a run's task proposes joins the run as a numbered revision", async t => {
  const c = await setup(t);
  const spec = { schemaVersion: 'graph-v1', nodes: [node('propose', 'graph:propose', 'W-03')], edges: [] };
  const saved = await c.request('/api/workflows', { name: 'Propose', graph: spec });
  const started = await c.request(`/api/workflows/${saved.data.id}/run`, { expectedVersion: 1 });
  const [proposerId] = started.data.taskIds;
  await c.wait(proposerId);
  const [proposed] = c.app.store.task(proposerId).proposedTaskIds.map(id => c.app.store.task(id));
  assert.deepEqual(proposed.runReference, { runId: started.data.runId, revision: 2 });
  const run = c.app.store.run(started.data.runId);
  assert.equal(run.revisions.length, 2);
  assert.equal(run.revisions[1].reason, `${proposerId} proposed work.`);
  assert.equal(run.revisions[1].source, proposerId);
  assert.deepEqual(run.revisions[1].added, [
    {
      taskId: proposed.id,
      key: 'follow-up',
      kind: 'graph:draft',
      title: followUp.title,
      workerId: 'W-04',
      dependencies: [proposerId],
    },
  ]);
  const view = (await c.state()).runs.find(item => item.id === started.data.runId);
  assert.deepEqual(
    view.nodes.map(item => [item.taskId, item.revision]),
    [
      [proposerId, 1],
      [proposed.id, 2],
    ],
  );
});

test('runs from before run records are read from their tasks without writing a record', async t => {
  const c = await setup(t);
  const base = {
    projectId: 'project-legacy',
    brief: 'Fixture.',
    acceptance: 'Recorded.',
    status: 'done',
    resources: [],
    maxSeconds: 30,
    maxAttempts: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const reference = key => ({ id: 'workflow-old', name: 'Old workflow', version: 3, runId: 'run-old', key, hash: 'h' });
  c.app.store.putTask({
    ...base,
    id: 'T-old-1',
    title: 'Old draft',
    kind: 'graph:draft',
    workerId: 'W-03',
    dependencies: [],
    workflowReference: reference('draft'),
  });
  c.app.store.putTask({
    ...base,
    id: 'T-old-2',
    title: 'Old check',
    kind: 'graph:check',
    workerId: 'W-04',
    dependencies: ['T-old-1'],
    workflowReference: reference('check'),
  });
  // A retry copy repeats its step's key; the earliest task stands for the step.
  c.app.store.putTask({
    ...base,
    id: 'T-old-3',
    title: 'Old check retry',
    kind: 'graph:check',
    workerId: 'W-04',
    dependencies: ['T-old-1'],
    retryOf: 'T-old-2',
    createdAt: '2026-10-02T00:00:00.000Z',
    workflowReference: reference('check'),
  });
  const view = (await c.state()).runs.find(item => item.id === 'run-old');
  assert.equal(view.legacy, true);
  assert.deepEqual(view.workflow, { id: 'workflow-old', name: 'Old workflow', version: 3 });
  assert.deepEqual(
    view.nodes.map(item => [item.key, item.taskId, item.dependencies]),
    [
      ['draft', 'T-old-1', []],
      ['check', 'T-old-2', ['T-old-1']],
    ],
  );
  assert.equal(c.app.store.run('run-old'), null);
  assert.equal(view.archive, undefined);
  for (const action of ['archive', 'restore']) {
    const response = await c.request(`/api/projects/project-legacy/runs/run-old/${action}`);
    assert.equal(response.status, 400);
    assert.match(response.data.error, /Legacy runs.*persisted run-v1/);
  }
  assert.deepEqual(
    (await c.state()).runs.find(item => item.id === 'run-old'),
    view,
  );
  assert.equal(c.app.store.setting('run-archive:project-legacy:run-old'), null);
});

// Store-level archive checks need no HTTP, model calls or source integration process.
function archiveFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-archive-')),
    registries = createRegistries(),
    profile = () => ({ organization: { company: {} }, tasks: [] }),
    projectId = 'project-legacy',
    runId = 'run-archive-fixture',
    c = { store: new Store(directory, profile), directory, registries, profile, projectId, runId };
  registries.workflows.register(pack);
  t.after(() => {
    c.store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const task = {
    ...node('draft', 'graph:draft', 'W-03'),
    id: 'T-archive-fixture',
    projectId,
    status: 'done',
    queued: false,
    dependencies: [],
    approval: { status: 'approved' },
    acceptedAttemptId: 'A-archive-fixture',
    lastAttemptId: 'A-archive-fixture',
    workflowReference: { runId, key: 'draft' },
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  c.task = task;
  c.store.putTask(task);
  c.store.insertAttempt(
    {
      id: task.acceptedAttemptId,
      taskId: task.id,
      projectId,
      status: 'accepted',
      result: { outcome: 'completed' },
      artifacts: [{ path: 'notes.json', kind: 'fixture', hash: 'immutable-hash' }],
    },
    { immutable: 'accepted instructions' },
  );
  c.store.putRun(
    newRun({
      id: runId,
      projectId,
      workflow: { id: 'workflow-archive', name: 'Archive fixture', version: 1 },
      graph: { schemaVersion: 'graph-v1', nodes: [node('draft', 'graph:draft', 'W-03')], edges: [] },
      envelope: { nodes: 3, attemptSeconds: 90 },
      taskIds: [['draft', task.id]],
      at: task.createdAt,
    }),
  );
  c.archive = (value = true, ownership) => setRunArchived(c.store, registries, projectId, runId, value, ownership);
  c.records = () => ({
    tasks: c.store.tasks(),
    attempts: c.store.allAttempts(),
    run: c.store.run(runId),
    leases: c.store.leases(),
    organization: c.store.organization(),
  });
  return c;
}

test('archive and restore persist separately without changing run revisions, tasks, attempts or artifacts', t => {
  const c = archiveFixture(t),
    before = c.records(),
    view = projectRuns(c.store, c.projectId)[0];
  assert.deepEqual(view.archive, { archived: false });
  assert.deepEqual(c.archive(false), { archived: false });
  assert.equal(c.store.setting(`run-archive:${c.projectId}:${c.runId}`), null);
  const archived = c.archive();
  assert.equal(archived.archived, true);
  assert.ok(Date.parse(archived.archivedAt));
  assert.deepEqual(c.archive(), archived);
  assert.deepEqual(c.records(), before);
  assert.deepEqual(projectRuns(c.store, c.projectId), [{ ...view, archive: archived }]);
  c.store.close();
  c.store = new Store(c.directory, c.profile);
  assert.deepEqual(runArchive(c.store, c.projectId, c.runId), archived);
  assert.deepEqual(c.records(), before);
  const restored = c.archive(false);
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, archived.archivedAt);
  assert.ok(Date.parse(restored.restoredAt));
  assert.deepEqual(c.archive(false), restored);
  c.store.close();
  c.store = new Store(c.directory, c.profile);
  assert.deepEqual(projectRuns(c.store, c.projectId), [{ ...view, archive: restored }]);
  assert.deepEqual(c.records(), before);
});

test('archive refuses unresolved task state, live or uncertain attempts and controller ownership without mutating evidence', t => {
  const c = archiveFixture(t),
    baseAttempt = c.store.attempt(c.task.acceptedAttemptId);
  const cases = [
    ...['backlog', 'ready', 'blocked', 'review', 'failed', 'cancelled', 'running', 'stopping', 'uncertain'].map(
      status => ({ task: { status }, error: /not accepted or explicitly closed/ }),
    ),
    { task: { queued: true }, error: /queued work/ },
    { task: { approval: { status: 'pending' } }, error: /pending decision/ },
    { task: { status: 'denied' }, error: /not accepted or explicitly closed/ },
    { task: { acceptedAttemptId: 'missing' }, error: /no completed accepted attempt/ },
    { attempt: { result: { outcome: 'blocked' } }, error: /no completed accepted attempt/ },
    { attempt: { status: 'review' }, error: /pending result decision/ },
    ...['running', 'stopping'].map(status => ({ attempt: { status }, error: /live attempt/ })),
    ...['interrupted', 'quarantined', 'uncertain'].map(status => ({ attempt: { status }, error: /reconciliation/ })),
    { ownership: { activeTaskIds: [c.task.id] }, error: /controller-owned work/ },
    { ownership: { pendingTaskId: c.task.id }, error: /controller-owned work/ },
    { ownership: { reservedTaskIds: [c.task.id] }, error: /reservation/ },
    { lease: true, error: /reservation/ },
  ];
  for (const entry of cases) {
    c.store.putTask({ ...c.task, ...entry.task });
    c.store.updateAttempt({ ...baseAttempt, ...entry.attempt });
    if (entry.lease) c.store.claim(['fixture:archive'], baseAttempt.id);
    const before = c.records();
    assert.throws(() => c.archive(true, entry.ownership), entry.error, JSON.stringify(entry));
    assert.deepEqual(c.records(), before);
    assert.deepEqual(runArchive(c.store, c.projectId, c.runId), { archived: false });
    if (entry.lease) c.store.release(baseAttempt.id);
  }
});

test('archive includes expansion tasks and requires explicit closure of unresolved work', t => {
  const c = archiveFixture(t),
    child = {
      ...c.task,
      id: 'T-expanded',
      status: 'failed',
      acceptedAttemptId: null,
      lastAttemptId: 'A-expanded',
    };
  expandRun(c.store, c.runId, { reason: 'Proposed child fixture.', source: c.task.id, tasks: [child] });
  c.store.putTask(child);
  c.store.insertAttempt(
    { id: child.lastAttemptId, taskId: child.id, projectId: c.projectId, status: 'failed', artifacts: [] },
    {},
  );
  assert.throws(() => c.archive(), /T-expanded.*not accepted or explicitly closed/);
  c.store.putTask({ ...child, status: 'denied', closed: { at: c.task.createdAt, by: { type: 'director' } } });
  const before = c.records();
  assert.equal(c.archive().archived, true);
  assert.deepEqual(c.records(), before);
  c.store.putTask({ ...c.task, status: 'denied', approval: { status: 'denied' } });
  assert.equal(c.archive().archived, true);
  // Closure cannot mask an older unreconciled attempt or a retained reservation.
  const old = { id: 'A-uncertain-old', taskId: child.id, projectId: c.projectId, status: 'interrupted' };
  c.store.insertAttempt(old, {});
  assert.throws(() => c.archive(), /reconciliation/);
  c.store.updateAttempt({ ...old, reconciledAt: c.task.createdAt });
  assert.equal(c.archive().archived, true);
  c.store.db.prepare('DELETE FROM tasks WHERE id=?').run(child.id);
  assert.throws(() => c.archive(), /Assignment not found/);
  // Restore is always available, even if the run has become unsettled again.
  assert.equal(c.archive(false).archived, false);
});

test('archive obeys neutral stage contracts and cannot transfer runs or tasks between projects', t => {
  const c = archiveFixture(t);
  c.registries.workflows.register({
    id: 'archive-stages',
    version: 'archive-stages-v1',
    tasks: [fixture('archive:staged', { stages: { closable: (store, task) => !task.published } })],
  });
  c.store.putTask({ ...c.task, kind: 'archive:staged' });
  assert.throws(() => c.archive(), /unfinished stages or integration/);
  c.store.putTask({ ...c.task, kind: 'archive:staged', published: true });
  assert.equal(c.archive().archived, true);
  c.archive(false);
  c.store.putTask({ ...c.task, stageState: { current: 'review' } });
  assert.throws(() => c.archive(), /unfinished stages/);
  c.store.putTask({ ...c.task, stageState: { current: 'review', complete: c.task.createdAt } });
  assert.equal(c.archive().archived, true);
  c.store.putProject({ id: 'project-other', name: 'Other project' });
  for (const value of [true, false]) {
    assert.throws(() => setRunArchived(c.store, c.registries, 'project-other', c.runId, value), /another project/);
    assert.throws(() => setRunArchived(c.store, c.registries, c.projectId, 'run-unknown', value), /Run not found/);
  }
  c.store.putTask({ ...c.task, projectId: 'project-other' });
  assert.throws(() => c.archive(), /another project/);
  assert.equal(c.store.setting(`run-archive:project-other:${c.runId}`), null);
});

test('the Runs view shows each run graph in stages from its record', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../public/runs.js', import.meta.url), 'utf8'), context);
  const at = minute => new Date(Date.UTC(2026, 9, 15, 19, minute)).toISOString();
  const task = (id, fields) => ({ id, title: id + ' title', brief: '', dependencies: [], createdAt: at(0), ...fields });
  const reference = { id: 'workflow-x', name: 'Draft and check', version: 1, runId: 'run-x', hash: 'h' };
  const state = {
    workers: [
      { id: 'W-03', displayName: 'Rowan' },
      { id: 'W-04', displayName: 'Quinn' },
    ],
    taskKinds: {},
    attempts: [],
    tasks: [
      task('T-1', { status: 'done', workerId: 'W-03', workflowReference: { ...reference, key: 'draft' } }),
      task('T-2', {
        status: 'review',
        workerId: 'W-04',
        dependencies: ['T-1'],
        workflowReference: { ...reference, key: 'check' },
      }),
      // Joined the run through its run reference, not by following proposals.
      task('T-3', {
        status: 'backlog',
        workerId: 'W-03',
        dependencies: ['T-2'],
        runReference: { runId: 'run-x', revision: 2 },
      }),
    ],
    runs: [
      {
        id: 'run-x',
        workflow: { id: 'workflow-x', name: 'Draft and check', version: 1 },
        brief: 'Recorded brief.',
        envelope: { nodes: 2, attemptSeconds: 60 },
        createdAt: at(0),
        revisions: [{ revision: 1 }, { revision: 2 }],
        nodes: [
          { taskId: 'T-1', key: 'draft', kind: 'graph:draft', title: 'Draft', dependencies: [], revision: 1 },
          { taskId: 'T-2', key: 'check', kind: 'graph:check', title: 'Check', dependencies: ['T-1'], revision: 1 },
          { taskId: 'T-3', kind: 'graph:draft', title: 'Follow up', dependencies: ['T-2'], revision: 2 },
        ],
      },
    ],
  };
  // Values built inside the vm context are compared as plain data.
  const [story] = JSON.parse(JSON.stringify(context.StudioRuns.buildRunStories(state)));
  assert.equal(story.brief, 'Recorded brief.');
  assert.deepEqual(story.taskIds.sort(), ['T-1', 'T-2', 'T-3']);
  assert.equal(story.graph.revisions, 2);
  assert.deepEqual(
    story.graph.stages.map(stage => stage.map(item => [item.taskId, item.worker, item.status, item.revision])),
    [[['T-1', 'Rowan', 'Accepted', 1]], [['T-2', 'Quinn', 'Review', 1]], [['T-3', 'Rowan', 'Planned', 2]]],
  );
});

test('an edge can wait for a milestone its upstream task type defines, and Start queues the wait', async t => {
  const c = await setup(t);
  const spec = {
    schemaVersion: 'graph-v1',
    nodes: [node('publish', 'graph:publish', 'W-03'), node('check', 'graph:check', 'W-04')],
    edges: [{ from: 'publish', to: 'check', milestone: 'published' }],
  };
  const saved = await c.request('/api/workflows', { name: 'Publish, then check', graph: spec });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const started = await c.request(`/api/workflows/${saved.data.id}/run`, { expectedVersion: 1 }),
    [publish, check] = started.data.taskIds;
  assert.deepEqual(c.app.store.task(check).waitsFor, { [publish]: 'published' });
  await c.wait(publish);
  assert.equal((await c.request(`/api/tasks/${publish}/accept`)).status, 200);
  // Accepted is not enough: the check waits for the milestone, and Start only queues it.
  const queued = await c.request(`/api/tasks/${check}/start`);
  assert.equal(queued.status, 202);
  assert.deepEqual(queued.data, { ok: true, queued: true, reason: `Waiting for ${publish} to be published.` });
  assert.equal(c.app.store.attempts(check).length, 0);
  const task = c.app.store.task(publish);
  task.published = true;
  c.app.store.putTask(task);
  // In use, the event that reaches a milestone (an integration settling) schedules dispatch.
  c.app.runner.schedule();
  await c.wait(check);
});
