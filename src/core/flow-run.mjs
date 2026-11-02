// Running a graph-v2 flow for a group (1.2): the controller records which flow and revision a group runs and makes
// each node whose inputs are met an ordinary task, which the scheduler runs as it runs any other work. Gate, for-each
// and join nodes are the controller's own and get no task. A flow record is a setting (`flow:<groupId>`, schemaVersion
// flow-run-v1) like a run record, so no database schema changes. Every write to it goes through writeFlow, which
// raises its sequence and puts the change on the change stream with the group's ID. Nothing calls this module from a
// route yet: the workflow routes still refuse graph-v2. Tasks without flowReference, stage templates and graph-v1 runs
// are untouched.
import { randomUUID } from 'node:crypto';
import { validateFlow } from './graph-v2.mjs';
import { staff } from './staffing.mjs';
import { projectOrganization } from './project-organization.mjs';
import { seenBy } from './project-agents.mjs';

export const FLOW_RUN_SCHEMA = 'flow-run-v1';
const controllerKinds = ['gate', 'for-each', 'join'];
const identity = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/;
export const flowKey = groupId => 'flow:' + groupId;

// A node's state as its task shows it: waiting until it has a task, then ready, working, review, accepted or failed.
const taskStates = {
  ready: 'ready',
  blocked: 'ready',
  running: 'working',
  stopping: 'working',
  review: 'review',
  done: 'accepted',
  failed: 'failed',
  cancelled: 'failed',
  denied: 'failed',
};

// Every write of a flow record, inside the caller's transaction: the record must carry the sequence it was read at,
// which goes up by one; the change stream names the group with its new sequence, and the Activity log says what
// changed in plain words. Returns the record as written.
export function writeFlow(store, record, message, taskId = null) {
  const current = store.setting(flowKey(record.groupId))?.sequence ?? 0;
  if (record.sequence !== current) throw new Error('This flow changed since it was read. Read it again.');
  const next = { ...record, sequence: current + 1 };
  store.putSetting(flowKey(record.groupId), next);
  store.changed({ type: 'flow', id: record.groupId, projectId: record.projectId, sequence: next.sequence });
  store.event('flow', taskId, null, message, record.projectId);
  return next;
}

export function flowRecord(store, groupId) {
  return store.setting(flowKey(groupId));
}

// A node's owner as staffing reads it: an agent is its own worker; a role is a staffing role, or a job title when no
// member holds it as a staffing role (validateFlow accepts both); a team is one of its enabled project members, the
// task type's default owner first. Separation of duties excludes the workers in `exclude`.
function staffOwner(org, registries, projectId, node, exclude) {
  const { type, id } = node.owner,
    kind = node.kind,
    members = org.workers.filter(worker => seenBy(worker, projectId)),
    original = chosen => ({ ...chosen, worker: members.find(worker => worker.id === chosen.worker.id) });
  if (type === 'agent') return staff({ ...org, workers: members }, registries, { kind, workerId: id, exclude });
  if (type === 'role') {
    if (members.some(worker => worker.roles?.includes(id)))
      return staff({ ...org, workers: members }, registries, { kind, role: id, exclude });
    const titled = members.filter(worker => worker.jobTitle === id).map(worker => ({ ...worker, roles: [id] }));
    return original(staff({ ...org, workers: titled }, registries, { kind, role: id, exclude }));
  }
  // Without roles, staffing weighs only the kind's default owner and then the team's members in order.
  const team = members.filter(worker => worker.teamId === id).map(worker => ({ ...worker, roles: [] }));
  let chosen;
  try {
    chosen = original(
      staff({ ...org, workers: team }, registries, { kind, exclude, fallbacks: team.map(worker => worker.id) }),
    );
  } catch {
    const others = exclude.length ? ` other than ${exclude.join(', ')}` : '';
    throw new Error(`No enabled member of team ${id} can run ${registries.workflows.get(kind).label}${others}.`);
  }
  return { worker: chosen.worker, staffing: { by: 'team', team: id, ...(exclude.length ? { exclude } : {}) } };
}

