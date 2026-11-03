// Naming an idea's planner in the idea's chat (team chat, November 2026): the message is the director's reply to the
// plan, as the idea conversation sends it. An accepted plan whose steps all wait is planned again with the message's
// words, as POST replan does; a plan waiting for review is revised with them, as POST revise does, then queued as
// Start. A plan being written or with a step started takes no reply, and any other message waits. Each case is
// compared with the same idea driven through the existing routes. Model-free: Simulator employees only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { projectOrganization } from '../src/core/project-organization.mjs';
import { planKinds, planStepOf, plannerOf } from '../src/core/messages.mjs';

const kinds = ['general:plan', 'general:work', 'general:review'],
  // A bench of specialists: the planner is not the builder.
  bench = { 'W-02': ['planner'], 'W-03': ['worker'], 'W-05': ['reviewer'], 'W-06': ['reviewer'] },
  waiting = { type: 'waiting', reason: 'Waiting for a reply.' },
  houseRules = {
    enabled: true,
    retries: 0,
    kinds: {
      'general:plan': { approve: 'director', accept: 'auto' },
      'general:work': { approve: 'director', accept: 'auto' },
      'general:review': { approve: 'auto', accept: 'auto' },
    },
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  };

// The general-work fixture of the existing replan test: a studio of Simulator employees.
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-planner-mention-')),
    registries = createRegistries(),
    delay = process.env.STUDIO_MOCK_DELAY_MS;
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
  c.store = c.app.store;
  c.request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.until = (check, label) =>
    waitFor(check, label, { interval: 10, detail: () => JSON.stringify(c.store.tasks().slice(-3)) });
  c.pause = async () => assert.equal((await c.request('/api/control', { paused: true })).status, 200);
  // A project with the bench, optionally under house rules that accept a plan by themselves, and one idea sent to it.
  c.idea = async (name, rules = null) => {
    const created = await c.request('/api/projects', { name });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const projectId = created.data.id;
    const saved = await c.request(
      `/api/projects/${projectId}/organization`,
      {
        projectId,
        expectedRevision: c.store.setting('project-organization:' + projectId).revision,
        teams: [{ id: 'team', name: 'Team', purpose: 'Bounded work that is not code.' }],
        members: Object.entries(bench).map(([workerId, roles]) => ({
          workerId,
          teamId: 'team',
          role: 'Contributor',
          responsibility: 'Bounded work that is not code.',
          roles,
        })),
        taskKinds: ['general', ...kinds],
        kindOwners: {},
      },
      'PATCH',
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    if (rules) {
      const policy = await c.request(`/api/projects/${projectId}/autonomy`, {
        projectId,
        expectedRevision: 0,
        ...rules,
      });
      assert.equal(policy.status, 200, JSON.stringify(policy.data));
    }
    const intake = await c.request('/api/intake', { projectId, idea: 'Write a guide.' });
    assert.equal(intake.status, 201, JSON.stringify(intake.data));
    return { projectId, runId: intake.data.runId, planId: intake.data.taskIds[0] };
  };
  c.post = (idea, text, channel = { type: 'run', id: idea.runId }) =>
    c.request(`/api/projects/${idea.projectId}/messages`, { projectId: idea.projectId, channel, text });
  c.name = (idea, workerId) =>
    projectOrganization(c.store, idea.projectId).workers.find(worker => worker.id === workerId).displayName;
  // Every task and attempt of the idea's project, byte for byte.
  c.snapshot = idea =>
    JSON.stringify(c.store.projectTasks(idea.projectId).map(task => ({ task, attempts: c.store.attempts(task.id) })));
  // Every event of the project's tasks in order (store.events() reads only the latest).
  c.events = idea => {
    const ids = new Set(c.store.projectTasks(idea.projectId).map(task => task.id));
    return c.store.db
      .prepare('SELECT kind, message, task_id FROM events ORDER BY seq')
      .all()
      .filter(event => ids.has(event.task_id));
  };
  return c;
}

const planRecord = task => {
  const { status, reason, direction, queued, autonomyNote, acceptedAttemptId } = task;
  return { status, reason, direction, queued, autonomyNote, acceptedAttemptId };
};

