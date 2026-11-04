// Reading one task answers the actions the director may take on it now (src/core/task-actions.mjs running the shared
// rules, public/task-actions.js): each with its label, method, path and fields, the ones the shared rules give for the
// records the dashboard holds. The controller accepts a listed action sent with its required fields, refuses one the
// list leaves out, and reading runs none of them. The list leaves out what the controller would refuse: Start on held
// work or on a story whose plan is out of date, reconciling an integration while it runs, and Send back once a story's
// interrupted merge was reconciled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Runner } from '../src/runner.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setup } from './studio-setup.mjs';
import { setup as sourceSetup } from './source-story-setup.mjs';
import { noteOutdated, sourceIntegrationResources } from '../src/connectors/source-changes.mjs';
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

test('held work lists Release hold and no Start assignment, which the controller refuses', async t => {
  mockDelay(t, 20);
  const c = await setup(t);

  // A held ready task, once the scheduler has recorded why it waits: Start is refused and leaves its record as it
  // was; Release hold is accepted, and Start is listed again and accepted.
  const held = await create(c);
  assert.equal((await c.request(`/api/tasks/${held}`, { projectId, hold: true }, 'PATCH')).status, 200);
  // The full state read refreshes readiness, which records the hold as the reason the task waits.
  await c.state();
  assert.equal(c.app.store.task(held).status, 'blocked');
  assert.equal(c.app.store.task(held).reason, 'Assignment is deliberately on hold.');
  let page = await actionsOf(c, held, ['Release hold', 'Close this step']);
  await refused(c, page, 'Start assignment', 'start');
  assert.equal((await send(c, page, 'Release hold')).status, 200);
  assert.equal(c.app.store.task(held).hold, false);
  page = await actionsOf(c, held, ['Start assignment', 'Close this step']);
  const started = await send(c, page, 'Start assignment');
  assert.ok(started.status >= 200 && started.status < 300, JSON.stringify(started.data));
  assert.equal(c.app.store.attempts(held).length, 1);

  // Its closing action is accepted too, on another held task.
  const closing = await create(c);
  assert.equal((await c.request(`/api/tasks/${closing}`, { projectId, hold: true }, 'PATCH')).status, 200);
  page = await actionsOf(c, closing, ['Release hold', 'Close this step']);
  assert.equal((await send(c, page, 'Close this step')).status, 200);
  assert.equal(c.app.store.task(closing).status, 'denied');
});

test('a story whose plan the source moved past lists no Start assignment', async t => {
  const c = await sourceSetup(t);
  const store = c.app.store,
    story = store.task(c.taskId);
  // The note a refused Start records when the source moved past the story's plan.
  assert.ok(
    noteOutdated(story, Object.assign(new Error('Moved on.'), { outdated: { files: ['src/core/workflows.mjs'] } })),
  );
  store.putTask(story);
  // Close and send as a new idea is offered in its place.
  const page = await actionsOf(c, c.taskId, ['Close and send as a new idea', 'Withdraw approval and deny']);
  assert.equal(
    page.actions.some(action => action.path.endsWith('/start')),
    false,
  );
  assert.equal((await send(c, page, 'Withdraw approval and deny')).status, 200);
  assert.equal(store.task(c.taskId).status, 'denied');
});

test('a running integration lists no Reconcile source integration, and a reconciled one no Send back', async t => {
  const c = await sourceSetup(t);
  const store = c.app.store;
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  const head = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal((await c.integration(review)).status, 200);
  const integrated = await c.settled(review);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));

  // The integration as it stood before its fast-forward: its journal committing, its resources held, the story
  // waiting for it, and the development copy where it was.
  git(c.root, ['reset', '--quiet', '--hard', head]);
  const attempt = store.attempt(review.id),
    { finishedAt, ...journal } = integrated,
    story = store.task(c.taskId);
  attempt.sourceIntegration = {
    ...journal,
    state: 'committing',
    repository: { branch: integrated.repository.branch, head },
  };
  Object.assign(story.sourceStage, {
    phase: 'integration',
    current: 'waiting-for-integration',
    integration: { attemptId: review.id, id: journal.id, state: 'committing' },
  });
  store.tx(() => {
    store.claim(sourceIntegrationResources, journal.id);
    store.updateAttempt(attempt);
    store.putTask(story);
  });

  // While the controller's own integration run is that journal, reconciling it is left out and refused.
  c.app.runner.sourceIntegrationRun = { id: journal.id, promise: Promise.resolve() };
  try {
    const running = await actionsOf(c, c.taskId, []);
    await refused(c, running, 'Reconcile source integration', 'restore-source');
  } finally {
    c.app.runner.sourceIntegrationRun = null;
  }

  // The same journal with no live run lists it, and reconciling is accepted: nothing landed, so it is abandoned.
  let page = await actionsOf(c, c.taskId, ['Reconcile source integration']);
  const reconciled = await send(c, page, 'Reconcile source integration');
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'abandoned');
  assert.equal(store.task(c.taskId).sourceStage.phase, 'integration');
  assert.equal(store.task(c.taskId).sourceStage.current, 'waiting-for-integration');

  // Its interrupted merge reconciled, the story is not sent back, which the controller refuses; integrating again is
  // accepted and lands.
  page = await actionsOf(c, c.taskId, ['Integrate again', 'Close without integrating']);
  await refused(c, page, 'Send back', 'send-back');
  assert.equal(
    page.actions.some(action => action.label.startsWith('Send back')),
    false,
  );
  assert.equal((await send(c, page, 'Integrate again')).status, 200);
  assert.equal((await c.settled(review)).state, 'integrated');
});

