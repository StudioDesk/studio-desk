// A graph-v2 flow across a controller restart (1.2): each scenario closes the studio mid-flow and opens a new store
// and orchestrator on the same database file. Recovery (recoverFlows) compares each node with its task: work that
// settled is followed once, interrupted work waits for Reconcile as any task does, a gate decided for its round is
// never decided again, a pending director decision stays pending, no task is created twice and no attempt is started.
// readFlowGroup lists each node in the graph's order with its state, round and the actions the director may take now.
// Model-free: Simulator agents only; a review titled REWORK asks for changes once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { GRAPH_V2_SCHEMA } from '../src/core/graph-v2.mjs';
import { attemptResource } from '../src/core/store.mjs';
import { startFlow, readFlowGroup, flowRecord, decideFlow, stopFlow } from '../src/core/flow-run.mjs';

const organization = () => ({
  teams: [
    { id: 'writing', name: 'Writing', purpose: 'Bounded general work.' },
    { id: 'checking', name: 'Checking', purpose: 'Independent reviews.' },
  ],
  members: [
    ['W-02', 'writing', 'Writer', ['worker']],
    ['W-03', 'writing', 'Writer', ['worker']],
    ['W-05', 'checking', 'Editor', ['reviewer']],
    ['W-07', 'checking', 'Editor', ['reviewer']],
  ].map(([workerId, teamId, role, roles]) => ({
    workerId,
    teamId,
    role,
    responsibility: 'Bounded general work.',
    roles,
  })),
  taskKinds: ['general:work', 'general:review'],
  kindOwners: {},
});

// Opens a studio on the scenario's folder, as starting the controller does.
async function open(c) {
  c.registries = createRegistries();
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { registries: c.registries } });
  c.store = c.app.store;
  c.origin = await c.app.start();
  c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
}

// Closes the studio mid-flow and opens a new store and orchestrator on the same database file.
async function restart(c) {
  await c.app.close();
  c.app = null;
  await open(c);
}

