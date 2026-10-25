// Controller-owned recovery evidence. Never registered as an artifact, accepted, or
// replayed here. All reads are bounded; a partial capture is explicitly unusable.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './contracts.mjs';
import { jobDirectory, recordProject } from './projects.mjs';
import { live } from '../adapters/process.mjs';

export const continuationLimits = Object.freeze({
  files: 100,
  fileBytes: 8 * 1024 * 1024,
  workFileBytes: 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  manifestBytes: 256 * 1024,
  entries: 400,
});
const checkpointName = 'continuation';
const planName = 'continuation-source.json';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safe = relative =>
  typeof relative === 'string' &&
  relative.length <= 500 &&
  relative
    .split('/')
    .every(
      part =>
        /^[\p{L}\p{N}_()[\]-][\p{L}\p{N}\p{M}_. ()[\]-]*$/u.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    ) &&
  !relative.includes('\\') &&
  !relative.includes(':');
const stage = a =>
  a.assignment?.stageState?.current ||
  a.assignment?.sourceStage?.phase ||
  a.assignment?.sourceStage?.current ||
  a.assignment?.stage ||
  null;
const identity = a => ({
  projectId: recordProject(a),
  taskId: a.taskId,
  attemptId: a.id,
  kind: a.assignment?.kind || null,
  stage: stage(a),
});

