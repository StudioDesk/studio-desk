import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor, waitForTask } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { hash } from '../src/core/contracts.mjs';
import { Store as CoreStore } from '../src/core/store.mjs';
import { planningContext, simulatedPlan, validatePlan } from '../src/planning.mjs';
import { validatePlan as validateCorePlan } from '../src/core/planning.mjs';
import { validateWorkflow } from '../src/core/workflows.mjs';

// A trusted test-only pack. No model calls, browser checks or external services.
const reportTask = {
  kind: 'test:report',
  version: 'test-report-v1',
  label: 'Fixture report JSON',
  creatable: true,
  requiredCapabilities: ['text-output'],
  requiredResources: ['document:registry-proof'],
  attemptFields: ['reportDigest'],
  prompt: 'Write report.json with the supplied direction and input identities.',
  instructions: () => ({
    assignment: { id: 'context-cannot-replace-controller-id', reportShape: { direction: 'text', sources: [] } },
    scopeNote: 'Fixture text/JSON only.',
  }),
  simulate({ attempt }) {
    return {
      artifact: 'report.json',
      data: {
        direction: attempt.assignment.direction,
        sources: attempt.inputReferences.map(ref => ({
          taskId: ref.taskId,
          attemptId: ref.attemptId,
          hashes: ref.artifacts.map(item => item.hash),
        })),
      },
      checks: [
        {
          name: 'External verification',
          status: 'not-run',
          evidence: 'Registered fixture; no external system was inspected.',
        },
      ],
    };
  },
  validateOutput({ readArtifact, checks }) {
    const contents = readArtifact('report.json'),
      report = JSON.parse(contents);
    if (typeof report.direction !== 'string' || !Array.isArray(report.sources))
      throw new Error('Invalid fixture report.');
    checks.push({
      name: 'Fixture report shape',
      status: 'pass',
      evidence: 'Text direction and recorded input identities checked.',
    });
    return { metadata: { reportDigest: hash(contents) } };
  },
};
const testPack = (tasks = [reportTask], formats) => ({
  id: 'test-fixtures',
  version: 'test-fixtures-v1',
  tasks,
  ...(formats ? { formats } : {}),
});

