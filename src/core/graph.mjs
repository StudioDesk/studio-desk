// Graph spec v1 and run records (MP-015 G2). A workflow is a versioned graph: nodes do
// bounded work and edges carry accepted results between them. Graphs are data, never
// agent-written code; the controller validates them. Each run keeps a record of the graph
// it executes, with a numbered revision for every expansion (proposed work, retries).
// Every executable node stays an ordinary task record.
import { recordProject, assertProject } from './projects.mjs';

export const GRAPH_SCHEMA = 'graph-v1';
// Code ceilings. A graph has at most 10 authored nodes; its envelope, which also covers the
// children its maps may create, tunes within the expanded ceilings.
export const graphCeilings = Object.freeze({
  nodes: 10,
  expandedNodes: 30,
  attemptSeconds: 3600,
  edges: 100,
  mapWidth: 20,
});
// Edge milestones name what the downstream node waits for: accepted by default, or a milestone
// the upstream node's task type defines (checked when the graph is saved).
const nodeFields = [
  'key',
  'title',
  'kind',
  'workerId',
  'role',
  'distinctFrom',
  'tier',
  'brief',
  'acceptance',
  'resources',
  'maxSeconds',
  'maxAttempts',
  'inputData',
  'map',
  'join',
  'gate',
];
function closed(value, allowed, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error(`${label} contains unsupported fields.`);
}
const bounded = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;

// Saved step lists load as plain chains: each step's dependencies become its incoming edges.
export function graphFromSteps(steps) {
  return {
    schemaVersion: GRAPH_SCHEMA,
    nodes: steps.map(({ dependencies, ...node }) => structuredClone(node)),
    edges: steps.flatMap(step => (step.dependencies || []).map(from => ({ from, to: step.key }))),
  };
}
export function stepsFromGraph(graph) {
  return graph.nodes.map(node => ({
    ...structuredClone(node),
    dependencies: graph.edges.filter(edge => edge.to === node.key).map(edge => edge.from),
  }));
}
// A workflow's graph: its saved graph, or its saved steps read as a chain. Nothing is rewritten.
export function workflowGraph(workflow) {
  return workflow.graph ? structuredClone(workflow.graph) : graphFromSteps(workflow.steps || []);
}

