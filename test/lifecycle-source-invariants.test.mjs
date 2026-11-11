// Random code-story lifecycles keep the studio's promises (test/lifecycle-harness.mjs, its code-story world): a seeded
// generator plays code stories added, director actions the controller lists for them (Start, Accept, Send back,
// Integrate, Merge onto the current source, Reconcile source integration, ...), agents finishing, restarts, and
// restarts while an integration is still verifying, against the disposable repository of test/source-story-setup.mjs
// with the model-free source-edit and source-check fixtures. After every step it checks the first story's promises
// (allowed status changes, acceptance, reservations, no replay, a way forward, every listed action accepted) and the
// integration ones: a story recorded as integrated has an accepted, completed attempt and an integrated journal; no
// integration is re-run on its own across a restart; and the main branch tip moves only when the director sends an
// integration, never while a journal awaits Reconcile source integration. A failing sequence is shrunk and printed.
//
// Each story builds a git worktree and runs fixture checks, so the suite's budget is smaller than the general-work
// test's. A longer run by hand sets the same variables as test/lifecycle-invariants.test.mjs:
//   STUDIO_LIFECYCLE_SEED   the run's seed (a whole number; this file's is 20261104)
//   STUDIO_LIFECYCLE_RUNS   how many sequences (this file's is 6)
//   STUDIO_LIFECYCLE_STEPS  the most steps in one sequence (this file's is 14)
// for example, in Git Bash:
//   STUDIO_LIFECYCLE_SEED=7 STUDIO_LIFECYCLE_RUNS=30 STUDIO_LIFECYCLE_STEPS=24 node --test test/lifecycle-source-invariants.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSequence,
  generateSourceStep,
  checkLeases,
  checkWayForward,
  checkIntegrated,
  checkIntegrationReplay,
  exploreSourceLifecycles,
} from './lifecycle-harness.mjs';

const whole = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const seed = whole('STUDIO_LIFECYCLE_SEED', 20261104),
  runs = whole('STUDIO_LIFECYCLE_RUNS', 6),
  length = whole('STUDIO_LIFECYCLE_STEPS', 14);

test('the same seed writes the same code-story sequences', () => {
  assert.deepEqual(
    generateSequence(seed, length, generateSourceStep),
    generateSequence(seed, length, generateSourceStep),
  );
  assert.notDeepEqual(generateSequence(1234, 50, generateSourceStep), generateSequence(1235, 50, generateSourceStep));
  const steps = generateSequence(1234, 300, generateSourceStep);
  for (const step of steps) assert.deepEqual(JSON.parse(JSON.stringify(step)), step);
  assert.deepEqual([...new Set(steps.map(step => step.kind))].sort(), [
    'act',
    'add',
    'finish',
    'integrate-restart',
    'restart',
  ]);
  assert.ok(steps.filter(step => step.kind === 'add').length <= 2, 'At most two stories are added.');
  assert.deepEqual([...new Set(steps.filter(step => step.verdict).map(step => step.verdict))].sort(), [
    'needs-work',
    'pass',
  ]);
});

