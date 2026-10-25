import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor, waitForTask } from './wait-for.mjs';
import { developmentOrganization } from '../src/organizations/studio-development/project.mjs';
import { studioDevelopmentPack } from '../src/packs/studio-development/index.mjs';
import { projectOrganization } from '../src/core/project-organization.mjs';

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-project-organization-'));
  const c = { directory, app: createStudio({ directory, port: 0 }) };
  c.connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await c.connect();
  t.after(async () => {
    await c.app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
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
  c.wait = async id => waitForTask(c.app.store, id, 'review', { interval: 10 });
  c.development = async () => {
    const response = await c.request('/api/studio-development');
    assert.equal(response.status, 201);
    return response.data;
  };
  c.config = (state, extra = {}) => ({
    expectedRevision: state.organizationConfiguration.revision,
    teams: state.organizationConfiguration.teams.map(({ goalTaskIds, ...team }) => team),
    members: state.organizationConfiguration.members,
    taskKinds: state.organizationConfiguration.taskKinds,
    kindOwners: state.organizationConfiguration.kindOwners,
    ...extra,
  });
  c.save = (projectId, config) =>
    c.request(`/api/projects/${projectId}/organization`, { projectId, ...config }, 'PATCH');
  c.create = async (projectId, extra = {}) => {
    const response = await c.request('/api/tasks', {
      projectId,
      title: 'Project organization fixture',
      brief: 'Model-free bounded notes.',
      acceptance: 'Recorded notes.',
      workerId: 'W-02',
      kind: 'general',
      maxSeconds: 30,
      ...extra,
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  return c;
}

test('software and generic projects have relevant teams and task catalogs without reseeding shared employees or game history', async t => {
  const c = await setup(t);
  await c.state('project-legacy');
  const baseline = JSON.stringify(c.app.store.organization()),
    legacy = JSON.stringify(c.app.store.tasks());
  const { project } = await c.development(),
    state = await c.state(project.id);
  assert.deepEqual(
    state.teams.map(team => team.name),
    ['Product', 'Engineering', 'Quality'],
  );
  assert.equal(state.workers.find(worker => worker.id === 'W-02').jobTitle, 'Software engineer');
  assert.equal(state.workers.find(worker => worker.id === 'W-07').jobTitle, 'Software reviewer');
  assert.equal(state.taskKinds.layout.available, false);
  assert.equal(state.taskKinds.plan.available, false);
  assert.equal(state.taskKinds['studio-development:checks'].available, true);
  const generic = (
    await c.request('/api/projects', {
      name: 'Local documentation project',
      goal: 'Write docs.',
      direction: 'Bounded notes.',
    })
  ).data;
  const neutral = await c.state(generic.id);
  assert.deepEqual(
    neutral.teams.map(team => team.name),
    ['Project team'],
  );
  assert.equal(neutral.taskKinds.general.available, true);
  assert.equal(neutral.taskKinds.layout.available, false);
  assert.equal(JSON.stringify(c.app.store.organization()), baseline);
  assert.equal(JSON.stringify(c.app.store.tasks()), legacy);
  const repeated = await c.development();
  assert.equal(repeated.project.id, project.id);
  assert.equal((await c.state(project.id)).organizationConfiguration.revision, 1);
  assert.equal(
    (
      await c.request(`/api/projects/${project.id}/organization`, {
        projectId: project.id,
        preset: 'studio-development',
        expectedRevision: 1,
      })
    ).status,
    400,
  );
});

test('project organization edits retain pending identity and decisions, reject invalid or stale structures atomically, and enforce catalogs', async t => {
  const c = await setup(t),
    { project, workflow } = await c.development(),
    initial = await c.state(project.id);
  const pending = await c.create(project.id, { planned: true });
  const approved = await c.create(project.id, { planned: true });
  assert.equal((await c.request(`/api/tasks/${approved.id}/approve-work`, { projectId: project.id })).status, 200);
  const decision = c.app.store.task(approved.id).approval;
  const config = c.config(initial);
  config.teams.find(team => team.id === 'engineering').name = 'Platform';
  config.members.find(member => member.workerId === 'W-02').role = 'Platform engineer';
  assert.equal((await c.save(project.id, config)).status, 200);
  const changed = c.app.store.task(pending.id);
  assert.equal(changed.team, 'Platform');
  assert.equal(changed.workerId, pending.workerId);
  assert.equal(changed.approval.status, 'pending');
  assert.equal(changed.ownerHistory[0].team, 'Engineering');
  assert.equal(changed.queued, undefined);
  assert.equal(changed.lastAttemptId, null);
  assert.equal(c.app.store.task(approved.id).team, 'Platform');
  assert.deepEqual(c.app.store.task(approved.id).approval, decision);
  assert.equal(c.app.store.attempts(approved.id).length, 0);
  const saved = c.app.store.setting('project-organization:' + project.id);
  assert.equal((await c.save(project.id, config)).status, 400);
  for (const mutate of [
    config => (config.teams[0].id = '__proto__'),
    config => config.members.push(config.members[0]),
    config => (config.teams[0].leadId = 'W-02'),
    config => config.taskKinds.push('unknown'),
    config => (config.kindOwners.general = 'W-08'),
    config => (config.members[0].permissions = ['source-write']),
  ]) {
    const invalid = c.config(await c.state(project.id));
    mutate(invalid);
    assert.equal((await c.save(project.id, invalid)).status, 400);
    assert.deepEqual(c.app.store.setting('project-organization:' + project.id), saved);
  }
  assert.equal(
    (
      await c.request('/api/tasks', {
        projectId: project.id,
        title: 'Game category bypass',
        brief: 'Should fail.',
        kind: 'layout',
        workerId: 'W-02',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await c.request('/api/plans', {
        projectId: project.id,
        title: 'Game planner bypass',
        brief: 'Should fail.',
        workerId: 'W-01',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await c.request('/api/workflows', {
        projectId: project.id,
        name: 'Nonmember bypass',
        steps: workflow.steps.map(step => ({ ...step, workerId: 'W-03' })),
      })
    ).status,
    400,
  );
  const available = c.config(await c.state(project.id));
  available.taskKinds = ['studio-development:checks'];
  available.kindOwners = { 'studio-development:checks': 'W-06' };
  assert.equal((await c.save(project.id, available)).status, 200);
  assert.equal((await c.request(`/api/tasks/${pending.id}/approve-work`, { projectId: project.id })).status, 400);
  assert.equal(c.app.store.task(pending.id).approval.status, 'pending');
});

test('project team and role drafts publish independently, and recorded organization/instruction snapshots survive later changes and restart', async t => {
  const c = await setup(t),
    { project } = await c.development(),
    task = await c.create(project.id);
  const publish = async (scope, id, text) => {
    assert.equal(
      (await c.request(`/api/instructions/${scope}/${id}/draft`, { projectId: project.id, baseRevision: 1, text }))
        .status,
      200,
    );
    assert.equal(
      (await c.request(`/api/instructions/${scope}/${id}/publish`, { projectId: project.id, baseRevision: 1, text }))
        .status,
      200,
    );
  };
  await publish('team', 'engineering', 'Review platform changes against measured tests.');
  await publish('employee', 'W-02', 'Produce bounded software evidence.');
  await publish('company', 'company', 'Improve the orchestration project with bounded accepted work.');
  assert.equal(c.app.store.organization().instructions.employees['W-02'].revision, 1);
  assert.equal((await c.request(`/api/tasks/${task.id}/start`, { projectId: project.id })).status, 202);
  const attempt = await c.wait(task.id),
    snapshot = JSON.stringify(attempt);
  assert.equal(attempt.organization.revision, 1);
  assert.equal(attempt.organization.role, 'Software engineer');
  assert.equal(attempt.assignment.team, 'Engineering');
  assert.equal(attempt.configuration.team, 'Engineering');
  assert.ok(
    attempt.instructions.layers.some(
      layer => layer.scope === 'team' && layer.projectId === project.id && layer.revision === 2,
    ),
  );
  assert.match(attempt.instructions.text, /Produce bounded software evidence/);
  const config = c.config(await c.state(project.id));
  config.members.find(member => member.workerId === 'W-02').role = 'Future platform owner';
  config.teams.find(team => team.id === 'engineering').name = 'Future platform';
  assert.equal((await c.save(project.id, config)).status, 200);
  assert.equal(JSON.stringify(c.app.store.attempt(attempt.id)), snapshot);
  assert.equal((await c.request(`/api/tasks/${task.id}/accept`, { projectId: project.id })).status, 200);
  const acceptedSnapshot = JSON.stringify(c.app.store.attempt(attempt.id));
  await c.app.close();
  c.app = createStudio({ directory: c.directory, port: 0 });
  await c.connect();
  assert.equal(JSON.stringify(c.app.store.attempt(attempt.id)), acceptedSnapshot);
  assert.equal((await c.state(project.id)).workers.find(worker => worker.id === 'W-02').role, 'Future platform owner');
  const next = await c.create(project.id);
  const preview = await c.request('/api/preview', { projectId: project.id, taskId: next.id, workerId: 'W-02' });
  assert.match(preview.data.text, /Future platform owner/);
});

test('project membership cannot create a second employee slot or rewrite active ownership; excluded pending owners require explicit reassignment', async t => {
  const c = await setup(t),
    { project } = await c.development(),
    task = await c.create(project.id),
    pending = await c.create(project.id, { planned: true });
  assert.equal((await c.request(`/api/tasks/${task.id}/start`, { projectId: project.id })).status, 202);
  const attempt = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId);
  const other = await c.create('project-legacy');
  // The shared employee is busy, which is a wait (MP-012): Start queues the other project's task.
  const queued = await c.request(`/api/tasks/${other.id}/start`);
  assert.equal(queued.status, 202);
  assert.equal(queued.data.queued, true);
  const employee = c.app.store.organization().workers.find(worker => worker.id === attempt.workerId);
  assert.equal(
    c.app.store.task(other.id).reason,
    `Waiting for ${employee.displayName}'s work on ${task.id} (${task.title}) to finish.`,
  );
  assert.ok(!c.app.store.task(other.id).reason.includes(attempt.id));
  assert.equal(c.app.store.attempts(other.id).length, 0);
  const config = c.config(await c.state(project.id));
  config.members = config.members.filter(member => member.workerId !== 'W-02');
  config.teams = config.teams.filter(team => team.id !== 'engineering');
  config.kindOwners['studio-development:change'] = 'W-01';
  assert.equal((await c.save(project.id, config)).status, 200);
  assert.equal(c.app.store.attempt(attempt.id).organization.team, 'Engineering');
  assert.equal(
    c.app.store.leases().some(lease => lease.resource === 'employee:W-02'),
    true,
  );
  assert.equal((await c.request(`/api/tasks/${pending.id}/approve-work`, { projectId: project.id })).status, 400);
  assert.equal(
    (await c.request(`/api/tasks/${pending.id}/project-owner`, { projectId: project.id, workerId: 'W-03' })).status,
    400,
  );
  assert.equal(
    (await c.request(`/api/tasks/${pending.id}/project-owner`, { projectId: project.id, workerId: 'W-01' })).status,
    200,
  );
  const moved = c.app.store.task(pending.id);
  assert.equal(moved.team, 'Product');
  assert.equal(moved.approval.status, 'pending');
  assert.equal(moved.ownerHistory[0].workerId, 'W-02');
  await c.wait(task.id);
  // Only after the employee's one attempt ends does the queued task start.
  await waitFor(() => c.app.store.attempts(other.id).length, `an attempt of task ${other.id}`);
  assert.equal(c.app.store.attempts(other.id).length, 1);
  assert.equal((await c.request(`/api/tasks/${task.id}/accept`, { projectId: project.id })).status, 200);
  assert.equal((await c.request(`/api/tasks/${pending.id}/approve-work`, { projectId: project.id })).status, 200);
  assert.equal(
    (await c.request(`/api/tasks/${pending.id}/project-owner`, { projectId: project.id, workerId: 'W-06' })).status,
    400,
  );
});

test('Morgan improvement ownership uses the configured project owner and all team/role document histories survive membership removal', async t => {
  const c = await setup(t),
    { project } = await c.development(),
    original = await c.state(project.id);
  const hook = studioDevelopmentPack.tasks.find(task => task.kind === 'studio-development:review').proposeWork;
  const readArtifact = () =>
    JSON.stringify({
      proposal: {
        title: 'Bounded software change',
        reason: 'Fixture review.',
        files: ['src/core/projects.mjs'],
        scope: 'A bounded change.',
        acceptance: 'Recorded tests.',
      },
    });
  const before = hook({ org: projectOrganization(c.app.store, project.id), readArtifact });
  assert.equal(before.tasks[0].workerId, 'W-02');
  const config = c.config(original);
  config.kindOwners['studio-development:change'] = 'W-01';
  assert.equal((await c.save(project.id, config)).status, 200);
  assert.equal(hook({ org: projectOrganization(c.app.store, project.id), readArtifact }).tasks[0].workerId, 'W-01');
  const savedDocs = c.app.store.setting('project-organization:' + project.id).instructions;
  const removed = c.config(await c.state(project.id));
  removed.members = removed.members.filter(member => member.teamId !== 'engineering');
  removed.teams = removed.teams.filter(team => team.id !== 'engineering');
  assert.equal((await c.save(project.id, removed)).status, 200);
  assert.deepEqual(c.app.store.setting('project-organization:' + project.id).instructions, savedDocs);
  const restored = { ...config, expectedRevision: 3 };
  assert.equal((await c.save(project.id, restored)).status, 200);
  assert.deepEqual((await c.state(project.id)).instructions.teams.engineering, savedDocs.teams.engineering);
  assert.equal((await c.state(project.id)).organizationConfiguration.history.length, 4);
});

test('explicit project configuration corrects a legacy pending software proposal while preserving its accepted evidence and attempt bytes', async t => {
  const c = await setup(t),
    hook = studioDevelopmentPack.tasks.find(task => task.kind === 'studio-development:review').proposeWork;
  const proposal = {
    title: 'Bounded software improvement',
    reason: 'Model-free source proposal fixture.',
    files: ['src/core/projects.mjs'],
    scope: 'Improve one project check.',
    acceptance: 'Measured tests pass.',
  };
  c.app.runner.registries.workflows.register({
    id: 'organization-proposal-fixture',
    version: 'fixture-v1',
    tasks: [
      {
        kind: 'test:software-proposal',
        version: 'fixture-v1',
        label: 'Fixture software proposal',
        creatable: true,
        autoProposeWork: true,
        requiredCapabilities: ['text-output'],
        requiredResources: [],
        instructions: () => ({ scopeNote: 'Model-free fixture only.' }),
        simulate: () => ({ artifact: 'source-review.json', data: { proposal }, checks: [] }),
        validateOutput: ({ readArtifact }) =>
          assert.deepEqual(JSON.parse(readArtifact('source-review.json')).proposal, proposal),
        proposeWork: hook,
      },
    ],
  });
  const source = await c.create('project-legacy', { workerId: 'W-07', kind: 'test:software-proposal' });
  assert.equal((await c.request(`/api/tasks/${source.id}/start`)).status, 202);
  await c.wait(source.id);
  assert.equal((await c.request(`/api/tasks/${source.id}/accept`)).status, 200);
  const attempt = c.app.store.attempt(c.app.store.task(source.id).acceptedAttemptId),
    snapshot = JSON.stringify(attempt),
    draftId = c.app.store.task(source.id).proposedTaskIds[0],
    before = c.app.store.task(draftId);
  assert.equal(before.team, 'Gameplay');
  const config = developmentOrganization(c.app.store.organization());
  config.taskKinds.push('test:software-proposal');
  assert.equal((await c.save('project-legacy', config)).status, 200);
  const after = c.app.store.task(draftId);
  assert.equal(after.team, 'Engineering');
  assert.deepEqual(after.proposalReference, before.proposalReference);
  assert.equal(after.workerId, before.workerId);
  assert.equal(after.approval.status, 'pending');
  assert.equal(after.queued, false);
  assert.equal(c.app.store.attempts(after.id).length, 0);
  assert.equal(JSON.stringify(c.app.store.attempt(attempt.id)), snapshot);
  assert.equal((await c.request(`/api/tasks/${after.id}/approve-work`)).status, 200);
  assert.equal((await c.request(`/api/tasks/${after.id}/start`)).status, 400);
  assert.match(c.app.store.task(after.id).reason, /no longer matches its accepted proposal/);
  assert.equal(c.app.store.attempts(after.id).length, 0);
});
