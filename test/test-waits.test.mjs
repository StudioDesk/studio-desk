// The shared test waits (test/wait-for.mjs): a generous limit measured by elapsed time, and a
// timeout that says what was expected and what the task showed instead. Slow work runs on mocked
// timers, so these tests take no real waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor, waitForTask, waitLimit } from './wait-for.mjs';

// A store whose task is running until the mocked clock reaches finishesAt, then in review.
function slowStore(finishesAt) {
  const attempt = { id: 'attempt-slow', status: 'completed' };
  return {
    task: id => ({
      id,
      status: Date.now() >= finishesAt ? 'review' : 'running',
      reason: Date.now() >= finishesAt ? 'Waiting for review.' : '',
      lastAttemptId: attempt.id,
    }),
    attempt: id => {
      assert.equal(id, attempt.id);
      return attempt;
    },
  };
}

// Advances mocked time in steps, letting the wait schedule its next poll before each step and
// check once more after the last.
async function advance(t, ms, step = 500) {
  for (let passed = 0; passed < ms; passed += step) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(step);
  }
  await new Promise(resolve => setImmediate(resolve));
}

test('an attempt that finishes after the old fixed waits is still waited for and returned', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // The source-story wait gave up after 500 polls of 15 ms (about 7.5 s), the HTTP one after 12 s.
  const store = slowStore(30000);
  let outcome;
  waitForTask(store, 'T-slow', 'review').then(
    attempt => (outcome = attempt),
    error => (outcome = error),
  );
  await advance(t, 29000);
  assert.equal(outcome, undefined);
  await advance(t, 1000);
  assert.deepEqual(outcome, { id: 'attempt-slow', status: 'completed' });
});

test('the default limit is a minute of elapsed time, however few polls fit in it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let outcome;
  waitForTask(slowStore(Infinity), 'T-never', 'review').then(
    () => (outcome = 'resolved'),
    error => (outcome = error),
  );
  // Polls land every 500 ms of mocked time here, far fewer than an iteration budget would count.
  await advance(t, waitLimit - 500);
  assert.equal(outcome, undefined);
  await advance(t, 500);
  assert.equal(
    outcome.message,
    `Timed out after ${waitLimit} ms waiting for task T-never to be review; task T-never is running ` +
      '(no reason recorded), its last attempt attempt-slow is completed.',
  );
});

test('a task wait that runs out names the task, the expected status and what the task shows', async () => {
  const store = {
    task: id => ({ id, status: 'failed', reason: 'Candidate tests failed.', lastAttemptId: 'attempt-7' }),
    attempt: id => ({ id, status: 'failed' }),
  };
  await assert.rejects(waitForTask(store, 'T-stuck', 'review', { limit: 30 }), {
    message:
      'Timed out after 30 ms waiting for task T-stuck to be review; task T-stuck is failed ' +
      '(reason: Candidate tests failed.), its last attempt attempt-7 is failed.',
  });
  const unstarted = {
    task: id => ({ id, status: 'ready', reason: 'Waiting for approval.' }),
    attempt: () => assert.fail('A task with no attempt has none to read.'),
  };
  await assert.rejects(waitForTask(unstarted, 'T-new', 'running', { limit: 1 }), {
    message:
      'Timed out after 1 ms waiting for task T-new to be running; task T-new is ready ' +
      '(reason: Waiting for approval.), with no attempt.',
  });
});

test('the general wait returns what its check found, or names its label when the limit runs out', async () => {
  let polls = 0;
  assert.deepEqual(await waitFor(async () => ++polls === 3 && { polls }, 'three polls', { interval: 1 }), {
    polls: 3,
  });
  await assert.rejects(
    waitFor(() => false, 'the join waits', { limit: 20 }),
    {
      message: 'Timed out after 20 ms waiting for the join waits.',
    },
  );
  await assert.rejects(
    waitFor(() => 0, 'the summary', { limit: 1, detail: () => 'it is blocked' }),
    {
      message: 'Timed out after 1 ms waiting for the summary; it is blocked.',
    },
  );
  // A check that throws, as the store does for an unknown task, ends the wait at once.
  await assert.rejects(
    waitFor(() => {
      throw new Error('Assignment not found.');
    }, 'a missing task'),
    { message: 'Assignment not found.' },
  );
});
