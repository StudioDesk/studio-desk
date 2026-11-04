// Reading one task answers the actions the director may take on it now (src/core/task-actions.mjs running the shared
// rules, public/task-actions.js): each with its label, method, path and fields, the ones the shared rules give for the
// records the dashboard holds. The controller accepts a listed action sent with its required fields, refuses one the
// list leaves out, and reading runs none of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Runner } from '../src/runner.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setup } from './studio-setup.mjs';
import { setup as sourceSetup } from './source-story-setup.mjs';
import '../public/runs.js';
import '../public/task-actions.js';

const projectId = 'project-legacy';
// Model-free values for the fields an action needs that the records do not fill.
const values = { direction: 'Model-free revision direction.', note: 'Model-free note.', reason: 'Model-free reason.' };

// The simulator's results arrive quickly, unless a test keeps one running. Each test puts back the delay it found,
// once, however often it changes it.
const restoring = new WeakSet();
const mockDelay = (t, ms) => {
  if (!restoring.has(t)) {
    restoring.add(t);
    const previous = process.env.STUDIO_MOCK_DELAY_MS;
    t.after(() => {
      if (previous === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
      else process.env.STUDIO_MOCK_DELAY_MS = previous;
    });
  }
  process.env.STUDIO_MOCK_DELAY_MS = String(ms);
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
// A task whose simulated result waits for the director.
const inReview = async c => {
  const id = await create(c);
  assert.equal((await c.request(`/api/tasks/${id}/start`, { projectId })).status, 202);
  assert.equal((await c.wait(id)).task.status, 'review');
  return id;
};

// The task as a local tool reads it with the director's key. Reading writes nothing: the task's record and its attempts
// are the same before and after.
const read = async (c, id) => {
  const before = JSON.stringify([c.app.store.task(id), c.app.store.attempts(id)]);
  const res = await fetch(`${c.origin}/api/tasks/${encodeURIComponent(id)}?projectId=${projectId}`, {
    headers: { 'x-studio-key': c.app.directorKey },
  });
  const page = await res.json();
  assert.equal(res.status, 200, JSON.stringify(page));
  assert.equal(JSON.stringify([c.app.store.task(id), c.app.store.attempts(id)]), before, 'Reading ran no action.');
  return page;
};

// The project's records as the story page holds them: its shell with the live set, and the task's own page.
const dashboardActions = async (c, page) => {
  const get = async route =>
    (
      await fetch(`${c.origin}/api/projects/${projectId}/${route}`, { headers: { 'x-studio-key': c.app.directorKey } })
    ).json();
  const state = { ...(await get('shell')), ...(await get('live')) },
    ids = new Set(page.attempts.map(attempt => attempt.id));
  return globalThis.StudioTaskActions.taskActions(page.task, {
    ...state,
    tasks: [...state.tasks.filter(task => task.id !== page.task.id), page.task],
    attempts: [...state.attempts.filter(attempt => !ids.has(attempt.id)), ...page.attempts],
  });
};

// Reads the task and checks its actions: each with a label, method, path and fields, the expected labels in order, and
// the very actions the shared rules give for the records the dashboard holds.
const actionsOf = async (c, id, labels) => {
  const page = await read(c, id);
  // The page keeps the change sequence it reflects (`version`) and adds the actions after it.
  assert.deepEqual(Object.keys(page), ['task', 'attempts', 'version', 'actions']);
  assert.ok(Number.isInteger(page.version), 'The page says the change sequence it reflects.');
  for (const action of page.actions) {
    assert.equal(typeof action.label, 'string');
    assert.ok(['POST', 'PATCH'].includes(action.method), action.method);
    assert.match(action.path, /^\/api\//);
    assert.ok(Array.isArray(action.fields), action.label);
    for (const field of action.fields) {
      assert.equal(typeof field.name, 'string');
      assert.equal(typeof field.required, 'boolean');
      assert.equal(typeof field.kind, 'string');
    }
    assert.ok(
      action.fields.some(field => field.name === 'projectId' && field.value === projectId),
      `${action.label} names the task's project.`,
    );
  }
  assert.deepEqual(
    page.actions.map(action => action.label),
    labels,
    `${id} (${page.task.status}) lists ${JSON.stringify(page.actions.map(action => action.label))}`,
  );
  assert.deepEqual(page.actions, await dashboardActions(c, page));
  return page;
};

// Sends one listed action as a local tool would: its method and path, each field the records fill, each required
// field the records leave empty with a model-free value, and the request token.
const send = (c, page, label) => {
  const action = page.actions.find(item => item.label === label);
  assert.ok(action, `${label} is listed.`);
  const body = {};
  for (const field of action.fields)
    if ('value' in field) body[field.name] = field.value;
    else if (field.required) {
      assert.ok(field.name in values, `A model-free value for ${field.name}.`);
      body[field.name] = values[field.name];
    }
  return c.request(action.path, body, action.method);
};
// The task's record and its attempts. A story whose plan the code moved past notes when a refusal last saw that
// (sourceStage.outdated.at); a refusal that sees it again changes nothing else.
const recorded = (c, id) => {
  const task = structuredClone(c.app.store.task(id));
  if (task.sourceStage?.outdated) delete task.sourceStage.outdated.at;
  return JSON.stringify([task, c.app.store.attempts(id)]);
};
// Sends an action the list leaves out, and checks the controller refuses it and the task stays as it was.
const refused = async (c, page, label, route) => {
  assert.equal(
    page.actions.some(action => action.label === label || action.path.endsWith(`/${route}`)),
    false,
    `${label} is left out.`,
  );
  const before = recorded(c, page.task.id),
    answer = await c.request(`/api/tasks/${encodeURIComponent(page.task.id)}/${route}`, { projectId });
  assert.ok(answer.status >= 400 && answer.status < 500, `${label} answered ${answer.status}.`);
  assert.equal(recorded(c, page.task.id), before);
};

test('ready, proposed, in review and running work: listed actions are accepted, left-out ones refused', async t => {
  mockDelay(t, 20);
  const c = await setup(t);

  // Proposed work waits for approval: Approve work is accepted, Start assignment refused.
  const proposed = await create(c, { planned: true });
  let page = await actionsOf(c, proposed, ['Approve work', 'Deny work']);
  await refused(c, page, 'Start assignment', 'start');
  assert.equal((await send(c, page, 'Approve work')).status, 200);
  assert.equal(c.app.store.task(proposed).approval.status, 'approved');

  // A result in review: Accept result and Request revision are accepted, each on a fresh task; Approve work refused.
  const accepting = await inReview(c);
  page = await actionsOf(c, accepting, ['Accept result', 'Request revision', 'Close without accepting']);
  await refused(c, page, 'Approve work', 'approve-work');
  await refused(c, page, 'Start assignment', 'start');
  assert.equal((await send(c, page, 'Accept result')).status, 200);
  assert.equal(c.app.store.task(accepting).status, 'done');
  const revising = await inReview(c);
  page = await actionsOf(c, revising, ['Accept result', 'Request revision', 'Close without accepting']);
  assert.equal((await send(c, page, 'Request revision')).status, 200);
  assert.equal(c.app.store.task(revising).status, 'ready');
  assert.equal(c.app.store.task(revising).direction, values.direction);

  // Ready work never started: Accept result is refused, Start assignment accepted; the attempt it starts keeps running.
  const ready = await create(c);
  page = await actionsOf(c, ready, ['Start assignment', 'Close this step']);
  await refused(c, page, 'Accept result', 'accept');
  mockDelay(t, 60000);
  const started = await send(c, page, 'Start assignment');
  assert.ok(started.status >= 200 && started.status < 300, JSON.stringify(started.data));
  assert.equal(c.app.store.attempts(ready).length, 1);
  assert.equal(c.app.store.task(ready).status, 'running');
  await actionsOf(c, ready, ['Request cancellation']);
});

test('an interrupted attempt lists only Reconcile, and closed work lists nothing', async t => {
  mockDelay(t, 20);
  const c = await setup(t);

  // Closing a result in review, as its list offers, leaves closed work with no actions.
  const closing = await inReview(c);
  const page = await actionsOf(c, closing, ['Accept result', 'Request revision', 'Close without accepting']);
  assert.equal((await send(c, page, 'Close without accepting')).status, 200);
  assert.ok(c.app.store.task(closing).closed);
  await actionsOf(c, closing, []);

  // An attempt a restart cut off stays unreconciled until the director reconciles it.
  const interrupted = await create(c);
  c.app.store.tx(() => {
    c.app.store.insertAttempt(
      {
        id: 'attempt-cut-off',
        taskId: interrupted,
        projectId,
        workerId: 'W-03',
        provider: 'mock',
        status: 'running',
        pid: null,
        artifacts: [],
      },
      { text: 'Model-free instructions.', hash: 'test' },
    );
    const task = c.app.store.task(interrupted);
    task.status = 'running';
    task.lastAttemptId = 'attempt-cut-off';
    c.app.store.putTask(task);
  });
  new Runner(c.app.store);
  assert.equal(c.app.store.attempt('attempt-cut-off').status, 'interrupted');
  assert.equal(c.app.store.task(interrupted).status, 'blocked');
  const cut = await actionsOf(c, interrupted, ['Reconcile interrupted attempt']);
  await refused(c, cut, 'Start assignment', 'start');
});

// The source story fixture whose project takes ideas as a source project does (fresh checks, then a breakdown).
const sourceStudio = async t => {
  const c = await sourceSetup(t),
    { store } = c.app,
    org = store.organization(),
    kinds = ['checks', 'breakdown', 'change', 'change-review'].map(name => `studio-development:${name}`);
  org.taskKinds = [...new Set([...(org.taskKinds || []), ...kinds])];
  org.kindOwners = { ...org.kindOwners, [kinds[0]]: 'W-06', [kinds[1]]: 'W-01' };
  store.setOrganization(org);
  return c;
};
const created = 'src/core/created.mjs';

test('a story blocked on a file another story has since created lists Close and send as a new idea, and Start and Allow and continue are refused', async t => {
  const c = await sourceStudio(t),
    { store, runner } = c.app,
    // Two unrelated stories from one breakdown both planned to create the same file.
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], newFiles: [created], dependencies: [] },
      { files: ['src/core/projects.mjs'], newFiles: [created], dependencies: [] },
    ]),
    id = ids[1];
  for (const story of ids) approveWork(store, runner.registries, store.task(story));
  runner.start(ids[0]);
  const { review } = await c.toReview(ids[0]);
  c.integrated(ids[0], review, { [created]: 'export const created = 1;\n' });
  // The director's Start is refused, and the story notes that its plan is out of date.
  const start = await c.request(`/api/tasks/${id}/start`, { projectId });
  assert.ok(start.status >= 400 && start.status < 500, JSON.stringify(start.data));
  assert.ok(store.task(id).sourceStage?.outdated, 'The story notes that its plan is out of date.');
  assert.equal(store.attempts(id).length, 0);
  // The story never started: the new idea is offered beside withdrawing its approval.
  const page = await actionsOf(c, id, ['Close and send as a new idea', 'Withdraw approval and deny']);
  const sending = page.actions.find(action => action.label === 'Close and send as a new idea');
  assert.equal(sending.method, 'POST');
  assert.equal(sending.path, `/api/tasks/${id}/send-as-idea`);
  assert.deepEqual(
    sending.fields.map(({ name, required }) => [name, required]),
    [
      ['projectId', true],
      ['idea', false],
    ],
  );
  await refused(c, page, 'Start assignment', 'start');
  await refused(c, page, 'Allow and continue', 'edit-scope');
  // Sending the listed action closes the story once its remaining work is taken in as a new idea; the project's
  // dispatch is held so the new idea's steps wait instead of running.
  store.putProject({ ...store.project(projectId), dispatchPaused: true });
  const sent = await send(c, page, 'Close and send as a new idea');
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.closed, id);
  assert.equal(store.task(id).status, 'denied');
  assert.equal(store.task(id).sentAsIdea.runId, sent.data.runId);
  await actionsOf(c, id, []);
});

