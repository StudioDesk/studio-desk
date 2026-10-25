// Deleting a project (v1.0 item 24; the director, October 23: "Add deleting to 1.0"). It removes the project and
// everything Studio desk recorded under it, and a sample's own folder under the data folder; it never touches a
// repository or folder the director chose, which keeps every commit the pipeline made. It is refused while any of
// the project's work runs, holds a resource or has an integration open, so nothing in flight loses its record.
import fs from 'node:fs';
import path from 'node:path';
import { jobDirectory, recordProject } from './projects.mjs';

const live = ['starting', 'running', 'stopping', 'quarantined'],
  settledIntegrations = ['integrated', 'rejected', 'abandoned'];

// Returns { deleted, folderRemoved }. `name` is the project's name, typed back to confirm.
export function deleteProject(store, projectId, name) {
  const project = store.project(projectId);
  if (typeof name !== 'string' || name.trim() !== project.name)
    throw new Error(`Type the project's name, ${project.name}, to delete it.`);
  const tasks = store.tasks().filter(task => recordProject(task) === projectId),
    taskIds = new Set(tasks.map(task => task.id)),
    attempts = store.allAttempts().filter(attempt => taskIds.has(attempt.taskId)),
    attemptIds = new Set(attempts.map(attempt => attempt.id));
  if (
    attempts.some(
      attempt => live.includes(attempt.status) || (attempt.status === 'interrupted' && !attempt.reconciledAt),
    )
  )
    throw new Error(
      "Some of this project's work is still running. Pause the project and wait for it to finish before deleting it.",
    );
  if (
    store.leases().some(lease => attemptIds.has(lease.attemptId) || lease.resource.startsWith(`source:${projectId}:`))
  )
    throw new Error('This project still holds a resource. Wait for its work to finish before deleting it.');
  const integration = store.setting('autonomy-integration');
  if (
    attempts.some(
      attempt => attempt.sourceIntegration && !settledIntegrations.includes(attempt.sourceIntegration.state),
    ) ||
    (integration && taskIds.has(integration.taskId))
  )
    throw new Error(
      "One of this project's integrations is open. Let it finish, or settle it, before deleting the project.",
    );
  const jobs = attempts.map(attempt => jobDirectory(store, attempt));
  store.tx(() => {
    store.deleteProjectRecords(projectId, [...taskIds], [...attemptIds]);
    store.event('project_deleted', null, null, `Project deleted: ${project.name}.`);
  });
  // Folders go after the commit; one that cannot be removed now is left, never a record without its files' owner.
  const remove = folder => {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  for (const folder of jobs) remove(folder);
  remove(path.join(store.directory, 'projects', projectId));
  const samples = path.join(store.directory, 'samples'),
    folder = project.sample?.folder ? path.resolve(project.sample.folder) : null;
  const folderRemoved =
    !!folder && path.dirname(folder) === path.resolve(samples) && fs.existsSync(folder) ? remove(folder) : false;
  return { deleted: projectId, folderRemoved };
}
