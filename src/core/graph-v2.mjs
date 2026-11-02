// Shape checks, and checks against one project's organization and task types (validateFlow). graph-v2 is not
// executable or accepted by the workflow routes yet: they validate graph-v1 and refuse any other schemaVersion.
import { graphCeilings } from './graph.mjs';
import { complexityPolicy } from './contracts.mjs';
import { stepContract, validateStep } from './step-contract.mjs';
import { isRoleId } from './staffing.mjs';
import { TIERS } from './execution.mjs';
import { projectOrganization, projectCatalog } from './project-organization.mjs';
import { seenBy } from './project-agents.mjs';
import { itemListFormat } from './fanout.mjs';

export const GRAPH_V2_SCHEMA = 'graph-v2';
// A node may run as long, and be tried as often, as the longest build the studio gives a source change (complexity 8),
// and a flow at full width may spend ten authored nodes' worth of that limit. graph-v1 keeps its own ceilings.
const longestBuild = complexityPolicy[8];
export const flowCeilings = Object.freeze({
  nodes: graphCeilings.nodes,
  expandedNodes: graphCeilings.expandedNodes,
  edges: graphCeilings.edges,
  mapWidth: graphCeilings.mapWidth,
  maxSeconds: longestBuild.maxSeconds,
  maxAttempts: longestBuild.maxAttempts,
  attemptSeconds: graphCeilings.nodes * longestBuild.maxSeconds * longestBuild.maxAttempts,
});
const controllerKinds = ['gate', 'for-each', 'join'];
const agentOwners = ['agent', 'team', 'role'];
const nodeFields = [
  'key',
  'title',
  'kind',
  'owner',
  'step',
  'brief',
  'acceptance',
  'distinctFrom',
  'tier',
  'resources',
  'maxSeconds',
  'maxAttempts',
  'inputData',
  'items',
  'join',
  'gate',
];
const safeKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(value);
const bounded = (value, max, min = 1) => Number.isInteger(value) && value >= min && value <= max;
const milestone = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const nodeLabel = node => `Node ${node?.key ?? '(without a key)'}`;
const edgeLabel = edge => `${edge?.from ?? '?'} → ${edge?.to ?? '?'}`;

