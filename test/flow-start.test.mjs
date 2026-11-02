// Starting a graph-v2 flow for a group (1.2): the controller records the flow and its revision under the group and
// makes each node whose inputs are met an ordinary task, which the unchanged scheduler runs with the Simulator. Gates,
// for-each and join nodes get no task, a group runs one flow, every flow write is on the change stream with the
// group's ID and a rising sequence, and graph-v1 runs and stage templates in the same studio behave as before.
// Model-free: Simulator agents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitForTask } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { GRAPH_V2_SCHEMA, validateFlow } from '../src/core/graph-v2.mjs';
import { FLOW_RUN_SCHEMA, startFlow, readFlowGroup, writeFlow, flowRecord } from '../src/core/flow-run.mjs';

// Two teams. Staffing roles: W-02 plans and works, W-03 works, W-05 and W-07 review; both reviewers' job title is
// Editor. W-08, listed first on the checking team, is a disabled agent in the studio's organization.
const organization = () => ({
  teams: [
    { id: 'writing', name: 'Writing', purpose: 'Bounded general work.' },
    { id: 'checking', name: 'Checking', purpose: 'Independent reviews.' },
  ],
  members: [
    ['W-02', 'writing', 'Planner', ['planner', 'worker']],
    ['W-03', 'writing', 'Writer', ['worker']],
    ['W-08', 'checking', 'Archivist', []],
    ['W-05', 'checking', 'Editor', ['reviewer']],
    ['W-07', 'checking', 'Editor', ['reviewer']],
  ].map(([workerId, teamId, role, roles]) => ({
    workerId,
    teamId,
    role,
    responsibility: 'Bounded general work.',
    roles,
  })),
  taskKinds: ['general:split', 'general:work', 'general:review'],
  kindOwners: {},
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-flow-start-')),
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
  const created = await c.request('/api/projects', { name: 'Flow start' });
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
  // Every change the store reports, in order, as the change stream receives it.
  c.changes = [];
  const notify = c.store.onChange;
  c.store.onChange = change => {
    c.changes.push(change);
    notify(change);
  };
  c.flowChanges = groupId => c.changes.filter(change => change.type === 'flow' && change.id === groupId);
  c.flowEvents = () =>
    c.store
      .activity(c.projectId, { limit: 200 })
      .events.filter(event => event.kind === 'flow')
      .reverse();
  c.projectTasks = () => c.store.projectTasks(c.projectId);
  c.start = (groupId, graph, fields = {}) =>
    startFlow(c.store, registries, {
      projectId: c.projectId,
      groupId,
      flow: { id: 'flow-guide', revision: 3, graph },
      ...fields,
    });
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
// The work, its independent review and a gate on that review: a pass goes on to publishing, a request for changes to
// a revision step.
const reviewedFlow = () => ({
  schemaVersion: GRAPH_V2_SCHEMA,
  nodes: [
    agentNode('work', 'general:work', role('worker'), 'Draft the guide'),
    agentNode('review', 'general:review', role('reviewer'), 'Review the guide'),
    {
      key: 'gate',
      title: 'The review passes',
      kind: 'gate',
      owner: { type: 'studio' },
      gate: { rule: 'all-pass', reason: 'The independent review must pass.' },
    },
    agentNode('publish', 'general:work', role('worker'), 'Publish the guide'),
    agentNode('revise', 'general:work', role('worker'), 'Revise the guide'),
  ],
  edges: [
    edge('work', 'review'),
    edge('review', 'gate'),
    edge('gate', 'publish', 'passed'),
    edge('gate', 'revise', 'needs-work'),
  ],
});
// A refused call writes nothing: the store's version, its tasks, flow records and events are as they were. The call is
// synchronous, so no scheduler pass runs between the two reads.
function refusedWithoutWrites(c, call, expected) {
  const written = () => ({
      version: c.store.version,
      tasks: c.store.tasks().length,
      flows: c.store.db.prepare("SELECT COUNT(*) AS count FROM settings WHERE id LIKE 'flow:%'").get().count,
      events: c.store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
    }),
    before = written();
  assert.throws(call, expected);
  assert.deepEqual(written(), before);
}

test('a started flow makes only its ready node a task, which the unchanged scheduler runs to Review', async t => {
  const c = await setup(t),
    graph = reviewedFlow(),
    before = structuredClone(graph),
    envelope = validateFlow(c.store, c.registries, graph, c.projectId);
  assert.deepEqual(envelope, { nodes: 5, attemptSeconds: 120 });
  const started = c.start('story-guide', graph, { brief: 'Keep it short.' });
  assert.deepEqual(graph, before, "The caller's graph is not rewritten.");
  // Exactly one task, for the node with no incoming edge: not the review, the gate or the steps after the gate.
  const tasks = c.projectTasks();
  assert.deepEqual(
    tasks.map(task => task.id),
    started.taskIds,
  );
  assert.equal(tasks.length, 1);
  const [work] = tasks;
  assert.deepEqual(work.flowReference, {
    flowId: 'flow-guide',
    revision: 3,
    node: 'work',
    round: 1,
    group: 'story-guide',
  });
  // An ordinary task, as a graph-v1 run builds one, staffed by its role: the first member who holds it.
  assert.equal(work.workerId, 'W-02');
  assert.deepEqual(work.staffing, { by: 'role', role: 'worker' });
  assert.equal(work.team, 'Writing');
  assert.deepEqual(
    {
      kind: work.kind,
      title: work.title,
      brief: work.brief,
      acceptance: work.acceptance,
      maxSeconds: work.maxSeconds,
      maxAttempts: work.maxAttempts,
      resources: work.resources,
      dependencies: work.dependencies,
      status: work.status,
      queued: work.queued,
      projectId: work.projectId,
      direction: work.direction,
      lastAttemptId: work.lastAttemptId,
    },
    {
      kind: 'general:work',
      title: 'Draft the guide',
      brief: 'Bounded general work.',
      acceptance: 'Return checked evidence.',
      maxSeconds: 30,
      maxAttempts: 1,
      resources: [],
      dependencies: [],
      status: 'ready',
      queued: true,
      projectId: c.projectId,
      direction: 'Director brief for this flow: Keep it short.',
      lastAttemptId: null,
    },
  );
  assert.equal(work.workflowReference, undefined);
  // The flow record holds the exact graph, its envelope and each node's task, round and state.
  const record = flowRecord(c.store, 'story-guide');
  assert.equal(record.schemaVersion, FLOW_RUN_SCHEMA);
  assert.equal(record.schemaVersion, 'flow-run-v1');
  assert.deepEqual(
    [record.projectId, record.groupId, record.flowId, record.revision, record.sequence, record.brief],
    [c.projectId, 'story-guide', 'flow-guide', 3, 1, 'Keep it short.'],
  );
  assert.deepEqual(record.graph, before);
  assert.deepEqual(record.envelope, envelope);
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
  assert.deepEqual(record.nodes, {
    work: { key: 'work', taskId: work.id, round: 1, state: 'ready' },
    review: { key: 'review', taskId: null, round: 0, state: 'waiting' },
    gate: { key: 'gate', taskId: null, round: 0, state: 'waiting' },
    publish: { key: 'publish', taskId: null, round: 0, state: 'waiting' },
    revise: { key: 'revise', taskId: null, round: 0, state: 'waiting' },
  });
  // Its write is on the change stream with the group's ID and sequence, and in the project's Activity.
  assert.deepEqual(
    c.flowChanges('story-guide').map(({ seq, ...change }) => change),
    [{ type: 'flow', id: 'story-guide', projectId: c.projectId, sequence: 1 }],
  );
  const [event] = c.flowEvents();
  assert.equal(c.flowEvents().length, 1);
  assert.equal(
    event.message,
    'Started flow flow-guide revision 3. Draft the guide can start now; 4 other steps wait for their inputs.',
  );
  assert.equal(c.store.setting('event-project:' + event.seq), c.projectId);
  const nodes = group => group.nodes.map(node => [node.key, node.taskId, node.round, node.state]);
  let group = readFlowGroup(c.store, c.registries, 'story-guide');
  assert.deepEqual(
    [group.groupId, group.flowId, group.revision, group.projectId, group.state],
    ['story-guide', 'flow-guide', 3, c.projectId, 'building'],
  );
  assert.deepEqual(
    group.nodes.map(node => node.title),
    ['Draft the guide', 'Review the guide', 'The review passes', 'Publish the guide', 'Revise the guide'],
  );
  assert.deepEqual(nodes(group), [
    ['work', work.id, 1, 'ready'],
    ['review', null, 0, 'waiting'],
    ['gate', null, 0, 'waiting'],
    ['publish', null, 0, 'waiting'],
    ['revise', null, 0, 'waiting'],
  ]);
  // Nobody starts it: the scheduler dispatches it to the Simulator and it reaches Review like any other task.
  const attempt = await waitForTask(c.store, work.id, 'review', { interval: 10 });
  assert.equal(attempt.workerId, 'W-02');
  assert.equal(attempt.assignment.kind, 'general:work');
  assert.equal(attempt.status, 'review');
  group = readFlowGroup(c.store, c.registries, 'story-guide');
  assert.deepEqual(nodes(group)[0], ['work', work.id, 1, 'review']);
  assert.equal(group.state, 'building');
  // Nothing else of the flow was created, and the flow record was not written again.
  assert.equal(c.projectTasks().length, 1);
  assert.equal(flowRecord(c.store, 'story-guide').sequence, 1);

  // A second flow for the same group is refused and writes nothing.
  refusedWithoutWrites(
    c,
    () => c.start('story-guide', reviewedFlow()),
    /^Error: Group story-guide already runs flow flow-guide revision 3\.$/,
  );
  assert.deepEqual(flowRecord(c.store, 'story-guide'), record);

  // An invalid flow is refused with validateFlow's sentence and creates no task and no record.
  const invalid = reviewedFlow();
  invalid.nodes[0].owner = { type: 'agent', id: 'W-01' };
  refusedWithoutWrites(
    c,
    () => c.start('story-other', invalid),
    error => error.message === 'Node work names agent W-01, who is not on this project.',
  );
  assert.equal(flowRecord(c.store, 'story-other'), null);
  assert.equal(readFlowGroup(c.store, c.registries, 'story-other'), null);
  assert.equal(c.projectTasks().length, 1);
  refusedWithoutWrites(c, () => c.start('story other', reviewedFlow()), /A flow group needs an ID/);
  refusedWithoutWrites(
    c,
    () => startFlow(c.store, c.registries, { projectId: c.projectId, groupId: 'story-x', flow: { id: 'f', graph } }),
    /A flow needs a revision of 1 or more/,
  );
});

test('only nodes with no incoming ordinary edge start, and controller nodes never get a task', async t => {
  const c = await setup(t),
    // Split work into items, then for each item the work and a review, a gate whose send-back loops to the work, and
    // a join. The work's only other edge is a loop, which is not an input it waits for at the start.
    graph = {
      schemaVersion: GRAPH_V2_SCHEMA,
      nodes: [
        agentNode('split', 'general:split', role('planner'), 'Split the guide into parts', {
          brief: 'Split the guide into its parts.\n- Birds\n- Trees',
        }),
        {
          key: 'each',
          title: 'For each part',
          kind: 'for-each',
          owner: { type: 'studio' },
          items: { from: 'split', maxWidth: 2 },
        },
        agentNode('work', 'general:work', role('worker'), 'Write the part'),
        agentNode('review', 'general:review', role('reviewer'), 'Review the part'),
        {
          key: 'gate',
          title: 'The review passes',
          kind: 'gate',
          owner: { type: 'studio' },
          gate: { rule: 'all-pass', reason: 'The independent review must pass.' },
        },
        {
          key: 'join',
          title: 'Collect the parts',
          kind: 'join',
          owner: { type: 'studio' },
          join: { from: 'each', rule: 'all' },
        },
      ],
      edges: [
        edge('split', 'each'),
        edge('each', 'work'),
        edge('work', 'review'),
        edge('review', 'gate'),
        edge('gate', 'join', 'passed'),
        { ...edge('gate', 'work', 'needs-work'), loop: { limit: 2 } },
      ],
    };
  const { taskIds } = c.start('step-parts', graph),
    tasks = c.projectTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(
    tasks.map(task => [task.id, task.kind, task.flowReference.node, task.workerId]),
    [[taskIds[0], 'general:split', 'split', 'W-02']],
  );
  assert.deepEqual(
    readFlowGroup(c.store, c.registries, 'step-parts').nodes.map(node => [node.key, node.taskId !== null, node.state]),
    [
      ['split', true, 'ready'],
      ['each', false, 'waiting'],
      ['work', false, 'waiting'],
      ['review', false, 'waiting'],
      ['gate', false, 'waiting'],
      ['join', false, 'waiting'],
    ],
  );
  await waitForTask(c.store, taskIds[0], 'review', { interval: 10 });
});

test('each flow write raises the sequence by one, on the change stream with the group, and records an event', async t => {
  const c = await setup(t),
    { taskIds } = c.start('story-guide', reviewedFlow());
  // The one helper every flow write goes through, as the later steps of a flow will use it.
  for (const message of ['Recorded a note on the flow.', 'Recorded another note on the flow.']) {
    const record = flowRecord(c.store, 'story-guide');
    c.store.tx(() => writeFlow(c.store, { ...record, note: message }, message));
  }
  assert.deepEqual(
    c.flowChanges('story-guide').map(change => [change.type, change.id, change.projectId, change.sequence]),
    [
      ['flow', 'story-guide', c.projectId, 1],
      ['flow', 'story-guide', c.projectId, 2],
      ['flow', 'story-guide', c.projectId, 3],
    ],
  );
  // Each is a later change of the store than the one before.
  const seqs = c.flowChanges('story-guide').map(change => change.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  assert.deepEqual(
    c.flowEvents().map(event => event.message),
    [
      'Started flow flow-guide revision 3. Draft the guide can start now; 4 other steps wait for their inputs.',
      'Recorded a note on the flow.',
      'Recorded another note on the flow.',
    ],
  );
  assert.equal(flowRecord(c.store, 'story-guide').sequence, 3);
  assert.equal(readFlowGroup(c.store, c.registries, 'story-guide').sequence, 3);
  // A write from a stale read is refused and writes nothing.
  const stale = { ...flowRecord(c.store, 'story-guide'), sequence: 2 };
  refusedWithoutWrites(
    c,
    () => c.store.tx(() => writeFlow(c.store, stale, 'A stale write.')),
    /This flow changed since it was read/,
  );
  assert.equal(c.flowChanges('story-guide').length, 3);
  // Running its task writes nothing to the flow.
  await waitForTask(c.store, taskIds[0], 'review', { interval: 10 });
  assert.equal(flowRecord(c.store, 'story-guide').sequence, 3);
});

test('an agent-owned node gets that agent, a team-owned node an enabled member of the team, and distinctFrom excludes', async t => {
  const c = await setup(t),
    team = id => ({ type: 'team', id });
  const flow = () => ({
    schemaVersion: GRAPH_V2_SCHEMA,
    nodes: [
      agentNode('draft', 'general:work', { type: 'agent', id: 'W-03' }, 'Draft the guide'),
      // The writing team's first member, W-02, outlines; the second outline must be someone else on the team.
      agentNode('outline', 'general:work', team('writing'), 'Outline the guide'),
      agentNode('second', 'general:work', team('writing'), 'Outline it again', { distinctFrom: ['outline'] }),
      // The checking team lists the disabled W-08 first.
      agentNode('notes', 'general:work', team('checking'), 'Note the sources', { tier: 'standard' }),
      // A role label that only job titles carry.
      agentNode('style', 'general:work', role('Editor'), 'Check the style', { distinctFrom: ['notes'] }),
    ],
    edges: [],
  });
  const { taskIds } = c.start('story-owners', flow()),
    byNode = Object.fromEntries(taskIds.map(id => c.store.task(id)).map(task => [task.flowReference.node, task]));
  assert.deepEqual(Object.keys(byNode), ['draft', 'outline', 'second', 'notes', 'style']);
  assert.equal(byNode.draft.workerId, 'W-03');
  assert.equal(byNode.draft.staffing, undefined);
  assert.equal(byNode.outline.workerId, 'W-02');
  assert.deepEqual(byNode.outline.staffing, { by: 'team', team: 'writing' });
  assert.equal(byNode.second.workerId, 'W-03');
  assert.deepEqual(byNode.second.staffing, { by: 'team', team: 'writing', exclude: ['W-02'] });
  assert.equal(byNode.notes.workerId, 'W-05');
  assert.equal(byNode.notes.team, 'Checking');
  assert.equal(byNode.notes.tier, 'standard');
  assert.equal(byNode.style.workerId, 'W-07');
  assert.deepEqual(byNode.style.staffing, { by: 'role', role: 'Editor', exclude: ['W-05'] });
  for (const task of Object.values(byNode)) assert.equal(task.flowReference.group, 'story-owners');

  // A team none of whose enabled members may run the node is refused, naming the node, and nothing is written.
  const blocked = flow();
  blocked.nodes[2].distinctFrom = ['outline', 'draft'];
  refusedWithoutWrites(
    c,
    () => c.start('story-blocked', blocked),
    /^Error: Node second: No enabled member of team writing can run Do the work other than W-02, W-03\.$/,
  );
  assert.equal(flowRecord(c.store, 'story-blocked'), null);
  // An agent excluded by distinctFrom is refused the same way.
  const excluded = flow();
  excluded.nodes[0].distinctFrom = ['outline'];
  excluded.nodes[1].owner = { type: 'agent', id: 'W-03' };
  excluded.nodes.reverse();
  refusedWithoutWrites(c, () => c.start('story-excluded', excluded), /^Error: Node draft: .*separation of duties/);
  // Each runs as its staffed agent.
  for (const task of Object.values(byNode))
    assert.equal((await waitForTask(c.store, task.id, 'review', { interval: 10 })).workerId, task.workerId);
});

test('a separation of duties holds whatever order the graph lists its start nodes, and around a cycle', async t => {
  const c = await setup(t),
    team = id => ({ type: 'team', id }),
    flow = nodes => ({ schemaVersion: GRAPH_V2_SCHEMA, nodes, edges: [] }),
    staffedBy = taskIds =>
      Object.fromEntries(
        taskIds.map(id => c.store.task(id)).map(task => [task.flowReference.node, [task.workerId, task.staffing]]),
      );
  const outline = agentNode('outline', 'general:work', team('writing'), 'Outline the guide'),
    second = agentNode('second', 'general:work', team('writing'), 'Outline it again', { distinctFrom: ['outline'] }),
    notes = agentNode('notes', 'general:work', team('checking'), 'Note the sources'),
    style = agentNode('style', 'general:work', role('Editor'), 'Check the style', { distinctFrom: ['notes'] });
  // Each node that declares distinctFrom is listed before the node it names. The named node is staffed first and the
  // declaring node avoids its agent, exactly as when the graph lists them the other way round.
  const later = c.start('story-later', flow([second, style, outline, notes])),
    earlier = c.start('story-earlier', flow([outline, notes, second, style])),
    expected = {
      second: ['W-03', { by: 'team', team: 'writing', exclude: ['W-02'] }],
      style: ['W-07', { by: 'role', role: 'Editor', exclude: ['W-05'] }],
      outline: ['W-02', { by: 'team', team: 'writing' }],
      notes: ['W-05', { by: 'team', team: 'checking' }],
    };
  assert.deepEqual(staffedBy(later.taskIds), expected);
  assert.deepEqual(staffedBy(earlier.taskIds), expected);
  // The tasks, the record and the Activity keep the graph's order.
  assert.deepEqual(Object.keys(staffedBy(later.taskIds)), ['second', 'style', 'outline', 'notes']);
  assert.deepEqual(
    readFlowGroup(c.store, c.registries, 'story-later').nodes.map(node => [node.key, node.taskId]),
    ['second', 'style', 'outline', 'notes'].map((key, index) => [key, later.taskIds[index]]),
  );
  assert.equal(
    c.flowEvents()[0].message,
    'Started flow flow-guide revision 3. Outline it again, Check the style, Outline the guide, Note the sources can start now.',
  );

  // Two nodes that name each other run as two agents.
  const pair = c.start(
    'story-pair',
    flow([
      agentNode('a', 'general:work', team('writing'), 'Write part A', { distinctFrom: ['b'] }),
      agentNode('b', 'general:work', team('writing'), 'Write part B', { distinctFrom: ['a'] }),
    ]),
  );
  assert.deepEqual(staffedBy(pair.taskIds), {
    a: ['W-03', { by: 'team', team: 'writing', exclude: ['W-02'] }],
    b: ['W-02', { by: 'team', team: 'writing' }],
  });

  // Three nodes that each name the next must all differ, which the writing team's two agents cannot do: the start is
  // refused, naming the node where the cycle closes, rather than running two of them as one agent.
  const cycle = flow([
    agentNode('a', 'general:work', team('writing'), 'Write part A', { distinctFrom: ['b'] }),
    agentNode('b', 'general:work', team('writing'), 'Write part B', { distinctFrom: ['c'] }),
    agentNode('c', 'general:work', team('writing'), 'Write part C', { distinctFrom: ['a'] }),
  ]);
  refusedWithoutWrites(
    c,
    () => c.start('story-cycle', cycle),
    /^Error: Node a: No enabled member of team writing can run Do the work other than W-03, W-02\.$/,
  );
  assert.equal(flowRecord(c.store, 'story-cycle'), null);

  // Each runs as its staffed agent; the scheduler's own separation check lets every one through.
  for (const id of [...later.taskIds, ...earlier.taskIds, ...pair.taskIds])
    assert.equal((await waitForTask(c.store, id, 'review', { interval: 10 })).workerId, c.store.task(id).workerId);
});

test('a graph-v1 run and a stage-template task in the same studio behave as before', async t => {
  const c = await setup(t),
    { taskIds } = c.start('story-guide', reviewedFlow()),
    flowTask = taskIds[0];
  // A graph-v1 workflow with one Do the work step, staffed by role, saved and run through the routes.
  const { owner, ...step } = agentNode('work', 'general:work', role('worker'), 'Do the work'),
    saved = await c.request('/api/workflows', {
      projectId: c.projectId,
      name: 'Work',
      graph: { schemaVersion: 'graph-v1', nodes: [{ ...step, role: owner.id, resources: [] }], edges: [] },
    });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const run = await c.request(`/api/workflows/${saved.data.id}/run`, { projectId: c.projectId, expectedVersion: 1 });
  assert.equal(run.status, 201, JSON.stringify(run.data));
  const [runTask] = run.data.taskIds.map(id => c.store.task(id));
  assert.equal(runTask.workflowReference.runId, run.data.runId);
  assert.equal(runTask.flowReference, undefined);
  assert.equal(c.store.run(run.data.runId).schemaVersion, 'run-v1');
  assert.equal(readFlowGroup(c.store, c.registries, run.data.runId), null);
  // Both run; the graph-v1 task's stage template takes it to its independent review once its work is accepted.
  await waitForTask(c.store, flowTask, 'review', { interval: 10 });
  const work = await waitForTask(c.store, runTask.id, 'review', { interval: 10 });
  assert.equal(work.assignment.kind, 'general:work');
  const accepted = await c.request(`/api/tasks/${runTask.id}/accept`, { projectId: c.projectId });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  // Accepting the work stage moved the task on before the answer came, so its next Review is the review stage's.
  assert.notEqual(c.store.task(runTask.id).status, 'review');
  const review = await waitForTask(c.store, runTask.id, 'review', { interval: 10 });
  assert.notEqual(review.id, work.id);
  assert.equal(review.assignment.kind, 'general:review');
  assert.notEqual(review.workerId, work.workerId, 'Separation of duties.');
  assert.deepEqual(
    c.store.task(runTask.id).stageState.history.map(entry => [entry.key, entry.outcome]),
    [['work', 'accepted']],
  );
  // The flow was not written by the other work, and its task carries no run.
  assert.equal(flowRecord(c.store, 'story-guide').sequence, 1);
  assert.equal(c.flowChanges('story-guide').length, 1);
  assert.equal(c.store.task(flowTask).workflowReference, undefined);
  assert.deepEqual(
    readFlowGroup(c.store, c.registries, 'story-guide').nodes.map(node => node.state),
    ['review', 'waiting', 'waiting', 'waiting', 'waiting'],
  );
});
