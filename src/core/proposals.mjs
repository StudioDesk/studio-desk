import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hash, validateResult, validateComplexityLimits } from './contracts.mjs';
import { artifactPath, acceptedReference, validateAcceptedReferences } from './artifacts.mjs';
import { assertProject, recordProject, validateTaskProject } from './projects.mjs';
import { validatePlan } from './planning.mjs';
import { projectOrganization, projectCatalog, assertProjectKind } from './project-organization.mjs';
import { unmetConsumes, portMessage } from './formats.mjs';
import { staffNodes } from './staffing.mjs';
import { expandRun, runIdOf } from './graph.mjs';
import { carryStoryClosed } from '../connectors/source-carries.mjs';

function readProposal(store, registries, source, attempt, proposalKey) {
  const definition = registries.workflows.get(source.kind);
  if (!definition.proposeWork) throw new Error('This result does not propose task records.');
  assertProject(store, attempt, recordProject(source));
  if (attempt.taskId !== source.id || attempt.result?.outcome !== 'completed')
    throw new Error('Choose a completed proposal attempt.');
  validateResult(attempt.result, definition.maxArtifacts);
  const readArtifact = relative => {
    const item = attempt.artifacts.find(item => item.path === relative);
    if (!item) throw new Error('Proposal artifact is not registered.');
    const contents = fs.readFileSync(artifactPath(store, attempt, relative));
    if (hash(contents) !== item.hash) throw new Error('Proposal artifact changed after validation.');
    return contents;
  };
  for (const item of attempt.artifacts) readArtifact(item.path);
  const checks = [],
    validation = definition.validateOutput({
      task: structuredClone(attempt.assignment),
      attempt: structuredClone(attempt),
      result: structuredClone(attempt.result),
      readArtifact,
      checks,
    });
  if (validation?.then) throw new Error('Proposal validators must complete synchronously.');
  const validatedChecks = [...checks, ...(validation?.checks === checks ? [] : validation?.checks || [])];
  validateResult({ ...attempt.result, checks: validatedChecks }, definition.maxArtifacts);
  if (
    !definition.acceptFailedChecks &&
    [...validatedChecks, ...attempt.result.checks].some(check => check.status === 'fail')
  )
    throw new Error('Failed work cannot propose executable tasks.');
  const org = projectOrganization(store, recordProject(source)),
    catalog = projectCatalog(store, registries, recordProject(source));
  const spec = definition.proposeWork({
    store,
    proposalKey,
    org,
    task: structuredClone(source),
    attempt: structuredClone(attempt),
    registries,
    project: store.project(recordProject(source)),
    readArtifact,
  });
  if (!spec || spec.then || !Array.isArray(spec.tasks) || Buffer.byteLength(JSON.stringify(spec)) > 256 * 1024)
    throw new Error('Return a bounded synchronous task proposal.');
  const item = attempt.artifacts.find(item => item.path === spec.path);
  if (!item) throw new Error('Proposed work must identify its registered evidence.');
  const inputs = spec.acceptedInputs || [];
  validateAcceptedReferences(store, inputs, recordProject(source));
  validatePlan(
    { version: 'studio-plan-v1', summary: source.title, assumptions: [], directorDecisions: [], tasks: spec.tasks },
    {
      workers: org.workers.filter(worker => worker.enabled),
      kinds: catalog.filter(task => task.creatable || task.proposalOnly).map(task => task.kind),
      reviewKinds: catalog.filter(task => task.acceptFailedChecks && !task.standaloneReport).map(task => task.kind),
      resourcePrefixes: [''],
      acceptedInputs: inputs,
      // Every intake task depends on this validated producing task. It need not
      // invent a graph key for the implicit prerequisite that the controller adds.
      proposalSource: source.id,
      limits: { maxTasks: 10, maxSeconds: 600, maxAttempts: 3, totalAttemptSeconds: 1800 },
    },
  );
  // Each proposed task's upstream: its producing source, sibling prerequisites and pinned inputs.
  for (const job of spec.tasks) {
    for (const [key, milestone] of Object.entries(job.waitsFor || {})) {
      const sibling = spec.tasks.find(other => other.key === key);
      if (!registries.workflows.milestonesOf(sibling.kind).includes(milestone))
        throw new Error(
          `Proposed task ${job.key} waits for ${key} to be ${milestone}, which ${sibling.kind} does not define.`,
        );
    }
    const upstream = [
      source.kind,
      ...job.dependencies.map(key => spec.tasks.find(sibling => sibling.key === key).kind),
      ...(job.acceptedInputs || []).map(id => store.task(id).kind),
    ];
    const unmet = unmetConsumes(registries.workflows, job.kind, upstream);
    if (unmet.length) throw new Error(portMessage(registries.workflows, `Proposed task ${job.key}`, unmet));
  }
  return { spec, inputs, item };
}

