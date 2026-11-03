// Advancing a graph-v2 flow (1.2): when a flow's task settles, the controller follows the edges its outcome matches in
// the same transaction, starts each node whose inputs all fired, decides gates without any task or attempt, records a
// node that can no longer run as skipped with its reason, and stops where a loop edge fires until the rounds step.
// The Simulator runs every task and the autonomy policy accepts automatically. Model-free: Simulator agents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { GRAPH_V2_SCHEMA } from '../src/core/graph-v2.mjs';
import { startFlow, readFlowGroup, flowRecord } from '../src/core/flow-run.mjs';

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-flow-advance-')),
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
  const created = await c.request('/api/projects', { name: 'Flow advance' });
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
  // Every flow change as the change stream receives it, with the flow record as that change wrote it.
  c.changes = [];
  c.snapshots = [];
  const notify = c.store.onChange;
  c.store.onChange = change => {
    c.changes.push(change);
    if (change.type === 'flow') c.snapshots.push(structuredClone(c.store.setting('flow:' + change.id)));
    notify(change);
  };
  c.flowChanges = groupId => c.changes.filter(change => change.type === 'flow' && change.id === groupId);
  c.flowEvents = () =>
    c.store
      .activity(c.projectId, { limit: 200 })
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
          c.store.projectTasks(c.projectId).map(task => [task.flowReference?.node, task.status, task.reason]),
        ),
    });
  c.groupState = (groupId, state) =>
    c.until(() => c.group(groupId).state === state && c.group(groupId), `group ${groupId} to be ${state}`);
  return c;
}

// Each flow change raised the group's sequence by exactly one on the change stream, with one flow event each.
function sequencedByOne(c, groupId) {
  const sequences = c.flowChanges(groupId).map(change => change.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_, index) => index + 1),
  );
  assert.equal(flowRecord(c.store, groupId).sequence, sequences.length);
  assert.equal(c.flowEvents().length, sequences.length);
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
const gate = (rule, reason = 'The independent reviews must pass.') => ({
  key: 'gate',
  title: 'The reviews pass',
  kind: 'gate',
  owner: { type: rule === 'director' ? 'director' : 'studio' },
  gate: { rule, reason },
});
const flow = (nodes, edges) => ({ schemaVersion: GRAPH_V2_SCHEMA, nodes, edges });
const nodeStates = group => Object.fromEntries(group.nodes.map(node => [node.key, node.state]));

test('a straight flow runs to done: each node starts once its input is accepted and the gate holds no task', async t => {
  const c = await setup(t),
    { taskIds } = c.start(
      'story-straight',
      flow(
        [
          work('work', 'Draft the guide'),
          review('review', 'Review the guide'),
          gate('all-pass'),
          work('finish', 'Publish the guide'),
          work('revise', 'Revise the guide'),
        ],
        [
          edge('work', 'review'),
          edge('review', 'gate'),
          edge('gate', 'finish', 'passed'),
          edge('gate', 'revise', 'needs-work'),
        ],
      ),
    );
  assert.equal(c.flowTasks('story-straight').length, 1);
  const group = await c.groupState('story-straight', 'done');
  assert.deepEqual(nodeStates(group), {
    work: 'accepted',
    review: 'accepted',
    gate: 'passed',
    finish: 'accepted',
    revise: 'skipped',
  });
  const [workTask, reviewTask, finishTask] = ['work', 'review', 'finish'].map(key => c.taskOf('story-straight', key));
  assert.equal(workTask.id, taskIds[0]);
  // The review was created in the write that recorded the work accepted, and depends on it; it was never there before.
  const firstWithReview = c.snapshots.findIndex(record => record.nodes.review.taskId);
  assert.ok(firstWithReview > 0);
  assert.equal(c.snapshots[firstWithReview - 1].nodes.review.taskId, null);
  assert.deepEqual(c.snapshots[firstWithReview].nodes.work.outcomes, ['accepted']);
  assert.deepEqual(reviewTask.dependencies, [workTask.id]);
  assert.ok(Date.parse(reviewTask.createdAt) >= Date.parse(c.store.attempt(workTask.acceptedAttemptId).acceptedAt));
  assert.deepEqual(reviewTask.flowReference, {
    flowId: 'flow-guide',
    revision: 1,
    node: 'review',
    round: 1,
    group: 'story-straight',
  });
  // The review is independent of the work's author.
  assert.notEqual(reviewTask.workerId, c.store.attempt(workTask.acceptedAttemptId).workerId);
  // The gate is decided by the controller: recorded on the group and in a flow event, with no task and no attempt.
  const gateNode = group.nodes.find(node => node.key === 'gate');
  assert.equal(gateNode.taskId, null);
  assert.deepEqual(
    [gateNode.decision.rule, gateNode.decision.state, gateNode.decision.outcome],
    ['all-pass', 'decided', 'passed'],
  );
  assert.deepEqual(gateNode.decision.inputs, [{ node: 'review', taskId: reviewTask.id, passed: true }]);
  assert.equal(c.flowTasks('story-straight').length, 3);
  assert.ok(c.flowTasks('story-straight').every(task => task.flowReference.node !== 'gate'));
  const attempts = c.flowTasks('story-straight').flatMap(task => c.store.attempts(task.id));
  assert.ok(
    attempts.every(attempt => ['work', 'review', 'finish'].includes(c.store.task(attempt.taskId).flowReference.node)),
  );
  const decided = c.flowEvents().find(event => /The reviews pass passed/.test(event.message));
  assert.ok(decided, 'the gate decision is a flow event');
  assert.match(decided.message, /The reviews pass passed by the all-pass rule: 1 of 1 review passed\./);
  assert.match(decided.message, /Publish the guide can start now\./);
  // The finish node depends on the review the gate passed; the needs-work branch was skipped with its reason.
  assert.deepEqual(finishTask.dependencies, [reviewTask.id]);
  assert.equal(finishTask.status, 'done');
  assert.equal(
    group.nodes.find(node => node.key === 'revise').reason,
    'The edge gate → revise waits for needs-work, and The reviews pass decided passed.',
  );
  // Start, work accepted, review passed with the gate, finish accepted: four changes, each raising the sequence by one.
  assert.equal(sequencedByOne(c, 'story-straight'), 4);
  assert.equal(group.sequence, 4);
});

