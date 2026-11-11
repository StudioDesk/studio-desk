// Every stop says why (C-41, src/stop-record.mjs): each start records itself in the data folder and each stop it sees
// completes the record; the next start reports it, a record with no stop meaning the process was ended from outside.
// The supervisor says every exit of the controller in its window, and a forced end on Windows never reaches a process
// that has already exited, whose ID may belong to another process by then. On Windows a Ctrl+C reaches the controller
// itself, so the supervisor waits for it to close and ends it only after a bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { previousStop, stopRecordName, stopRecorder, uptimeText } from '../src/stop-record.mjs';
import { exitLine, stopController } from '../scripts/supervisor.mjs';

const folder = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-record-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('a start records itself, its stop completes the record once, and the next start reads either', t => {
  const directory = folder(t);
  assert.equal(previousStop(directory), null, 'a data folder used for the first time has no previous stop');
  const startedAt = new Date('2026-11-01T20:00:00Z'),
    run = stopRecorder(directory, { pid: 4242, startedAt });
  const unrecorded = previousStop(directory);
  assert.equal(unrecorded.recorded, false);
  assert.match(unrecorded.text, /process 4242, started 2026-11-01T20:00:00\.000Z\) stopped without recording why/);
  assert.equal(run.stop('it was asked to stop (SIGINT)', new Date('2026-11-01T22:03:00Z')), true);
  assert.equal(
    run.stop('it exited with code 0', new Date('2026-11-01T22:04:00Z')),
    false,
    'only the first stop counts',
  );
  const recorded = previousStop(directory);
  assert.equal(recorded.recorded, true);
  assert.equal(
    recorded.text,
    'The previous controller stopped at 2026-11-01T22:03:00.000Z after 2 h 3 min: it was asked to stop (SIGINT).',
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, stopRecordName), 'utf8')), {
    pid: 4242,
    startedAt: '2026-11-01T20:00:00.000Z',
    stoppedAt: '2026-11-01T22:03:00.000Z',
    uptimeSeconds: 7380,
    reason: 'it was asked to stop (SIGINT)',
  });
  // A damaged record is no record; a folder that cannot be written never stops a start or a stop.
  fs.writeFileSync(path.join(directory, stopRecordName), '{not json');
  assert.equal(previousStop(directory), null);
  const missing = path.join(directory, 'no-such-folder');
  assert.doesNotThrow(() => stopRecorder(missing).stop('it exited with code 0'));
});

test('how long a controller ran, and the line the supervisor shows for each way it exits', () => {
  assert.equal(uptimeText(42), '42 s');
  assert.equal(uptimeText(125), '2 min');
  assert.equal(uptimeText(3 * 3600 + 5 * 60), '3 h 5 min');
  assert.equal(uptimeText(2 * 86400 + 3600), '2 d 1 h');
  assert.equal(uptimeText(NaN), 'an unknown time');
  const startedAt = new Date('2026-11-01T21:00:00Z'),
    at = new Date('2026-11-01T22:03:00Z');
  assert.equal(
    exitLine(1, null, startedAt, at),
    'Studio desk: the controller exited with exit code 1 at 2026-11-01T22:03:00.000Z, after 1 h 3 min.',
  );
  assert.match(exitLine(null, 'SIGKILL', startedAt, at), /exited on the signal SIGKILL at/);
  assert.match(exitLine(75, null, startedAt, at), /exited for a planned restart at/);
  assert.match(exitLine(0, null, startedAt, at), /exited normally \(exit code 0\) at/);
});

test('a forced end on Windows passes over a process that has exited; elsewhere the process group is still ended', async t => {
  const require = createRequire(import.meta.url),
    childProcess = require('node:child_process'),
    plainSpawnSync = childProcess.spawnSync,
    plainKill = process.kill,
    ended = [];
  childProcess.spawnSync = (program, args, options) =>
    program === 'taskkill'
      ? (ended.push(['taskkill', ...args]), { status: 0 })
      : plainSpawnSync(program, args, options);
  syncBuiltinESMExports();
  process.kill = (pid, signal) => (ended.push(['kill', pid, signal]), true);
  t.after(() => {
    childProcess.spawnSync = plainSpawnSync;
    syncBuiltinESMExports();
    process.kill = plainKill;
  });
  const { Runner } = await import('../src/core/orchestrator.mjs'),
    { stopProcess } = await import('../src/connectors/source-integration.mjs');
  const exited = { pid: 4242, exitCode: 0, signalCode: null },
    running = { pid: 4243, exitCode: null, signalCode: null };
  for (const child of [exited, running]) {
    Runner.prototype.terminate.call({ fixtureProcessTermination: null }, { child }, true);
    stopProcess(child);
  }
  if (process.platform === 'win32')
    assert.deepEqual(ended, [
      ['taskkill', '/PID', '4243', '/T', '/F'],
      ['taskkill', '/PID', '4243', '/T', '/F'],
    ]);
  else
    assert.deepEqual(ended, [
      ['kill', -4242, 'SIGKILL'],
      ['kill', -4242, 'SIGKILL'],
      ['kill', -4243, 'SIGKILL'],
      ['kill', -4243, 'SIGKILL'],
    ]);
});

