// How much of a CLI's output the controller records, and that output volume never stops the work
// (v1.0 tally row 7). Model-free: the recording functions run against a stand-in runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Reuse the candidate-local temp policy: MXC's redirected OS temp denies some writes.
import './model-free-studio.mjs';
import { activityRowBytes, outputLineBytes, parseOutput, recordLine } from '../src/adapters/native-process.mjs';

function harness(t) {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-activity-'));
  t.after(() => fs.rmSync(job, { recursive: true, force: true }));
  const runtime = {
      events: [],
      failures: [],
      stopped: [],
      protocol: [],
      store: {
        event: (kind, taskId, attemptId, message) => runtime.events.push({ kind, attemptId, message }),
        updateAttempt: () => {},
      },
      stop(id) {
        this.stopped.push(id);
      },
      nativeFailure(entry, message) {
        this.failures.push(message);
      },
      recordLine(...args) {
        return recordLine.call(this, ...args);
      },
    },
    entry = {
      attempt: { id: 'attempt-activity', taskId: 'T-activity' },
      job,
      buffers: {},
      adapter: { recordEvent: (rt, e, data) => runtime.protocol.push(data.type) },
    };
  return { runtime, entry, job, write: text => parseOutput.call(runtime, entry, 'stdout', text) };
}

test('a long attempt keeps working past the activity rows, and its activity file keeps every line', t => {
  const { runtime, entry, job, write } = harness(t),
    line = JSON.stringify({ type: 'item.completed', text: 'x'.repeat(40 * 1024) });
  // About 3.3 MB: the amount that used to stop the attempt at 2 MB.
  for (let i = 0; i < 80; i++) write(line + '\n');
  assert.deepEqual(runtime.stopped, []);
  assert.equal(entry.nativeError, undefined);
  const rows = runtime.events.filter(event => event.kind === 'log'),
    markers = rows.filter(event => event.message.startsWith('controller:'));
  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /stopped recording at 2 MB; the attempt continues/);
  const recorded = rows.filter(event => event.message.startsWith('stdout:'));
  assert.ok(recorded.length < 80);
  assert.ok(recorded.reduce((total, event) => total + Buffer.byteLength(event.message), 0) <= activityRowBytes + 80);
  // The full output is in the attempt's activity file, in order.
  const kept = fs
    .readFileSync(path.join(job, 'activity.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(text => JSON.parse(text));
  assert.equal(kept.length, 80);
  assert.ok(kept.every(record => record.channel === 'stdout' && record.line === line && record.time));
  // Protocol lines are still read after the rows stop: a usage limit or a result is never missed.
  write(JSON.stringify({ type: 'error', message: 'usage limit reached' }) + '\n');
  assert.deepEqual(runtime.failures, ['usage limit reached']);
  assert.equal(runtime.protocol.at(-1), 'error');
  assert.equal(runtime.events.filter(event => event.kind === 'log').length, rows.length);
});

test('one unterminated output line past its limit stops the attempt, so memory stays bounded', t => {
  const { runtime, entry, write } = harness(t);
  write('y'.repeat(outputLineBytes + 1));
  assert.deepEqual(runtime.stopped, ['attempt-activity']);
  assert.match(entry.nativeError, /single output line over 8 MB/);
});
