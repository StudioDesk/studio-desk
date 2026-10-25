import fs from 'node:fs';
import path from 'node:path';
import { adapterText, modelAdapter, modelMode } from '../core/execution.mjs';
import { artifactPath } from '../core/artifacts.mjs';
import { jobDirectory, recordProject } from '../core/projects.mjs';
import { measuredSourceEvidence } from '../connectors/source-changes.mjs';
import { sourceWorktreeRoot, worktreeName } from '../connectors/source-worktrees.mjs';
import { snapshotCommit, verifySnapshot } from './source-snapshot.mjs';
import { live } from './process.mjs';
import { profileOf } from '../connectors/source-profile.mjs';

// The location is controller-selected and outside the employee's output folder.
const referencePath = '../source';
const planningScope = mode =>
  mode === 'workspace'
    ? "Before planning, read and search the verified measured source reference at ../source. Locate the relevant implementations, their callers and the tests asserting each behavior or message a story changes; include those tests in that story's file scope. This reference is planning context only and grants no source editing authority. Preserve its contents. Do not execute source or stories. Return only source-breakdown.json."
    : 'Plan from the supplied measured file list and source-context documents, plus the director brief/direction. No repository reference is supplied in text delivery: do not search the filesystem or claim to inspect implementations or tests beyond the supplied documents. Identify relevant behavior-pinning tests from the supplied evidence and state any missing context. Return only source-breakdown.json.';

function removeReference(runtime, attempt) {
  if (attempt.sourceBreakdownContext?.mode !== 'workspace') return;
  if (live(attempt)) throw new Error('The breakdown employee is still live; its source reference is retained.');
  // Never delete a persisted/model-supplied path. jobDirectory validates the identities.
  fs.rmSync(path.join(jobDirectory(runtime.store, attempt), 'source'), { recursive: true, force: true });
}

export const sourceBreakdownAdapter = {
  id: 'source-breakdown',
  version: 'source-breakdown-adapter-v1',
  name: 'Measured source planning',
  workerSelectable: false,
  subscription: true,
  capabilities: ['text-output'],
  modelFor: (runtime, worker) => modelAdapter(runtime.adapters, worker),
  quotaKey: worker => worker.provider,
  initialize(runtime) {
    // Finish can have been recorded immediately before a controller crash. Running,
    // quarantined and unreconciled attempts keep their reference until reconciliation.
    for (const attempt of runtime.store.allAttempts())
      if (
        attempt.contracts?.adapter?.id === 'source-breakdown' &&
        !['running', 'stopping', 'quarantined'].includes(attempt.status) &&
        !(attempt.status === 'interrupted' && !attempt.reconciledAt) &&
        !live(attempt)
      )
        try {
          removeReference(runtime, attempt);
        } catch (error) {
          runtime.store.event(
            'cleanup_failed',
            attempt.taskId,
            attempt.id,
            `Attempt cleanup did not complete: ${error.message}`,
          );
        }
  },
  status: () => ({ available: true, label: "Verified measured source context, then the employee's model" }),
  blockReason(runtime, verifyAuth, task, worker) {
    try {
      const model = modelAdapter(runtime.adapters, worker);
      if (worker.effort && model.efforts?.length && !model.efforts.includes(worker.effort))
        return `${model.name} does not accept effort "${worker.effort}". Change the employee or task execution settings.`;
      return model.blockReason(runtime, verifyAuth, task, worker);
    } catch (error) {
      return error.message;
    }
  },
  configuration(runtime, worker, task) {
    const model = modelAdapter(runtime.adapters, worker);
    return {
      ...model.configuration(runtime, worker, task),
      executionAdapter: 'source-breakdown',
      model: model.id,
      mode: modelMode(model, worker),
    };
  },
  requestedModel: (worker, runtime) => modelAdapter(runtime.adapters, worker).requestedModel(worker),
  delivery: (worker, runtime) => adapterText(modelAdapter(runtime.adapters, worker), 'delivery', worker, runtime),
  deliveryScope: (worker, runtime) => {
    const model = modelAdapter(runtime.adapters, worker);
    return `${adapterText(model, 'deliveryScope', worker, runtime)} ${planningScope(modelMode(model, worker))}`;
  },
  start(runtime, entry, worker) {
    const model = modelAdapter(runtime.adapters, worker),
      mode = modelMode(model, worker),
      a = entry.attempt,
      pinned = a.sourceBreakdown;
    const source = measuredSourceEvidence(runtime.store, pinned.taskId, pinned.attemptId, recordProject(a));
    if (
      JSON.stringify(source) !== JSON.stringify(pinned) ||
      a.assignment.dependencies.length !== 1 ||
      a.assignment.dependencies[0] !== source.taskId ||
      a.inputReferences.length !== 1 ||
      a.inputReferences[0].taskId !== source.taskId ||
      a.inputReferences[0].attemptId !== source.attemptId
    )
      throw new Error('Recorded breakdown/check source identities changed. Request fresh evidence.');
    a.sourceBreakdownContext = { mode };
    let plan, report;
    const destination = path.join(entry.job, 'source');
    if (mode === 'workspace') {
      const checked = runtime.store.attempt(source.attemptId);
      report = JSON.parse(fs.readFileSync(artifactPath(runtime.store, checked, source.path)));
      a.sourceBreakdownContext = {
        mode,
        path: referencePath,
        commit: report.source.commit,
        sourceHash: source.sourceHash,
      };
      runtime.store.updateAttempt(a);
      try {
        plan = snapshotCommit(
          checked.sourceCheck.root,
          sourceWorktreeRoot(runtime),
          'b-' + worktreeName(a.id),
          { commit: report.source.commit },
          destination,
          report,
          profileOf(checked.sourceCheck),
        );
      } catch (error) {
        throw new Error(
          `Breakdown source reference preparation failed: ${error.message} No employee model was started.`,
        );
      }
      entry.cleanup.push(() => removeReference(runtime, a));
    }
    runtime.store.updateAttempt(a);
    entry.model = model;
    model.run(runtime, entry, worker, {
      mode,
      // Text receives only the already staged measured report/context, never a repository payload.
      editable: [],
      context: [],
      onComplete(result) {
        if (plan) verifySnapshot(plan, destination, report);
        runtime.finish(entry, result);
      },
    });
  },
  recordEvent: (runtime, entry, data) => entry.model?.recordEvent?.(runtime, entry, data),
  reconcile(runtime, taskId) {
    const task = runtime.store.task(taskId),
      unsettled = runtime.store
        .attempts(taskId)
        .filter(a => ['interrupted', 'quarantined'].includes(a.status) && !a.reconciledAt);
    if (['running', 'stopping', 'review', 'done'].includes(task.status) || !unsettled.length)
      throw new Error('Only an interrupted or quarantined assignment can be reconciled.');
    // Check every owner before deleting anything or releasing any reservation.
    for (const a of unsettled)
      if (runtime.active.has(a.id) || live(a))
        throw new Error(`Attempt ${a.id} still has a live process/group. Stop it in your terminal before reconciling.`);
    for (const a of unsettled) {
      removeReference(runtime, a);
      runtime.store.release(a.id);
      a.status = 'interrupted';
      a.reconciledAt = new Date().toISOString();
      runtime.store.updateAttempt(a);
    }
    task.status = 'ready';
    task.reason = '';
    runtime.putTask(task);
    runtime.store.event(
      'reconciled',
      taskId,
      null,
      'Previous process is no longer live; source reference removed and reservations released.',
    );
  },
};
