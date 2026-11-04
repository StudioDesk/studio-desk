// The controller's owner record (src/server.mjs, createStudio): each start records its ID, its pid and when its process
// began, and a later start is refused only while the recorded owner still runs. An owner whose ID now belongs to a
// process that began later, or whose ID is gone, no longer holds the data folder; an owner recorded before start times
// were (no startedAt) keeps the ID-only answer. Model-free; the "previous owners" are Node processes this test starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createStudio } from './model-free-studio.mjs';
import { processStartTimes } from '../src/adapters/process.mjs';

const hour = 60 * 60 * 1000;
const refused = /Another controller owns this data folder/;

// A data folder whose controller-owner record is `record`: a studio is opened and closed on it (closing deletes only
// its own record, so the one written over it stays).
async function folderOwnedBy(t, record) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = createStudio({ directory, port: 0 });
  app.store.db.prepare('UPDATE settings SET data=? WHERE id=?').run(JSON.stringify(record), 'controller-owner');
  await app.close();
  return directory;
}
const ownerRow = app =>
  JSON.parse(app.store.db.prepare('SELECT data FROM settings WHERE id=?').get('controller-owner').data);

// A process that is not a controller and waits until stopped, its start recorded right after the spawn returns.
function startChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const recordedAt = new Date();
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { child, recordedAt, closed };
}

// Opens a studio on the folder, which must succeed, and checks the new owner is this process with its own start.
async function startsAndOwns(t, directory, previous) {
  const app = createStudio({ directory, port: 0 });
  t.after(() => app.close());
  const owner = ownerRow(app);
  assert.notEqual(owner.id, previous.id, 'the new start records an owner of its own');
  assert.equal(owner.pid, process.pid);
  assert.deepEqual(Object.keys(owner).sort(), ['id', 'pid', 'startedAt']);
  const ownStart = Date.now() - process.uptime() * 1000;
  assert.ok(
    Math.abs(Date.parse(owner.startedAt) - ownStart) < 1000,
    `the owner's start ${owner.startedAt} is when this process began`,
  );
  await app.close();
  return owner;
}

test('an owner whose ID now belongs to a program that began later does not block the start', async t => {
  const running = startChild(t);
  const previous = {
    id: 'previous-owner',
    pid: running.child.pid,
    startedAt: new Date(running.recordedAt.getTime() - hour).toISOString(),
  };
  const directory = await folderOwnedBy(t, previous);
  await startsAndOwns(t, directory, previous);
  // Closing deleted the new owner's record, as it always did: a record of this very process would refuse the next
  // start, which finds no owner at all.
  const again = createStudio({ directory, port: 0 });
  t.after(() => again.close());
  assert.equal(ownerRow(again).pid, process.pid);
  await again.close();
  assert.equal(running.child.exitCode, null, 'the unrelated program was left running');
});

test('an owner that really runs, recorded with its true start time, still blocks the start', async t => {
  const running = startChild(t);
  const directory = await folderOwnedBy(t, {
    id: 'running-owner',
    pid: running.child.pid,
    startedAt: running.recordedAt.toISOString(),
  });
  assert.throws(() => createStudio({ directory, port: 0 }), refused);
  // The refused start left the running owner's record in place, so it is refused again.
  assert.throws(() => createStudio({ directory, port: 0 }), refused);
});

test('an owner whose process has exited does not block the start', async t => {
  const exited = startChild(t);
  exited.child.kill();
  await exited.closed;
  const previous = { id: 'exited-owner', pid: exited.child.pid, startedAt: exited.recordedAt.toISOString() };
  await startsAndOwns(t, await folderOwnedBy(t, previous), previous);
});

test('an owner recorded before start times were keeps the ID-only answer: a running pid blocks', async t => {
  const running = startChild(t);
  const directory = await folderOwnedBy(t, { id: 'old-owner', pid: running.child.pid });
  const reads = t.mock.method(processStartTimes, 'read', () => {
    throw new Error('an owner without a start time is never compared by start time');
  });
  assert.throws(() => createStudio({ directory, port: 0 }), refused);
  assert.equal(reads.mock.callCount(), 0);
  // Once that pid is gone, the same old record no longer blocks.
  running.child.kill();
  await running.closed;
  reads.mock.restore();
  await startsAndOwns(t, directory, { id: 'old-owner' });
});

test('a second studio in the same process is refused without asking the operating system for a start time', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = createStudio({ directory, port: 0 });
  t.after(() => first.close());
  const reads = t.mock.method(processStartTimes, 'read', () => 'unknown');
  assert.throws(() => createStudio({ directory, port: 0 }), refused);
  assert.equal(reads.mock.callCount(), 0, "this process's own start is the one its owner recorded");
  // An owner recorded by an earlier process that had this process's ID began before this one: it has ended.
  first.store.db
    .prepare('UPDATE settings SET data=? WHERE id=?')
    .run(
      JSON.stringify({ id: 'earlier', pid: process.pid, startedAt: new Date(Date.now() - 2 * hour).toISOString() }),
      'controller-owner',
    );
  await first.close();
  const second = createStudio({ directory, port: 0 });
  t.after(() => second.close());
  assert.equal(ownerRow(second).pid, process.pid);
  assert.equal(reads.mock.callCount(), 0);
  await second.close();
});
