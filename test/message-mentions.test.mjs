// Naming a story's builder on its thread (team chat, November 2026): the message takes the one action the director's
// own buttons allow for the story's state, through the same functions, with the message's text as its note or
// direction: send back a story whose review passed, revise one waiting for review, or start a stopped one. Busy or
// finished work keeps the message as a note, a refusal keeps it as refused, and any other message waits for a reply.
// Each case is compared with the same story driven through the existing routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup as studio } from './studio-setup.mjs';
import { setup as sourceStory } from './source-story-setup.mjs';
import { autonomyPolicy, saveAutonomyPolicy } from '../src/core/autonomy.mjs';
import { studioDeskSourceResources } from '../src/connectors/source-projects.mjs';
import { projectOrganization } from '../src/core/project-organization.mjs';
import { postMessage } from '../src/core/messages.mjs';

const projectId = 'project-legacy',
  waiting = { type: 'waiting', reason: 'Waiting for a reply.' },
  post = (c, taskId, text) =>
    c.request(`/api/projects/${projectId}/messages`, { projectId, channel: { type: 'task', id: taskId }, text }),
  taskEvents = (store, taskId) => store.events().filter(event => event.task_id === taskId),
  // What a task and its attempts are, byte for byte.
  snapshot = (store, taskId) => JSON.stringify({ task: store.task(taskId), attempts: store.attempts(taskId) }),
  builderOf = (store, task) =>
    projectOrganization(store, projectId).workers.find(worker => worker.id === task.workerId);

// A story whose edit and independent review are accepted, the review passing, in a paused studio, so Start answers the
// same way each time and nothing runs.
async function passed(t) {
  const c = await sourceStory(t),
    store = c.app.store;
  await c.start();
  const { review } = await c.toReview(c.taskId);
  assert.equal(store.task(c.taskId).sourceStage.current, 'waiting-for-integration');
  assert.equal((await c.request('/api/control', { paused: true })).status, 200);
  return { c, store, review, story: store.task(c.taskId) };
}

