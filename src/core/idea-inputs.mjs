// Local director inputs, independent of workflow/domain packs. Wire contract:
// files?: [{ name, mediaType?: string, data: canonical RFC 4648 base64 }].
// directorInputs is a metadata-only array on the owning run and initial tasks.
// Storage names are controller identities, never display names. Later pipeline
// propagation follows controller run/proposal identities; these are reference
// data, never tool permissions or accepted task-result evidence.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectIdentity, assertProject, recordProject } from './projects.mjs';
import { runIdOf } from './graph.mjs';

export const ideaInputLimits = Object.freeze({
  count: 10,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  wireBytes: 28 * 1024 * 1024,
});
const types = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv'],
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function reject(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function safeName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    !name.isWellFormed() ||
    name.length > 180 ||
    Buffer.byteLength(name) > 255 ||
    /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/u.test(name) ||
    name.trim() !== name ||
    /[. ]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    reject('Input filenames must be bounded safe display names without paths.');
}
function checkContent(bytes, mediaType) {
  const prefix = bytes.subarray(0, 12);
  const valid =
    mediaType === 'image/png'
      ? prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : mediaType === 'image/jpeg'
        ? prefix.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : mediaType === 'image/gif'
          ? ['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('ascii'))
          : mediaType === 'image/webp'
            ? prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP'
            : null;
  if (valid === false) reject('Input bytes do not match the allowed image format.');
  if (valid === null) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      reject('Text inputs must contain valid UTF-8.');
    }
    if (text.includes('\0')) reject('Text inputs cannot contain NUL bytes.');
    if (mediaType === 'application/json') {
      try {
        JSON.parse(text);
      } catch {
        reject('JSON input must contain valid JSON.');
      }
    }
  }
}
export function validateIdeaFiles(files = []) {
  if (!Array.isArray(files) || files.length > ideaInputLimits.count)
    reject(`An idea accepts up to ${ideaInputLimits.count} files.`);
  const names = new Set();
  let total = 0;
  return files.map(file => {
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      Object.keys(file).some(key => !['name', 'mediaType', 'data'].includes(key))
    )
      reject('Input files accept only name, mediaType and base64 data.');
    safeName(file.name);
    const key = file.name.normalize('NFKC').toLowerCase();
    if (names.has(key)) reject('Input display names must be unique.');
    names.add(key);
    const mediaType = types.get(path.extname(file.name).toLowerCase());
    if (!mediaType || (file.mediaType !== undefined && file.mediaType !== '' && file.mediaType !== mediaType))
      reject('Unsupported input format or media type.');
    if (typeof file.data !== 'string') reject('Input data must be canonical base64.');
    if (file.data.length > 4 * Math.ceil(ideaInputLimits.fileBytes / 3))
      reject('Input exceeds the 5 MiB per-file limit.', 413);
    // Buffer.from alone accepts malformed and noncanonical base64.
    if (file.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))
      reject('Input data must be canonical base64.');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data) reject('Input data must be canonical base64.');
    if (bytes.length > ideaInputLimits.fileBytes) reject('Input exceeds the 5 MiB per-file limit.', 413);
    total += bytes.length;
    if (total > ideaInputLimits.totalBytes) reject('Inputs exceed the 20 MiB combined limit.', 413);
    checkContent(bytes, mediaType);
    return { name: file.name, mediaType, bytes };
  });
}
export const directorInputsOf = record => structuredClone(record?.directorInputs || []);
export function createDirectorInputs(projectId, runId, files) {
  return files.map(({ name, mediaType, bytes }) => ({
    id: 'input-' + randomUUID(),
    projectId,
    runId,
    name,
    byteLength: bytes.length,
    mediaType,
    sha256: sha256(bytes),
  }));
}
export function assertUnchangedDirectorInputs(previous, next) {
  if (previous && JSON.stringify(directorInputsOf(previous)) !== JSON.stringify(directorInputsOf(next)))
    reject('Recorded director inputs are immutable.', 409);
}
function storageRoot(store, projectId) {
  projectIdentity(projectId);
  return path.join(store.directory, 'projects', projectId, 'idea-inputs');
}
function runDirectory(store, projectId, runId) {
  if (typeof runId !== 'string' || !/^run-[0-9a-f-]{36}$/.test(runId)) reject('Invalid input run identity.');
  return path.join(storageRoot(store, projectId), runId);
}
// Check each component before use: a symlink/junction must not redirect storage.
function directories(store, directory, create = false) {
  let current = path.resolve(store.directory);
  const relative = path.relative(current, directory);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..'))
    reject('Invalid input storage path.');
  const root = fs.lstatSync(current);
  if (root.isSymbolicLink() || !root.isDirectory()) reject('Input storage requires local directories.');
  for (const part of relative.split(path.sep)) {
    if (!part || part === '..') reject('Invalid input storage path.');
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) reject('Input storage requires local directories.');
  }
}
export function stageIdeaInputs(store, run, files) {
  const manifest = directorInputsOf(run);
  if (!manifest.length && !files.length) return () => {};
  const directory = runDirectory(store, run.projectId, run.id);
  directories(store, path.dirname(directory), true);
  // Exclusive creation means neither another input nor an existing run is overwritten.
  fs.mkdirSync(directory);
  const discard = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    if (manifest.length !== files.length) reject('Input manifest does not match supplied files.');
    manifest.forEach((item, index) => {
      const file = files[index];
      if (
        item.projectId !== run.projectId ||
        item.runId !== run.id ||
        item.name !== file.name ||
        item.mediaType !== file.mediaType ||
        item.byteLength !== file.bytes.length ||
        item.sha256 !== sha256(file.bytes) ||
        !/^input-[0-9a-f-]{36}$/.test(item.id)
      )
        reject('Input manifest does not match supplied files.');
      fs.writeFileSync(path.join(directory, item.id + '.bin'), file.bytes, { flag: 'wx', flush: true });
    });
    return discard;
  } catch (error) {
    // A failed cleanup can leave only an unreachable directory, never a committed run.
    try {
      discard();
    } catch {}
    throw error;
  }
}
export function readIdeaInput(store, projectId, runId, inputId) {
  const run = store.run(runId);
  if (!run) reject('Input run not found.', 404);
  assertProject(store, run, projectId);
  const item = directorInputsOf(run).find(item => item.id === inputId);
  if (!item) reject('Input not registered for this run.', 404);
  if (item.projectId !== projectId || item.runId !== runId || !/^input-[0-9a-f-]{36}$/.test(item.id))
    reject('Input ownership does not match its run.', 409);
  try {
    const directory = runDirectory(store, projectId, runId);
    directories(store, directory);
    const filename = path.join(directory, item.id + '.bin'),
      stat = fs.lstatSync(filename);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size !== item.byteLength ||
      stat.size > ideaInputLimits.fileBytes
    )
      reject('Recorded input bytes are missing or modified.', 409);
    const bytes = fs.readFileSync(filename);
    if (sha256(bytes) !== item.sha256) reject('Recorded input bytes are missing or modified.', 409);
    return { item, bytes };
  } catch (error) {
    if (error.status) throw error;
    reject('Recorded input bytes are missing or modified.', 409);
  }
}

