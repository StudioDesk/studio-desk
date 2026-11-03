// Rounds of a graph-v2 flow (1.2): a loop that fires runs the same tasks again as their next round, with the findings
// that sent the work back in its direction and its attempts counted per round, and at its limit does what the loop
// says: stop, continue past it, or (by default) ask the director, whose answer decideFlow applies once. The Simulator
// runs every task (a review asks for changes once for a task titled REWORK) and the autonomy policy accepts
// automatically. Model-free: Simulator agents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { GRAPH_V2_SCHEMA } from '../src/core/graph-v2.mjs';
import { buildAttemptHistory } from '../src/core/attempt-history.mjs';
import { startFlow, readFlowGroup, flowRecord, decideFlow } from '../src/core/flow-run.mjs';

// W-02 and W-03 work; W-05 and W-07 review.
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

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-flow-rounds-')),
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
  const created = await c.request('/api/projects', { name: 'Flow rounds' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  c.projectId = created.data.id;
  const saved = await c.request(
    `/api/projects/${c.projectId}/organization`,
    {
      projectId: c.projectId,
      expectedRevision: c.store.setting('project-organization:' + c.projectId).revision,
      ...organization(),
    },
    'PATCH',
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  // The autonomy policy accepts both task types automatically.
  const policy = await c.request(`/api/projects/${c.projectId}/autonomy`, {
    projectId: c.projectId,
    expectedRevision: 0,
    enabled: true,
    retries: 1,
    kinds: {
      'general:work': { approve: 'auto', accept: 'auto' },
      'general:review': { approve: 'auto', accept: 'auto' },
    },
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  assert.equal(policy.status, 200, JSON.stringify(policy.data));
  // Every flow change as the change stream receives it, with the group as that change left it.
  c.changes = [];
  c.snapshots = [];
  const notify = c.store.onChange;
  c.store.onChange = change => {
    c.changes.push(change);
    if (change.type === 'flow') c.snapshots.push(readFlowGroup(c.store, registries, change.id));
    notify(change);
  };
  c.flowChanges = groupId => c.changes.filter(change => change.type === 'flow' && change.id === groupId);
  c.flowEvents = () =>
    c.store
      .activity(c.projectId, { limit: 500 })
      .events.filter(event => event.kind === 'flow')
      .reverse();
  c.flowTasks = groupId => c.store.projectTasks(c.projectId).filter(task => task.flowReference?.group === groupId);
  c.taskOf = (groupId, key) => c.flowTasks(groupId).find(task => task.flowReference.node === key);
  c.group = groupId => readFlowGroup(c.store, registries, groupId);
  c.start = (groupId, graph) =>
    startFlow(c.store, registries, { projectId: c.projectId, groupId, flow: { id: 'flow-guide', revision: 1, graph } });
  c.until = (check, label) =>
    waitFor(check, label, {
      interval: 10,
      detail: () =>
        JSON.stringify(
          c.store
            .projectTasks(c.projectId)
            .map(task => [task.flowReference?.group, task.flowReference?.node, task.status, task.reason]),
        ),
    });
  c.groupState = (groupId, state) =>
    c.until(() => c.group(groupId).state === state && c.group(groupId), `group ${groupId} to be ${state}`);
  return c;
}

// Each flow change raised its group's sequence by exactly one on the change stream, with the group's ID.
function sequencedByOne(c, groupId) {
  const changes = c.flowChanges(groupId),
    sequences = changes.map(change => change.sequence);
  assert.ok(changes.every(change => change.id === groupId && change.projectId === c.projectId));
  assert.deepEqual(
    sequences,
    sequences.map((_, index) => index + 1),
  );
  assert.equal(flowRecord(c.store, groupId).sequence, sequences.length);
  return sequences.length;
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
  owner: { type: 'studio' },
  gate: { rule, reason },
});
const flow = (nodes, edges) => ({ schemaVersion: GRAPH_V2_SCHEMA, nodes, edges });
const rounds = group => Object.fromEntries(group.nodes.map(node => [node.key, [node.round, node.state]]));
// A general work task runs its own stage review after its work stage; these are its work-stage attempts.
const workAttempts = (c, task) => c.store.attempts(task.id).filter(attempt => attempt.assignment.kind === task.kind);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// An outline, then work, a review titled REWORK (it asks for changes once) and an all-pass gate that loops back to
// the work; a loop's target needs an ordinary input, which is the outline.
const reworkLoop = (loop, reviews = [review('review', 'REWORK review of the guide')]) =>
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

// A review that always asks for changes: its first input is an outline outside the loop, which the Simulator always
// reads as a first revision, so every round of the loop needs work again.
const alwaysReworkLoop = loop =>
  flow(
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
      { ...edge('gate', 'work', 'needs-work'), loop },
    ],
  );

test('a loop runs the same work task again as round 2 with the findings, and the flow reaches done', async t => {
  const c = await setup(t),
    { taskIds } = c.start('story-round', reworkLoop({ limit: 2 }));
  const group = await c.groupState('story-round', 'done');
  // The group was sent back while round 2 was pending, with the review's findings.
  const back = c.snapshots.find(snapshot => snapshot.groupId === 'story-round' && snapshot.state === 'sent-back');
  assert.ok(back, 'the group was sent back');
  assert.deepEqual(
    [back.sentBack.from, back.sentBack.to, back.sentBack.outcome, back.sentBack.round, back.sentBack.nextRound],
    ['gate', 'work', 'needs-work', 1, 2],
  );
  assert.deepEqual(
    back.sentBack.findings.map(item => [item.node, item.verdict, item.findings]),
    [['review', 'needs-work', ['Simulated finding: revise once.']]],
  );
  assert.deepEqual(
    [back.nodes.find(node => node.key === 'work').round, back.nodes.find(node => node.key === 'review').state],
    [2, 'waiting'],
  );
  assert.deepEqual(rounds(group), {
    outline: [1, 'accepted'],
    work: [2, 'accepted'],
    review: [2, 'accepted'],
    gate: [2, 'passed'],
    finish: [1, 'accepted'],
  });
  // The same tasks ran again: no new task and no retry copy, just one finish task.
  const tasks = c.flowTasks('story-round');
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every(task => !task.retryOf));
  const workTask = c.taskOf('story-round', 'work'),
    reviewTask = c.taskOf('story-round', 'review');
  // The work's task is the one round 1 created; its ID never changed.
  const created = c.snapshots.find(snapshot => snapshot.groupId === 'story-round' && snapshot.nodes[1].taskId);
  assert.deepEqual([created.nodes[1].key, created.nodes[1].taskId, created.nodes[1].round], ['work', workTask.id, 1]);
  assert.equal(taskIds.length, 1);
  assert.equal(workTask.flowReference.round, 2);
  assert.equal(reviewTask.flowReference.round, 2);
  // The work's round-1 attempt stays on record beside its round-2 attempt, which was accepted.
  const [first, second] = workAttempts(c, workTask);
  assert.equal(workAttempts(c, workTask).length, 2);
  assert.deepEqual([first.flowRound, first.status, second.flowRound, second.status], [1, 'accepted', 2, 'accepted']);
  assert.equal(workTask.acceptedAttemptId, second.id);
  // Round 2's direction carries the review's summary and findings, and its attempt sees round 1 as earlier history.
  const firstReview = c.store.attempts(reviewTask.id)[0];
  assert.equal(firstReview.workReviewVerdict, 'needs-work');
  const direction = second.assignment.direction;
  assert.match(direction, /Round 2: The reviews pass sent this back after round 1\./);
  assert.ok(direction.includes(`REWORK review of the guide (${reviewTask.id}), verdict needs-work`));
  assert.ok(direction.includes(firstReview.result.summary));
  assert.ok(direction.includes('Simulated finding: revise once.'));
  assert.equal(first.assignment.direction, '');
  const history = buildAttemptHistory(c.store, workTask, { attemptId: second.id });
  assert.ok(history.files.some(file => file.path.includes(first.id)));
  // The review ran round 2 against the revised work and passed; the gate's round-1 decision stays on record.
  const reviews = c.store.attempts(reviewTask.id);
  assert.deepEqual(
    reviews.map(attempt => [attempt.flowRound, attempt.workReviewVerdict]),
    [
      [1, 'needs-work'],
      [2, 'pass'],
    ],
  );
  const gateNode = group.nodes.find(node => node.key === 'gate');
  assert.deepEqual([gateNode.decision.round, gateNode.decision.outcome], [2, 'passed']);
  assert.deepEqual(
    gateNode.earlierDecisions.map(decision => [decision.round, decision.outcome]),
    [[1, 'needs-work']],
  );
  assert.equal(group.loops['gate->work'].sendBacks, 1);
  assert.ok(c.taskOf('story-round', 'finish').dependencies.includes(reviewTask.id));
  assert.ok(
    c
      .flowEvents()
      .some(event =>
        /sent the work back to Draft the guide with the findings of 1 input; round 2 starts/.test(event.message),
      ),
  );
  sequencedByOne(c, 'story-round');
});

test('a flow task given one attempt per round attempts again in its next round', async t => {
  const c = await setup(t);
  c.start('story-limit', reworkLoop({ limit: 2 }));
  await c.groupState('story-limit', 'done');
  const workTask = c.taskOf('story-limit', 'work');
  assert.equal(workTask.maxAttempts, 1);
  // Two attempts on record, one per round; only the current round's counts toward the task's one-attempt limit.
  assert.deepEqual(
    workAttempts(c, workTask).map(attempt => attempt.flowRound),
    [1, 2],
  );
  // The work stage's attempts that count toward the limit: only the round's own. Without a flow reference the same
  // attempts would all count, as for any other task.
  const workStage = round => ({
      ...workTask,
      stageState: { ...workTask.stageState, current: 'work' },
      flowReference: round && { ...workTask.flowReference, round },
    }),
    counted = round =>
      c.registries.workflows.stageAttempts(c.store, workStage(round)).map(attempt => attempt.flowRound);
  assert.deepEqual(counted(2), [2]);
  assert.deepEqual(counted(1), [1]);
  assert.deepEqual(counted(null), [1, 2]);
  // Neither attempt was a director's override of the limit.
  assert.ok(c.store.attempts(workTask.id).every(attempt => !attempt.directorOverride));
  sequencedByOne(c, 'story-limit');
});

test("with two reviews asking for changes, the work's next round carries both reviews' findings", async t => {
  const c = await setup(t);
  c.start(
    'story-pair',
    reworkLoop({ limit: 2 }, [
      review('first', 'REWORK review of the guide'),
      review('second', 'REWORK check of the guide', { distinctFrom: ['first'] }),
    ]),
  );
  const group = await c.groupState('story-pair', 'done');
  assert.deepEqual(rounds(group), {
    outline: [1, 'accepted'],
    work: [2, 'accepted'],
    first: [2, 'accepted'],
    second: [2, 'accepted'],
    gate: [2, 'passed'],
    finish: [1, 'accepted'],
  });
  const workTask = c.taskOf('story-pair', 'work'),
    second = workAttempts(c, workTask)[1],
    direction = second.assignment.direction;
  for (const key of ['first', 'second']) {
    const reviewTask = c.taskOf('story-pair', key),
      asked = c.store.attempts(reviewTask.id)[0];
    assert.equal(asked.workReviewVerdict, 'needs-work');
    assert.ok(
      direction.includes(`${reviewTask.title} (${reviewTask.id}), verdict needs-work: ${asked.result.summary}`),
    );
  }
  assert.equal(direction.match(/Simulated finding: revise once\./g).length, 2);
  sequencedByOne(c, 'story-pair');
});

test('a loop at its limit asks the director, who may run another round, accept it over with a reason or stop', async t => {
  const c = await setup(t);
  c.start('story-ask', alwaysReworkLoop({ limit: 1 }));
  c.start('story-stop', alwaysReworkLoop({ limit: 1 }));
  // Round 2 asks for changes again: the loop is at its limit and the director decides; nothing starts.
  let group = await c.until(() => c.group('story-ask').pending && c.group('story-ask'), 'the director decision');
  assert.equal(group.state, 'in-review');
  assert.equal(group.pending.length, 1);
  const [pending] = group.pending;
  assert.deepEqual(
    [pending.node, pending.from, pending.to, pending.round, pending.limit],
    ['gate', 'gate', 'work', 2, 1],
  );
  assert.deepEqual(
    pending.choices.map(choice => choice.id),
    ['another-round', 'accept-over', 'stop'],
  );
  assert.deepEqual(
    pending.findings.map(item => [item.node, item.verdict]),
    [['review', 'needs-work']],
  );
  const workTask = c.taskOf('story-ask', 'work'),
    sequence = group.sequence,
    attempts = c.store.attempts(workTask.id).length;
  assert.equal(workAttempts(c, workTask).length, 2);
  await pause(150);
  assert.equal(c.group('story-ask').sequence, sequence);
  assert.equal(c.store.attempts(workTask.id).length, attempts);
  assert.ok(c.flowTasks('story-ask').every(task => task.status === 'done'));
  assert.equal(c.taskOf('story-ask', 'finish'), undefined);
  const asked = c.flowEvents().find(event => /reached its limit of 1 round\. The director decides/.test(event.message));
  assert.ok(asked, 'the pending decision is a flow event');

  // Another round runs round 3 past the limit, and it asks again.
  const another = decideFlow(c.store, c.registries, 'story-ask', { node: 'gate', choice: 'another-round' });
  assert.deepEqual(another.taskIds, [workTask.id]);
  await c.until(
    () => c.group('story-ask').pending?.[0]?.round === 3 && c.group('story-ask'),
    'the loop to reach its limit again in round 3',
  );
  assert.deepEqual(
    workAttempts(c, workTask).map(attempt => attempt.flowRound),
    [1, 2, 3],
  );
  assert.equal(c.group('story-ask').loops['gate->work'].sendBacks, 2);

  // Accepting over the findings needs a reason, and a refusal writes nothing.
  const before = c.group('story-ask').sequence;
  assert.throws(
    () => decideFlow(c.store, c.registries, 'story-ask', { node: 'gate', choice: 'accept-over' }),
    /needs a reason/,
  );
  assert.throws(
    () => decideFlow(c.store, c.registries, 'story-ask', { node: 'gate', choice: 'accept-over', reason: '  ' }),
    /needs a reason/,
  );
  assert.equal(c.group('story-ask').sequence, before);
  decideFlow(c.store, c.registries, 'story-ask', {
    node: 'gate',
    choice: 'accept-over',
    reason: 'The outline is out of scope for this guide.',
  });
  group = await c.groupState('story-ask', 'done');
  const gateNode = group.nodes.find(node => node.key === 'gate');
  assert.deepEqual(
    [gateNode.decision.round, gateNode.decision.outcome, gateNode.decision.over.by, gateNode.decision.over.reason],
    [3, 'passed', 'director', 'The outline is out of scope for this guide.'],
  );
  assert.equal(c.taskOf('story-ask', 'finish').status, 'done');
  assert.deepEqual(
    group.directorDecisions.map(decision => [decision.round, decision.choice]),
    [
      [2, 'another-round'],
      [3, 'accept-over'],
    ],
  );
  // A decision already made is refused.
  assert.throws(
    () => decideFlow(c.store, c.registries, 'story-ask', { node: 'gate', choice: 'stop' }),
    /already decided to accept it over the findings/,
  );
  sequencedByOne(c, 'story-ask');

  // Stop records the group stopped, starts nothing, and is made once.
  await c.until(() => c.group('story-stop').pending, 'the director decision');
  const stopped = decideFlow(c.store, c.registries, 'story-stop', {
    node: 'gate',
    choice: 'stop',
    reason: 'Rescope the guide instead.',
  });
  assert.deepEqual(stopped.taskIds, []);
  group = c.group('story-stop');
  assert.equal(group.state, 'stopped');
  assert.deepEqual(
    [group.stopped.by, group.stopped.node, group.stopped.round, group.stopped.reason],
    ['director', 'gate', 2, 'Rescope the guide instead.'],
  );
  assert.equal(group.pending, undefined);
  assert.throws(
    () => decideFlow(c.store, c.registries, 'story-stop', { node: 'gate', choice: 'another-round' }),
    /already decided to stop/,
  );
  await pause(100);
  assert.equal(c.taskOf('story-stop', 'finish'), undefined);
  assert.equal(c.group('story-stop').sequence, group.sequence);
  sequencedByOne(c, 'story-stop');
});

test('a loop whose atLimit is stop stops the flow, and one whose atLimit is continue passes the gate', async t => {
  const c = await setup(t);
  c.start('story-halt', alwaysReworkLoop({ limit: 1, atLimit: 'stop' }));
  c.start('story-on', alwaysReworkLoop({ limit: 1, atLimit: 'continue' }));
  const halted = await c.groupState('story-halt', 'stopped');
  assert.deepEqual([halted.stopped.by, halted.stopped.node, halted.stopped.round], ['loop', 'gate', 2]);
  assert.equal(halted.pending, undefined);
  assert.equal(c.taskOf('story-halt', 'finish'), undefined);
  assert.throws(
    () => decideFlow(c.store, c.registries, 'story-halt', { node: 'gate', choice: 'another-round' }),
    /Nothing at The reviews pass waits/,
  );
  const on = await c.groupState('story-on', 'done'),
    gateNode = on.nodes.find(node => node.key === 'gate');
  assert.deepEqual(
    [gateNode.decision.round, gateNode.decision.outcome, gateNode.decision.over.by],
    [2, 'passed', 'loop'],
  );
  assert.match(gateNode.decision.over.note, /reached its limit of 1 round; the flow continues past it/);
  assert.equal(c.taskOf('story-on', 'finish').status, 'done');
  assert.equal(on.pending, undefined);
  assert.ok(c.flowEvents().some(event => /the flow continues past it, as the loop says/.test(event.message)));
  assert.ok(c.flowEvents().some(event => /the flow stopped, as the loop says/.test(event.message)));
  sequencedByOne(c, 'story-halt');
  sequencedByOne(c, 'story-on');
});
