// A project's accepted files for its Artifacts page, and snapshots of them (1.2 step 6): a named set at one moment, what
// changed since the last one, and the set downloaded as one zip whose files are checked by hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { setup } from './studio-setup.mjs';
import { hash } from '../src/core/contracts.mjs';

const project = 'project-legacy';

// Accepted work that handed back files, as a finished run leaves it; a second call for the same task accepts a newer
// attempt of it.
function accepted(store, taskId, files, attemptId = `attempt-${taskId}`) {
  const output = path.join(store.directory, 'jobs', attemptId, 'output');
  fs.mkdirSync(output, { recursive: true });
  const artifacts = Object.entries(files).map(([file, text]) => {
    fs.writeFileSync(path.join(output, file), text);
    return { path: file, kind: 'document', hash: hash(Buffer.from(text)) };
  });
  store.putTask({
    id: taskId,
    projectId: project,
    kind: 'general',
    title: `Write ${taskId}`,
    status: 'done',
    acceptedAttemptId: attemptId,
    lastAttemptId: attemptId,
    dependencies: [],
  });
  store.insertAttempt(
    {
      id: attemptId,
      taskId,
      projectId: project,
      workerId: 'W-03',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      outputFolder: output,
      artifacts,
      result: { taskId, outcome: 'completed', summary: 'Done.', artifacts: [], checks: [], issues: [], handoff: '' },
    },
    { text: 'Fixture', hash: 'fixture' },
  );
}

// The stored entries of a zip, read by their local headers.
function unzip(bytes) {
  const files = {};
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
    const size = bytes.readUInt32LE(at + 18),
      nameLength = bytes.readUInt16LE(at + 26),
      name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8'),
      data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(bytes.readUInt32LE(at + 14), zlib.crc32(data), `${name}'s checksum`);
    files[name] = data.toString('utf8');
    at += 30 + nameLength + size;
  }
  return files;
}

test("the Artifacts page reads every file the project's accepted work handed back, with its task, agent and kind", async t => {
  const c = await setup(t);
  accepted(c.app.store, 'T-brief', { 'brief.md': '# Brief\n' });
  accepted(c.app.store, 'T-copy', { 'home.md': '# Home\n', 'about.md': '# About\n' });
  const files = await (
    await fetch(`${c.origin}/api/projects/project-legacy/artifacts?projectId=project-legacy`)
  ).json();
  assert.deepEqual(files.map(file => [file.taskId, file.path, file.workerId, file.kind]).sort(), [
    ['T-brief', 'brief.md', 'W-03', 'document'],
    ['T-copy', 'about.md', 'W-03', 'document'],
    ['T-copy', 'home.md', 'W-03', 'document'],
  ]);
});

test('a snapshot names a set of accepted files, says what changed since the last one, and downloads as one zip', async t => {
  const c = await setup(t),
    store = c.app.store;
  accepted(store, 'T-brief', { 'brief.md': '# Brief\n' });
  accepted(store, 'T-copy', { 'home.md': '# Home\n' });
  const first = await c.request('/api/projects/project-legacy/snapshots', {
    projectId: project,
    name: 'Sent to the client, October 27',
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.files.length, 2);
  // Later work changes one file, adds another and drops the brief from the next set.
  accepted(store, 'T-copy', { 'home.md': '# Home, revised\n', 'faq.md': '# FAQ\n' }, 'attempt-T-copy-2');
  const second = await c.request('/api/projects/project-legacy/snapshots', {
    projectId: project,
    name: 'Second round',
    files: [
      { taskId: 'T-copy', path: 'home.md' },
      { taskId: 'T-copy', path: 'faq.md' },
    ],
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.deepEqual(second.data.changes, {
    added: [{ taskId: 'T-copy', path: 'faq.md' }],
    changed: [{ taskId: 'T-copy', path: 'home.md' }],
    removed: [{ taskId: 'T-brief', path: 'brief.md' }],
  });
  const view = await (await fetch(`${c.origin}/api/projects/project-legacy/snapshots?projectId=project-legacy`)).json();
  assert.deepEqual(
    view.map(snapshot => [snapshot.name, snapshot.files.length, snapshot.changes.added.length]),
    [
      ['Sent to the client, October 27', 2, 2],
      ['Second round', 2, 1],
    ],
  );
  // The first set downloads as it was named, from the attempts it named.
  const download = await fetch(
    `${c.origin}/api/projects/project-legacy/snapshots/${first.data.id}/download?projectId=project-legacy`,
  );
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(
    download.headers.get('content-disposition'),
    /attachment; filename="Sent-to-the-client-October-27\.zip"/,
  );
  assert.deepEqual(unzip(Buffer.from(await download.arrayBuffer())), {
    'T-brief-Write-T-brief/brief.md': '# Brief\n',
    'T-copy-Write-T-copy/home.md': '# Home\n',
  });
  // A file that is not accepted work, or a name missing, is refused; a changed file is never downloaded.
  const stray = await c.request('/api/projects/project-legacy/snapshots', {
    projectId: project,
    name: 'Stray',
    files: [{ taskId: 'T-copy', path: '../secrets.md' }],
  });
  assert.equal(stray.status, 404);
  assert.equal((await c.request('/api/projects/project-legacy/snapshots', { projectId: project })).status, 400);
  fs.writeFileSync(path.join(store.directory, 'jobs', 'attempt-T-brief', 'output', 'brief.md'), '# Changed\n');
  const changed = await fetch(
    `${c.origin}/api/projects/project-legacy/snapshots/${first.data.id}/download?projectId=project-legacy`,
  );
  assert.equal(changed.status, 409);
});