test('each integration check reports a hand-made violation', () => {
  const tip = 'a'.repeat(40),
    moved = 'b'.repeat(40),
    story = { id: 'T-1', status: 'done', acceptedAttemptId: 'r-1' },
    busy = { 'r-1': { id: 'source-integration:r-1', taskId: 'T-1', state: 'verifying' } },
    waiting = { 'r-1': { ...busy['r-1'], state: 'needs-reconciliation' } },
    rules = list => list.map(violation => violation.rule);

  // An integration journal re-run after a restart: it was verifying and is integrated after the restart.
  assert.deepEqual(
    rules(
      checkIntegrationReplay(
        { journals: busy, mainTip: tip },
        { journals: { 'r-1': { ...busy['r-1'], state: 'integrated' } }, mainTip: moved },
        { restart: true },
      ),
    ),
    ['integration-replay', 'main-tip'],
  );
  // Left awaiting Reconcile source integration with the tip in place, the restart keeps the promise.
  assert.deepEqual(
    checkIntegrationReplay({ journals: busy, mainTip: tip }, { journals: waiting, mainTip: tip }, { restart: true }),
    [],
  );
  // A main branch tip that moved with no director action.
  assert.deepEqual(rules(checkIntegrationReplay({ journals: {}, mainTip: tip }, { journals: {}, mainTip: moved })), [
    'main-tip',
  ]);
  assert.deepEqual(
    checkIntegrationReplay({ journals: {}, mainTip: tip }, { journals: {}, mainTip: moved }, { directed: true }),
    [],
  );
  // While a journal awaits Reconcile source integration, the tip does not move and the journal does not change, even
  // on a step that sent another integration; once Reconcile source integration is sent for its story, it may.
  assert.deepEqual(
    rules(
      checkIntegrationReplay(
        { journals: waiting, mainTip: tip },
        { journals: { 'r-1': { ...waiting['r-1'], state: 'integrated' } }, mainTip: moved },
        { directed: true },
      ),
    ),
    ['integration-replay', 'main-tip'],
  );
  assert.deepEqual(
    checkIntegrationReplay(
      { journals: waiting, mainTip: tip },
      { journals: { 'r-1': { ...waiting['r-1'], state: 'abandoned' } }, mainTip: tip },
      { reconciled: ['T-1'] },
    ),
    [],
  );

  // An integrated story whose attempt was not accepted.
  const stage = { current: 'integrated', integration: { attemptId: 'r-1', state: 'integrated' } },
    integrated = {
      id: 'r-1',
      taskId: 'T-1',
      sourceIntegration: { state: 'integrated' },
      result: { outcome: 'completed' },
    };
  assert.deepEqual(
    rules(
      checkIntegrated({ tasks: [{ ...story, sourceStage: stage }], attempts: [{ ...integrated, status: 'failed' }] }),
    ),
    ['integrated'],
  );
  // Or whose journal is not integrated.
  assert.deepEqual(
    rules(
      checkIntegrated({
        tasks: [{ ...story, sourceStage: stage }],
        attempts: [{ ...integrated, status: 'accepted', sourceIntegration: { state: 'verifying' } }],
      }),
    ),
    ['integrated'],
  );
  assert.deepEqual(
    checkIntegrated({ tasks: [{ ...story, sourceStage: stage }], attempts: [{ ...integrated, status: 'accepted' }] }),
    [],
  );

  // The first story's rules cover integrations: a busy journal holds its reservations, and a story whose journal
  // awaits Reconcile source integration lists a way forward.
  assert.deepEqual(rules(checkLeases({ liveAttempts: [], leases: [], journals: waiting })), ['reservation']);
  assert.deepEqual(
    checkLeases({
      liveAttempts: [],
      leases: [{ resource: 'source:root', attemptId: 'source-integration:r-1' }],
      journals: waiting,
    }),
    [],
  );
  assert.deepEqual(rules(checkWayForward({ tasks: [story], attempts: [], journals: waiting, actions: {} })), [
    'way-forward',
  ]);
  assert.deepEqual(
    checkWayForward({ tasks: [story], attempts: [], journals: waiting, actions: { 'T-1': [{ key: 'restore' }] } }),
    [],
  );
});

// About a minute on its own; the suite's default limit per test (120 s, package.json) is too tight beside the rest of
// the suite, so this test sets its own.
test(
  `random code-story lifecycles keep the studio's promises (seed ${seed}, ${runs} sequences of up to ${length} steps)`,
  { timeout: 480000 },
  async t => {
    const { counters, sequences, failure } = await exploreSourceLifecycles({
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
    // The run sent Send back, Integrate and Reconcile source integration, and restarted during a busy integration.
    const covered = {
      'Send back': (counters.actions['send-back'] || 0) + (counters.actions['send-back-passed'] || 0),
      Integrate: counters.actions.integrate,
      'a restart during a busy integration': counters.steps['restart during integration'],
      'Reconcile source integration': counters.actions.restore,
    };
    const missing = Object.entries(covered)
      .filter(([, count]) => !count)
      .map(([name]) => name);
    assert.deepEqual(missing, [], `Not covered: ${missing.join(', ')}. Counters: ${JSON.stringify(counters)}`);
  },
);
