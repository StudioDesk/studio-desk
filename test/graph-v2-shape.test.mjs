import test from 'node:test';
import assert from 'node:assert/strict';
import { graphCeilings, validateGraphShape } from '../src/core/graph.mjs';
import { GRAPH_V2_SCHEMA, validateFlowShape, loopAtLimit, flowEnvelope } from '../src/core/graph-v2.mjs';

const stepOf = node => {
  const step = {
    'fixture:plan': { kind: 'plan', milestones: ['published'] },
    'fixture:work': { kind: 'work', milestones: ['integrated'] },
    'fixture:review': { kind: 'review', milestones: [] },
  }[node.kind];
  if (!step) throw new Error('Unknown fixture kind.');
  return step;
};
const agent = (key, kind = 'fixture:work') => ({
  key,
  kind,
  title: `Do ${key}`,
  owner: { type: 'role', id: 'worker' },
  brief: 'Do bounded work.',
  acceptance: 'Return checked evidence.',
  maxSeconds: 30,
  maxAttempts: 1,
});
const edge = (from, to, outcome = 'accepted', loop) => ({
  from,
  to,
  outcome,
  ...(loop === undefined ? {} : { loop }),
});
const flow = () => ({
  schemaVersion: GRAPH_V2_SCHEMA,
  nodes: [
    agent('plan', 'fixture:plan'),
    {
      key: 'each',
      title: 'For each item',
      kind: 'for-each',
      owner: { type: 'studio' },
      items: { from: 'plan', maxWidth: 2 },
    },
    agent('work'),
    agent('review-a', 'fixture:review'),
    agent('review-b', 'fixture:review'),
    {
      key: 'gate',
      title: 'Check both reviews',
      kind: 'gate',
      owner: { type: 'studio' },
      gate: { rule: 'all-pass', reason: 'Both reviews must pass.' },
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
    edge('plan', 'each'),
    edge('each', 'work'),
    edge('work', 'review-a'),
    edge('work', 'review-b'),
    edge('review-a', 'gate', 'passed'),
    edge('review-b', 'gate', 'passed'),
    edge('gate', 'join', 'passed'),
    edge('gate', 'work', 'needs-work', { limit: 2 }),
  ],
});
const check = graph => validateFlowShape(graph, { stepOf });
const byKey = (graph, key) => graph.nodes.find(node => node.key === key);
const sendBack = graph => graph.edges.find(item => item.loop);
const chain = () => ({
  schemaVersion: GRAPH_V2_SCHEMA,
  nodes: [agent('draft'), agent('check', 'fixture:review')],
  edges: [edge('draft', 'check')],
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function refuses(name, mutate, message, fixture = flow) {
  test(name, () => {
    const graph = fixture();
    mutate(graph);
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
  });
}

test('a parallel-review flow is returned unchanged with a default director decision at the loop limit', () => {
  const graph = freeze(flow()),
    before = structuredClone(graph);
  assert.strictEqual(check(graph), graph);
  assert.deepEqual(graph, before);
  assert.equal(sendBack(graph).loop.atLimit, undefined);
  assert.equal(loopAtLimit(sendBack(graph).loop), 'ask-director');
  // Four nodes in the body, twice in parallel and three rounds; three nodes outside it.
  assert.deepEqual(flowEnvelope(graph), { nodes: 27, attemptSeconds: 570 });
});

test('task types are resolved by base step kind and their extra outcomes are usable', () => {
  const graph = flow();
  graph.edges[0].outcome = 'published';
  graph.edges[2].outcome = 'integrated';
  byKey(graph, 'work').step = {
    receives: { library: 'none' },
    proposes: { library: false },
    acceptance: { acceptOver: false },
  };
  assert.strictEqual(check(graph), graph);
  const called = [];
  validateFlowShape(graph, {
    stepOf: node => {
      called.push(node.key);
      return stepOf(node);
    },
  });
  assert.deepEqual(called, ['plan', 'work', 'review-a', 'review-b']);
});

test('review nodes produce accepted, passed and needs-work', () => {
  for (const outcome of ['accepted', 'passed', 'needs-work']) {
    const graph = chain();
    graph.nodes.push(agent('after'));
    graph.edges.push(edge('check', 'after', outcome));
    assert.strictEqual(check(graph), graph);
  }
});

test('agent, team and role owners can carry bounded work without a resource request', () => {
  for (const owner of [
    { type: 'agent', id: 'W-01' },
    { type: 'team', id: 'engineering' },
    { type: 'role', id: 'Editor.v2:lead' },
  ]) {
    const graph = chain();
    graph.nodes[0].owner = owner;
    assert.strictEqual(check(graph), graph);
  }
});

test('gates support all-pass, any-pass and director with the appropriate owner', () => {
  for (const rule of ['all-pass', 'any-pass', 'director']) {
    const graph = flow(),
      gate = byKey(graph, 'gate');
    gate.gate.rule = rule;
    gate.owner.type = rule === 'director' ? 'director' : 'studio';
    assert.strictEqual(check(graph), graph);
  }
});

test('loop boundaries and all explicit actions are accepted without changing the graph', () => {
  for (const limit of [1, 5])
    for (const atLimit of ['ask-director', 'stop', 'continue']) {
      const graph = chain();
      graph.edges.push(edge('check', 'draft', 'needs-work', { limit, atLimit }));
      graph.nodes.unshift(agent('start'));
      graph.edges.unshift(edge('start', 'draft'));
      const before = structuredClone(graph);
      assert.strictEqual(check(graph), graph);
      assert.equal(loopAtLimit(sendBack(graph).loop), atLimit);
      assert.deepEqual(graph, before);
    }
});

refuses(
  'an unknown owner type names the node',
  g => {
    byKey(g, 'work').owner.type = 'provider';
  },
  /Node work has an unknown owner/,
);
refuses(
  'an agent cannot own a gate',
  g => {
    byKey(g, 'gate').owner = { type: 'agent', id: 'W-01' };
  },
  /Node gate has an unknown owner/,
);
refuses(
  'a studio cannot own a task-type node',
  g => {
    byKey(g, 'work').owner = { type: 'studio' };
  },
  /Node work has an unknown owner/,
);
refuses(
  'a director gate cannot be studio-owned',
  g => {
    byKey(g, 'gate').gate.rule = 'director';
  },
  /Node gate has an unknown owner/,
);
refuses(
  'a for-each cannot be director-owned',
  g => {
    byKey(g, 'each').owner.type = 'director';
  },
  /Node each has an unknown owner/,
);
refuses(
  'an agent owner needs an id',
  g => {
    byKey(g, 'work').owner = { type: 'agent' };
  },
  /Node work has an unknown owner/,
);
refuses(
  'a team owner needs a nonempty id',
  g => {
    byKey(g, 'work').owner = { type: 'team', id: ' ' };
  },
  /Node work has an unknown owner/,
);
refuses(
  'a role follows the staffing role character rule',
  g => {
    byKey(g, 'work').owner.id = 'some role';
  },
  /Node work has an unknown owner/,
);
refuses(
  'the studio takes no id',
  g => {
    byKey(g, 'each').owner.id = 'studio';
  },
  /Node each has an unknown owner/,
);
refuses(
  'a resolver failure names the node and its unknown kind',
  g => {
    byKey(g, 'work').kind = 'fixture:missing';
  },
  /Node work has an unknown kind.*fixture:missing/,
);
refuses(
  'an unknown step override field is refused',
  g => {
    byKey(g, 'work').step = { run: true };
  },
  /Node work's step override takes only/,
);
refuses(
  'a step override cannot change the base kind',
  g => {
    byKey(g, 'work').step = { kind: 'review' };
  },
  /Node work's step override takes only/,
);
refuses(
  'an unknown step override value uses the contract check',
  g => {
    byKey(g, 'work').step = { receives: { library: 'some' } };
  },
  /Node work receives the library as one of/,
);
refuses(
  'a nested step override field is closed',
  g => {
    byKey(g, 'work').step = { proposes: { files: true } };
  },
  /Node work's proposes takes only library/,
);
refuses(
  'a step override boolean is checked',
  g => {
    byKey(g, 'work').step = { acceptance: { acceptOver: 'yes' } };
  },
  /Node work's acceptance.*true or false/,
);
refuses(
  'needs-work is not produced by work and the refusal lists its outcomes',
  g => {
    g.edges[2].outcome = 'needs-work';
  },
  /Edge work → review-a.*produces accepted, integrated/,
);
refuses(
  'every edge needs an outcome',
  g => {
    delete g.edges[2].outcome;
  },
  /Edge work → review-a waits for an outcome/,
);
refuses(
  'a milestone must be produced by the source',
  g => {
    g.edges[0].outcome = 'integrated';
  },
  /Edge plan → each.*produces accepted, published/,
);
refuses(
  'a node in a disconnected loop component is unreachable',
  g => {
    g.nodes.push(agent('lost-a'), agent('lost-b'));
    g.edges.push(edge('lost-a', 'lost-b'), edge('lost-b', 'lost-a', 'accepted', { limit: 1 }));
  },
  /Node lost-a is a node nothing can reach/,
);
refuses(
  'a forward cycle must declare its loop',
  g => {
    delete sendBack(g).loop;
  },
  /Edge \S+ → \S+ is in a cycle but is not a declared loop/,
);
refuses(
  'a loop needs a limit',
  g => {
    delete sendBack(g).loop.limit;
  },
  /Loop gate → work needs a limit of 1 to 5 rounds/,
);
refuses(
  'a loop limit of six is refused',
  g => {
    sendBack(g).loop.limit = 6;
  },
  /Loop gate → work needs a limit of 1 to 5 rounds/,
);
refuses(
  'a loop cannot point forward',
  g => {
    g.edges[0].loop = { limit: 1 };
  },
  /Loop plan → each must point back to an earlier node/,
);
refuses(
  'a loop cannot rely on another loop as its forward path',
  g => {
    g.edges.find(item => item.from === 'each').loop = { limit: 1 };
  },
  /Loop each → work must point back to an earlier node/,
);
refuses(
  'an invalid loop action is refused',
  g => {
    sendBack(g).loop.atLimit = 'retry';
  },
  /Loop gate → work needs atLimit/,
);
refuses(
  'a null action is not an omitted default',
  g => {
    sendBack(g).loop.atLimit = null;
  },
  /Loop gate → work needs atLimit/,
);
refuses(
  'a gate must follow only reviews',
  g => {
    g.edges.push(edge('work', 'gate'));
  },
  /Gate gate has no reviews before it/,
);
refuses(
  'a gate needs at least one incoming review',
  g => {
    delete sendBack(g).loop;
    g.edges = g.edges.filter(item => item.to !== 'gate');
  },
  /Gate gate has no reviews before it/,
);
refuses(
  'a gate needs its send-back edge',
  g => {
    g.edges = g.edges.filter(item => item.outcome !== 'needs-work');
  },
  /Gate gate needs an outgoing needs-work send-back edge/,
);
refuses(
  'a gate needs its passed edge',
  g => {
    g.edges = g.edges.filter(item => !(item.from === 'gate' && item.outcome === 'passed'));
  },
  /Gate gate needs an outgoing passed edge/,
);
refuses(
  'a gate rule is checked',
  g => {
    byKey(g, 'gate').gate.rule = 'majority';
  },
  /Gate gate needs a rule of all-pass, any-pass or director/,
);
refuses(
  'a gate reason must be bounded text',
  g => {
    byKey(g, 'gate').gate.reason = 'x'.repeat(401);
  },
  /Gate gate's reason/,
);

refuses(
  'the graph-v1 authored node ceiling is reused',
  g => {
    g.nodes = Array.from({ length: graphCeilings.nodes + 1 }, (_, i) => agent(`node-${i}`));
    g.edges = [];
  },
  new RegExp(`1 to ${graphCeilings.nodes} nodes.*node-${graphCeilings.nodes}`),
);
refuses(
  'the graph-v1 map width ceiling is reused',
  g => {
    byKey(g, 'each').items.maxWidth = graphCeilings.mapWidth + 1;
  },
  new RegExp(`For-each each needs a maxWidth from 1 to ${graphCeilings.mapWidth}`),
);
refuses(
  'widths and loops count toward the attempt-second ceiling',
  g => {
    for (const node of g.nodes.filter(node => node.owner.type === 'role')) {
      node.maxSeconds = 600;
      node.maxAttempts = 3;
    }
  },
  new RegExp(
    `node plan needs 27 nodes and 34200 attempt-seconds; the ceilings are ${graphCeilings.expandedNodes} and ${graphCeilings.attemptSeconds}`,
  ),
);
refuses(
  'loop rounds and width count control nodes toward the expanded ceiling',
  g => {
    byKey(g, 'each').items.maxWidth = 3;
  },
  new RegExp(`node plan needs 39 nodes.*ceilings are ${graphCeilings.expandedNodes}`),
);
refuses(
  'a declared envelope must cover the computed node count',
  g => {
    g.envelope = { nodes: 26 };
  },
  /node plan needs 27 nodes and 570 attempt-seconds, more than its envelope allows/,
);
refuses(
  'a declared envelope must cover the computed seconds',
  g => {
    g.envelope = { attemptSeconds: 569 };
  },
  /node plan needs 27 nodes and 570 attempt-seconds, more than its envelope allows/,
);
refuses(
  'an envelope cannot exceed the shared ceilings',
  g => {
    g.envelope = { attemptSeconds: graphCeilings.attemptSeconds + 1 };
  },
  /node plan's envelope allows at most/,
);

test('declared envelopes cover exact needs or reserve more within the ceilings', () => {
  const graph = flow();
  graph.envelope = { nodes: graphCeilings.expandedNodes, attemptSeconds: graphCeilings.attemptSeconds };
  assert.strictEqual(check(graph), graph);
  assert.deepEqual(flowEnvelope(graph), graph.envelope);
  graph.envelope = { nodes: 27, attemptSeconds: 570 };
  assert.strictEqual(check(graph), graph);
});

refuses(
  'a for-each source must match its only incoming edge',
  g => {
    byKey(g, 'each').items.from = 'work';
  },
  /For-each each needs exactly one incoming edge/,
);
refuses(
  'a for-each needs exactly one incoming edge',
  g => {
    g.edges.push(edge('plan', 'each', 'published'));
  },
  /For-each each needs exactly one incoming edge/,
);
refuses(
  'a for-each needs exactly one join',
  g => {
    byKey(g, 'join').join.from = 'missing';
  },
  /For-each each needs exactly one join node/,
);
refuses(
  'a join can only receive from its own body',
  g => {
    g.edges.push(edge('plan', 'join'));
  },
  /Join join must collect nodes from its for-each body each/,
);
refuses(
  'a join cannot collect an unknown for-each',
  g => {
    g.nodes.push({
      key: 'orphan',
      title: 'Orphan',
      kind: 'join',
      owner: { type: 'studio' },
      join: { from: 'missing', rule: 'all' },
    });
  },
  /Join orphan must collect nodes from its for-each body missing/,
);
refuses(
  'a join rule is checked',
  g => {
    byKey(g, 'join').join.rule = 'any';
  },
  /Join join rule must be all, or quorum with a minimum/,
);
refuses(
  'an all join takes no minimum',
  g => {
    byKey(g, 'join').join.min = 1;
  },
  /Join join rule must be all, or quorum with a minimum/,
);
refuses(
  'a quorum join needs a minimum',
  g => {
    byKey(g, 'join').join.rule = 'quorum';
  },
  /Join join quorum minimum must be from 1/,
);
refuses(
  'a quorum minimum cannot exceed the width',
  g => {
    byKey(g, 'join').join = { from: 'each', rule: 'quorum', min: 3 };
  },
  /Join join quorum minimum must be from 1/,
);
test('a quorum join accepts a minimum within the full width', () => {
  const graph = flow();
  byKey(graph, 'join').join = { from: 'each', rule: 'quorum', min: 2 };
  assert.strictEqual(check(graph), graph);
});

refuses(
  'node objects are closed',
  g => {
    byKey(g, 'work').workerId = 'W-01';
  },
  /Node work takes only/,
);
refuses(
  'owner objects are closed',
  g => {
    byKey(g, 'work').owner.extra = true;
  },
  /Node work's owner takes only type, id/,
);
refuses(
  'edge objects are closed',
  g => {
    g.edges[0].milestone = 'accepted';
  },
  /Edge plan → each takes only/,
);
refuses(
  'loop objects are closed',
  g => {
    sendBack(g).loop.extra = true;
  },
  /Loop gate → work takes only/,
);
refuses(
  'items objects are closed',
  g => {
    byKey(g, 'each').items.extra = true;
  },
  /For-each each's items takes only/,
);
refuses(
  'join objects are closed',
  g => {
    byKey(g, 'join').join.transform = 'collect';
  },
  /Join join takes only/,
);
refuses(
  'gate objects are closed',
  g => {
    byKey(g, 'gate').gate.extra = true;
  },
  /Gate gate takes only/,
);
refuses(
  'envelope objects are closed',
  g => {
    g.envelope = { extra: true };
  },
  /node plan's envelope takes only/,
);
refuses(
  'keys must be safe identifiers',
  g => {
    byKey(g, 'work').key = 'not safe';
  },
  /Node not safe needs a safe key/,
);
refuses(
  'keys must be unique',
  g => {
    byKey(g, 'work').key = 'plan';
  },
  /Node plan repeats a node key/,
);
refuses(
  'titles are required on controller nodes',
  g => {
    delete byKey(g, 'each').title;
  },
  /Node each's title/,
);
refuses(
  'agent briefs are required',
  g => {
    byKey(g, 'work').brief = ' ';
  },
  /Node work's brief/,
);
refuses(
  'agent acceptance text is required',
  g => {
    delete byKey(g, 'work').acceptance;
  },
  /Node work's acceptance/,
);
refuses(
  'agent execution seconds are bounded',
  g => {
    byKey(g, 'work').maxSeconds = 4;
  },
  /Node work needs maxSeconds from 5 to 600/,
);
refuses(
  'agent retries are bounded',
  g => {
    byKey(g, 'work').maxAttempts = 4;
  },
  /Node work needs maxAttempts from 1 to 3/,
);
refuses(
  'resources must be safe names',
  g => {
    byKey(g, 'work').resources = ['../../outside'];
  },
  /Node work needs a list of at most 10 safe resource names/,
);
refuses(
  'tiers come from the existing catalog',
  g => {
    byKey(g, 'work').tier = 'maximum';
  },
  /Node work needs a tier of/,
);
refuses(
  'distinctFrom must be distinct keys',
  g => {
    byKey(g, 'work').distinctFrom = ['plan', 'plan'];
  },
  /Node work's distinctFrom must list distinct node keys/,
);
refuses(
  'items cannot be attached to an agent node',
  g => {
    byKey(g, 'work').items = { from: 'plan', maxWidth: 1 };
  },
  /Node work can have items only when its kind is for-each/,
);
refuses(
  'duplicate edges include their outcome',
  g => {
    g.edges.push({ ...g.edges[0] });
  },
  /Edge plan → each repeats the outcome accepted/,
);
refuses(
  'self edges are refused',
  g => {
    g.edges.push(edge('work', 'work'));
  },
  /Edge work → work must connect two different existing nodes/,
);
refuses(
  'missing edge endpoints are refused',
  g => {
    g.edges.push(edge('work', 'missing'));
  },
  /Edge work → missing must connect two different existing nodes/,
);

test('different outcomes may connect the same two nodes', () => {
  const graph = flow();
  graph.edges.push(edge('review-a', 'gate', 'needs-work'));
  assert.strictEqual(check(graph), graph);
});

test('a loop multiplies only nodes on a path back to its source', () => {
  const graph = {
    schemaVersion: GRAPH_V2_SCHEMA,
    nodes: [agent('start'), agent('draft'), agent('review', 'fixture:review'), agent('bypass'), agent('finish')],
    edges: [
      edge('start', 'draft'),
      edge('draft', 'review'),
      edge('draft', 'bypass'),
      edge('bypass', 'finish'),
      edge('review', 'finish'),
      edge('review', 'draft', 'needs-work', { limit: 2 }),
    ],
  };
  assert.strictEqual(check(graph), graph);
  assert.deepEqual(flowEnvelope(graph), { nodes: 9, attemptSeconds: 270 });
});

test('nested for-each bodies multiply widths and stop at their own joins', () => {
  const graph = {
    schemaVersion: GRAPH_V2_SCHEMA,
    nodes: [
      agent('plan', 'fixture:plan'),
      {
        key: 'outer',
        title: 'Outer items',
        kind: 'for-each',
        owner: { type: 'studio' },
        items: { from: 'plan', maxWidth: 2 },
      },
      agent('split', 'fixture:plan'),
      {
        key: 'inner',
        title: 'Inner items',
        kind: 'for-each',
        owner: { type: 'studio' },
        items: { from: 'split', maxWidth: 2 },
      },
      agent('work'),
      {
        key: 'inner-join',
        title: 'Collect inner',
        kind: 'join',
        owner: { type: 'studio' },
        join: { from: 'inner', rule: 'all' },
      },
      {
        key: 'outer-join',
        title: 'Collect outer',
        kind: 'join',
        owner: { type: 'studio' },
        join: { from: 'outer', rule: 'all' },
      },
    ],
    edges: [
      edge('plan', 'outer'),
      edge('outer', 'split'),
      edge('split', 'inner'),
      edge('inner', 'work'),
      edge('work', 'inner-join'),
      edge('inner-join', 'outer-join'),
    ],
  };
  assert.strictEqual(check(graph), graph);
  assert.deepEqual(flowEnvelope(graph), { nodes: 13, attemptSeconds: 210 });
});

refuses(
  'the shared edge ceiling is checked before traversing the graph',
  g => {
    g.edges = Array.from({ length: graphCeilings.edges + 1 }, () => edge('plan', 'each'));
  },
  new RegExp(`node plan has at most ${graphCeilings.edges} edges`),
);

test('graph-v1 still refuses graph-v2 by schema version', () => {
  assert.throws(() => validateGraphShape(flow()), { message: 'schemaVersion must be graph-v1.' });
});