// A worker supplies an artifact; only trusted task definitions translate it
// into non-executable records. Preparation completes before any state write.
export function prepareProposedWork(store, registries, source, attempt) {
  if (registries.workflows.stagesOf(source))
    throw new Error('This task advances through its own stages after acceptance; it does not propose separate work.');
  const { spec, inputs, item } = readProposal(store, registries, source, attempt);
  const previous = store.tasks().filter(task => task.proposalReference?.attemptId === attempt.id);
  const ids = new Map(
    spec.tasks.map(job => [
      job.key,
      previous.find(task => task.proposalReference.key === job.key)?.id || 'T-' + randomUUID().slice(0, 8),
    ]),
  );
  const now = new Date().toISOString(),
    tasks = [],
    org = projectOrganization(store, recordProject(source));
  // Role-named tasks are staffed now; the proposing attempt and pinned inputs count as upstream work.
  const staffed = staffNodes(org, registries, spec.tasks, {
    label: 'Proposed task',
    source: attempt.workerId,
    inputs: inputs.map(ref => ({ taskId: ref.taskId, workerId: store.attempt(ref.attemptId).workerId })),
  });
  for (const { role, distinctFrom, ...job } of spec.tasks) {
    const existing = previous.find(task => task.id === ids.get(job.key));
    if (existing) {
      if (existing.proposalReference.hash !== item.hash) throw new Error('Recorded proposal identity changed.');
      continue;
    }
    const { worker, staffing } = staffed.get(job.key);
    const pinned = (job.acceptedInputs || []).map(id => inputs.find(ref => ref.taskId === id));
    const dependencies = [
      ...new Set([source.id, ...job.dependencies.map(key => ids.get(key)), ...pinned.map(ref => ref.taskId)]),
    ];
    if (dependencies.length > 20) throw new Error('Proposed work has too many prerequisites.');
    tasks.push({
      ...structuredClone(job),
      workerId: worker.id,
      ...(staffing ? { staffing } : {}),
      ...(job.waitsFor
        ? {
            waitsFor: Object.fromEntries(
              Object.entries(job.waitsFor).map(([key, milestone]) => [ids.get(key), milestone]),
            ),
          }
        : {}),
      acceptedInputs: pinned,
      id: ids.get(job.key),
      projectId: recordProject(source),
      team: worker.team,
      goalId: null,
      dependencies,
      direction: '',
      status: 'backlog',
      reason: 'Awaiting director work approval.',
      hold: false,
      queued: false,
      lastAttemptId: null,
      createdAt: now,
      approval: { status: 'pending' },
      proposalReference: { taskId: source.id, attemptId: attempt.id, path: item.path, hash: item.hash, key: job.key },
      teamId: worker.teamId,
      organizationReference: org.projectOrganization,
      proposedConfiguration: {
        team: worker.team,
        teamId: worker.teamId,
        provider: worker.provider,
        model: worker.model || '',
      },
    });
  }
  return {
    tasks,
    taskIds: [...ids.values()],
    attemptId: attempt.id,
    evidence: { path: item.path, hash: item.hash },
  };
}

// Work proposed by an earlier attempt of the same task is pinned to that attempt and can no
// longer run once a newer attempt proposes its replacement. Retire it if it has not started,
// so Planned shows only actionable work.
function supersededProposals(store, source, attemptId) {
  return store
    .tasks()
    .filter(
      task =>
        task.proposalReference?.taskId === source.id &&
        task.proposalReference.attemptId !== attemptId &&
        ['pending', 'approved'].includes(task.approval?.status) &&
        ['backlog', 'ready', 'blocked'].includes(task.status) &&
        !store.attempts(task.id).length,
    );
}

