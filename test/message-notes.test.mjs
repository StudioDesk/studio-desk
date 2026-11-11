// A director's note on a busy or finished story (team chat, November 2026): a message naming the story's builder
// while the story cannot act on it is kept as a note waiting for an attempt. The story's next attempt receives every
// waiting note after its own direction, in Send back's words, within the direction limit, and each note records that
// attempt in the transaction that records it. The story's own direction never changes. A note waits until an attempt
// that received it hands back a result: one whose receiving attempt ended without a result (cut off and reconciled,
// cancelled or stopped) waits again for the next attempt, which it then records, one whose receiving attempt is live
// never waits, and a start the studio refuses leaves them waiting. Model-free: attempts are claimed by the controller
// (Runner.claimAttempt) and no process or model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup as studio } from './studio-setup.mjs';
import { projectOrganization } from '../src/core/project-organization.mjs';
import { directionWithNotes, messageLimits } from '../src/core/messages.mjs';

const projectId = 'project-legacy',
  post = (c, taskId, text) =>
    c.request(`/api/projects/${projectId}/messages`, { projectId, channel: { type: 'task', id: taskId }, text }),
  assignmentLayer = attempt => JSON.parse(attempt.instructions.layers.find(layer => layer.title === 'Assignment').text);

// A studio with general stories of one builder, no prerequisites and room for every attempt the tests record.
async function stories(t) {
  const c = await studio(t),
    store = c.app.store,
    runner = c.app.runner,
    builder = projectOrganization(store, projectId).workers.find(worker => worker.enabled);
  const org = store.organization();
  org.maxParallel = 20;
  store.setOrganization(org);
  // A story whose attempt is running now (or stopped, with no attempt running), not queued, so nothing starts it.
  const seed = (name, { direction = '', resources = [], running = true } = {}) => {
    const taskId = `T-${name}`,
      attemptId = `attempt-${name}-first`;
    store.putTask({
      id: taskId,
      projectId,
      kind: 'general',
      title: `The ${name}`,
      brief: 'Bounded model-free work.',
      workerId: builder.id,
      team: builder.team,
      teamId: builder.teamId,
      status: running ? 'running' : 'failed',
      direction,
      reason: '',
      hold: false,
      queued: false,
      dependencies: [],
      resources,
      maxAttempts: 10,
      createdAt: new Date().toISOString(),
      lastAttemptId: attemptId,
    });
    store.insertAttempt(
      {
        id: attemptId,
        taskId,
        projectId,
        workerId: builder.id,
        status: running ? 'running' : 'failed',
        artifacts: [],
      },
      { text: 'Fixture', hash: 'fixture' },
    );
    return taskId;
  };
  // The story's live attempts stop, their resources are released, and the story waits for a new start.
  const stop = taskId => {
    for (const attempt of store.attempts(taskId).filter(a => ['running', 'stopping'].includes(a.status))) {
      store.updateAttempt({ ...attempt, status: 'failed', finishedAt: new Date().toISOString() });
      store.release(attempt.id);
    }
    const task = store.task(taskId);
    task.status = 'failed';
    store.putTask(task);
  };
  // The story's running attempt hands back a result and the director sends it back: the attempt records the result,
  // its resources are released, and the story is ready for its next attempt.
  const handBack = taskId => {
    for (const attempt of store.attempts(taskId).filter(a => a.status === 'running')) {
      store.updateAttempt({
        ...attempt,
        status: 'revision_requested',
        result: { taskId, outcome: 'completed', summary: 'Done.', artifacts: [], checks: [], issues: [], handoff: '' },
        finishedAt: new Date().toISOString(),
      });
      store.release(attempt.id);
    }
    const task = store.task(taskId);
    task.status = 'ready';
    store.putTask(task);
  };
  const note = async (taskId, words) => {
    const posted = await post(c, taskId, `@${builder.displayName} ${words}`);
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.deepEqual(posted.data.outcome, { type: 'note', taskId, receivedBy: null });
    return posted.data;
  };
  const claim = taskId => runner.claimAttempt(taskId, { director: true }).a.id;
  return { c, store, runner, builder, seed, stop, handBack, note, claim };
}

