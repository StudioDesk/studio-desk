import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hash, resultSchema, validateResult } from './contracts.mjs';
import { compileInstructions } from './instructions.mjs';
import { artifactPath, validateAcceptedReferences, validateProtectedFiles } from './artifacts.mjs';
import { directorInputsFor, directorInputReferences, stageDirectorInputs } from './idea-inputs.mjs';
import { prepareOperation, validateOperationResult } from './operations.mjs';
import { LEGACY_PROJECT, recordProject, assertProject, validateTaskProject, jobDirectory } from './projects.mjs';
import { live } from '../adapters/process.mjs';
import { prepareProposedWork, recordProposedWork } from './proposals.mjs';
import { runMock } from '../adapters/simulator.mjs';
import { runNative, parseOutput, recordLine, nativeFailure } from '../adapters/native-process.mjs';
import { projectOrganization, assertProjectKind } from './project-organization.mjs';
import { Autonomy } from './autonomy-runtime.mjs';
import { executionWorker, resolveAdapter, modelMode, quotaKey, adapterText } from './execution.mjs';
import { producedFormatChecks, missingInputFormats } from './formats.mjs';
import { excludedEmployees } from './staffing.mjs';
import { joinStatus } from './fanout.mjs';
import { applyTransform } from './transforms.mjs';
import { captureContinuation, continuationFile } from './attempt-continuation.mjs';
import { buildAttemptHistory, stageAttemptHistory } from './attempt-history.mjs';

