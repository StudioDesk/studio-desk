import fs from 'node:fs';
import { hash } from './contracts.mjs';
import { artifactPath } from './artifacts.mjs';
import { assertProject, recordProject } from './projects.mjs';
import { prepareProposedWork, recordProposedWork } from './proposals.mjs';
import { expandMaps } from './fanout.mjs';

// Accepts a reviewed attempt. Shared by the director's route and the
// controller's autonomy policy so both apply exactly the same checks.
// `by` is { type: 'director' } or { type: 'policy', revision, reason }.
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
  const policy = a.contracts?.task || definition;
  if (!policy.acceptFailedChecks && a.result.checks.some(c => c.status === 'fail'))
    throw new Error('The worker reported a failed check. Request a revision first.');
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
  });
  store.event(
    'accepted',
    task.id,
    a.id,
    by.type === 'policy'
      ? `Accepted by autonomy policy revision ${by.revision}: ${by.reason}`
      : 'Director accepted the recorded result.',
  );
  return { ok: true, proposedTaskIds: prepared?.taskIds || [] };
}
