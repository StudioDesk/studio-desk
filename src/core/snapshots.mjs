// Every file a project's accepted work handed back, for its Artifacts page, and snapshots of them (1.2 step 6, decision
// 12). A project that isn't code names a set of its accepted files at one moment, such as "Sent to the client,
// October 27", sees what changed since its last snapshot, and downloads the set: its counterpart to a code project's
// release, kept in the controller's own records with no git. A snapshot holds any accepted file, since what is sent is
// often not a file later work follows. Each file is a reference to accepted work, read and checked by hash when the set
// is downloaded.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { hash } from './contracts.mjs';
import { artifactPath } from './artifacts.mjs';
import { recordProject } from './projects.mjs';
import { runIdOf } from './graph.mjs';

export const snapshotLimits = Object.freeze({ snapshots: 100, files: 200, bytes: 100 * 1024 * 1024 });
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const settingId = projectId => `snapshots:${projectId}`;

// Every file a project's accepted work handed back: each done task's accepted attempt, with its idea, its agent and the
// file's kind, newest first. Controller evidence files of code stories are listed too; the page groups by kind.
export function projectArtifacts(store, projectId) {
  const files = [];
  for (const task of store.tasks()) {
    if (recordProject(task) !== projectId || task.status !== 'done' || !task.acceptedAttemptId) continue;
    let attempt;
    try {
      attempt = store.attempt(task.acceptedAttemptId);
    } catch {
      continue;
    }
    if (attempt.status !== 'accepted') continue;
    for (const item of attempt.artifacts || [])
      files.push({
        taskId: task.id,
        title: task.title,
        attemptId: attempt.id,
        workerId: attempt.workerId,
        runId: runIdOf(task) || null,
        kind: item.kind,
        path: item.path,
        hash: item.hash,
        acceptedAt: attempt.acceptedAt || null,
      });
  }
  return files.sort((a, b) => (b.acceptedAt || '').localeCompare(a.acceptedAt || ''));
}

export const snapshotsOf = (store, projectId) => store.setting(settingId(projectId)) || [];
const fileKey = file => `${file.taskId}\0${file.path}`;

// What changed from one set of files to the next, by task and path: added, changed (another hash) and removed.
export function snapshotChanges(before, after) {
  const earlier = new Map((before || []).map(file => [fileKey(file), file])),
    later = new Map(after.map(file => [fileKey(file), file]));
  return {
    added: after.filter(file => !earlier.has(fileKey(file))).map(file => ({ taskId: file.taskId, path: file.path })),
    changed: after
      .filter(file => earlier.has(fileKey(file)) && earlier.get(fileKey(file)).hash !== file.hash)
      .map(file => ({ taskId: file.taskId, path: file.path })),
    removed: (before || [])
      .filter(file => !later.has(fileKey(file)))
      .map(file => ({ taskId: file.taskId, path: file.path })),
  };
}

// The snapshots, oldest first, each with what changed since the one before it.
export function snapshotView(store, projectId) {
  const snapshots = snapshotsOf(store, projectId);
  return snapshots.map((snapshot, index) => ({
    ...snapshot,
    changes: snapshotChanges(index ? snapshots[index - 1].files : null, snapshot.files),
  }));
}

// Names a set of accepted files: those listed ({ taskId, attemptId?, path }), or every accepted file when none are.
export function createSnapshot(store, projectId, data, by = { type: 'director' }) {
  if (!data || typeof data !== 'object' || Object.keys(data).some(key => !['name', 'files'].includes(key)))
    throw failure('A snapshot takes a name and, optionally, the accepted files it holds.');
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120)
    throw failure('A snapshot needs a name of at most 120 characters, such as "Sent to the client, October 27".');
  const available = projectArtifacts(store, projectId);
  let files;
  if (data.files === undefined) files = available;
  else {
    if (!Array.isArray(data.files) || !data.files.length || data.files.length > snapshotLimits.files)
      throw failure(`A snapshot holds one to ${snapshotLimits.files} files.`);
    files = data.files.map(item => {
      const found =
        item &&
        typeof item === 'object' &&
        available.find(
          file =>
            file.taskId === item.taskId &&
            file.path === item.path &&
            (item.attemptId === undefined || file.attemptId === item.attemptId),
        );
      if (!found) throw failure(`${item?.path ?? 'A file'} is not a file of this project's accepted work.`, 404);
      return found;
    });
    if (new Set(files.map(fileKey)).size !== files.length) throw failure('A snapshot lists each file once.');
  }
  if (!files.length) throw failure('The project has no accepted files to snapshot yet.', 409);
  if (files.length > snapshotLimits.files) throw failure(`A snapshot holds at most ${snapshotLimits.files} files.`);
  const snapshots = snapshotsOf(store, projectId);
  if (snapshots.length >= snapshotLimits.snapshots)
    throw failure(`A project keeps at most ${snapshotLimits.snapshots} snapshots.`, 409);
  const snapshot = {
    id: `snap-${randomUUID()}`,
    name: data.name.trim(),
    at: new Date().toISOString(),
    by,
    files: files.map(({ taskId, title, attemptId, kind, path: file, hash: digest }) => ({
      taskId,
      title,
      attemptId,
      kind,
      path: file,
      hash: digest,
    })),
  };
  store.putSetting(settingId(projectId), [...snapshots, snapshot]);
  const changes = snapshotChanges(snapshots.at(-1)?.files || null, snapshot.files);
  store.event(
    'snapshot',
    null,
    null,
    `The director named a snapshot, ${snapshot.name}, of ${snapshot.files.length} file${snapshot.files.length === 1 ? '' : 's'}${snapshots.length ? `: ${changes.added.length} added, ${changes.changed.length} changed and ${changes.removed.length} removed since ${snapshots.at(-1).name}` : ''}.`,
    projectId,
  );
  return { ...snapshot, changes };
}

// A snapshot's files as one zip, stored without compression, each read from its accepted work and checked by hash.
// Each file sits under a folder named for its task, so two files of one name stay apart.
export function snapshotZip(store, projectId, snapshotId) {
  const snapshot = snapshotsOf(store, projectId).find(item => item.id === snapshotId);
  if (!snapshot) throw failure('Snapshot not found.', 404);
  const entries = [];
  let total = 0;
  for (const file of snapshot.files) {
    const attempt = store.attempt(file.attemptId),
      bytes = fs.readFileSync(artifactPath(store, attempt, file.path));
    if (hash(bytes) !== file.hash) throw failure(`${file.path} changed after the snapshot was named.`, 409);
    total += bytes.length;
    if (total > snapshotLimits.bytes) throw failure('The snapshot is larger than 100 MiB to download at once.', 413);
    const folder = `${file.taskId}-${(file.title || '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)}`;
    entries.push({ name: `${folder.replace(/-$/, '')}/${file.path.replace(/\\/g, '/')}`, bytes });
  }
  return {
    name: `${snapshot.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'snapshot'}.zip`,
    bytes: zip(entries),
  };
}

// A zip of stored entries: local headers, the central directory and its end record, with UTF-8 names.
function zip(entries) {
  const parts = [],
    central = [];
  let offset = 0;
  const time = new Date(),
    dosTime = (time.getHours() << 11) | (time.getMinutes() << 5) | Math.floor(time.getSeconds() / 2),
    dosDate = ((time.getFullYear() - 1980) << 9) | ((time.getMonth() + 1) << 5) | time.getDate();
  for (const { name, bytes } of entries) {
    const nameBytes = Buffer.from(path.posix.normalize(name).replace(/^(\.\.\/)+/, ''), 'utf8'),
      crc = zlib.crc32(bytes),
      local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, bytes);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(bytes.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