test("a note kept while a story runs reaches its next attempt after the story's direction, and records it", async t => {
  const { store, seed, stop, handBack, note, claim } = await stories(t),
    direction = 'Keep the fixture small.',
    taskId = seed('busy', { direction }),
    kept = await note(taskId, 'please also check the empty case');
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: null });
  stop(taskId);
  const attemptId = claim(taskId),
    attempt = store.attempt(attemptId),
    expected = `${direction}\n\nDirector's note: ${kept.text}`;
  assert.equal(attempt.assignment.direction, expected);
  assert.equal(assignmentLayer(attempt).direction, expected);
  assert.ok(attempt.instructions.text.includes(JSON.stringify(expected)), 'The compiled text carries the note.');
  assert.equal(store.task(taskId).direction, direction, "The story's own direction is unchanged.");
  assert.equal(store.task(taskId).status, 'running');
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: attemptId });
  assert.deepEqual(store.waitingNotes(projectId, taskId), []);

  // The attempt handed back a result, so the attempt after it does not receive the note again.
  handBack(taskId);
  assert.deepEqual(store.waitingNotes(projectId, taskId), []);
  const nextId = claim(taskId),
    next = store.attempt(nextId);
  assert.notEqual(nextId, attemptId);
  assert.equal(next.assignment.direction, direction);
  assert.equal(assignmentLayer(next).direction, direction);
  assert.ok(!next.instructions.text.includes('please also check the empty case'));
  assert.ok(!next.instructions.text.includes("Director's note:"));
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: attemptId });
});

test('a note whose attempt is cut off by a restart waits while it is unreconciled, then reaches the next attempt once', async t => {
  const { store, runner, seed, stop, note, claim } = await stories(t),
    direction = 'Keep the fixture small.',
    resource = 'note-cut-off-resource',
    taskId = seed('cut-off', { direction, resources: [resource] }),
    kept = await note(taskId, 'check the restart case too'),
    expected = `${direction}

Director's note: ${kept.text}`;
  stop(taskId);
  const firstId = claim(taskId);
  assert.equal(store.attempt(firstId).assignment.direction, expected);
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: firstId });
  // While the receiving attempt runs, the note does not wait, so no second attempt can receive it.
  assert.equal(store.attempt(firstId).status, 'running');
  assert.deepEqual(store.waitingNotes(projectId, taskId), []);

  // A controller restart leaves the attempt interrupted, unreconciled, with its reservation held.
  const cut = store.attempt(firstId);
  store.updateAttempt({ ...cut, status: 'interrupted', finishedAt: new Date().toISOString() });
  const task = store.task(taskId);
  task.status = 'blocked';
  task.reason = 'Controller restarted. Reconcile the previous attempt before retrying.';
  store.putTask(task);
  assert.ok(store.leases().some(lease => lease.attemptId === firstId && lease.resource === resource));
  assert.deepEqual(store.waitingNotes(projectId, taskId), [], 'An unreconciled attempt may still hold the note.');

  runner.reconcile(taskId);
  assert.ok(store.attempt(firstId).reconciledAt);
  assert.ok(!store.attempt(firstId).result);
  assert.ok(!store.leases().some(lease => lease.attemptId === firstId));
  assert.equal(store.task(taskId).status, 'ready');
  assert.deepEqual(
    store.waitingNotes(projectId, taskId).map(message => message.id),
    [kept.id],
  );

  const nextId = claim(taskId),
    next = store.attempt(nextId);
  assert.notEqual(nextId, firstId);
  assert.equal(next.assignment.direction, expected);
  assert.equal(assignmentLayer(next).direction, expected);
  assert.ok(next.instructions.text.includes(JSON.stringify(expected)), 'The compiled text carries the note.');
  assert.equal(next.assignment.direction.split("Director's note:").length, 2, 'The note is delivered once.');
  assert.equal(store.task(taskId).direction, direction, "The story's own direction is unchanged.");
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: nextId });
  assert.deepEqual(store.waitingNotes(projectId, taskId), []);
});

test('a note whose attempt is cancelled with no result reaches the next attempt, which it then records', async t => {
  const { store, seed, stop, note, claim } = await stories(t),
    direction = 'Own direction.',
    taskId = seed('cancelled', { direction }),
    kept = await note(taskId, 'keep the old name'),
    expected = `${direction}

Director's note: ${kept.text}`;
  stop(taskId);
  const firstId = claim(taskId);
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: firstId });
  // Stopped before it handed anything back: the attempt ends failed with no result.
  stop(taskId);
  assert.equal(store.attempt(firstId).status, 'failed');
  assert.ok(!store.attempt(firstId).result);
  const nextId = claim(taskId);
  assert.notEqual(nextId, firstId);
  assert.equal(store.attempt(nextId).assignment.direction, expected);
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: nextId });
  assert.equal(store.task(taskId).direction, direction);
});