async function setup(t, tasks = [reportTask], configure = () => {}, formats) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-registry-'));
  const registries = createRegistries();
  registries.workflows.register(testPack(tasks, formats));
  configure(registries);
  const previousDelay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '30';
  const c = { directory, registries, app: createStudio({ directory, port: 0, runnerOptions: { registries } }) };
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousDelay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = previousDelay;
  });
  c.connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await c.connect();
  c.request = async (url, body = {}, method = 'POST') => {
    const response = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  c.state = async () => (await fetch(c.origin + '/api/state')).json();
  c.create = async (title, extra = {}) => {
    const response = await c.request('/api/tasks', {
      title,
      brief: 'Bounded model-free registry fixture.',
      kind: reportTask.kind,
      workerId: 'W-03',
      ...extra,
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  c.wait = async (id, status) => waitForTask(c.app.store, id, status, { interval: 10 });
  return c;
}

test('a registered non-game task uses shared dispatch, revisions, validation, acceptance, inputs and persistence', async t => {
  const c = await setup(t),
    initial = await c.create('Registered report');
  const dependent = await c.create('Dependent registered report', { workerId: 'W-04', dependencies: [initial.id] });
  const state = await c.state();
  assert.equal(state.taskKinds[reportTask.kind].label, reportTask.label);
  assert.deepEqual(state.taskKinds[reportTask.kind].requiredResources, reportTask.requiredResources);
  assert.equal(state.adapters.mock.version, 'simulator-v1');
  const preview = (await c.request('/api/preview', { taskId: initial.id, workerId: initial.workerId })).data;
  const assignment = JSON.parse(preview.layers.find(layer => layer.title === 'Assignment').text);
  assert.deepEqual(assignment.reportShape, { direction: 'text', sources: [] });
  assert.equal(assignment.catalog, undefined);
  assert.equal(assignment.id, initial.id);
  await c.request('/api/pipeline', { action: 'queue', taskIds: [initial.id, dependent.id] });
  const first = await c.wait(initial.id, 'review');
  assert.equal(c.app.store.attempts(dependent.id).length, 0);
  assert.equal((await c.request(`/api/tasks/${dependent.id}/accept`)).status, 400);
  assert.deepEqual(first.contracts, {
    pack: { id: 'test-fixtures', version: 'test-fixtures-v1' },
    task: { kind: reportTask.kind, version: reportTask.version, acceptFailedChecks: false },
    adapter: { id: 'mock', version: 'simulator-v1' },
  });
  assert.deepEqual(
    JSON.parse(first.instructions.layers.find(layer => layer.title === 'Execution contracts').text),
    first.contracts,
  );
  assert.deepEqual(first.assignment.resources, reportTask.requiredResources);
  assert.equal(first.reportDigest, first.artifacts[0].hash);
  await c.request(`/api/tasks/${initial.id}/revise`, { direction: 'Keep the accepted input identities.' });
  const second = await c.wait(initial.id, 'review');
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.outputFolder, first.outputFolder);
  assert.match(second.instructions.text, /Keep the accepted input identities/);
  assert.equal(c.app.store.attempt(first.id).instructions.hash, first.instructions.hash);
  assert.equal((await c.request(`/api/tasks/${initial.id}/accept`)).status, 200);
  const downstream = await c.wait(dependent.id, 'review');
  assert.equal(downstream.inputReferences[0].attemptId, second.id);
  assert.equal(downstream.inputReferences[0].artifacts[0].hash, second.artifacts[0].hash);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(downstream.outputFolder, 'report.json'))).sources[0].attemptId,
    second.id,
  );
  assert.equal((await c.request(`/api/tasks/${dependent.id}/accept`)).status, 200);
  const organization = c.app.store.organization();
  organization.companyName = 'Persisted director edits';
  c.app.store.setOrganization(organization);
  await c.app.close();
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { registries: c.registries } });
  await c.connect();
  assert.equal(c.app.store.organization().companyName, 'Persisted director edits');
  assert.equal(c.app.store.task(dependent.id).acceptedAttemptId, downstream.id);
  assert.equal(c.app.store.attempt(first.id).instructions.hash, first.instructions.hash);
  assert.deepEqual(c.app.store.attempt(second.id).contracts, second.contracts);
});

test('unknown kinds/adapters and unsupported capabilities block before claiming an attempt', async t => {
  const unavailable = { ...reportTask, kind: 'test:browser', requiredCapabilities: ['browser-evidence'] };
  const c = await setup(t, [reportTask, unavailable]);
  const count = c.app.store.tasks().length;
  assert.equal(
    (await c.request('/api/tasks', { title: 'Unknown', brief: 'No execution.', kind: 'missing', workerId: 'W-03' }))
      .status,
    400,
  );
  assert.equal(c.app.store.tasks().length, count);
  const blocked = await c.create('Unavailable capability', { kind: unavailable.kind });
  assert.equal((await c.request(`/api/tasks/${blocked.id}/start`)).status, 400);
  assert.match(c.app.store.task(blocked.id).reason, /lacks required capability: browser-evidence/);
  assert.equal(c.app.store.attempts(blocked.id).length, 0);
  assert.deepEqual(c.app.store.leases(), []);
  const unsupported = await c.create('Legacy unknown adapter');
  const org = c.app.store.organization();
  org.workers.find(worker => worker.id === unsupported.workerId).provider = 'missing';
  c.app.store.setOrganization(org);
  assert.equal((await c.request(`/api/tasks/${unsupported.id}/start`)).status, 400);
  assert.match(c.app.store.task(unsupported.id).reason, /Worker adapter is not implemented/);
  assert.equal(c.app.store.attempts(unsupported.id).length, 0);
  unsupported.kind = 'removed:kind';
  c.app.store.putTask(unsupported);
  await c.state();
  assert.match(c.app.store.task(unsupported.id).reason, /Unknown assignment kind/);
  assert.equal(
    (
      await c.request(
        `/api/workers/${unsupported.workerId}`,
        { provider: 'unreal-gateway-fixture', expectedVersion: 1 },
        'PATCH',
      )
    ).status,
    400,
  );
});