test('naming the planner of an accepted plan whose steps wait plans it again as POST replan does', async t => {
  const c = await setup(t),
    routed = await c.idea('Replanned by the route', houseRules),
    mentioned = await c.idea('Replanned by a message', houseRules);
  for (const idea of [routed, mentioned]) {
    idea.steps = await c.until(() => c.store.task(idea.planId).proposedTaskIds, 'the plan to propose work');
    idea.first = c.store.task(idea.planId).acceptedAttemptId;
  }
  await c.pause();
  const planner = plannerOf(c.store, c.store.task(mentioned.planId));
  assert.equal(planner, 'W-02');
  // The planner's name in another case still names the planner.
  const text = `@${c.name(mentioned, planner).toUpperCase()} split the second step`;
  const replied = await c.request(`/api/tasks/${routed.planId}/replan`, {
    projectId: routed.projectId,
    direction: text,
  });
  assert.equal(replied.status, 202, JSON.stringify(replied.data));
  const before = c.events(mentioned).length;
  const posted = await c.post(mentioned, text);
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.mentions, [planner]);
  // The message answers with what it led to, as recorded, and its start is the replan route's.
  assert.deepEqual(posted.data.outcome, { type: 'replanned', taskId: mentioned.planId, start: replied.data.start });
  assert.deepEqual(replied.data.start, { ok: false, reason: 'Studio dispatch is paused.' });
  assert.deepEqual(c.store.message(posted.data.id).outcome, posted.data.outcome);
  // The same records: the steps set aside with the same reason, the plan ready with the reply, its first plan kept.
  const steps = idea =>
    idea.steps.map(id => {
      const { status, reason, queued, approval } = c.store.task(id);
      return { status, reason, queued, approval: { status: approval.status, reason: approval.reason } };
    });
  assert.ok(steps(mentioned).every(step => step.status === 'denied'));
  assert.deepEqual(steps(mentioned), steps(routed));
  assert.deepEqual(planRecord(c.store.task(mentioned.planId)), planRecord(c.store.task(routed.planId)));
  assert.equal(c.store.task(mentioned.planId).acceptedAttemptId, undefined);
  assert.match(c.store.task(mentioned.planId).direction, /split the second step/);
  const first = idea => c.store.attempt(idea.first);
  assert.equal(first(mentioned).status, 'accepted');
  assert.equal(first(mentioned).replannedBy.reason, first(routed).replannedBy.reason);
  assert.equal(first(mentioned).replannedBy.reason, text);
  // The same events, in the same order.
  const added = (idea, from) =>
    c
      .events(idea)
      .slice(from)
      .map(event => [event.kind, event.message]);
  const routedEvents = c.events(routed),
    replannedAt = routedEvents.findIndex(event => event.kind === 'work_denied');
  assert.deepEqual(added(mentioned, before), added(routed, replannedAt));
  // The steps set aside and the plan replanned, then the paused studio's answer to its queued start.
  assert.deepEqual(
    added(mentioned, before).map(([kind]) => kind),
    [...mentioned.steps.map(() => 'work_denied'), 'replanned', 'blocked'],
  );
});

test('naming the planner of a plan waiting for review revises it as POST revise does, then starts it as Start does', async t => {
  const c = await setup(t),
    routed = await c.idea('Revised by the route'),
    mentioned = await c.idea('Revised by a message');
  for (const idea of [routed, mentioned])
    await c.until(() => c.store.task(idea.planId).status === 'review', 'the plan to wait for review');
  await c.pause();
  const planner = plannerOf(c.store, c.store.task(mentioned.planId)),
    text = `@${c.name(mentioned, planner).toLowerCase()} keep it to one page`;
  const revised = await c.request(`/api/tasks/${routed.planId}/revise`, {
    projectId: routed.projectId,
    direction: text,
  });
  assert.deepEqual(revised, { status: 200, data: { ok: true } });
  // The paused studio refuses Start, and the message's queued start answers the same.
  const started = await c.request(`/api/tasks/${routed.planId}/start`, { projectId: routed.projectId });
  assert.deepEqual(started, { status: 400, data: { error: 'Studio dispatch is paused.' } });
  const before = c.events(mentioned).length,
    routedBefore = c.events(routed).findIndex(event => event.kind === 'revision');
  const posted = await c.post(mentioned, text);
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.mentions, [planner]);
  assert.deepEqual(posted.data.outcome, {
    type: 'revised',
    taskId: mentioned.planId,
    start: { ok: false, reason: started.data.error },
  });
  assert.deepEqual(c.store.message(posted.data.id).outcome, posted.data.outcome);
  assert.deepEqual(planRecord(c.store.task(mentioned.planId)), planRecord(c.store.task(routed.planId)));
  assert.match(c.store.task(mentioned.planId).direction, /keep it to one page/);
  const latest = idea => c.store.attempt(c.store.task(idea.planId).lastAttemptId);
  assert.equal(latest(mentioned).status, 'revision_requested');
  assert.equal(latest(mentioned).revisionRequestedBy.reason, latest(routed).revisionRequestedBy.reason);
  assert.deepEqual(
    c
      .events(mentioned)
      .slice(before)
      .map(event => [event.kind, event.message]),
    c
      .events(routed)
      .slice(routedBefore)
      .map(event => [event.kind, event.message]),
  );
});

