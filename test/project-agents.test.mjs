// A project's own agents (1.0.1): made in one project, working only there, renamed and deleted from it, while the
// studio's starting agents stay shared by every project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './studio-setup.mjs';

async function project(c, name) {
  const created = await c.request('/api/projects', { name });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.id;
}
const shape = (c, projectId) =>
  fetch(`${c.origin}/api/state?projectId=${projectId}&mode=dashboard`).then(response => response.json());
async function makeAgent(c, projectId, fields = {}) {
  const state = await shape(c, projectId);
  return c.request(`/api/projects/${projectId}/agents`, {
    projectId,
    expectedRevision: state.organizationConfiguration.revision,
    displayName: 'Nova',
    jobTitle: 'Copywriter',
    teamId: state.organizationConfiguration.teams[0].id,
    roles: ['copywriter'],
    provider: 'mock',
    ...fields,
  });
}
// The project's saved organization, in the shape its save takes.
function saveShape(state) {
  const config = state.organizationConfiguration;
  return {
    expectedRevision: config.revision,
    teams: config.teams.map(({ id, name, mark, purpose, goal, outcome, leadId }) => ({
      id,
      name,
      mark,
      purpose,
      goal,
      outcome,
      leadId,
    })),
    members: config.members,
    taskKinds: config.taskKinds,
    kindOwners: config.kindOwners,
  };
}