test('two reviews side by side start together, and an all-pass gate waits for the second', async t => {
  const c = await setup(t);
  c.start(
    'story-pair',
    flow(
      [
        work('work', 'Draft the guide'),
        review('first', 'Review the guide'),
        review('second', 'Check the guide again', { distinctFrom: ['first'] }),
        gate('all-pass'),
        work('finish', 'Publish the guide'),
        work('revise', 'Revise the guide'),
      ],
      [
        edge('work', 'first'),
        edge('work', 'second'),
        edge('first', 'gate'),
        edge('second', 'gate'),
        edge('gate', 'finish', 'passed'),
        edge('gate', 'revise', 'needs-work'),
      ],
    ),
  );
  const group = await c.groupState('story-pair', 'done');
  assert.deepEqual(nodeStates(group), {
    work: 'accepted',
    first: 'accepted',
    second: 'accepted',
    gate: 'passed',
    finish: 'accepted',
    revise: 'skipped',
  });
  // Both reviews were created by the same write, by different reviewers.
  const created = c.snapshots.findIndex(record => record.nodes.first.taskId || record.nodes.second.taskId);
  assert.ok(c.snapshots[created].nodes.first.taskId && c.snapshots[created].nodes.second.taskId);
  const [first, second] = ['first', 'second'].map(key => c.taskOf('story-pair', key));
  assert.notEqual(first.workerId, second.workerId);
  // Its separation from the first review, and its independence from the work's author.
  const author = c.store.attempt(c.taskOf('story-pair', 'work').acceptedAttemptId).workerId;
  assert.deepEqual(new Set(second.staffing.exclude), new Set([first.workerId, author]));
  // The write that recorded the first review settled left the gate undecided; the second one decided it.
  const settled = record => ['first', 'second'].filter(key => record.nodes[key].outcomes).length;
  const one = c.snapshots.find(record => settled(record) === 1),
    both = c.snapshots.find(record => settled(record) === 2);
  assert.ok(one && both);
  assert.equal(one.nodes.gate.decision, undefined);
  assert.equal(one.nodes.finish.taskId, null);
  assert.equal(both.nodes.gate.decision.outcome, 'passed');
  assert.ok(both.nodes.finish.taskId);
  assert.equal(c.snapshots.indexOf(both), c.snapshots.indexOf(one) + 1);
  sequencedByOne(c, 'story-pair');
});