// Structural checks. Kinds, staffing, ports, limits and cycles are checked with the steps.
export function validateGraphShape(graph) {
  closed(graph, ['schemaVersion', 'nodes', 'edges', 'envelope'], 'Graph');
  if (graph.schemaVersion !== GRAPH_SCHEMA) throw new Error(`schemaVersion must be ${GRAPH_SCHEMA}.`);
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > graphCeilings.nodes)
    throw new Error(`A graph needs 1 to ${graphCeilings.nodes} nodes.`);
  graph.nodes.forEach(node => closed(node, nodeFields, 'Graph node'));
  const keys = new Set(graph.nodes.map(node => node.key));
  if (!Array.isArray(graph.edges) || graph.edges.length > graphCeilings.edges)
    throw new Error(`A graph has at most ${graphCeilings.edges} edges.`);
  const pairs = new Set();
  for (const edge of graph.edges) {
    closed(edge, ['from', 'to', 'milestone'], 'Graph edge');
    if (!keys.has(edge.from) || !keys.has(edge.to) || edge.from === edge.to)
      throw new Error('Each edge connects two different nodes of this graph.');
    if (pairs.has(`${edge.from}\n${edge.to}`)) throw new Error('Edges between the same nodes must be distinct.');
    pairs.add(`${edge.from}\n${edge.to}`);
    if (
      edge.milestone !== undefined &&
      (typeof edge.milestone !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(edge.milestone))
    )
      throw new Error('An edge milestone is a name such as accepted or integrated.');
  }
  if (graph.envelope !== undefined) {
    closed(graph.envelope, ['nodes', 'attemptSeconds'], 'Graph envelope');
    if (
      (graph.envelope.nodes !== undefined && !bounded(graph.envelope.nodes, graphCeilings.expandedNodes)) ||
      (graph.envelope.attemptSeconds !== undefined &&
        !bounded(graph.envelope.attemptSeconds, graphCeilings.attemptSeconds))
    )
      throw new Error(
        `A graph envelope allows at most ${graphCeilings.expandedNodes} nodes and ${graphCeilings.attemptSeconds} attempt-seconds.`,
      );
  }
  validateShapes(graph);
  return graph;
}
// Map and join (G3a). A map node is a template expanded over its single source's accepted
// item list; its only outgoing edge goes to the one join that collects its children.
function validateShapes(graph) {
  const byKey = new Map(graph.nodes.map(node => [node.key, node])),
    incoming = key => graph.edges.filter(edge => edge.to === key).map(edge => edge.from),
    outgoing = key => graph.edges.filter(edge => edge.from === key).map(edge => edge.to);
  for (const node of graph.nodes) {
    // A gate is a director decision before the node runs (G3c).
    if (node.gate !== undefined) {
      closed(node.gate, ['reason'], 'Gate');
      if (typeof node.gate.reason !== 'string' || !node.gate.reason.trim() || node.gate.reason.length > 400)
        throw new Error(`Gate ${node.key} needs a reason of at most 400 characters.`);
      if (node.map !== undefined)
        throw new Error(`Map ${node.key} is a template; gate its source or its join instead.`);
    }
    if (node.map !== undefined) {
      closed(node.map, ['from', 'maxWidth'], 'Map');
      if (node.join !== undefined) throw new Error(`Node ${node.key} cannot both map and join.`);
      if (!bounded(node.map.maxWidth, graphCeilings.mapWidth))
        throw new Error(`Map ${node.key} needs a maxWidth from 1 to ${graphCeilings.mapWidth}.`);
      const sources = incoming(node.key);
      if (sources.length !== 1 || sources[0] !== node.map.from || byKey.get(node.map.from)?.map)
        throw new Error(`Map ${node.key} needs exactly one incoming edge, from its source ${node.map.from}.`);
      const joins = graph.nodes.filter(other => other.join?.from === node.key);
      if (joins.length !== 1 || outgoing(node.key).join() !== joins[0].key)
        throw new Error(`Map ${node.key} needs exactly one join node and no other outgoing edges.`);
    }
    if (node.join !== undefined) {
      closed(node.join, ['from', 'rule', 'min', 'transform'], 'Join');
      const map = byKey.get(node.join.from);
      if (!map?.map || !incoming(node.key).includes(map.key))
        throw new Error(`Join ${node.key} must collect a map node it has an edge from.`);
      if (node.join.rule === 'all' ? node.join.min !== undefined : node.join.rule !== 'quorum')
        throw new Error(`Join ${node.key} rule must be all, or quorum with a minimum.`);
      if (node.join.rule === 'quorum' && !bounded(node.join.min, map.map.maxWidth))
        throw new Error(`Join ${node.key} quorum minimum must be from 1 to the map's width.`);
    }
  }
}
// Each map counts at its full width: maxWidth children, each with the template's limits.
function maxExpansion(graph) {
  return graph.nodes
    .filter(node => node.map)
    .reduce(
      (total, node) => ({
        nodes: total.nodes + node.map.maxWidth - 1,
        attemptSeconds: total.attemptSeconds + (node.map.maxWidth - 1) * node.maxSeconds * node.maxAttempts,
      }),
      { nodes: 0, attemptSeconds: 0 },
    );
}
// The limits a run is approved with: the declared envelope, which must cover the graph, or
// the graph's own needs. Approving the graph approves its envelope (MP-015 decision 1).
export function graphEnvelope(graph, budget) {
  const expansion = maxExpansion(graph),
    needed = {
      nodes: graph.nodes.length + expansion.nodes,
      attemptSeconds: budget.totalAttemptSeconds + expansion.attemptSeconds,
    };
  if (needed.nodes > graphCeilings.expandedNodes || needed.attemptSeconds > graphCeilings.attemptSeconds)
    throw new Error(
      `At full width the graph needs ${needed.nodes} nodes and ${needed.attemptSeconds} attempt-seconds; the ceilings are ${graphCeilings.expandedNodes} and ${graphCeilings.attemptSeconds}.`,
    );
  const envelope = { ...needed, ...(graph.envelope || {}) };
  if (envelope.nodes < needed.nodes || envelope.attemptSeconds < needed.attemptSeconds)
    throw new Error(
      `The graph needs ${needed.nodes} nodes and ${needed.attemptSeconds} attempt-seconds, more than its envelope allows.`,
    );
  return envelope;
}

// A gated task waits in Planned for the director. Approving it queues it so its run continues;
// autonomy never approves a gate, which may widen the limits the director approved.
export function gated(reason) {
  return {
    status: 'backlog',
    queued: false,
    queueOnApproval: true,
    reason: `Waiting for your decision: ${reason}`,
    approval: { status: 'pending', gate: true, reason },
  };
}

