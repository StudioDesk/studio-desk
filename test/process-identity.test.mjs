// A recorded process told from a later one that has its ID (src/adapters/process.mjs): the operating system's start
// time reader, processEnded() and live() against real child processes this test starts and stops, an ID this account
// may not look at (EPERM, modelled at process.kill with the reader replaced), and records made before start times
// were recorded. Model-free; the children are Node processes that wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  live,
  processEnded,
  processStartTimes,
  readProcessStartTime,
  startTimeSlackMs,
} from '../src/adapters/process.mjs';

const windows = process.platform === 'win32';
const hour = 60 * 60 * 1000;

// A child that waits until stopped, leading its own process group on macOS and Linux as attempts' processes do, with
// its start recorded right after the spawn returns.
function startChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: !windows,
  });
  const recordedAt = new Date();
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { child, recordedAt, closed };
}
async function stopChild({ child, closed }) {
  child.kill();
  await closed;
}
const refuse = t =>
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
  });

test('a running process recorded with its true start time is not ended and is live', async t => {
  const running = startChild(t);
  const { pid } = running.child;
  const pidStartedAt = running.recordedAt.toISOString();
  assert.equal(processEnded(pid, pidStartedAt), false);
  assert.equal(live({ pid, pidStartedAt }), true);
  // A record without a start time keeps today's answer for it.
  assert.equal(processEnded(pid), false);
  assert.equal(live({ pid }), true);
});

test('the same running process recorded an hour before it started counts as ended: its ID belongs to a later process', async t => {
  const running = startChild(t);
  const { pid } = running.child;
  const pidStartedAt = new Date(running.recordedAt.getTime() - hour).toISOString();
  assert.equal(processEnded(pid, pidStartedAt), true);
  assert.equal(live({ pid, pidStartedAt }), false);
});

test("an exited process's ID counts as ended with or without a start time", async t => {
  const running = startChild(t);
  const { pid } = running.child;
  const pidStartedAt = running.recordedAt.toISOString();
  await stopChild(running);
  assert.equal(processEnded(pid), true);
  assert.equal(processEnded(pid, pidStartedAt), true);
  assert.equal(live({ pid }), false);
  assert.equal(live({ pid, pidStartedAt }), false);
});

test('an exited ID is answered by signal 0 alone, without asking the operating system for a start time', async t => {
  const running = startChild(t);
  const { pid } = running.child;
  await stopChild(running);
  const read = t.mock.method(processStartTimes, 'read', () => assert.fail('no start time should be read'));
  assert.equal(processEnded(pid, running.recordedAt.toISOString()), true);
  assert.equal(live({ pid, pidStartedAt: running.recordedAt.toISOString() }), false);
  assert.equal(read.mock.callCount(), 0);
});

test('an ID this account may not look at is ended with a recorded start time it cannot read, and alive without one', t => {
  const pid = 424242;
  const pidStartedAt = new Date().toISOString();
  const read = t.mock.method(processStartTimes, 'read', () => 'unknown');
  refuse(t);
  assert.equal(processEnded(pid, pidStartedAt), true);
  assert.equal(live({ pid, pidStartedAt }), false);
  // Records made before start times were recorded keep today's answer, and nothing is asked of the system for them.
  const calls = read.mock.callCount();
  assert.equal(processEnded(pid), false);
  assert.equal(live({ pid }), true);
  assert.equal(read.mock.callCount(), calls);
  // The injected reader replaces the system's for processEnded as well.
  assert.equal(processEnded(pid, pidStartedAt, { readStartTime: () => 'unknown' }), true);
});

test('an ID this account may not look at is compared when the operating system shows its start time', t => {
  const recordedAt = new Date('2026-11-03T10:00:00.000Z');
  const pidStartedAt = recordedAt.toISOString();
  refuse(t);
  const at = offset => () => new Date(recordedAt.getTime() + offset);
  assert.equal(processEnded(4242, pidStartedAt, { readStartTime: at(-500) }), false);
  assert.equal(processEnded(4242, pidStartedAt, { readStartTime: at(startTimeSlackMs) }), false);
  assert.equal(processEnded(4242, pidStartedAt, { readStartTime: at(startTimeSlackMs + 1) }), true);
  assert.equal(processEnded(4242, pidStartedAt, { readStartTime: () => 'gone' }), true);
  t.mock.method(processStartTimes, 'read', at(-500));
  assert.equal(live({ pid: 4242, pidStartedAt }), true);
  t.mock.method(processStartTimes, 'read', at(hour));
  assert.equal(live({ pid: 4242, pidStartedAt }), false);
});

test('a process group that still answers while its leader is gone is the recorded group', t => {
  const pidStartedAt = new Date().toISOString();
  const kill = t.mock.method(process, 'kill', () => true);
  t.mock.method(processStartTimes, 'read', () => 'gone');
  // On macOS and Linux live() asks the group, which answers; on Windows it asks the process, which has just gone.
  assert.equal(live({ pid: 4242, pidStartedAt }), !windows);
  assert.equal(kill.mock.calls[0].arguments[0], windows ? 4242 : -4242);
  // A single process that answered and is then gone has ended.
  assert.equal(processEnded(4242, pidStartedAt), true);
  // The reader could not tell: a process this account may signal stays running, as before.
  t.mock.method(processStartTimes, 'read', () => 'unknown');
  assert.equal(processEnded(4242, pidStartedAt), false);
  assert.equal(live({ pid: 4242, pidStartedAt }), true);
});