test('a plan being written or with a step started refuses the message, and other messages wait; nothing changes', async t => {
  const c = await setup(t),
    accepted = await c.idea('A plan with a started step', houseRules);
  const [stepId] = await c.until(() => c.store.task(accepted.planId).proposedTaskIds, 'the plan to propose work');
  await c.pause();
  // An idea sent while the studio is paused waits for its planning to start; then its planner is writing it (its
  // running attempt seeded, as nothing runs in a paused studio).
  const writing = await c.idea('A plan being written'),
    writer = c.store.task(writing.planId).workerId;
  assert.equal(writer, 'W-02', 'The plan step names its planner before it runs.');
  let before, events, posted;
  const refusedAs = async (idea, reason) => {
    before = c.snapshot(idea);
    events = c.events(idea).length;
    posted = await c.post(idea, `@${c.name(idea, writer)} split the second step`);
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.deepEqual(posted.data.outcome, { type: 'refused', reason });
    assert.deepEqual(c.store.message(posted.data.id).outcome, posted.data.outcome);
    assert.equal(c.snapshot(idea), before, 'Every task and attempt is unchanged.');
    assert.equal(c.events(idea).length, events);
  };
  assert.equal(c.store.task(writing.planId).status, 'blocked');
  await refusedAs(
    writing,
    'The plan cannot take a reply now. It waits for your answer, or for its planning to start again.',
  );
  c.store.putTask({ ...c.store.task(writing.planId), status: 'running', lastAttemptId: 'attempt-writing' });
  c.store.insertAttempt(
    {
      id: 'attempt-writing',
      taskId: writing.planId,
      projectId: writing.projectId,
      workerId: writer,
      status: 'running',
      startedAt: new Date().toISOString(),
      artifacts: [],
    },
    { text: 'Fixture', hash: 'fixture' },
  );
  assert.equal(plannerOf(c.store, c.store.task(writing.planId)), writer);
  await refusedAs(writing, 'The plan cannot take a reply now. It is still being written; reply once it arrives.');
  // A step started: the replan route refuses, and the message is refused in its words.
  assert.equal((await c.request(`/api/tasks/${stepId}/approve-work`, { projectId: accepted.projectId })).status, 200);
  const step = c.store.task(stepId);
  c.store.insertAttempt(
    {
      id: 'attempt-started-step',
      taskId: stepId,
      projectId: accepted.projectId,
      workerId: step.workerId,
      status: 'failed',
      artifacts: [],
    },
    { text: 'Fixture', hash: 'fixture' },
  );
  const planner = plannerOf(c.store, c.store.task(accepted.planId)),
    text = `@${c.name(accepted, planner)} split the second step`;
  before = c.snapshot(accepted);
  events = c.events(accepted).length;
  const refused = await c.request(`/api/tasks/${accepted.planId}/replan`, {
    projectId: accepted.projectId,
    direction: text,
  });
  assert.equal(refused.status, 400);
  posted = await c.post(accepted, text);
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.outcome, {
    type: 'refused',
    reason: `The plan cannot take a reply now. ${refused.data.error}`,
  });
  assert.match(posted.data.outcome.reason, /have started/);
  assert.equal(c.snapshot(accepted), before, 'Every task and attempt is unchanged.');
  assert.equal(c.events(accepted).length, events);
  // Naming a builder, or no one, in the idea's chat, and anything on the project's channel, waits for a reply.
  const builder = c.name(accepted, step.workerId);
  assert.notEqual(step.workerId, planner);
  for (const [message, channel] of [
    [`@${builder} what do you think?`, undefined],
    ['No one named here.', undefined],
    [text, { type: 'project' }],
  ]) {
    const kept = await c.post(accepted, message, channel);
    assert.equal(kept.status, 201, JSON.stringify(kept.data));
    assert.deepEqual(kept.data.outcome, waiting);
    assert.deepEqual(c.store.message(kept.data.id).outcome, waiting);
  }
  assert.equal(c.snapshot(accepted), before);
  assert.equal(c.events(accepted).length, events);
});

test("an idea's plan step is its run's task of a planning kind, and its planner the latest attempt's agent", () => {
  assert.deepEqual([...planKinds], ['studio-development:breakdown', 'general:plan']);
  const tasks = [
      { id: 'T-other-run', kind: 'general:plan', workflowReference: { runId: 'run-other' } },
      { id: 'T-checks', kind: 'studio-development:source-checks', workflowReference: { runId: 'run-idea' } },
      {
        id: 'T-breakdown',
        kind: 'studio-development:breakdown',
        workerId: 'W-01',
        workflowReference: { runId: 'run-idea' },
      },
    ],
    attempts = {
      'T-breakdown': [
        { id: 'attempt-2', workerId: 'W-09', startedAt: '2026-11-02T10:00:00.000Z' },
        { id: 'attempt-1', workerId: 'W-08', startedAt: '2026-11-01T10:00:00.000Z' },
      ],
    },
    store = { projectTasks: () => tasks, attempts: id => [...(attempts[id] || [])] };
  const plan = planStepOf(store, 'project', 'run-idea');
  assert.equal(plan.id, 'T-breakdown');
  assert.equal(plannerOf(store, plan), 'W-09');
  assert.equal(plannerOf(store, { id: 'T-unstarted', workerId: 'W-01' }), 'W-01');
  assert.equal(planStepOf(store, 'project', 'run-without-plan'), null);
});