test('an any-pass gate passes once both reviews settle and one passed, and the review asking for changes sends nothing back', async t => {
  const c = await setup(t);
  c.start(
    'story-any',
    flow(
      [
        work('work', 'Draft the guide'),
        review('first', 'Review the guide'),
        review('second', 'REWORK review of the guide'),
        gate('any-pass', 'One independent review must pass.'),
        work('finish', 'Publish the guide'),
        work('revise', 'Revise the guide'),
      ],
      [
        edge('work', 'first'),
        edge('work', 'second'),
        edge('first', 'gate'),
        edge('second', 'gate'),
        edge('gate', 'finish', 'passed'),
        edge('gate', 'revise', 'needs-work'),
      ],
    ),
  );
  const group = await c.groupState('story-any', 'done'),
    gateNode = group.nodes.find(node => node.key === 'gate');
  assert.deepEqual([gateNode.decision.rule, gateNode.decision.outcome], ['any-pass', 'passed']);
  const second = c.taskOf('story-any', 'second'),
    secondAttempt = c.store.attempt(second.acceptedAttemptId);
  assert.equal(secondAttempt.workReviewVerdict, 'needs-work');
  assert.match(secondAttempt.acceptedBy.reason, /^Recorded as evidence\./);
  assert.deepEqual(
    gateNode.decision.inputs.map(input => [input.node, input.passed]),
    [
      ['first', true],
      ['second', false],
    ],
  );
  // The gate was decided only in the write where the last of the two reviews settled.
  const decidedAt = c.snapshots.find(record => record.nodes.gate.decision);
  assert.ok(decidedAt.nodes.first.outcomes && decidedAt.nodes.second.outcomes);
  assert.ok(c.flowEvents().some(event => /passed by the any-pass rule: 1 of 2 reviews passed\./.test(event.message)));
  // The autonomy policy did not send the work back on the review's own say: no retry task, nothing redone.
  const tasks = c.store.projectTasks(c.projectId);
  assert.equal(tasks.length, 4);
  assert.equal(group.nodes.find(node => node.key === 'revise').state, 'skipped');
  assert.ok(tasks.every(task => !task.retryOf));
  assert.equal(c.store.task(c.taskOf('story-any', 'work').id).status, 'done');
  sequencedByOne(c, 'story-any');
});

test('a director gate records a pending decision with its reason and starts nothing', async t => {
  const c = await setup(t);
  c.start(
    'story-director',
    flow(
      [
        work('work', 'Draft the guide'),
        review('review', 'Review the guide'),
        gate('director', 'The director reads the guide before it is published.'),
        work('finish', 'Publish the guide'),
        work('revise', 'Revise the guide'),
      ],
      [
        edge('work', 'review'),
        edge('review', 'gate'),
        edge('gate', 'finish', 'passed'),
        edge('gate', 'revise', 'needs-work'),
      ],
    ),
  );
  const group = await c.groupState('story-director', 'in-review'),
    pending = await c.until(() => c.group('story-director').nodes.find(node => node.decision)?.decision, 'the gate');
  assert.deepEqual(
    [pending.rule, pending.state, pending.reason, pending.outcome],
    ['director', 'pending', 'The director reads the guide before it is published.', undefined],
  );
  assert.ok(
    c
      .flowEvents()
      .some(
        event =>
          event.message.includes("The reviews pass waits for the director's decision (1 of 1 review passed)") &&
          event.message.includes('The director reads the guide before it is published.'),
      ),
  );
  // Nothing after the gate starts, and nothing more is written while the decision waits.
  const sequence = flowRecord(c.store, 'story-director').sequence;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(c.store.projectTasks(c.projectId).length, 2);
  const now = c.group('story-director');
  assert.equal(now.sequence, sequence);
  assert.deepEqual(nodeStates(now), {
    work: 'accepted',
    review: 'accepted',
    gate: 'director',
    finish: 'waiting',
    revise: 'waiting',
  });
  assert.equal(group.state, 'in-review');
  sequencedByOne(c, 'story-director');
});

test('a node waiting for needs-work is skipped with its reason when the review passes, and the node after the review still runs', async t => {
  const c = await setup(t);
  c.start(
    'story-skip',
    flow(
      [
        work('work', 'Draft the guide'),
        review('review', 'Review the guide'),
        work('fix', 'Fix the guide'),
        work('polish', 'Polish the fix'),
        work('publish', 'Publish the guide'),
      ],
      [
        edge('work', 'review'),
        edge('review', 'fix', 'needs-work'),
        edge('fix', 'polish'),
        edge('review', 'publish', 'passed'),
        edge('work', 'publish'),
      ],
    ),
  );
  const group = await c.groupState('story-skip', 'done'),
    byKey = Object.fromEntries(group.nodes.map(node => [node.key, node]));
  assert.deepEqual(nodeStates(group), {
    work: 'accepted',
    review: 'accepted',
    fix: 'skipped',
    polish: 'skipped',
    publish: 'accepted',
  });
  assert.equal(byKey.fix.reason, 'The edge review → fix waits for needs-work, and Review the guide passed its review.');
  // Skipping carries on past it.
  assert.equal(byKey.polish.reason, 'The edge fix → polish waits for accepted, and Fix the guide was skipped.');
  assert.equal(byKey.fix.taskId, null);
  assert.equal(byKey.polish.taskId, null);
  // The node after the review ran on both its inputs.
  const publish = c.taskOf('story-skip', 'publish');
  assert.deepEqual(
    new Set(publish.dependencies),
    new Set([c.taskOf('story-skip', 'work').id, c.taskOf('story-skip', 'review').id]),
  );
  assert.equal(c.store.projectTasks(c.projectId).length, 3);
  sequencedByOne(c, 'story-skip');
});