function location(store, a) {
  const task = store.task(a.taskId);
  if (recordProject(task) !== recordProject(a) || (a.assignment?.id && a.assignment.id !== a.taskId))
    throw new Error('Continuation belongs to a foreign task/project.');
  const job = jobDirectory(store, a);
  let current = path.resolve(store.directory);
  for (const part of ['', ...path.relative(current, job).split(path.sep)]) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlinked continuation job.');
  }
  return job;
}
function exists(filename) {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
// Reject links at every component, including the root. Never follow junctions or
// symlinks, even when they happen to target another path inside this job.
function regular(root, relative, missing = false) {
  if (!safe(relative)) throw new Error('Unsafe continuation path.');
  let current = path.resolve(root);
  for (const part of ['', ...relative.split('/')]) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (missing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Continuation path is symlinked.');
    if (current !== path.resolve(root, relative) && !stat.isDirectory())
      throw new Error('Continuation parent is not a directory.');
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Continuation requires a complete regular file.');
  return { filename: current, stat };
}
function read(root, relative, limit, missing = false) {
  const found = regular(root, relative, missing);
  if (!found) return null;
  if (found.stat.size > limit) throw new Error(`Continuation file exceeds ${limit} bytes: ${relative}`);
  const fd = fs.openSync(found.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== found.stat.size ||
      before.ino !== found.stat.ino ||
      before.dev !== found.stat.dev
    )
      throw new Error('Continuation file changed before reading.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!count) throw new Error('Continuation file was truncated.');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error('Continuation file changed while reading.');
    const current = regular(root, relative).stat;
    if (
      current.ino !== after.ino ||
      current.dev !== after.dev ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs ||
      current.ctimeMs !== after.ctimeMs
    )
      throw new Error('Continuation file was replaced while reading.');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function write(root, relative, bytes) {
  if (!safe(relative)) throw new Error('Unsafe continuation destination.');
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes, { flag: 'wx' });
}
// Windows scanners can briefly hold a just-closed file/directory. Retry only
// transient sharing/access failures, with a hard 40 ms wait ceiling; publication
// still uses the same atomic rename and never falls back to a partial copy.
function publish(temporary, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, destination);
      return;
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
function sourcePlan(a) {
  const scope = a.sourceChange;
  if (!scope) return null;
  const paths = [...scope.allowedFiles, ...(scope.newFiles || []), ...(scope.deleteFiles || [])];
  if (paths.length > continuationLimits.files || new Set(paths).size !== paths.length || !paths.every(safe))
    throw new Error('Invalid continuation source scope.');
  const existing = [...scope.allowedFiles, ...(scope.deleteFiles || [])].map(file => {
    const item = scope.source.files.find(item => item.path === file);
    if (!item || !/^[a-f0-9]{64}$/.test(item.hash) || !Number.isSafeInteger(item.bytes))
      throw new Error('Missing source baseline identity.');
    return { path: file, bytes: item.bytes, hash: item.hash };
  });
  return {
    identity: identity(a),
    sourceHash: scope.source.sourceHash,
    baseCommit: scope.base?.commit || null,
    proposal: scope.proposalReference,
    allowedFiles: scope.allowedFiles,
    newFiles: scope.newFiles || [],
    deleteFiles: scope.deleteFiles || [],
    carriedNewFiles: (scope.continueFrom?.files || [])
      .filter(item => (scope.newFiles || []).includes(item.path))
      .map(item => item.path),
    baseline: existing,
  };
}

// Called before model dispatch, when the approved baseline is known. The plan is
// outside output; capture compares it with the immutable attempt, including on restart.
export function prepareSourceContinuation(store, a) {
  const job = location(store, a),
    plan = sourcePlan(a);
  let total = 0;
  for (const item of plan.baseline) {
    const bytes = read(path.join(job, 'source'), item.path, continuationLimits.fileBytes);
    total += bytes.length;
    if (total > continuationLimits.totalBytes || bytes.length !== item.bytes || hash(bytes) !== item.hash)
      throw new Error('Continuation source baseline is unavailable or changed.');
  }
  const bytes = Buffer.from(JSON.stringify(plan));
  if (bytes.length > continuationLimits.manifestBytes) throw new Error('Continuation source plan is oversized.');
  const temporary = `${planName}.${randomUUID()}`;
  try {
    write(job, temporary, bytes);
    publish(path.join(job, temporary), path.join(job, planName));
  } finally {
    fs.rmSync(path.join(job, temporary), { force: true });
  }
}

const controls =
  /^(?:agents\.md|instructions\.json|assignment\.json|result(?:-schema)?\.json|source-(?:scope|change|breakdown|review|context|check-report|change-review)\.json|scope-(?:request|report)\.json|change\.diff|check-report\.json|test-output\.txt|test-errors\.txt|review\.json|(?:claude|codex|provider)[^/]*|delivery(?:-schema)?\.json)$/i;
function workPath(relative) {
  return (
    safe(relative) &&
    relative
      .split('/')
      .every(
        part =>
          !controls.test(part) &&
          !/^(?:inputs|changes|source|continuation|node_modules|provider|providers)$/i.test(part),
      )
  );
}
function generalPaths(output) {
  const paths = [];
  let entries = 0;
  const visit = (directory, prefix = '') => {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Symlinked work directory.');
    const dir = fs.opendirSync(directory);
    try {
      let item;
      while ((item = dir.readSync())) {
        if (++entries > continuationLimits.entries) throw new Error('Continuation directory entry limit reached.');
        const relative = prefix + item.name;
        if (!workPath(relative)) continue;
        const stat = fs.lstatSync(path.join(output, relative));
        if (stat.isSymbolicLink()) throw new Error('Symlinked work file.');
        if (stat.isDirectory()) visit(path.join(output, relative), relative + '/');
        else if (stat.isFile()) paths.push(relative);
        else throw new Error('Nonregular work file.');
        if (paths.length > continuationLimits.files) throw new Error('Continuation file count limit reached.');
      }
    } finally {
      dir.closeSync();
    }
  };
  visit(output);
  return paths.sort();
}

export function captureContinuation(store, a) {
  // This guard also protects direct callers; uncertainty is never a stopped process.
  if (live(a) || ['running', 'stopping', 'quarantined'].includes(a.status))
    return { status: 'unavailable', issues: ['Process/group is not confirmed stopped.'] };
  let temporary;
  const manifest = {
    schemaVersion: 'attempt-continuation-v1',
    identity: identity(a),
    evidence: 'checkpoint',
    status: 'complete',
    capturedAt: new Date().toISOString(),
    terminal: { status: a.status, error: a.error || null, stopContext: a.stopContext || null },
    files: [],
    deletions: [],
    removedNewFiles: [],
    baseline: [],
    issues: [],
  };
  try {
    const job = location(store, a),
      output = path.join(job, 'output'),
      target = path.join(job, checkpointName);
    // Never replace earlier recovery evidence or silently repair tampered evidence.
    if (exists(target)) return readContinuation(store, a);
    regular(job, 'assignment.json', true); // rejects a linked job root even for old layouts
    if (a.sourceChange && !regular(job, planName, true)) {
      const legacy = legacyContinuation(store, a);
      if (legacy.status === 'complete') return legacy;
    }
    temporary = path.join(job, `continuation-${randomUUID()}`);
    fs.mkdirSync(temporary);
    let total = 0,
      count = 0;
    const copy = (root, relative, destination, expected, limit = continuationLimits.fileBytes) => {
      const bytes = read(root, relative, Math.min(limit, continuationLimits.totalBytes - total));
      if (++count > continuationLimits.files * 2) throw new Error('Continuation file count limit reached.');
      const item = { path: relative, bytes: bytes.length, hash: hash(bytes) };
      if (expected && (item.hash !== expected.hash || item.bytes !== expected.bytes))
        throw new Error(`Continuation bytes changed: ${relative}`);
      total += bytes.length;
      write(temporary, destination, bytes);
      return item;
    };
    const plan = sourcePlan(a);
    if (plan) {
      const prepared = JSON.parse(read(job, planName, continuationLimits.manifestBytes));
      if (!same(prepared, plan)) throw new Error('Continuation source plan identity changed.');
      manifest.source = plan;
      for (const item of plan.baseline)
        manifest.baseline.push(copy(path.join(job, 'source'), item.path, 'base/' + item.path, item));
      manifest.deletions = [...plan.deleteFiles]; // approved controller deletion intent, not missing edits
      for (const file of [...plan.allowedFiles, ...plan.newFiles]) {
        const relative = 'changes/' + file;
        if (!regular(output, relative, true)) {
          if (plan.allowedFiles.includes(file)) throw new Error(`Missing approved edit: ${file}`);
          if (plan.carriedNewFiles.includes(file)) manifest.removedNewFiles.push(file);
          continue; // an approved new file may never have been created
        }
        const registered = a.artifacts?.find(item => item.path === relative && item.kind === 'source-file');
        manifest.files.push(copy(output, relative, 'files/' + relative, registered));
      }
    } else if (a.assignment?.kind === 'general:work') {
      for (const relative of generalPaths(output)) {
        const registered = a.artifacts?.find(item => item.path === relative && item.kind === 'work-file');
        const item = copy(output, relative, 'files/' + relative, registered, continuationLimits.workFileBytes);
        // Same text-only boundary as general work deliverables.
        const bytes = read(temporary, 'files/' + relative, continuationLimits.workFileBytes);
        if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))
          throw new Error('General continuation work must be UTF-8 text.');
        manifest.files.push(item);
      }
    } else throw new Error('This attempt has no recoverable work contract.');
    manifest.totalBytes = total;
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded) > continuationLimits.manifestBytes)
      throw new Error('Continuation manifest limit reached.');
    write(temporary, 'manifest.json', encoded);
    publish(temporary, target);
    temporary = null;
    return manifest;
  } catch (error) {
    manifest.status = manifest.files.length ? 'incomplete' : 'unavailable';
    manifest.issues = [String(error.message).slice(0, 1000)];
    try {
      if (temporary) {
        write(temporary, 'manifest.json', JSON.stringify(manifest));
        publish(temporary, path.join(location(store, a), checkpointName));
        temporary = null;
      }
    } catch {}
    return manifest;
  } finally {
    try {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    } catch {}
  }
}