function closed(value, allowed, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error(`${label} takes only ${allowed.join(', ')}.`);
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} needs nonempty text of at most ${max} characters.`);
}

// Defaults are read, never written into the caller's saved graph.
export function loopAtLimit(loop) {
  return loop.atLimit === undefined ? 'ask-director' : loop.atLimit;
}

function checkNode(node, stepOf) {
  const label = nodeLabel(node);
  closed(node, nodeFields, label);
  if (!safeKey(node.key)) throw new Error(`${label} needs a safe key of 1 to 40 letters, digits, _ or -.`);
  text(node.title, 160, `${label}'s title`);
  if (typeof node.kind !== 'string' || !node.kind.trim()) throw new Error(`${label} has an unknown kind.`);
  const controller = controllerKinds.includes(node.kind);
  let step;
  try {
    // Resolver contract: { kind: <base step kind>, milestones: [<outcome name>, ...] }.
    step = controller ? { kind: node.kind, milestones: [] } : stepOf(node);
    validateStep({ kind: step.kind }, label);
    if (!Array.isArray(step.milestones) || !step.milestones.every(milestone)) throw new Error();
  } catch {
    throw new Error(`${label} has an unknown kind or step contract for ${node.kind}.`);
  }
  if (node.step !== undefined) {
    closed(node.step, ['receives', 'proposes', 'acceptance'], `${label}'s step override`);
    validateStep({ ...node.step, kind: step.kind }, label);
  }
  for (const [field, kind] of [
    ['gate', 'gate'],
    ['items', 'for-each'],
    ['join', 'join'],
  ])
    if (node[field] !== undefined && node.kind !== kind)
      throw new Error(`${label} can have ${field} only when its kind is ${kind}.`);

  if (node.kind === 'gate') {
    closed(node.gate, ['rule', 'reason'], `Gate ${node.key}`);
    if (!['all-pass', 'any-pass', 'director'].includes(node.gate.rule))
      throw new Error(`Gate ${node.key} needs a rule of all-pass, any-pass or director.`);
    text(node.gate.reason, 400, `Gate ${node.key}'s reason`);
  }
  closed(node.owner, ['type', 'id'], `${label}'s owner`);
  const ownedByAgent = agentOwners.includes(node.owner.type);
  const expected = !controller
    ? agentOwners
    : node.kind === 'gate' && node.gate.rule === 'director'
      ? ['director']
      : ['studio'];
  if (
    !expected.includes(node.owner.type) ||
    (ownedByAgent && (typeof node.owner.id !== 'string' || !node.owner.id.trim())) ||
    (node.owner.type === 'role' && !isRoleId(node.owner.id)) ||
    (!ownedByAgent && Object.hasOwn(node.owner, 'id'))
  )
    throw new Error(`${label} has an unknown owner for this kind of node.`);

  for (const field of ['brief', 'acceptance'])
    if (ownedByAgent || node[field] !== undefined) text(node[field], 24000, `${label}'s ${field}`);
  if ((ownedByAgent || node.maxSeconds !== undefined) && !bounded(node.maxSeconds, flowCeilings.maxSeconds, 5))
    throw new Error(`${label} needs maxSeconds from 5 to ${flowCeilings.maxSeconds}.`);
  if ((ownedByAgent || node.maxAttempts !== undefined) && !bounded(node.maxAttempts, flowCeilings.maxAttempts))
    throw new Error(`${label} needs maxAttempts from 1 to ${flowCeilings.maxAttempts}.`);
  if (
    node.distinctFrom !== undefined &&
    (!Array.isArray(node.distinctFrom) ||
      node.distinctFrom.length > flowCeilings.nodes ||
      new Set(node.distinctFrom).size !== node.distinctFrom.length ||
      !node.distinctFrom.every(safeKey))
  )
    throw new Error(`${label}'s distinctFrom must list distinct node keys.`);
  if (node.tier !== undefined && !TIERS.includes(node.tier))
    throw new Error(`${label} needs a tier of ${TIERS.join(', ')}.`);
  if (
    node.resources !== undefined &&
    (!Array.isArray(node.resources) ||
      node.resources.length > 10 ||
      node.resources.some(resource => typeof resource !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(resource)))
  )
    throw new Error(`${label} needs a list of at most 10 safe resource names.`);
  return {
    kind: step.kind,
    outcomes:
      step.kind === 'gate'
        ? ['passed', 'needs-work']
        : step.kind === 'review'
          ? ['accepted', 'passed', 'needs-work']
          : [...new Set(['accepted', ...step.milestones])],
  };
}

// All topology calculations use the forward graph; declared loops are checked against it.
function topology(graph) {
  const incoming = new Map(graph.nodes.map(node => [node.key, []])),
    outgoing = new Map(graph.nodes.map(node => [node.key, []]));
  for (const edge of graph.edges) {
    incoming.get(edge.to).push(edge);
    outgoing.get(edge.from).push(edge);
  }
  const reach = (start, { reverse = false, stop } = {}) => {
    const found = new Set(),
      pending = [start],
      edges = reverse ? incoming : outgoing;
    while (pending.length) {
      const key = pending.pop();
      if (key === stop || found.has(key)) continue;
      found.add(key);
      for (const edge of edges.get(key)) if (edge.loop === undefined) pending.push(reverse ? edge.from : edge.to);
    }
    return found;
  };
  return { incoming, outgoing, reach };
}

