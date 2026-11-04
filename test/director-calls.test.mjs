// A project's list of what needs the director now (GET /api/projects/:id/calls, src/core/director-calls.mjs): the
// shared rules' calls (public/runs.js needsYouItems) from the records the dashboard holds, only those whose
// requiresDirector is true, each task's with the actions its task read answers. Waits, running work and finished work
// are left out; reading writes nothing and starts nothing. Model-free: the simulator's attempts, recorded attempts a
// restart cut off or an agent stopped on, and the source story fixture's protocol CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../src/runner.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { routes } from '../src/core/routes.mjs';
import { setup } from './studio-setup.mjs';
import { setup as sourceSetup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import '../public/runs.js';

const projectId = 'project-legacy';

// The simulator's results arrive after the delay set when an attempt starts; each test puts back the delay it found.
const mockDelay = (t, ms) => {
  if (!t.restoresDelay) {
    t.restoresDelay = true;
    const previous = process.env.STUDIO_MOCK_DELAY_MS;
    t.after(() => {
      if (previous === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
      else process.env.STUDIO_MOCK_DELAY_MS = previous;
    });
  }
  process.env.STUDIO_MOCK_DELAY_MS = String(ms);
};

// A director read with the director's key.
const get = async (c, route) => {
  const res = await fetch(c.origin + route, { headers: { 'x-studio-key': c.app.directorKey } });
  const data = await res.json();
  assert.equal(res.status, 200, `${route}: ${JSON.stringify(data)}`);
  return data;
};
// Everything a read could change: the store's version, every task with its attempts, and the event log.
const recorded = store =>
  JSON.stringify({
    version: store.version,
    tasks: store.tasks().map(task => [task, store.attempts(task.id)]),
    events: store.events(null),
  });
// The list, read once with the director's key; reading it leaves every record as it was and starts nothing.
const calls = async c => {
  const { store } = c.app,
    before = recorded(store),
    live = store.liveAttempts().length,
    answer = await get(c, `/api/projects/${projectId}/calls`);
  assert.equal(recorded(store), before, 'Reading the list changed no record.');
  assert.equal(store.liveAttempts().length, live, 'Reading the list started nothing.');
  assert.deepEqual(Object.keys(answer), ['projectId', 'items', 'count', 'version']);
  assert.equal(answer.projectId, projectId);
  assert.equal(answer.count, answer.items.length);
  assert.equal(answer.version, store.version);
  return answer;
};
// The task items a list holds, a cleanup's members included.
const taskItems = items =>
  items.flatMap(item => (item.type === 'cleanup' ? item.members : item.type === 'task' ? [item] : []));
const names = items =>
  items.flatMap(item =>
    item.type === 'hold' ? [`hold:${item.provider}`] : item.type === 'cleanup' ? item.taskIds : [item.taskId],
  );

// The project's records as the dashboard holds them (its shell and every page of its live set), and the calls the
// shared rules list from them as Today does (dashboard/src/studio-runs.ts liveSummary): every item, the waits too.
const dashboardItems = async c => {
  const shell = await get(c, `/api/projects/${projectId}/shell`),
    pages = [];
  let before = null;
  do {
    const page = await get(
      c,
      `/api/projects/${projectId}/live${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    );
    pages.push(page);
    before = page.next;
  } while (before !== null);
  const runs = new Map();
  for (const page of pages) for (const run of page.runs) if (!runs.has(run.id)) runs.set(run.id, run);
  const state = {
      ...shell,
      tasks: pages.flatMap(page => page.tasks),
      attempts: pages.flatMap(page => page.attempts),
      runs: [...runs.values()],
    },
    rules = globalThis.StudioRuns,
    stories = rules.buildRunStories(state).filter(story => runs.has(story.id));
  return rules
    .needsYouItems(state, stories)
    .map(item =>
      item.kind === 'subscription-hold'
        ? { ...item, type: 'hold' }
        : item.members
          ? { ...item, type: 'cleanup' }
          : { ...item, type: 'task' },
    );
};

// Every task item's actions are the very ones its task read answers at the same moment, and the list names the tasks
// the shared rules' items for the director name, in the same order.
const agrees = async (c, list) => {
  for (const item of taskItems(list.items)) {
    const page = await get(c, `/api/tasks/${encodeURIComponent(item.taskId)}?projectId=${projectId}`);
    assert.deepEqual(item.actions, page.actions, `${item.taskId} has the actions its task read answers.`);
    assert.ok(item.actions.length, `${item.taskId} offers the director something to do.`);
  }
  const shared = await dashboardItems(c);
  assert.deepEqual(names(list.items), names(shared.filter(item => item.requiresDirector)));
  return shared;
};

const create = async (c, fields = {}) => {
  const created = await c.request('/api/tasks', {
    projectId,
    title: 'Bounded layout',
    brief: 'Return the layout contract.',
    acceptance: 'Connected rooms.',
    kind: 'layout',
    workerId: 'W-03',
    ...fields,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.id;
};
const command = async (c, id, action, body = {}) => {
  const answer = await c.request(`/api/tasks/${encodeURIComponent(id)}/${action}`, { projectId, ...body });
  assert.ok(answer.status >= 200 && answer.status < 300, `${action} ${id}: ${JSON.stringify(answer.data)}`);
  return answer.data;
};
const inReview = async c => {
  const id = await create(c);
  await command(c, id, 'start');
  assert.equal((await c.wait(id)).task.status, 'review');
  return id;
};
// Records an attempt on a task as the controller left it, and the task as it then stands.
const recordAttempt = (c, id, attempt, task) => {
  const { store } = c.app;
  store.tx(() => {
    store.insertAttempt(
      { taskId: id, projectId, workerId: 'W-03', provider: 'mock', pid: null, artifacts: [], ...attempt },
      { text: 'Model-free instructions.', hash: 'test' },
    );
    store.putTask({ ...store.task(id), lastAttemptId: attempt.id, ...task });
  });
};

test('the list names reconciled work waiting for Start and a waiting question, and leaves out running work, waits and finished work', async t => {
  mockDelay(t, 20);
  const c = await setup(t),
    { store } = c.app;
  const org = store.organization();
  // Slots enough for every attempt here, and a second CLI for the usage hold.
  org.maxParallel = 8;
  for (const worker of org.workers) if (worker.id === 'W-04') worker.provider = 'codex';
  store.setOrganization(org);

  // Finished work: accepted, closed without accepting, and planned work denied.
  const accepted = await inReview(c);
  await command(c, accepted, 'accept');
  const closed = await inReview(c);
  await command(c, closed, 'close', { reason: 'Model-free reason.' });
  const denied = await create(c, { planned: true });
  await command(c, denied, 'deny-work', { reason: 'Model-free reason.' });

  // An attempt a restart cut off, reconciled by the director: the work waits only for Start assignment.
  const reconciled = await create(c);
  recordAttempt(c, reconciled, { id: 'attempt-cut-off', status: 'running' }, { status: 'running' });
  new Runner(store);
  assert.equal(store.attempt('attempt-cut-off').status, 'interrupted');
  await command(c, reconciled, 'reconcile');
  assert.equal(store.task(reconciled).status, 'ready');
  assert.ok(store.attempt('attempt-cut-off').reconciledAt);

  // An agent stopped to ask the director a question nobody has answered.
  const asked = await create(c);
  recordAttempt(
    c,
    asked,
    {
      id: 'attempt-asked',
      status: 'blocked',
      result: { outcome: 'blocked', summary: 'Stopped to ask.' },
      question: {
        schemaVersion: 'question-v1',
        ask: 'Should the layout lead with the hub or the corridor?',
        why: 'The brief names both.',
        options: [{ label: 'Hub first' }, { label: 'Corridor first' }],
        recommended: 0,
        choice: 'director',
        topics: [],
      },
    },
    { status: 'blocked' },
  );

  // Running work, running work waiting for the computer's test turn, and queued work waiting for a prerequisite.
  mockDelay(t, 60000);
  const running = await create(c);
  await command(c, running, 'start');
  const turn = await create(c);
  await command(c, turn, 'start');
  await waitFor(() => store.task(running).status === 'running' && store.task(turn).status === 'running', 'both run');
  const waiting = store.attempt(store.task(turn).lastAttemptId);
  store.updateAttempt({
    ...waiting,
    testTurn: { reason: 'Waiting for the test turn: another full suite is running.' },
  });
  const queued = await create(c, { dependencies: [running] });
  await command(c, queued, 'start');
  assert.equal(store.task(queued).queued, true);

  // Work on a CLI whose usage limit resets on its own tomorrow only waits, and so does its hold.
  const reset = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  store.setOrganization({
    ...store.organization(),
    quota: { ...store.organization().quota, codex: true },
    quotaResets: { codex: reset },
  });
  const held = await create(c, { workerId: 'W-04' });

  const list = await calls(c),
    on = names(list.items);
  assert.ok(on.includes(reconciled), JSON.stringify(list.items));
  assert.ok(on.includes(asked), JSON.stringify(list.items));
  for (const id of [accepted, closed, denied, running, turn, queued, held])
    assert.equal(on.includes(id), false, `${id} (${store.task(id).status}) is not on the list.`);
  assert.equal(
    list.items.some(item => item.type === 'hold'),
    false,
    'A hold with a known reset is not on the list.',
  );
  const byId = new Map(taskItems(list.items).map(item => [item.taskId, item]));
  assert.deepEqual(
    [byId.get(reconciled).kind, byId.get(reconciled).action, byId.get(reconciled).runId],
    ['ready', 'Start assignment', null],
  );
  assert.ok(byId.get(reconciled).actions.some(action => action.label === 'Start assignment'));
  assert.deepEqual([byId.get(asked).kind, byId.get(asked).attemptId], ['question', 'attempt-asked']);
  for (const item of byId.values())
    for (const field of ['type', 'taskId', 'runId', 'kind', 'reason', 'next', 'action', 'details', 'attemptId'])
      assert.ok(field in item, `${item.taskId} carries ${field}.`);

  // The shared rules list the waits for the dashboard, as waits; the controller's list leaves them out.
  const shared = await agrees(c, list),
    kindOf = id => shared.find(item => item.type === 'task' && item.taskId === id)?.kind;
  assert.equal(kindOf(queued), 'prerequisite-wait');
  assert.equal(kindOf(held), 'subscription-wait');
  assert.equal(shared.find(item => item.taskId === queued).requiresDirector, false);
  assert.equal(store.attempts(queued).length, 0, 'Reading started nothing.');
});

test('the list names a story blocked on a file request and leaves out an integrated story', async t => {
  const c = await sourceSetup(t),
    { store, runner } = c.app,
    org = store.organization(),
    kinds = ['checks', 'breakdown', 'change', 'change-review'].map(name => `studio-development:${name}`);
  org.taskKinds = [...new Set([...(org.taskKinds || []), ...kinds])];
  org.kindOwners = { ...org.kindOwners, [kinds[0]]: 'W-06', [kinds[1]]: 'W-01' };
  store.setOrganization(org);
  const { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    [landed, requesting] = ids;
  for (const id of ids) approveWork(store, runner.registries, store.task(id));

  // One story lands; the other's editor stops asking for a file outside its approved scope.
  runner.start(landed);
  const { review } = await c.toReview(landed);
  c.integrated(landed, review, { 'src/core/workflows.mjs': '// Integrated.\n' });
  store.putTask({
    ...store.task(requesting),
    direction: `block-request ${JSON.stringify({ files: ['src/core/workflows.mjs'], reason: 'Model-free reason.' })}`,
  });
  runner.start(requesting);
  await c.wait(requesting, 'blocked');

  const list = await calls(c),
    item = taskItems(list.items).find(call => call.taskId === requesting);
  assert.ok(item, JSON.stringify(list.items));
  assert.equal(item.kind, 'scope-request');
  assert.equal(item.runId, store.task(requesting).workflowReference?.runId ?? item.runId);
  assert.equal(names(list.items).includes(landed), false, 'The integrated story is not on the list.');
  await agrees(c, list);
});

test('the list is a director read: refused without the session or key, and listed once in the route table', async t => {
  const c = await setup(t),
    route = `/api/projects/${projectId}/calls`;
  // The suite's fetch sends the director's key unless told not to (test/model-free-studio.mjs).
  const before = recorded(c.app.store);
  assert.equal((await fetch(c.origin + route, { directorKey: false })).status, 401);
  const withToken = await fetch(c.origin + route, { directorKey: false, headers: { 'X-Studio-Token': c.token } });
  assert.equal(withToken.status, 401, 'The request token alone is no director access.');
  assert.equal(recorded(c.app.store), before);
  const listed = (await get(c, '/api/routes')).routes;
  assert.deepEqual(listed, JSON.parse(JSON.stringify(routes)));
  const matching = listed.filter(entry => entry.path === '/api/projects/:id/calls');
  assert.equal(matching.length, 1);
  assert.deepEqual([matching[0].method, matching[0].access, matching[0].token], ['GET', 'director', 'none']);
  // With the director's key it answers, and its count is its number of items (calls checks both).
  await agrees(c, await calls(c));
});