test('a record with no pid is ended and not live', () => {
  for (const pid of [undefined, null, 0]) {
    assert.equal(processEnded(pid), true);
    assert.equal(processEnded(pid, new Date().toISOString()), true);
    assert.equal(live({ pid }), false);
    assert.equal(live({ pid, pidStartedAt: new Date().toISOString() }), false);
  }
});

test('a start time that cannot be read as a time is treated as not recorded', t => {
  refuse(t);
  t.mock.method(processStartTimes, 'read', () => 'unknown');
  assert.equal(processEnded(4242, 'not a time'), false);
  assert.equal(live({ pid: 4242, pidStartedAt: 'not a time' }), true);
});

test('the start time reader answers a time near the spawn for a running child and gone once it exits', async t => {
  const running = startChild(t);
  const { pid } = running.child;
  const started = readProcessStartTime(pid);
  assert.ok(started instanceof Date, `expected a time, got ${String(started)}`);
  // The child started at or before the record (whole-second clocks round it down), within a few seconds of it.
  const difference = started.getTime() - running.recordedAt.getTime();
  assert.ok(difference <= startTimeSlackMs, `started ${difference} ms after the record`);
  assert.ok(difference > -5000, `started ${-difference} ms before the record`);
  await stopChild(running);
  assert.equal(readProcessStartTime(pid), 'gone');
  assert.equal(readProcessStartTime(0), 'unknown');
  assert.equal(readProcessStartTime(-1), 'unknown');
});

test("each system's reader asks with an argument array and reads its answer", () => {
  const calls = [];
  const runner = (status, stdout) => (file, args, options) => {
    calls.push({ file, args, options });
    return { status, stdout };
  };
  // Windows: PowerShell by its full path, the query encoded as one argument.
  const at = Date.parse('2026-11-03T10:00:00.250Z');
  const win = readProcessStartTime(321, { platform: 'win32', run: runner(0, `${at}\r\n`) });
  assert.equal(win.getTime(), at);
  assert.match(calls[0].file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.match(Buffer.from(calls[0].args[3], 'base64').toString('utf16le'), /Get-Process -Id 321 /);
  assert.equal(readProcessStartTime(321, { platform: 'win32', run: runner(0, 'gone\r\n') }), 'gone');
  assert.equal(readProcessStartTime(321, { platform: 'win32', run: runner(0, 'unknown\r\n') }), 'unknown');
  assert.equal(readProcessStartTime(321, { platform: 'win32', run: runner(1, '') }), 'unknown');
  assert.equal(readProcessStartTime(321, { platform: 'win32', run: runner(null, '') }), 'unknown');

  // Linux: /proc/<pid>/stat's start time in clock ticks after /proc/stat's boot time; a command name may hold ') '.
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[19] = '12345';
  const files = {
    '/proc/77/stat': `77 (odd ) name) ${fields.join(' ')}\n`,
    '/proc/stat': 'cpu 1 2 3\nbtime 1790000000\nprocesses 9\n',
  };
  const readFile = file => {
    if (file in files) return files[file];
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const linux = readProcessStartTime(77, { platform: 'linux', readFile, run: runner(0, '100\n') });
  assert.ok(linux instanceof Date);
  assert.ok(Math.abs(linux.getTime() - (1790000000 * 1000 + 123450)) < 1000);
  assert.equal(readProcessStartTime(78, { platform: 'linux', readFile, run: runner(0, '100\n') }), 'gone');
  const denied = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  assert.equal(readProcessStartTime(77, { platform: 'linux', readFile: denied, run: runner(0, '100\n') }), 'unknown');

  // macOS: ps prints the start in the C locale.
  calls.length = 0;
  const mac = readProcessStartTime(55, { platform: 'darwin', run: runner(0, 'Tue Nov  3 10:00:00 2026\n') });
  assert.ok(mac instanceof Date);
  assert.equal(mac.getTime(), new Date(2026, 10, 3, 10, 0, 0).getTime());
  assert.deepEqual([calls[0].file, calls[0].args], ['ps', ['-o', 'lstart=', '-p', '55']]);
  assert.equal(calls[0].options.env.LC_ALL, 'C');
  assert.equal(readProcessStartTime(55, { platform: 'darwin', run: runner(1, '') }), 'gone');
  assert.equal(readProcessStartTime(55, { platform: 'darwin', run: runner(0, 'not a date') }), 'unknown');

  // Elsewhere, and when the query cannot start, the answer is unknown.
  assert.equal(readProcessStartTime(55, { platform: 'freebsd' }), 'unknown');
  const thrower = () => {
    throw new Error('spawn failed');
  };
  assert.equal(readProcessStartTime(55, { platform: 'darwin', run: thrower }), 'unknown');
});
