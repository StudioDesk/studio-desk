// Running a graph-v2 flow for a group (1.2): the controller records which flow and revision a group runs and makes
// each node whose inputs are met an ordinary task, which the scheduler runs as it runs any other work. Gate, for-each
// and join nodes are the controller's own and get no task. A flow record is a setting (`flow:<groupId>`, schemaVersion
// flow-run-v1) like a run record, so no database schema changes. Every write to it goes through writeFlow, which
// raises its sequence and puts the change on the change stream with the group's ID. Nothing calls this module from a
// route yet: the workflow routes still refuse graph-v2. Tasks without flowReference, stage templates and graph-v1 runs
// are untouched. A loop that fires runs the same tasks again as their next round (flowReference.round), and a loop at
// its limit does what its atLimit says; by default the director decides (decideFlow).
import { randomUUID } from 'node:crypto';
import { validateFlow, loopAtLimit } from './graph-v2.mjs';
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

const roundOf = task => task?.flowReference?.round ?? 1;

// A node's task in the node's current round, or null while it has none or its next round has not started yet: a loop
// moves the node to its next round first, and its task joins that round when its inputs are met again.
function currentTask(store, entry) {
  const task = taskOf(store, entry.taskId);
  return task && roundOf(task) === entry.round ? task : null;
}

// The nodes a key reaches through ordinary edges (or, reversed, the nodes that reach it), itself included.
function reach(graph, start, reverse = false) {
  const found = new Set(),
    pending = [start];
  while (pending.length) {
    const key = pending.pop();
    if (found.has(key)) continue;
    found.add(key);
    for (const edge of graph.edges)
      if (edge.loop === undefined && (reverse ? edge.to : edge.from) === key)
        pending.push(reverse ? edge.from : edge.to);
  }
  return found;
}

const loopKey = edge => `${edge.from}->${edge.to}`;
const bounded = (text, max = 24000) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const baseDirection = record => (record.brief ? `Director brief for this flow: ${record.brief}` : '');

// What a director may choose when a loop reaches its limit with atLimit ask-director.
export const LIMIT_CHOICES = Object.freeze([
  Object.freeze({ id: 'another-round', label: 'Run another round' }),
  Object.freeze({ id: 'accept-over', label: 'Accept it over the findings, with a reason' }),
  Object.freeze({ id: 'stop', label: 'Stop the flow' }),
]);

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

