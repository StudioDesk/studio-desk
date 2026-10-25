import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { Autonomy } from '../src/core/autonomy-runtime.mjs';
import { hash } from '../src/core/contracts.mjs';

// A trusted, simulator-only pack: a producer proposes a worker task, and the
// worker proposes an independent checker. Directions select fixture behavior.
const step = (key, kind, workerId) => ({
  key,
  kind,
  workerId,
  title: `Fixture ${key}`,
  brief: 'Model-free autonomy fixture.',
  acceptance: 'Fixture checks pass.',
  dependencies: [],
  resources: [],
  maxSeconds: 30,
  maxAttempts: 3,
});
const simulated = ({ attempt }) => ({
  artifact: 'out.json',
  data: { direction: attempt.assignment.direction || '' },
  checks: [],
});
const kinds = [
  {
    kind: 'auto:producer',
    version: 'auto-producer-v1',
    label: 'Autonomy producer fixture',
    creatable: true,
    requiredCapabilities: ['text-output'],
    requiredResources: [],
    autoProposeWork: true,
    autonomy: { recommended: { accept: 'auto' } },
    instructions: () => ({ scopeNote: 'Fixture.' }),
    simulate: simulated,
    validateOutput: () => {},
    proposeWork: ({ task }) => ({
      path: 'out.json',
      tasks: [
        {
          ...step('work', task.brief.includes('checked') ? 'auto:checked-worker' : 'auto:worker', 'W-04'),
          brief: task.brief,
        },
      ],
    }),
  },
  {
    kind: 'auto:worker',
    version: 'auto-worker-v1',
    label: 'Autonomy worker fixture',
    proposalOnly: true,
    requiredCapabilities: ['text-output'],
    requiredResources: [],
    autonomy: { recommended: { approve: 'auto', accept: 'auto' } },
    instructions: () => ({ scopeNote: 'Fixture.' }),
    simulate: simulated,
    validateOutput({ task, checks }) {
      const fails =
        task.brief.includes('always-fail') ||
        (task.brief.includes('flaky') && !(task.direction || '').includes('Automatic retry'));
      checks.push({ name: 'Fixture outcome', status: fails ? 'fail' : 'pass', evidence: 'Fixture.' });
    },
    acceptFailedChecks: true,
    standaloneReport: true,
  },
  {
    kind: 'auto:checked-worker',
    version: 'auto-checked-worker-v1',
    label: 'Autonomy worker fixture with an independent check',
    proposalOnly: true,
    requiredCapabilities: ['text-output'],
    requiredResources: [],
    autoProposeWork: true,
    autonomy: { recommended: { approve: 'auto', accept: 'auto' } },
    instructions: () => ({ scopeNote: 'Fixture.' }),
    simulate: simulated,
    validateOutput: () => {},
    proposeWork: ({ task }) => ({
      path: 'out.json',
      tasks: [{ ...step('check', 'auto:checker', 'W-05'), brief: task.brief }],
    }),
  },
  {
    kind: 'auto:checker',
    version: 'auto-checker-v1',
    label: 'Autonomy checker fixture',
    proposalOnly: true,
    requiredCapabilities: ['text-output'],
    requiredResources: [],
    acceptFailedChecks: true,
    autonomy: {
      recommended: { approve: 'auto', accept: 'auto' },
      evaluate({ store, task }) {
        const source = store.task(task.dependencies[0]);
        const rejects = task.brief.includes('reject-always') || (task.brief.includes('reject-once') && !source.retryOf);
        return rejects
          ? { ok: false, reason: 'Checker rejected.', retryUpstream: { taskId: source.id, reason: 'Fix it.' } }
          : { ok: true, reason: 'Checker passed.' };
      },
    },
    instructions: () => ({ scopeNote: 'Fixture.' }),
    simulate: simulated,
    validateOutput: () => {},
  },
];
// Work that reads the source, as candidate and source checks do (test-only).
const sourceReader = {
  kind: 'auto:source-reader',
  version: 'auto-source-reader-v1',
  label: 'Source reader fixture',
  creatable: true,
  requiredCapabilities: ['text-output'],
  requiredResources: ['source:studio-desk-tests'],
  instructions: () => ({ scopeNote: 'Fixture.' }),
  simulate: simulated,
  validateOutput: () => {},
};
// A story with an integrated milestone, which the integration fixture below records, so linked work
// can wait for it to be integrated as it waits for a source story (test-only).
const integratedStory = {
  kind: 'auto:story',
  version: 'auto-story-v1',
  label: 'Integrated story fixture',
  creatable: true,
  requiredCapabilities: ['text-output'],
  requiredResources: [],
  milestones: { integrated: task => !!task.fixtureIntegrated },
  instructions: () => ({ scopeNote: 'Fixture.' }),
  simulate: simulated,
  validateOutput: () => {},
};
const recordIntegration = c => (runtime, task, attemptId, reviewHash) => {
  runtime.store.putTask({ ...runtime.store.task(task.id), fixtureIntegrated: true });
  c.integrations.push({ taskId: task.id, attemptId, reviewHash, active: runtime.active.size });
  return { state: 'integrated' };
};
const pauseReason = 'Waiting for the project to resume: this project is paused.';