// Inheritance uses controller records, never worker-supplied result fields or
// arbitrary dependencies. Proposed/retried tasks keep their runReference (or
// exact proposal attempt), even when a stage consumes only its predecessor.
export function directorInputsFor(store, task) {
  const projectId = recordProject(task),
    manifests = [];
  if (Object.hasOwn(task, 'directorInputs')) manifests.push(directorInputsOf(task));
  const runId = runIdOf(task);
  if (runId) {
    const run = store.run(runId);
    if (run) {
      assertProject(store, run, projectId);
      manifests.push(directorInputsOf(run));
    } else if (manifests.some(items => items.length)) reject('Director input run is missing.', 409);
  }
  if (task.proposalReference) {
    const reference = task.proposalReference,
      attempt = store.attempt(reference.attemptId);
    assertProject(store, attempt, projectId);
    if (attempt.taskId !== reference.taskId) reject('Director input proposal identity changed.', 409);
    if (Object.hasOwn(attempt, 'directorInputs')) manifests.push(directorInputsOf(attempt));
  }
  const manifest = manifests[0] || [];
  if (manifests.some(items => JSON.stringify(items) !== JSON.stringify(manifest)))
    reject('Inherited director input manifest changed.', 409);
  if (!Array.isArray(manifest) || manifest.length > ideaInputLimits.count)
    reject('Invalid director input manifest.', 409);
  let total = 0;
  const ids = new Set();
  for (const item of manifest) {
    safeName(item.name);
    if (
      item.projectId !== projectId ||
      (runId && item.runId !== runId) ||
      item.runId !== manifest[0].runId ||
      !/^input-[0-9a-f-]{36}$/.test(item.id) ||
      ids.has(item.id) ||
      !Number.isInteger(item.byteLength) ||
      item.byteLength < 0 ||
      item.byteLength > ideaInputLimits.fileBytes ||
      types.get(path.extname(item.name).toLowerCase()) !== item.mediaType ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    )
      reject(`Invalid director input provenance for ${item.name}.`, 409);
    ids.add(item.id);
    total += item.byteLength;
    const run = store.run(item.runId);
    if (!run) reject(`Director input run is missing for ${item.name}.`, 409);
    assertProject(store, run, projectId);
    const original = directorInputsOf(run).find(input => input.id === item.id);
    if (JSON.stringify(original) !== JSON.stringify(item))
      reject(`Director input manifest changed for ${item.name}.`, 409);
    if (JSON.stringify(directorInputsOf(run)) !== JSON.stringify(manifest))
      reject('The complete original director input manifest must be retained.', 409);
  }
  if (total > ideaInputLimits.totalBytes) reject('Director input manifest exceeds the combined limit.', 409);
  return structuredClone(manifest);
}

export const directorInputReferences = manifest =>
  manifest.map(item => ({
    ...structuredClone(item),
    path: `../inputs/director/${item.id}${path.extname(item.name).toLowerCase()}`,
  }));

export function stageDirectorInputs(store, entry) {
  for (const reference of entry.attempt.directorInputReferences || []) {
    try {
      const { item, bytes } = readIdeaInput(store, reference.projectId, reference.runId, reference.id),
        { path: relative, ...manifest } = reference;
      if (JSON.stringify(item) !== JSON.stringify(manifest)) reject('Director input manifest changed.', 409);
      const destination = path.resolve(entry.output, relative);
      // The destination is generated by the controller, never taken from uploads.
      if (!destination.startsWith(path.join(entry.job, 'inputs', 'director') + path.sep))
        reject('Invalid director input destination.');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx' });
      entry.protectedFiles.set(destination, reference.sha256);
    } catch (error) {
      entry.needsDecision = true;
      throw new Error(`Director input ${reference.name}: ${error.message}`);
    }
  }
}