// Consumers must verify every recorded byte again. An incomplete/tampered latest
// checkpoint is not permission to substitute older evidence. No automatic replay.
export function readContinuation(store, a) {
  try {
    const job = location(store, a),
      root = path.join(job, checkpointName);
    if (!exists(root)) return legacyContinuation(store, a);
    const manifest = JSON.parse(read(root, 'manifest.json', continuationLimits.manifestBytes));
    if (
      manifest.schemaVersion !== 'attempt-continuation-v1' ||
      manifest.evidence !== 'checkpoint' ||
      !['complete', 'incomplete', 'unavailable'].includes(manifest.status) ||
      !same(manifest.identity, identity(a))
    )
      throw new Error('Foreign continuation identity.');
    if (manifest.status !== 'complete') return { ...manifest, files: [], baseline: [] };
    const plan = sourcePlan(a);
    if (
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.baseline) ||
      manifest.files.length > continuationLimits.files ||
      manifest.baseline.length > continuationLimits.files
    )
      throw new Error('Continuation manifest count limit reached.');
    if (
      plan &&
      (!same(manifest.source, plan) ||
        !same(manifest.deletions, plan.deleteFiles) ||
        !same(manifest.baseline, plan.baseline) ||
        !Array.isArray(manifest.removedNewFiles) ||
        manifest.removedNewFiles.some(file => !plan.carriedNewFiles.includes(file)))
    )
      throw new Error('Continuation source identities changed.');
    if (
      !plan &&
      (a.assignment?.kind !== 'general:work' ||
        manifest.baseline.length ||
        !same(manifest.deletions, []) ||
        !same(manifest.removedNewFiles, []))
    )
      throw new Error('Unsupported work contract.');
    let total = 0;
    const seen = new Set();
    for (const [folder, files] of [
      ['files', manifest.files],
      ['base', manifest.baseline],
    ])
      for (const item of files) {
        if (seen.has(folder + '/' + item.path)) throw new Error('Duplicate continuation path.');
        seen.add(folder + '/' + item.path);
        if (
          folder === 'files' &&
          (plan
            ? ![...plan.allowedFiles, ...plan.newFiles].map(p => 'changes/' + p).includes(item.path)
            : !workPath(item.path))
        )
          throw new Error('Unapproved continuation file.');
        const bytes = read(
          root,
          folder + '/' + item.path,
          Math.min(
            plan ? continuationLimits.fileBytes : continuationLimits.workFileBytes,
            continuationLimits.totalBytes - total,
          ),
        );
        total += bytes.length;
        if (bytes.length !== item.bytes || hash(bytes) !== item.hash)
          throw new Error('Continuation hash/size mismatch.');
        if (!plan && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)))
          throw new Error('General continuation work must be UTF-8 text.');
      }
    if (plan && plan.allowedFiles.some(file => !manifest.files.some(item => item.path === 'changes/' + file)))
      throw new Error('Continuation is missing an approved edit.');
    if (
      plan &&
      (plan.carriedNewFiles.some(
        file =>
          !manifest.files.some(item => item.path === 'changes/' + file) && !manifest.removedNewFiles.includes(file),
      ) ||
        manifest.removedNewFiles.some(file => manifest.files.some(item => item.path === 'changes/' + file)))
    )
      throw new Error('Continuation carried new file removal is inconsistent.');
    if (total !== manifest.totalBytes) throw new Error('Continuation total byte count changed.');
    return manifest;
  } catch (error) {
    return { status: 'unavailable', evidence: 'checkpoint', files: [], issues: [error.message] };
  }
}