// Starts the controller as `npm start`'s supervisor starts it, on a throwaway data folder and any free port, and
// answers once it prints its address, with everything it printed so far.
function controller(directory, t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, STUDIO_DATA_DIR: directory, STUDIO_PORT: '0', STUDIO_SUPERVISED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => child.exitCode === null && child.kill('SIGKILL'));
  let output = '';
  const exited = new Promise(resolve => child.on('exit', resolve));
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The controller did not start: ${output.slice(-500)}`)), 60000);
    const read = chunk => {
      output += chunk;
      if (/Press Ctrl\+C to stop/.test(output)) {
        clearTimeout(timer);
        setTimeout(() => resolve(output), 300);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', code => reject(new Error(`The controller exited (${code}): ${output.slice(-500)}`)));
  });
  return { child, started, exited, output: () => output };
}

test('the next start reports a controller ended from outside, and on macOS and Linux one asked to stop', async t => {
  const directory = folder(t);
  const first = controller(directory, t);
  await first.started;
  assert.doesNotMatch(first.output(), /previous controller/, 'a first start has nothing to report');
  // Ended from outside, as Task Manager or taskkill would: nothing in the process sees it. The operating system
  // releases its lock on the data folder as it ends, so the next start is not refused, whatever program the system
  // hands its process ID to.
  first.child.kill('SIGKILL');
  await first.exited;
  const second = controller(directory, t);
  const said = await second.started;
  assert.match(
    said,
    new RegExp(`The previous controller \\(process ${first.child.pid}, started .*\\) stopped without recording why`),
  );
  if (process.platform === 'win32') {
    second.child.kill('SIGKILL');
    await second.exited;
    return;
  }
  second.child.kill('SIGTERM');
  await second.exited;
  assert.match(second.output(), /Studio desk: stopping at .*: it was asked to stop \(SIGTERM\)\./);
  const third = controller(directory, t);
  assert.match(
    await third.started,
    /The previous controller stopped at .* after .*: it was asked to stop \(SIGTERM\)\./,
  );
  third.child.kill('SIGKILL');
  await third.exited;
});

// A stand-in controller: a small Node process running the given script, whose ends the test can watch, and whose
// kill calls are counted, so the test sees whether the supervisor ended it or it closed by itself.
function standIn(t, script, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const plainKill = child.kill.bind(child),
    kills = [];
  child.kill = signal => (kills.push({ signal, at: Date.now() }), plainKill(signal));
  t.after(() => child.exitCode === null && child.signalCode === null && plainKill('SIGKILL'));
  const startedAt = new Date(),
    exited = new Promise(resolve =>
      child.on('exit', (code, signal) =>
        resolve({ code, signal, at: Date.now(), line: exitLine(code, signal, startedAt) }),
      ),
    );
  return { child, kills, exited };
}

test('on Windows the supervisor waits for a controller that records its stop and closes by itself', async t => {
  const directory = folder(t),
    said = [];
  // As if it had received the window's Ctrl+C itself: it records why it stopped and exits shortly after.
  const { child, kills, exited } = standIn(
    t,
    `const { stopRecorder } = await import(process.argv[1]);
    const run = stopRecorder(process.argv[2]);
    setTimeout(() => { run.stop('it was asked to stop (SIGINT)'); process.exit(0); }, 300);`,
    [pathToFileURL(fileURLToPath(new URL('../src/stop-record.mjs', import.meta.url))).href, directory],
  );
  const options = { platform: 'win32', boundMs: 5000, log: line => said.push(line) };
  assert.equal(stopController(child, 'SIGINT', options), 'waiting');
  assert.equal(stopController(child, 'SIGINT', options), 'already waiting', 'a repeated Ctrl+C starts no second wait');
  const end = await exited;
  assert.deepEqual(kills, [], 'the supervisor did not end the controller');
  assert.equal(end.code, 0);
  assert.equal(end.signal, null);
  assert.match(end.line, /the controller exited normally \(exit code 0\) at/);
  const stop = previousStop(directory);
  assert.equal(stop.recorded, true);
  assert.match(stop.text, /: it was asked to stop \(SIGINT\)\.$/);
  assert.deepEqual(said, ['Studio desk: waiting up to 5 s for the controller to record its stop and close.']);
  assert.equal(stopController(child, 'SIGINT', options), 'exited');
  assert.equal(said.length, 1, 'nothing more is said for a controller that has exited');
});

test('on Windows the supervisor ends a controller that does not close within the bound, and not before', async t => {
  const said = [],
    boundMs = 600;
  const { child, kills, exited } = standIn(t, 'setInterval(() => {}, 1000);');
  const askedAt = Date.now();
  const options = { platform: 'win32', boundMs, log: line => said.push(line) };
  assert.equal(stopController(child, 'SIGINT', options), 'waiting');
  await new Promise(resolve => setTimeout(resolve, boundMs / 2));
  assert.equal(stopController(child, 'SIGINT', options), 'already waiting');
  assert.deepEqual(kills, [], 'not ended before the bound');
  assert.equal(child.exitCode, null);
  await exited;
  assert.equal(kills.length, 1, 'ended once, by one wait');
  assert.equal(kills[0].signal, undefined, 'ended with the default way to end a process');
  assert.ok(kills[0].at - askedAt >= boundMs - 20, `ended after the bound (${kills[0].at - askedAt} ms)`);
  assert.deepEqual(said, [
    'Studio desk: waiting up to 0.6 s for the controller to record its stop and close.',
    'Studio desk: the controller did not close within 0.6 s; ending it.',
  ]);
});

test('on macOS and Linux the supervisor forwards the signal to the controller at once', () => {
  for (const platform of ['linux', 'darwin'])
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const kills = [],
        said = [];
      const child = { exitCode: null, signalCode: null, kill: sent => kills.push(sent) };
      assert.equal(stopController(child, signal, { platform, boundMs: 10, log: line => said.push(line) }), 'forwarded');
      assert.deepEqual(kills, [signal]);
      assert.deepEqual(said, []);
    }
});
