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
import { stepContract } from './step-contract.mjs';

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
// agents in `exclude`. A node started after others depends on their accepted tasks, which are its inputs.
function nodeTask(store, registries, record, node, round, exclude, dependencies = []) {
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
    dependencies: [...dependencies],
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

function attemptOf(store, id) {
  try {
    return id ? store.attempt(id) : null;
  } catch {
    return null;
  }
}

// Whether a node can still change: it waits, runs or is in Review, its task stopped with attempts left, or its gate
// waits for the director. Accepted, denied and cancelled work, failed work with no attempts left, skipped nodes and
// decided gates are settled.
function open(store, registries, state, task) {
  if (!task) return state === 'waiting' || state === 'director';
  if (state === 'accepted' || ['denied', 'cancelled'].includes(task.status)) return false;
  if (task.status !== 'failed') return true;
  const view = registries.workflows.stageView(task);
  return registries.workflows.stageAttempts(store, view).length < view.maxAttempts;
}

const reviewOutcomes = ['accepted', 'passed', 'needs-work'];

// A review task's accepted verdict as its task type records it on the attempt (general work: workReviewVerdict), with
// its findings; null for a task whose type is not a review step.
function reviewOf(store, registries, task) {
  const definition = registries.workflows.find(task.kind);
  if (!definition || stepContract(definition).kind !== 'review') return null;
  const attempt = attemptOf(store, task.acceptedAttemptId),
    field = (definition.attemptFields || []).find(name => /Verdict$/.test(name)),
    verdict = attempt && field ? (attempt[field] ?? null) : null,
    findings = attempt && field ? attempt[field.replace(/Verdict$/, 'Findings')] : null;
  return {
    passed: verdict === 'pass' || verdict === 'passed',
    verdict,
    findings: Array.isArray(findings) ? structuredClone(findings) : [],
    summary: attempt?.result?.summary ?? '',
  };
}

// What a node settled as, or null while it can still change: the outcomes its edges can wait for and, in plain words,
// how it settled. A node whose task was denied, cancelled or failed with no attempts left settled without an outcome.
function settlement(store, registries, record, node) {
  const entry = record.nodes[node.key];
  if (entry.state === 'skipped') return { outcomes: [], how: 'was skipped' };
  if (node.kind === 'gate')
    return entry.decision?.outcome
      ? { outcomes: [entry.decision.outcome], how: `decided ${entry.decision.outcome}` }
      : null;
  if (controllerKinds.includes(node.kind)) return null;
  const task = taskOf(store, entry.taskId);
  if (!task) return null;
  if (task.status === 'done') {
    const review = reviewOf(store, registries, task),
      outcomes = ['accepted', ...(review ? [review.passed ? 'passed' : 'needs-work'] : [])];
    for (const name of registries.workflows.milestonesOf(task.kind))
      if (!reviewOutcomes.includes(name) && registries.workflows.reached(store, task, name)) outcomes.push(name);
    return {
      outcomes,
      done: true,
      review,
      how: !review ? 'was accepted' : review.passed ? 'passed its review' : 'asked for changes',
    };
  }
  if (open(store, registries, taskStates[task.status], task)) return null;
  return {
    outcomes: [],
    how: task.status === 'failed' ? 'failed with no attempts left' : `was ${task.status}`,
  };
}

// An edge fires once its source settled with its outcome, and can no longer fire once the source settled otherwise.
// A milestone after acceptance (such as integrated) may still be reached by an accepted task, so its edge waits.
function edgeState(settled, edge) {
  if (!settled) return 'pending';
  if (settled.outcomes.includes(edge.outcome)) return 'fired';
  if (settled.done && !reviewOutcomes.includes(edge.outcome)) return 'pending';
  return 'dead';
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// Follows a flow record's edges as far as they go now, changing the record in place: records each node that settled,
// skips the nodes that can no longer run (and those after them), decides each gate whose inputs all settled, starts
// each node whose ordinary inputs all fired and stops the flow where a loop edge fires. Returns the sentences that
// describe what changed and the tasks to create; nothing changed when there are none.
function followEdges(store, registries, record) {
  const { graph } = record,
    byKey = new Map(graph.nodes.map(node => [node.key, node])),
    changes = [],
    tasks = [];
  if (record.sentBack) return { changes, tasks };
  const settledOf = key => settlement(store, registries, record, byKey.get(key)),
    incomingOf = key => graph.edges.filter(edge => edge.to === key && edge.loop === undefined);
  // The tasks a node's inputs hold: a controller node passes on its own inputs' tasks.
  const inputTasks = (key, seen = new Set()) => {
    if (seen.has(key)) return [];
    seen.add(key);
    const entry = record.nodes[key];
    if (entry.taskId) return [entry.taskId];
    if (!controllerKinds.includes(byKey.get(key).kind)) return [];
    return incomingOf(key).flatMap(edge => inputTasks(edge.from, seen));
  };
  const workerOf = key => {
    const id = record.nodes[key]?.taskId;
    return (tasks.find(task => task.id === id) || taskOf(store, id))?.workerId ?? null;
  };
  let progressed = true;
  while (progressed) {
    progressed = false;
    // Each node's settlement, recorded once it settles (and again when an accepted task reaches a later milestone).
    for (const node of graph.nodes) {
      const entry = record.nodes[node.key];
      if (!entry.taskId) continue;
      const settled = settledOf(node.key);
      if (!settled || JSON.stringify(entry.outcomes) === JSON.stringify(settled.outcomes)) continue;
      const first = entry.outcomes === undefined;
      entry.outcomes = settled.outcomes;
      if (settled.review)
        entry.review = {
          verdict: settled.review.verdict,
          findings: settled.review.findings,
          summary: settled.review.summary,
        };
      changes.push(first ? `${node.title} ${settled.how}.` : `${node.title} reached ${settled.outcomes.at(-1)}.`);
    }
    // A loop edge that fires sends the group back; the next round is the rounds step's, so nothing more starts.
    for (const edge of graph.edges) {
      if (edge.loop === undefined || edgeState(settledOf(edge.from), edge) !== 'fired') continue;
      const source = byKey.get(edge.from),
        inputs = source.kind === 'gate' ? incomingOf(source.key).map(input => input.from) : [source.key],
        findings = inputs.map(key => ({
          node: key,
          taskId: record.nodes[key].taskId ?? null,
          verdict: record.nodes[key].review?.verdict ?? null,
          summary: record.nodes[key].review?.summary ?? '',
          findings: record.nodes[key].review?.findings ?? [],
        }));
      record.sentBack = { from: edge.from, to: edge.to, outcome: edge.outcome, at: new Date().toISOString(), findings };
      changes.push(
        `${source.title} sent the work back to ${byKey.get(edge.to).title} with the findings of ${plural(findings.length, 'input', 'inputs')}; nothing more starts until its next round.`,
      );
      return { changes, tasks };
    }
    for (const node of graph.nodes) {
      const entry = record.nodes[node.key];
      if (entry.taskId || entry.state === 'skipped' || entry.decision) continue;
      const incoming = incomingOf(node.key);
      if (!incoming.length) continue;
      const states = incoming.map(edge => [edge, settledOf(edge.from)]),
        dead = states.find(([edge, settled]) => edgeState(settled, edge) === 'dead');
      if (dead) {
        const [edge, settled] = dead;
        entry.state = 'skipped';
        entry.reason = `The edge ${edge.from} → ${edge.to} waits for ${edge.outcome}, and ${byKey.get(edge.from).title} ${settled.how}.`;
        changes.push(`Skipped ${node.title}: ${entry.reason}`);
        progressed = true;
        continue;
      }
      if (!states.every(([edge, settled]) => edgeState(settled, edge) === 'fired')) continue;
      if (node.kind === 'gate') {
        const inputs = incoming.map(edge => ({
            node: edge.from,
            taskId: record.nodes[edge.from].taskId ?? null,
            passed: !!settledOf(edge.from).review?.passed,
          })),
          passed = inputs.filter(input => input.passed).length,
          { rule, reason } = node.gate,
          at = new Date().toISOString(),
          tally = `${passed} of ${plural(inputs.length, 'review', 'reviews')} passed`;
        if (rule === 'director') {
          entry.decision = { rule, state: 'pending', reason, inputs, at };
          entry.state = 'director';
          changes.push(`${node.title} waits for the director's decision (${tally}): ${reason}`);
        } else {
          const outcome = (rule === 'all-pass' ? passed === inputs.length : passed > 0) ? 'passed' : 'needs-work';
          entry.decision = { rule, state: 'decided', outcome, reason, inputs, at };
          entry.state = outcome;
          changes.push(
            `${node.title} ${outcome === 'passed' ? 'passed' : 'needs work'} by the ${rule} rule: ${tally}.`,
          );
        }
        progressed = true;
        continue;
      }
      // For-each and join nodes are run by a later step of the flow engine.
      if (controllerKinds.includes(node.kind)) continue;
      const dependencies = [...new Set(incoming.flatMap(edge => inputTasks(edge.from)))].filter(
          id => taskOf(store, id)?.status === 'done',
        ),
        definition = registries.workflows.find(node.kind),
        independent = definition?.distinctFromInputs
          ? dependencies.map(id => attemptOf(store, taskOf(store, id).acceptedAttemptId)?.workerId).filter(Boolean)
          : [],
        exclude = [...new Set([...separation(graph, node, workerOf), ...independent])];
      let task;
      try {
        task = nodeTask(store, registries, record, node, 1, exclude, dependencies);
      } catch (error) {
        // A node nobody can run waits, with the reason, for the director to change the team.
        if (entry.reason !== error.message) {
          entry.reason = error.message;
          changes.push(`${node.title} cannot start: ${error.message}`);
        }
        continue;
      }
      tasks.push(task);
      delete entry.reason;
      Object.assign(entry, { taskId: task.id, round: 1, state: 'ready' });
      changes.push(`${node.title} can start now.`);
      progressed = true;
    }
  }
  return { changes, tasks };
}

function advanceGroup(store, registries, groupId, taskId = null, reference = null) {
  const stored = flowRecord(store, groupId);
  if (!stored || stored.schemaVersion !== FLOW_RUN_SCHEMA) return [];
  if (reference && (reference.flowId !== stored.flowId || reference.revision !== stored.revision)) return [];
  const record = structuredClone(stored),
    { changes, tasks } = followEdges(store, registries, record);
  if (!changes.length) return [];
  tasks.forEach(created => store.putTask(created));
  writeFlow(store, record, changes.join(' '), taskId);
  return tasks.map(created => created.id);
}

// Advances a settled task's flow inside the caller's transaction (the one that settles the task), so a settlement and
// the flow's next step are recorded together: its new tasks and one write of the flow record, which raises the
// group's sequence by one. A task without flowReference, or a flow with nothing to do, writes nothing. Returns the
// IDs of the tasks it created.
export function advanceFlow(store, registries, task) {
  const reference = task?.flowReference;
  if (!reference) return [];
  return advanceGroup(store, registries, reference.group, task.id, reference);
}

// Re-checks every open flow when readiness is refreshed: an accepted task may since have reached a milestone an edge
// waits for, or a flow task was denied or cancelled outside an attempt. Each flow that changed is written in its own
// transaction. Only flow records are read; with no flow there is nothing to do.
export function advanceOpenFlows(store, registries) {
  const ids = store.db
    .prepare("SELECT id FROM settings WHERE id LIKE 'flow:%'")
    .all()
    .map(row => row.id.slice('flow:'.length));
  const created = [];
  for (const groupId of ids) {
    const record = flowRecord(store, groupId);
    if (!record || record.schemaVersion !== FLOW_RUN_SCHEMA || record.sentBack) continue;
    created.push(...store.tx(() => advanceGroup(store, registries, groupId)));
  }
  return created;
}

// The group's state: sent-back once a loop edge fired; done once no node can change; in-review while every node with
// open work is a review, or a gate waits for the director; passed once a gate passed and the work after it runs;
// building otherwise.
function groupState(record, nodes, isOpen, reviewKeys) {
  if (record.sentBack) return 'sent-back';
  if (!isOpen.some(Boolean)) return 'done';
  const active = nodes.filter((node, index) => isOpen[index] && (node.taskId || node.state === 'director'));
  if (active.length && active.every(node => node.state === 'director' || reviewKeys.has(node.key))) return 'in-review';
  if (Object.values(record.nodes).some(entry => entry.decision?.outcome === 'passed')) return 'passed';
  return 'building';
}

// A group's flow as the controller reads it now, or null when the group has none: the flow's identity and its nodes
// in the graph's order, each with its task (or none), round and state, a skipped node with its reason and a gate with
// its decision, and the group's state: building, in-review, passed, sent-back (with the findings it was sent back
// with) or done.
export function readFlowGroup(store, registries, groupId) {
  const record = flowRecord(store, groupId);
  if (!record) return null;
  const isOpen = [],
    reviewKeys = new Set();
  const nodes = record.graph.nodes.map(node => {
    const entry = record.nodes[node.key],
      task = taskOf(store, entry.taskId),
      state = task ? taskStates[task.status] || 'waiting' : entry.state;
    isOpen.push(open(store, registries, state, task));
    const definition = controllerKinds.includes(node.kind) ? null : registries.workflows.find(node.kind);
    if (definition && stepContract(definition).kind === 'review') reviewKeys.add(node.key);
    return {
      key: node.key,
      title: node.title,
      taskId: entry.taskId ?? null,
      round: entry.round,
      state,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(node.kind === 'gate' ? { decision: entry.decision ? structuredClone(entry.decision) : null } : {}),
    };
  });
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    groupId: record.groupId,
    flowId: record.flowId,
    revision: record.revision,
    createdAt: record.createdAt,
    sequence: record.sequence,
    state: groupState(record, nodes, isOpen, reviewKeys),
    ...(record.sentBack ? { sentBack: structuredClone(record.sentBack) } : {}),
    nodes,
  };
}