export function recordProposedWork(store, source, prepared) {
  const reason = `Superseded: a newer attempt of ${source.id} (${prepared.attemptId}) proposed replacement work.`,
    superseded = supersededProposals(store, source, prepared.attemptId);
  for (const task of superseded) {
    task.approval = {
      status: 'denied',
      decidedAt: new Date().toISOString(),
      reason,
      by: { type: 'controller' },
      previous: task.approval,
    };
    task.status = 'denied';
    task.queued = false;
    task.reason = reason;
    delete task.autonomyNote;
    store.putTask(task);
  }
  // Work proposed by a run's task joins that run as its next revision.
  expandRun(store, runIdOf(source), {
    reason: `${source.id} proposed work.`,
    source: source.id,
    tasks: prepared.tasks,
  });
  prepared.tasks.forEach(task => store.putTask(task));
  source.proposedTaskIds = [...new Set([...(source.proposedTaskIds || []), ...prepared.taskIds])];
  store.putTask(source);
  for (const task of superseded) store.event('work_superseded', task.id, null, reason, recordProject(task));
  return prepared.taskIds;
}

export function stageProposedWork(store, registries, source, attempt) {
  return recordProposedWork(store, source, prepareProposedWork(store, registries, source, attempt));
}

function approvedTask(store, registries, task) {
  if (task.status !== 'backlog' || task.approval?.status !== 'pending')
    throw new Error('Only pending Planned work can be approved.');
  validateTaskProject(store, task);
  if (Object.hasOwn(task, 'complexity')) validateComplexityLimits(task);
  const worker = projectOrganization(store, recordProject(task)).workers.find(
    worker => worker.id === task.workerId && worker.enabled,
  );
  if (!worker) throw new Error('The proposed employee is no longer enabled.');
  assertProjectKind(store, registries, recordProject(task), task.kind);
  if (task.proposalReference) {
    const reference = task.proposalReference,
      source = store.task(reference.taskId);
    // Work is proposed when its source finishes, but it runs on the accepted result.
    if (source.status !== 'done')
      throw new Error(`Accept ${source.id} (“${source.title}”) first. This proposed work uses its accepted result.`);
    const accepted = acceptedReference(store, source.id, reference.attemptId, recordProject(task));
    if (!accepted.artifacts.some(item => item.path === reference.path && item.hash === reference.hash))
      throw new Error('Proposed work no longer matches its accepted evidence.');
    const { spec, inputs } = readProposal(store, registries, source, store.attempt(reference.attemptId), reference.key);
    // A proposer with exact proposals has every approval recheck its recorded content,
    // limits, sibling prerequisites and pinned inputs.
    if (registries.workflows.get(source.kind).exactProposals) {
      const job = spec.tasks.find(job => job.key === reference.key);
      if (
        !job ||
        task.key !== reference.key ||
        ['kind', 'title', 'brief', 'acceptance', 'complexity', 'maxSeconds', 'maxAttempts'].some(
          key => task[key] !== job[key],
        )
      )
        throw new Error(
          'Proposed work no longer matches its exact recorded proposal key and scope. Request a fresh proposal.',
        );
      const siblingIds = job.dependencies.map(key => {
        const sibling = store
          .tasks()
          .find(
            item =>
              item.proposalReference?.taskId === source.id &&
              item.proposalReference.attemptId === reference.attemptId &&
              item.proposalReference.hash === reference.hash &&
              item.proposalReference.path === reference.path &&
              item.proposalReference.key === key &&
              recordProject(item) === recordProject(task),
          );
        if (!sibling) throw new Error(`Missing recorded sibling prerequisite ${key}.`);
        return sibling.id;
      });
      const expected = [source.id, ...siblingIds, ...(job.acceptedInputs || [])];
      if (task.dependencies.length !== expected.length || expected.some(id => !task.dependencies.includes(id)))
        throw new Error('Proposed work dependencies no longer match its accepted proposal.');
      const pinned = task.acceptedInputs || [],
        required = inputs.filter(ref => job.acceptedInputs.includes(ref.taskId));
      if (
        pinned.length !== required.length ||
        required.some(
          ref =>
            !pinned.some(
              item =>
                item.taskId === ref.taskId &&
                item.attemptId === ref.attemptId &&
                JSON.stringify(item.artifacts) === JSON.stringify(ref.artifacts),
            ),
        )
      )
        throw new Error('Proposed work must retain its exact pinned accepted inputs before approval.');
    }
    if (
      task.proposedConfiguration.team !== worker.team ||
      task.proposedConfiguration.provider !== worker.provider ||
      task.proposedConfiguration.model !== (worker.model || '')
    )
      throw new Error('The proposed employee configuration changed. Request a fresh proposal.');
    task.acceptedInputs = [...(task.acceptedInputs || []), accepted];
    if (task.acceptedInputs.length > 20) throw new Error('Too many accepted proposal inputs.');
  }
  validateAcceptedReferences(store, task.acceptedInputs || [], recordProject(task));
  task.approval = {
    status: 'approved',
    decidedAt: new Date().toISOString(),
    ...(task.approval.gate ? { gate: true, reason: task.approval.reason } : {}),
  };
  task.status = 'ready';
  task.reason = '';
  delete task.autonomyNote;
  // A passed gate resumes its run; other approved work waits for an explicit start.
  task.queued = !!task.queueOnApproval;
  return task;
}