// Verified checkpoint bytes for the controller's readable attempt history only: never
// registered, accepted or replayed. A file over limit is named, not read.
export function continuationChanges(store, a, limit = continuationLimits.fileBytes) {
  const manifest = readContinuation(store, a);
  if (manifest.status !== 'complete' || manifest.evidence !== 'checkpoint') return { manifest, changes: [] };
  const root = path.join(location(store, a), checkpointName),
    changes = [];
  const verified = (relative, item) => {
    const bytes = read(root, relative, limit);
    if (bytes.length !== item.bytes || hash(bytes) !== item.hash) throw new Error('Continuation hash/size mismatch.');
    return bytes.toString('utf8');
  };
  for (const item of manifest.files) {
    const file = manifest.source ? item.path.replace(/^changes\//, '') : item.path,
      base = manifest.baseline.find(entry => entry.path === file);
    if (item.bytes > limit || base?.bytes > limit) changes.push({ path: file, oversized: true });
    else
      changes.push({
        path: file,
        before: base ? verified('base/' + base.path, base) : null,
        after: verified('files/' + item.path, item),
      });
  }
  for (const file of manifest.deletions || []) changes.push({ path: file, deleted: true });
  return { manifest, changes };
}

// The work a general work step continues from: the latest earlier Work attempt of this task in its
// project (never an independent review, never an older attempt in place of a newer one), read from
// its verified checkpoint or, for attempts from before checkpoints, its registered work files. Work
// that cannot be verified, a checkpoint naming another project, task or attempt, or more files than
// a result may return starts the step fresh with the reason; the earlier attempt and its history
// stay. Null when the step has no earlier Work attempt.
export function generalWorkContinuation(
  store,
  task,
  currentAttemptId = null,
  { maxFiles = continuationLimits.files } = {},
) {
  const projectId = recordProject(task),
    previous = store
      .attempts(task.id)
      .filter(a => a.id !== currentAttemptId && a.assignment?.kind === 'general:work' && recordProject(a) === projectId)
      .at(-1);
  if (!previous) return null;
  if (
    ['running', 'stopping'].includes(previous.status) ||
    (['interrupted', 'quarantined'].includes(previous.status) && !previous.reconciledAt)
  )
    throw new Error(`Attempt ${previous.id} has not stopped and been reconciled; its work cannot be continued yet.`);
  const fresh = reason => ({ attemptId: previous.id, files: [], fresh: { reason } }),
    manifest = readContinuation(store, previous);
  if (manifest.status !== 'complete')
    return fresh(
      `its recorded work could not be verified (${(manifest.issues || []).join(' ').slice(0, 500) || manifest.status})`,
    );
  const owner = manifest.identity || {};
  if (owner.projectId !== projectId || owner.taskId !== task.id || owner.attemptId !== previous.id)
    return fresh('its recorded work names another project, task or attempt');
  if (manifest.files.length > maxFiles)
    return fresh(`it recorded ${manifest.files.length} work files, more than the ${maxFiles} a result may return`);
  return {
    attemptId: previous.id,
    files: manifest.files.map(item => ({ path: item.path, hash: item.hash, bytes: item.bytes })),
  };
}

// The verified bytes of one recorded work file a later attempt continues from: its checkpoint copy,
// or, for an attempt from before checkpoints, its registered output file. Never substitutes either.
export function continuationFile(store, a, relative, expected) {
  const job = location(store, a),
    root = path.join(job, checkpointName),
    bytes = exists(root)
      ? read(root, 'files/' + relative, continuationLimits.fileBytes)
      : read(path.join(job, 'output'), relative, continuationLimits.fileBytes);
  if (hash(bytes) !== expected) throw new Error('The work this attempt continues from changed after it was recorded.');
  return bytes;
}

function legacyContinuation(store, a) {
  const job = location(store, a),
    plan = sourcePlan(a),
    files = [];
  let total = 0;
  for (const item of a.artifacts || []) {
    if (plan ? item.kind !== 'source-file' : a.assignment?.kind !== 'general:work' || item.kind !== 'work-file')
      continue;
    if (
      plan
        ? ![...plan.allowedFiles, ...plan.newFiles].map(file => 'changes/' + file).includes(item.path)
        : !workPath(item.path)
    )
      throw new Error('Unapproved legacy work path.');
    if (files.length >= continuationLimits.files) throw new Error('Legacy continuation count limit reached.');
    const bytes = read(
      path.join(job, 'output'),
      item.path,
      Math.min(
        plan ? continuationLimits.fileBytes : continuationLimits.workFileBytes,
        continuationLimits.totalBytes - total,
      ),
    );
    total += bytes.length;
    if (hash(bytes) !== item.hash || bytes.length !== item.bytes) throw new Error('Legacy work hash/size mismatch.');
    if (!plan && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)))
      throw new Error('Legacy general work must be UTF-8 text.');
    files.push({ path: item.path, hash: item.hash, bytes: item.bytes });
  }
  return {
    schemaVersion: 'attempt-continuation-v1',
    identity: identity(a),
    evidence: 'legacy',
    status: files.length ? 'complete' : 'unavailable',
    files,
    source: plan,
    deletions: plan?.deleteFiles || [],
    issues: ['Historical checkpoint missing; only independently verified registered work is available.'],
  };
}
