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
  // A passed gate resumes its run; other approved work waits for a sprint or an explicit start.
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
        : 'Director approved this work. Add it to a sprint or start it explicitly.',
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
  const { unstarted, workflowStep } = allowed;
  if (typeof reason !== 'string' || reason.length > 2000) throw new Error('Denial reason must be bounded text.');
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
  store.tx(() => store.putTask(task));
  store.event('work_denied', task.id, null, task.reason);
  return { ok: true };
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
export function closeStartedWork(store, registries, task, reason = '') {
  if (typeof reason !== 'string' || reason.length > 2000) throw new Error('Closing reason must be bounded text.');
  if (denial(store, task)) return denyWork(store, task, reason);
  const attempts = store.attempts(task.id),
    stages = registries.workflows.stagesOf(task);
  if (task.status === 'denied') throw new Error('This work is already closed.');
  if (['running', 'stopping'].includes(task.status))
    throw new Error('Cancel the running attempt first; close the work once it has stopped.');
  if (attempts.some(a => ['interrupted', 'quarantined', 'uncertain'].includes(a.status) && !a.reconciledAt))
    throw new Error('Reconcile interrupted work before closing it.');
  if (store.leases().some(lease => attempts.some(a => a.id === lease.attemptId)))
    throw new Error('This work still holds a reservation. Wait for it to be released.');
  if (task.status === 'done' && !stages?.closable?.(store, task))
    throw new Error('Accepted work is final; it cannot be closed.');
  if (!['review', 'failed', 'cancelled', 'blocked', 'ready', 'done'].includes(task.status))
    throw new Error('Only stopped work can be closed.');
  const at = new Date().toISOString(),
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
  return { ok: true };
}

// Sends accepted work back to an earlier stage when a later stage returned findings (for example,
// an independent review requested changes), or when the director overrules a later stage that passed
// (a passing review, before its integration is approved). The stage hook rewinds it, and the next
// attempt's direction is what the later stage returned with the director's note, which overruling a
// pass that noted nothing requires.
// Autonomy does the same within its retry budget; the director may always do it. The check and the
// rewind are one transaction with the record read inside it, and `refuse` (the controller's own
// refusal, such as an integration approved meanwhile) is asked there too, so nothing approved in
// between is overtaken.
export function sendBackWork(store, registries, task, note = '', { refuse } = {}) {
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
    return { ok: true, direction: current.direction };
  });
}

export function startSprint(store, runner, projectId, name, taskIds) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 160 ||
    !Array.isArray(taskIds) ||
    !taskIds.length ||
    taskIds.length > 10 ||
    new Set(taskIds).size !== taskIds.length
  )
    throw new Error('Choose a sprint name and 1 to 10 distinct tasks.');
  const selected = new Set(taskIds),
    tasks = taskIds.map(id => {
      const task = store.task(id);
      assertProject(store, task, projectId);
      if (task.sprintId || store.attempts(id).length)
        throw new Error('Choose work that has not entered a sprint or started.');
      if (task.approval?.status === 'pending') return approvedTask(store, runner.registries, task);
      if (task.approval?.status !== 'approved' || !['ready', 'blocked'].includes(task.status))
        throw new Error('Choose Planned or approved unstarted work.');
      assertProjectKind(store, runner.registries, projectId, task.kind);
      const worker = projectOrganization(store, projectId).workers.find(
        worker => worker.id === task.workerId && worker.enabled,
      );
      if (!worker || worker.team !== task.team)
        throw new Error('Approved project ownership changed. Scope and approve new work before sprint selection.');
      validateTaskProject(store, task);
      validateAcceptedReferences(store, task.acceptedInputs || [], projectId);
      return task;
    });
  for (const task of tasks) {
    if (Object.hasOwn(task, 'complexity')) validateComplexityLimits(task);
    else if (
      !Number.isInteger(task.maxSeconds) ||
      task.maxSeconds < 5 ||
      task.maxSeconds > 600 ||
      !Number.isInteger(task.maxAttempts) ||
      task.maxAttempts < 1 ||
      task.maxAttempts > 3
    )
      throw new Error('Sprint exceeds a task execution limit.');
  }
  const budget = tasks.reduce((seconds, task) => seconds + task.maxSeconds * task.maxAttempts, 0),
    legacySeconds = tasks
      .filter(task => !Object.hasOwn(task, 'complexity'))
      .reduce((seconds, task) => seconds + task.maxSeconds * task.maxAttempts, 0);
  if (legacySeconds > 1800) throw new Error('Sprint exceeds the 1800-second attempt budget.');
  for (const task of tasks)
    for (const id of task.dependencies) {
      const dependency = store.task(id);
      if (dependency.approval && dependency.approval.status !== 'approved' && !selected.has(id))
        throw new Error('Include or approve the proposed prerequisite before starting this sprint.');
    }
  const sprint = {
    id: 'sprint-' + randomUUID(),
    projectId,
    name: name.trim(),
    taskIds,
    totalAttemptSeconds: budget,
    createdAt: new Date().toISOString(),
  };
  store.tx(() => {
    store.putSetting(sprint.id, sprint);
    for (const task of tasks) {
      task.sprintId = sprint.id;
      task.queued = true;
      store.putTask(task);
    }
    runner.enablePipeline(projectId);
  });
  store.event(
    'sprint_started',
    null,
    null,
    `Director selected ${tasks.length} tasks for ${sprint.name}. Eligible work starts; results require acceptance.`,
    projectId,
  );
  return sprint;
}