function checkConnections(graph, steps, links) {
  const { incoming, outgoing, reach } = links,
    visiting = new Set(),
    visited = new Set();
  const visit = key => {
    if (visited.has(key)) return;
    visiting.add(key);
    for (const edge of outgoing.get(key)) {
      if (edge.loop !== undefined) continue;
      if (visiting.has(edge.to)) throw new Error(`Edge ${edgeLabel(edge)} is in a cycle but is not a declared loop.`);
      visit(edge.to);
    }
    visiting.delete(key);
    visited.add(key);
  };
  graph.nodes.forEach(node => visit(node.key));
  for (const edge of graph.edges)
    if (edge.loop !== undefined && !reach(edge.to).has(edge.from))
      throw new Error(`Loop ${edgeLabel(edge)} must point back to an earlier node through non-loop edges.`);

  const reachable = new Set();
  for (const node of graph.nodes)
    if (!incoming.get(node.key).length) for (const key of reach(node.key)) reachable.add(key);
  for (const node of graph.nodes) {
    if (!reachable.has(node.key)) throw new Error(`Node ${node.key} is a node nothing can reach.`);
    if (node.kind !== 'gate') continue;
    const before = incoming.get(node.key),
      after = outgoing.get(node.key);
    if (!before.some(edge => edge.loop === undefined) || before.some(edge => steps.get(edge.from).kind !== 'review'))
      throw new Error(`Gate ${node.key} has no reviews before it.`);
    if (!after.some(edge => edge.outcome === 'passed'))
      throw new Error(`Gate ${node.key} needs an outgoing passed edge.`);
    if (!after.some(edge => edge.outcome === 'needs-work'))
      throw new Error(`Gate ${node.key} needs an outgoing needs-work send-back edge.`);
  }
}

function checkBodies(graph, links) {
  const byKey = new Map(graph.nodes.map(node => [node.key, node])),
    bodies = new Map();
  for (const node of graph.nodes) {
    if (node.kind === 'for-each') {
      closed(node.items, ['from', 'maxWidth'], `For-each ${node.key}'s items`);
      if (!bounded(node.items.maxWidth, flowCeilings.mapWidth))
        throw new Error(`For-each ${node.key} needs a maxWidth from 1 to ${flowCeilings.mapWidth}.`);
      const before = links.incoming.get(node.key);
      if (before.length !== 1 || before[0].from !== node.items.from || before[0].loop !== undefined)
        throw new Error(
          `For-each ${node.key} needs exactly one incoming edge, from its items source ${node.items.from}.`,
        );
      const joins = graph.nodes.filter(other => other.kind === 'join' && other.join?.from === node.key);
      if (joins.length !== 1) throw new Error(`For-each ${node.key} needs exactly one join node.`);
      const body = links.reach(node.key, { stop: joins[0].key });
      body.delete(node.key);
      if (!body.size || !links.reach(node.key).has(joins[0].key))
        throw new Error(`For-each ${node.key} needs a body leading to its join ${joins[0].key}.`);
      bodies.set(node.key, body);
    }
  }
  for (const node of graph.nodes) {
    if (node.kind !== 'join') continue;
    closed(node.join, ['from', 'rule', 'min'], `Join ${node.key}`);
    const source = byKey.get(node.join.from),
      body = bodies.get(node.join.from),
      before = links.incoming.get(node.key);
    if (!body || !before.length || before.some(edge => !body.has(edge.from)))
      throw new Error(`Join ${node.key} must collect nodes from its for-each body ${node.join.from}.`);
    if (node.join.rule === 'all' ? node.join.min !== undefined : node.join.rule !== 'quorum')
      throw new Error(`Join ${node.key} rule must be all, or quorum with a minimum.`);
    if (node.join.rule === 'quorum' && !bounded(node.join.min, source.items.maxWidth))
      throw new Error(`Join ${node.key} quorum minimum must be from 1 to the for-each's width.`);
  }
  return bodies;
}

