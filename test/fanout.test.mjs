import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { transforms } from '../src/core/transforms.mjs';
import { approveWork } from '../src/core/proposals.mjs';

// Neutral fixtures: a planner splits work into items, reviewers check one item each, and a
// lead summarizes their findings. The planner's brief says how many items to list; an item
// titled FAIL makes its reviewer fail.
const kind = (id, fields) => ({
  kind: id,
  version: `${id.split(':')[1]}-v1`,
  label: `Fan ${id.split(':')[1]}`,
  creatable: true,
  requiredCapabilities: ['text-output'],
  requiredResources: [],
  instructions: () => ({ scopeNote: 'Model-free fan-out fixture.' }),
  validateOutput: () => {},
  ...fields,
});
const findings = { id: 'fan-finding-v1', label: 'Fan finding', artifactKind: 'fan-finding' };
const pack = {
  id: 'fan-fixtures',
  version: 'fan-fixtures-v1',
  formats: [findings],
  roles: [
    { id: 'planner', label: 'Planner' },
    { id: 'reviewer', label: 'Reviewer' },
    { id: 'lead', label: 'Lead' },
  ],
  tasks: [
    kind('fan:split', {
      role: 'planner',
      produces: ['item-list-v1'],
      simulate: ({ attempt }) => {
        const titles = attempt.assignment.brief.match(/items: (.*)$/m)[1].split(',');
        return {
          artifact: 'items.json',
          kind: 'item-list',
          data: {
            schemaVersion: 'item-list-v1',
            items: titles.map((title, index) => ({ key: `item-${index + 1}`, title, brief: `Check ${title}.` })),
          },
          checks: [],
        };
      },
    }),
    kind('fan:review', {
      role: 'reviewer',
      distinctFromInputs: true,
      consumes: ['item-list-v1'],
      produces: ['fan-finding-v1'],
      simulate: ({ attempt }) => ({
        artifact: 'finding.json',
        kind: 'fan-finding',
        data: { brief: attempt.assignment.brief },
        checks: [],
      }),
      validateOutput: ({ task }) => {
        if (task.title.endsWith(': FAIL')) throw new Error('Fixture reviewer could not check this item.');
      },
    }),
    kind('fan:collated', {
      role: 'lead',
      consumes: ['collection-v1'],
      simulate: () => ({ artifact: 'collated.json', data: {}, checks: [] }),
    }),
    kind('fan:summary', {
      role: 'lead',
      consumes: ['fan-finding-v1'],
      simulate: ({ attempt }) => ({
        artifact: 'summary.json',
        data: { inputs: attempt.inputReferences.map(ref => ref.taskId) },
        checks: [],
      }),
    }),
  ],
};
const shapes = {
  // Few people: one plans and leads, two review.
  pair: { 'W-03': ['planner', 'lead'], 'W-04': ['reviewer'], 'W-05': ['reviewer'] },
  // A larger bench with three reviewers.
  bench: { 'W-02': ['planner'], 'W-03': ['reviewer'], 'W-04': ['reviewer'], 'W-05': ['reviewer'], 'W-06': ['lead'] },
};
const node = (key, kindId, role, fields = {}) => ({
  key,
  title: `Fan ${key}`,
  kind: kindId,
  role,
  brief: `Fixture ${key}.`,
  acceptance: 'Recorded.',
  resources: [],
  maxSeconds: 30,
  maxAttempts: 1,
  ...fields,
});
const graph = (items, join = { from: 'review', rule: 'quorum', min: 2 }, width = 5) => ({
  schemaVersion: 'graph-v1',
  nodes: [
    node('split', 'fan:split', 'planner', { brief: `Split the work.\nitems: ${items.join(',')}` }),
    node('review', 'fan:review', 'reviewer', { map: { from: 'split', maxWidth: width } }),
    node('summary', 'fan:summary', 'lead', { join }),
  ],
  edges: [
    { from: 'split', to: 'review' },
    { from: 'review', to: 'summary' },
  ],
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fanout-')),
    registries = createRegistries();
  registries.workflows.register(pack);
  const delay = process.env.STUDIO_MOCK_DELAY_MS;
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
  c.request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.state = async projectId => (await fetch(c.origin + '/api/state?projectId=' + projectId)).json();
  c.until = (check, label) => waitFor(check, label, { interval: 10 });
  c.project = async (name, roles) => {
    const created = await c.request('/api/projects', { name });
    const saved = await c.request(
      `/api/projects/${created.data.id}/organization`,
      {
        projectId: created.data.id,
        expectedRevision: c.app.store.setting('project-organization:' + created.data.id).revision,
        teams: [{ id: 'team', name: 'Team', purpose: 'Bounded fixture work.' }],
        members: Object.entries(roles).map(([workerId, memberRoles]) => ({
          workerId,
          teamId: 'team',
          role: 'Contributor',
          responsibility: 'Bounded fixture work.',
          roles: memberRoles,
        })),
        taskKinds: ['general', 'general:split', ...pack.tasks.map(task => task.kind)],
        kindOwners: {},
      },
      'PATCH',
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return created.data.id;
  };
  c.start = async (projectId, spec) => {
    const saved = await c.request('/api/workflows', { projectId, name: 'Fan out', graph: spec });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const started = await c.request(`/api/workflows/${saved.data.id}/run`, { projectId, expectedVersion: 1 });
    assert.equal(started.status, 201, JSON.stringify(started.data));
    return started.data;
  };
  c.accept = async (projectId, id) => {
    await c.until(() => c.app.store.task(id).status === 'review', `${id} in review`);
    const accepted = await c.request(`/api/tasks/${id}/accept`, { projectId });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  };
  return c;
}

test('one fan-out graph is staffed across each organization and its join proceeds by quorum', async t => {
  const c = await setup(t);
  for (const [shape, planner, reviewers, lead] of [
    ['pair', 'W-03', ['W-04', 'W-05', 'W-04'], 'W-03'],
    ['bench', 'W-02', ['W-03', 'W-04', 'W-05'], 'W-06'],
  ]) {
    const projectId = await c.project(`${shape} studio`, shapes[shape]),
      { runId, taskIds } = await c.start(projectId, graph(['alpha', 'FAIL', 'gamma']));
    // The map is a template: only the split and the summary exist until the split is accepted.
    assert.equal(taskIds.length, 2);
    const [split, summary] = taskIds;
    assert.equal(c.app.store.task(split).workerId, planner);
    assert.equal(c.app.store.task(summary).workerId, lead);
    assert.deepEqual(c.app.store.run(runId).envelope, { nodes: 7, attemptSeconds: 210 });
    await c.accept(projectId, split);

    const run = c.app.store.run(runId),
      expansion = run.revisions[1];
    assert.equal(expansion.reason, `Map review expanded over 3 items from ${split}.`);
    const children = expansion.map.children.map(id => c.app.store.task(id));
    assert.deepEqual(
      children.map(child => [child.title, child.workerId, child.dependencies]),
      [
        ['Fan review: alpha', reviewers[0], [split]],
        ['Fan review: FAIL', reviewers[1], [split]],
        ['Fan review: gamma', reviewers[2], [split]],
      ],
      shape,
    );
    // Each child is independent of the planner whose list it checks.
    for (const child of children) assert.ok(child.staffing.exclude.includes(planner), shape);
    assert.deepEqual(c.app.store.task(summary).dependencies, expansion.map.children);

    const [alpha, failed, gamma] = expansion.map.children;
    await c.until(() => c.app.store.task(failed).status === 'failed', 'the FAIL child fails');
    await c.accept(projectId, alpha);
    await c.accept(projectId, gamma);
    // Two accepted children meet the quorum; the failed one is recorded as missing.
    const joined = await c.until(
      () =>
        c.app.store.task(summary).status === 'review' && c.app.store.attempt(c.app.store.task(summary).lastAttemptId),
      'summary in review',
    );
    assert.deepEqual(joined.inputReferences.map(ref => ref.taskId).sort(), [alpha, gamma].sort());
    assert.deepEqual(joined.joinMissing, [failed]);
    const view = (await c.state(projectId)).runs.find(item => item.id === runId);
    assert.deepEqual(
      view.nodes.map(item => [item.taskId, item.revision]),
      [
        [split, 1],
        [summary, 1],
        [alpha, 2],
        [failed, 2],
        [gamma, 2],
      ],
    );
  }
});

test('a join that needs every child stops with the missing children named', async t => {
  const c = await setup(t),
    projectId = await c.project('bench studio', shapes.bench),
    { runId, taskIds } = await c.start(projectId, graph(['alpha', 'FAIL'], { from: 'review', rule: 'all' }));
  const [split, summary] = taskIds;
  await c.accept(projectId, split);
  const [alpha, failed] = c.app.store.run(runId).revisions[1].map.children;
  await c.until(() => c.app.store.task(summary).reason.startsWith('Waiting for'), 'the join waits');
  assert.match(c.app.store.task(summary).reason, /Waiting for [12] of 2 children/);
  await c.accept(projectId, alpha);
  await c.until(() => c.app.store.task(failed).status === 'failed', 'the FAIL child fails');
  await c.state(projectId);
  assert.equal(
    c.app.store.task(summary).reason,
    `This join needs 2 accepted children; 1 were accepted and 1 are missing (${failed}).`,
  );
  assert.equal(c.app.store.attempts(summary).length, 0);
});

test('children beyond the approved limits wait at a gate that only the director can pass', async t => {
  const c = await setup(t),
    projectId = await c.project('pair studio', shapes.pair),
    { runId, taskIds } = await c.start(projectId, graph(['a', 'b', 'c'], { from: 'review', rule: 'all' }, 2));
  const [split, summary] = taskIds;
  await c.accept(projectId, split);
  const [first, second, third] = c.app.store.run(runId).revisions[1].map.children.map(id => c.app.store.task(id));
  assert.deepEqual([first.approval, second.approval], [undefined, undefined]);
  assert.equal(third.status, 'backlog');
  assert.deepEqual(third.approval, {
    status: 'pending',
    gate: true,
    reason: 'item 3 of 3 is beyond the approved limits (map width 2, run envelope 4 nodes).',
  });
  // Autonomy cannot widen limits the director approved.
  assert.throws(
    () =>
      approveWork(c.app.store, c.registries, c.app.store.task(third.id), {
        type: 'policy',
        revision: 1,
        reason: 'Fixture.',
      }),
    /Only the director can pass a gate/,
  );
  const needs = (await c.state(projectId)).tasks.find(task => task.id === third.id);
  assert.equal(needs.approval.status, 'pending');
  await c.accept(projectId, first.id);
  await c.accept(projectId, second.id);
  assert.match(c.app.store.task(summary).reason, /Waiting for 1 of 3 children/);
  const passed = await c.request(`/api/tasks/${third.id}/approve-work`, { projectId });
  assert.equal(passed.status, 200, JSON.stringify(passed.data));
  assert.equal(c.app.store.task(third.id).queued, true);
  // Passing the gate resumes the run: the child runs, and the join then has every input.
  await c.accept(projectId, third.id);
  const joined = await c.until(
    () => c.app.store.task(summary).status === 'review' && c.app.store.attempt(c.app.store.task(summary).lastAttemptId),
    'summary in review',
  );
  assert.equal(joined.inputReferences.length, 3);
});

test('a gate node waits for the director before it runs, and a denied gate stops there', async t => {
  const c = await setup(t),
    projectId = await c.project('pair studio', shapes.pair);
  for (const decision of ['approve-work', 'deny-work']) {
    const spec = graph(['a'], { from: 'review', rule: 'all' });
    spec.nodes[2] = { ...spec.nodes[2], gate: { reason: 'Read the findings before the summary.' } };
    const { runId, taskIds } = await c.start(projectId, spec),
      [split, summary] = taskIds;
    assert.equal(c.app.store.task(summary).status, 'backlog');
    assert.equal(c.app.store.task(summary).reason, 'Waiting for your decision: Read the findings before the summary.');
    await c.accept(projectId, split);
    const [child] = c.app.store.run(runId).revisions[1].map.children;
    await c.accept(projectId, child);
    assert.equal(c.app.store.attempts(summary).length, 0);
    assert.equal((await c.request(`/api/tasks/${summary}/${decision}`, { projectId })).status, 200);
    if (decision === 'approve-work')
      await c.until(() => c.app.store.task(summary).status === 'review', 'the gated summary runs');
    else assert.equal(c.app.store.task(summary).status, 'denied');
  }
  const invalid = graph(['a']);
  invalid.nodes[1] = { ...invalid.nodes[1], gate: { reason: 'Templates are not gated.' } };
  const refused = await c.request('/api/workflows', { projectId, name: 'Gated map', graph: invalid });
  assert.match(refused.data.error, /Map review is a template; gate its source or its join instead/);
});

test('map and join graphs are validated before they are saved', async t => {
  const c = await setup(t),
    projectId = await c.project('pair studio', shapes.pair),
    base = graph(['a']);
  const without = (nodes, edges = base.edges) => ({ ...base, nodes, edges });
  const [split, review, summary] = base.nodes;
  const cases = [
    [
      without([{ ...split, kind: 'fan:summary', role: 'lead' }, review, summary]),
      /Map review needs a source whose task type produces item-list-v1/,
    ],
    [without([split, review, { ...summary, join: undefined }]), /Map review needs exactly one join node/],
    [
      without([split, review, { ...summary, join: { from: 'review', rule: 'quorum', min: 6 } }]),
      /quorum minimum must be from 1 to the map's width/,
    ],
    [
      without([split, review, { ...summary, join: { from: 'review', rule: 'all', min: 1 } }]),
      /rule must be all, or quorum with a minimum/,
    ],
    [
      without([split, { ...review, map: { from: 'split', maxWidth: 20 }, maxSeconds: 200, maxAttempts: 1 }, summary]),
      /At full width the graph needs 22 nodes and 4060 attempt-seconds/,
    ],
    [
      without([split, review, summary], [...base.edges, { from: 'summary', to: 'review' }]),
      /Map review needs exactly one incoming edge, from its source split/,
    ],
    [
      without([split, review, summary], [...base.edges, { from: 'review', to: 'split' }]),
      /Map review needs exactly one join node and no other outgoing edges/,
    ],
  ];
  for (const [spec, error] of cases) {
    const response = await c.request('/api/workflows', { projectId, name: 'Invalid', graph: spec });
    assert.equal(response.status, 400, JSON.stringify(spec));
    assert.match(response.data.error, error);
  }
  // Map and join are graph features; a step list cannot carry them.
  const steps = await c.request('/api/workflows', {
    projectId,
    name: 'Steps',
    steps: [
      { ...split, dependencies: [] },
      { ...review, dependencies: ['split'] },
    ],
  });
  assert.equal(steps.status, 400);
  assert.match(steps.data.error, /unsupported fields/);
});

test("a join's controller transform collects accepted children into one staged input", async t => {
  const c = await setup(t),
    projectId = await c.project('pair studio', shapes.pair),
    spec = graph(['alpha', 'beta'], { from: 'review', rule: 'quorum', min: 1, transform: 'collect' }),
    { runId, taskIds } = await c.start(projectId, spec);
  const [split, summary] = taskIds;
  await c.accept(projectId, split);
  const children = c.app.store.run(runId).revisions[1].map.children;
  for (const child of children) await c.accept(projectId, child);
  const joined = await c.until(
    () => c.app.store.task(summary).status === 'review' && c.app.store.attempt(c.app.store.task(summary).lastAttemptId),
    'summary in review',
  );
  assert.equal(joined.inputTransform.id, 'collect');
  assert.equal(joined.inputTransform.version, 'collect-v2');
  assert.deepEqual(
    joined.inputTransform.inputs.map(input => [input.taskId, input.path]),
    children.map(id => [id, 'finding.json']),
  );
  const staged = joined.inputReferences.at(-1);
  assert.equal(staged.taskId, 'transform:collect');
  assert.equal(staged.attemptId, null);
  assert.deepEqual(staged.artifacts, [joined.inputTransform.output]);
  const collection = JSON.parse(fs.readFileSync(path.resolve(joined.outputFolder, staged.artifacts[0].path), 'utf8'));
  assert.equal(collection.schemaVersion, 'collection-v1');
  assert.deepEqual(
    collection.items.map(item => [item.taskId, item.kind]),
    children.map(id => [id, 'fan-finding']),
  );
  assert.match(collection.items[0].data.brief, /Item item-1: alpha/);
});

test('a join that consumes collected results needs a collecting transform', async t => {
  const c = await setup(t),
    projectId = await c.project('pair studio', shapes.pair);
  const collated = (join, summaryKind = 'fan:collated') => {
    const spec = graph(['a'], join);
    spec.nodes[2] = { ...spec.nodes[2], kind: summaryKind };
    return spec;
  };
  const without = await c.request('/api/workflows', {
    projectId,
    name: 'No transform',
    graph: collated({ from: 'review', rule: 'all' }),
  });
  assert.equal(without.status, 400);
  assert.match(without.data.error, /Step summary consumes Collected results \(collection-v1\)/);
  const unknown = await c.request('/api/workflows', {
    projectId,
    name: 'Unknown transform',
    graph: collated({ from: 'review', rule: 'all', transform: 'summarize' }),
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /Join summary names an unknown transform; choose one of: collect, merge-item-lists/);
  const collected = await c.request('/api/workflows', {
    projectId,
    name: 'Collected',
    graph: collated({ from: 'review', rule: 'all', transform: 'collect' }),
  });
  assert.equal(collected.status, 201, JSON.stringify(collected.data));
});

test('merge-item-lists keeps the first item for each repeated key', () => {
  const list = items => ({
    item: { path: 'items.json', kind: 'item-list' },
    contents: Buffer.from(JSON.stringify({ schemaVersion: 'item-list-v1', items })),
  });
  const item = (key, title) => ({ key, title, brief: `Brief for ${title}.` });
  const merged = transforms['merge-item-lists'].run([
    list([item('a', 'First a'), item('b', 'B')]),
    list([item('a', 'Second a'), item('c', 'C')]),
  ]);
  assert.deepEqual(
    merged.items.map(entry => [entry.key, entry.title]),
    [
      ['a', 'First a'],
      ['b', 'B'],
      ['c', 'C'],
    ],
  );
});

test('a join whose map never expanded cannot run, even when the director starts it', async t => {
  const c = await setup(t),
    projectId = await c.project('pair studio', shapes.pair),
    { runId, taskIds } = await c.start(projectId, graph(['a'])),
    [split, summary] = taskIds;
  // Without its run record the map cannot expand; the join must not run on the source alone.
  c.app.store.db.prepare('DELETE FROM settings WHERE id=?').run('run:' + runId);
  await c.accept(projectId, split);
  const started = await c.request(`/api/tasks/${summary}/start`, { projectId });
  assert.equal(started.status, 202);
  assert.equal(started.data.queued, true);
  assert.equal(started.data.reason, 'Waiting for map review to expand when its source is accepted.');
  assert.equal(c.app.store.attempts(summary).length, 0);
});

test('the general split task type lets any organization fan out without a domain pack', async t => {
  const c = await setup(t),
    projectId = await c.project('general studio', shapes.pair),
    spec = {
      schemaVersion: 'graph-v1',
      nodes: [
        node('split', 'general:split', 'planner', { brief: 'Split the work.\n- alpha\n- beta' }),
        node('part', 'general', 'reviewer', { map: { from: 'split', maxWidth: 4 } }),
        node('collect', 'general', 'lead', { join: { from: 'part', rule: 'all', transform: 'collect' } }),
      ],
      edges: [
        { from: 'split', to: 'part' },
        { from: 'part', to: 'collect' },
      ],
    },
    { runId, taskIds } = await c.start(projectId, spec),
    [split, collect] = taskIds;
  await c.accept(projectId, split);
  const children = c.app.store.run(runId).revisions[1].map.children;
  assert.deepEqual(
    children.map(id => c.app.store.task(id).title),
    ['Fan part: alpha', 'Fan part: beta'],
  );
  for (const child of children) await c.accept(projectId, child);
  const joined = await c.until(
    () => c.app.store.task(collect).status === 'review' && c.app.store.attempt(c.app.store.task(collect).lastAttemptId),
    'collect in review',
  );
  const staged = joined.inputReferences.at(-1),
    collection = JSON.parse(fs.readFileSync(path.resolve(joined.outputFolder, staged.artifacts[0].path), 'utf8'));
  // Text results are collected as text, with where each came from.
  assert.deepEqual(
    collection.items.map(item => [item.taskId, item.path]),
    children.map(id => [id, 'work.txt']),
  );
  assert.match(collection.items[0].text, /Fan part: alpha/);
});
