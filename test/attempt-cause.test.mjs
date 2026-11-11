// Why an attempt ended (src/core/attempt-cause.mjs): the controller records an endCause on every attempt it finishes,
// and only the work's own endings use up a story's automatic attempts (WorkflowRegistry.stageAttempts). Model-free: a
// fixture adapter that finishes as each test asks, the source-story fixture's protocol CLI and fixture test commands,
// temporary records and no HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { setup as sourceStory } from './source-story-setup.mjs';
import { waitFor, waitForTask } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { countsTowardLimit } from '../src/core/registry.mjs';
import {
  causeText,
  endCause,
  finishedCause,
  recordedCause,
  sandboxCause,
  sandboxNeverStarted,
} from '../src/core/attempt-cause.mjs';
import { jobStartFailed } from '../src/adapters/process-job.mjs';
import { buildAttemptHistory } from '../src/core/attempt-history.mjs';
import { dashboardAttempt } from '../src/core/dashboard-state.mjs';

const controllerStop = { cause: 'environment', detail: 'controller-stop' },
  sandbox = { cause: 'environment', detail: 'sandbox' };

// A studio whose W-03 runs on a model-free adapter that ends each attempt as `c.behavior` says.
function causeStudio(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cause-')),
    registries = createRegistries(),
    c = { directory, registries, behavior: 'complete' };
  registries.adapters.register({
    id: 'cause-fixture',
    version: 'cause-fixture-v1',
    name: 'Cause fixture',
    workerSelectable: true,
    capabilities: ['text-output'],
    modes: ['workspace'],
    status: () => ({ available: true, label: 'Protocol fixture' }),
    blockReason: () => '',
    configuration: () => ({ mode: 'workspace' }),
    requestedModel: () => 'No model',
    delivery: 'Model-free end-cause fixture.',
    deliveryScope: 'Private fixture workspace.',
    start(runtime, entry) {
      this.run(runtime, entry);
    },
    run(runtime, entry) {
      const a = entry.attempt,
        done = (outcome, artifacts) =>
          runtime.finish(entry, {
            taskId: a.taskId,
            outcome,
            summary: `Fixture ${outcome}.`,
            artifacts,
            checks: [],
            issues: outcome === 'blocked' ? ['Asks the director.'] : [],
            handoff: 'Review.',
          });
      if (c.behavior === 'hang') return;
      if (c.behavior === 'fail') return runtime.finish(entry, null, 'Fixture failure.');
      if (c.behavior === 'limit') {
        entry.quota = 'fixture-limit';
        return runtime.finish(entry, null, 'Fixture usage limit reached.');
      }
      // A process of the adapter's that never started, after it named that cause (as the source change's tests do).
      if (c.behavior === 'start-failure') {
        entry.startFailureCause = sandboxCause();
        entry.spawnError = 'Fixture process could not be started.';
        return runtime.finish(entry, null, entry.spawnError);
      }
      if (c.behavior === 'question') {
        fs.writeFileSync(
          path.join(entry.output, 'question.json'),
          JSON.stringify({
            schemaVersion: 'question-v1',
            ask: 'Which wording should the page use?',
            why: 'Both fit the story.',
            options: [{ label: 'Short' }, { label: 'Long' }],
            recommended: 0,
            choice: 'director',
            topics: [],
          }),
        );
        return done('blocked', [{ path: 'question.json', kind: 'question' }]);
      }
      fs.writeFileSync(path.join(entry.output, 'answer.txt'), 'Fixture result');
      done('completed', [{ path: 'answer.txt', kind: 'text' }]);
    },
  });
  c.open = () => {
    c.app = createStudio({ directory, port: 0, runnerOptions: { registries } });
    const org = c.app.store.organization();
    org.workers.find(worker => worker.id === 'W-03').provider = 'cause-fixture';
    c.app.store.setOrganization(org);
    return c.app;
  };
  c.open();
  c.task = (id, fields = {}) => {
    const worker = c.app.store.organization().workers.find(item => item.id === 'W-03');
    c.app.store.putTask({
      id,
      projectId: 'project-legacy',
      kind: 'general',
      workerId: worker.id,
      team: worker.team,
      title: `Cause ${id}`,
      brief: 'Bounded model-free work.',
      acceptance: 'A recorded cause.',
      status: 'ready',
      dependencies: [],
      resources: [],
      maxSeconds: 30,
      maxAttempts: 2,
      ...fields,
    });
    return id;
  };
  // Starts one attempt that ends as `behavior` says and returns it once it has left the running states.
  c.run = async (id, behavior, settled = ['review', 'failed', 'blocked', 'cancelled']) => {
    c.behavior = behavior;
    c.app.runner.start(id);
    const attemptId = c.app.store.task(id).lastAttemptId;
    return waitFor(() => {
      const attempt = c.app.store.attempt(attemptId);
      return settled.includes(attempt.status) && !c.app.runner.active.has(attemptId) && attempt;
    }, `attempt ${attemptId} to settle`);
  };
  c.counted = id => c.app.runner.registries.workflows.stageAttempts(c.app.store, c.app.store.task(id)).length;
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return c;
}

