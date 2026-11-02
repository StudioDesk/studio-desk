// A graph-v2 flow checked against one project (1.2): its task types through the real registries and the project's
// enabled task types, its owners against the project's organization, its milestones against each source's task type
// and its for-each sources against the core item list. The workflow routes still save graph-v1 only. Model-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { createRegistries } from '../src/registry.mjs';
import { Store } from '../src/core/store.mjs';
import { bootstrapFactory } from '../src/core/bootstrap.mjs';
import { saveProjectOrganization } from '../src/core/project-organization.mjs';
import { GRAPH_V2_SCHEMA, validateFlow, validateFlowShape } from '../src/core/graph-v2.mjs';

const projectId = 'project-flow';
const generalKinds = ['general:split', 'general:work', 'general:review'];
// Two teams. Staffing roles: W-02 plans and works, W-03 works, W-05 and W-07 review; every reviewer's job title is
// Editor. W-08 is on the project but is a disabled agent in the studio's organization; W-01 is not on the project.
const organization = (taskKinds = generalKinds) => ({
  teams: [
    { id: 'writing', name: 'Writing', purpose: 'Bounded general work.' },
    { id: 'checking', name: 'Checking', purpose: 'Independent reviews.' },
  ],
  members: [
    ['W-02', 'writing', 'Planner', ['planner', 'worker']],
    ['W-03', 'writing', 'Writer', ['worker']],
    ['W-05', 'checking', 'Editor', ['reviewer']],
    ['W-07', 'checking', 'Editor', ['reviewer']],
    ['W-08', 'checking', 'Archivist', []],
  ].map(([workerId, teamId, role, roles]) => ({
    workerId,
    teamId,
    role,
    responsibility: 'Bounded general work.',
    roles,
  })),
  taskKinds,
  kindOwners: {},
});

// A temporary store with the studio's seeded agents and one project; nothing is served.
function setup(t, taskKinds) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-flow-')),
    registries = createRegistries(),
    store = new Store(
      directory,
      bootstrapFactory(registries, { organizationPreset: 'game-studio', workflowPresets: [] }),
    );
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store.putProject({
    id: projectId,
    name: 'Flow check',
    goal: 'Bounded general work.',
    direction: '',
    revision: 1,
    dispatchPaused: false,
  });
  saveProjectOrganization(store, registries, projectId, { expectedRevision: 0, ...organization(taskKinds) });
  return { store, registries, check: graph => validateFlow(store, registries, graph, projectId) };
}

const agentNode = (key, kind, owner, title) => ({
  key,
  title,
  kind,
  owner,
  brief: 'Bounded general work.',
  acceptance: 'Return checked evidence.',
  maxSeconds: 30,
  maxAttempts: 1,
});
const role = id => ({ type: 'role', id });
const edge = (from, to, outcome = 'accepted', loop) => ({ from, to, outcome, ...(loop ? { loop } : {}) });
// Split work into items, then for each item: the work, two reviews side by side, a gate whose send-back loops to the
// work at most twice and then asks the director, and a join collecting the items.
const generalFlow = () => ({
  schemaVersion: GRAPH_V2_SCHEMA,
  nodes: [
    agentNode('split', 'general:split', role('planner'), 'Split work into items'),
    {
      key: 'each',
      title: 'For each item',
      kind: 'for-each',
      owner: { type: 'studio' },
      items: { from: 'split', maxWidth: 2 },
    },
    agentNode('work', 'general:work', role('worker'), 'Do the item'),
    agentNode('review-a', 'general:review', role('reviewer'), 'Review the item'),
    agentNode('review-b', 'general:review', role('reviewer'), 'Review the item again'),
    {
      key: 'gate',
      title: 'Both reviews pass',
      kind: 'gate',
      owner: { type: 'studio' },
      gate: { rule: 'all-pass', reason: 'Both independent reviews must pass.' },
    },
    {
      key: 'join',
      title: 'Collect the items',
      kind: 'join',
      owner: { type: 'studio' },
      join: { from: 'each', rule: 'all' },
    },
  ],
  edges: [
    edge('split', 'each'),
    edge('each', 'work'),
    edge('work', 'review-a'),
    edge('work', 'review-b'),
    edge('review-a', 'gate'),
    edge('review-b', 'gate'),
    edge('gate', 'join', 'passed'),
    edge('gate', 'work', 'needs-work', { limit: 2, atLimit: 'ask-director' }),
  ],
});
const byKey = (graph, key) => graph.nodes.find(node => node.key === key);
function refuses(check, graph, message) {
  assert.throws(
    () => check(graph),
    error => {
      assert.equal(error.constructor, Error);
      assert.match(error.message, message);
      assert.ok(error.message.endsWith('.'), error.message);
      assert.doesNotMatch(error.message, /[\r\n]/);
      return true;
    },
  );
}

test('a general-work flow with parallel reviews and a bounded send-back is valid for the project', t => {
  const { check } = setup(t),
    graph = generalFlow(),
    before = structuredClone(graph);
  // The body (work, two reviews, the gate) runs for two items and up to three rounds: 4 × 2 × 3 = 24 nodes, plus the
  // split, the for-each and the join. Attempt-seconds: the split's 30, and 6 runs of 30 for each of three agent nodes.
  assert.deepEqual(check(graph), { nodes: 27, attemptSeconds: 570 });
  assert.deepEqual(graph, before);
  // A declared envelope that covers the flow is the one returned.
  assert.deepEqual(check({ ...generalFlow(), envelope: { nodes: 30, attemptSeconds: 600 } }), {
    nodes: 30,
    attemptSeconds: 600,
  });
});