// `by` is { type: 'director' } or { type: 'policy', revision, reason }.
export function approveWork(store, registries, task, by = { type: 'director' }) {
  if (task.approval?.gate && by.type !== 'director') throw new Error('Only the director can pass a gate.');
  const approved = approvedTask(store, registries, task);
  approved.approval.by = structuredClone(by);
  store.tx(() => {
    store.putTask(approved);
    if (approved.queued) {
      const org = store.organization();
      if (!org.pipelineEnabled) {
        org.pipelineEnabled = true;
        store.setOrganization(org);
      }
    }
  });
  store.event(
    'work_approved',
    task.id,
    null,
    by.type === 'policy'
      ? `Approved by autonomy policy revision ${by.revision}: ${by.reason}`
      : approved.queued
        ? 'Director passed the gate; the work is queued and its run continues.'
        : 'Director approved this work. Start it when it should run.',
  );
  return { ok: true };
}

// Pending work can be denied; approved work can be withdrawn until an attempt exists. A workflow
// step that never started (for example, behind a cancelled prerequisite) can be closed the same way.
function denial(store, task) {
  const neverStarted = !store.attempts(task.id).length,
    pending = task.status === 'backlog' && task.approval?.status === 'pending',
    unstarted =
      task.approval?.status === 'approved' &&
      neverStarted &&
      !['running', 'stopping', 'review', 'done'].includes(task.status),
    workflowStep = !task.approval && neverStarted && ['ready', 'blocked'].includes(task.status);
  return pending || unstarted || workflowStep ? { unstarted, workflowStep } : null;
}
export function denyWork(store, task, reason = '') {
  const allowed = denial(store, task);
  if (!allowed) throw new Error('Only Planned, approved or workflow work that has not started can be denied.');
  if (typeof reason !== 'string' || reason.length > 2000) throw new Error('Denial reason must be bounded text.');
  store.tx(() => store.putTask(denied(task, allowed, reason)));
  store.event('work_denied', task.id, null, task.reason);
  // A carry story set aside frees its carry for the director's next choice.
  if (task.carryOf) carryStoryClosed(store, task);
  return { ok: true };
}
// The task set aside with its reason, as Deny records it; nothing is written here.
function denied(task, { unstarted, workflowStep }, reason) {
  task.approval = {
    status: 'denied',
    decidedAt: new Date().toISOString(),
    reason: reason.trim(),
    ...(unstarted ? { previous: task.approval } : {}),
    ...(workflowStep ? { workflowStep: true } : {}),
  };
  task.status = 'denied';
  task.queued = false;
  task.reason = reason.trim() || 'Director denied this work.';
  delete task.autonomyNote;
  return task;
}

// A plan whose steps have not started is planned again with the director's reply (the chat box, October 30). Under
// house rules that accept a plan by themselves, the plan is accepted the moment it arrives and its steps wait for the
// director, so a reply to it in the idea's conversation comes after its acceptance. Every step is checked before any
// changes: each is set aside (denied, with the reply as its reason), and the plan step goes back to ready with the reply
// as its direction, to be started as the director's Start would. Its accepted attempt stays recorded, marked as
// planned again; the new plan's steps join the same idea. The steps, the plan and their events are one transaction, and
// `record` (such as the message that asked for it) is written in it too.
export function replanWork(store, registries, task, direction, { record } = {}) {
  if (typeof direction !== 'string' || !direction.trim() || direction.length > 24000)
    throw new Error('Say what to change in the plan.');
  const plan = store.task(task.id),
    steps = (plan.proposedTaskIds || []).map(id => store.task(id)).filter(step => step.status !== 'denied');
  if (plan.status !== 'done' || !plan.acceptedAttemptId || !steps.length)
    throw new Error('Only an accepted plan whose steps wait for your approval can be planned again.');
  if (!steps.every(step => denial(store, step)))
    throw new Error("Some of this plan's steps have started; change them on their own pages instead.");
  const words = direction.trim(),
    reason = `Planned again with your reply: ${words.split('\n')[0].slice(0, 200)}`;
  return store.tx(() => {
    for (const step of steps) {
      store.putTask(denied(step, denial(store, step), reason));
      store.event('work_denied', step.id, null, step.reason);
    }
    const accepted = store.attempt(plan.acceptedAttemptId),
      current = store.task(plan.id);
    accepted.replannedBy = { type: 'director', at: new Date().toISOString(), reason: words };
    store.updateAttempt(accepted);
    registries.workflows.direct(current, words);
    Object.assign(current, { status: 'ready', reason: '', queued: false });
    delete current.acceptedAttemptId;
    delete current.autonomyNote;
    store.putTask(current);
    store.event(
      'replanned',
      plan.id,
      null,
      `Director replied to the plan: its ${steps.length} waiting step${steps.length === 1 ? ' was' : 's were'} set aside, and it is planned again with the reply.`,
    );
    const replanned = { ok: true, setAside: steps.map(step => step.id) };
    record?.(current);
    return replanned;
  });
}

