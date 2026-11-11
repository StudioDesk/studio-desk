// The controller's claim on its data folder (src/data-folder-lock.mjs, src/server.mjs createStudio): each start takes
// an exclusive lock on a lock file of its own in the folder before it opens the studio's records, and holds it until
// it closes or ends however it ends. A second controller, in this process or another, is refused while the lock is
// held; a start that fails after taking it, or is refused, leaves it as it found it. The owner record is still written
// and deleted as before, but its process ID and start time no longer decide anything, so a record naming a live,
// unrelated program never blocks a start. Model-free; the other programs are Node processes this test starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { realPath } from '../src/core/real-path.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from './model-free-studio.mjs';

const refused = /Another controller owns this data folder/;

const folder = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const ownerRow = app =>
  JSON.parse(app.store.db.prepare('SELECT data FROM settings WHERE id=?').get('controller-owner').data);
// The rows a start reads back: every setting but the owner record, every task and every event, in record order.
const records = app => ({
  settings: app.store.db.prepare("SELECT id, data FROM settings WHERE id<>'controller-owner' ORDER BY id").all(),
  tasks: app.store.db.prepare('SELECT id, data FROM tasks ORDER BY id').all(),
  events: app.store.db.prepare('SELECT seq, time, kind, task_id, attempt_id, message FROM events ORDER BY seq').all(),
});

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

// Another Node process that opens a model-free studio on the folder, closes it if it started, and exits: with 0 and
// 'started' if it started, with 3 and the refusal's message if it did not. Answers its exit code and what it printed.
function startInAnotherProcess(t, directory) {
  const studio = new URL('./model-free-studio.mjs', import.meta.url).href;
  const script = `import { createStudio } from ${JSON.stringify(studio)};
try {
  const app = createStudio({ directory: process.argv[1], port: 0 });
  await app.close();
  console.log('started');
} catch (error) {
  console.error(error.message);
  process.exitCode = 3;
}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  t.after(() => child.exitCode === null && child.kill('SIGKILL'));
  return new Promise(resolve =>
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, output });
    }),
  );
}

test('a second controller is refused while the first holds the folder, in this process and in another', async t => {
  const directory = folder(t);
  const first = createStudio({ directory, port: 0 });
  t.after(() => first.close());
  const owner = ownerRow(first);
  assert.throws(() => createStudio({ directory, port: 0 }), refused);
  const other = await startInAnotherProcess(t, directory);
  assert.equal(other.code, 3, `the other process was refused: ${other.output}`);
  assert.match(other.output, refused);
  assert.doesNotMatch(other.output, /started/);
  // The first still runs on its records, which neither refused start opened or changed, and still holds the lock.
  assert.deepEqual(ownerRow(first), owner);
  assert.throws(() => createStudio({ directory, port: 0 }), refused);
  await first.close();
  // Once it closes, the next start succeeds, here and in another process.
  const next = createStudio({ directory, port: 0 });
  assert.equal(ownerRow(next).pid, process.pid);
  assert.notEqual(ownerRow(next).id, owner.id);
  await next.close();
  const later = await startInAnotherProcess(t, directory);
  assert.equal(later.code, 0, `the other process started: ${later.output}`);
  assert.match(later.output, /started/);
});

test('an owner record naming a live, unrelated program with its true start time does not block the start', async t => {
  const directory = folder(t);
  const running = startChild(t);
  const previous = { id: 'running-owner', pid: running.child.pid, startedAt: running.recordedAt.toISOString() };
  // A studio is opened and closed on the folder, its owner record replaced by one naming the running program
  // (closing deletes only its own record, so the one written over it stays).
  const before = createStudio({ directory, port: 0 });
  before.store.db.prepare('UPDATE settings SET data=? WHERE id=?').run(JSON.stringify(previous), 'controller-owner');
  await before.close();
  const app = createStudio({ directory, port: 0 });
  t.after(() => app.close());
  const owner = ownerRow(app);
  assert.notEqual(owner.id, previous.id, 'the new start records an owner of its own');
  assert.equal(owner.pid, process.pid);
  assert.deepEqual(Object.keys(owner).sort(), ['id', 'pid', 'startedAt']);
  await app.close();
  assert.equal(running.child.exitCode, null, 'the unrelated program was left running');
  assert.equal(running.child.signalCode, null);
});

test('a start that fails after taking the lock leaves it free', async t => {
  const directory = folder(t);
  // The Runner's constructor asks the integration to recover what a stop cut off; this one cannot.
  const failing = {
    integration: {
      recover() {
        throw new Error('The runner could not start.');
      },
    },
  };
  assert.throws(() => createStudio({ directory, port: 0, runnerOptions: failing }), /The runner could not start/);
  assert.throws(() => createStudio({ directory, port: 0, runnerOptions: failing }), /The runner could not start/);
  const app = createStudio({ directory, port: 0 });
  t.after(() => app.close());
  assert.equal(ownerRow(app).pid, process.pid);
  await app.close();
});

test('the start after a clean close takes the lock again and reads the records back unchanged', async t => {
  const directory = folder(t);
  const first = createStudio({ directory, port: 0 });
  first.store.db
    .prepare('INSERT INTO settings VALUES (?,?)')
    .run('lock-test-record', JSON.stringify({ kept: 'across starts' }));
  first.store.event('control', null, null, 'A record written before the clean close.');
  const written = records(first);
  assert.ok(written.tasks.length > 0, 'the studio holds tasks to read back');
  await first.close();
  const second = createStudio({ directory, port: 0 });
  t.after(() => second.close());
  assert.deepEqual(records(second), written);
  assert.throws(() => createStudio({ directory, port: 0 }), refused, 'the second start holds the lock again');
  await second.close();
});

test("the lock is a file of its own: the studio's database stays open to other readers", async t => {
  const directory = folder(t);
  const app = createStudio({ directory, port: 0 });
  t.after(() => app.close());
  const lock = path.join(directory, 'controller.lock'),
    database = path.join(directory, 'studio.sqlite');
  assert.ok(fs.existsSync(lock), 'the lock file is in the data folder');
  assert.ok(fs.existsSync(database));
  assert.notEqual(realPath(lock), realPath(database));
  // While the controller runs, another connection reads the studio's records, and the lock file refuses one.
  const reader = new DatabaseSync(database, { readOnly: true, timeout: 0 });
  try {
    const row = reader.prepare('SELECT data FROM settings WHERE id=?').get('controller-owner');
    assert.deepEqual(JSON.parse(row.data), ownerRow(app));
  } finally {
    reader.close();
  }
  const other = new DatabaseSync(lock, { timeout: 0 });
  try {
    assert.throws(() => other.exec('BEGIN IMMEDIATE'), /database is locked/);
  } finally {
    other.close();
  }
  await app.close();
  // The lock file may stay after release; only the held lock matters.
  const next = createStudio({ directory, port: 0 });
  await next.close();
});