test('an attempt the controller shutdown cancels ended with the controller, and automatic start is still allowed after a restart', async t => {
  const c = causeStudio(t),
    id = c.task('T-shutdown');
  const failed = await c.run(id, 'fail');
  assert.deepEqual(failed.endCause, { cause: 'work' });
  assert.equal(c.counted(id), 1);
  c.behavior = 'hang';
  c.app.runner.start(id);
  const runningId = c.app.store.task(id).lastAttemptId;
  assert.equal(c.app.store.attempt(runningId).status, 'running');
  await c.app.close();
  c.open();
  const stopped = c.app.store.attempt(runningId);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(stopped.endCause, controllerStop);
  // The same count as before the stop: one of two, so the scheduler may start it again without the director.
  assert.equal(c.counted(id), 1);
  assert.equal(c.app.store.attempts(id).length, 2);
  const again = await c.run(id, 'complete');
  assert.equal(again.status, 'review');
  assert.equal(c.counted(id), 2);
});

test('a director Stop and a failed result are the work and count; a usage limit and a question record their causes and do not', async t => {
  const c = causeStudio(t),
    id = c.task('T-causes', { maxAttempts: 10 });
  const limited = await c.run(id, 'limit');
  assert.equal(limited.status, 'blocked');
  assert.deepEqual(limited.endCause, { cause: 'usage-limit' });
  assert.equal(c.counted(id), 0);
  const asked = await c.run(id, 'question');
  assert.equal(asked.question.ask, 'Which wording should the page use?');
  assert.deepEqual(asked.endCause, { cause: 'question' });
  assert.equal(c.counted(id), 0);
  const notStarted = await c.run(id, 'start-failure');
  assert.equal(notStarted.status, 'failed');
  assert.deepEqual(notStarted.endCause, sandbox);
  assert.equal(c.counted(id), 0);
  const failed = await c.run(id, 'fail');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.endCause, { cause: 'work' });
  assert.equal(c.counted(id), 1);
  c.behavior = 'hang';
  c.app.runner.start(id);
  const stopId = c.app.store.task(id).lastAttemptId;
  c.app.runner.stop(stopId);
  const stopped = c.app.store.attempt(stopId);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(stopped.endCause, { cause: 'work' });
  assert.equal(c.counted(id), 2);
  // The cause is served with the attempt summary, and a retrying agent reads it in plain words.
  assert.deepEqual(dashboardAttempt(c.app.store.attempt(limited.id)).endCause, { cause: 'usage-limit' });
  assert.equal(dashboardAttempt({ id: 'attempt-old', status: 'failed' }).endCause, undefined);
  const history = buildAttemptHistory(c.app.store, c.app.store.task(id), { now: 'fixed' }),
    entry = attemptId => history.files.find(file => file.path.endsWith(`-${attemptId}.md`)).content,
    item = attemptId => history.projection.find(value => value.attemptId === attemptId);
  assert.ok(entry(limited.id).includes('\n- ended by: a usage limit stopped it; not counted\n'));
  assert.ok(entry(failed.id).includes('\n- ended by: the work itself; counted toward the attempt limit\n'));
  assert.equal(
    item(notStarted.id).endedBy,
    "the candidate's test sandbox could not start, so no tests ran; not counted",
  );
});

test('a candidate whose test sandbox could not start records the environment and leaves the story count unchanged', async t => {
  const c = await sourceStory(t, 'pass', undefined, {}, true),
    { store, runner } = c.app,
    // The job wrapper's start-failure exit on Windows, where exit codes keep it; the built-in sandbox runner's own
    // start failure everywhere. Neither reports a test.
    commands = [
      ...(process.platform === 'win32'
        ? [{ executable: process.execPath, args: ['-e', `process.exit(${jobStartFailed})`] }]
        : []),
      {
        executable: process.execPath,
        args: ['-e', 'console.error("The sandbox runtime did not start: fixture refusal."); process.exit(1);'],
      },
    ],
    counted = () => runner.registries.workflows.stageAttempts(store, store.task(c.taskId)).length;
  for (const [index, command] of commands.entries()) {
    runner.sourceCheckCommand = command;
    runner.start(c.taskId);
    const attemptId = store.task(c.taskId).lastAttemptId;
    await waitForTask(store, c.taskId, 'failed');
    await waitFor(() => !runner.active.has(attemptId), `attempt ${attemptId} to finish`);
    const attempt = store.attempt(attemptId);
    assert.deepEqual(attempt.endCause, sandbox, attempt.error);
    assert.match(attempt.error, /test sandbox could not start .*so no tests ran/);
    assert.equal(counted(), 0);
    assert.equal(store.attempts(c.taskId).length, index + 1);
  }
});