// `reviewAccept` is how the review task type is accepted: by the director (the review waits in Review) or auto.
async function setup(t, reviewAccept = 'director') {
  const c = { directory: fs.mkdtempSync(path.join(os.tmpdir(), 'studio-flow-restart-')) },
    delay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '15';
  t.after(async () => {
    await c.app?.close();
    fs.rmSync(c.directory, { recursive: true, force: true });
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
  });
  await open(c);
  c.request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.ok = async (url, data = {}, method = 'POST') => {
    const answer = await c.request(url, { projectId: c.projectId, ...data }, method);
    assert.ok(answer.status < 300, `${url}: ${JSON.stringify(answer.data)}`);
    return answer.data;
  };
  const created = await c.request('/api/projects', { name: 'Flow restart' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  c.projectId = created.data.id;
  await c.ok(
    `/api/projects/${c.projectId}/organization`,
    { expectedRevision: c.store.setting('project-organization:' + c.projectId).revision, ...organization() },
    'PATCH',
  );
  await c.ok(`/api/projects/${c.projectId}/autonomy`, {
    expectedRevision: 0,
    enabled: true,
    retries: 1,
    kinds: {
      'general:work': { approve: 'auto', accept: 'auto' },
      'general:review': { approve: 'auto', accept: reviewAccept },
    },
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  c.flowEvents = groupId =>
    c.store
      .activity(c.projectId, { limit: 500 })
      .events.filter(event => event.kind === 'flow')
      .reverse()
      .filter(event => !groupId || flowRecord(c.store, groupId));
  c.flowTasks = groupId => c.store.projectTasks(c.projectId).filter(task => task.flowReference?.group === groupId);
  c.taskOf = (groupId, key) => c.flowTasks(groupId).find(task => task.flowReference.node === key);
  c.group = groupId => readFlowGroup(c.store, c.registries, groupId);
  c.start = (groupId, graph) =>
    startFlow(c.store, c.registries, {
      projectId: c.projectId,
      groupId,
      flow: { id: 'flow-guide', revision: 1, graph },
    });
  c.until = (check, label) =>
    waitFor(check, label, {
      interval: 10,
      detail: () =>
        JSON.stringify(
          c.store
            .projectTasks(c.projectId)
            .map(task => [task.flowReference?.node, task.flowReference?.round, task.status, task.reason]),
        ),
    });
  c.groupState = (groupId, state) =>
    c.until(() => c.group(groupId).state === state && c.group(groupId), `group ${groupId} to be ${state}`);
  c.resume = () => c.ok('/api/pipeline', { action: 'resume' });
  // Accepts every flow task that waits in Review (a work task's own stage review included) except the nodes held, until
  // the check holds; the held reviews stay in Review for the scenario.
  c.drive = async (groupId, check, label, held = []) => {
    const deadline = Date.now() + 60000;
    for (;;) {
      const done = check();
      if (done) return done;
      for (const task of c.flowTasks(groupId))
        if (task.status === 'review' && !held.includes(task.flowReference.node))
          await c.ok(`/api/tasks/${task.id}/accept`);
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await pause(10);
    }
  };
  c.inReview = (groupId, keys) =>
    c.drive(
      groupId,
      () => keys.every(key => c.taskOf(groupId, key)?.status === 'review'),
      keys.join(' and ') + ' in Review',
      keys,
    );
  c.done = groupId => c.drive(groupId, () => c.group(groupId).state === 'done' && c.group(groupId), groupId + ' done');
  return c;
}

const agentNode = (key, kind, owner, title, fields = {}) => ({
  key,
  title,
  kind,
  owner,
  brief: 'Bounded general work.',
  acceptance: 'Return checked evidence.',
  maxSeconds: 30,
  maxAttempts: 1,
  ...fields,
});
const role = id => ({ type: 'role', id });
const edge = (from, to, outcome = 'accepted') => ({ from, to, outcome });
const work = (key, title, fields) => agentNode(key, 'general:work', role('worker'), title, fields);
const review = (key, title, fields) => agentNode(key, 'general:review', role('reviewer'), title, fields);
const gate = (rule = 'all-pass', reason = 'The independent reviews must pass.') => ({
  key: 'gate',
  title: 'The reviews pass',
  kind: 'gate',
  owner: { type: rule === 'director' ? 'director' : 'studio' },
  gate: { rule, reason },
});
const flow = (nodes, edges) => ({ schemaVersion: GRAPH_V2_SCHEMA, nodes, edges });
// Each node in the graph's order with its round, state and the keys of its actions.
const view = group => group.nodes.map(node => [node.key, node.round, node.state, node.actions.map(item => item.key)]);
const decisionEvents = (c, pattern) => c.flowEvents().filter(event => pattern.test(event.message));
const recoveryEvents = c => c.flowEvents().filter(event => /^After the controller started again: /.test(event.message));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Work, then its reviews, an all-pass gate and the finish; `loop` adds the gate's loop back to the work.
const reviewed = (reviews, loop = { limit: 2 }) =>
  flow(
    [
      work('outline', 'Outline the guide'),
      work('work', 'Draft the guide'),
      ...reviews,
      gate(),
      work('finish', 'Publish the guide'),
    ],
    [
      edge('outline', 'work'),
      ...reviews.map(item => edge('work', item.key)),
      ...reviews.map(item => edge(item.key, 'gate')),
      edge('gate', 'finish', 'passed'),
      { ...edge('gate', 'work', 'needs-work'), loop },
    ],
  );

test('a straight flow restarted while its review is in Review decides its gate once after acceptance', async t => {
  const c = await setup(t);
  c.start('story-straight', reviewed([review('review', 'Review of the guide')]));
  await c.inReview('story-straight', ['review']);
  const before = flowRecord(c.store, 'story-straight').sequence,
    reviewId = c.taskOf('story-straight', 'review').id;
  assert.deepEqual(view(c.group('story-straight')), [
    ['outline', 1, 'accepted', []],
    ['work', 1, 'accepted', []],
    ['review', 1, 'review', ['accept', 'revise']],
    ['gate', 0, 'waiting', []],
    ['finish', 0, 'waiting', []],
  ]);
  await restart(c);
  // Nothing settled while it was stopped: recovery writes nothing and the gate is still undecided.
  let group = c.group('story-straight');
  assert.equal(group.sequence, before);
  assert.equal(recoveryEvents(c).length, 0);
  assert.equal(group.nodes.find(node => node.key === 'gate').decision, null);
  assert.equal(c.store.task(reviewId).status, 'review');
  assert.deepEqual(
    group.actions.map(item => [item.key, item.operation]),
    [['stop', 'stopFlow']],
  );
  const accept = group.nodes.find(node => node.key === 'review').actions.find(item => item.key === 'accept');
  assert.deepEqual([accept.method, accept.path], ['POST', `/api/tasks/${reviewId}/accept`]);
  await c.ok(accept.path);
  group = c.group('story-straight');
  assert.deepEqual([group.nodes[3].decision.round, group.nodes[3].decision.outcome], [1, 'passed']);
  await c.resume();
  group = await c.done('story-straight');
  assert.deepEqual(view(group), [
    ['outline', 1, 'accepted', []],
    ['work', 1, 'accepted', []],
    ['review', 1, 'accepted', []],
    ['gate', 1, 'passed', []],
    ['finish', 1, 'accepted', []],
  ]);
  assert.deepEqual(group.actions, []);
  assert.equal(decisionEvents(c, /The reviews pass passed by the all-pass rule/).length, 1);
  assert.equal(c.flowTasks('story-straight').length, 4);
});

test('a send-back restarted before round 2 runs round 2 once and records no second send-back', async t => {
  const c = await setup(t);
  c.start('story-back', reviewed([review('review', 'REWORK review of the guide')], { limit: 2 }));
  await c.inReview('story-back', ['review']);
  // The pipeline waits, so round 2 is recorded but not started when the controller stops.
  await c.ok('/api/pipeline', { action: 'pause' });
  await c.ok(`/api/tasks/${c.taskOf('story-back', 'review').id}/accept`);
  const workTask = c.taskOf('story-back', 'work');
  assert.equal(workTask.flowReference.round, 2);
  assert.equal(c.group('story-back').state, 'sent-back');
  const before = flowRecord(c.store, 'story-back').sequence,
    attempts = c.store.attempts(workTask.id).length;
  await restart(c);
  let group = c.group('story-back');
  assert.equal(group.sequence, before);
  assert.deepEqual(view(group).slice(0, 4), [
    ['outline', 1, 'accepted', []],
    ['work', 2, 'ready', ['start']],
    ['review', 2, 'waiting', []],
    ['gate', 2, 'waiting', []],
  ]);
  assert.equal(c.store.attempts(workTask.id).length, attempts);
  await c.resume();
  group = await c.done('story-back');
  // One task for the work, run in round 2 once, with the findings in its direction.
  const works = c.flowTasks('story-back').filter(task => task.flowReference.node === 'work');
  assert.equal(works.length, 1);
  const rounds = c.store
    .attempts(workTask.id)
    .filter(attempt => attempt.assignment.kind === 'general:work')
    .map(attempt => attempt.flowRound);
  assert.deepEqual(rounds, [1, 2]);
  assert.match(c.store.task(workTask.id).direction ?? '', /Round 2: The reviews pass sent this back after round 1/);
  assert.equal(group.loops['gate->work'].sendBacks, 1);
  assert.equal(decisionEvents(c, /sent the work back to Draft the guide/).length, 1);
  assert.deepEqual(
    group.nodes.find(node => node.key === 'gate').earlierDecisions.map(item => [item.round, item.outcome]),
    [[1, 'needs-work']],
  );
  assert.equal(c.taskOf('story-back', 'finish').status, 'done');
});

test('two reviews restarted after the first passed: the gate waits for the second and decides once', async t => {
  const c = await setup(t);
  c.start(
    'story-pair',
    reviewed([
      review('first', 'Review of the guide'),
      review('second', 'Check of the guide', { distinctFrom: ['first'] }),
    ]),
  );
  await c.inReview('story-pair', ['first', 'second']);
  await c.ok(`/api/tasks/${c.taskOf('story-pair', 'first').id}/accept`);
  await restart(c);
  let group = c.group('story-pair');
  assert.deepEqual(view(group).slice(2, 4), [
    ['first', 1, 'accepted', []],
    ['second', 1, 'review', ['accept', 'revise']],
  ]);
  assert.equal(group.nodes[4].decision, null);
  assert.equal(recoveryEvents(c).length, 0);
  await c.ok(`/api/tasks/${c.taskOf('story-pair', 'second').id}/accept`);
  await c.resume();
  group = await c.done('story-pair');
  assert.deepEqual([group.nodes[4].round, group.nodes[4].state], [1, 'passed']);
  assert.equal(decisionEvents(c, /The reviews pass passed by the all-pass rule/).length, 1);
});

test('a loop at its limit restarted while the director decides is still pending, and decideFlow works after', async t => {
  const c = await setup(t, 'auto');
  // The review always asks for changes: its first input is an outline outside the loop.
  const graph = flow(
    [
      work('outline', 'Outline the guide'),
      work('work', 'Draft the guide'),
      review('review', 'REWORK review of the outline and draft'),
      gate(),
      work('finish', 'Publish the guide'),
    ],
    [
      edge('outline', 'work'),
      edge('outline', 'review'),
      edge('work', 'review'),
      edge('review', 'gate'),
      edge('gate', 'finish', 'passed'),
      { ...edge('gate', 'work', 'needs-work'), loop: { limit: 1 } },
    ],
  );
  c.start('story-ask', graph);
  await c.until(() => c.group('story-ask').pending, 'the director decision');
  const before = flowRecord(c.store, 'story-ask').sequence,
    tasks = c.flowTasks('story-ask').length;
  await restart(c);
  let group = c.group('story-ask');
  assert.equal(group.sequence, before);
  assert.equal(group.state, 'in-review');
  assert.deepEqual(
    group.pending.map(item => [item.node, item.round, item.choices.map(choice => choice.id)]),
    [['gate', 2, ['another-round', 'accept-over', 'stop']]],
  );
  const gateNode = group.nodes.find(node => node.key === 'gate');
  assert.deepEqual(
    gateNode.actions.map(item => [item.key, item.operation, item.fields.find(f => f.name === 'reason').required]),
    [
      ['another-round', 'decideFlow', false],
      ['accept-over', 'decideFlow', true],
      ['stop', 'decideFlow', false],
    ],
  );
  await pause(100);
  assert.equal(c.flowTasks('story-ask').length, tasks);
  assert.equal(c.taskOf('story-ask', 'finish'), undefined);
  decideFlow(c.store, c.registries, 'story-ask', {
    node: 'gate',
    choice: 'accept-over',
    reason: 'The outline is out of scope for this guide.',
  });
  group = await c.groupState('story-ask', 'done');
  assert.deepEqual(group.nodes.at(-1).actions, []);
  assert.deepEqual(
    group.directorDecisions.map(item => [item.round, item.choice]),
    [[2, 'accept-over']],
  );
  assert.throws(
    () => decideFlow(c.store, c.registries, 'story-ask', { node: 'gate', choice: 'stop' }),
    /already decided/,
  );
});

test('a skipped node stays skipped with its reason after a restart and is never created', async t => {
  const c = await setup(t, 'auto');
  // The review passes, so the edge that waits for needs-work can no longer fire.
  c.start(
    'story-skip',
    flow(
      [
        work('work', 'Draft the guide'),
        review('review', 'Review of the guide'),
        work('fix', 'Fix the guide'),
        work('publish', 'Publish the guide'),
      ],
      [edge('work', 'review'), edge('review', 'fix', 'needs-work'), edge('review', 'publish', 'passed')],
    ),
  );
  let group = await c.groupState('story-skip', 'done');
  const reason = group.nodes.find(node => node.key === 'fix').reason;
  assert.match(reason, /waits for needs-work/);
  await restart(c);
  group = c.group('story-skip');
  assert.deepEqual(view(group), [
    ['work', 1, 'accepted', []],
    ['review', 1, 'accepted', []],
    ['fix', 0, 'skipped', []],
    ['publish', 1, 'accepted', []],
  ]);
  assert.equal(group.nodes[2].reason, reason);
  assert.equal(c.taskOf('story-skip', 'fix'), undefined);
  assert.equal(recoveryEvents(c).length, 0);
});

test('a restart while an attempt runs leaves the task interrupted and the flow waits until it settles', async t => {
  const c = await setup(t, 'auto');
  const {
    taskIds: [taskId],
  } = c.start(
    'story-run',
    flow([work('work', 'Draft the guide'), review('review', 'Review of the guide')], [edge('work', 'review')]),
  );
  // The controller stops while the work's attempt runs: its records say running, as a crash leaves them.
  const attemptId = 'attempt-flow-restart-running',
    task = c.store.task(taskId);
  c.store.tx(() => {
    Object.assign(task, { status: 'running', queued: false, lastAttemptId: attemptId });
    c.store.putTask(task);
    c.store.insertAttempt(
      {
        id: attemptId,
        taskId,
        projectId: c.projectId,
        workerId: task.workerId,
        provider: 'simulator',
        status: 'running',
        assignment: { kind: task.kind, taskId },
        startedAt: new Date().toISOString(),
        artifacts: [],
        inputReferences: [],
        pid: null,
      },
      { hash: 'snapshot', text: 'Instructions.' },
    );
    c.store.claim([attemptResource(attemptId)], attemptId);
  });
  const before = flowRecord(c.store, 'story-run').sequence;
  await restart(c);
  assert.equal(c.store.attempt(attemptId).status, 'interrupted');
  assert.equal(c.store.task(taskId).status, 'blocked');
  let group = c.group('story-run');
  assert.equal(group.sequence, before);
  assert.deepEqual(view(group), [
    ['work', 1, 'ready', ['reconcile']],
    ['review', 0, 'waiting', []],
  ]);
  assert.deepEqual(
    group.actions.map(item => item.key),
    ['stop'],
  );
  await pause(100);
  assert.equal(c.store.attempts(taskId).length, 1);
  assert.equal(c.taskOf('story-run', 'review'), undefined);
  assert.equal(flowRecord(c.store, 'story-run').sequence, before);
  // The director reconciles it and queues it again; the flow advances once the task settles.
  await c.ok(`/api/tasks/${taskId}/reconcile`);
  assert.deepEqual(view(c.group('story-run'))[0], ['work', 1, 'ready', ['start']]);
  await c.ok('/api/pipeline', { action: 'queue', taskIds: [taskId] });
  group = await c.groupState('story-run', 'done');
  assert.deepEqual(view(group), [
    ['work', 1, 'accepted', []],
    ['review', 1, 'accepted', []],
  ]);
});

test('recovery follows a task that settled while its flow was not advanced, once', async t => {
  const c = await setup(t);
  c.start('story-missed', reviewed([review('review', 'Review of the guide')]));
  await c.inReview('story-missed', ['review']);
  await c.ok('/api/pipeline', { action: 'pause' });
  // The review's acceptance is recorded without its flow advancing, as a stop between the two would leave it.
  const reviewTask = c.taskOf('story-missed', 'review'),
    attempt = c.store.attempt(reviewTask.lastAttemptId);
  const before = flowRecord(c.store, 'story-missed').sequence;
  await c.app.close();
  c.app = null;
  // With the controller stopped, settle the review in the records only.
  {
    const studio = createStudio({ directory: c.directory, port: 0, runnerOptions: { registries: createRegistries() } });
    studio.store.tx(() => {
      const stored = studio.store.task(reviewTask.id),
        recorded = studio.store.attempt(attempt.id);
      recorded.status = 'accepted';
      studio.store.updateAttempt(recorded);
      Object.assign(stored, { status: 'done', acceptedAttemptId: attempt.id, queued: false });
      studio.store.putTask(stored);
    });
    await studio.close();
  }
  await open(c);
  const group = c.group('story-missed');
  // The restart that opened this store followed the settled review once: the gate decided and the finish was created.
  assert.ok(group.sequence > before);
  assert.equal(recoveryEvents(c).length, 1);
  assert.match(recoveryEvents(c)[0].message, /Review of the guide passed its review\..*The reviews pass passed/);
  assert.deepEqual(view(group).slice(2, 5), [
    ['review', 1, 'accepted', []],
    ['gate', 1, 'passed', []],
    ['finish', 1, 'ready', ['start']],
  ]);
  // Another restart changes nothing: the gate is not decided again and no task is created twice.
  const sequence = group.sequence,
    count = c.flowTasks('story-missed').length;
  await restart(c);
  assert.equal(c.group('story-missed').sequence, sequence);
  assert.equal(c.flowTasks('story-missed').length, count);
  assert.equal(recoveryEvents(c).length, 1);
  assert.equal(decisionEvents(c, /The reviews pass passed by the all-pass rule/).length, 1);
  // The director stops the flow; it is stopped once and then offers nothing.
  stopFlow(c.store, c.registries, 'story-missed', { reason: 'Enough for now.' });
  assert.equal(c.group('story-missed').state, 'stopped');
  assert.deepEqual(c.group('story-missed').actions, []);
  assert.ok(c.group('story-missed').nodes.every(node => !node.actions.length));
  assert.throws(() => stopFlow(c.store, c.registries, 'story-missed'), /already stopped/);
});

test('a director gate offers pass and send back, decides once, and still offers them after a restart', async t => {
  const c = await setup(t, 'auto');
  c.start(
    'story-director',
    flow(
      [
        work('outline', 'Outline the guide'),
        work('work', 'Draft the guide'),
        review('review', 'Review of the guide'),
        gate('director', 'The director reads the guide.'),
        work('finish', 'Publish the guide'),
      ],
      [
        edge('outline', 'work'),
        edge('work', 'review'),
        edge('review', 'gate'),
        edge('gate', 'finish', 'passed'),
        { ...edge('gate', 'work', 'needs-work'), loop: { limit: 2 } },
      ],
    ),
  );
  await c.until(() => c.group('story-director').nodes[3].state === 'director', 'the director gate');
  await restart(c);
  let group = c.group('story-director');
  assert.equal(group.nodes[3].decision.state, 'pending');
  assert.deepEqual(
    group.nodes[3].actions.map(item => [item.key, item.operation]),
    [
      ['pass', 'decideFlow'],
      ['send-back', 'decideFlow'],
    ],
  );
  decideFlow(c.store, c.registries, 'story-director', { node: 'gate', choice: 'pass', reason: 'Reads well.' });
  assert.throws(
    () => decideFlow(c.store, c.registries, 'story-director', { node: 'gate', choice: 'send-back' }),
    /already decided passed in round 1/,
  );
  await c.resume();
  group = await c.groupState('story-director', 'done');
  assert.deepEqual(
    [group.nodes[3].state, group.nodes[3].decision.director.choice, group.nodes[3].decision.director.reason],
    ['passed', 'pass', 'Reads well.'],
  );
});
