import path from 'node:path';

export const LEGACY_PROJECT = 'project-legacy';
export const recordProject = record => (record.projectId === undefined ? LEGACY_PROJECT : record.projectId);
export function projectIdentity(id) {
  if (typeof id !== 'string' || !/^project-[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid project identity.');
  return id;
}
export function assertProject(store, record, projectId) {
  store.project(projectId);
  if (recordProject(record) !== projectId)
    throw new Error('This record belongs to another project. Cross-project transfer is not supported.');
}
export function validateTaskProject(store, task) {
  const id = recordProject(task);
  store.project(id);
  for (const dependency of task.dependencies) assertProject(store, store.task(dependency), id);
  for (const reference of task.acceptedInputs || []) {
    assertProject(store, store.task(reference.taskId), id);
    assertProject(store, store.attempt(reference.attemptId), id);
  }
  return id;
}
export function jobDirectory(store, attempt) {
  if (typeof attempt.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(attempt.id))
    throw new Error('Invalid attempt identity.');
  const id = projectIdentity(recordProject(attempt));
  return id === LEGACY_PROJECT
    ? path.join(store.directory, 'jobs', attempt.id)
    : path.join(store.directory, 'projects', id, 'jobs', attempt.id);
}