test('declared pack resources cannot be omitted and failed claims leave no employee reservation', async t => {
  const c = await setup(t),
    work = await c.create('Required resource', { resources: [] });
  c.app.store.tx(() => c.app.store.claim(reportTask.requiredResources, 'fixture-resource-owner'));
  // A held resource is a wait (MP-012): Start queues the task, and the failed claim reserves nothing.
  const response = await c.request(`/api/tasks/${work.id}/start`);
  assert.equal(response.status, 202);
  assert.equal(response.data.queued, true);
  assert.equal(response.data.reason, 'Waiting for resource document:registry-proof to become available.');
  assert.deepEqual(
    c.app.store.leases().map(lease => lease.attemptId),
    ['fixture-resource-owner'],
  );
  assert.equal(c.app.store.attempts(work.id).length, 0);
  c.app.store.release('fixture-resource-owner');
  // Freeing the resource is a change (MP-026), so the queued task starts by itself with the
  // declared resource and its employee, without a second Start.
  await waitFor(() => c.app.store.attempts(work.id).length, `an attempt of task ${work.id}`, { interval: 5 });
  assert.deepEqual(
    c.app.store.attempts(work.id).map(attempt => attempt.status),
    ['running'],
  );
  assert.deepEqual(
    c.app.store.leases().map(lease => lease.resource),
    ['document:registry-proof', 'employee:W-03'],
  );
  await c.wait(work.id, 'review');
  assert.deepEqual(c.app.store.leases(), []);
});

test('registered adapters use the same lifecycle and controller result gates', async t => {
  const c = await setup(t, [reportTask], registries =>
    registries.adapters.register({
      id: 'fixture-text',
      version: 'fixture-text-v1',
      name: 'Fixture text adapter',
      workerSelectable: true,
      capabilities: ['text-output'],
      status: () => ({ available: true, label: 'Model-free delivery fixture' }),
      blockReason: () => '',
      configuration: (runtime, worker) => structuredClone(worker),
      requestedModel: () => 'No model',
      delivery: 'Model-free fixture writes bounded report data.',
      deliveryScope: 'Private output folder only.',
      start(runtime, entry) {
        fs.writeFileSync(
          path.join(entry.output, 'report.json'),
          JSON.stringify({ direction: 'Fixture adapter', sources: [] }),
        );
        runtime.finish(entry, {
          taskId: entry.attempt.taskId,
          outcome: 'completed',
          summary: 'Fixture adapter delivery.',
          artifacts: [{ path: 'report.json', kind: 'fixture-report' }],
          checks: [],
          issues: [],
          handoff: 'Director acceptance required.',
        });
      },
    }),
  );
  assert.equal(
    (await c.request('/api/workers/W-03', { provider: 'fixture-text', expectedVersion: 1 }, 'PATCH')).status,
    200,
  );
  const work = await c.create('Registered adapter');
  assert.equal((await c.request(`/api/tasks/${work.id}/start`)).status, 202);
  const a = await c.wait(work.id, 'review');
  assert.equal(a.provider, 'fixture-text');
  assert.equal(a.contracts.adapter.version, 'fixture-text-v1');
  assert.equal(a.configuration.provider, 'fixture-text');
  assert.equal(a.reportDigest, a.artifacts[0].hash);
  assert.equal((await c.request(`/api/tasks/${work.id}/accept`)).status, 200);
});

test('pack validation cannot override attempt state or silently pass failing semantic checks', async t => {
  const bad = {
    ...reportTask,
    kind: 'test:invalid',
    validateOutput: () => ({
      checks: [{ name: 'Semantic failure', status: 'fail', evidence: 'Model-free rejection fixture.' }],
    }),
  };
  const metadata = {
    ...reportTask,
    kind: 'test:metadata',
    validateOutput: () => ({ metadata: { status: 'accepted' } }),
  };
  const c = await setup(t, [reportTask, bad, metadata]);
  for (const [kind, error] of [
    [bad.kind, /failed semantic validation/],
    [metadata.kind, /undeclared attempt metadata/],
  ]) {
    const work = await c.create('Reject invalid pack output', { kind });
    await c.request(`/api/tasks/${work.id}/start`);
    const a = await c.wait(work.id, 'failed');
    assert.match(a.error, error);
    assert.equal((await c.request(`/api/tasks/${work.id}/accept`)).status, 400);
    assert.deepEqual(c.app.store.leases(), []);
  }
  const registries = createRegistries();
  assert.throws(
    () => registries.workflows.register(testPack([{ ...reportTask, attemptFields: ['status'] }])),
    /controller-owned/,
  );
  assert.equal(registries.workflows.packs.has('test-fixtures'), false);
  assert.throws(() => registries.workflows.register(testPack([reportTask, { ...reportTask }])), /duplicate task/);
  assert.throws(() => registries.workflows.get(reportTask.kind), /Unknown assignment/);
});

