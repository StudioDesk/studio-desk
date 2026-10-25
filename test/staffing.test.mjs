import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitForTask } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { proposeFromGraph } from '../src/core/planning.mjs';
import { projectOrganization } from '../src/core/project-organization.mjs';

// A neutral pack: a writer drafts, a checker independently checks the exact accepted draft,
// and a planner proposes that graph naming only roles. No domain, model or external system.
const fixture = (kind, label, fields = {}) => ({
  kind,
  version: `${kind.split(':')[1]}-v1`,
  label,
  creatable: true,
  requiredCapabilities: ['text-output'],
  requiredResources: [],
  instructions: () => ({ scopeNote: 'Model-free staffing fixture.' }),
  simulate: ({ attempt }) => ({
    artifact: 'notes.json',
    data: { kind, inputs: attempt.inputReferences.map(ref => ref.attemptId) },
    checks: [],
  }),
  validateOutput: ({ readArtifact }) => {
    JSON.parse(readArtifact(fields.artifact || 'notes.json'));
  },
  ...fields,
});
const graph = {
  schemaVersion: 'graph-proposal-v1',
  summary: 'Draft, then an independent check.',
  tasks: [
    {
      key: 'draft',
      title: 'Draft the notes',
      kind: 'fixture:draft',
      role: 'writer',
      brief: 'Write bounded notes.',
      acceptance: 'Notes are recorded.',
      dependencies: [],
      complexity: 1,
    },
    {
      key: 'check',
      title: 'Check the accepted draft',
      kind: 'fixture:check',
      role: 'checker',
      brief: 'Check the draft.',
      acceptance: 'Findings are recorded.',
      dependencies: ['draft'],
      complexity: 1,
    },
  ],
};
const pack = {
  id: 'staffing-fixtures',
  version: 'staffing-fixtures-v1',
  roles: [
    { id: 'writer', label: 'Writer' },
    { id: 'checker', label: 'Checker' },
    { id: 'planner', label: 'Planner' },
  ],
  tasks: [
    fixture('fixture:draft', 'Fixture draft', { role: 'writer' }),
    fixture('fixture:check', 'Fixture check', { role: 'checker', distinctFromInputs: true }),
    fixture('fixture:deep', 'Fixture deep draft', { role: 'writer', tier: 'deep' }),
    fixture('fixture:plan', 'Fixture planner', {
      role: 'planner',
      artifact: 'graph.json',
      produces: ['graph-proposal-v1'],
      autoProposeWork: true,
      proposeWork: proposeFromGraph,
      simulate: () => ({ artifact: 'graph.json', kind: 'graph-proposal', data: graph, checks: [] }),
    }),
  ],
};
const shapes = {
  // Two people: one writes, plans and could check; the other only checks.
  pair: { 'W-03': ['writer', 'checker', 'planner'], 'W-04': ['checker'] },
  // A larger bench of specialists.
  bench: { 'W-02': ['planner'], 'W-03': ['writer'], 'W-05': ['writer'], 'W-06': ['checker'], 'W-07': ['checker'] },
  // One person cannot check their own work.
  solo: { 'W-03': ['writer', 'checker'] },
};
const step = (key, kind, role, dependencies = []) => ({
  key,
  title: key,
  kind,
  role,
  brief: 'Bounded staffing fixture.',
  acceptance: 'Recorded fixture evidence.',
  dependencies,
  resources: [],
  maxSeconds: 30,
  maxAttempts: 1,
});
const template = [step('draft', 'fixture:draft', 'writer'), step('check', 'fixture:check', 'checker', ['draft'])];

async function setup(t, configure = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-staffing-')),
    registries = createRegistries();
  registries.workflows.register(pack);
  configure(registries);
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
  c.state = async id => (await fetch(c.origin + '/api/state?projectId=' + id)).json();
  c.wait = async (id, status = 'review') => waitForTask(c.app.store, id, status, { interval: 10 });
  c.organization = (projectId, roles, extra = {}) =>
    c.request(
      `/api/projects/${projectId}/organization`,
      {
        projectId,
        expectedRevision: c.app.store.setting('project-organization:' + projectId)?.revision || 0,
        teams: [{ id: 'team', name: 'Team', purpose: 'Bounded fixture work.' }],
        members: Object.entries(roles).map(([workerId, memberRoles]) => ({
          workerId,
          teamId: 'team',
          role: 'Contributor',
          responsibility: 'Bounded fixture work.',
          ...(memberRoles ? { roles: memberRoles } : {}),
        })),
        taskKinds: ['general', ...pack.tasks.map(task => task.kind)],
        kindOwners: {},
        ...extra,
      },
      'PATCH',
    );
  c.project = async (name, roles) => {
    const created = await c.request('/api/projects', { name });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const saved = await c.organization(created.data.id, roles);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return created.data.id;
  };
  c.workflow = (projectId, steps = template) =>
    c.request('/api/workflows', { projectId, name: 'Draft and check', steps });
  return c;
}