// The sweep: every action listed on each sample story, sent on a fresh copy of that sample, is accepted. Each sample
// is built on controller records with a temporary git source (the source story fixture) and its model-free CLI and
// checks; it answers its studio and the story's ID. The labels are what the sample lists.
const twoStories = [
  { files: ['src/core/workflows.mjs'], dependencies: [] },
  { files: ['src/core/projects.mjs'], dependencies: [] },
];
// Starts a story whose editor stops as the direction asks, and answers the attempt it stopped.
const stopped = async (c, id, direction) => {
  const { store, runner } = c.app;
  if (store.task(id).approval?.status !== 'approved') approveWork(store, runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction });
  runner.start(id);
  return c.wait(id, 'blocked');
};
const asking = request => `block-request ${JSON.stringify(request)}`;
const samples = [
  {
    name: 'ready work',
    labels: ['Start assignment', 'Withdraw approval and deny'],
    build: async t => {
      const c = await sourceStudio(t);
      return { c, id: c.taskId };
    },
  },
  {
    name: 'proposed work',
    labels: ['Approve work', 'Deny work'],
    build: async t => {
      const c = await sourceStudio(t),
        { ids } = await c.breakdown(twoStories);
      return { c, id: ids[0] };
    },
  },
  {
    name: 'a result in review',
    labels: ['Accept result', 'Request revision', 'Close without accepting'],
    build: async t => {
      const c = await sourceStudio(t);
      await c.start();
      // The trusted protocol seam marks the fixture's checks as measured, as a real attempt's are.
      c.measuredFixture(await c.wait(c.taskId));
      return { c, id: c.taskId };
    },
  },
  {
    name: 'a stop without a question',
    labels: ['Start assignment', 'Close'],
    build: async t => {
      const c = await sourceStudio(t),
        attempt = await stopped(c, c.taskId, 'block');
      assert.equal(attempt.question?.ask, undefined, 'The editor stopped without asking.');
      assert.equal(attempt.scopeRequest, undefined, 'The editor stopped without a file request.');
      return { c, id: c.taskId };
    },
  },
  {
    name: 'a story blocked on a file another story has since created',
    labels: ['Close and send as a new idea', 'Withdraw approval and deny'],
    build: async t => {
      const c = await sourceStudio(t),
        { store, runner } = c.app,
        { ids } = await c.breakdown([
          { files: ['src/core/workflows.mjs'], newFiles: [created], dependencies: [] },
          { files: ['src/core/projects.mjs'], newFiles: [created], dependencies: [] },
        ]);
      for (const story of ids) approveWork(store, runner.registries, store.task(story));
      runner.start(ids[0]);
      const { review } = await c.toReview(ids[0]);
      c.integrated(ids[0], review, { [created]: 'export const created = 1;\n' });
      const start = await c.request(`/api/tasks/${ids[1]}/start`, { projectId });
      assert.ok(start.status >= 400 && start.status < 500, JSON.stringify(start.data));
      assert.ok(store.task(ids[1]).sourceStage?.outdated, 'The story notes that its plan is out of date.');
      return { c, id: ids[1] };
    },
  },
  {
    name: 'a blocked editor whose file request is usable',
    labels: ['Allow and continue', 'Start assignment', 'Close'],
    build: async t => {
      const c = await sourceStudio(t),
        { ids } = await c.breakdown(twoStories),
        request = {
          files: ['src/core/projects.mjs'],
          newFiles: ['src/core/wording.mjs'],
          reason: 'It pins the wording.',
        },
        attempt = await stopped(c, ids[0], asking(request));
      assert.equal(attempt.scopeRequest.problem, undefined, 'The request is one the controller would accept.');
      return { c, id: ids[0] };
    },
  },
  {
    name: 'a blocked editor whose file request names a file outside the measured list',
    labels: ['Close and send as a new idea', 'Close'],
    build: async t => {
      const c = await sourceStudio(t),
        byHand = 'test/by-hand.test.mjs',
        { ids } = await c.breakdown(twoStories);
      // Committed after the breakdown's checks measured the source.
      fs.writeFileSync(path.join(c.root, byHand), '// Added by hand\n');
      git(c.root, ['add', byHand]);
      git(c.root, ['commit', '--quiet', '-m', 'Add a test by hand']);
      const attempt = await stopped(c, ids[0], asking({ files: [byHand], reason: 'The hand-added test pins it.' }));
      assert.ok(attempt.scopeRequest.problem, 'The request records why approving it would be refused.');
      return { c, id: ids[0] };
    },
  },
  {
    name: 'a blocked editor whose file request names a file its prerequisite created',
    labels: ['Allow and continue', 'Start assignment', 'Close'],
    build: async t => {
      const c = await sourceStudio(t),
        { store, runner } = c.app,
        { ids } = await c.breakdown([
          { files: ['src/core/workflows.mjs'], newFiles: [created], dependencies: [] },
          { files: ['src/core/projects.mjs'], dependencies: ['workflow'] },
        ]),
        reason = 'The module the earlier story created needs the new wording.';
      approveWork(store, runner.registries, store.task(ids[0]));
      runner.start(ids[0]);
      const { review } = await c.toReview(ids[0]);
      c.integrated(ids[0], review, created, '// Created by the earlier story in the chain\n');
      const attempt = await stopped(c, ids[1], asking({ files: [created], reason }));
      assert.deepEqual(attempt.scopeRequest, { files: [], newFiles: [created], deleteFiles: [], reason });
      return { c, id: ids[1] };
    },
  },
];