test('a blocked editor whose file request names a file outside the measured list is offered no Allow and continue', async t => {
  const c = await sourceStudio(t),
    { store, runner } = c.app,
    byHand = 'test/by-hand.test.mjs',
    reason = 'The test added by hand pins the old wording.',
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    id = ids[0];
  // A file committed after the breakdown's checks measured the source: it exists now, but not in the measured list.
  fs.writeFileSync(path.join(c.root, byHand), '// Added by hand\n');
  git(c.root, ['add', byHand]);
  git(c.root, ['commit', '--quiet', '-m', 'Add a test by hand']);
  approveWork(store, runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: `block-request ${JSON.stringify({ files: [byHand], reason })}` });
  runner.start(id);
  const blocked = await c.wait(id, 'blocked');
  assert.ok(blocked.scopeRequest.problem, 'The request records why approving it would be refused.');
  assert.ok(store.task(id).sourceStage?.outdated, 'The story notes that its plan is out of date.');
  let page = await actionsOf(c, id, ['Close and send as a new idea', 'Close']);
  await refused(c, page, 'Allow and continue', 'edit-scope');
  // A request that carries a problem is not usable on its own: without the note, Start is offered and Allow and
  // continue is not.
  const story = store.task(id);
  delete story.sourceStage.outdated;
  store.putTask(story);
  page = await actionsOf(c, id, ['Start assignment', 'Close']);
  await refused(c, page, 'Allow and continue', 'edit-scope');
});
