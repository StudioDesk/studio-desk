// Random lifecycles keep the studio's promises (test/lifecycle-harness.mjs): a seeded generator plays work added,
// director actions the controller lists, agents finishing, time limits and restarts against a model-free general-work
// studio, and after every step checks allowed status changes, acceptance only from a validated completed attempt,
// reservations kept while an attempt may still run, no replay after a restart, a way forward for interrupted or blocked
// work, and every listed action accepted. A failing sequence is shrunk and printed as an ordinary test.
//
// The suite runs a fixed seed with a small budget. A longer run by hand sets any of:
//   STUDIO_LIFECYCLE_SEED   the run's seed (a whole number; the suite's is 20261103)
//   STUDIO_LIFECYCLE_RUNS   how many sequences (the suite's is 12)
//   STUDIO_LIFECYCLE_STEPS  the most steps in one sequence (the suite's is 20)
// for example, in Git Bash:
//   STUDIO_LIFECYCLE_SEED=7 STUDIO_LIFECYCLE_RUNS=60 STUDIO_LIFECYCLE_STEPS=40 node --test test/lifecycle-invariants.test.mjs
// (In PowerShell, set each with $env:NAME = 'value' first.) A failing run prints its sequence's seed and the shrunk steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRandom,
  generateSequence,
  shrink,
  asTest,
  checkTransitions,
  checkAccepted,
  checkLeases,
  checkReplay,
  checkWayForward,
  checkAnswer,
  exploreLifecycles,
} from './lifecycle-harness.mjs';

const whole = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const seed = whole('STUDIO_LIFECYCLE_SEED', 20261103),
  runs = whole('STUDIO_LIFECYCLE_RUNS', 12),
  length = whole('STUDIO_LIFECYCLE_STEPS', 20);

test('the same seed writes the same random numbers and the same step sequences', () => {
  const one = createRandom(42),
    other = createRandom(42);
  assert.deepEqual(
    Array.from({ length: 50 }, () => one.next()),
    Array.from({ length: 50 }, () => other.next()),
  );
  assert.deepEqual(generateSequence(seed, length), generateSequence(seed, length));
  assert.deepEqual(generateSequence(1234, 200), generateSequence(1234, 200));
  assert.notDeepEqual(generateSequence(1234, 50), generateSequence(1235, 50));
  // Steps are plain records that print and replay.
  for (const step of generateSequence(seed, 200)) assert.deepEqual(JSON.parse(JSON.stringify(step)), step);
});