test('each owner is checked against the project organization', t => {
  const { check } = setup(t),
    owned = (key, owner) => {
      const graph = generalFlow();
      byKey(graph, key).owner = owner;
      return graph;
    };
  // An enabled agent on the project, one of its teams, and a role label taken from members' job titles.
  assert.ok(check(owned('review-a', { type: 'agent', id: 'W-05' })));
  assert.ok(check(owned('work', { type: 'team', id: 'writing' })));
  assert.ok(check(owned('review-b', role('Editor'))));
  refuses(
    check,
    owned('review-a', { type: 'agent', id: 'W-99' }),
    /^Node review-a names agent W-99, who is not on this project\.$/,
  );
  // An agent of the studio who is not a member of this project.
  refuses(
    check,
    owned('work', { type: 'agent', id: 'W-01' }),
    /^Node work names agent W-01, who is not on this project\.$/,
  );
  refuses(
    check,
    owned('work', { type: 'agent', id: 'W-08' }),
    /^Node work names agent W-08, who is not enabled on this project\.$/,
  );
  refuses(
    check,
    owned('work', { type: 'team', id: 'design' }),
    /^Node work names team design, which this project does not have\.$/,
  );
  refuses(
    check,
    owned('review-b', role('editor')),
    /^Node review-b names role editor, which no member of this project holds as a staffing role or job title\.$/,
  );
  // A role a pack names but nobody on this project holds.
  refuses(check, owned('split', role('tester')), /^Node split names role tester, which no member/);
});

test('each task type must be registered and enabled for the project', t => {
  const { check } = setup(t),
    kinded = kind => {
      const graph = generalFlow();
      byKey(graph, 'work').kind = kind;
      return graph;
    };
  refuses(
    check,
    kinded('general:translate'),
    /^Node work names task type general:translate, which is not registered\.$/,
  );
  // Registered, but this project enables only splitting, working and reviewing.
  refuses(
    check,
    kinded('general:plan'),
    /^Node work names task type general:plan, which this project has not enabled\.$/,
  );
});

test("an edge waits only for an outcome its source's task type produces", t => {
  const { check } = setup(t, [...generalKinds, 'studio-development:change']),
    graph = generalFlow();
  // General work defines no milestone beyond acceptance, so nothing waits for it to be integrated.
  graph.edges.find(item => item.from === 'work' && item.to === 'review-a').outcome = 'integrated';
  refuses(check, graph, /^Edge work → review-a waits for integrated, but its source produces accepted\.$/);
  // A task type that defines integrated (a source story) can be waited on for it.
  byKey(graph, 'work').kind = 'studio-development:change';
  assert.deepEqual(check(graph), { nodes: 27, attemptSeconds: 570 });
});

test('a for-each goes over a task type that produces an item list', t => {
  const { check } = setup(t),
    graph = generalFlow();
  // The work step returns work files, not an item list.
  byKey(graph, 'split').kind = 'general:work';
  refuses(check, graph, /^For-each each goes over split, which does not produce an item list\.$/);
});

test('supplied data is refused for a task type that takes none', t => {
  const { check } = setup(t),
    graph = generalFlow();
  byKey(graph, 'work').inputData = { note: 'unexpected' };
  refuses(check, graph, /^Node work takes no supplied data\.$/);
});

test('shape refusals pass through unchanged', t => {
  const { store, registries, check } = setup(t),
    graph = generalFlow();
  graph.edges.pop();
  refuses(check, graph, /^Gate gate needs an outgoing needs-work send-back edge\.$/);
  refuses(check, { ...generalFlow(), schemaVersion: 'graph-v1' }, /^schemaVersion must be graph-v2\.$/);
  assert.throws(() => validateFlow(store, registries, generalFlow(), 'project-missing'), /Project not found/);
  // The shape check alone, with no resolver, still refuses a task type it cannot resolve.
  assert.throws(() => validateFlowShape(generalFlow()), /Node split has an unknown kind/);
});

test('the workflow routes still save and run graph-v1 only, so a valid graph-v2 flow is refused and nothing is saved', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-flow-route-')),
    registries = createRegistries(),
    app = createStudio({ directory, port: 0, runnerOptions: { registries } }),
    origin = await app.start(),
    token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  const created = await request('/api/projects', { name: 'Flow route' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id,
    saved = await request(
      `/api/projects/${id}/organization`,
      {
        projectId: id,
        expectedRevision: app.store.setting('project-organization:' + id).revision,
        ...organization(),
      },
      'PATCH',
    );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  // The flow is valid for this project...
  assert.deepEqual(validateFlow(app.store, registries, generalFlow(), id), { nodes: 27, attemptSeconds: 570 });
  // ...and saving it waits for the step that runs it.
  const refused = await request('/api/workflows', { projectId: id, name: 'General work', graph: generalFlow() });
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  assert.match(refused.data.error, /schemaVersion must be graph-v1/);
  assert.deepEqual(app.store.workflows(id), []);
  // Editing a saved graph-v1 workflow into graph-v2 is refused the same way and leaves its version.
  const { owner, ...work } = agentNode('work', 'general:work', role('worker'), 'Do the work'),
    draft = { schemaVersion: 'graph-v1', nodes: [{ ...work, role: owner.id, resources: [] }], edges: [] };
  const first = await request('/api/workflows', { projectId: id, name: 'Work', graph: draft });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const edited = await request(
    `/api/workflows/${first.data.id}`,
    { projectId: id, name: 'Work', graph: generalFlow(), expectedVersion: 1 },
    'PATCH',
  );
  assert.equal(edited.status, 400, JSON.stringify(edited.data));
  assert.match(edited.data.error, /schemaVersion must be graph-v1/);
  assert.deepEqual(
    app.store.workflows(id).map(workflow => [workflow.version, workflow.graph]),
    [[1, draft]],
  );
});