// Closes several unstarted tasks at once (for example, what is left of a stopped run).
// Every task is checked before any is changed.
export function closeWork(store, projectId, taskIds, reason = '') {
  if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 50 || new Set(taskIds).size !== taskIds.length)
    throw new Error('Choose 1 to 50 distinct tasks to close.');
  if (typeof reason !== 'string' || reason.length > 2000) throw new Error('Closing reason must be bounded text.');
  const tasks = taskIds.map(id => {
    const task = store.task(id);
    assertProject(store, task, projectId);
    if (!denial(store, task)) throw new Error(`${id} has started or finished, so it cannot be closed.`);
    return task;
  });
  for (const task of tasks) denyWork(store, task, reason);
  return { closed: taskIds };
}

// Closes one task the director will not take further: work that has not started is denied;
// started work that is not live (in Review, failed, cancelled or blocked) keeps its recorded
// attempts and is closed without accepting a result. Accepted work is final unless its stages
// say it is still unfinished (for example, a candidate that will not be integrated).
// `sentAsIdea` (Close and send as a new idea) records on the closed task the run its remaining work was sent in as.
export function closeStartedWork(store, registries, task, reason = '', { sentAsIdea } = {}) {
  if (typeof reason !== 'string' || reason.length > 2000) throw new Error('Closing reason must be bounded text.');
  const refusal = closeRefusal(store, registries, task);
  if (refusal) throw refusal;
  if (sentAsIdea) task.sentAsIdea = { ...sentAsIdea };
  if (denial(store, task)) return denyWork(store, task, reason);
  const stages = registries.workflows.stagesOf(task),
    at = new Date().toISOString(),
    text = reason.trim() || 'Director closed this work without taking it further.',
    pending = task.status === 'review' ? store.attempt(task.lastAttemptId) : null;
  task.closed = { at, reason: text, status: task.status, by: { type: 'director' } };
  stages?.closed?.(task, text);
  Object.assign(task, { status: 'denied', queued: false, reason: text, controllerWait: false });
  delete task.autonomyNote;
  store.tx(() => {
    if (pending?.status === 'review') {
      pending.status = 'closed';
      pending.closedBy = { type: 'director', at, reason: text };
      store.updateAttempt(pending);
    }
    store.putTask(task);
  });
  store.event('work_closed', task.id, pending?.id || null, `Director closed this work: ${text}`);
  if (task.carryOf) carryStoryClosed(store, task);
  return { ok: true };
}
// Why closeStartedWork would refuse this task now, as the error it would throw, or null when it may be closed. Nothing
// is written, so a step that must do something else first (sending a story as a new idea) can ask before it starts.
export function closeRefusal(store, registries, task) {
  if (denial(store, task)) return null;
  const attempts = store.attempts(task.id),
    stages = registries.workflows.stagesOf(task);
  if (task.status === 'denied') return new Error('This work is already closed.');
  if (['running', 'stopping'].includes(task.status))
    return new Error('Cancel the running attempt first; close the work once it has stopped.');
  if (attempts.some(a => ['interrupted', 'quarantined', 'uncertain'].includes(a.status) && !a.reconciledAt))
    return new Error('Reconcile interrupted work before closing it.');
  if (store.leases().some(lease => attempts.some(a => a.id === lease.attemptId)))
    return new Error('This work still holds a reservation. Wait for it to be released.');
  if (task.status === 'done') {
    let closable;
    try {
      closable = stages?.closable?.(store, task);
    } catch (error) {
      return error;
    }
    if (!closable) return new Error('Accepted work is final; it cannot be closed.');
  }
  if (!['review', 'failed', 'cancelled', 'blocked', 'ready', 'done'].includes(task.status))
    return new Error('Only stopped work can be closed.');
  return null;
}