test('the shrinker returns the shortest sequence that still breaks the same rule', async () => {
  const steps = ['a', 'b', 'X', 'c', 'd', 'e', 'Y', 'f', 'g'].map(name => ({ kind: 'act', task: name })),
    names = list => list.map(step => step.task);
  let replays = 0;
  const fails = async list => {
    replays++;
    const has = name => list.some(step => step.task === name);
    if (has('X') && has('Y')) return 'pair';
    // Another rule, which a candidate must not be kept for.
    if (has('a') && has('g')) return 'other';
    return null;
  };
  const shrunk = await shrink(steps, fails);
  assert.deepEqual(names(shrunk), ['X', 'Y']);
  assert.ok(replays < 60, `${replays} replays`);
  // A sequence that only breaks another rule is not shrunk toward it.
  assert.deepEqual(names(await shrink(steps.slice(0, 3), fails)), names(steps.slice(0, 3)));
  assert.match(asTest({ seed: 9, rule: 'pair', steps: shrunk }), /test\('lifecycle: pair \(seed 9\)'[\s\S]*replay\(\[/);
});

test('each promise check reports a hand-made violation', () => {
  // A status change the table does not allow.
  assert.deepEqual(
    checkTransitions([{ task: 'w1', from: 'backlog', to: 'done' }]).map(v => v.rule),
    ['transition'],
  );
  assert.deepEqual(checkTransitions([{ task: 'w1', from: 'review', to: 'done' }]), []);
  // A done task whose accepted attempt failed.
  const done = { id: 'T-1', status: 'done', acceptedAttemptId: 'a-1' },
    failed = { id: 'a-1', taskId: 'T-1', status: 'failed', result: { outcome: 'completed' }, artifacts: [] };
  assert.deepEqual(
    checkAccepted({ tasks: [done], attempts: [failed], files: {} }).map(v => v.rule),
    ['acceptance'],
  );
  const accepted = { ...failed, status: 'accepted', artifacts: [{ path: 'notes.md', hash: 'h1' }] };
  assert.deepEqual(checkAccepted({ tasks: [done], attempts: [accepted], files: { 'a-1': { 'notes.md': 'h1' } } }), []);
  assert.deepEqual(
    checkAccepted({ tasks: [done], attempts: [accepted], files: { 'a-1': { 'notes.md': 'h2' } } }).map(v => v.rule),
    ['acceptance'],
  );
  // A live attempt with no lease.
  const running = { id: 'a-2', taskId: 'T-2', status: 'running' };
  assert.deepEqual(
    checkLeases({ liveAttempts: [running], leases: [] }).map(v => v.rule),
    ['reservation'],
  );
  assert.deepEqual(
    checkLeases({ liveAttempts: [running], leases: [{ resource: 'attempt:a-2', attemptId: 'a-2' }] }),
    [],
  );
  // A new attempt across a restart, and a running attempt a crash did not leave interrupted.
  const before = { tasks: [{ id: 'T-2', status: 'running' }], attempts: [running] };
  assert.deepEqual(
    checkReplay(
      before,
      {
        tasks: [{ id: 'T-2', status: 'running' }],
        attempts: [running, { id: 'a-3', taskId: 'T-2', status: 'running' }],
      },
      { restart: true, crash: true },
    ).map(v => v.rule),
    ['no-replay', 'no-replay'],
  );
  assert.deepEqual(
    checkReplay(
      before,
      { tasks: [{ id: 'T-2', status: 'blocked' }], attempts: [{ ...running, status: 'interrupted' }] },
      { restart: true, crash: true },
    ),
    [],
  );
  // A new attempt for a task whose interrupted attempt was never reconciled.
  const interrupted = { id: 'a-4', taskId: 'T-4', status: 'interrupted' };
  assert.deepEqual(
    checkReplay(
      { tasks: [], attempts: [interrupted] },
      { tasks: [], attempts: [interrupted, { id: 'a-5', taskId: 'T-4', status: 'running' }] },
    ).map(v => v.rule),
    ['no-replay'],
  );
  // An interrupted task with no actions.
  assert.deepEqual(
    checkWayForward({ tasks: [{ id: 'T-4', status: 'blocked' }], attempts: [interrupted], actions: {} }).map(
      v => v.rule,
    ),
    ['way-forward'],
  );
  assert.deepEqual(
    checkWayForward({ tasks: [{ id: 'T-4', status: 'blocked' }], attempts: [interrupted], actions: { 'T-4': [{}] } }),
    [],
  );
  // A listed action answered 409.
  const action = { key: 'accept', label: 'Accept result', method: 'POST', path: '/api/tasks/T-1/accept' };
  const refused = checkAnswer({ task: 'w1', action, status: 409, data: { error: 'Conflict.' } });
  assert.deepEqual(
    refused.map(v => [v.rule, v.action, v.status]),
    [['listed-action', 'accept', 409]],
  );
  assert.deepEqual(checkAnswer({ task: 'w1', action, status: 202, data: {} }), []);
});

test(`random lifecycles keep the studio's promises (seed ${seed}, ${runs} sequences of up to ${length} steps)`, async t => {
  const { counters, sequences, failure } = await exploreLifecycles({
    seed,
    runs,
    length,
    log: line => t.diagnostic(line),
  });
  const total = sequences.reduce((sum, item) => sum + item.steps, 0);
  t.diagnostic(`${sequences.length} sequences, ${total} steps: ${JSON.stringify(counters)}`);
  assert.equal(
    failure,
    null,
    failure &&
      `Seed ${seed}: sequence seed ${failure.seed} broke ${failure.rule}: ${failure.message}\nShrunk to ${failure.steps.length} steps:\n${failure.test}`,
  );
  // The run covered every step kind, every director action the work offers, and every agent result.
  const covered = {
    'add work': counters.steps.add,
    'agent finishes': counters.steps.finish,
    timeout: counters.steps['timeout fired'],
    'graceful restart': counters.steps['graceful restart'],
    'crash restart': counters.steps['crash restart'],
    'Approve work': counters.actions.approve,
    'Start assignment': counters.actions.start,
    'Accept result': counters.actions.accept,
    'Request revision': counters.actions.revise,
    Close: counters.actions.close,
    'Request cancellation': counters.actions.cancel,
    'Reconcile interrupted attempt': counters.actions.reconcile,
    'the answer to a question': counters.actions.answer,
    completed: counters.results.completed,
    'failed check': counters.results['failed-check'],
    blocked: counters.results.blocked,
    question: counters.results.question,
  };
  const missing = Object.entries(covered)
    .filter(([, count]) => !count)
    .map(([name]) => name);
  assert.deepEqual(missing, [], `Not covered: ${missing.join(', ')}. Counters: ${JSON.stringify(counters)}`);
});