function envelopeOf(graph, links, bodies) {
  const counts = new Map(graph.nodes.map(node => [node.key, 1]));
  for (const node of graph.nodes)
    if (node.kind === 'for-each')
      for (const key of bodies.get(node.key)) counts.set(key, counts.get(key) * node.items.maxWidth);
  for (const edge of graph.edges) {
    if (edge.loop === undefined) continue;
    const afterTarget = links.reach(edge.to),
      beforeSource = links.reach(edge.from, { reverse: true });
    for (const key of afterTarget) if (beforeSource.has(key)) counts.set(key, counts.get(key) * (edge.loop.limit + 1));
  }
  const needed = graph.nodes.reduce(
    (total, node) => ({
      nodes: total.nodes + counts.get(node.key),
      attemptSeconds:
        total.attemptSeconds +
        (agentOwners.includes(node.owner.type) ? counts.get(node.key) * node.maxSeconds * node.maxAttempts : 0),
    }),
    { nodes: 0, attemptSeconds: 0 },
  );
  if (needed.nodes > flowCeilings.expandedNodes || needed.attemptSeconds > flowCeilings.attemptSeconds)
    throw new Error(
      `At full width the graph from node ${graph.nodes[0].key} needs ${needed.nodes} nodes and ${needed.attemptSeconds} attempt-seconds; the ceilings are ${flowCeilings.expandedNodes} and ${flowCeilings.attemptSeconds}.`,
    );
  const envelope = { ...needed, ...graph.envelope };
  if (envelope.nodes < needed.nodes || envelope.attemptSeconds < needed.attemptSeconds)
    throw new Error(
      `The graph from node ${graph.nodes[0].key} needs ${needed.nodes} nodes and ${needed.attemptSeconds} attempt-seconds, more than its envelope allows.`,
    );
  return envelope;
}

// stepOf resolves a task type without consulting runtime state here; controller kinds need no resolver.
// Successful validation returns the identical graph, including omitted defaults and envelope.
export function validateFlowShape(graph, { stepOf } = {}) {
  closed(graph, ['schemaVersion', 'nodes', 'edges', 'envelope'], 'Graph');
  if (graph.schemaVersion !== GRAPH_V2_SCHEMA) throw new Error(`schemaVersion must be ${GRAPH_V2_SCHEMA}.`);
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > flowCeilings.nodes)
    throw new Error(
      `A graph needs 1 to ${flowCeilings.nodes} nodes${Array.isArray(graph.nodes) && graph.nodes.length ? `, including node ${graph.nodes.at(-1)?.key}` : ''}.`,
    );
  if (!Array.isArray(graph.edges) || graph.edges.length > flowCeilings.edges)
    throw new Error(`The graph at node ${graph.nodes[0]?.key} has at most ${flowCeilings.edges} edges.`);
  const steps = new Map();
  for (const node of graph.nodes) {
    const step = checkNode(node, stepOf);
    if (steps.has(node.key)) throw new Error(`Node ${node.key} repeats a node key.`);
    steps.set(node.key, step);
  }
  const seen = new Set();
  for (const edge of graph.edges) {
    const label = edgeLabel(edge);
    closed(edge, ['from', 'to', 'outcome', 'loop'], `Edge ${label}`);
    if (!steps.has(edge.from) || !steps.has(edge.to) || edge.from === edge.to)
      throw new Error(`Edge ${label} must connect two different existing nodes.`);
    const produces = steps.get(edge.from).outcomes;
    if (!milestone(edge.outcome) || !produces.includes(edge.outcome))
      throw new Error(
        `Edge ${label} waits for ${edge.outcome ?? 'an outcome'}, but its source produces ${produces.join(', ')}.`,
      );
    const identity = `${edge.from}\n${edge.to}\n${edge.outcome}`;
    if (seen.has(identity)) throw new Error(`Edge ${label} repeats the outcome ${edge.outcome}.`);
    seen.add(identity);
    if (edge.loop !== undefined) {
      closed(edge.loop, ['limit', 'atLimit'], `Loop ${label}`);
      if (!bounded(edge.loop.limit, 5)) throw new Error(`Loop ${label} needs a limit of 1 to 5 rounds.`);
      if (!['ask-director', 'stop', 'continue'].includes(loopAtLimit(edge.loop)))
        throw new Error(`Loop ${label} needs atLimit to be ask-director, stop or continue.`);
    }
  }
  if (graph.envelope !== undefined) {
    closed(graph.envelope, ['nodes', 'attemptSeconds'], `The graph at node ${graph.nodes[0].key}'s envelope`);
    if (
      (graph.envelope.nodes !== undefined && !bounded(graph.envelope.nodes, flowCeilings.expandedNodes)) ||
      (graph.envelope.attemptSeconds !== undefined &&
        !bounded(graph.envelope.attemptSeconds, flowCeilings.attemptSeconds))
    )
      throw new Error(
        `The graph at node ${graph.nodes[0].key}'s envelope allows at most ${flowCeilings.expandedNodes} nodes and ${flowCeilings.attemptSeconds} attempt-seconds.`,
      );
  }
  const links = topology(graph);
  checkConnections(graph, steps, links);
  const bodies = checkBodies(graph, links);
  envelopeOf(graph, links, bodies);
  return graph;
}

