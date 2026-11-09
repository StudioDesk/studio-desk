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
import { directorCalls, directorCallsComputed, forgetDirectorCalls } from '../src/core/director-calls.mjs';
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
// The scheduler at rest: no dispatch pass asked for or running, none measuring its sources in a process of its own,
// and the store's version unchanged over a few polls. A dispatch pass records after its measuring process answers
// (src/core/orchestrator.mjs dispatchQueued), so one still measuring when a read began could write while the read was
// answered (on Linux the version moved from 114 to 116: the pass finding no queued work switched the queue off and
// recorded pipeline_finished) and look like the read's own writes.
const settled = async c => {
  const { store, runner } = c.app;
  let version = null,
    quiet = 0;
  await waitFor(
    () => {
      if (runner.scheduled || runner.dispatching || runner.measuringSources || store.version !== version) {
        version = store.version;
        quiet = 0;
        return false;
      }
      return ++quiet >= 3;
    },
    'the scheduler to settle',
    {
      detail: () =>
        JSON.stringify({
          scheduled: !!runner.scheduled,
          dispatching: !!runner.dispatching,
          measuring: !!runner.measuringSources,
          version: store.version,
        }),
    },
  );
};
// The list, read once with the director's key once the scheduler is at rest; reading it leaves every record as it was
// and starts nothing.
const calls = async (c, project = projectId) => {
  await settled(c);
  const { store } = c.app,
    before = recorded(store),
    live = store.liveAttempts().length,
    answer = await get(c, `/api/projects/${project}/calls`);
  assert.equal(recorded(store), before, 'Reading the list changed no record.');
  assert.equal(store.liveAttempts().length, live, 'Reading the list started nothing.');
  assert.deepEqual(Object.keys(answer), ['projectId', 'items', 'count', 'version']);
  assert.equal(answer.projectId, project);
  assert.equal(answer.count, answer.items.length);
  assert.equal(answer.version, store.version);
  return answer;
};
// The task items a list holds, a cleanup's members included.
const taskItems = items =>
  items.flatMap(item => (item.type === 'cleanup' ? item.members : item.type === 'task' ? [item] : []));
