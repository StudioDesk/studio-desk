// Every stop says why (C-41, src/stop-record.mjs): each start records itself in the data folder and each stop it sees
// completes the record; the next start reports it, a record with no stop meaning the process was ended from outside.
// The supervisor says every exit of the controller in its window, and a forced end on Windows never reaches a process
// that has already exited, whose ID may belong to another process by then.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { previousStop, stopRecordName, stopRecorder, uptimeText } from '../src/stop-record.mjs';
import { exitLine } from '../scripts/supervisor.mjs';
import { startTimeSlackMs } from '../src/adapters/process.mjs';

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
  const spawnedAt = Date.now();
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
  return { child, spawnedAt, started, exited, output: () => output };
}

test('the next start reports a controller ended from outside, and on macOS and Linux one asked to stop', async t => {
  const directory = folder(t);
  const first = controller(directory, t);
  await first.started;
  assert.doesNotMatch(first.output(), /previous controller/, 'a first start has nothing to report');
  // Ended from outside, as Task Manager or taskkill would: nothing in the process sees it. It is ended only once the
  // start time slack has passed since it began, so a program the operating system hands its ID to straight away
  // (Windows does under load) began measurably later than the recorded owner, and the next start is not refused.
  const slackPassed = first.spawnedAt + startTimeSlackMs + 1000;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, slackPassed - Date.now())));
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