// What a node settled as in its current round, or null while it can still change: the outcomes its edges can wait for
// and, in plain words, how it settled. A node whose task was denied, cancelled or failed with no attempts left settled
// without an outcome. A review a loop at its limit passed over (entry.over) counts as passed.
function settlement(store, registries, record, node) {
  const entry = record.nodes[node.key];
  if (entry.state === 'skipped') return { outcomes: [], how: 'was skipped' };
  if (node.kind === 'gate')
    return entry.decision?.outcome
      ? { outcomes: [entry.decision.outcome], how: `decided ${entry.decision.outcome}` }
      : null;
  if (controllerKinds.includes(node.kind)) return null;
  const task = currentTask(store, entry);
  if (!task) return null;
  if (task.status === 'done') {
    const review = reviewOf(store, registries, task);
    let outcomes = ['accepted', ...(review ? [review.passed ? 'passed' : 'needs-work'] : [])];
    if (entry.over) outcomes = ['accepted', 'passed'];
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

// The nodes a loop runs again: those after its target and before its source through ordinary edges, both included.
function loopNodes(graph, edge) {
  const after = reach(graph, edge.to),
    before = reach(graph, edge.from, true);
  return graph.nodes.filter(node => after.has(node.key) && before.has(node.key)).map(node => node.key);
}

// The reviews a loop's source decided on (a gate's inputs, or the review itself), each with its verdict, summary and
// findings as its current round recorded them.
function loopFindings(record, edge) {
  const { graph } = record,
    source = graph.nodes.find(node => node.key === edge.from),
    inputs =
      source.kind === 'gate'
        ? graph.edges.filter(other => other.to === source.key && other.loop === undefined).map(other => other.from)
        : [source.key];
  return inputs.map(key => ({
    node: key,
    taskId: record.nodes[key].taskId ?? null,
    verdict: record.nodes[key].review?.verdict ?? null,
    summary: record.nodes[key].review?.summary ?? '',
    findings: record.nodes[key].review?.findings ?? [],
  }));
}

const passedVerdict = verdict => verdict === 'pass' || verdict === 'passed';

// A loop sends its work back: every node it runs again moves to the next round and waits for its inputs again (a
// gate's decision stays on record with its round), the target keeps the findings of the reviews that asked for
// changes for its next attempt's direction, and nodes after the loop that its round skipped may run once the next round
// settles. The tasks themselves join the round when their inputs are met (followEdges). Returns the sentence that says
// what happened.
function sendBack(record, edge) {
  const { graph } = record,
    byKey = new Map(graph.nodes.map(node => [node.key, node])),
    source = byKey.get(edge.from),
    target = byKey.get(edge.to),
    findings = loopFindings(record, edge),
    from = Math.max(record.nodes[edge.to].round, 1),
    round = from + 1,
    keys = loopNodes(graph, edge),
    loops = (record.loops ||= {}),
    loop = (loops[loopKey(edge)] ||= { from: edge.from, to: edge.to, limit: edge.loop.limit, sendBacks: 0 });
  loop.sendBacks += 1;
  for (const key of keys) {
    const entry = record.nodes[key];
    if (entry.decision) (entry.earlierDecisions ||= []).push(structuredClone(entry.decision));
    for (const field of ['decision', 'outcomes', 'review', 'reason', 'over', 'sentBack']) delete entry[field];
    Object.assign(entry, { round, state: 'waiting' });
  }
  for (const key of reach(graph, edge.to)) {
    const entry = record.nodes[key];
    if (keys.includes(key) || entry.state !== 'skipped' || entry.taskId) continue;
    if (graph.edges.some(other => other.to === key && other.loop === undefined && keys.includes(other.from))) {
      entry.state = 'waiting';
      delete entry.reason;
    }
  }
  const asked = findings.filter(item => !passedVerdict(item.verdict));
  record.nodes[edge.to].sentBack = {
    by: source.title,
    round: from,
    findings: (asked.length ? asked : findings).map(item => ({ ...item, title: byKey.get(item.node).title })),
  };
  record.sentBack = {
    from: edge.from,
    to: edge.to,
    outcome: edge.outcome,
    round: from,
    nextRound: round,
    at: new Date().toISOString(),
    findings,
  };
  return `${source.title} sent the work back to ${target.title} with the findings of ${plural(findings.length, 'input', 'inputs')}; round ${round} starts.`;
}

// The direction of a node's next round: the flow's brief and, for a loop's target, the findings that sent it back.
function roundDirection(record, entry) {
  const base = baseDirection(record),
    back = entry.sentBack;
  if (!back) return base;
  const text = item => (typeof item === 'string' ? item : JSON.stringify(item)),
    lines = back.findings.flatMap(item => [
      `- ${item.title} (${item.taskId ?? 'no task'}), verdict ${item.verdict ?? 'none'}: ${item.summary || 'no summary'}`,
      ...item.findings.map(finding => `  - ${text(finding)}`),
    ]);
  return bounded(
    [
      base,
      `Round ${entry.round}: ${back.by} sent this back after round ${back.round}. Your earlier attempts stay on record. Address the findings of each review that sent it back:\n${lines.join('\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

// A loop's source passes over its findings: a gate's decision becomes passed, recording who passed it over and why;
// a review counts as passed (entry.over). The source's passed edges fire on the next pass.
function passOver(record, edge, over) {
  const source = record.graph.nodes.find(node => node.key === edge.from),
    entry = record.nodes[edge.from],
    at = new Date().toISOString();
  if (source.kind === 'gate') {
    entry.decision = { ...entry.decision, outcome: 'passed', over: { ...over, outcome: entry.decision.outcome, at } };
    entry.state = 'passed';
  } else entry.over = { ...over, at };
}

// Follows a flow record's edges as far as they go now, changing the record in place: records each node that settled
// in its round, skips the nodes that can no longer run (and those after them), decides each gate whose inputs all
// settled, starts each node whose ordinary inputs all fired (a node a loop sent back runs its own task again as its
// next round), and does what a firing loop says: sends its work back while it has rounds left, and at its limit stops
// the flow, passes over its findings or asks the director (record.pending), which starts nothing until the director
// decides. Returns the sentences that describe what changed, the tasks to create and the tasks that run a new round;
// nothing changed when there are no sentences.
function followEdges(store, registries, record) {
  const { graph } = record,
    byKey = new Map(graph.nodes.map(node => [node.key, node])),
    changes = [],
    tasks = [],
    reruns = [];
  if (record.stopped || record.pending?.length) return { changes, tasks, reruns };
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
    return (
      (tasks.find(task => task.id === id) || reruns.find(task => task.id === id) || taskOf(store, id))?.workerId ?? null
    );
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
      // The work a loop sent back is no longer pending once its next round settled.
      if (record.sentBack?.to === node.key && entry.round === record.sentBack.nextRound) {
        (record.sendBacks ||= []).push(record.sentBack);
        delete record.sentBack;
      }
    }
    // A loop edge that fires sends its work back while it has rounds left; at its limit it does what atLimit says.
    for (const edge of graph.edges) {
      if (edge.loop === undefined || edgeState(settledOf(edge.from), edge) !== 'fired') continue;
      const source = byKey.get(edge.from),
        target = byKey.get(edge.to),
        used = record.loops?.[loopKey(edge)]?.sendBacks ?? 0;
      progressed = true;
      if (used < edge.loop.limit) {
        changes.push(sendBack(record, edge));
        continue;
      }
      const round = Math.max(record.nodes[edge.to].round, 1),
        at = new Date().toISOString(),
        reached = `${source.title} asked for changes again in round ${round}, and the loop back to ${target.title} reached its limit of ${plural(edge.loop.limit, 'round', 'rounds')}`,
        atLimit = loopAtLimit(edge.loop);
      if (atLimit === 'stop') {
        record.stopped = { by: 'loop', node: edge.from, round, at, reason: `${reached}.` };
        changes.push(`${reached}; the flow stopped, as the loop says.`);
        return { changes, tasks, reruns };
      }
      if (atLimit === 'continue') {
        const note = `${reached}; the flow continues past it, as the loop says.`;
        passOver(record, edge, { by: 'loop', note });
        changes.push(`${note} ${source.title} follows its passed edges.`);
        continue;
      }
      (record.pending ||= []).push({
        node: edge.from,
        from: edge.from,
        to: edge.to,
        outcome: edge.outcome,
        round,
        limit: edge.loop.limit,
        sendBacks: used,
        choices: LIMIT_CHOICES.map(choice => ({ ...choice })),
        findings: loopFindings(record, edge),
        at,
      });
      changes.push(
        `${reached}. The director decides: run another round, accept it over the findings with a reason, or stop the flow.`,
      );
    }
    // Nothing starts while the director decides.
    if (record.pending?.length) return { changes, tasks, reruns };
    for (const node of graph.nodes) {
      const entry = record.nodes[node.key],
        rerun = !!entry.taskId && entry.state === 'waiting';
      if ((entry.taskId && !rerun) || entry.state === 'skipped' || entry.decision) continue;
      const incoming = incomingOf(node.key);
      if (!incoming.length && !rerun) continue;
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
        if (!entry.round) entry.round = 1;
        if (rule === 'director') {
          entry.decision = { rule, state: 'pending', reason, inputs, round: entry.round, at };
          entry.state = 'director';
          changes.push(`${node.title} waits for the director's decision (${tally}): ${reason}`);
        } else {
          const outcome = (rule === 'all-pass' ? passed === inputs.length : passed > 0) ? 'passed' : 'needs-work';
          entry.decision = { rule, state: 'decided', outcome, reason, inputs, round: entry.round, at };
          entry.state = outcome;
          changes.push(
            `${node.title} ${outcome === 'passed' ? 'passed' : 'needs work'} by the ${rule} rule: ${tally}.`,
          );
        }
        // A loop from this gate acts before anything after the gate is skipped.
        progressed = true;
        break;
      }
      // For-each and join nodes are run by a later step of the flow engine.
      if (controllerKinds.includes(node.kind)) continue;
      const dependencies = [...new Set(incoming.flatMap(edge => inputTasks(edge.from)))].filter(
        id => (reruns.find(task => task.id === id) || taskOf(store, id))?.status === 'done',
      );
      if (rerun) {
        // The node's own task runs again as its next round: its attempts stay on record, and its attempt limit counts
        // this round's attempts only (WorkflowRegistry.stageAttempts). A task with stages starts the round at its
        // first stage, as a retry copy does (its stage state is cleared and recorded afresh when it is written).
        const task = taskOf(store, entry.taskId);
        task.flowReference = { ...task.flowReference, round: entry.round };
        Object.assign(task, { status: 'ready', reason: '', queued: true, controllerWait: false, dependencies });
        for (const field of ['acceptedAttemptId', 'autonomyNote']) delete task[field];
        registries.workflows.stagesOf(task)?.clear?.(task);
        registries.workflows.direct(task, roundDirection(record, entry));
        reruns.push(task);
        delete entry.reason;
        delete entry.sentBack;
        entry.state = 'ready';
        changes.push(`${node.title} runs round ${entry.round}.`);
        progressed = true;
        continue;
      }
      const definition = registries.workflows.find(node.kind),
        independent = definition?.distinctFromInputs
          ? dependencies.map(id => attemptOf(store, taskOf(store, id).acceptedAttemptId)?.workerId).filter(Boolean)
          : [],
        exclude = [...new Set([...separation(graph, node, workerOf), ...independent])],
        round = Math.max(entry.round, 1);
      let task;
      try {
        task = nodeTask(store, registries, record, node, round, exclude, dependencies);
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
      Object.assign(entry, { taskId: task.id, round, state: 'ready' });
      changes.push(`${node.title} can start now.`);
      progressed = true;
    }
  }
  return { changes, tasks, reruns };
}

// Writes what followEdges changed: new tasks as created, and a task starting a new round the way the orchestrator's
// putTask writes a stored task (its stage progress, then the task).
function putFlowTasks(store, registries, tasks, reruns) {
  tasks.forEach(created => store.putTask(created));
  for (const task of reruns) {
    registries.workflows.stageProgress(store, task);
    store.putTask(task);
  }
}

function advanceGroup(store, registries, groupId, taskId = null, reference = null, prefix = '') {
  const stored = flowRecord(store, groupId);
  if (!stored || stored.schemaVersion !== FLOW_RUN_SCHEMA) return [];
  if (reference && (reference.flowId !== stored.flowId || reference.revision !== stored.revision)) return [];
  const record = structuredClone(stored),
    { changes, tasks, reruns } = followEdges(store, registries, record);
  if (!changes.length) return [];
  putFlowTasks(store, registries, tasks, reruns);
  writeFlow(store, record, prefix + changes.join(' '), taskId);
  return tasks.map(created => created.id);
}

// Advances a settled task's flow inside the caller's transaction (the one that settles the task), so a settlement and
// the flow's next step are recorded together: its new tasks, the tasks that start a new round and one write of the
// flow record, which raises the group's sequence by one. A task without flowReference, or a flow with nothing to do,
// writes nothing. Returns the IDs of the tasks it created.
export function advanceFlow(store, registries, task) {
  const reference = task?.flowReference;
  if (!reference) return [];
  return advanceGroup(store, registries, reference.group, task.id, reference);
}

// Re-checks every open flow when readiness is refreshed: an accepted task may since have reached a milestone an edge
// waits for, or a flow task was denied or cancelled outside an attempt. Each flow that changed is written in its own
// transaction. Only flow records are read; with no flow there is nothing to do. A stopped flow never changes again.
export function advanceOpenFlows(store, registries) {
  const created = [];
  for (const groupId of flowGroupIds(store)) {
    const record = flowRecord(store, groupId);
    if (!record || record.schemaVersion !== FLOW_RUN_SCHEMA || record.stopped) continue;
    created.push(...store.tx(() => advanceGroup(store, registries, groupId)));
  }
  return created;
}

const flowGroupIds = store =>
  store.db
    .prepare("SELECT id FROM settings WHERE id LIKE 'flow:%'")
    .all()
    .map(row => row.id.slice('flow:'.length));

// Reconciles every open flow once when the controller starts (the Orchestrator's constructor, after it marked the
// attempts a stop cut off as interrupted): each node's recorded state and round are compared with its task through the
// same path advanceFlow takes. A task that settled while its flow was not advanced (a milestone reached while the
// controller was stopped) is followed once; a node whose task was interrupted stays as its task is, blocked until the
// director reconciles it, and is followed only when it settles; a gate decided for its round is never decided again; a
// pending director decision stays pending; a node that has a task in its round gets no second one. Recovery writes
// tasks only (the pipeline is paused at a restart) and starts no attempt. Each flow that changed is one flow event on
// the change stream with its group's ID and sequence; a flow that cannot be read is left as it is, with an event.
// Returns the IDs of the tasks it created.
export function recoverFlows(store, registries) {
  const created = [];
  for (const groupId of flowGroupIds(store)) {
    const record = flowRecord(store, groupId);
    if (!record || record.schemaVersion !== FLOW_RUN_SCHEMA || record.stopped) continue;
    try {
      created.push(
        ...store.tx(() => advanceGroup(store, registries, groupId, null, null, 'After the controller started again: ')),
      );
    } catch (error) {
      store.event(
        'flow',
        null,
        null,
        `The flow of group ${groupId} could not be checked after the controller started again and stays as it was: ${error.message}`,
        record.projectId,
      );
    }
  }
  return created;
}

// What a director may choose at a gate whose rule is director.
export const GATE_CHOICES = Object.freeze([
  Object.freeze({ id: 'pass', label: 'Pass' }),
  Object.freeze({ id: 'send-back', label: 'Send it back' }),
]);

const choiceWords = {
  'another-round': 'another round',
  'accept-over': 'to accept it over the findings',
  stop: 'to stop',
  pass: 'to pass it',
  'send-back': 'to send it back',
};

// Applies the director's answer to a loop at its limit, once, in one transaction: another-round sends the work back
// for one more round past the limit, accept-over (which needs a reason) passes over the findings and follows the
// source's passed edges, and stop records the group stopped. A decision already made, or one nothing waits for, is
// refused and writes nothing. Returns the group, the choice, the tasks that start and the flow's new sequence.
export function decideFlow(store, registries, groupId, { node, choice, reason = '' } = {}) {
  const gateChoice = GATE_CHOICES.some(item => item.id === choice);
  if (!gateChoice && !LIMIT_CHOICES.some(item => item.id === choice))
    throw new Error(`Choose ${[...LIMIT_CHOICES, ...GATE_CHOICES].map(item => item.id).join(', ')}.`);
  if (typeof reason !== 'string' || reason.length > 4000)
    throw new Error("A decision's reason is text of at most 4000 characters.");
  if (choice === 'accept-over' && !reason.trim()) throw new Error('Accepting over the findings needs a reason.');
  return store.tx(() => {
    const stored = flowRecord(store, groupId);
    if (!stored || stored.schemaVersion !== FLOW_RUN_SCHEMA) throw new Error(`Group ${groupId} runs no flow.`);
    const record = structuredClone(stored),
      source = record.graph.nodes.find(item => item.key === node);
    if (!source) throw new Error(`Flow ${record.flowId} has no node ${node}.`);
    if (gateChoice) {
      if (record.stopped) throw new Error(`The flow of group ${groupId} stopped.`);
      return decideGate(store, registries, record, source, choice, reason.trim());
    }
    const index = (record.pending || []).findIndex(item => item.node === node);
    if (index < 0) {
      const made = (record.directorDecisions || []).filter(item => item.node === node).at(-1);
      throw new Error(
        made
          ? `The director already decided ${choiceWords[made.choice]} for ${source.title} in round ${made.round}.`
          : `Nothing at ${source.title} waits for the director's decision.`,
      );
    }
    const [pending] = record.pending.splice(index, 1),
      edge = record.graph.edges.find(
        item => item.loop !== undefined && item.from === pending.from && item.to === pending.to,
      ),
      at = new Date().toISOString(),
      why = reason.trim();
    if (!record.pending.length) delete record.pending;
    (record.directorDecisions ||= []).push({
      node,
      round: pending.round,
      choice,
      ...(why ? { reason: why } : {}),
      at,
    });
    let change;
    if (choice === 'stop') {
      record.stopped = { by: 'director', node, round: pending.round, at, ...(why ? { reason: why } : {}) };
      change = `The director stopped the flow at ${source.title} in round ${pending.round}${why ? `: ${why}` : '.'}`;
    } else if (choice === 'another-round') {
      change = `The director chose another round past the loop's limit${why ? `: ${why}` : '.'} ${sendBack(record, edge)}`;
    } else {
      passOver(record, edge, { by: 'director', reason: why });
      change = `The director accepted ${source.title} over its findings in round ${pending.round}: ${why}`;
    }
    return followDecision(store, registries, record, choice, change);
  });
}

// Follows the edges after a director's decision and writes the flow once, inside the decision's transaction.
function followDecision(store, registries, record, choice, change) {
  const { changes, tasks, reruns } = followEdges(store, registries, record);
  putFlowTasks(store, registries, tasks, reruns);
  if (tasks.length || reruns.length) {
    // As when the flow started: the scheduler runs queued work only while the pipeline is on.
    const org = store.organization();
    if (!org.pipelineEnabled) {
      org.pipelineEnabled = true;
      store.setOrganization(org);
    }
  }
  const saved = writeFlow(store, record, [change, ...changes].join(' '));
  return {
    groupId: record.groupId,
    choice,
    taskIds: [...reruns, ...tasks].map(task => task.id),
    sequence: saved.sequence,
  };
}

// A director gate's decision for its round, once: pass follows its passed edges, send-back its needs-work edges (a loop
// among them sends the work back). A gate that waits for no decision, or one already decided, is refused.
function decideGate(store, registries, record, source, choice, reason) {
  const entry = record.nodes[source.key];
  if (source.kind !== 'gate' || entry.decision?.state !== 'pending')
    throw new Error(
      entry.decision?.state === 'decided'
        ? `${source.title} was already decided ${entry.decision.outcome} in round ${entry.decision.round}.`
        : `Nothing at ${source.title} waits for the director's decision.`,
    );
  const outcome = choice === 'pass' ? 'passed' : 'needs-work',
    at = new Date().toISOString();
  entry.decision = {
    ...entry.decision,
    state: 'decided',
    outcome,
    director: { choice, ...(reason ? { reason } : {}), at },
  };
  entry.state = outcome;
  (record.directorDecisions ||= []).push({
    node: source.key,
    round: entry.decision.round,
    choice,
    ...(reason ? { reason } : {}),
    at,
  });
  const change = `The director ${choice === 'pass' ? 'passed' : 'sent back'} ${source.title} in round ${entry.decision.round}${reason ? `: ${reason}` : '.'}`;
  return followDecision(store, registries, record, choice, change);
}

// Stops an open flow at the director's word, once, in one transaction: a pending decision is dropped, nothing new
// starts and work already running is not cancelled. A stopped or settled flow is refused and nothing is written.
export function stopFlow(store, registries, groupId, { reason = '' } = {}) {
  if (typeof reason !== 'string' || reason.length > 4000)
    throw new Error("A decision's reason is text of at most 4000 characters.");
  const why = reason.trim();
  return store.tx(() => {
    const stored = flowRecord(store, groupId);
    if (!stored || stored.schemaVersion !== FLOW_RUN_SCHEMA) throw new Error(`Group ${groupId} runs no flow.`);
    if (stored.stopped) throw new Error(`The flow of group ${groupId} already stopped.`);
    if (readFlowGroup(store, registries, groupId).state === 'done')
      throw new Error(`The flow of group ${groupId} already finished.`);
    const record = structuredClone(stored),
      at = new Date().toISOString();
    delete record.pending;
    record.stopped = { by: 'director', at, ...(why ? { reason: why } : {}) };
    (record.directorDecisions ||= []).push({ node: null, choice: 'stop', ...(why ? { reason: why } : {}), at });
    const saved = writeFlow(store, record, `The director stopped the flow${why ? `: ${why}` : '.'}`);
    return { groupId, choice: 'stop', taskIds: [], sequence: saved.sequence };
  });
}

// An action's body field, as the shared task actions write one (public/task-actions.js): its name, whether it is
// needed, what kind of value it is and the value the controller fills in.
const field = (name, required, kind, value) => ({ name, required, kind, ...(value === undefined ? {} : { value }) });

// A director's action on the flow itself. No route runs a flow yet, so it names the flow module's operation that
// performs it (decideFlow or stopFlow) and the fields that operation takes.
const flowAction = (record, key, label, operation, fields = []) => ({
  key,
  label,
  operation,
  fields: [field('groupId', true, 'id', record.groupId), ...fields],
});

// A node's task's own actions, the ones the story page offers on any task (public/task-actions.js, same keys, words
// and routes), for the states a flow's task passes through: reconcile an interrupted attempt, start work that waits,
// accept or ask to revise a result in Review, and cancel running work. A flow adds no task action of its own.
function taskNodeActions(store, task) {
  const id = encodeURIComponent(task.id),
    step = route => ({
      method: 'POST',
      path: `/api/tasks/${id}/${route}`,
      fields: [field('projectId', true, 'id', task.projectId)],
    }),
    live = ['running', 'stopping'].includes(task.status),
    unsettled = store
      .attempts(task.id)
      .some(attempt => ['interrupted', 'quarantined', 'uncertain'].includes(attempt.status) && !attempt.reconciledAt),
    actions = [];
  const offer = (key, label, request, fields = []) =>
    actions.push({ key, label, ...request, fields: [...request.fields, ...fields] });
  if (unsettled) offer('reconcile', 'Reconcile interrupted attempt', step('reconcile'));
  if (!live && !task.closed && !unsettled && ['ready', 'blocked', 'failed', 'cancelled'].includes(task.status))
    offer('start', 'Start assignment', step('start'), [field('direction', false, 'note')]);
  if (task.status === 'review') {
    offer('accept', 'Accept result', step('accept'), [field('overReason', false, 'reason')]);
    offer('revise', 'Request revision', step('revise'), [field('direction', true, 'note')]);
  }
  if (live) offer('cancel', 'Request cancellation', step('cancel'));
  return actions;
}

// What the director may do about one node now: a loop at its limit offers its choices, a director gate waiting for
// its decision offers pass and send back, and a node's task in its current round offers that task's own actions.
function nodeActions(store, record, node, task) {
  const choice = (item, reason = false) =>
    flowAction(record, item.id, item.label, 'decideFlow', [
      field('node', true, 'id', node.key),
      field('choice', true, 'text', item.id),
      field('reason', reason, 'reason'),
    ]);
  const actions = [];
  for (const pending of (record.pending || []).filter(item => item.node === node.key))
    actions.push(...pending.choices.map(item => choice(item, item.id === 'accept-over')));
  if (node.decision?.state === 'pending') actions.push(...GATE_CHOICES.map(item => choice(item)));
  if (task) actions.push(...taskNodeActions(store, task));
  return actions;
}

// The group's state: stopped once a loop or the director stopped it; in-review while the director decides a loop at
// its limit, every node with open work is a review, or a gate waits for the director; sent-back from a loop firing
// until the work it sent back settles its next round; done once no node can change; passed once a gate passed and
// the work after it runs; building otherwise.
function groupState(record, nodes, isOpen, reviewKeys) {
  if (record.stopped) return 'stopped';
  if (record.pending?.length) return 'in-review';
  if (record.sentBack) return 'sent-back';
  if (!isOpen.some(Boolean)) return 'done';
  const active = nodes.filter(
    (node, index) => isOpen[index] && ((node.taskId && node.state !== 'waiting') || node.state === 'director'),
  );
  if (active.length && active.every(node => node.state === 'director' || reviewKeys.has(node.key))) return 'in-review';
  if (Object.values(record.nodes).some(entry => entry.decision?.outcome === 'passed')) return 'passed';
  return 'building';
}

// A group's flow as the controller reads it now, or null when the group has none: the flow's identity and its nodes
// in the graph's order, each with its task (or none), round and state (waiting while its next round has not started),
// a skipped node with its reason and a gate with its decision in its round (and its earlier rounds' decisions), and
// the group's state: building, in-review, passed, sent-back (with the findings it was sent back with), stopped (with
// who stopped it and why) or done. A loop at its limit adds the director's pending decision with its choices, and the
// loops' send-backs and the director's decisions so far are listed.
export function readFlowGroup(store, registries, groupId) {
  const record = flowRecord(store, groupId);
  if (!record) return null;
  const isOpen = [],
    reviewKeys = new Set(),
    tasks = [];
  const nodes = record.graph.nodes.map(node => {
    const entry = record.nodes[node.key],
      task = currentTask(store, entry),
      state = task ? taskStates[task.status] || 'waiting' : entry.state;
    isOpen.push(open(store, registries, state, task));
    tasks.push(task);
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
      ...(entry.earlierDecisions ? { earlierDecisions: structuredClone(entry.earlierDecisions) } : {}),
    };
  });
  const state = groupState(record, nodes, isOpen, reviewKeys),
    settled = state === 'done' || state === 'stopped';
  nodes.forEach((node, index) => {
    node.actions = settled ? [] : nodeActions(store, record, node, tasks[index]);
  });
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    groupId: record.groupId,
    flowId: record.flowId,
    revision: record.revision,
    createdAt: record.createdAt,
    sequence: record.sequence,
    state,
    actions: settled
      ? []
      : [flowAction(record, 'stop', 'Stop the flow', 'stopFlow', [field('reason', false, 'reason')])],
    ...(record.sentBack ? { sentBack: structuredClone(record.sentBack) } : {}),
    ...(record.pending?.length ? { pending: structuredClone(record.pending) } : {}),
    ...(record.stopped ? { stopped: structuredClone(record.stopped) } : {}),
    ...(record.loops ? { loops: structuredClone(record.loops) } : {}),
    ...(record.directorDecisions ? { directorDecisions: structuredClone(record.directorDecisions) } : {}),
    nodes,
  };
}