test("naming a passed story's builder sends it back with the message, as Send back with that note does", async t => {
  const [byRoute, byMessage] = await Promise.all([passed(t), passed(t)]),
    name = builderOf(byMessage.store, byMessage.story).displayName,
    text = `@${name} tighten the copy`;
  const sent = await byRoute.c.request(`/api/tasks/${byRoute.c.taskId}/send-back`, { note: text });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  const posted = await post(byMessage.c, byMessage.c.taskId, text);
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const routed = byRoute.store.task(byRoute.c.taskId),
    mentioned = byMessage.store.task(byMessage.c.taskId);
  assert.equal(mentioned.direction, routed.direction);
  assert.match(mentioned.direction, /Director's note: @.+ tighten the copy$/);
  for (const field of ['status', 'reason', 'queued'])
    assert.deepEqual(mentioned[field], routed[field], `The task's ${field} matches Send back.`);
  assert.equal(mentioned.sourceStage.phase, routed.sourceStage.phase);
  assert.deepEqual(
    byMessage.store.attempts(byMessage.c.taskId).map(attempt => attempt.status),
    byRoute.store.attempts(byRoute.c.taskId).map(attempt => attempt.status),
  );
  const sentBack = c => c.store.events().find(event => event.kind === 'sent_back');
  assert.equal(sentBack(byMessage).message, sentBack(byRoute).message);
  // Queued as Send back queues it, and the message answers with what it led to, as recorded.
  assert.deepEqual(posted.data.outcome, { type: 'sent-back', taskId: byMessage.c.taskId, start: sent.data.start });
  assert.deepEqual(posted.data.outcome.start, { ok: false, reason: 'Studio dispatch is paused.' });
  assert.deepEqual(byMessage.store.message(posted.data.id).outcome, posted.data.outcome);
  assert.deepEqual(posted.data.mentions, [mentioned.workerId]);
});

test('an integration approved first refuses the mention, and the message is kept as refused', async t => {
  const { c, store, review } = await passed(t);
  saveAutonomyPolicy(store, c.app.runner.registries, projectId, {
    expectedRevision: autonomyPolicy(store, projectId).revision,
    enabled: true,
    retries: 0,
    kinds: {
      'studio-development:change': { approve: 'director', accept: 'director', integrate: 'director' },
      'studio-development:change-review': { approve: 'auto', accept: 'director' },
    },
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  store.claim([...studioDeskSourceResources], 'held-by-another-story');
  c.app.runner.autonomy.requestIntegration(store.task(c.taskId), review.id, review.artifacts[0].hash, {
    by: { type: 'policy', revision: 1, reason: 'Integrate after a passing review: independent review passed' },
  });
  assert.equal(c.app.runner.autonomy.pendingIntegration().taskId, c.taskId);
  const before = snapshot(store, c.taskId),
    events = taskEvents(store, c.taskId).length,
    text = `@${builderOf(store, store.task(c.taskId)).displayName} tighten the copy`;
  const refused = await c.request(`/api/tasks/${c.taskId}/send-back`, { note: text });
  assert.equal(refused.status, 409);
  const posted = await post(c, c.taskId, text);
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.outcome, { type: 'refused', reason: refused.data.error });
  assert.equal(
    posted.data.outcome.reason,
    'Integration is approved for this work and waiting to run; it cannot be sent back now.',
  );
  assert.deepEqual(store.message(posted.data.id).outcome, posted.data.outcome);
  assert.equal(snapshot(store, c.taskId), before, 'The story is exactly as it was.');
  assert.equal(taskEvents(store, c.taskId).length, events);
  assert.equal(c.app.runner.autonomy.pendingIntegration().taskId, c.taskId);
  store.release('held-by-another-story');
});

// Work of the general kind seeded in each state, owned by one agent of the project. Each waits for unfinished work, so
// a Start is queued and answers the same way each time, and nothing runs.
async function general(t) {
  const c = await studio(t),
    store = c.app.store,
    builder = projectOrganization(store, projectId).workers.find(worker => worker.enabled),
    other = projectOrganization(store, projectId).workers.find(worker => worker.enabled && worker.id !== builder.id);
  store.putTask({
    id: 'T-prerequisite',
    projectId,
    kind: 'general',
    title: 'The prerequisite',
    workerId: builder.id,
    team: builder.team,
    status: 'backlog',
    dependencies: [],
    resources: [],
    lastAttemptId: null,
  });
  const seed = (name, status, attemptStatus, extra = {}) => {
    const taskId = `T-${name}`,
      attemptId = `attempt-${name}`;
    store.putTask({
      id: taskId,
      projectId,
      kind: 'general',
      title: `The ${name}`,
      brief: 'Bounded model-free work.',
      workerId: builder.id,
      team: builder.team,
      teamId: builder.teamId,
      status,
      direction: '',
      reason: '',
      hold: false,
      queued: false,
      dependencies: ['T-prerequisite'],
      resources: [],
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      lastAttemptId: attemptStatus ? attemptId : null,
      ...(attemptStatus === 'accepted' ? { acceptedAttemptId: attemptId } : {}),
      ...extra,
    });
    if (attemptStatus)
      store.insertAttempt(
        { id: attemptId, taskId, projectId, workerId: builder.id, status: attemptStatus, artifacts: [] },
        { text: 'Fixture', hash: 'fixture' },
      );
    return taskId;
  };
  return { c, store, builder, other, seed, mention: `@${builder.displayName}` };
}
const record = (store, taskId) => {
  const { status, reason, direction, queued, autonomyNote } = store.task(taskId);
  return { status, reason, direction, queued, autonomyNote };
};

test('naming the builder of work in review revises it as Revise does, then starts it as Start does', async t => {
  const { c, store, seed, mention } = await general(t),
    text = `${mention} tighten the copy`,
    routed = seed('routed', 'review', 'review'),
    mentioned = seed('mentioned', 'review', 'review'),
    direct = seed('direct', 'review', 'review');
  const revised = await c.request(`/api/tasks/${routed}/revise`, { direction: text });
  assert.deepEqual(revised, { status: 200, data: { ok: true } });
  const afterRevise = record(store, routed);
  assert.equal(afterRevise.status, 'ready');
  // The mention, called as the route calls it: the work is revised and ready when its Start is queued.
  let queuedAs;
  const message = postMessage(
    store,
    c.app.runner.registries,
    projectId,
    { channel: { type: 'task', id: direct }, text },
    {
      queueStart: taskId => {
        queuedAs = record(store, taskId);
        return { ok: true, queued: true, reason: '' };
      },
    },
  );
  assert.deepEqual(queuedAs, afterRevise);
  assert.deepEqual(message.outcome, { type: 'revised', taskId: direct, start: { ok: true, queued: true, reason: '' } });
  // Through the route: the same attempt, task and event as Revise, then Start.
  const started = await c.request(`/api/tasks/${routed}/start`);
  const posted = await post(c, mentioned, text);
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.outcome, { type: 'revised', taskId: mentioned, start: started.data });
  assert.deepEqual(store.message(posted.data.id).outcome, posted.data.outcome);
  assert.deepEqual(record(store, mentioned), record(store, routed));
  for (const id of [mentioned, direct]) {
    const attempt = store.attempt(`attempt-${id.slice(2)}`);
    assert.equal(attempt.status, 'revision_requested');
    assert.equal(attempt.revisionRequestedBy.type, 'director');
    assert.equal(attempt.revisionRequestedBy.reason, store.attempt('attempt-routed').revisionRequestedBy.reason);
  }
  const revision = id => taskEvents(store, id).find(event => event.kind === 'revision');
  assert.equal(revision(mentioned).message, revision(routed).message);
  assert.equal(revision(mentioned).attempt_id, `attempt-mentioned`);
  assert.deepEqual(
    taskEvents(store, mentioned).map(event => [event.kind, event.message]),
    taskEvents(store, routed).map(event => [event.kind, event.message]),
  );
});

test('naming the builder of stopped work makes the message its direction and queues it as Start does', async t => {
  const { c, store, seed, mention } = await general(t),
    text = `${mention} try the shorter title`;
  for (const status of ['blocked', 'failed']) {
    const routed = seed(`${status}-routed`, status, 'failed'),
      mentioned = seed(`${status}-mentioned`, status, 'failed');
    const started = await c.request(`/api/tasks/${routed}/start`, { direction: text });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    assert.equal(started.data.queued, true);
    const posted = await post(c, mentioned, text);
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.deepEqual(posted.data.outcome, { type: 'started', taskId: mentioned, start: started.data });
    assert.deepEqual(store.message(posted.data.id).outcome, posted.data.outcome);
    assert.equal(store.task(mentioned).direction, text);
    assert.deepEqual(record(store, mentioned), record(store, routed));
    assert.deepEqual(
      store.attempts(mentioned).map(attempt => attempt.status),
      ['failed'],
    );
    assert.deepEqual(
      taskEvents(store, mentioned).map(event => [event.kind, event.message]),
      taskEvents(store, routed).map(event => [event.kind, event.message]),
    );
  }
});

test('busy, finished and unapproved work keeps the message as a note and changes nothing', async t => {
  const { c, store, seed, mention } = await general(t),
    running = seed('running', 'running', 'running'),
    accepted = seed('accepted', 'done', 'accepted'),
    planned = seed('planned', 'backlog', null, {
      reason: 'Awaiting director work approval.',
      approval: { status: 'pending' },
    });
  // Start refuses each of them, and so does Send back; Revise refuses all but work in review.
  for (const taskId of [running, accepted, planned]) {
    const before = snapshot(store, taskId),
      events = taskEvents(store, taskId).length;
    assert.ok((await c.request(`/api/tasks/${taskId}/start`, { direction: 'Go.' })).status >= 400);
    assert.ok((await c.request(`/api/tasks/${taskId}/send-back`, { note: 'Go.' })).status >= 400);
    assert.equal(snapshot(store, taskId), before);
    const posted = await post(c, taskId, `${mention} please look at this`);
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.deepEqual(posted.data.outcome, { type: 'note', taskId, receivedBy: null });
    assert.deepEqual(store.message(posted.data.id).outcome, posted.data.outcome);
    assert.equal(snapshot(store, taskId), before, `${taskId} and its attempts are byte-identical.`);
    assert.equal(taskEvents(store, taskId).length, events);
  }
  // Never approved by a mention.
  assert.deepEqual(store.task(planned).approval, { status: 'pending' });
});

test('a message naming another agent, or no one, waits for a reply and changes no task', async t => {
  const { c, store, seed, other } = await general(t),
    stopped = seed('stopped', 'failed', 'failed'),
    before = snapshot(store, stopped);
  for (const text of [`@${other.displayName} what do you think?`, 'No one named here.', 'mail me at eli@example.com']) {
    const posted = await post(c, stopped, text);
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.deepEqual(posted.data.outcome, waiting);
    assert.deepEqual(store.message(posted.data.id).outcome, waiting);
  }
  assert.equal(snapshot(store, stopped), before);
  assert.deepEqual(taskEvents(store, stopped), []);
});

test('a refused action keeps the message as refused, and a message that fails its checks runs nothing', async t => {
  const { c, store, seed, mention } = await general(t),
    // Never replay an editor mutation: its fixed attempt limit refuses Revise, and the mention too.
    fixed = seed('fixed', 'review', 'review', { kind: 'unreal-integration', maxAttempts: 1 }),
    before = snapshot(store, fixed);
  const revised = await c.request(`/api/tasks/${fixed}/revise`, { direction: 'Again.' });
  assert.equal(revised.status, 400);
  assert.equal(revised.data.error, 'Attempt limit reached. Create a newly scoped assignment.');
  const posted = await post(c, fixed, `${mention} again`);
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.outcome, { type: 'refused', reason: revised.data.error });
  assert.deepEqual(store.message(posted.data.id).outcome, posted.data.outcome);
  assert.equal(snapshot(store, fixed), before);
  assert.deepEqual(taskEvents(store, fixed), []);
  // A message that fails its checks is not kept, and its mention does nothing.
  const stopped = seed('stopped', 'failed', 'failed'),
    kept = snapshot(store, stopped),
    invalid = await c.request(`/api/projects/${projectId}/messages`, {
      projectId,
      channel: { type: 'task', id: stopped },
      text: `${mention} go`,
      attachments: [{ taskId: 'T-missing', attemptId: 'attempt-missing', path: 'notes.md' }],
    });
  assert.equal(invalid.status, 404, JSON.stringify(invalid.data));
  assert.equal(snapshot(store, stopped), kept);
  assert.deepEqual(store.messagePage(projectId, { type: 'task', id: stopped }).messages, []);
});