export function newRun({ id, projectId, workflow, brief, graph, envelope, taskIds, at }) {
  return {
    id,
    schemaVersion: 'run-v1',
    projectId,
    workflow: { id: workflow.id, name: workflow.name, version: workflow.version },
    ...(brief ? { brief } : {}),
    envelope,
    createdAt: at,
    revisions: [
      {
        revision: 1,
        at,
        reason: `Run created from workflow version ${workflow.version}.`,
        graph: structuredClone(graph),
        tasks: Object.fromEntries(taskIds),
      },
    ],
  };
}
// The run a task belongs to: the run that created it, or the run its proposal or retry joined.
export function runIdOf(task) {
  return task?.workflowReference?.runId || task?.runReference?.runId || null;
}
// Records work added to a run as its next revision and links the new tasks to it. Runs
// created before run records existed have no record and are left as they are.
export function expandRun(store, runId, { reason, source, tasks, details = {} }) {
  const run = runId && store.run(runId);
  if (!run || !tasks.length) return null;
  const revision = run.revisions.length + 1;
  run.revisions.push({
    revision,
    at: new Date().toISOString(),
    reason,
    source,
    added: tasks.map(task => ({
      taskId: task.id,
      ...(task.proposalReference?.key ? { key: task.proposalReference.key } : {}),
      kind: task.kind,
      title: task.title,
      workerId: task.workerId,
      dependencies: [...task.dependencies],
    })),
    ...details,
  });
  for (const task of tasks) {
    task.runReference = { runId, revision };
    // An idea sent with auto mode on or off starts the work added to its run the same way, unless the task chose.
    if (typeof run.autoMode === 'boolean' && typeof task.autoMode !== 'boolean') task.autoMode = run.autoMode;
  }
  store.putRun(run);
  return revision;
}

// The current graph of a run as task nodes, for views. Edges point at task IDs.
function runView(run, tasks) {
  const byId = new Map(tasks.map(task => [task.id, task])),
    nodes = [];
  const [created, ...expansions] = run.revisions;
  for (const node of created.graph.nodes) {
    const taskId = created.tasks[node.key],
      task = byId.get(taskId);
    // A map node is a template; its children appear with the revision that created them.
    if (!taskId) continue;
    nodes.push({
      taskId,
      key: node.key,
      kind: node.kind,
      title: task?.title || node.title,
      workerId: task?.workerId || node.workerId || null,
      dependencies: task
        ? [...task.dependencies]
        : created.graph.edges.filter(edge => edge.to === node.key).map(edge => created.tasks[edge.from]),
      revision: 1,
    });
  }
  for (const expansion of expansions)
    for (const added of expansion.added)
      nodes.push({ ...added, title: byId.get(added.taskId)?.title || added.title, revision: expansion.revision });
  return {
    id: run.id,
    projectId: run.projectId,
    workflow: run.workflow,
    ...(run.brief ? { brief: run.brief } : {}),
    envelope: run.envelope,
    createdAt: run.createdAt,
    revisions: run.revisions.map(({ revision, at, reason, source }) => ({
      revision,
      at,
      reason,
      ...(source ? { source } : {}),
    })),
    nodes,
    ...(run.legacy ? { legacy: true } : {}),
  };
}
// Runs created before run records existed, read from their tasks without writing anything.
function legacyRuns(tasks, recorded) {
  const groups = new Map();
  for (const task of tasks) {
    const reference = task.workflowReference;
    if (!reference?.runId || recorded.has(reference.runId)) continue;
    if (!groups.has(reference.runId)) groups.set(reference.runId, []);
    groups.get(reference.runId).push(task);
  }
  return [...groups.entries()].map(([id, all]) => {
    // Retry copies repeat their step's key; the earliest task stands for the step.
    const members = [...all]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .filter(
        (task, index, sorted) =>
          sorted.findIndex(other => other.workflowReference.key === task.workflowReference.key) === index,
      );
    const reference = members[0].workflowReference,
      keyOf = new Map(members.map(task => [task.id, task.workflowReference.key])),
      createdAt = members.map(task => task.createdAt).sort()[0];
    return {
      id,
      projectId: recordProject(members[0]),
      workflow: { id: reference.id, name: reference.name, version: reference.version },
      ...(reference.brief ? { brief: reference.brief } : {}),
      createdAt,
      legacy: true,
      revisions: [
        {
          revision: 1,
          at: createdAt,
          reason: 'Run created before run records; read from its tasks.',
          graph: graphFromSteps(
            members.map(task => ({
              key: task.workflowReference.key,
              title: task.title,
              kind: task.kind,
              workerId: task.workerId,
              dependencies: task.dependencies.filter(dependency => keyOf.has(dependency)).map(d => keyOf.get(d)),
            })),
          ),
          tasks: Object.fromEntries(members.map(task => [task.workflowReference.key, task.id])),
        },
      ],
    };
  });
}
// Archive is presentation metadata, separate from the immutable run graph and task state.
const archiveKey = (projectId, runId) => `run-archive:${projectId}:${runId}`;
export function runArchive(store, projectId, runId) {
  return store.setting(archiveKey(projectId, runId), { archived: false });
}