// Reasons that clear by themselves as other work finishes.
const waiting = reason => /^Waiting for /.test(reason || '');
// What queued work in a paused project waits for; the director's resume starts it.
const projectPaused = 'Waiting for the project to resume: this project is paused.';
// setTimeout's longest delay; a later reset re-arms the timer when it fires.
const maxTimerDelay = 2 ** 31 - 1;
// How long a process asked to stop has to close before it is forced.
const stopGrace = 2000;
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A reset time as the controller's local clock shows it ("10:25 PM"), with its date when not today.
function resetTime(time) {
  const at = new Date(time),
    hour = at.getHours(),
    clock = `${hour % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  return at.toDateString() === new Date().toDateString()
    ? clock
    : `${clock} on ${monthNames[at.getMonth()]} ${at.getDate()}`;
}
// Where a self-clearing hold's reset time came from (org.quotaResetSources); a hold recorded
// without one names no source.
const resetSources = { report: ", from the CLI's own report", message: ", read from the CLI's message" };

export class Runner {
  constructor(store, options = {}) {
    this.store = store;
    this.active = new Map();
    this.fixtureProcessTermination = options.fixtureProcessTermination; // trusted model-free test seam; never exposed by HTTP
    this.registries = options.registries;
    if (!this.registries) throw new Error('Explicit workflow and adapter registries are required.');
    this.workflows = this.registries.workflows;
    this.adapters = this.registries.adapters;
    // The application injects its integration operation (options.integrate) with these
    // companions, so the core names no connector: target resolves the task to integrate,
    // failed records a refused integration on it, stop ends a running integration process,
    // recover marks the integrations a stop cut off as uncertain when the controller starts,
    // resources(task) are the ones integrating that task holds exclusively (its repository's), and
    // pauses(task) says whether integrating it replaces this controller's own modules.
    this.integration = {
      target: (store, task) => task,
      requested() {},
      failed() {},
      stop() {},
      recover() {},
      resources: () => [],
      pauses: () => !!this.selfHosted,
      ...options.integration,
    };
    for (const adapter of this.adapters.list()) adapter.initialize?.(this, options);
    this.dispatching = false;
    this.closing = false;
    this.scheduled = null;
    this.quotaTimer = null;
    const org = store.organization();
    if (org.pipelineEnabled) {
      org.pipelineEnabled = false;
      store.setOrganization(org);
      for (const id of new Set(
        store
          .tasks()
          .filter(task => task.queued)
          .map(recordProject),
      )) {
        const project = store.project(id);
        // A project the director paused stays theirs. The pause made here is marked, so a planned
        // restart lifts only this one (Autonomy.resumePlan).
        if (project.dispatchPaused) continue;
        project.dispatchPaused = true;
        project.restartPaused = true;
        store.putProject(project);
      }
      store.event(
        'pipeline_paused',
        null,
        null,
        'Controller restarted. The queue is retained; resume it after inspecting interrupted work.',
      );
    }
    // An unacknowledged process may still be alive. Retain its reservations until reconciled.
    for (const a of store.allAttempts().filter(x => ['running', 'stopping'].includes(x.status))) {
      this.adapters.find(a.contracts?.adapter?.id || a.provider)?.recover?.(this, a);
      a.status = 'interrupted';
      a.finishedAt = new Date().toISOString();
      store.updateAttempt(a);
      const t = store.task(a.taskId);
      t.status = 'blocked';
      t.queued = false;
      t.reason = 'Controller restarted. Reconcile the previous attempt before retrying.';
      if (t.autonomyNote) t.autonomyNote = t.reason;
      this.putTask(t);
      store.event('interrupted', t.id, a.id, t.reason);
      // Unknown operation endings stay unmatched. This is an observation of interruption,
      // not evidence that the old process stopped or that any mutation completed.
      this.interruptPhases(a);
    }
    // Likewise an integration no process of this controller runs yet; its resources stay held until reconciled.
    this.integration.recover(this);
    this.autonomy = new Autonomy(this, { integrate: options.integrate, restart: options.restart });
    // A reset time that passed while the controller was stopped clears its hold now.
    this.clearPassedHolds();
  }
  // A subscription hold whose CLI named its reset time (org.quotaResets) clears itself then. One
  // timer waits for the earliest; a hold with no recorded time waits for the director.
  heldResets(org = this.store.organization()) {
    return Object.entries(org.quotaResets || {})
      .filter(([key]) => org.quota?.[key])
      .map(([key, at]) => [key, Date.parse(at)])
      .filter(([, time]) => Number.isFinite(time));
  }
  armQuotaTimer() {
    clearTimeout(this.quotaTimer);
    this.quotaTimer = null;
    const times = this.heldResets().map(([, time]) => time);
    if (this.closing || !times.length) return;
    this.quotaTimer = setTimeout(
      () => {
        this.quotaTimer = null;
        this.clearPassedHolds();
      },
      Math.min(Math.max(0, Math.min(...times) - Date.now()), maxTimerDelay),
    );
    // Shutdown clears it as well; it never keeps the process alive by itself.
    this.quotaTimer.unref?.();
  }
  clearPassedHolds() {
    if (this.closing) return;
    const org = this.store.organization(),
      now = Date.now(),
      passed = this.heldResets(org).filter(([, time]) => time <= now),
      sources = { ...org.quotaResetSources };
    if (passed.length) {
      for (const [key] of passed) {
        org.quota[key] = false;
        delete org.quotaResets[key];
        if (org.quotaResetSources) delete org.quotaResetSources[key];
      }
      this.store.setOrganization(org);
      for (const [key, time] of passed) {
        const source = Object.hasOwn(resetSources, sources[key]) ? resetSources[sources[key]] : '';
        this.store.event(
          'control',
          null,
          null,
          `${this.quotaLabel(key)} hold cleared itself at its reset time, ${resetTime(time)}${source}. Actual provider availability is not inferred.`,
        );
      }
    }
    this.armQuotaTimer();
    if (passed.length) this.schedule();
  }
  quotaLabel(key) {
    const adapter = this.adapters.find(key);
    return adapter?.quotaLabel || adapter?.name || key;
  }
  // Work on a hold with a known reset time only waits, so Start queues it and dispatch starts it then.
  holdWait(key, time) {
    return `Waiting for the ${this.quotaLabel(key)} usage limit to reset at ${resetTime(time)}.`;
  }
  // A stage view keeps its task's ID while running another kind; its scheduling
  // state is saved on the task it belongs to.
  putTask(task) {
    const owner = this.workflows.stageOwner(this.store, task);
    if (owner) {
      for (const field of ['status', 'reason', 'queued', 'controllerWait', 'lastAttemptId']) owner[field] = task[field];
      if (Object.hasOwn(task, 'autonomyNote')) owner.autonomyNote = task.autonomyNote;
      else delete owner.autonomyNote;
      task = owner;
    }
    this.workflows.stageProgress(this.store, task);
    this.store.putTask(task);
  }
  enablePipeline(projectId) {
    const project = this.store.project(projectId);
    project.dispatchPaused = false;
    delete project.restartPaused;
    this.store.putProject(project);
    const org = this.store.organization();
    org.pipelineEnabled = true;
    this.store.setOrganization(org);
  }
  pipeline(action, taskIds, projectId = LEGACY_PROJECT) {
    const store = this.store,
      org = store.organization();
    const project = store.project(projectId);
    if (action === 'queue') {
      if (
        !Array.isArray(taskIds) ||
        !taskIds.length ||
        taskIds.length > 20 ||
        taskIds.some(id => typeof id !== 'string')
      )
        throw new Error('Choose 1 to 20 assignments for the pipeline.');
      const tasks = [...new Set(taskIds)].map(id => store.task(id));
      for (const task of tasks) {
        assertProject(store, task, projectId);
        validateTaskProject(store, task);
        if (['backlog', 'denied'].includes(task.status) || (task.approval && task.approval.status !== 'approved'))
          throw new Error('Approve Planned work before queuing it; denied work cannot run.');
        if (task.status === 'done') throw new Error('Accepted assignments cannot be queued again.');
        if (store.attempts(task.id).some(a => ['interrupted', 'quarantined'].includes(a.status) && !a.reconciledAt))
          throw new Error('Reconcile interrupted work before queuing it.');
        if (
          !['running', 'stopping', 'review'].includes(task.status) &&
          this.workflows.stageAttempts(store, task).length >= this.workflows.stageView(task).maxAttempts
        )
          throw new Error('An assignment reached its attempt limit. Scope new work instead.');
      }
      store.tx(() => {
        for (const task of tasks) {
          task.queued = true;
          if (['failed', 'cancelled', 'blocked'].includes(task.status)) {
            task.status = 'ready';
            task.reason = '';
            task.controllerWait = true;
            delete task.autonomyNote;
          }
          this.putTask(task);
        }
        this.enablePipeline(projectId);
      });
      store.event(
        'pipeline_queued',
        null,
        null,
        `Director queued ${tasks.map(task => task.id).join(', ')}. Eligible work starts automatically; each completed result waits for approval.`,
        projectId,
      );
    } else if (action === 'pause' || action === 'resume') {
      project.dispatchPaused = action === 'pause';
      // The director's pause or resume replaces a pause the controller made at restart.
      delete project.restartPaused;
      store.putProject(project);
      org.pipelineEnabled = store
        .tasks()
        .some(task => task.queued && !store.project(recordProject(task)).dispatchPaused);
      store.setOrganization(org);
      // Queued work in a paused project says why it waits; resuming clears that before dispatch.
      this.refreshReadiness();
      store.event(
        'pipeline_' + (action === 'resume' ? 'resumed' : 'paused'),
        null,
        null,
        action === 'resume'
          ? 'Director resumed this project pipeline.'
          : 'This project pipeline paused; active attempts continue.',
        projectId,
      );
    } else if (action === 'remove') {
      if (!Array.isArray(taskIds) || taskIds.length !== 1)
        throw new Error('Choose one assignment to remove from the queue.');
      const task = store.task(taskIds[0]);
      assertProject(store, task, projectId);
      task.queued = false;
      // A withdrawn director Start no longer lends its override to a later automatic run.
      delete task.directorStart;
      store.putTask(task);
      store.event(
        'pipeline_removed',
        task.id,
        null,
        'Removed from queued dispatch. Any active attempt continues to its normal stop.',
      );
    } else throw new Error('Unknown pipeline action.');
    this.schedule();
    return { ok: true };
  }
  schedule() {
    if (this.closing || this.scheduled || this.dispatching || !this.store.organization().pipelineEnabled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      this.dispatchQueued();
    });
  }
  dispatchQueued() {
    if (this.closing || this.dispatching || !this.store.organization().pipelineEnabled) return;
    this.dispatching = true;
    try {
      this.refreshReadiness();
      for (const task of this.store
        .tasks()
        .filter(
          task => task.queued && task.status === 'ready' && !this.store.project(recordProject(task)).dispatchPaused,
        )) {
        // Refresh after each claim, so later jobs observe the same slots and leases.
        this.refreshReadiness();
        if (this.store.task(task.id).status !== 'ready') continue;
        try {
          this.start(task.id, { director: !!this.store.task(task.id).directorStart });
        } catch (error) {
          const current = this.store.task(task.id);
          if (!current.controllerWait || current.status === 'ready') {
            current.queued = false;
            delete current.directorStart;
            current.status = 'blocked';
            current.controllerWait = false;
            current.reason = error.message;
            if (current.autonomyNote) current.autonomyNote = current.reason;
            this.putTask(current);
            this.store.event('pipeline_attention', current.id, null, error.message);
          }
        }
      }
      if (!this.store.tasks().some(task => task.queued)) {
        const org = this.store.organization();
        org.pipelineEnabled = false;
        this.store.setOrganization(org);
        this.store.event('pipeline_finished', null, null, 'The selected pipeline has no queued work remaining.');
      }
    } finally {
      this.dispatching = false;
    }
  }
  // The tier a task requests: its own, else its task type's default.
  tierOf(task) {
    return task.tier || this.workflows.find(task.kind)?.tier || '';
  }
  // The settings an attempt runs with: employee defaults, the project's tier settings, then task overrides.
  effectiveWorker(org, task) {
    return executionWorker(
      org.workers.find(worker => worker.id === task.workerId),
      task,
      { tiers: org.tiers, tier: this.tierOf(task) },
    );
  }
  blockReason(task, verifyAuth = false) {
    task = this.workflows.stageView(task);
    const org = projectOrganization(this.store, recordProject(task)),
      w = this.effectiveWorker(org, task);
    try {
      validateTaskProject(this.store, task);
    } catch (error) {
      return error.message;
    }
    try {
      assertProjectKind(this.store, this.registries, recordProject(task), task.kind);
    } catch (error) {
      return error.message;
    }
    if (org.paused) return 'Studio dispatch is paused.';
    if (!w || !w.enabled) return 'This employee has no enabled worker adapter.';
    if (w.team !== task.team)
      return 'Project ownership changed. Create newly scoped work or update the pending Planned owner.';
    if (w.paused) return 'Employee dispatch is paused.';
    if (excludedEmployees(this.store, this.registries, task).has(w.id))
      return `Separation of duties: ${w.displayName || w.id} produced this work's inputs or is excluded from it. Choose another employee.`;
    if (task.hold) return 'Assignment is deliberately on hold.';
    if (task.approval && task.approval.status !== 'approved') return 'Director work approval is required.';
    let requirements, adapter;
    try {
      requirements = this.workflows.requirements(task, { store: this.store });
      adapter = resolveAdapter(this.adapters, requirements.definition, w);
    } catch (error) {
      return error.message;
    }
    for (const capability of requirements.capabilities)
      if (!adapter.capabilities.includes(capability))
        return (
          requirements.rules.find(rule => rule.capability === capability)?.reason ||
          `Adapter ${adapter.id} lacks required capability: ${capability}.`
        );
    // Adapters without effort levels (test runners, local operations, the Simulator) ignore it.
    if (w.effort && adapter.efforts?.length && !adapter.efforts.includes(w.effort))
      return `${adapter.name} does not accept effort "${w.effort}". Change the employee or task execution settings.`;
    if (adapter.subscription && org.quota[quotaKey(adapter, w)]) {
      const key = quotaKey(adapter, w),
        reset = Date.parse(org.quotaResets?.[key]);
      return Number.isFinite(reset)
        ? this.holdWait(key, reset)
        : 'This CLI has a subscription hold. Clear it when usable again.';
    }
    // A stage view may depend on its own task's earlier accepted stage; its stage hook supplies that input.
    const stageView = !!this.workflows.stageOwner(this.store, task);
    // A join's children are judged by its rule; every other prerequisite must be accepted.
    const children = new Set(task.join?.children || []);
    // A dependency may wait for a later milestone than acceptance (task.waitsFor), such as integration.
    const unmet = task.dependencies.filter(
      id =>
        !children.has(id) &&
        !(stageView && id === task.id) &&
        !this.workflows.reached(this.store, this.store.task(id), task.waitsFor?.[id]),
    );
    if (unmet.length) {
      const accepted = unmet.filter(id => !task.waitsFor?.[id] || task.waitsFor[id] === 'accepted'),
        later = unmet.filter(id => !accepted.includes(id)).map(id => `${id} to be ${task.waitsFor[id]}`);
      return `Waiting for ${[...(accepted.length ? [`accepted work: ${accepted.join(', ')}`] : []), ...later].join('; ')}.`;
    }
    const join = joinStatus(this.store, this.registries, task);
    if (join?.reason) return join.reason;
    try {
      const validation = requirements.definition.validateInputs?.({
        store: this.store,
        task: structuredClone(task),
        runtime: this,
        verifyAuth,
      });
      if (validation?.then) throw new Error('Workflow input validators must complete synchronously.');
    } catch (error) {
      return error.message;
    }
    if (verifyAuth && task.acceptedInputs && !stageView)
      validateAcceptedReferences(this.store, task.acceptedInputs, recordProject(task));
    if (requirements.definition.operation) {
      try {
        prepareOperation(this.store, this.registries.connectors, task, requirements.definition.operation);
      } catch (error) {
        return error.message;
      }
    }
    const isolation = this.isolationBlock(requirements.definition, adapter, w, verifyAuth);
    if (isolation) return isolation;
    return adapter.blockReason(this, verifyAuth, task, w);
  }
  // Steps that let a model read accepted inputs declare requiresIsolation. In workspace
  // mode the model's own OS sandbox must pass its model-free probe; text mode grants
  // no file access. The latest probe result is reused between verified dispatches.
  isolationBlock(definition, adapter, worker, verifyAuth) {
    if (!definition.requiresIsolation) return '';
    let model;
    try {
      model = adapter.modelFor ? adapter.modelFor(this, worker) : adapter;
    } catch {
      return '';
    }
    if (!model.modes || modelMode(model, worker) !== 'workspace' || !model.isolationCheck) return '';
    this.isolation ||= {};
    if (verifyAuth) this.isolation[model.id] = model.isolationCheck(this);
    const probe = this.isolation[model.id];
    return probe && !probe.passed
      ? `${model.name} workspace isolation did not pass (${probe.implementation || 'configured sandbox'}): ${probe.stderr || probe.error || 'See sandbox diagnostics.'}`
      : '';
  }
  adapterFor(task) {
    task = this.workflows.stageView(task);
    const definition = this.workflows.get(task.kind);
    // Tiers never change the CLI, so the adapter follows the employee and task overrides.
    const worker = executionWorker(
      this.store.organization().workers.find(worker => worker.id === task.workerId),
      task,
    );
    return resolveAdapter(this.adapters, definition, worker);
  }
  instructionContext(org, worker, task) {
    task = this.workflows.stageView(task);
    const definition = this.workflows.get(task.kind),
      adapter = this.adapterFor(task);
    const { id, name, goal, direction, revision } = this.store.project(recordProject(task)),
      project = { id, name, goal, direction, revision };
    const context = definition.instructions({ org, task, registries: this.registries, project, store: this.store });
    return {
      ...context,
      project,
      layers: [
        ...(context.layers || []),
        ...(definition.operation
          ? [
              {
                title: 'Controller-owned local operation binding',
                text: JSON.stringify({ binding: definition.operation, inputData: task.inputData }, null, 2),
              },
            ]
          : []),
      ],
      deliveryScope: adapterText(adapter, 'deliveryScope', executionWorker(worker, task), this),
      contracts: this.contractsFor(definition, adapter),
    };
  }
  contractsFor(definition, adapter) {
    const operation = definition.operation && this.registries.connectors.resolve(definition.operation);
    return {
      pack: { id: definition.packId, version: definition.packVersion },
      task: { kind: definition.kind, version: definition.version, acceptFailedChecks: !!definition.acceptFailedChecks },
      adapter: { id: adapter.id, version: adapter.version },
      ...(operation
        ? {
            connector: { id: operation.connectorId, version: operation.connectorVersion },
            operation: {
              id: operation.id,
              version: operation.version,
              inputContract: operation.inputContract,
              outputContract: operation.outputContract,
            },
          }
        : {}),
    };
  }
  compileInstructions(org, worker, task, attemptId, workspace, inputs, directorReferences = [], history = null) {
    return compileInstructions(org, worker, task, attemptId, workspace, inputs, {
      ...this.instructionContext(org, worker, task),
      directorInputReferences: directorReferences,
      ...(history ? { history: { reference: history.reference, attempts: history.attempts } } : {}),
    });
  }
  applyMetadata(attempt, definition, metadata = {}) {
    for (const [field, value] of Object.entries(metadata)) {
      if (!definition.attemptFields.includes(field)) throw new Error('Workflow returned undeclared attempt metadata.');
      attempt[field] = structuredClone(value);
    }
  }
  refreshReadiness() {
    for (const t of this.store
      .tasks()
      .filter(t => t.status === 'ready' || (t.status === 'blocked' && t.controllerWait))) {
      let reason = this.blockReason(t),
        conflict;
      // Queued work whose own prerequisites are met waits for the director to resume its project,
      // before any slot, resource or integration it would wait for next.
      if (!reason && t.queued && this.store.project(recordProject(t)).dispatchPaused) reason = projectPaused;
      if (!reason) {
        const count = this.store
          .allAttempts()
          .filter(
            a =>
              ['running', 'stopping', 'quarantined'].includes(a.status) ||
              (a.status === 'interrupted' && !a.reconciledAt),
          ).length;
        if (count >= this.store.organization().maxParallel) reason = 'Waiting for a studio execution slot.';
        const execution = this.workflows.stageView(t),
          w = this.store.organization().workers.find(w => w.id === execution.workerId);
        const held = this.store
          .leases()
          .find(l =>
            ['employee:' + w?.id, ...this.workflows.requirements(execution, { store: this.store }).resources].includes(
              l.resource,
            ),
          );
        if (held) {
          conflict = this.store.resourceConflict(held.resource, held.attemptId);
          reason = conflict.reason;
        }
        // An approved integration that does not pause the studio goes next on its resources.
        else if (
          this.autonomy.pendingIntegration()?.paused === false &&
          this.workflows
            .requirements(execution, { store: this.store })
            .resources.some(r =>
              this.integration.resources(this.store.task(this.autonomy.pendingIntegration().taskId)).includes(r),
            )
        )
          reason = 'Waiting for the approved source integration.';
      }
      const status = reason ? 'blocked' : 'ready';
      const changed = t.status !== status || t.reason !== reason;
      if (changed) {
        t.status = status;
        t.reason = reason;
        if (t.autonomyNote) {
          if (reason) t.autonomyNote = reason;
          else delete t.autonomyNote;
        }
        t.controllerWait = true;
        this.putTask(t);
      }
      if (conflict) this.store.recordResourceConflict(t.id, conflict, changed);
    }
  }
  reconcile(taskId) {
    const task = this.store.task(taskId);
    const adapter = this.adapterFor(task);
    if (adapter.reconcile) {
      const resolved = result => {
        const current = this.store.task(taskId);
        delete current.autonomyNote;
        this.putTask(current);
        return result;
      };
      const result = adapter.reconcile(this, taskId);
      return result?.then ? result.then(resolved) : resolved(result);
    }
    const unsettled = this.store
      .attempts(taskId)
      .filter(a => ['interrupted', 'quarantined'].includes(a.status) && !a.reconciledAt);
    if (['running', 'stopping', 'review', 'done'].includes(task.status) || !unsettled.length)
      throw new Error('Only an interrupted or quarantined assignment can be reconciled.');
    for (const a of unsettled) {
      if (this.active.has(a.id) || live(a))
        throw new Error(`Attempt ${a.id} still has a live process/group. Stop it in your terminal before reconciling.`);
      a.status = 'interrupted';
      this.checkpoint(a);
      this.store.release(a.id);
      a.reconciledAt = new Date().toISOString();
      this.store.updateAttempt(a);
    }
    task.status = 'ready';
    task.reason = '';
    delete task.autonomyNote;
    this.putTask(task);
    this.store.event('reconciled', taskId, null, 'Previous process is no longer live; reservations released.');
  }
  // A director Start is always accepted when the work is only waiting (MP-012): for its
  // prerequisites, a slot, its employee or a resource. It is queued and starts when free.
  // Anything else, such as a missing approval or capability, still fails. A queued director
  // Start keeps the director's attempt-limit override until it runs.
  queueStart(taskId) {
    try {
      return this.start(taskId, { director: true });
    } catch (error) {
      const task = this.store.task(taskId);
      // Judge the error Start raised, not a reason left on the task by an earlier check.
      if (!['ready', 'blocked'].includes(task.status) || !(waiting(error.message) || error.wait)) throw error;
      task.queued = true;
      task.directorStart = { at: new Date().toISOString() };
      delete task.autonomyNote;
      this.putTask(task);
      const projectId = recordProject(task);
      if (!this.store.project(projectId).dispatchPaused) this.enablePipeline(projectId);
      this.schedule();
      return { ok: true, queued: true, reason: task.reason };
    }
  }
  // The attempt limit bounds automatic dispatch and retries. A director's explicit
  // start may go past it; the attempt records that override.
  start(taskId, { director = false } = {}) {
    const store = this.store,
      task = this.workflows.stageView(store.task(taskId));
    if (task.approval && task.approval.status !== 'approved')
      throw new Error('Director work approval is required before starting this assignment.');
    if (!['ready', 'failed', 'cancelled', 'blocked'].includes(task.status))
      throw new Error('Only ready or stopped assignments can start.');
    if (
      store
        .attempts(task.id)
        .some(a => ['interrupted', 'quarantined'].includes(a.status) && store.leases().some(l => l.attemptId === a.id))
    )
      throw new Error('Reconcile the interrupted attempt before starting another.');
    const reason = this.blockReason(task, true);
    if (reason) {
      task.status = 'blocked';
      task.reason = reason;
      if (task.autonomyNote) task.autonomyNote = reason;
      task.controllerWait = !reason.includes('subscription login');
      this.putTask(task);
      store.event('blocked', task.id, null, reason);
      throw new Error(reason);
    }
    const org = projectOrganization(store, recordProject(task)),
      worker = this.effectiveWorker(org, task);
    const previousAttempts = this.workflows.stageAttempts(store, task).length;
    if (previousAttempts >= task.maxAttempts && (!director || this.workflows.get(task.kind).fixedAttemptLimit))
      throw new Error(
        this.workflows.get(task.kind).fixedAttemptLimit
          ? `Assignment reached its fixed ${task.maxAttempts}-attempt limit. Create a newly scoped assignment to continue.`
          : `Assignment reached its ${task.maxAttempts}-attempt limit for automatic runs. Press Start to run it again.`,
      );
    const projectId = recordProject(task),
      project = this.instructionContext(org, worker, task).project;
    const id = 'attempt-' + randomUUID(),
      job = jobDirectory(store, { id, projectId }),
      output = path.join(job, 'output');
    // A join receives its accepted children only; the rest are recorded as missing.
    const join = joinStatus(store, this.registries, task);
    if (join?.reason) throw new Error(join.reason);
    const references =
      this.workflows.stageInputs(store, task) ??
      task.dependencies
        .filter(depId => !join || !join.missing.includes(depId))
        .map(depId => {
          const dep = store.task(depId),
            accepted = store.attempt(dep.acceptedAttemptId);
          const pinned = task.acceptedInputs?.find(ref => ref.taskId === depId);
          if (pinned && pinned.attemptId !== accepted.id)
            throw new Error('Accepted prerequisite no longer matches the approved repair input.');
          return {
            taskId: depId,
            attemptId: accepted.id,
            summary: accepted.result.summary,
            artifacts: accepted.artifacts,
          };
        });
    // A join's controller transform runs on its accepted inputs and is staged as one more input.
    const transformed = task.join?.transform ? applyTransform(store, task.join.transform, references) : null;
    const missing = missingInputFormats(this.workflows.formats, this.workflows.get(task.kind), [
      ...references,
      ...(transformed ? [transformed.reference] : []),
    ]);
    if (missing.length) {
      // Accepted inputs cannot change by waiting, so this needs the director.
      task.status = 'blocked';
      task.reason = `Inputs are missing consumed ${missing.map(id => `${this.workflows.formats.get(id).label} (${id})`).join(', ')}. Accept a prerequisite that produces it.`;
      task.controllerWait = false;
      if (task.autonomyNote) task.autonomyNote = task.reason;
      this.putTask(task);
      store.event('blocked', task.id, null, task.reason);
      throw new Error(task.reason);
    }
    const inputs = [
      ...references.map(ref => ({
        taskId: ref.taskId,
        attemptId: ref.attemptId,
        summary: ref.summary,
        artifacts: ref.artifacts.map((a, i) => ({
          path: `../inputs/${ref.taskId}/${i}-${path.basename(a.path)}`,
          hash: a.hash,
          kind: a.kind,
        })),
      })),
      ...(transformed ? [transformed.reference] : []),
    ];
    const { definition, resources } = this.workflows.requirements(task, { store: this.store }),
      adapter = this.adapterFor(task);
    const operation =
      definition.operation && prepareOperation(store, this.registries.connectors, task, definition.operation);
    const directorInputs = directorInputsFor(store, task),
      directorReferences = directorInputReferences(directorInputs);
    // Earlier attempts on this work, as bounded unaccepted reference data (never inputs).
    const history = buildAttemptHistory(store, task, { attemptId: id });
    const snapshot = this.compileInstructions(org, worker, task, id, output, inputs, directorReferences, history);
    const configuration = adapter.configuration(this, worker, task);
    if (adapter.id !== worker.provider) configuration.executionAdapter = adapter.id;
    const a = {
      id,
      projectId,
      project,
      taskId: task.id,
      workerId: worker.id,
      provider: adapter.id,
      requestedModel: adapter.requestedModel(worker, this),
      requestedEffort: worker.effort || '',
      ...(this.tierOf(task) ? { requestedTier: this.tierOf(task) } : {}),
      ...(previousAttempts >= task.maxAttempts
        ? { directorOverride: { attemptLimit: task.maxAttempts, attemptNumber: previousAttempts + 1 } }
        : {}),
      reportedModel: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: null,
      sessionId: null,
      outputFolder: output,
      artifacts: [],
      configuration,
      assignment: {
        ...structuredClone(task),
        projectId,
        resources,
        directorInputs,
        directorInputReferences: directorReferences,
      },
      inputReferences: inputs,
      directorInputs,
      directorInputReferences: directorReferences,
      ...(join?.missing.length ? { joinMissing: [...join.missing] } : {}),
      ...(transformed ? { inputTransform: transformed.provenance } : {}),
      delivery: adapterText(adapter, 'delivery', worker, this),
      contracts: this.contractsFor(definition, adapter),
    };
    if (org.projectOrganization)
      a.organization = {
        ...org.projectOrganization,
        teamId: worker.teamId,
        team: worker.team,
        role: worker.role,
        responsibility: worker.responsibility,
      };
    if (operation) a.operation = operation;
    this.applyMetadata(
      a,
      definition,
      definition.prepareAttempt?.({
        org,
        task,
        registries: this.registries,
        project,
        store,
        runtime: this,
        attemptId: id,
      }),
    );
    try {
      store.tx(() => {
        if (
          store
            .allAttempts()
            .filter(
              x =>
                ['running', 'stopping', 'quarantined'].includes(x.status) ||
                (x.status === 'interrupted' && !x.reconciledAt),
            ).length >= org.maxParallel
        )
          throw Object.assign(new Error('Studio concurrency limit reached.'), { wait: true });
        try {
          store.claim(['employee:' + worker.id, ...resources], id);
        } catch (error) {
          // A busy employee or resource frees itself; the controller can wait for it.
          throw Object.assign(error, { wait: true });
        }
        store.insertAttempt(a, snapshot);
        task.status = 'running';
        task.reason = '';
        delete task.autonomyNote;
        task.controllerWait = false;
        task.lastAttemptId = id;
        delete task.directorStart;
        this.putTask(task);
      });
    } catch (err) {
      task.status = 'blocked';
      task.reason = err.message;
      if (task.autonomyNote) task.autonomyNote = err.message;
      task.controllerWait = true;
      this.putTask(task);
      store.event('blocked', task.id, null, err.message);
      if (err.conflict) store.recordResourceConflict(task.id, err.conflict, true);
      throw err;
    }
    const entry = {
      definition,
      adapter,
      quotaKey: quotaKey(adapter, worker),
      attempt: a,
      job,
      output,
      buffers: {},
      timer: null,
      child: null,
      cancelled: false,
      timedOut: false,
      nativeError: null,
      protectedFiles: new Map(),
      history: history ? { reference: history.reference, projection: history.projection } : null,
      // Adapter cleanups (for example a disposable worktree), run once the attempt has finished.
      cleanup: [],
    };
    this.active.set(id, entry);
    try {
      this.startPhase(entry, 'attempt');
      fs.mkdirSync(output, { recursive: true });
      fs.mkdirSync(path.join(job, 'inputs'), { recursive: true });
      stageDirectorInputs(store, entry);
      // A reference stages the accepted artifacts it names, which may be some of them (a stage can
      // read only what it needs, such as a candidate's diff rather than its changed files).
      references.forEach((ref, n) => {
        // A controller transform's output has no producing attempt; it is staged below.
        if (!ref.attemptId) return;
        const accepted = store.attempt(ref.attemptId);
        ref.artifacts.forEach((artifact, i) => {
          if (!accepted.artifacts.some(item => item.path === artifact.path && item.hash === artifact.hash))
            throw new Error('Accepted input is not a recorded artifact of its attempt.');
          const contents = fs.readFileSync(artifactPath(store, accepted, artifact.path));
          if (hash(contents) !== artifact.hash) throw new Error('Accepted input was modified after acceptance.');
          const dest = path.resolve(output, inputs[n].artifacts[i].path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, contents);
          entry.protectedFiles.set(dest, artifact.hash);
        });
      });
      if (transformed) {
        const dest = path.resolve(output, transformed.reference.artifacts[0].path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, transformed.contents);
        entry.protectedFiles.set(dest, transformed.reference.artifacts[0].hash);
      }
      if (history) stageAttemptHistory(job, history, entry.protectedFiles);
      this.seedContinuation(entry);
      const guidance = path.join(output, 'AGENTS.md');
      fs.writeFileSync(guidance, snapshot.text);
      entry.protectedFiles.set(guidance, snapshot.hash);
      fs.writeFileSync(path.join(job, 'result-schema.json'), JSON.stringify(resultSchema, null, 2));
      fs.writeFileSync(path.join(job, 'instructions.json'), JSON.stringify(snapshot, null, 2));
      fs.writeFileSync(path.join(job, 'assignment.json'), JSON.stringify(a.assignment, null, 2));
      store.event('started', task.id, id, `${worker.displayName} started ${adapter.name}.`);
      if (a.directorOverride)
        store.event(
          'attempt_limit_override',
          task.id,
          id,
          `Director started attempt ${a.directorOverride.attemptNumber}, past the ${a.directorOverride.attemptLimit}-attempt limit for automatic runs.`,
        );
      entry.timer = setTimeout(() => {
        entry.timedOut = true;
        this.stop(id);
      }, task.maxSeconds * 1000);
      validateProtectedFiles(entry);
      adapter.start(this, entry, worker);
    } catch (err) {
      this.finish(entry, null, err.message);
    }
    return { attemptId: id };
  }
  // Writes the work an attempt continues from (continueFrom) at its original paths in the new output
  // folder: each file's verified checkpoint bytes, as an ordinary work file rather than a protected
  // one. When a file no longer verifies, the files already seeded are removed and the attempt starts
  // fresh with the reason instead of failing its dispatch. An event records either.
  seedContinuation(entry) {
    const a = entry.attempt,
      carried = a.continueFrom;
    if (!carried) return;
    const written = [];
    try {
      const previous = carried.files.length ? this.store.attempt(carried.attemptId) : null;
      for (const item of carried.files) {
        const bytes = continuationFile(this.store, previous, item.path, item.hash),
          target = path.resolve(entry.output, item.path);
        if (!target.startsWith(path.resolve(entry.output) + path.sep))
          throw new Error(`Carried work path is outside the output folder: ${item.path}`);
        const created = fs.mkdirSync(path.dirname(target), { recursive: true });
        if (created) written.push(created);
        fs.writeFileSync(target, bytes, { flag: 'wx' });
        written.push(target);
      }
    } catch (error) {
      // Created folders hold only files seeded here; nothing else has written to the output yet.
      for (const item of written.reverse()) fs.rmSync(item, { recursive: true, force: true });
      a.continueFrom = {
        attemptId: carried.attemptId,
        files: [],
        fresh: { reason: `its recorded work did not verify when this attempt started (${error.message})` },
      };
      this.store.updateAttempt(a);
    }
    const { attemptId, files, fresh } = a.continueFrom;
    this.store.event(
      'work_continuation',
      a.taskId,
      a.id,
      fresh
        ? `Starts without the work of ${attemptId}: ${fresh.reason}. Its history still shows that attempt.`
        : files.length
          ? `Continues from the work of ${attemptId}: ${files.map(item => item.path).join(', ')}.`
          : `Continues from ${attemptId}, which recorded no work files.`,
    );
  }
  // Work an attempt continued from stays in its result although the CLI did not list it, as the kind
  // of file its task type produces, unless the CLI deleted it. It is then validated, registered and
  // reviewed like every returned file; nothing is accepted because it was carried.
  withCarriedWork(entry, result) {
    const files = entry.attempt.continueFrom?.files || [],
      produced = entry.definition.produces?.[0];
    if (
      !files.length ||
      !produced ||
      !['completed', 'blocked'].includes(result?.outcome) ||
      !Array.isArray(result.artifacts)
    )
      return result;
    const listed = new Set(result.artifacts.map(item => item?.path)),
      kind = this.workflows.formats.get(produced).artifactKind,
      kept = files.filter(item => !listed.has(item.path) && fs.existsSync(path.join(entry.output, item.path)));
    return kept.length
      ? { ...result, artifacts: [...result.artifacts, ...kept.map(item => ({ path: item.path, kind }))] }
      : result;
  }
  // Keep the simulator method as a compatibility seam for existing fixtures.
  runMock(entry) {
    return runMock.call(this, entry);
  }
  runNative(...args) {
    const result = runNative.call(this, ...args),
      entry = args[0];
    entry.child.once('close', () => {
      if (entry.attempt.status === 'quarantined') {
        const phase = entry.phases?.find(item => item.payload.phaseId === 'attempt');
        if (phase) this.store.finishPhase(phase, 'interrupted', { timing: 'process-group-unconfirmed' });
      }
    });
    return result;
  }
  parseOutput(...args) {
    return parseOutput.call(this, ...args);
  }
  recordLine(...args) {
    return recordLine.call(this, ...args);
  }
  nativeFailure(...args) {
    const result = nativeFailure.call(this, ...args);
    // A hold it recorded, with or without a reset time, changes what the timer waits for.
    if (args[0].quota) this.armQuotaTimer();
    return result;
  }
  startPhase(entry, phaseId, evidence) {
    const phase = this.store.startPhase(entry.attempt, phaseId);
    phase.evidence = evidence;
    (entry.phases ||= []).push(phase);
    return phase;
  }
  interruptPhases(attempt) {
    const events = this.store.phaseEvents(attempt.id).map(event => event.payload),
      finished = new Set(events.filter(event => event.boundary === 'finish').map(event => event.occurrenceId));
    // Only end the enclosing execution observation. Nested work may still be alive.
    for (const payload of events.filter(
      event => event.phaseId === 'attempt' && event.boundary === 'start' && !finished.has(event.occurrenceId),
    ))
      this.store.finishPhase(
        { payload, clock: performance.now() - Math.max(0, Date.now() - Date.parse(payload.timestamp)) },
        'interrupted',
        { timing: 'observed-until-restart' },
      );
  }
  finish(entry, result, error = null) {
    if (!this.active.has(entry.attempt.id)) return;
    // Also guard adapters that throw after spawning, rather than reaching the
    // native close callback. Unknown/live groups retain all ownership.
    if (live(entry.attempt)) {
      const a = entry.attempt,
        task = this.store.task(a.taskId);
      entry.nativeError ||= error || 'Adapter tried to finish before its process/group was confirmed stopped.';
      a.status = 'quarantined';
      a.finishedAt = new Date().toISOString();
      task.status = 'blocked';
      task.reason = 'Process/group is still live or unknown. Reservations retained until reconciliation.';
      this.store.updateAttempt(a);
      this.putTask(task);
      this.store.event('quarantined', a.taskId, a.id, task.reason);
      return;
    }
    clearTimeout(entry.timer);
    clearTimeout(entry.mockTimer);
    clearTimeout(entry.killTimer);
    const a = entry.attempt,
      task = this.store.task(a.taskId);
    // Observe adapter-owned evidence before persisting the terminal attempt. A cancelled
    // native process never invokes its result callback, but its TAP may still be useful.
    const phaseEvidence = new Map();
    for (const phase of entry.phases || []) {
      try {
        phaseEvidence.set(phase, phase.evidence?.() || {});
      } catch {}
    }
    const integrity = [];
    let proposedWork;
    try {
      validateProtectedFiles(entry);
      if (!entry.cancelled && !error) {
        result = this.withCarriedWork(entry, result);
        validateResult(result, entry.definition.maxArtifacts);
        if (result.taskId !== a.taskId) throw new Error('Result belongs to a different assignment.');
        for (const item of result.artifacts) {
          if (item.path === 'AGENTS.md') throw new Error('Guidance is not a deliverable.');
          const p = artifactPath(this.store, a, item.path);
          a.artifacts.push({ ...item, hash: hash(fs.readFileSync(p)), bytes: fs.statSync(p).size });
        }
        if (result.outcome === 'completed' && !a.artifacts.length)
          throw new Error('Completed work requires at least one staged artifact.');
        if (result.outcome === 'completed') {
          const readArtifact = relative => {
            const item = a.artifacts.find(item => item.path === relative);
            if (!item) throw new Error('Workflow validation requested an unregistered artifact.');
            const contents = fs.readFileSync(artifactPath(this.store, a, relative));
            if (hash(contents) !== item.hash) throw new Error('Artifact changed during result validation.');
            return contents;
          };
          if (a.operation) integrity.push(...validateOperationResult(this.registries.connectors, a, readArtifact));
          integrity.push(...producedFormatChecks(this.workflows.formats, entry.definition, a, readArtifact));
          const validation = entry.definition.validateOutput({
            task: structuredClone(a.assignment),
            attempt: structuredClone(a),
            result: structuredClone(result),
            checks: integrity,
            readArtifact,
          });
          if (validation?.then) throw new Error('Workflow output validators must complete synchronously.');
          if (validation?.checks && validation.checks !== integrity) integrity.push(...validation.checks);
          validateResult({ ...result, checks: integrity }, entry.definition.maxArtifacts);
          if (!entry.definition.acceptFailedChecks && integrity.some(check => check.status === 'fail'))
            throw new Error('Workflow output failed semantic validation.');
          this.applyMetadata(a, entry.definition, validation?.metadata);
        }
        a.result = result;
        if (
          result.outcome === 'completed' &&
          // A task with stages advances itself after acceptance; it never proposes separate work.
          !entry.definition.stages &&
          entry.definition.proposeWork &&
          (entry.definition.autoProposeWork || a.assignment.proposalMode === 'backlog')
        )
          proposedWork = prepareProposedWork(this.store, this.registries, task, a);
      }
    } catch (err) {
      error = err.message;
    }
    a.controllerChecks = integrity;
    a.finishedAt = new Date().toISOString();
    a.status = entry.timedOut
      ? 'failed'
      : entry.cancelled && !entry.nativeError
        ? 'cancelled'
        : error
          ? entry.quota || entry.needsDecision
            ? 'blocked'
            : 'failed'
          : result?.outcome === 'blocked'
            ? 'blocked'
            : 'review';
    a.error = entry.timedOut ? 'Assignment time limit reached.' : error;
    // The provider's usage limit stopped this attempt, not its work; it doesn't count toward the attempt limit.
    if (a.status === 'blocked' && error && entry.quota) {
      a.subscriptionHold = entry.quota;
      if (entry.quotaReset) a.subscriptionReset = entry.quotaReset;
    }
    task.status = a.status;
    task.reason =
      a.error || (a.status === 'blocked' ? result?.issues.join(' ') || result?.summary || 'Worker is blocked.' : '');
    // Queued work a usage limit stopped stays queued when the CLI named its reset time: it waits on
    // the hold and starts again once the hold clears itself. Without a known time, or after a
    // cancellation, the director decides.
    const resumes = !!a.subscriptionReset && !!task.queued && !entry.cancelled;
    if (resumes) {
      task.controllerWait = true;
      task.reason = this.holdWait(a.subscriptionHold, Date.parse(a.subscriptionReset));
    } else if (a.status !== 'review') {
      task.queued = false;
      task.controllerWait = false;
    }
    this.workflows.stagesOf(task)?.finished?.(task, a);
    this.checkpoint(a);
    this.store.tx(() => {
      this.store.updateAttempt(a);
      this.putTask(task);
      if (a.status === 'review' && proposedWork) recordProposedWork(this.store, task, proposedWork);
      this.store.release(a.id);
      if (resumes && !this.store.project(recordProject(task)).dispatchPaused) this.enablePipeline(recordProject(task));
    });
    this.active.delete(a.id);
    // Negative reports remain reviewable evidence; phase outcomes describe their measured
    // result independently of the task's review/acceptance state.
    const phaseOutcome =
      a.status === 'review'
        ? [...(result?.checks || []), ...integrity].some(check => check.status === 'fail')
          ? 'failed'
          : 'succeeded'
        : a.status;
    for (const phase of [...(entry.phases || [])].reverse()) {
      this.store.finishPhase(phase, phaseOutcome, phaseEvidence.get(phase) || {});
    }
    this.store.event(
      a.status,
      a.taskId,
      a.id,
      resumes ? `${a.error} ${task.reason}` : task.reason || result?.summary || 'Attempt stopped.',
    );
    for (const cleanup of entry.cleanup)
      try {
        cleanup();
      } catch (err) {
        this.store.event('cleanup_failed', a.taskId, a.id, `Attempt cleanup did not complete: ${err.message}`);
      }
    setImmediate(() => this.autonomy.settled(a.taskId));
    if (resumes) this.schedule();
  }
  checkpoint(attempt) {
    // Capture is best effort evidence; it cannot prevent terminal persistence,
    // lease cleanup, or disposable worktree cleanup after a confirmed stop.
    try {
      const result = captureContinuation(this.store, attempt);
      this.store.event(
        'continuation_checkpoint',
        attempt.taskId,
        attempt.id,
        JSON.stringify({ status: result.status, issues: result.issues || [] }),
      );
    } catch (error) {
      this.store.event(
        'continuation_checkpoint',
        attempt.taskId,
        attempt.id,
        JSON.stringify({ status: 'unavailable', issues: [error.message] }),
      );
    }
  }
  stop(id) {
    const entry = this.active.get(id);
    if (!entry) throw new Error('No live attempt to cancel.');
    if (entry.timedOut && !entry.attempt.stopContext) {
      const a = entry.attempt,
        phase = [...(entry.phases || [])]
          .reverse()
          .find(
            item =>
              item.payload.attemptId === a.id && item.payload.taskId === a.taskId && item.payload.phaseId !== 'attempt',
          );
      let evidence;
      try {
        evidence = phase?.evidence?.();
      } catch {}
      a.stopContext = {
        reason: 'time-limit',
        timedOut: true,
        requestedAt: new Date().toISOString(),
        taskKind: a.assignment?.kind || null,
        stage:
          a.assignment?.stageState?.current ||
          a.assignment?.sourceStage?.phase ||
          a.assignment?.sourceStage?.current ||
          a.assignment?.stage ||
          null,
        activity: phase?.payload.phaseId || 'unknown',
        phaseId: phase?.payload.phaseId || 'attempt',
        occurrenceId:
          phase?.payload.occurrenceId ||
          entry.phases?.find(item => item.payload.phaseId === 'attempt')?.payload.occurrenceId ||
          null,
        phaseFinished: phase?.closed || false,
        ...(phase?.payload.phaseId === 'test' && evidence ? { testEvidence: evidence } : {}),
      };
      this.store.updateAttempt(a);
    }
    if (entry.cancelled) return;
    if (entry.adapter.stop) {
      entry.adapter.stop(this, entry);
      return;
    }
    entry.cancelled = true;
    entry.attempt.status = 'stopping';
    this.store.updateAttempt(entry.attempt);
    const t = this.store.task(entry.attempt.taskId);
    t.status = 'stopping';
    this.putTask(t);
    this.store.event(
      'stopping',
      t.id,
      id,
      entry.timedOut
        ? 'Time limit reached; stopping the process.'
        : 'Cancellation requested. Reservations remain until the process closes.',
    );
    if (!entry.child) {
      this.finish(entry, null);
      return;
    }
    this.terminate(entry, false);
    entry.killTimer = setTimeout(() => this.terminate(entry, true), stopGrace);
  }
  // Ends the attempt's current process and its tree, asked or forced.
  terminate(entry, force) {
    try {
      if (this.fixtureProcessTermination) {
        this.fixtureProcessTermination(entry, force);
        return;
      }
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/PID', String(entry.child.pid), '/T', ...(force ? ['/F'] : [])], {
          windowsHide: true,
          timeout: 3000,
        });
      else process.kill(-entry.child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
  // Stops every active attempt and waits, within a bound, for each to leave: a process still running after
  // the grace period is forced, one cancelled before shutdown too, and a stop it confirms finishes as
  // cancelled. Nothing the attempts armed stays armed when it returns, so the store and server can close.
  async shutdown() {
    this.closing = true;
    clearImmediate(this.scheduled);
    this.scheduled = null;
    clearTimeout(this.quotaTimer);
    this.quotaTimer = null;
    const entries = [...this.active.values()];
    for (const entry of entries) this.stop(entry.attempt.id);
    this.integration.stop(this);
    for (const adapter of this.adapters.list()) adapter.shutdown?.(this);
    const started = Date.now(),
      bound = Math.max(5000, ...this.adapters.list().map(adapter => adapter.shutdownWait?.(this) || 0));
    let forced = false;
    while (this.active.size) {
      if (!forced && Date.now() - started >= stopGrace) {
        forced = true;
        for (const entry of this.active.values())
          if (entry.child) {
            clearTimeout(entry.killTimer);
            this.terminate(entry, true);
          }
      }
      // A close that a slow termination left queued is observed before the bound is checked.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (Date.now() - started >= bound) break;
    }
    for (const entry of [...this.active.values()]) this.abandon(entry);
    for (const entry of entries) {
      clearTimeout(entry.timer);
      clearTimeout(entry.killTimer);
      clearTimeout(entry.mockTimer);
    }
  }
  // An attempt whose process shutdown could not confirm stopped keeps its reservations and its stopping
  // record, which the next start records as interrupted for reconciliation; nothing is released or replayed.
  // The controller lets go of the process: its close is not observed on the closed store (runNative), and
  // its pipes and process handle no longer keep this process running.
  abandon(entry) {
    const a = entry.attempt;
    entry.abandoned = true;
    this.active.delete(a.id);
    if (!entry.child) return;
    for (const stream of [entry.child.stdin, entry.child.stdout, entry.child.stderr]) stream?.destroy();
    entry.child.unref();
    this.store.event(
      'interrupted',
      a.taskId,
      a.id,
      "The controller stopped before this attempt's process was confirmed stopped. Its reservations stay held until it is reconciled.",
    );
  }
}