// Sends accepted work back to an earlier stage when a later stage returned findings (for example,
// an independent review requested changes), or when the director overrules a later stage that passed
// (a passing review, before its integration is approved). The stage hook rewinds it, and the next
// attempt's direction is what the later stage returned with the director's note, which overruling a
// pass that noted nothing requires.
// Autonomy does the same within its retry budget; the director may always do it. The check and the
// rewind are one transaction with the record read inside it, and `refuse` (the controller's own
// refusal, such as an integration approved meanwhile) is asked there too, so nothing approved in
// between is overtaken. `record` (such as the director's message that asked for it) is written in that transaction too.
export function sendBackWork(store, registries, task, note = '', { refuse, record } = {}) {
  if (typeof note !== 'string' || note.length > 4000) throw new Error('A send-back note must be bounded text.');
  const stages = registries.workflows.stagesOf(task);
  return store.tx(() => {
    const current = store.task(task.id),
      refusal = refuse?.(current);
    if (refusal) throw refusal;
    const returned = stages?.returnable?.(store, current);
    if (!returned || !stages.retry)
      throw new Error(
        'Only accepted work whose later stage requested changes, or whose passing review is not yet being integrated, can be sent back.',
      );
    if (returned.needsNote && !note.trim())
      throw new Error(
        'Say what to change: the review passed and noted nothing, so your note is what the next attempt changes.',
      );
    stages.retry(current);
    const direction = `${returned.findings}${note.trim() ? `\n\nDirector's note: ${note.trim()}` : ''}`;
    current.direction = direction.length > 24000 ? direction.slice(0, 23999) + '…' : direction;
    delete current.autonomyNote;
    Object.assign(current, { status: 'ready', queued: false, reason: '', controllerWait: false });
    registries.workflows.stageProgress(store, current);
    store.putTask(current);
    store.event(
      'sent_back',
      current.id,
      current.acceptedAttemptId,
      `Director sent this work back for another attempt${returned.passed ? ' over a passing review' : ''}.${note.trim() ? ` Note: ${note.trim()}` : ''}`,
    );
    const sent = { ok: true, direction: current.direction };
    record?.(current);
    return sent;
  });
}

// Work awaiting review goes back to ready with the director's revision direction (the Revise button, and a message
// that names the work's builder on its thread). Past the attempt limit the revised work waits for the director to
// press Start, except where the task type's limit is a safety rule, which refuses the revision. The attempt, the task
// and the event are one transaction, and `record` (such as the message that asked for it) is written in it too.
export function reviseWork(store, registries, task, direction, { record } = {}) {
  if (task.status !== 'review') throw new Error('Only work awaiting review can be revised.');
  if (registries.workflows.get(task.kind).fixedAttemptLimit && store.attempts(task.id).length >= task.maxAttempts)
    throw new Error('Attempt limit reached. Create a newly scoped assignment.');
  if (typeof direction !== 'string' || direction.length > 24000 || !direction.trim())
    throw new Error('Revision direction is missing or too long.');
  const words = direction.trim();
  return store.tx(() => {
    registries.workflows.direct(task, words);
    const a = store.attempt(task.lastAttemptId);
    a.status = 'revision_requested';
    a.revisionRequestedBy = { type: 'director', at: new Date().toISOString(), reason: words };
    store.updateAttempt(a);
    task.status = 'ready';
    task.reason = '';
    delete task.autonomyNote;
    registries.workflows.stageProgress(store, task);
    store.putTask(task);
    store.event('revision', task.id, a.id, words);
    record?.(task);
    return { ok: true };
  });
}

// Start's direction for the next attempt (a director's Start with a note, and a message that names the work's builder
// on its thread): recorded as a PATCH direction is, before the work starts. Work Start refuses for its state keeps its
// direction. Starting it is the caller's: the controller's queued Start.
export function directStart(store, registries, task, direction, { record } = {}) {
  if (typeof direction !== 'string' || direction.length > 24000) throw new Error('Direction is missing or too long.');
  if (!['ready', 'failed', 'cancelled', 'blocked'].includes(task.status))
    throw new Error('Only ready or stopped assignments can start.');
  return store.tx(() => {
    registries.workflows.direct(task, direction.trim());
    store.putTask(task);
    store.event('task_updated', task.id, null, 'Direction for the next attempt updated with Start.');
    record?.(task);
    return { ok: true };
  });
}
