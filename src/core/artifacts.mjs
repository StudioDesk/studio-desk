import fs from 'node:fs';
import path from 'node:path';
import { hash } from './contracts.mjs';
import { jobDirectory, recordProject, assertProject } from './projects.mjs';

// Protected inputs may be outside output but must remain regular local files
// inside this attempt's job. Hash equality alone does not detect a symlink swap.
export function validateProtectedFiles(entry) {
  const root = path.resolve(entry.job);
  for (const [filename, expected] of entry.protectedFiles) {
    const relative = path.relative(root, filename);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..'))
      throw new Error('Protected instructions or inputs are outside the job.');
    let current = root;
    for (const part of ['', ...relative.split(path.sep)]) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error('Protected instructions or inputs were replaced by a symlink.');
    }
    if (!fs.statSync(filename).isFile() || hash(fs.readFileSync(filename)) !== expected)
      throw new Error('Protected instructions or inputs were modified.');
  }
}

export function artifactPath(store, a, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\'))
    throw new Error('Invalid artifact path.');
  const output = path.join(jobDirectory(store, a), 'output');
  const target = path.resolve(output, relative);
  if (!target.startsWith(output + path.sep) || !fs.existsSync(target))
    throw new Error('Artifact is missing or outside its output folder.');
  const real = fs.realpathSync(target);
  if (!real.startsWith(fs.realpathSync(output) + path.sep))
    throw new Error('Artifact symlinks outside the workspace are not allowed.');
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Artifact must be a file smaller than 8 MB.');
  return real;
}
// Pinned references are controller records, never worker-selected attempt IDs or hashes.
export function acceptedReference(store, taskId, attemptId = store.task(taskId).acceptedAttemptId, projectId) {
  const task = store.task(taskId),
    a = store.attempt(attemptId);
  assertProject(store, a, recordProject(task));
  if (projectId !== undefined) assertProject(store, task, projectId);
  if (
    task.status !== 'done' ||
    task.acceptedAttemptId !== attemptId ||
    a.taskId !== taskId ||
    a.status !== 'accepted' ||
    a.result?.outcome !== 'completed' ||
    !a.artifacts.length
  )
    throw new Error('Repair inputs must be exact accepted attempts with validated artifacts.');
  for (const item of a.artifacts)
    if (hash(fs.readFileSync(artifactPath(store, a, item.path))) !== item.hash)
      throw new Error('Accepted input was modified after acceptance.');
  return {
    taskId,
    attemptId,
    summary: a.result.summary,
    artifacts: a.artifacts.map(({ path, kind, hash }) => ({ path, kind, hash })),
  };
}
export function validateAcceptedReferences(store, references, projectId) {
  if (
    !Array.isArray(references) ||
    references.length > 20 ||
    new Set(references.map(ref => ref.taskId)).size !== references.length
  )
    throw new Error('Invalid pinned accepted inputs.');
  for (const ref of references) {
    const accepted = acceptedReference(store, ref.taskId, ref.attemptId, projectId);
    if (JSON.stringify(accepted.artifacts) !== JSON.stringify(ref.artifacts))
      throw new Error('Pinned accepted input manifest changed.');
  }
}