test('an attempt recorded before endCause counts exactly as the earlier rules counted it', () => {
  // The earlier rule, kept here word for word.
  const earlier = attempt =>
    !attempt.subscriptionHold && !(attempt.status === 'interrupted' && attempt.reconciledAt) && !attempt.question?.ask;
  const records = [
    { status: 'failed' },
    { status: 'review' },
    { status: 'accepted' },
    { status: 'cancelled' },
    { status: 'quarantined' },
    { status: 'blocked', subscriptionHold: 'claude' },
    { status: 'interrupted' },
    { status: 'interrupted', reconciledAt: '2026-10-24T09:10:00.000Z' },
    { status: 'failed', reconciledAt: '2026-10-24T09:10:00.000Z' },
    { status: 'blocked', question: { ask: 'Which one?' } },
    { status: 'blocked', question: { problem: 'Not a question.' } },
    { status: 'blocked' },
  ];
  for (const record of records) assert.equal(countsTowardLimit(record), earlier(record), JSON.stringify(record));
  // A recorded cause decides on its own.
  assert.equal(countsTowardLimit({ status: 'interrupted', endCause: controllerStop }), false);
  assert.equal(countsTowardLimit({ status: 'cancelled', endCause: { cause: 'work' } }), true);
  assert.equal(countsTowardLimit({ status: 'failed', endCause: sandbox }), false);
  assert.deepEqual(recordedCause({ status: 'interrupted', reconciledAt: 'then' }), controllerStop);
  assert.equal(causeText({ status: 'cancelled', endCause: controllerStop }), 'the controller stopped; not counted');
});

test('a fixed attempt limit still counts every attempt, whatever ended it', () => {
  const { workflows } = createRegistries(),
    attempts = [
      { id: 'attempt-stop', status: 'cancelled', endCause: controllerStop },
      { id: 'attempt-sandbox', status: 'failed', endCause: sandbox },
      { id: 'attempt-limit', status: 'blocked', endCause: { cause: 'usage-limit' } },
      { id: 'attempt-work', status: 'failed', endCause: { cause: 'work' } },
    ],
    store = { task: id => ({ id, kind: 'unreal-integration' }), attempts: () => attempts };
  assert.ok(workflows.get('unreal-integration').fixedAttemptLimit);
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'unreal-integration' }), attempts);
  store.task = id => ({ id, kind: 'layout' });
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'layout' }), [attempts[3]]);
});

test('the cause rules: a time limit is the work, a shutdown stop the controller, and only known causes are recorded', () => {
  const attempt = { status: 'cancelled' };
  assert.deepEqual(finishedCause({ attempt, cancelled: true, shutdown: true }), controllerStop);
  assert.deepEqual(finishedCause({ attempt, cancelled: true }), { cause: 'work' });
  assert.deepEqual(finishedCause({ attempt, cancelled: true, timedOut: true, shutdown: true }), { cause: 'work' });
  // A cause an adapter observed does not survive a stop: the stop decides.
  assert.deepEqual(finishedCause({ attempt, cancelled: true, observed: sandbox }), { cause: 'work' });
  assert.deepEqual(finishedCause({ attempt: { status: 'failed' }, observed: sandbox }), sandbox);
  assert.deepEqual(finishedCause({ attempt: { status: 'blocked', subscriptionHold: 'codex' } }), {
    cause: 'usage-limit',
  });
  assert.throws(() => endCause('weather'), /Unknown attempt end cause/);
  assert.throws(() => endCause('environment', 'network'), /Invalid detail/);
  assert.throws(() => endCause('work', 'sandbox'), /Invalid detail/);
  // A run that reported tests, or failed without the sandbox's own words, is the candidate's.
  const tap = ['TAP version 13', 'not ok 1 - fails', '1..1', '# tests 1', ''].join('\n');
  assert.equal(sandboxNeverStarted({ exitCode: jobStartFailed, stdout: '' }), true);
  assert.equal(sandboxNeverStarted({ exitCode: jobStartFailed, stdout: tap }), false);
  assert.equal(sandboxNeverStarted({ exitCode: 1, stdout: '', stderr: 'npm ERR! lint failed' }), false);
  assert.equal(
    sandboxNeverStarted({
      exitCode: 1,
      stdout: '',
      stderr: 'The test command did not start in the sandbox: spawn ENOENT',
    }),
    true,
  );
  assert.equal(
    sandboxNeverStarted({ exitCode: 1, stdout: tap, stderr: 'The test command did not start in the sandbox: x' }),
    false,
  );
  assert.equal(sandboxNeverStarted({ exitCode: 0, stdout: '', stderr: 'The sandbox runtime did not start: x' }), false);
});