async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-autonomy-'));
  const registries = createRegistries();
  registries.workflows.register({
    id: 'autonomy-fixtures',
    version: 'autonomy-fixtures-v1',
    tasks: [...kinds, ...(options.kinds || [])],
  });
  const previousDelay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '20';
  const c = { directory, registries, integrations: [], restarts: 0 };
  c.options = () => ({
    directory,
    port: 0,
    restart: options.supervised ? () => c.restarts++ : null,
    runnerOptions: {
      registries,
      ...(options.sourceChangeRoot ? { sourceChangeRoot: options.sourceChangeRoot } : {}),
      integrate:
        options.integrate?.(c) ||
        ((runtime, task, attemptId, reviewHash) => {
          c.integrations.push({ taskId: task.id, attemptId, reviewHash, active: runtime.active.size });
          return { state: 'integrated' };
        }),
    },
  });
  c.app = createStudio(c.options());
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
  c.reopen = async () => {
    await c.app.close();
    c.app = createStudio(c.options());
    await c.connect();
  };
  await c.connect();
  c.request = async (url, body = {}) => {
    const response = await fetch(c.origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  c.state = async () => (await fetch(c.origin + '/api/state')).json();
  c.policy = async (changes = {}) => {
    const current = (await c.state()).autonomy.policy;
    const response = await c.request('/api/projects/project-legacy/autonomy', {
      expectedRevision: current.revision,
      enabled: true,
      retries: 1,
      kinds: {
        'auto:producer': { approve: 'director', accept: 'auto' },
        'auto:worker': { approve: 'auto', accept: 'auto' },
        'auto:checked-worker': { approve: 'auto', accept: 'auto' },
        'auto:checker': { approve: 'auto', accept: 'auto' },
      },
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
      ...changes,
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  };
  c.produce = async brief => {
    const created = await c.request('/api/tasks', {
      title: 'Fixture producer',
      brief,
      kind: 'auto:producer',
      workerId: 'W-03',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal((await c.request(`/api/tasks/${created.data.id}/start`)).status, 202);
    return created.data.id;
  };
  c.until = (check, label) => waitFor(check, label, { detail: () => JSON.stringify(c.app.store.tasks().slice(-4)) });
  c.task = id => c.app.store.task(id);
  c.byKind = kind => c.app.store.tasks().filter(task => task.kind === kind);
  c.events = kind => c.app.store.events().filter(event => event.kind === kind);
  c.pipeline = async (action, projectId = 'project-legacy', taskIds) => {
    const response = await c.request('/api/pipeline', { projectId, action, ...(taskIds ? { taskIds } : {}) });
    assert.equal(response.status, 200, JSON.stringify(response.data));
  };
  return c;
}

// An accepted prerequisite story and a linked story the director queued, which waits for the
// prerequisite to be integrated.
async function linkedStory(c) {
  const create = async (title, extra = {}) => {
    const created = await c.request('/api/tasks', {
      title,
      brief: 'plain',
      kind: 'auto:story',
      workerId: 'W-02',
      ...extra,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.id;
  };
  const prerequisite = await create('Fixture prerequisite story');
  assert.equal((await c.request(`/api/tasks/${prerequisite}/start`)).status, 202);
  await c.until(() => c.task(prerequisite).status === 'review', 'prerequisite review');
  assert.equal((await c.request(`/api/tasks/${prerequisite}/accept`)).status, 200);
  const story = await create('Fixture linked story', { dependencies: [prerequisite] });
  c.app.store.putTask({ ...c.task(story), waitsFor: { [prerequisite]: 'integrated' } });
  await c.pipeline('queue', 'project-legacy', [story]);
  await c.until(
    () => c.task(story).reason === `Waiting for ${prerequisite} to be integrated.`,
    'the linked story to wait for its prerequisite',
  );
  return { prerequisite, story };
}

test('with autonomy off every result and proposal waits for the director', async t => {
  const c = await setup(t);
  const id = await c.produce('plain');
  await c.until(() => c.task(id).status === 'review', 'producer review');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.task(id).status, 'review');
  assert.equal((await c.request(`/api/tasks/${id}/accept`)).status, 200);
  const [work] = c.byKind('auto:worker');
  assert.equal(work.status, 'backlog');
  assert.equal(work.approval.status, 'pending');
  assert.equal(c.app.store.attempt(c.task(id).acceptedAttemptId).acceptedBy.type, 'director');
});

test('policy accepts passing results, approves allowed proposals and records its revision', async t => {
  const c = await setup(t);
  const policy = await c.policy();
  const id = await c.produce('plain');
  const work = await c.until(
    () => c.byKind('auto:worker').find(task => task.status === 'done'),
    'worker accepted automatically',
  );
  const producerAttempt = c.app.store.attempt(c.task(id).acceptedAttemptId);
  assert.deepEqual(
    { type: producerAttempt.acceptedBy.type, revision: producerAttempt.acceptedBy.revision },
    { type: 'policy', revision: policy.revision },
  );
  assert.equal(work.approval.by.type, 'policy');
  assert.equal(c.app.store.attempt(work.acceptedAttemptId).acceptedBy.reason, 'All recorded checks passed.');
  assert.ok(c.events('accepted').some(event => event.message.startsWith('Accepted by autonomy policy')));
});

test('director approval gates stop the loop, and approving resumes it without a separate start', async t => {
  const c = await setup(t);
  await c.policy({
    kinds: {
      'auto:producer': { approve: 'director', accept: 'auto' },
      'auto:worker': { approve: 'director', accept: 'auto' },
    },
  });
  await c.produce('plain');
  const pending = await c.until(
    () => c.byKind('auto:worker').find(task => task.autonomyNote),
    'approval gate attention',
  );
  assert.equal(pending.status, 'backlog');
  assert.match(pending.autonomyNote, /Approve or deny proposed work/);
  const attention = c.events('autonomy_attention').find(event => event.task_id === pending.id);
  assert.match(attention.message, /Approve or deny proposed work/);
  assert.equal((await c.request(`/api/tasks/${pending.id}/approve-work`)).status, 200);
  assert.equal(c.task(pending.id).autonomyNote, undefined);
  assert.equal(c.task(pending.id).reason, '');
  await c.until(() => c.task(pending.id).status === 'done', 'approved work runs and is accepted');
  assert.equal(c.task(pending.id).approval.by.type, 'director');
  assert.equal(c.task(pending.id).autonomyNote, undefined);
  assert.ok(
    c.events('autonomy_attention').some(event => event.seq === attention.seq && event.message === attention.message),
  );
});

test('a failing result retries once with failure details; a second failure waits for the director', async t => {
  const c = await setup(t);
  await c.policy();
  await c.produce('flaky');
  const flaky = await c.until(
    () => c.byKind('auto:worker').find(task => task.status === 'done'),
    'flaky work passes on retry',
  );
  assert.equal(flaky.autoRetries, 1);
  assert.match(flaky.direction, /Automatic retry 1: .*Fixture outcome/);
  assert.equal(c.app.store.attempts(flaky.id).length, 2);
  assert.equal(c.app.store.attempts(flaky.id)[0].status, 'revision_requested');

  await c.produce('always-fail');
  const stuck = await c.until(
    () => c.byKind('auto:worker').find(task => task.brief === 'always-fail' && task.autonomyNote),
    'second failure stops',
  );
  assert.equal(stuck.status, 'review');
  assert.equal(c.app.store.attempts(stuck.id).length, 2);
  assert.equal(stuck.autoRetries, 1);
});

test('a downstream rejection records evidence and retries the upstream task once', async t => {
  const c = await setup(t);
  await c.policy();
  await c.produce('checked reject-once');
  const retried = await c.until(
    () => c.byKind('auto:checked-worker').find(task => task.retryOf && task.status === 'done'),
    'upstream retry accepted',
  );
  assert.match(retried.direction, /requested changes[\s\S]*Fix it\./);
  assert.equal(retried.approval.by.type, 'policy');
  await c.until(
    () => c.byKind('auto:checker').filter(task => task.status === 'done').length === 2,
    'second checker passes',
  );
  const [first] = c.byKind('auto:checker');
  assert.match(c.app.store.attempt(first.acceptedAttemptId).acceptedBy.reason, /^Recorded as evidence/);

  await c.produce('checked reject-always');
  await c.until(
    () => c.byKind('auto:checker').find(task => task.brief.includes('reject-always') && task.autonomyNote),
    'retry limit reached',
  );
  assert.equal(c.byKind('auto:checked-worker').filter(task => task.brief.includes('reject-always')).length, 2);
});

test('policy saves are validated, revisioned and never enable unknown or unavailable task types', async t => {
  const c = await setup(t);
  const save = body =>
    c.request('/api/projects/project-legacy/autonomy', {
      expectedRevision: 0,
      enabled: true,
      retries: 0,
      kinds: {},
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
      ...body,
    });
  assert.equal((await save({ kinds: { 'missing:kind': { approve: 'auto', accept: 'auto' } } })).status, 400);
  assert.equal((await save({ kinds: { 'auto:worker': { approve: 'always', accept: 'auto' } } })).status, 400);
  assert.equal((await save({ retries: 2 })).status, 400);
  assert.equal((await save({ cycle: { enabled: true, workflowId: null, maxPerDay: 3 } })).status, 400);
  assert.equal((await save({ grantTools: true })).status, 400);
  assert.equal((await save({})).status, 200);
  assert.equal((await save({})).status, 400, 'Stale revision is rejected.');
  const state = await c.state();
  assert.equal(state.autonomy.policy.revision, 1);
  assert.deepEqual(state.autonomy.recommended['auto:worker'], { approve: 'auto', accept: 'auto' });

  const workflow = await c.request('/api/workflows', {
    name: 'Saved cycle policy fixture',
    steps: [step('produce', 'auto:producer', 'W-03')],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.data));
  const cycle = { enabled: true, workflowId: workflow.data.id, maxPerDay: 9 };
  const on = await save({ expectedRevision: 1, cycle });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  const unrelated = await save({ expectedRevision: 2, enabled: false, retries: 1, cycle: on.data.cycle });
  assert.equal(unrelated.status, 200, JSON.stringify(unrelated.data));
  assert.deepEqual(unrelated.data.cycle, cycle, 'An unrelated revisioned save preserves the enabled cycle.');
  const beforeDisable = unrelated.data;
  const disabled = await save({
    expectedRevision: beforeDisable.revision,
    enabled: beforeDisable.enabled,
    retries: beforeDisable.retries,
    kinds: beforeDisable.kinds,
    cycle: { ...beforeDisable.cycle, enabled: false },
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
  const persisted = (await c.state()).autonomy.policy;
  assert.deepEqual(persisted.cycle, { ...cycle, enabled: false });
  assert.equal(persisted.enabled, beforeDisable.enabled);
  assert.equal(persisted.retries, beforeDisable.retries);
  assert.deepEqual(persisted.kinds, beforeDisable.kinds);
  assert.deepEqual(persisted.history.slice(0, -1), beforeDisable.history, 'Earlier history entries remain unchanged.');
  assert.deepEqual(
    persisted.history.map(entry => entry.revision),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    persisted.history.slice(1).map(entry => entry.cycle),
    [cycle, cycle, { ...cycle, enabled: false }],
  );
});

test('integration waits for running work, then integrates and requests a restart without the supervisor', async t => {
  const c = await setup(t);
  await c.policy();
  const review = c.app.store.task(await c.produce('plain'));
  assert.equal(c.app.runner.active.size, 1);
  const pending = c.app.runner.autonomy.requestIntegration(review, 'attempt-x', 'hash-x');
  assert.equal(pending.state, 'waiting');
  assert.equal(c.app.store.organization().paused, true);
  assert.equal(c.integrations.length, 0);
  await c.until(() => c.integrations.length === 1, 'integration after work finishes');
  assert.equal(c.integrations[0].active, 0);
  assert.equal(c.app.store.organization().paused, false, 'Previous dispatch state is restored.');
  assert.equal((await c.state()).autonomy.selfHosted, true);
  assert.equal((await c.state()).autonomy.restart.reason, `Load source integrated from ${review.id}.`);
  assert.ok(c.events('restart_required').length);
  // A manual restart completes the plan, so "restart required" does not persist.
  await c.reopen();
  assert.equal((await c.state()).autonomy.restart, null);
});

test('integrating into a separate development copy never pauses or restarts, and goes next on its resources', async t => {
  const development = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-development-copy-'));
  t.after(() => fs.rmSync(development, { recursive: true, force: true }));
  const c = await setup(t, { supervised: true, sourceChangeRoot: development, kinds: [sourceReader] });
  assert.equal(c.app.runner.selfHosted, false);
  assert.equal((await c.state()).autonomy.selfHosted, false);
  await c.policy();
  const review = c.app.store.task(await c.produce('plain'));
  assert.equal(c.app.runner.active.size, 1);
  // Integration by merge (MP-016) starts while other work runs; dispatch is never paused.
  c.app.runner.autonomy.requestIntegration(review, 'attempt-x', 'hash-x');
  assert.equal(c.integrations.length, 1);
  assert.equal(c.integrations[0].active, 1);
  assert.equal(c.app.store.organization().paused, false);
  await c.until(() => c.events('source_ready_to_promote').length === 1, 'promotion notice');
  assert.equal(c.restarts, 0, 'The running controller did not change, so it does not restart.');
  assert.equal((await c.state()).autonomy.restart, null);
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, false);
  await c.until(() => !c.app.runner.active.size, 'fixture work to finish');
  // While a resource it needs is held, an approved integration waits without pausing anything,
  // and queued work that needs those resources waits behind it instead of taking them first.
  c.app.store.claim(['source:studio-desk-tests'], 'fixture-owner');
  assert.equal(c.app.runner.autonomy.requestIntegration(review, 'attempt-y', 'hash-y').state, 'waiting');
  assert.equal(c.app.store.organization().paused, false);
  const reader = await c.request('/api/tasks', {
    title: 'Fixture source reader',
    brief: 'plain',
    kind: 'auto:source-reader',
    workerId: 'W-03',
  });
  assert.equal(reader.status, 201, JSON.stringify(reader.data));
  assert.equal((await c.request(`/api/tasks/${reader.data.id}/start`)).status, 202);
  assert.equal(c.task(reader.data.id).reason, 'Waiting for resource source:studio-desk-tests to become available.');
  c.app.store.release('fixture-owner');
  c.app.runner.refreshReadiness();
  assert.equal(c.task(reader.data.id).reason, 'Waiting for the approved source integration.');
  assert.equal(c.app.runner.autonomy.tryIntegration().state, 'integrated');
  assert.equal(c.integrations.length, 2);
  await c.until(() => c.app.store.attempts(reader.data.id).length, 'the reader to start after the integration');
});

test("the policy queues work without lifting the director's pause, and it starts once they resume", async t => {
  const c = await setup(t);
  await c.policy();
  assert.equal((await c.request('/api/pipeline', { projectId: 'project-legacy', action: 'pause' })).status, 200);
  const created = await c.request('/api/tasks', {
    title: 'Queued while paused',
    brief: 'plain',
    kind: 'auto:producer',
    workerId: 'W-03',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  // As when the policy queues the next linked story after an integration (idea 18, October 22).
  c.app.runner.autonomy.approved(created.data.id);
  assert.equal(c.task(created.data.id).queued, true);
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true, 'The pause holds.');
  c.app.runner.schedule();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.attempts(created.data.id).length, 0, 'Nothing starts while paused.');
  assert.equal((await c.request('/api/pipeline', { projectId: 'project-legacy', action: 'resume' })).status, 200);
  await c.until(() => c.app.store.attempts(created.data.id).length, 'the queued work to start once resumed');
});

test('a planned restart resumes paused projects and starts capped cycles; unplanned restarts do not', async t => {
  const c = await setup(t, { supervised: true });
  const workflow = await c.request('/api/workflows', {
    name: 'Fixture cycle',
    steps: [step('produce', 'auto:producer', 'W-03')],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.data));
  await c.policy({ cycle: { enabled: true, workflowId: workflow.data.id, maxPerDay: 1 } });
  const marker = () =>
    c.app.store.putSetting('planned-restart', {
      reason: 'Fixture restart.',
      resumeProjects: ['project-legacy'],
      cycleProjects: ['project-legacy'],
      requestedAt: new Date().toISOString(),
    });
  marker();
  await c.reopen();
  await c.until(() => c.byKind('auto:producer').length === 1, 'first cycle');
  assert.equal(c.app.store.setting('planned-restart'), null);
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, false);

  marker();
  await c.reopen();
  await c.until(
    () => c.events('autonomy_attention').some(event => event.message.includes('Daily cycle cap')),
    'cycle cap',
  );
  assert.equal(c.byKind('auto:producer').length, 1);

  // No marker: a crash or manual restart keeps the existing pause-on-restart behavior.
  const before = c.app.store.tasks().length;
  await c.reopen();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.tasks().length, before);
});

// October 23: the director paused Studio desk, and the linked story waiting for an integrated story
// started when that integration settled.
test('an integration into a separate development copy leaves a paused project paused and its linked story waiting', async t => {
  const development = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-development-copy-'));
  t.after(() => fs.rmSync(development, { recursive: true, force: true }));
  const c = await setup(t, { sourceChangeRoot: development, kinds: [integratedStory], integrate: recordIntegration });
  await c.policy();
  const { prerequisite, story } = await linkedStory(c);
  await c.pipeline('pause');
  assert.equal(c.task(story).reason, `Waiting for ${prerequisite} to be integrated.`, 'Its own wait comes first.');
  const integrated = c.app.runner.autonomy.requestIntegration(c.task(prerequisite), 'attempt-x', 'hash-x');
  assert.equal(integrated.state, 'integrated');
  assert.equal(c.events('source_ready_to_promote').length, 1);
  await c.until(() => c.task(story).reason === pauseReason, 'the linked story to wait for the pause');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.attempts(story).length, 0, 'Nothing starts while paused.');
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true, 'The integration does not lift the pause.');
  assert.equal(c.task(story).reason, pauseReason);
  assert.equal(c.task(story).controllerWait, true);
  await c.pipeline('resume');
  await c.until(() => c.app.store.attempts(story).length, 'the linked story to start once resumed');
  assert.notEqual(c.task(story).reason, pauseReason);
});

test('a planned restart lifts only the pause the controller made, so a linked story in a director-paused project waits', async t => {
  const c = await setup(t, { supervised: true, kinds: [integratedStory], integrate: recordIntegration });
  await c.policy();
  const { prerequisite, story } = await linkedStory(c);
  // A restart pauses the project it finds with queued work and marks that pause as its own.
  await c.reopen();
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true);
  assert.equal(c.app.store.project('project-legacy').restartPaused, true);
  // A planned restart lifts the controller's own pause.
  c.app.store.putSetting('planned-restart', {
    reason: 'Fixture restart.',
    resumeProjects: ['project-legacy'],
    cycleProjects: [],
    requestedAt: new Date().toISOString(),
  });
  await c.reopen();
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, false);
  assert.equal(c.app.store.project('project-legacy').restartPaused, undefined);
  // The director's pause holds through an integration and the planned restart it requests.
  await c.pipeline('pause');
  const integrated = c.app.runner.autonomy.requestIntegration(c.task(prerequisite), 'attempt-x', 'hash-x');
  assert.equal(integrated.state, 'integrated');
  assert.deepEqual(c.app.runner.autonomy.restartRequired().resumeProjects, ['project-legacy']);
  await c.reopen();
  await c.until(() => c.task(story).reason === pauseReason, 'the linked story to wait for the pause');
  assert.equal(c.app.store.setting('planned-restart'), null, 'The planned restart completed.');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.attempts(story).length, 0, 'Nothing starts while paused.');
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true, 'The restart does not lift the pause.');
  assert.equal(c.task(story).reason, pauseReason);
  await c.pipeline('resume');
  await c.until(() => c.app.store.attempts(story).length, 'the linked story to start once resumed');
  assert.notEqual(c.task(story).reason, pauseReason);
});