export function setRunArchived(store, registries, projectId, runId, archived, ownership = {}) {
  return store.tx(() => {
    store.project(projectId);
    const run = store.run(runId);
    if (!run) {
      const legacy = store.tasks().some(task => recordProject(task) === projectId && runIdOf(task) === runId);
      throw new Error(
        legacy ? 'Legacy runs without a persisted run-v1 record cannot be archived or restored.' : 'Run not found.',
      );
    }
    assertProject(store, run, projectId);
    if (run.schemaVersion !== 'run-v1') throw new Error('Only persisted run-v1 records support archive and restore.');
    if (archived) {
      // Include every revision, including proposed work, retries and fan-out children. Never
      // silently omit a missing recorded task or a task linked to this run outside the graph.
      const ids = new Set([
        ...Object.values(run.revisions[0].tasks).filter(Boolean),
        ...run.revisions.slice(1).flatMap(revision => (revision.added || []).map(node => node.taskId)),
        ...store
          .tasks()
          .filter(task => runIdOf(task) === runId)
          .map(task => task.id),
      ]);
      if (!ids.size) throw new Error('This run has no recorded tasks to settle.');
      for (const id of ids) {
        const task = store.task(id);
        assertProject(store, task, projectId);
        const attempts = store.attempts(id),
          attemptIds = new Set(attempts.map(attempt => attempt.id)),
          unsettled = reason => {
            throw new Error(`Run cannot be archived: ${id} ${reason}.`);
          };
        if (task.queued || task.approval?.status === 'pending') unsettled('has queued work or a pending decision');
        if (attempts.some(attempt => attempt.status === 'review')) unsettled('has a pending result decision');
        if (ownership.activeTaskIds?.includes(id) || ownership.pendingTaskId === id)
          unsettled('still has controller-owned work');
        if (attempts.some(attempt => ['running', 'stopping'].includes(attempt.status))) unsettled('has a live attempt');
        if (
          attempts.some(
            attempt => ['interrupted', 'quarantined', 'uncertain'].includes(attempt.status) && !attempt.reconciledAt,
          )
        )
          unsettled('needs attempt reconciliation');
        if (ownership.reservedTaskIds?.includes(id) || store.leases().some(lease => attemptIds.has(lease.attemptId)))
          unsettled('still holds a reservation');
        if (task.status === 'denied' && (task.closed || task.approval?.status === 'denied')) continue;
        if (task.status !== 'done') unsettled('is not accepted or explicitly closed');
        const accepted = attempts.find(attempt => attempt.id === task.acceptedAttemptId);
        if (!accepted || accepted.status !== 'accepted' || accepted.result?.outcome !== 'completed')
          unsettled('has no completed accepted attempt');
        assertProject(store, accepted, projectId);
        // The stage contract defines unfinished accepted work, including pending integration.
        // Templates normally remain Ready until their final acceptance; also check their
        // recorded completion marker rather than treating an earlier stage as final.
        if (
          registries.workflows.stagesOf(task)?.closable?.(store, task) ||
          (task.stageState && !task.stageState.complete)
        )
          unsettled('still has unfinished stages or integration');
      }
    }
    const previous = runArchive(store, projectId, runId);
    if (previous.archived === archived) return previous;
    const archive = {
      ...previous,
      archived,
      [archived ? 'archivedAt' : 'restoredAt']: new Date().toISOString(),
    };
    store.putSetting(archiveKey(projectId, runId), archive);
    return archive;
  });
}

export function projectRuns(store, projectId, tasks = store.tasks().filter(task => recordProject(task) === projectId)) {
  const recorded = store.runs(projectId);
  return [...recorded, ...legacyRuns(tasks, new Set(recorded.map(run => run.id)))]
    .map(run => ({
      ...runView(run, tasks),
      ...(!run.legacy && run.schemaVersion === 'run-v1' ? { archive: runArchive(store, projectId, run.id) } : {}),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
