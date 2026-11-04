// Each task's automatic attempts used and its limit, as the controller serves them (WorkflowRegistry.attemptCount):
// counted by the same rule the scheduler compares against the limit, a flow's current round and a staged story's
// current stage included, and read without writing anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { createRegistries } from '../src/registry.mjs';

const work = { cause: 'work' },
  usageLimit = { cause: 'usage-limit' },
  controllerStop = { cause: 'environment', detail: 'controller-stop' };

// A store holding one task and its attempts, as stageAttempts reads them.
const storeOf = (record, attempts) => ({
  task: id => {
    if (id !== record.id) throw new Error('Task not found.');
    return record;
  },
  attempts: id => (id === record.id ? attempts : []),
});

test("a flow task on its second round is served only that round's attempts, as stageAttempts counts them", () => {
  const { workflows } = createRegistries(),
    flowReference = { group: 'group-1', node: 'build', round: 2 },
    flowTask = { id: 'T-flow', kind: 'general', maxAttempts: 3, flowReference },
    attempts = [
      { id: 'attempt-r1-a', status: 'failed', flowRound: 1, endCause: work },
      { id: 'attempt-r1-b', status: 'accepted', flowRound: 1, endCause: work },
      { id: 'attempt-r2-a', status: 'failed', flowRound: 2, endCause: work },
      // An attempt that recorded its round only in its assignment, and one a usage limit stopped.
      { id: 'attempt-r2-b', status: 'failed', assignment: { flowReference: { round: 2 } }, endCause: work },
      { id: 'attempt-r2-limit', status: 'blocked', flowRound: 2, endCause: usageLimit },
    ],
    store = storeOf(flowTask, attempts);
  assert.deepEqual(
    workflows.stageAttempts(store, flowTask).map(attempt => attempt.id),
    ['attempt-r2-a', 'attempt-r2-b'],
  );
  assert.deepEqual(workflows.attemptCount(store, flowTask), { used: 2, allowed: 3 });
  // The same task on its first round counts that round's.
  const first = { ...flowTask, flowReference: { ...flowReference, round: 1 } },
    firstStore = storeOf(first, attempts);
  assert.deepEqual(workflows.attemptCount(firstStore, first), { used: 2, allowed: 3 });
  assert.deepEqual(
    workflows.stageAttempts(firstStore, first).map(attempt => attempt.id),
    ['attempt-r1-a', 'attempt-r1-b'],
  );
  // A task without a limit is served what it used and no limit; nothing is written to the task.
  const unlimited = { id: 'T-flow', kind: 'general', flowReference };
  assert.deepEqual(workflows.attemptCount(storeOf(unlimited, attempts), unlimited), { used: 2 });
  assert.deepEqual(Object.keys(unlimited).sort(), ['flowReference', 'id', 'kind']);
});

test("a staged story's review attempts are not counted toward its build, nor its build's toward its review", () => {
  const { workflows } = createRegistries(),
    build = 'studio-development:change',
    review = 'studio-development:change-review',
    attempts = [
      { id: 'attempt-build-1', status: 'failed', assignment: { kind: build }, endCause: work },
      { id: 'attempt-build-2', status: 'accepted', assignment: { kind: build }, endCause: work },
      {
        id: 'attempt-review-1',
        status: 'failed',
        assignment: { kind: review },
        candidateReview: { attemptId: 'attempt-build-1' },
        endCause: work,
      },
      {
        id: 'attempt-review-2',
        status: 'failed',
        assignment: { kind: review },
        candidateReview: { attemptId: 'attempt-build-2' },
        endCause: work,
      },
    ],
    story = {
      id: 'T-story',
      kind: build,
      maxAttempts: 3,
      sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', history: [] },
    };
  // Building: both build attempts count, the reviews do not, against the story's own limit.
  assert.deepEqual(workflows.attemptCount(storeOf(story, attempts), story), { used: 2, allowed: 3 });
  // In review: only the review of the current candidate counts, against the review stage's own limit.
  const reviewing = {
    ...story,
    sourceStage: {
      ...story.sourceStage,
      phase: 'candidate-review',
      candidate: { attemptId: 'attempt-build-2' },
      reviewTask: { kind: review, workerId: 'W-03', maxAttempts: 2, maxSeconds: 600 },
    },
  };
  const store = storeOf(reviewing, attempts);
  assert.deepEqual(
    workflows.stageAttempts(store, reviewing).map(attempt => attempt.id),
    ['attempt-review-2'],
  );
  assert.deepEqual(workflows.attemptCount(store, reviewing), { used: 1, allowed: 2 });
});

test('the served count is what the scheduler compares against the limit before it queues the task', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-count-')),
    app = createStudio({ directory, port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { store, runner } = app,
    workflows = runner.registries.workflows,
    worker = store.organization().workers.find(item => item.id === 'W-03'),
    record = (id, fields) =>
      store.putTask({
        id,
        projectId: 'project-legacy',
        kind: 'general',
        workerId: worker.id,
        team: worker.team,
        title: `Count ${id}`,
        brief: 'Bounded model-free work.',
        acceptance: 'A served count.',
        dependencies: [],
        resources: [],
        maxSeconds: 30,
        maxAttempts: 2,
        ...fields,
      });
  // A prerequisite nobody queued, so the counted task waits on it once queued and never starts here.
  record('T-before', { status: 'blocked' });
  record('T-count', { status: 'failed', dependencies: ['T-before'] });
  for (const [id, status, endCause] of [
    ['attempt-count-work', 'failed', work],
    ['attempt-count-limit', 'blocked', usageLimit],
    ['attempt-count-stop', 'cancelled', controllerStop],
    ['attempt-count-work-2', 'failed', work],
  ])
    store.insertAttempt({ id, taskId: 'T-count', status, endCause }, {});
  const queue = () => runner.pipeline('queue', ['T-count'], 'project-legacy'),
    count = () => workflows.attemptCount(store, store.task('T-count'));
  // Two attempts the work ended reach the limit of two: the scheduler refuses, and the count says so.
  assert.deepEqual(count(), { used: 2, allowed: 2 });
  assert.equal(count().used, workflows.stageAttempts(store, store.task('T-count')).length);
  assert.throws(queue, /reached its attempt limit/);
  // Once one of them is known to have ended with the controller, neither counts it: one used, and the task queues.
  store.updateAttempt({ ...store.attempt('attempt-count-work-2'), endCause: controllerStop });
  assert.deepEqual(count(), { used: 1, allowed: 2 });
  queue();
  assert.equal(store.task('T-count').queued, true);
  assert.deepEqual(count(), { used: 1, allowed: 2 }, 'Queuing starts nothing while the prerequisite waits.');
});