// The agents a node must not run as. Separation of duties is mutual: the agents of the nodes its distinctFrom names,
// then those of the nodes whose distinctFrom names it, so a separation holds whichever of the two is staffed first.
// `workerOf` names the agent of a node's task, or null while that node has none.
function separation(graph, node, workerOf) {
  const named = (node.distinctFrom || []).filter(key => key !== node.key),
    naming = graph.nodes.filter(other => other.key !== node.key && other.distinctFrom?.includes(node.key));
  return [...new Set([...named.map(workerOf), ...naming.map(other => workerOf(other.key))].filter(Boolean))];
}

// The start nodes in the order they are staffed: each after the start nodes its distinctFrom names, otherwise in the
// graph's order, so a declared separation staffs the same agents however the graph lists its nodes and each task
// records the exclusions it declared. A cycle of distinctFrom is cut where it closes; separation covers it both ways.
function staffingOrder(ready) {
  const byKey = new Map(ready.map(node => [node.key, node])),
    seen = new Set(),
    order = [];
  const visit = node => {
    if (seen.has(node.key)) return;
    seen.add(node.key);
    for (const key of node.distinctFrom || []) if (byKey.has(key)) visit(byKey.get(key));
    order.push(node);
  };
  ready.forEach(visit);
  return order;
}

// One node's task, built the way materializeWorkflow builds a step's task, staffed by the node's owner other than the
// agents in `exclude`.
function nodeTask(store, registries, record, node, round, exclude) {
  const org = projectOrganization(store, record.projectId);
  let staffed;
  try {
    staffed = staffOwner(org, registries, record.projectId, node, exclude);
  } catch (error) {
    throw new Error(`Node ${node.key}: ${error.message}`);
  }
  const { worker, staffing } = staffed;
  return {
    id: 'T-' + randomUUID().slice(0, 8),
    kind: node.kind,
    title: node.title,
    brief: node.brief,
    acceptance: node.acceptance,
    workerId: worker.id,
    ...(staffing ? { staffing } : {}),
    ...(node.tier ? { tier: node.tier } : {}),
    resources: [...(node.resources || [])],
    maxSeconds: node.maxSeconds,
    maxAttempts: node.maxAttempts,
    ...(node.inputData !== undefined ? { inputData: structuredClone(node.inputData) } : {}),
    projectId: record.projectId,
    directorInputs: [],
    team: worker.team,
    goalId: null,
    dependencies: [],
    status: 'ready',
    direction: record.brief ? `Director brief for this flow: ${record.brief}` : '',
    reason: '',
    hold: false,
    queued: true,
    lastAttemptId: null,
    createdAt: new Date().toISOString(),
    flowReference: { flowId: record.flowId, revision: record.revision, node: node.key, round, group: record.groupId },
  };
}

function checkStart(store, { projectId, groupId, flow, brief = '' }) {
  store.project(projectId);
  if (typeof groupId !== 'string' || !identity.test(groupId))
    throw new Error('A flow group needs an ID of 1 to 120 letters, digits, _ . : or -.');
  if (
    !flow ||
    typeof flow !== 'object' ||
    Array.isArray(flow) ||
    Object.keys(flow).some(field => !['id', 'revision', 'graph'].includes(field))
  )
    throw new Error('A flow to start takes only id, revision and graph.');
  if (typeof flow.id !== 'string' || !identity.test(flow.id))
    throw new Error('A flow needs an ID of 1 to 120 letters, digits, _ . : or -.');
  if (!Number.isInteger(flow.revision) || flow.revision < 1) throw new Error('A flow needs a revision of 1 or more.');
  if (typeof brief !== 'string' || brief.length > 4000)
    throw new Error('A flow brief is text of at most 4000 characters.');
  refuseRunning(store, groupId);
}

// A group runs one flow.
function refuseRunning(store, groupId) {
  const existing = flowRecord(store, groupId);
  if (existing) throw new Error(`Group ${groupId} already runs flow ${existing.flowId} revision ${existing.revision}.`);
}