test('a new agent belongs to its project: its own instructions and team there, and no other project sees it', async t => {
  const c = await setup(t),
    first = await project(c, 'Marketing'),
    second = await project(c, 'Docs'),
    made = await makeAgent(c, first, { instructions: 'Write launch copy from the attached sources.' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const nova = made.data.worker;
  assert.match(nova.id, /^W-[0-9a-f]{8}$/);
  assert.equal(nova.projectId, first);
  assert.equal(nova.provider, 'mock');
  assert.equal(nova.cli, 'Simulator');
  const own = await shape(c, first),
    member = own.workers.find(worker => worker.id === nova.id);
  assert.equal(own.organizationConfiguration.revision, made.data.revision);
  assert.equal(member.displayName, 'Nova');
  assert.equal(member.jobTitle, 'Copywriter');
  assert.deepEqual(member.roles, ['copywriter']);
  assert.ok(own.employeeDirectory.some(worker => worker.id === nova.id));
  const docs = (await fetch(`${c.origin}/api/projects/${first}/instructions`).then(r => r.json())).projectInstructions;
  assert.equal(docs.employees[nova.id].text, 'Write launch copy from the attached sources.');
  assert.equal(docs.employees[nova.id].revision, 1);
  assert.equal(docs.employees[nova.id].history[0].note, 'Its first instructions');
  assert.match(c.app.store.events().at(-1).message, /^Nova joined .+ as Copywriter\.$/);

  // Another project neither lists it nor can staff it, change it or delete it.
  const other = await shape(c, second);
  assert.ok(!other.employeeDirectory.some(worker => worker.id === nova.id));
  const taken = saveShape(other);
  taken.members = [
    ...taken.members,
    { workerId: nova.id, teamId: taken.teams[0].id, role: 'Writer', responsibility: 'Writes.' },
  ];
  const joined = await c.request(`/api/projects/${second}/organization`, { projectId: second, ...taken });
  assert.equal(joined.status, 400);
  assert.equal(joined.data.error, 'Nova belongs to another project.');
  const changed = await c.request(
    `/api/workers/${nova.id}`,
    { projectId: second, model: '', expectedVersion: 1 },
    'PATCH',
  );
  assert.equal(changed.data.error, 'Nova belongs to another project.');
  const face = await c.request(`/api/workers/${nova.id}/look`, { projectId: second, look: null });
  assert.equal(face.data.error, 'Nova belongs to another project.');
  const removed = await c.request(`/api/projects/${second}/agents/${nova.id}/delete`, {
    projectId: second,
    expectedRevision: other.organizationConfiguration.revision,
  });
  assert.equal(removed.data.error, 'Nova belongs to another project.');

  // A project made later starts from the shared agents only.
  const third = await shape(c, await project(c, 'Later'));
  assert.ok(!third.workers.some(worker => worker.id === nova.id));
  assert.ok(!third.organizationConfiguration.members.some(item => item.workerId === nova.id));
});

test('a new agent is checked before anything is saved', async t => {
  const c = await setup(t),
    id = await project(c, 'Marketing'),
    before = structuredClone(c.app.store.organization()),
    revision = (await shape(c, id)).organizationConfiguration.revision;
  const refused = async (fields, error) => {
    const response = await makeAgent(c, id, fields);
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal(response.data.error, error);
  };
  await refused({ displayName: '  ' }, 'Give the agent a name of at most 40 characters.');
  await refused({ displayName: 'x'.repeat(41) }, 'Give the agent a name of at most 40 characters.');
  await refused({ displayName: 'mara' }, 'There is already an agent named Mara. Choose another name.');
  await refused({ jobTitle: '' }, 'Job title is missing or too long.');
  await refused({ teamId: 'nowhere' }, "Choose one of this project's teams for the agent.");
  await refused({ provider: '' }, 'Choose the CLI the agent runs on.');
  await refused(
    { roles: ['not a role'] },
    'Staffing roles must list up to 20 distinct role IDs (letters, digits, _ . : -).',
  );
  await refused(
    { look: { body: 1 } },
    'A face is six part numbers from 0 to 9: body, color, eyes, mouth, top and detail.',
  );
  await refused({ expectedRevision: revision - 1 }, 'Project organization changed. Refresh before saving.');
  await refused(
    { tools: ['shell'] },
    'A new agent takes its name, job title, team, CLI and, optionally, its face and instructions.',
  );
  assert.deepEqual(c.app.store.organization(), before);
  assert.equal((await shape(c, id)).organizationConfiguration.revision, revision);
});

test('a project’s own agent is renamed from its project; names stay distinct where they are seen', async t => {
  const c = await setup(t),
    first = await project(c, 'Marketing'),
    second = await project(c, 'Docs'),
    nova = (await makeAgent(c, first)).data.worker;
  const rename = (id, displayName, projectId = first, version = 1) =>
    c.request(`/api/workers/${id}`, { projectId, displayName, expectedVersion: version }, 'PATCH');
  const renamed = await rename(nova.id, 'Iris');
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(c.app.store.organization().workers.find(worker => worker.id === nova.id).displayName, 'Iris');
  assert.equal(c.app.store.events().at(-2).message, 'Nova is now called Iris.');
  // Another project may have its own Iris: they never appear together.
  assert.equal((await makeAgent(c, second, { displayName: 'Iris' })).status, 201);
  assert.equal(
    (await makeAgent(c, first, { displayName: 'iris' })).data.error,
    'There is already an agent named Iris. Choose another name.',
  );
  // A shared agent is seen everywhere, so its name is checked against every agent.
  const shared = c.app.store.organization().workers.find(worker => worker.id === 'W-01');
  const clash = await rename('W-01', 'Iris', first, shared.configVersion ?? 1);
  assert.equal(clash.data.error, 'There is already an agent named Iris. Choose another name.');
  assert.equal((await rename('W-01', 'Mara Lead', first, shared.configVersion ?? 1)).status, 200);
});

test('deleting a project’s own agent waits for its work, keeps its record and frees its place', async t => {
  const delay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '60000';
  t.after(() => {
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
  });
  const c = await setup(t),
    id = await project(c, 'Marketing'),
    nova = (await makeAgent(c, id)).data.worker,
    kai = (await makeAgent(c, id, { displayName: 'Kai' })).data.worker;
  const remove = async workerId =>
    c.request(`/api/projects/${id}/agents/${workerId}/delete`, {
      projectId: id,
      expectedRevision: (await shape(c, id)).organizationConfiguration.revision,
    });
  assert.equal(
    (await remove('W-01')).data.error,
    "Mara is shared by every project. Take Mara off this project's teams instead.",
  );
  const task = async (workerId, title) =>
    (await c.request('/api/tasks', { projectId: id, title, brief: 'Return a text file.', kind: 'general', workerId }))
      .data;
  // Open work holds the agent until it is closed or finished.
  const draft = await task(nova.id, 'Draft the launch post');
  assert.equal(
    (await remove(nova.id)).data.error,
    'Nova still has a task open: Draft the launch post. Close it or let it finish first.',
  );
  assert.equal(
    (await c.request('/api/tasks/close', { projectId: id, taskIds: [draft.id], reason: 'Not now' })).status,
    200,
  );
  // A running attempt holds it too.
  const running = await task(kai.id, 'Write the thread');
  assert.equal((await c.request(`/api/tasks/${running.id}/start`, { projectId: id })).status, 202);
  await c.until(
    () => c.app.store.attempts(running.id).some(attempt => attempt.status === 'running'),
    'the attempt starts',
  );
  assert.equal(
    (await remove(kai.id)).data.error,
    'Kai is working. Let the run finish, or stop it, before deleting Kai.',
  );

  const deleted = await remove(nova.id);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  const record = c.app.store.organization().workers.find(worker => worker.id === nova.id);
  assert.ok(record.deletedAt);
  assert.equal(record.enabled, false);
  const after = await shape(c, id);
  assert.equal(after.organizationConfiguration.revision, deleted.data.revision);
  assert.ok(!after.workers.some(worker => worker.id === nova.id));
  assert.ok(!after.organizationConfiguration.members.some(member => member.workerId === nova.id));
  // Its closed work still names it.
  assert.equal(after.employeeDirectory.find(worker => worker.id === nova.id).displayName, 'Nova');
  assert.equal(after.tasks.find(item => item.id === draft.id).workerId, nova.id);
  // Gone means gone: no second delete, no change, no team, and the attempt limit counts only agents that remain.
  assert.equal((await remove(nova.id)).status, 404);
  assert.equal(
    (await c.request(`/api/workers/${nova.id}`, { projectId: id, expectedVersion: 1 }, 'PATCH')).data.error,
    'Employee not found.',
  );
  const back = saveShape(after);
  back.members = [
    ...back.members,
    { workerId: nova.id, teamId: back.teams[0].id, role: 'Writer', responsibility: 'Writes.' },
  ];
  assert.equal(
    (await c.request(`/api/projects/${id}/organization`, { projectId: id, ...back })).data.error,
    'Each project member must be one existing employee in one selected team.',
  );
  const remaining = c.app.store.organization().workers.filter(worker => !worker.deletedAt).length;
  assert.equal(
    (await c.request('/api/control', { maxParallel: remaining + 1 })).data.error,
    `Choose from 1 to ${remaining} attempts at the same time.`,
  );
});

test('a project’s last agent stays, a team it led loses its lead, and deleting the project takes its agents', async t => {
  const c = await setup(t),
    id = await project(c, 'Solo'),
    nova = (await makeAgent(c, id)).data.worker,
    kai = (await makeAgent(c, id, { displayName: 'Kai' })).data.worker;
  // Only Nova and Kai on the team, with Kai leading it and owning a kind of work.
  const state = await shape(c, id),
    saved = saveShape(state);
  saved.members = saved.members.filter(member => [nova.id, kai.id].includes(member.workerId));
  saved.teams = [{ ...saved.teams[0], leadId: kai.id }];
  saved.kindOwners = { 'general:work': kai.id };
  assert.equal((await c.request(`/api/projects/${id}/organization`, { projectId: id, ...saved })).status, 200);
  const remove = async workerId =>
    c.request(`/api/projects/${id}/agents/${workerId}/delete`, {
      projectId: id,
      expectedRevision: (await shape(c, id)).organizationConfiguration.revision,
    });
  assert.equal((await remove(kai.id)).status, 200);
  const config = (await shape(c, id)).organizationConfiguration;
  assert.equal(config.teams[0].leadId, null);
  assert.deepEqual(config.kindOwners, {});
  assert.equal(
    (await remove(nova.id)).data.error,
    "Nova is this project's only agent. Add another before deleting Nova.",
  );
  // Deleting the project removes its own agents, deleted or not; the shared agents stay.
  const shared = c.app.store.organization().workers.filter(worker => !worker.projectId).length;
  assert.equal((await c.request(`/api/projects/${id}/delete`, { projectId: id, name: 'Solo' })).status, 200);
  const workers = c.app.store.organization().workers;
  assert.ok(!workers.some(worker => worker.projectId === id));
  assert.equal(workers.length, shared);
});