// Sends one listed action with its method and path, each field the records fill and a model-free value for each
// required field they leave empty.
const deliver = async (c, action) => {
  const body = {};
  for (const item of action.fields)
    if ('value' in item) body[item.name] = item.value;
    else if (item.required) {
      assert.ok(item.name in values, `A model-free value for ${item.name}.`);
      body[item.name] = values[item.name];
    }
  const res = await fetch(c.origin + action.path, {
    method: action.method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};
// The controller's own stops of the task after the event seq given: a refused start records a blocked event that
// names no attempt.
const latestEvent = c => c.app.store.events(null, { logs: false }).at(-1)?.seq ?? 0;
const controllerStops = (c, id, after) =>
  c.app.store
    .events(null, { logs: false })
    .filter(event => event.seq > after && event.task_id === id && event.kind === 'blocked' && !event.attempt_id);
// An action is accepted when its answer is 2xx and it did not block the task again: a start it asks for is not
// refused, and the controller stopped the task only where its answer says the work is queued to wait.
const accepted = (c, id, label, answer, before) => {
  assert.ok(
    answer.status >= 200 && answer.status < 300,
    `${label} answered ${answer.status}: ${JSON.stringify(answer.data)}`,
  );
  const start = answer.data?.start;
  assert.notEqual(start?.ok, false, `${label} blocked the task again: ${JSON.stringify(start)}`);
  if (answer.data?.queued !== true && start?.queued !== true)
    assert.deepEqual(
      controllerStops(c, id, before).map(event => event.message),
      [],
      `${label} blocked the task again.`,
    );
};
// Where the list leaves out Allow and continue on a story whose editor asked for files or whose plan the code moved
// past, the edit it would send: the story's paths with the requested ones and a reason. Elsewhere an edit of the file
// list is the page's own form rather than a listed action, so only a request that names no paths is sent.
const leftOutEdit = (c, task) => {
  const latest = task.lastAttemptId ? c.app.store.attempt(task.lastAttemptId) : null,
    request = latest?.scopeRequest;
  if (!request && !task.sourceStage?.outdated) return {};
  const line = label =>
      (
        String(task.brief ?? '')
          .split('\n')
          .find(text => text.startsWith(label + ': ')) ?? ''
      )
        .slice(label.length + 2)
        .split(', ')
        .filter(Boolean),
    join = (label, list) => [...new Set([...line(label), ...(request?.[list] ?? [])])];
  return {
    files: join('Files', 'files'),
    newFiles: join('New files', 'newFiles'),
    deleteFiles: join('Delete', 'deleteFiles'),
    reason: request?.reason ?? values.reason,
    ...(request ? { request: latest.id } : {}),
  };
};

// Whether the story's out-of-date note came from its editor's file request: every file it names is one the latest
// attempt's request asked for.
const outdatedByRequest = (c, task) => {
  const files = task.sourceStage?.outdated?.files ?? [],
    request = task.lastAttemptId ? c.app.store.attempt(task.lastAttemptId)?.scopeRequest : null,
    asked = new Set([...(request?.files ?? []), ...(request?.newFiles ?? []), ...(request?.deleteFiles ?? [])]);
  return files.length > 0 && files.every(file => asked.has(file));
};

for (const sample of samples)
  test(`the sweep on ${sample.name}: each listed action is accepted, and Start and edit-scope left out are refused`, async t => {
    await t.test('reads its actions and refuses the left-out ones', async t => {
      const { c, id } = await sample.build(t),
        page = await actionsOf(c, id, sample.labels);
      for (const [label, route] of [
        ['Start assignment', 'start'],
        ['Allow and continue', 'edit-scope'],
      ]) {
        if (page.actions.some(action => action.path.endsWith(`/${route}`))) continue;
        assert.equal(
          page.actions.some(action => action.label === label),
          false,
          `${label} is left out.`,
        );
        // The list leaves out Start on every out-of-date story, since restarting one whose editor needs a file it
        // cannot be given only blocks again. Where the note came only from a file request, the story's own files are
        // still current and the controller still accepts Start; story T-d3193a7e ("The controller refuses every task
        // command its action list does not offer now") makes it refuse this one, so only its refusal is skipped here.
        if (route === 'start' && outdatedByRequest(c, c.app.store.task(id))) continue;
        const before = recorded(c, id),
          answer = await c.request(`/api/tasks/${encodeURIComponent(id)}/${route}`, {
            projectId,
            ...(route === 'edit-scope' ? leftOutEdit(c, c.app.store.task(id)) : {}),
          });
        assert.ok(answer.status >= 400 && answer.status < 500, `${label} answered ${answer.status}.`);
        assert.equal(recorded(c, id), before, `${label}, refused, changes nothing.`);
      }
    });
    // Each listed action on a fresh copy of the sample, so none is sent after another changed the story.
    for (const label of sample.labels)
      await t.test(`sends ${label}`, async t => {
        const { c, id } = await sample.build(t),
          page = await actionsOf(c, id, sample.labels),
          before = latestEvent(c),
          action = page.actions.find(item => item.label === label);
        accepted(c, id, label, await deliver(c, action), before);
      });
  });

// The shared rules read the attempts used from the count the controller served with the task (its attemptCount), so
// the past-the-limit Start the actions offer is the one the controller refuses an automatic start past: a flow's
// earlier rounds, or an attempt the environment ended, on record do not put it past the limit. A record served without
// a count is counted as before.
test('the past-the-limit Start follows the served attempt count, and a record without one counts as before', () => {
  const attempts = [
      { id: 'a1', taskId: 'T-9', status: 'failed', workerId: 'W-1' },
      { id: 'a2', taskId: 'T-9', status: 'failed', workerId: 'W-1' },
    ],
    task = fields => ({
      id: 'T-9',
      projectId,
      title: 'Work',
      kind: 'general',
      status: 'failed',
      workerId: 'W-1',
      maxAttempts: 2,
      lastAttemptId: 'a2',
      ...fields,
    }),
    start = (fields, records = attempts) => {
      const record = task(fields);
      return globalThis.StudioTaskActions.taskActions(record, {
        project: { id: projectId },
        tasks: [record],
        attempts: records,
        runs: [],
      }).find(action => action.label === 'Start assignment')?.key;
    };
  // Two earlier-round attempts on record, one used of this round's two: an ordinary Start.
  assert.equal(start({ attemptCount: { used: 1, allowed: 2 } }), 'start');
  // The served count reaches the limit: Start past it.
  assert.equal(start({ attemptCount: { used: 2, allowed: 2 } }), 'start-past-limit');
  // No limit served: never past it.
  assert.equal(start({ attemptCount: { used: 5 } }), 'start');
  // Without a served count, the two failed attempts on record reach the limit, as before.
  assert.equal(start({}), 'start-past-limit');
  // ...and an attempt the controller's stop ended (its endCause) is not one of them.
  assert.equal(
    start({}, [attempts[0], { ...attempts[1], endCause: { cause: 'environment', detail: 'controller-stop' } }]),
    'start',
  );
});