test('a task type has a scope mode only with an operation that applies scope requests (MP-021)', () => {
  const registries = createRegistries(),
    apply = () => null;
  for (const autonomy of [
    { recommended: { scope: 'auto' } },
    { scopeRequest: { apply } },
    { scopeRequest: { label: 'Fixture requests' } },
    { scopeRequest: { label: 'Fixture requests', apply }, recommended: { scope: 'sometimes' } },
  ])
    assert.throws(
      () => registries.workflows.register(testPack([{ ...reportTask, autonomy }])),
      /Invalid task autonomy declaration/,
      JSON.stringify(autonomy),
    );
  registries.workflows.register(
    testPack([
      {
        ...reportTask,
        autonomy: {
          recommended: { accept: 'auto', scope: 'auto' },
          scopeRequest: { label: 'Fixture requests', apply },
        },
      },
    ]),
  );
  assert.equal(registries.workflows.describe()[reportTask.kind].scopeRequestLabel, 'Fixture requests');
});

test('a task type has an integrate mode only when it says when its result is ready to integrate (MP-023)', () => {
  const registries = createRegistries(),
    ready = () => null;
  for (const autonomy of [
    { recommended: { integrate: 'auto' } },
    { integration: { ready } },
    { integration: { label: 'Fixture integration' } },
    { integration: null },
    { integration: { label: 'Fixture integration', ready }, recommended: { integrate: 'sometimes' } },
    { scopeRequest: { label: 'Fixture requests', apply: ready }, recommended: { integrate: 'auto' } },
  ])
    assert.throws(
      () => registries.workflows.register(testPack([{ ...reportTask, autonomy }])),
      /Invalid task autonomy declaration/,
      JSON.stringify(autonomy),
    );
  registries.workflows.register(
    testPack([
      {
        ...reportTask,
        autonomy: {
          recommended: { accept: 'auto', integrate: 'auto' },
          integration: { label: 'Fixture integration', ready },
        },
      },
    ]),
  );
  const described = registries.workflows.describe()[reportTask.kind];
  assert.equal(described.integrationLabel, 'Fixture integration');
  assert.equal(described.scopeRequestLabel, undefined);
});

test('legacy review attempts and planning contexts retain acceptance and independent-review rules', async t => {
  const c = await setup(t);
  const legacy = c.app.store.task('R-001'),
    id = 'legacy-review-fixture',
    output = path.join(c.directory, 'jobs', id, 'output');
  fs.mkdirSync(output, { recursive: true });
  const content = JSON.stringify({
    verdict: 'revise',
    findings: ['Fixture finding'],
    evidence: ['Model-free legacy evidence'],
  });
  fs.writeFileSync(path.join(output, 'review.json'), content);
  const snapshot = {
    version: 'studio-instructions-v1',
    text: 'Recorded before extraction',
    layers: [],
    hash: hash('Recorded before extraction'),
  };
  c.app.store.insertAttempt(
    {
      id,
      taskId: legacy.id,
      workerId: legacy.workerId,
      provider: 'mock',
      status: 'review',
      outputFolder: output,
      artifacts: [{ path: 'review.json', kind: 'review', hash: hash(content), bytes: Buffer.byteLength(content) }],
      result: {
        taskId: legacy.id,
        outcome: 'completed',
        summary: 'Completed legacy review report.',
        artifacts: [{ path: 'review.json', kind: 'review' }],
        checks: [
          {
            name: 'Logical finding',
            status: 'fail',
            evidence: 'Report a revision; accepting the report is not accepting its source.',
          },
        ],
        issues: [],
        handoff: 'Director review.',
      },
    },
    snapshot,
  );
  legacy.status = 'review';
  legacy.lastAttemptId = id;
  c.app.store.putTask(legacy);
  assert.equal((await c.request('/api/tasks/R-001/accept')).status, 200);
  assert.deepEqual(c.app.store.attempt(id).instructions, snapshot);
  assert.equal(c.app.store.attempt(id).contracts, undefined);
  const context = planningContext(c.app.store.organization());
  delete context.reviewKinds;
  const plan = simulatedPlan(context, 'Legacy fixture brief');
  plan.tasks[1].dependencies = [];
  assert.throws(() => validatePlan(plan, context), /planned review needs prerequisite artifacts/);
  await c.app.close();
  const reopened = new CoreStore(c.directory, () => {
    throw new Error('Existing databases must not be reseeded.');
  });
  assert.deepEqual(reopened.attempt(id).instructions, snapshot);
  assert.equal(reopened.task(legacy.id).acceptedAttemptId, id);
  reopened.close();
});