test('a failed task with no attempts left skips the nodes that wait on its acceptance; other branches run', async t => {
  const c = await setup(t),
    write = fs.writeFileSync;
  // The Simulator's work for the doomed node cannot be written, so its only attempt fails.
  t.mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
    if (String(file).endsWith('work.md') && String(data).startsWith('# Doomed'))
      throw new Error('Simulated failure: the work could not be written.');
    return write.call(fs, file, data, ...rest);
  });
  c.start(
    'story-failed',
    flow(
      [
        work('work', 'Doomed draft'),
        review('review', 'Review the draft'),
        gate('all-pass'),
        work('finish', 'Publish the draft'),
        work('revise', 'Revise the draft'),
        work('outline', 'Outline the guide'),
        work('summary', 'Summarize the outline'),
      ],
      [
        edge('work', 'review'),
        edge('review', 'gate'),
        edge('gate', 'finish', 'passed'),
        edge('gate', 'revise', 'needs-work'),
        edge('outline', 'summary'),
      ],
    ),
  );
  const group = await c.groupState('story-failed', 'done'),
    byKey = Object.fromEntries(group.nodes.map(node => [node.key, node]));
  assert.deepEqual(nodeStates(group), {
    work: 'failed',
    review: 'skipped',
    gate: 'skipped',
    finish: 'skipped',
    revise: 'skipped',
    outline: 'accepted',
    summary: 'accepted',
  });
  assert.equal(c.taskOf('story-failed', 'work').status, 'failed');
  assert.equal(c.store.attempts(c.taskOf('story-failed', 'work').id).length, 1);
  assert.equal(
    byKey.review.reason,
    'The edge work → review waits for accepted, and Doomed draft failed with no attempts left.',
  );
  assert.equal(byKey.gate.reason, 'The edge review → gate waits for accepted, and Review the draft was skipped.');
  assert.equal(byKey.gate.decision, null);
  assert.equal(byKey.finish.reason, 'The edge gate → finish waits for passed, and The reviews pass was skipped.');
  assert.deepEqual(
    c
      .flowTasks('story-failed')
      .map(task => task.flowReference.node)
      .sort(),
    ['outline', 'summary', 'work'],
  );
  // The skip was recorded in the transaction that settled the failed attempt.
  const skipped = c.snapshots.find(record => record.nodes.review.state === 'skipped');
  assert.deepEqual(skipped.nodes.work.outcomes, []);
  sequencedByOne(c, 'story-failed');
});

test('a firing loop edge records the group as sent back with every input finding and starts nothing until its rounds', async t => {
  const c = await setup(t);
  c.start(
    'story-back',
    flow(
      [
        work('outline', 'Outline the guide'),
        work('work', 'Draft the guide'),
        review('review', 'REWORK review of the guide'),
        gate('all-pass'),
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
  const group = await c.groupState('story-back', 'sent-back'),
    reviewTask = c.taskOf('story-back', 'review');
  assert.deepEqual([group.sentBack.from, group.sentBack.to, group.sentBack.outcome], ['gate', 'work', 'needs-work']);
  assert.deepEqual(group.sentBack.findings, [
    {
      node: 'review',
      taskId: reviewTask.id,
      verdict: 'needs-work',
      summary: c.store.attempt(reviewTask.acceptedAttemptId).result.summary,
      findings: ['Simulated finding: revise once.'],
    },
  ]);
  assert.equal(group.nodes.find(node => node.key === 'gate').decision.outcome, 'needs-work');
  // Nothing starts: no finish task, no new round of the work and no retry the autonomy policy would have made.
  const workTask = c.taskOf('story-back', 'work'),
    workAttempts = c.store.attempts(workTask.id).length,
    sequence = group.sequence;
  await new Promise(resolve => setTimeout(resolve, 150));
  const tasks = c.store.projectTasks(c.projectId);
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every(task => !task.retryOf));
  assert.equal(c.store.task(workTask.id).status, 'done');
  assert.equal(c.store.attempts(workTask.id).length, workAttempts);
  assert.equal(c.store.task(reviewTask.id).status, 'done');
  assert.equal(c.group('story-back').sequence, sequence);
  assert.ok(
    c
      .flowEvents()
      .some(event => /sent the work back to Draft the guide with the findings of 1 input/.test(event.message)),
  );
  sequencedByOne(c, 'story-back');
});