test('an automatic cycle in a director-paused project is queued and counted, and starts only once they resume', async t => {
  const c = await setup(t, { supervised: true });
  const workflow = await c.request('/api/workflows', {
    name: 'Fixture cycle',
    steps: [step('produce', 'auto:producer', 'W-03')],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.data));
  await c.policy({ cycle: { enabled: true, workflowId: workflow.data.id, maxPerDay: 1 } });
  await c.pipeline('pause');
  c.app.store.putSetting('planned-restart', {
    reason: 'Fixture restart.',
    resumeProjects: ['project-legacy'],
    cycleProjects: ['project-legacy'],
    requestedAt: new Date().toISOString(),
  });
  await c.reopen();
  const producer = await c.until(() => c.byKind('auto:producer')[0], 'the cycle');
  await c.until(() => c.task(producer.id).reason === pauseReason, 'the cycle to wait for the pause');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.task(producer.id).queued, true);
  assert.equal(c.app.store.attempts(producer.id).length, 0, 'Nothing starts while paused.');
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true, 'The cycle does not lift the pause.');
  // The held run counts against the daily cap.
  assert.equal(c.app.runner.autonomy.startCycle('project-legacy'), null);
  assert.ok(c.events('autonomy_attention').some(event => event.message.includes('Daily cycle cap (1)')));
  await c.pipeline('resume');
  await c.until(() => c.app.store.attempts(producer.id).length, 'the cycle to start once resumed');
  assert.notEqual(c.task(producer.id).reason, pauseReason);
});