test('one workflow template is staffed by role across differently shaped organizations', async t => {
  const c = await setup(t),
    pair = await c.project('Pair studio', shapes.pair),
    bench = await c.project('Specialist bench', shapes.bench),
    solo = await c.project('Solo studio', shapes.solo);
  const state = await c.state(pair);
  assert.deepEqual(
    state.organizationConfiguration.members.map(member => member.roles),
    [shapes.pair['W-03'], shapes.pair['W-04']],
  );
  assert.equal(state.taskKinds['fixture:check'].role, 'checker');
  assert.equal(state.taskKinds['fixture:check'].distinctFromInputs, true);

  const staffed = {};
  for (const [name, projectId, writer, checker] of [
    ['pair', pair, 'W-03', 'W-04'],
    ['bench', bench, 'W-03', 'W-06'],
  ]) {
    const saved = await c.workflow(projectId);
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const run = await c.request(`/api/workflows/${saved.data.id}/run`, { projectId, expectedVersion: 1 });
    assert.equal(run.status, 201, JSON.stringify(run.data));
    const [draft, check] = run.data.taskIds.map(id => c.app.store.task(id));
    assert.equal(draft.workerId, writer, name);
    assert.deepEqual(draft.staffing, { by: 'role', role: 'writer' });
    // The checker is independent of the employee who drafted its input.
    assert.equal(check.workerId, checker, name);
    assert.deepEqual(check.staffing, { by: 'role', role: 'checker', exclude: [writer] });
    staffed[name] = { projectId, draft, check };
  }
  // The same template cannot be staffed when only the writer could check.
  const refused = await c.workflow(solo);
  assert.equal(refused.status, 400);
  assert.match(
    refused.data.error,
    /Step check: No enabled employee holding role checker can run Fixture check other than W-03/,
  );

  // Runs follow the staffing: the pair's check runs as W-04 on the exact accepted draft.
  const { projectId, draft, check } = staffed.pair;
  const drafted = await c.wait(draft.id);
  assert.equal(drafted.workerId, 'W-03');
  assert.equal((await c.request(`/api/tasks/${draft.id}/accept`, { projectId })).status, 200);
  const checked = await c.wait(check.id);
  assert.equal(checked.workerId, 'W-04');
  assert.equal(checked.inputReferences[0].attemptId, drafted.id);

  // Dispatch enforces separation of duties even for an explicitly assigned employee.
  const own = await c.request('/api/tasks', {
    projectId,
    title: 'Check my own draft',
    brief: 'Bounded fixture.',
    kind: 'fixture:check',
    workerId: 'W-03',
    dependencies: [draft.id],
  });
  assert.equal(own.status, 201, JSON.stringify(own.data));
  assert.equal((await c.request(`/api/tasks/${own.data.id}/start`, { projectId })).status, 400);
  assert.match(c.app.store.task(own.data.id).reason, /Separation of duties: .* produced this work's inputs/);
  assert.equal(c.app.store.attempts(own.data.id).length, 0);
});

test('a planner proposes a role-named graph that each organization staffs, with declared separation of duties', async t => {
  const c = await setup(t),
    bench = await c.project('Specialist bench', shapes.bench);
  const plan = await c.request('/api/tasks', {
    projectId: bench,
    title: 'Plan draft and check',
    brief: 'Propose the graph.',
    kind: 'fixture:plan',
    workerId: 'W-02',
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  assert.equal((await c.request(`/api/tasks/${plan.data.id}/start`, { projectId: bench })).status, 202);
  const planned = await c.wait(plan.data.id);
  assert.equal(
    planned.controllerChecks.find(check => check.name === 'Produced data format graph-proposal-v1').status,
    'pass',
  );
  const [draft, check] = c.app.store.task(plan.data.id).proposedTaskIds.map(id => c.app.store.task(id));
  assert.equal(draft.status, 'backlog');
  assert.equal(draft.workerId, 'W-03');
  assert.deepEqual(draft.staffing, { by: 'role', role: 'writer' });
  assert.equal(check.workerId, 'W-06');
  // Independent of its sibling prerequisite and of the proposing planner.
  assert.deepEqual(check.staffing, { by: 'role', role: 'checker', exclude: ['W-03', 'W-02'] });
  assert.equal(draft.role, undefined, 'roles are recorded under staffing, not as job titles');

  // Explicit employees, distinctFrom and unheld roles are checked before any record is written.
  const explicit = [
    { ...template[0], role: undefined, workerId: 'W-03' },
    { ...template[1], role: undefined, workerId: 'W-03', distinctFrom: ['draft'] },
  ];
  for (const [steps, error] of [
    [explicit, /Step check: .* cannot run Fixture check: separation of duties requires another employee/],
    [
      [{ ...template[0], distinctFrom: ['check'] }, template[1]],
      /Step draft: distinctFrom must name its own prerequisites/,
    ],
    [[step('draft', 'fixture:draft', 'editor')], /Step draft: No project member holds role editor/],
    [[{ ...template[0], workerId: 'W-03' }], /names either an enabled employee or one role ID/],
  ]) {
    const response = await c.workflow(bench, steps);
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.match(response.data.error, error);
  }
});

test('saved staffing roles survive an editor that omits them, and an empty list clears them', async t => {
  const c = await setup(t),
    projectId = await c.project('Pair studio', shapes.pair);
  const roles = () => c.app.store.setting('project-organization:' + projectId).members.map(member => member.roles);
  assert.equal((await c.organization(projectId, { 'W-03': undefined, 'W-04': undefined })).status, 200);
  assert.deepEqual(roles(), [shapes.pair['W-03'], shapes.pair['W-04']]);
  assert.equal((await c.organization(projectId, { 'W-03': [], 'W-04': ['checker'] })).status, 200);
  assert.deepEqual(roles(), [undefined, ['checker']]);
  const invalid = await c.organization(projectId, { 'W-03': ['not a role'], 'W-04': [] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /distinct role IDs/);
});

test('model tiers map to each CLI per project, below explicit task overrides', async t => {
  // A model-free CLI with effort levels; it records the settings each attempt ran with.
  const tiered = {
    id: 'fixture-tiered',
    version: 'fixture-tiered-v1',
    name: 'Tiered fixture CLI',
    workerSelectable: true,
    capabilities: ['text-output'],
    efforts: ['low', 'high'],
    status: () => ({ available: true, label: 'Model-free tier fixture' }),
    blockReason: () => '',
    configuration: (runtime, worker) => ({ model: worker.model || '', effort: worker.effort || '' }),
    requestedModel: worker => worker.model || 'CLI default',
    delivery: 'Model-free fixture.',
    deliveryScope: 'Private output folder only.',
    start(runtime, entry) {
      fs.writeFileSync(path.join(entry.output, 'notes.json'), JSON.stringify({ tiered: true }));
      runtime.finish(entry, {
        taskId: entry.attempt.taskId,
        outcome: 'completed',
        summary: 'Tier fixture delivery.',
        artifacts: [{ path: 'notes.json', kind: 'fixture-notes' }],
        checks: [],
        issues: [],
        handoff: 'Director acceptance required.',
      });
    },
  };
  const c = await setup(t, registries => registries.adapters.register(tiered));
  assert.equal(
    (await c.request('/api/workers/W-03', { provider: tiered.id, model: 'house-model', expectedVersion: 1 }, 'PATCH'))
      .status,
    200,
  );
  const projectId = await c.project('Tiered studio', { 'W-03': ['writer', 'checker'], 'W-04': ['checker'] });
  const tiers = {
    light: { [tiered.id]: { model: 'small-model', effort: 'low' } },
    deep: { [tiered.id]: { model: 'large-model', effort: 'high' } },
  };
  assert.equal((await c.organization(projectId, { 'W-03': undefined, 'W-04': undefined }, { tiers })).status, 200);
  for (const [bad, error] of [
    [{ huge: {} }, /Tier settings has unsupported fields/],
    [{ light: { 'not-a-cli': {} } }, /Tier light has unsupported fields/],
    [{ light: { [tiered.id]: { effort: 'max' } } }, /does not accept effort "max"/],
  ]) {
    const response = await c.organization(projectId, { 'W-03': undefined, 'W-04': undefined }, { tiers: bad });
    assert.equal(response.status, 400);
    assert.match(response.data.error, error);
  }
  // Omitting tiers keeps the saved settings.
  assert.equal((await c.organization(projectId, { 'W-03': undefined, 'W-04': undefined })).status, 200);
  assert.deepEqual(c.app.store.setting('project-organization:' + projectId).tiers, tiers);

  const run = async (kind, fields = {}) => {
    const created = await c.request('/api/tasks', {
      projectId,
      title: `Tiered ${kind}`,
      brief: 'Bounded fixture.',
      kind,
      workerId: 'W-03',
      ...fields,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal((await c.request(`/api/tasks/${created.data.id}/start`, { projectId })).status, 202);
    return c.wait(created.data.id);
  };
  // No tier: the employee's own settings.
  const plain = await run('fixture:draft');
  assert.equal(plain.requestedModel, 'house-model');
  assert.equal(plain.requestedTier, undefined);
  // A task type's default tier.
  const deep = await run('fixture:deep');
  assert.deepEqual([deep.requestedTier, deep.requestedModel, deep.requestedEffort], ['deep', 'large-model', 'high']);
  // A workflow step's tier, with an explicit task override still winning on effort.
  const saved = await c.workflow(projectId, [{ ...template[0], tier: 'light' }]);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const started = await c.request(`/api/workflows/${saved.data.id}/run`, { projectId, expectedVersion: 1 });
  const light = await c.wait(started.data.taskIds[0]);
  assert.deepEqual([light.requestedTier, light.requestedModel, light.requestedEffort], ['light', 'small-model', 'low']);
  // An explicit task override still wins over the tier.
  const org = projectOrganization(c.app.store, projectId),
    lightTask = c.app.store.task(started.data.taskIds[0]),
    mixed = c.app.runner.effectiveWorker(org, { ...lightTask, execution: { effort: 'high' } });
  assert.deepEqual([mixed.model, mixed.effort], ['small-model', 'high']);
});