test('core repair-plan validation uses explicitly supplied review kinds', async t => {
  const c = await setup(t),
    context = planningContext(c.app.store.organization());
  context.kinds = ['test:produce', 'test:inspect'];
  context.reviewKinds = ['test:inspect'];
  context.repair = { verdict: 'revise' };
  context.acceptedInputs = [{ taskId: 'accepted-fixture-source' }];
  const proposal = simulatedPlan(context, 'Fixture repair');
  proposal.tasks[0].kind = 'test:produce';
  proposal.tasks[1].kind = 'test:inspect';
  assert.equal(validateCorePlan(proposal, context).tasks, 2);
  proposal.tasks[1].workerId = proposal.tasks[0].workerId;
  assert.throws(() => validateCorePlan(proposal, context), /different employee/);
});

test('a task definition runs one task through stages without naming any kind in the core', async t => {
  // Two neutral stages on one record: a draft by one employee, then a check of that
  // exact accepted draft by another, each its own attempt with its own kind and inputs.
  const check = { ...reportTask, kind: 'test:check', version: 'test-check-v1', label: 'Fixture check' };
  const reference = attempt => ({
    taskId: attempt.taskId,
    attemptId: attempt.id,
    summary: 'Accepted draft supplied by the stage hook.',
    artifacts: attempt.artifacts.map(({ path, kind, hash }) => ({ path, kind, hash })),
  });
  const staged = {
    ...reportTask,
    kind: 'test:staged',
    label: 'Fixture staged report',
    revalidateOnAccept: true,
    stages: {
      view: task =>
        task.stage?.phase === 'check'
          ? {
              ...task,
              kind: check.kind,
              workerId: task.stage.workerId,
              team: task.stage.team,
              dependencies: [task.id],
              maxAttempts: 1,
            }
          : task,
      attempts: (store, task) =>
        store
          .attempts(task.id)
          .filter(attempt => attempt.assignment.kind === (task.stage?.phase === 'check' ? check.kind : 'test:staged')),
      progress: task => {
        if (task.stage) task.stage.status = task.status;
      },
      inputs: (store, task) => [task.stage.input],
      finished: (task, attempt) => {
        if (task.stage) task.stage.finishedKind = attempt.assignment.kind;
      },
      accepted: (store, registries, task, attempt) => {
        if (attempt.assignment.kind === check.kind) task.stage.phase = 'done';
        else {
          const worker = store.organization().workers.find(worker => worker.id === 'W-04');
          task.stage = { phase: 'check', workerId: worker.id, team: worker.team, input: reference(attempt) };
          Object.assign(task, { status: 'ready', queued: true, reason: '', controllerWait: true });
        }
        store.putTask(task);
      },
      clear: task => delete task.stage,
    },
  };
  const c = await setup(t, [reportTask, check, staged]),
    work = await c.create('Draft, then an independent check', { kind: staged.kind }),
    records = c.app.store.tasks().length;
  await c.request(`/api/tasks/${work.id}/start`);
  const draft = await c.wait(work.id, 'review');
  assert.equal(draft.assignment.kind, staged.kind);
  assert.equal((await c.request(`/api/tasks/${work.id}/accept`)).status, 200);
  const checked = await c.wait(work.id, 'review');
  assert.notEqual(checked.id, draft.id);
  assert.equal(checked.assignment.kind, check.kind);
  assert.equal(checked.workerId, 'W-04');
  assert.equal(checked.contracts.task.kind, check.kind);
  assert.equal(checked.inputReferences[0].attemptId, draft.id);
  assert.equal(checked.inputReferences[0].summary, 'Accepted draft supplied by the stage hook.');
  assert.equal(checked.inputReferences[0].artifacts[0].hash, draft.artifacts[0].hash);
  assert.equal(c.app.store.task(work.id).stage.finishedKind, check.kind);
  assert.equal((await c.request(`/api/tasks/${work.id}/accept`)).status, 200);
  const done = c.app.store.task(work.id);
  assert.equal(done.status, 'done');
  assert.equal(done.stage.phase, 'done');
  assert.equal(done.acceptedAttemptId, checked.id);
  assert.equal(c.app.store.attempts(work.id).length, 2);
  assert.equal(c.app.store.tasks().length, records, 'stages create no separate task records');
  assert.deepEqual(c.app.store.leases(), []);

  const registries = createRegistries();
  for (const stages of [{ advance() {} }, { view: 'not a function' }, []])
    assert.throws(
      () => registries.workflows.register(testPack([{ ...reportTask, kind: 'test:bad-stages', stages }])),
      /Task stages support only these synchronous hooks/,
    );
});