test('a project pause holds queued work with its reason while a running attempt finishes and other projects dispatch', async t => {
  const c = await setup(t, { kinds: [integratedStory] });
  await c.policy();
  // Work queued before the pause, waiting for a resource.
  c.app.store.claim(['fixture:held'], 'fixture-owner');
  const created = await c.request('/api/tasks', {
    title: 'Queued before the pause',
    brief: 'plain',
    kind: 'auto:story',
    workerId: 'W-02',
    resources: ['fixture:held'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const waiting = created.data.id;
  await c.pipeline('queue', 'project-legacy', [waiting]);
  await c.until(
    () => c.task(waiting).reason === 'Waiting for resource fixture:held to become available.',
    'the resource wait',
  );
  // An attempt that is still running when the director pauses the project.
  process.env.STUDIO_MOCK_DELAY_MS = '400';
  const running = await c.produce('plain');
  process.env.STUDIO_MOCK_DELAY_MS = '20';
  await c.pipeline('pause');
  assert.equal(c.app.runner.active.size, 1, 'The attempt is running when the pause is pressed.');
  assert.equal(c.task(waiting).reason, pauseReason, 'The pause comes before the resource wait.');
  assert.equal(c.task(waiting).controllerWait, true);
  c.app.store.release('fixture-owner');
  // The running attempt finishes and the policy accepts it as before; the work it proposed waits.
  await c.until(() => c.task(running).status === 'done', 'the running attempt to be accepted');
  assert.equal(c.app.store.attempts(running).length, 1);
  assert.equal(c.app.store.attempt(c.task(running).acceptedAttemptId).acceptedBy.type, 'policy');
  const work = await c.until(
    () => c.byKind('auto:worker').find(task => task.queued && task.reason === pauseReason),
    'the proposed work to wait for the pause',
  );
  // Another project's queued work starts while this one is paused.
  const other = await c.request('/api/projects', { name: 'Second fixture project' });
  assert.equal(other.status, 201, JSON.stringify(other.data));
  const elsewhere = await c.request('/api/tasks', {
    projectId: other.data.id,
    title: 'Work in another project',
    brief: 'Bounded model-free work.',
    kind: 'general',
    workerId: 'W-06',
  });
  assert.equal(elsewhere.status, 201, JSON.stringify(elsewhere.data));
  await c.pipeline('queue', other.data.id, [elsewhere.data.id]);
  await c.until(() => c.app.store.attempts(elsewhere.data.id).length, "the other project's work to start");
  assert.equal(c.app.store.project(other.data.id).dispatchPaused, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true);
  for (const id of [waiting, work.id]) {
    assert.equal(c.app.store.attempts(id).length, 0, 'Nothing starts while paused.');
    assert.equal(c.task(id).reason, pauseReason);
  }
  await c.pipeline('resume');
  for (const id of [waiting, work.id]) {
    await c.until(() => c.app.store.attempts(id).length, `${id} to start once resumed`);
    assert.notEqual(c.task(id).reason, pauseReason);
  }
});

test('an independent review and an automatic retry queued in a paused project wait with the pause reason until resumed', async t => {
  const c = await setup(t);
  await c.policy();
  await c.pipeline('pause');
  // The director's own Start still runs work in a paused project; what the controller queues after it waits.
  await c.produce('checked');
  const checked = await c.until(
    () => c.byKind('auto:checked-worker').find(task => task.reason === pauseReason),
    'the approved work to wait for the pause',
  );
  assert.equal(c.app.store.attempts(checked.id).length, 0);
  assert.equal((await c.request(`/api/tasks/${checked.id}/start`)).status, 202);
  await c.until(() => c.task(checked.id).status === 'done', 'the checked work to be accepted');
  const review = await c.until(
    () => c.byKind('auto:checker').find(task => task.queued && task.reason === pauseReason),
    'the independent review to wait for the pause',
  );
  await c.produce('flaky');
  const flaky = await c.until(
    () => c.byKind('auto:worker').find(task => task.reason === pauseReason),
    'the flaky work to wait for the pause',
  );
  assert.equal((await c.request(`/api/tasks/${flaky.id}/start`)).status, 202);
  await c.until(
    () => c.task(flaky.id).autoRetries === 1 && c.task(flaky.id).reason === pauseReason,
    'the automatic retry to wait for the pause',
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.app.store.attempts(review.id).length, 0, 'The review does not start while paused.');
  assert.equal(c.app.store.attempts(flaky.id).length, 1, 'The retry does not start while paused.');
  assert.equal(c.task(review.id).reason, pauseReason);
  assert.equal(c.task(flaky.id).queued, true);
  assert.equal(c.task(flaky.id).reason, pauseReason);
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true);
  await c.pipeline('resume');
  await c.until(() => c.task(review.id).status === 'done', 'the review to run and be accepted once resumed');
  await c.until(() => c.task(flaky.id).status === 'done', 'the retry to run and be accepted once resumed');
  assert.equal(c.app.store.attempts(review.id).length, 1);
  assert.equal(c.app.store.attempts(flaky.id).length, 2);
});

test('Studio desk autonomy: failing live tests stop, failing candidates retry, rejected candidates retry upstream', async () => {
  const { studioDevelopmentPack } = await import('../src/packs/studio-development/index.mjs');
  const definition = kind => studioDevelopmentPack.tasks.find(task => task.kind === kind).autonomy;
  const read = data => () => Buffer.from(JSON.stringify(data));
  const checks = definition('studio-development:checks');
  assert.equal(checks.evaluate({ readArtifact: read({ passed: true }), failed: [] }).ok, true);
  const failing = checks.evaluate({ readArtifact: read({ passed: false }), failed: [] });
  assert.equal(failing.ok, false);
  assert.equal(failing.retry, undefined, 'Live-source test failures are never retried automatically.');
  const change = definition('studio-development:change');
  const candidate = change.evaluate({
    failed: [{ name: 'Measured candidate checks', status: 'fail', evidence: '{"fail":1}' }],
  });
  assert.equal(candidate.retry, true);
  assert.match(candidate.reason, /Measured candidate checks/);
  const review = definition('studio-development:change-review');
  const attempt = { candidateReview: { taskId: 'T-change' } };
  assert.equal(review.evaluate({ attempt, readArtifact: read({ verdict: 'pass' }), failed: [] }).ok, true);
  const rejected = review.evaluate({
    attempt,
    readArtifact: read({ verdict: 'needs-work', summary: 'Edge case.', findings: ['Missing test.'] }),
    failed: [],
  });
  assert.equal(rejected.retryUpstream.taskId, 'T-change');
  assert.match(rejected.retryUpstream.reason, /Edge case\.\n- Missing test\./);
  assert.deepEqual(
    Object.fromEntries(studioDevelopmentPack.tasks.map(task => [task.kind, task.autonomy.recommended])),
    {
      'studio-development:checks': { accept: 'auto' },
      'studio-development:review': { accept: 'auto' },
      'studio-development:breakdown': { accept: 'auto' },
      'studio-development:change': { approve: 'director', accept: 'auto', scope: 'auto', integrate: 'auto' },
      'studio-development:change-review': { approve: 'auto', accept: 'auto' },
    },
  );
});

test('supervisor relaunches the controller after a planned restart and exits with its final code', async t => {
  const { spawnSync } = await import('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-supervisor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'src'));
  for (const script of ['supervisor.mjs', 'build-dashboard.mjs'])
    fs.copyFileSync(new URL('../scripts/' + script, import.meta.url), path.join(directory, 'scripts', script));
  // Fake controller: a planned restart (75) on the first launch, a clean exit on the second.
  fs.writeFileSync(
    path.join(directory, 'src/server.mjs'),
    `import fs from 'node:fs';
const marker = new URL('./launched', import.meta.url);
if (process.env.STUDIO_SUPERVISED !== '1') process.exit(9);
if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(75); }
process.exit(0);`,
  );
  const run = spawnSync(process.execPath, [path.join(directory, 'scripts/supervisor.mjs')], {
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /restarting to load updated source/);
  // Without installed build tools the new dashboard is not built, and the controller starts anyway (MP-026).
  assert.match(run.stdout, /Dashboard not built: run `npm ci`/);
  fs.writeFileSync(path.join(directory, 'src/server.mjs'), 'process.exit(75);');
  const looping = spawnSync(process.execPath, [path.join(directory, 'scripts/supervisor.mjs')], {
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(looping.status, 1);
  assert.match(looping.stderr, /more than 3 times in a minute/);
});

test('a verifying integration keeps dispatch paused until it settles; only a committed integration restarts', async t => {
  const settle = [];
  const c = await setup(t, {
    integrate: c => (runtime, task, attemptId, reviewHash, onSettled) => {
      c.integrations.push({ taskId: task.id, attemptId, reviewHash });
      settle.push(onSettled);
      return { state: 'verifying' };
    },
  });
  await c.policy();
  const review = c.app.store.task(await c.produce('plain'));
  await c.until(() => !c.app.runner.active.size, 'producer to finish');
  assert.equal(c.app.runner.autonomy.requestIntegration(review, 'attempt-x', 'hash-x').state, 'verifying');
  assert.equal(c.app.store.organization().paused, true);
  settle[0]({ state: 'rejected', error: 'Fixture verification failed.' });
  assert.equal(c.app.store.organization().paused, true, 'A rejected integration leaves dispatch paused.');
  assert.match(c.task(review.id).autonomyNote, /Fixture verification failed/);
  assert.equal((await c.state()).autonomy.restart, null);
  assert.equal(c.app.runner.autonomy.requestIntegration(review, 'attempt-x', 'hash-x').state, 'verifying');
  assert.equal((await c.state()).autonomy.restart, null, 'No restart while verification runs.');
  assert.equal(c.task(review.id).autonomyNote, undefined);
  assert.equal(c.task(review.id).reason, '');
  settle[1]({ state: 'integrated' });
  assert.equal(c.task(review.id).autonomyNote, undefined);
  assert.equal(c.task(review.id).reason, '');
  assert.equal((await c.state()).autonomy.restart.reason, `Load source integrated from ${review.id}.`);
});

test('source review acceptance uses its stage policy and a late integration callback ignores a closed store', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stage-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'jobs', 'stage-review', 'output');
  fs.mkdirSync(output, { recursive: true });
  const contents = JSON.stringify({ verdict: 'pass' });
  fs.writeFileSync(path.join(output, 'source-change-review.json'), contents);
  const attempt = {
    id: 'stage-review',
    taskId: 'story',
    status: 'review',
    result: { checks: [] },
    artifacts: [{ path: 'source-change-review.json', hash: hash(contents) }],
  };
  const task = {
    id: 'story',
    kind: 'studio-development:change',
    status: 'review',
    lastAttemptId: attempt.id,
    sourceStage: { phase: 'candidate-review', reviewTask: { kind: 'studio-development:change-review' } },
  };
  const context = { store: { directory, attempt: () => attempt }, runner: { registries: createRegistries() } };
  // An automatic implementation acceptance policy cannot accept its independent
  // review when that stage's acceptance remains a director decision.
  Autonomy.prototype.reviewed.call(context, task, {
    enabled: true,
    kinds: {
      'studio-development:change': { accept: 'auto' },
      'studio-development:change-review': { accept: 'director' },
    },
  });
  const closed = new Proxy(
    {},
    {
      get() {
        throw new Error('Store is closed.');
      },
    },
  );
  Autonomy.prototype.integrationSettled.call(
    { runner: { closing: true }, store: closed },
    task,
    {},
    { state: 'integrated' },
  );
});

test("a run's proposed work and automatic retries join its record as numbered revisions", async t => {
  const c = await setup(t);
  await c.policy();
  const saved = await c.request('/api/workflows', {
    name: 'Produce and check',
    steps: [{ ...step('produce', 'auto:producer', 'W-03'), brief: 'checked reject-once' }],
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const started = await c.request(`/api/workflows/${saved.data.id}/run`, { expectedVersion: 1 });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const { runId } = started.data;
  const retried = await c.until(
    () => c.byKind('auto:checked-worker').find(task => task.retryOf && task.status === 'done'),
    'upstream retry accepted',
  );
  await c.until(
    () => c.byKind('auto:checker').filter(task => task.status === 'done').length === 2,
    'second checker passes',
  );
  const run = c.app.store.run(runId),
    reasons = run.revisions.map(revision => revision.reason);
  assert.equal(run.revisions[0].revision, 1);
  assert.deepEqual(Object.values(run.revisions[0].tasks), started.data.taskIds);
  // Producer, worker and retried worker each proposed work; the retry is its own revision.
  assert.equal(reasons.filter(reason => / proposed work\.$/.test(reason)).length, 3);
  assert.equal(reasons.filter(reason => /^Automatic retry of /.test(reason)).length, 1);
  assert.deepEqual(
    run.revisions.map(revision => revision.revision),
    run.revisions.map((revision, index) => index + 1),
  );
  assert.equal(retried.runReference.runId, runId);
  const added = run.revisions.flatMap(revision => revision.added || []).map(item => item.taskId);
  for (const task of [...c.byKind('auto:checked-worker'), ...c.byKind('auto:checker')])
    assert.ok(added.includes(task.id), `${task.id} is recorded in its run`);
  const [view] = (await c.state()).runs.filter(item => item.id === runId);
  assert.equal(view.nodes.length, 1 + added.length);
  assert.equal(view.revisions.length, run.revisions.length);
});

test('an automatic retry names the failing tests and their errors, not only the counts', async t => {
  const c = await setup(t);
  const id = await c.produce('plain');
  await c.until(() => c.task(id).status === 'review', 'producer in review');
  const attempt = c.app.store.attempt(c.task(id).lastAttemptId);
  attempt.failedTests = [
    { name: 'settles after shutdown', file: 'stage.test.mjs', error: 'Store is closed.' },
    { name: 'keeps records', file: '' },
  ];
  c.app.store.updateAttempt(attempt);
  c.app.runner.autonomy.attention(c.task(id), 'The previous checks need attention.');
  c.app.runner.autonomy.retry(c.task(id), 'Candidate checks failed: 1 of 163 tests.', { revision: 1, retries: 1 });
  assert.equal(c.task(id).reason, '');
  assert.equal(c.task(id).autonomyNote, undefined);
  assert.equal(c.app.store.attempt(attempt.id).status, 'revision_requested');
  assert.equal(
    c.task(id).direction,
    'Automatic retry 1: the previous attempt did not pass. Candidate checks failed: 1 of 163 tests.\nFailing tests:\n- settles after shutdown (stage.test.mjs): Store is closed.\n- keeps records',
  );
});
