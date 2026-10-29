// A test studio's cleanup ends well within the suite's 120-second per-test bound, or says which folder it could
// not remove and why: the studio closes while its server still has connections open, and the folder is removed
// once Windows lets go of it. Model-free: the connections are raw requests the test holds open, and the refused
// removals are stubs or a process still running in the folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { closeAndRemove, removeFolder } from './fixture-cleanup.mjs';
import { waitFor } from './wait-for.mjs';

const refusal = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cleanup-'));

// A raw request whose body the test sends in parts, so it stays unanswered as long as the test likes.
function partialRequest(origin, token) {
  const { port } = new URL(origin),
    socket = net.connect(Number(port), '127.0.0.1'),
    request = { socket, answer: '' };
  socket.setEncoding('utf8');
  socket.on('data', chunk => (request.answer += chunk));
  socket.on('error', () => {});
  request.closed = new Promise(resolve => socket.on('close', resolve));
  socket.write(
    `POST /api/fixture-cleanup HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n` +
      `Content-Type: application/json\r\nX-Studio-Token: ${token}\r\nContent-Length: 2\r\n\r\n{`,
  );
  return request;
}

test('a studio closes while its server still has a request unanswered, one answered as it closes and an idle connection', async t => {
  const directory = folder(),
    app = createStudio({ directory, port: 0 });
  let held, answered;
  t.after(() => {
    held?.socket.destroy();
    answered?.socket.destroy();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const origin = await app.start(),
    // fetch keeps this connection open, idle, for its keep-alive.
    token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  let started = 0;
  app.server.on('request', () => started++);
  held = partialRequest(origin, token);
  answered = partialRequest(origin, token);
  await waitFor(() => started === 2, 'both partial requests to reach the controller');
  const began = Date.now(),
    closed = closeAndRemove(app, directory);
  // The second request's body completes once the server has begun to close, so it is answered and its
  // connection would then stay open for the client's keep-alive.
  await waitFor(() => !app.server.listening, 'the server to begin closing', { interval: 5 });
  answered.socket.write('}');
  await closed;
  const elapsed = Date.now() - began;
  // Stopping attempts takes at most about five seconds and the server's connections two more; without ending
  // them the close never finished, since the held request never completes.
  assert.ok(elapsed < 20000, `The studio closed in ${elapsed} ms.`);
  await Promise.all([held.closed, answered.closed]);
  assert.match(answered.answer, /^HTTP\/1\.1 \d{3} /, 'The request completed as the server closed is answered.');
  assert.equal(held.answer, '', 'The request that never completed has no answer.');
  assert.equal(fs.existsSync(directory), false);
});

test('a fixture folder Windows still holds is removed once it lets go, and one it never lets go of is named with the reason', async () => {
  const busy = folder(),
    calls = [];
  fs.writeFileSync(path.join(busy, 'held.txt'), 'held');
  await removeFolder(busy, {
    delay: 10,
    remove: (directory, options) => {
      calls.push(directory);
      if (calls.length <= 2) throw refusal('EBUSY', 'resource busy or locked');
      fs.rmSync(directory, options);
    },
  });
  assert.deepEqual(calls, [busy, busy, busy], 'Removed on the third try.');
  assert.equal(fs.existsSync(busy), false);

  const locked = folder();
  try {
    let tries = 0;
    const started = Date.now();
    await assert.rejects(
      removeFolder(locked, {
        attempts: 3,
        delay: 10,
        remove: () => {
          tries++;
          throw refusal('EPERM', 'operation not permitted');
        },
      }),
      error =>
        error.message.includes(locked) &&
        /after 3 attempts: EPERM: operation not permitted$/.test(error.message) &&
        error.cause.code === 'EPERM',
    );
    assert.equal(tries, 3);
    assert.ok(Date.now() - started < 5000, 'It reports instead of hanging.');
    // A refusal waiting cannot outlast is reported at once.
    tries = 0;
    await assert.rejects(
      removeFolder(locked, {
        remove: () => {
          tries++;
          throw refusal('EINVAL', 'invalid argument');
        },
      }),
      error =>
        error.message === `Could not remove the fixture folder ${locked} after 1 attempt: EINVAL: invalid argument`,
    );
    assert.equal(tries, 1);
  } finally {
    fs.rmSync(locked, { recursive: true, force: true });
  }
});

test('a fixture folder a process still runs in is removed once the process ends', async t => {
  const directory = folder(),
    inside = path.join(directory, 'job');
  fs.mkdirSync(inside);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    cwd: inside,
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  let refused = 0;
  await removeFolder(directory, {
    delay: 100,
    remove: (target, options) => {
      try {
        fs.rmSync(target, options);
      } catch (error) {
        // Windows refuses while the process runs in the folder; other systems remove it at once.
        refused++;
        child.kill('SIGKILL');
        throw error;
      }
    },
  });
  assert.equal(fs.existsSync(directory), false, `Removed after ${refused} refusal(s).`);
});

test("a studio whose close never ends is reported with its folder, within the cleanup's bound, and its folder still goes", async () => {
  const directory = folder(),
    started = Date.now();
  await assert.rejects(
    closeAndRemove({ close: () => new Promise(() => {}) }, directory, { limit: 200 }),
    error => error.message === `The studio in ${directory} did not close within 200 ms.`,
  );
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.existsSync(directory), false);
  // A close that fails is reported as it failed, after the folder is removed.
  const failing = folder();
  await assert.rejects(
    closeAndRemove({ close: async () => Promise.reject(new Error('Store is closed.')) }, failing),
    /^Error: Store is closed\.$/,
  );
  assert.equal(fs.existsSync(failing), false);
});