test('data formats type task ports: composition, proposals, results and dispatched inputs are checked', async t => {
  // Neutral formats. The Simulator labels each artifact with its task kind.
  const notes = {
      id: 'fixture-notes-v1',
      label: 'Fixture notes',
      artifactKind: 'test:writer',
      validate: value => {
        if (typeof value.direction !== 'string') throw new Error('Fixture notes need a direction.');
      },
    },
    figures = { id: 'fixture-figures-v1', label: 'Fixture figures', artifactKind: 'test:other' },
    strict = {
      id: 'fixture-strict-v1',
      label: 'Strict fixture',
      artifactKind: 'test:strict',
      validate: value => {
        if (!value.approvedBy) throw new Error('Strict fixture needs approvedBy.');
      },
    };
  const job = (key, kind, dependencies = []) => ({
    key,
    title: `Proposed ${key}`,
    kind,
    workerId: 'W-04',
    brief: 'Bounded fixture.',
    acceptance: 'Recorded fixture evidence.',
    dependencies,
    resources: [],
    maxSeconds: 30,
    maxAttempts: 1,
  });
  const task = (kind, fields) => ({ ...reportTask, kind, label: kind, ...fields });
  const planner = (kind, jobs) =>
    task(kind, { autoProposeWork: true, proposeWork: () => ({ path: 'report.json', tasks: jobs }) });
  const tasks = [
    reportTask,
    task('test:writer', { produces: [notes.id] }),
    task('test:other', { produces: [figures.id] }),
    task('test:reader', { consumes: [notes.id] }),
    task('test:mislabeled', { produces: [figures.id] }),
    task('test:strict', { produces: [strict.id] }),
    planner('test:planner-linked', [job('write', 'test:writer'), job('read', 'test:reader', ['write'])]),
    planner('test:planner-unlinked', [job('read', 'test:reader')]),
  ];
  const c = await setup(t, tasks, () => {}, [notes, figures, strict]);
  const state = await c.state();
  assert.deepEqual(state.taskKinds['test:reader'].consumes, [notes.id]);
  assert.deepEqual(state.taskKinds['test:writer'].produces, [notes.id]);

  // Composition: a typed consumer needs a prerequisite that produces its format.
  const step = (key, kind, dependencies = []) => ({
    key,
    title: key,
    kind,
    workerId: 'W-03',
    brief: 'Bounded fixture.',
    acceptance: 'Recorded fixture evidence.',
    dependencies,
    resources: [],
    maxSeconds: 30,
    maxAttempts: 1,
  });
  assert.equal(
    validateWorkflow(c.app.store, c.registries, [step('write', 'test:writer'), step('read', 'test:reader', ['write'])])
      .steps,
    2,
  );
  for (const steps of [
    [step('other', 'test:other'), step('read', 'test:reader', ['other'])],
    [step('read', 'test:reader')],
    [step('plain', reportTask.kind), step('read', 'test:reader', ['plain'])],
  ])
    assert.throws(
      () => validateWorkflow(c.app.store, c.registries, steps),
      /Step read consumes Fixture notes \(fixture-notes-v1\), but none of its prerequisites produces it/,
    );

  // Results carry their produced formats, with valid contents.
  const run = async (kind, status, extra = {}) => {
    const work = await c.create(kind, { kind, ...extra });
    await c.request(`/api/tasks/${work.id}/start`);
    return { work, attempt: await c.wait(work.id, status) };
  };
  assert.match((await run('test:mislabeled', 'failed')).attempt.error, /missing its produced Fixture figures/);
  assert.match((await run('test:strict', 'failed')).attempt.error, /Strict fixture needs approvedBy/);
  const written = await run('test:writer', 'review');
  assert.equal(
    written.attempt.controllerChecks.find(check => check.name === 'Produced data format fixture-notes-v1').status,
    'pass',
  );

  // Dispatch: staged inputs must carry each consumed format.
  const other = await run('test:other', 'review');
  assert.equal((await c.request(`/api/tasks/${other.work.id}/accept`)).status, 200);
  assert.equal((await c.request(`/api/tasks/${written.work.id}/accept`)).status, 200);
  const starved = await c.create('Reader without notes', { kind: 'test:reader', dependencies: [other.work.id] });
  assert.equal((await c.request(`/api/tasks/${starved.id}/start`)).status, 400);
  assert.match(c.app.store.task(starved.id).reason, /Inputs are missing consumed Fixture notes \(fixture-notes-v1\)/);
  assert.equal(c.app.store.attempts(starved.id).length, 0);
  const fed = await run('test:reader', 'review', { dependencies: [written.work.id] });
  assert.equal(fed.attempt.inputReferences[0].artifacts[0].kind, 'test:writer');

  // Proposals: a proposed consumer needs a producing sibling, source or pinned input.
  const linked = await run('test:planner-linked', 'review');
  assert.equal(c.app.store.task(linked.work.id).proposedTaskIds.length, 2);
  assert.match(
    (await run('test:planner-unlinked', 'failed')).attempt.error,
    /Proposed task read consumes Fixture notes \(fixture-notes-v1\), but none of its prerequisites produces it/,
  );
  assert.deepEqual(c.app.store.leases(), []);

  const registries = createRegistries();
  assert.throws(
    () => registries.workflows.register(testPack([task('test:unknown-port', { consumes: ['missing-v1'] })])),
    /Unknown data format: missing-v1/,
  );
  assert.throws(
    () =>
      registries.workflows.register(
        testPack([reportTask], [notes, { ...notes, label: 'A different definition with the same ID' }]),
      ),
    /fixture-notes-v1 is already registered/,
  );
});

test('the controller lists the adapters that start no model, so Runs never hard-codes them', () => {
  const adapters = createRegistries().adapters,
    modelFree = adapters.modelFree();
  assert.deepEqual(new Set(modelFree), new Set(['mock', 'local-operation', 'source-checks', 'unreal-gateway-fixture']));
  // Model CLIs have delivery modes; a wrapper such as the source edit delegates to one.
  for (const id of ['codex', 'claude', 'source-change']) assert.ok(!modelFree.includes(id), id);
  assert.ok(adapters.find('source-change').modelFor);
});

test('an attempt stopped by a usage limit does not count toward an attempt limit, except a fixed one', () => {
  const { workflows } = createRegistries(),
    stopped = { id: 'attempt-stopped', status: 'blocked', subscriptionHold: 'codex' },
    failed = { id: 'attempt-failed', status: 'failed' },
    store = {
      task: id => ({ id, kind: 'layout' }),
      attempts: () => [stopped, failed],
    };
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'layout' }), [failed]);
  store.task = id => ({ id, kind: 'unreal-integration' });
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'unreal-integration' }), [stopped, failed]);
});
