import fs from 'node:fs';
import { hash } from './contracts.mjs';
import { artifactPath } from './artifacts.mjs';
import { assertProject, recordProject } from './projects.mjs';
import { prepareProposedWork, recordProposedWork } from './proposals.mjs';
import { expandMaps } from './fanout.mjs';
import { autonomyPolicy } from './autonomy.mjs';
import { recordLibraryProposals } from './library.mjs';
import { stepContract } from './step-contract.mjs';
import { advanceFlow } from './flow-run.mjs';

// Accepts a reviewed attempt. Shared by the director's route and the
// controller's autonomy policy so both apply exactly the same checks.
// `by` is { type: 'director' }, { type: 'director', over: { reason } } to accept over a failed check where the step's
// contract allows it (the director's decision, November 2, 2026), or { type: 'policy', revision, reason }. The policy
// never accepts over a failed check.
export function acceptAttempt(store, registries, task, by = { type: 'director' }) {
  if (task.kind === 'plan') throw new Error('Use plan approval to create and queue its proposed assignments.');
  if (task.status !== 'review') throw new Error('Only reviewed outputs can be accepted.');
  const a = store.attempt(task.lastAttemptId);
  assertProject(store, a, recordProject(task));
  if (a.status !== 'review' || !a.result || a.result.outcome !== 'completed')
    throw new Error('Attempt is not ready for acceptance.');
  for (const item of a.artifacts)
    if (hash(fs.readFileSync(artifactPath(store, a, item.path))) !== item.hash)
      throw new Error('Artifact changed after validation.');
  const execution = registries.workflows.stageView(task),
    definition = registries.workflows.get(execution.kind),
    stages = registries.workflows.stagesOf(task);
  const policy = a.contracts?.task || definition,
    failed = a.result.checks.filter(c => c.status === 'fail').map(c => c.name);
  if (by.type === 'director' && by.over !== undefined) {
    if (!failed.length) throw new Error('No check failed, so accept it without a reason.');
    if (!stepContract(definition).acceptance.acceptOver)
      throw new Error("This step's contract does not take acceptance over a failed check.");
    by = { type: 'director', over: { reason: by.over.reason, checks: failed } };
  } else if (!policy.acceptFailedChecks && failed.length)
    throw new Error('The worker reported a failed check. Accept over it with a reason, or request a revision.');
  // Definitions whose evidence can change after validation have it rechecked at acceptance.
  if (definition.revalidateOnAccept) {
    const checks = [];
    definition.validateOutput({
      task: structuredClone(a.assignment),
      attempt: structuredClone(a),
      result: structuredClone(a.result),
      checks,
      readArtifact: name => fs.readFileSync(artifactPath(store, a, name)),
    });
  }
  // A task with stages advances itself after acceptance; it never proposes separate work.
  const prepared = definition.proposeWork && !stages ? prepareProposedWork(store, registries, task, a) : null;
  a.status = 'accepted';
  a.acceptedAt = new Date().toISOString();
  a.acceptedBy = structuredClone(by);
  task.status = 'done';
  task.queued = false;
  task.acceptedAttemptId = a.id;
  task.reason = '';
  delete task.autonomyNote;
  store.tx(() => {
    store.updateAttempt(a);
    store.putTask(task);
    stages?.accepted?.(store, registries, task, a);
    // A map whose source this is expands now, within the run's approved envelope.
    expandMaps(store, registries, task, a);
    if (prepared) recordProposedWork(store, task, prepared);
    // A flow's task follows its flow's edges in the same transaction (1.2); other tasks write nothing more.
    if (task.flowReference) advanceFlow(store, registries, task);
  });
  store.event(
    'accepted',
    task.id,
    a.id,
    by.type === 'policy'
      ? `Accepted by autonomy policy revision ${by.revision}: ${by.reason}`
      : by.over
        ? `Director accepted the recorded result over ${by.over.checks.length === 1 ? 'a failed check' : `${by.over.checks.length} failed checks`} (${by.over.checks.join(', ')}): ${by.over.reason}`
        : 'Director accepted the recorded result.',
  );
  // Files the work proposed for the library (1.2 step 6), recorded once it is accepted and approved by the autonomy
  // policy when it is on. A proposal that cannot be read never undoes the acceptance.
  try {
    recordLibraryProposals(
      store,
      task,
      a,
      name => fs.readFileSync(artifactPath(store, a, name)),
      autonomyPolicy(store, recordProject(task)),
    );
  } catch (error) {
    store.event('library_proposed', task.id, a.id, `The work's library proposal was not recorded: ${error.message}`);
  }
  return { ok: true, proposedTaskIds: prepared?.taskIds || [] };
}