// For callers needing the approved envelope after shape validation; no saved data is rewritten.
export function flowEnvelope(graph) {
  const links = topology(graph);
  return envelopeOf(graph, links, checkBodies(graph, links));
}

// A flow checked against what one project has: each task type registered and enabled for it (its catalog), each owner
// an enabled agent on it, one of its teams or a role label its members use, and each for-each over a task type that
// produces an item list. Returns the flow's envelope. Nothing is saved or rewritten.
export function validateFlow(store, registries, graph, projectId) {
  const org = projectOrganization(store, projectId),
    enabled = new Set(projectCatalog(store, registries, projectId).map(definition => definition.kind)),
    members = org.workers.filter(worker => seenBy(worker, projectId));
  // The shape check reports any resolver failure as an unknown kind, so the project's own reason is kept here.
  let refusal = null;
  const stepOf = node => {
    const definition = registries.workflows.find(node.kind);
    refusal = !definition
      ? `Node ${node.key} names task type ${node.kind}, which is not registered.`
      : !enabled.has(node.kind)
        ? `Node ${node.key} names task type ${node.kind}, which this project has not enabled.`
        : null;
    if (refusal) throw new Error(refusal);
    return {
      kind: stepContract(definition).kind,
      milestones: registries.workflows.milestonesOf(node.kind).filter(name => name !== 'accepted'),
    };
  };
  try {
    validateFlowShape(graph, { stepOf });
  } catch (error) {
    throw refusal ? new Error(refusal) : error;
  }
  const byKey = new Map(graph.nodes.map(node => [node.key, node]));
  for (const node of graph.nodes) {
    const { type, id } = node.owner;
    if (type === 'agent' && !members.some(worker => worker.id === id))
      throw new Error(`Node ${node.key} names agent ${id}, who is not on this project.`);
    if (type === 'agent' && !members.some(worker => worker.id === id && worker.enabled))
      throw new Error(`Node ${node.key} names agent ${id}, who is not enabled on this project.`);
    if (type === 'team' && !org.teams.some(team => team.id === id))
      throw new Error(`Node ${node.key} names team ${id}, which this project does not have.`);
    if (type === 'role' && !members.some(worker => worker.roles?.includes(id) || worker.jobTitle === id))
      throw new Error(
        `Node ${node.key} names role ${id}, which no member of this project holds as a staffing role or job title.`,
      );
    // Supplied data as graph-v1 checks it: only a task type whose operation reads task data takes it.
    const definition = controllerKinds.includes(node.kind) ? null : registries.workflows.get(node.kind);
    if (definition?.operation?.source === 'task-data')
      try {
        registries.connectors.inputData(definition.operation, node.inputData);
      } catch (error) {
        throw new Error(`Node ${node.key}'s supplied data is refused: ${error.message}`);
      }
    else if (node.inputData !== undefined) throw new Error(`Node ${node.key} takes no supplied data.`);
    if (node.kind === 'for-each') {
      const source = byKey.get(node.items.from);
      if (
        controllerKinds.includes(source.kind) ||
        !registries.workflows.get(source.kind).produces?.includes(itemListFormat.id)
      )
        throw new Error(`For-each ${node.key} goes over ${source.key}, which does not produce an item list.`);
    }
  }
  return flowEnvelope(graph);
}