const names = items =>
  items.flatMap(item =>
    item.type === 'hold'
      ? [`hold:${item.provider}`]
      : item.type === 'resume'
        ? [`resume:${item.projectId}`]
        : item.type === 'cleanup'
          ? item.taskIds
          : [item.taskId],
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
        : item.kind === 'project-resume'
          ? { ...item, type: 'resume' }
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

// Stories queued as the director's Start or the house rules leave them, with the queue switched on, recorded without
// asking dispatch to start them: only the Runner's own schedule starts queued work.
const queuedStories = async (c, count) => {
  const { store } = c.app,
    ids = [];
  for (let n = 0; n < count; n++) ids.push(await create(c, { title: `Queued layout ${n + 1}` }));
  store.tx(() => {
    for (const id of ids) store.putTask({ ...store.task(id), status: 'ready', queued: true, reason: '' });
    store.setOrganization({ ...store.organization(), pipelineEnabled: true });
  });
  return ids;
};
const resumeReason =
  "The controller restarted, so this project's work is held until you have looked at what the restart interrupted.";

test('after a restart, the list holds one call to resume the project with the stories that wait only for it, gone once resumed', async t => {
  mockDelay(t, 60000);
  const c = await setup(t),
    { store } = c.app;
  store.setOrganization({ ...store.organization(), maxParallel: 8 });
  // Work a restart cut off, and stories queued behind it.
  const cut = await create(c, { title: 'Cut-off layout' });
  recordAttempt(c, cut, { id: 'attempt-restart-cut', status: 'running' }, { status: 'running' });
  const queued = await queuedStories(c, 2);
  new Runner(store);
  assert.equal(store.attempt('attempt-restart-cut').status, 'interrupted');
  assert.equal(store.project(projectId).restartPaused, true);

  const list = await calls(c),
    resumes = list.items.filter(item => item.type === 'resume');
  assert.equal(resumes.length, 1, JSON.stringify(list.items));
  const [resume] = resumes;
  assert.deepEqual(resume, {
    type: 'resume',
    projectId,
    taskIds: queued,
    runId: null,
    kind: 'project-resume',
    reason: resumeReason,
    next: 'Resume the project when you are ready; queued stories, carries and releases then go on by themselves.',
    action: 'Resume this project',
    details: [],
    actions: [
      {
        key: 'resume',
        label: 'Resume this project',
        emphasis: 'primary',
        closing: false,
        method: 'POST',
        path: '/api/pipeline',
        fields: [
          { name: 'projectId', required: true, kind: 'id', value: projectId },
          { name: 'action', required: true, kind: 'text', value: 'resume' },
        ],
      },
    ],
  });
  // The cut-off work is still a call of its own; the queued stories are not, and no call says the pipeline is paused.
  const on = names(list.items);
  assert.ok(on.includes(cut), JSON.stringify(list.items));
  for (const id of queued) assert.equal(on.includes(id), false, `${id} is listed only under the resume call.`);
  assert.equal(
    taskItems(list.items).some(item => item.kind === 'pipeline-paused'),
    false,
  );
  // Each queued story says it waits only for the resume, and its own page keeps Resume pipeline.
  const shared = await agrees(c, list);
  for (const id of queued) {
    const wait = shared.find(item => item.type === 'task' && item.taskId === id);
    assert.equal(wait.reason, 'Waits only for this project to be resumed.');
    assert.equal(wait.requiresDirector, false);
    const page = await get(c, `/api/tasks/${encodeURIComponent(id)}?projectId=${projectId}`);
    assert.ok(
      page.actions.some(action => action.label === 'Resume pipeline' && action.path === '/api/pipeline'),
      JSON.stringify(page.actions),
    );
  }

  // Once the controller has weighed the queue, the stories record that they wait for the project to resume: still
  // only the resume call's.
  c.app.runner.refreshReadiness();
  assert.match(store.task(queued[0]).reason, /^Waiting for the project to resume/);
  const weighed = await calls(c);
  assert.deepEqual(
    weighed.items.filter(item => item.type === 'resume').map(item => item.taskIds),
    [queued],
  );
  await agrees(c, weighed);

  // The director resumes the project: the call is gone.
  const resumed = await c.request('/api/pipeline', { projectId, action: 'resume' });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(store.project(projectId).restartPaused, undefined);
  const after = await calls(c);
  assert.equal(
    after.items.some(item => item.type === 'resume'),
    false,
    JSON.stringify(after.items),
  );
});

test('a project the director paused by hand has no resume call', async t => {
  mockDelay(t, 60000);
  const c = await setup(t),
    { store } = c.app;
  const queued = await queuedStories(c, 1);
  const paused = await c.request('/api/pipeline', { projectId, action: 'pause' });
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  // A restart leaves a project the director paused as theirs.
  new Runner(store);
  assert.equal(store.project(projectId).dispatchPaused, true);
  assert.equal(store.project(projectId).restartPaused, undefined);
  const list = await calls(c);
  assert.equal(
    list.items.some(item => item.type === 'resume'),
    false,
    JSON.stringify(list.items),
  );
  const shared = await agrees(c, list);
  assert.equal(
    shared.some(item => item.type === 'resume'),
    false,
  );
  assert.notEqual(shared.find(item => item.taskId === queued[0])?.reason, 'Waits only for this project to be resumed.');
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

// A question an agent stopped to ask the director, recorded on a task of a project as the controller leaves it.
const question = {
  schemaVersion: 'question-v1',
  ask: 'Should the layout lead with the hub or the corridor?',
  why: 'The brief names both.',
  options: [{ label: 'Hub first' }, { label: 'Corridor first' }],
  recommended: 0,
  choice: 'director',
  topics: [],
};
const asking = (c, id, attemptId, project = projectId, workerId = 'W-03') => {
  const { store } = c.app;
  store.tx(() => {
    store.insertAttempt(
      {
        id: attemptId,
        taskId: id,
        projectId: project,
        workerId,
        provider: 'mock',
        pid: null,
        artifacts: [],
        status: 'blocked',
        result: { outcome: 'blocked', summary: 'Stopped to ask.' },
        question,
      },
      { text: 'Model-free instructions.', hash: 'test' },
    );
    store.putTask({ ...store.task(id), lastAttemptId: attemptId, status: 'blocked' });
  });
  return id;
};
// The list read through the route, with how many times the controller worked a list out for that read.
const counted = async (c, project = projectId) => {
  const before = directorCallsComputed(),
    list = await calls(c, project);
  return { list, computed: directorCallsComputed() - before };
};

test('the list is worked out once for each change, and a change that alters the calls works it out again', async t => {
  mockDelay(t, 60000);
  const c = await setup(t),
    { store } = c.app;
  const first = asking(c, await create(c, { title: 'Asking layout 1' }), 'attempt-once-first');

  // Two reads with no write between them: worked out once, the same answer.
  const one = await counted(c),
    two = await counted(c);
  assert.equal(one.computed, 1, 'The first read works the list out.');
  assert.equal(two.computed, 0, 'A read with no write since is answered the list already worked out.');
  assert.deepEqual(two.list, one.list);
  assert.ok(names(one.list.items).includes(first), JSON.stringify(one.list.items));
  // The fixture's own calls, which stay on the list throughout.
  const base = names(one.list.items).filter(name => name !== first);
  await agrees(c, two.list);

  // A story stops to ask the director: the next read works the list out again, at the new version, with the new call.
  const version = store.version,
    second = asking(c, await create(c, { title: 'Asking layout 2' }), 'attempt-once-second');
  assert.ok(store.version > version);
  const changed = await counted(c);
  assert.equal(changed.computed, 1, 'A recorded change works the list out again.');
  assert.equal(changed.list.version, store.version);
  assert.deepEqual(names(changed.list.items), [...base, first, second]);
  // It is the list a fresh computation at that version answers.
  forgetDirectorCalls(store);
  const fresh = await counted(c);
  assert.equal(fresh.computed, 1);
  assert.deepEqual(fresh.list, changed.list);
  await agrees(c, changed.list);

  // The director answers the first question, so its work starts again: that call is gone from the next read.
  const answered = await c.request(`/api/tasks/${encodeURIComponent(first)}/answer`, {
    projectId,
    attemptId: 'attempt-once-first',
    text: 'Hub first.',
  });
  assert.equal(answered.status, 202, JSON.stringify(answered.data));
  await waitFor(() => store.task(first).status === 'running', 'the answered work to start');
  const after = await counted(c);
  assert.equal(after.computed, 1, 'An answered call works the list out again.');
  assert.equal(after.list.version, store.version);
  assert.deepEqual(names(after.list.items), [...base, second]);
  forgetDirectorCalls(store);
  assert.deepEqual((await counted(c)).list, after.list);
});

test('the list is worked out again when the common fields or the day change with no record written, and each caller has its own copy', async t => {
  const c = await setup(t),
    { store } = c.app;
  const id = asking(c, await create(c), 'attempt-common');
  // The common fields as the project's shell answers them beside its records, and a task read like the server's.
  const shell = await get(c, `/api/projects/${projectId}/shell`),
    taskPage = (project, record) => ({
      task: record,
      attempts: store.dashboardAttempts(project, record.id),
      version: store.version,
    }),
    read = shared => {
      const before = directorCallsComputed(),
        answer = directorCalls(store, projectId, { taskPage, shared });
      return { answer, computed: directorCallsComputed() - before };
    },
    version = store.version;

  const plain = read(shell);
  assert.equal(plain.computed, 1);
  assert.ok(names(plain.answer.items).includes(id), JSON.stringify(plain.answer.items));
  assert.equal(read(structuredClone(shell)).computed, 0, 'Equal common fields are the same input.');

  // A usage hold with no known reset in the common fields, no record written: worked out again, with its call.
  const held = read({ ...shell, quota: { codex: true }, quotaResets: {} });
  assert.equal(held.computed, 1, 'Changed common fields work the list out again.');
  assert.equal(store.version, version, 'No record was written.');
  assert.ok(names(held.answer.items).includes('hold:codex'), JSON.stringify(held.answer.items));
  assert.ok(names(held.answer.items).includes(id), JSON.stringify(held.answer.items));
  assert.equal(held.answer.version, version);
  // Back to the plain fields: worked out again, the list as it was.
  const back = read(shell);
  assert.equal(back.computed, 1);
  assert.deepEqual(back.answer, plain.answer);

  // A caller that changes its answer changes no other caller's.
  back.answer.items[0].actions.length = 0;
  back.answer.items.length = 0;
  back.answer.count = 99;
  const again = read(shell);
  assert.equal(again.computed, 0);
  assert.deepEqual(again.answer, plain.answer);

  // A new day: the shared rules word a reset time by whether it is today, so the list is worked out again.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 24 * 3600 * 1000 });
  t.after(() => t.mock.timers.reset());
  assert.equal(read(shell).computed, 1, 'A new day works the list out again.');
  assert.equal(read(shell).computed, 0);
});

test('two projects each get their own list', async t => {
  const c = await setup(t),
    { store } = c.app;
  const mine = asking(c, await create(c), 'attempt-mine');
  const other = await c.request('/api/projects', { name: 'Second fixture project' });
  assert.equal(other.status, 201, JSON.stringify(other.data));
  const otherId = other.data.id,
    task = await c.request('/api/tasks', {
      projectId: otherId,
      title: 'Work in another project',
      brief: 'Bounded model-free work.',
      kind: 'general',
      workerId: 'W-06',
    });
  assert.equal(task.status, 201, JSON.stringify(task.data));
  const theirs = asking(c, task.data.id, 'attempt-theirs', otherId, 'W-06');

  const a = await counted(c),
    b = await counted(c, otherId);
  assert.equal(a.computed, 1);
  assert.equal(b.computed, 1, 'Another project has a list of its own.');
  assert.ok(names(a.list.items).includes(mine), JSON.stringify(a.list.items));
  assert.equal(names(a.list.items).includes(theirs), false);
  assert.deepEqual(names(b.list.items), [theirs]);
  // Each is kept for its project: reading either again works nothing out and answers its own list.
  const a2 = await counted(c),
    b2 = await counted(c, otherId);
  assert.deepEqual([a2.computed, b2.computed], [0, 0]);
  assert.deepEqual(a2.list, a.list);
  assert.deepEqual(b2.list, b.list);
  assert.equal(store.version, a.list.version);
});