test('two notes reach one attempt in the order they were written, and both record it', async t => {
  const { store, seed, stop, note, claim } = await stories(t),
    taskId = seed('ordered'),
    first = await note(taskId, 'first: rename the step'),
    second = await note(taskId, 'second: then add the check');
  stop(taskId);
  const attemptId = claim(taskId),
    { direction } = store.attempt(attemptId).assignment;
  // The story had no direction of its own, so the notes are all of it.
  assert.equal(direction, `Director's note: ${first.text}\n\nDirector's note: ${second.text}`);
  assert.ok(direction.indexOf(first.text) < direction.indexOf(second.text));
  for (const kept of [first, second])
    assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: attemptId });
  assert.equal(store.task(taskId).direction, '');
});

test("a start refused for the studio's limit or a held resource delivers nothing, and the next start does", async t => {
  const { store, seed, stop, note, claim } = await stories(t),
    direction = 'Own direction.',
    resource = 'note-fixture-resource',
    taskId = seed('refused', { direction, resources: [resource] }),
    kept = await note(taskId, 'wait for your turn'),
    waiting = () => assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: null }),
    attempts = () => store.attempts(taskId).length;
  stop(taskId);
  // As many live attempts as the studio's limit: another story's attempt holds the last slot.
  const other = seed('slot-holder');
  const org = store.organization();
  org.maxParallel = store.liveAttempts().length;
  store.setOrganization(org);
  const before = attempts();
  assert.throws(() => claim(taskId), /Studio concurrency limit reached\./);
  assert.equal(attempts(), before);
  waiting();
  assert.equal(store.task(taskId).direction, direction);
  assert.equal(store.task(taskId).status, 'blocked');
  // A resource of the story held by another owner refuses the start the same way.
  stop(other);
  store.claim([resource], 'held-by-another-story');
  assert.throws(
    () => claim(taskId),
    error => error.wait === true && error.conflict?.resource === resource,
  );
  assert.equal(attempts(), before);
  waiting();
  assert.equal(store.task(taskId).direction, direction);
  assert.equal(store.task(taskId).status, 'blocked');
  // Once the resource is free, the next start delivers the note.
  store.release('held-by-another-story');
  const attemptId = claim(taskId);
  assert.equal(store.attempt(attemptId).assignment.direction, `${direction}\n\nDirector's note: ${kept.text}`);
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: attemptId });
  assert.equal(store.task(taskId).direction, direction);
});

test("a note on one story's thread never reaches another story's attempt", async t => {
  const { store, seed, note, claim } = await stories(t),
    noted = seed('noted'),
    kept = await note(noted, 'only for this story'),
    otherDirection = 'The other story.',
    other = seed('other', { direction: otherDirection, running: false });
  const attemptId = claim(other),
    attempt = store.attempt(attemptId);
  assert.equal(attempt.assignment.direction, otherDirection);
  assert.ok(!attempt.instructions.text.includes('only for this story'));
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId: noted, receivedBy: null });
  assert.deepEqual(
    store.waitingNotes(projectId, noted).map(message => message.id),
    [kept.id],
  );
});

test('a longest note on a direction near its limit keeps the direction first and stays within 24000 characters', async t => {
  const { store, builder, seed, stop, note, claim } = await stories(t),
    direction = 'D'.repeat(23990),
    taskId = seed('long', { direction }),
    words = 'N'.repeat(messageLimits.textMax - builder.displayName.length - 2),
    kept = await note(taskId, words);
  assert.equal(kept.text.length, messageLimits.textMax);
  stop(taskId);
  const attemptId = claim(taskId),
    delivered = store.attempt(attemptId).assignment.direction;
  assert.equal(delivered.length, 24000);
  assert.ok(delivered.startsWith(direction));
  assert.ok(delivered.endsWith('…'));
  assert.equal(delivered, `${direction}\n\nDirector's note: ${kept.text}`.slice(0, 23999) + '…');
  assert.equal(store.task(taskId).direction, direction);
  assert.deepEqual(store.message(kept.id).outcome, { type: 'note', taskId, receivedBy: attemptId });
});

test("the direction helper keeps a direction without notes and gives one note alone in Send back's words", () => {
  assert.equal(directionWithNotes('As it was.', []), 'As it was.');
  assert.equal(directionWithNotes('As it was.'), 'As it was.');
  assert.equal(directionWithNotes('', []), '');
  assert.equal(directionWithNotes('', [{ text: 'Look again.' }]), "Director's note: Look again.");
  assert.equal(
    directionWithNotes('First.', [{ text: 'One.' }, { text: 'Two.' }]),
    "First.\n\nDirector's note: One.\n\nDirector's note: Two.",
  );
  const long = directionWithNotes('x'.repeat(24000), [{ text: 'y' }]);
  assert.equal(long.length, 24000);
  assert.ok(long.startsWith('x'.repeat(23999)) && long.endsWith('…'));
});