// Starts a flow for a group: checks it against the project (validateFlow), refuses a group that already has a flow,
// and in one transaction records the flow and creates a task for each node with no incoming ordinary edge, and only
// those, keeping every separation of duties declared between them. A refusal writes nothing. Returns the group, its
// new tasks' IDs in the graph's order and the flow's envelope.
export function startFlow(store, registries, { projectId, groupId, flow, brief = '' } = {}) {
  checkStart(store, { projectId, groupId, flow, brief });
  const { graph } = flow,
    envelope = validateFlow(store, registries, graph, projectId),
    createdAt = new Date().toISOString(),
    record = {
      schemaVersion: FLOW_RUN_SCHEMA,
      projectId,
      groupId,
      flowId: flow.id,
      revision: flow.revision,
      graph: structuredClone(graph),
      envelope,
      ...(brief.trim() ? { brief: brief.trim() } : {}),
      createdAt,
      nodes: Object.fromEntries(
        graph.nodes.map(node => [node.key, { key: node.key, taskId: null, round: 0, state: 'waiting' }]),
      ),
      sequence: 0,
    };
  const ready = graph.nodes.filter(
      node =>
        !controllerKinds.includes(node.kind) &&
        !graph.edges.some(edge => edge.to === node.key && edge.loop === undefined),
    ),
    staffed = new Map();
  const workerOf = key => staffed.get(key)?.workerId ?? null;
  for (const node of staffingOrder(ready))
    staffed.set(node.key, nodeTask(store, registries, record, node, 1, separation(graph, node, workerOf)));
  const tasks = ready.map(node => staffed.get(node.key));
  for (const node of ready)
    record.nodes[node.key] = { key: node.key, taskId: staffed.get(node.key).id, round: 1, state: 'ready' };
  const others = graph.nodes.length - ready.length,
    titles = tasks.map(task => task.title).join(', '),
    later = !others
      ? ''
      : others === 1
        ? '; 1 other step waits for its inputs'
        : `; ${others} other steps wait for their inputs`,
    message = `Started flow ${flow.id} revision ${flow.revision}. ${titles} can start now${later}.`;
  const written = store.tx(() => {
    refuseRunning(store, groupId);
    tasks.forEach(task => store.putTask(task));
    const saved = writeFlow(store, record, message);
    // The scheduler runs queued work only while the pipeline is on; a project the director paused still waits.
    const org = store.organization();
    if (!org.pipelineEnabled) {
      org.pipelineEnabled = true;
      store.setOrganization(org);
    }
    return saved;
  });
  return { groupId, taskIds: tasks.map(task => task.id), envelope, sequence: written.sequence };
}

function taskOf(store, id) {
  try {
    return id ? store.task(id) : null;
  } catch {
    return null;
  }
}

// Whether a node can still change: it waits, runs or is in Review, or its task stopped with attempts left. Accepted,
// denied and cancelled work, and failed work with no attempts left, is settled.
function open(store, registries, state, task) {
  if (!task) return state === 'waiting';
  if (state === 'accepted' || ['denied', 'cancelled'].includes(task.status)) return false;
  if (task.status !== 'failed') return true;
  const view = registries.workflows.stageView(task);
  return registries.workflows.stageAttempts(store, view).length < view.maxAttempts;
}

// A group's flow as the controller reads it now, or null when the group has none: the flow's identity and its nodes
// in the graph's order, each with its task (or none), round and state, and the group's state, building while any
// node is open.
export function readFlowGroup(store, registries, groupId) {
  const record = flowRecord(store, groupId);
  if (!record) return null;
  let building = false;
  const nodes = record.graph.nodes.map(node => {
    const entry = record.nodes[node.key],
      task = taskOf(store, entry.taskId),
      state = task ? taskStates[task.status] || 'waiting' : entry.state;
    if (open(store, registries, state, task)) building = true;
    return { key: node.key, title: node.title, taskId: entry.taskId ?? null, round: entry.round, state };
  });
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    groupId: record.groupId,
    flowId: record.flowId,
    revision: record.revision,
    createdAt: record.createdAt,
    sequence: record.sequence,
    state: building ? 'building' : 'settled',
    nodes,
  };
}
