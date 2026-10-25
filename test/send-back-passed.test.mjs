// The director sends a story back over its passing review (the canvas's Send back to Eli beside Integrate, the
// director's yes on October 23): the note is the next attempt's only direction, and an integration approved
// first, by the director or the policy, always wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyPolicy, saveAutonomyPolicy } from '../src/core/autonomy.mjs';
import { studioDeskSourceResources } from '../src/connectors/source-projects.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setup } from './source-story-setup.mjs';

// A story whose edit and independent review are accepted, the review passing: ready to integrate.
async function passed(t) {
  const c = await setup(t),
    store = c.app.store;
  await c.start();
  const { edit, review } = await c.toReview(c.taskId),
    story = store.task(c.taskId);
  assert.equal(story.status, 'done');
  assert.equal(story.sourceStage.current, 'waiting-for-integration');
  assert.equal(story.sourceStage.review.verdict, 'pass');
  // What must never move while the director and the policy decide: the repository, the candidate's own commit
  // and its recorded changes.
  const before = () => ({
    head: git(c.root, ['rev-parse', 'HEAD']),
    status: git(c.root, ['status', '--porcelain']),
    candidate: store.attempt(edit.id).sourceCandidate,
    artifacts: store.attempt(edit.id).artifacts,
    journal: store.attempt(review.id).sourceIntegration ?? null,
  });
  return { c, store, edit, review, before };
}
const sendBack = (c, note) => c.request(`/api/tasks/${c.taskId}/send-back`, note === undefined ? {} : { note });
const enable = (c, integrate) =>
  saveAutonomyPolicy(c.app.store, c.app.runner.registries, 'project-legacy', {
    expectedRevision: autonomyPolicy(c.app.store, 'project-legacy').revision,
    enabled: true,
    retries: 0,
    kinds: {
      'studio-development:change': { approve: 'director', accept: 'director', integrate },
      'studio-development:change-review': { approve: 'auto', accept: 'director' },
    },
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });

test('the director sends a story back over its passing review, and the note is the next direction', async t => {
  const { c, store, edit, review, before } = await passed(t),
    kept = before();
  // A passed story is not opened to a file edit; it goes back through Send back alone.
  const edited = await c.request(`/api/tasks/${c.taskId}/edit-scope`, {
    files: [...edit.sourceChange.allowedFiles, 'docs/module-contracts.md'],
    reason: 'Add the contract.',
  });
  assert.equal(edited.status, 400, JSON.stringify(edited.data));
  assert.match(edited.data.error, /Edit a story while its implementation is stopped, or after its independent review/);
  assert.equal(store.task(c.taskId).scopeEdits, undefined);
  // A pass has no findings by definition, and this one noted nothing, so the director says what to change.
  const bare = await sendBack(c);
  assert.equal(bare.status, 400);
  assert.match(bare.data.error, /^Say what to change: the review passed/);
  assert.equal(store.task(c.taskId).status, 'done');
  const sent = await sendBack(c, 'Name the setting in plain words, not its key.');
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  // Back to implementation, and started again.
  const story = store.task(c.taskId);
  assert.notEqual(story.status, 'done');
  assert.equal(story.sourceStage.phase, 'implementing');
  assert.equal(
    story.direction,
    `Independent review ${review.id} passed, and the director sent the change back for another attempt.\n- Model-free candidate review fixture.\n\nDirector's note: Name the setting in plain words, not its key.`,
  );
  assert.equal(
    store.events().find(event => event.kind === 'sent_back').message,
    'Director sent this work back for another attempt over a passing review. Note: Name the setting in plain words, not its key.',
  );
  assert.deepEqual(before(), kept, 'Sending back changes no source, commit or recorded change.');
  // Sent back once, the story is no longer waiting on a review it could integrate or send back.
  assert.equal((await sendBack(c, 'Again.')).status, 400);
  // The next attempt runs with the note.
  const next = await c.wait(c.taskId);
  assert.match(next.assignment.direction, /Director's note: Name the setting in plain words, not its key\./);
});

test("a passing review's notes go back with the story, so the director's note is optional", async t => {
  const c = await setup(t),
    store = c.app.store;
  await c.start();
  const first = await c.wait(c.taskId),
    review = await c.review(first, 'pass-with-notes');
  await c.accept(c.taskId);
  assert.equal(store.task(c.taskId).sourceStage.current, 'waiting-for-integration');
  const sent = await sendBack(c);
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  assert.equal(
    store.task(c.taskId).direction,
    `Independent review ${review.id} passed, and the director sent the change back for another attempt.\n- Model-free candidate review fixture.\nIts notes, which did not block it:\n- Fixture note: a case this repository does not use.`,
  );
  // The next attempt has them in its direction, and the whole review in its history.
  const next = await c.wait(c.taskId);
  assert.match(next.assignment.direction, /Fixture note: a case this repository does not use\./);
});

test('an integration approved first refuses the send-back, and the story is exactly as it was', async t => {
  const { c, store, review, before } = await passed(t);
  enable(c, 'director');
  // The integration waits for its source, which another story holds.
  store.claim([...studioDeskSourceResources], 'held-by-another-story');
  const waiting = c.app.runner.autonomy.requestIntegration(store.task(c.taskId), review.id, review.artifacts[0].hash, {
    by: { type: 'policy', revision: 1, reason: 'Integrate after a passing review: independent review passed' },
  });
  assert.equal(waiting.state, 'waiting');
  assert.equal(c.app.runner.autonomy.pendingIntegration().taskId, c.taskId);
  const kept = { story: store.task(c.taskId), ...before() };
  const refused = await sendBack(c, 'Rename it.');
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(
    refused.data.error,
    'Integration is approved for this work and waiting to run; it cannot be sent back now.',
  );
  assert.deepEqual({ story: store.task(c.taskId), ...before() }, kept);
  assert.equal(c.app.runner.autonomy.pendingIntegration().taskId, c.taskId);
  assert.ok(!store.events().some(event => event.kind === 'sent_back'));
  // Not under way either: a recorded integration in progress is not something to send back.
  store.putSetting('autonomy-integration', null);
  const attempt = store.attempt(review.id);
  attempt.sourceIntegration = { id: 'source-integration:' + review.id, method: 'merge', state: 'verifying' };
  store.updateAttempt(attempt);
  assert.equal((await sendBack(c, 'Rename it.')).status, 400);
  assert.equal(store.task(c.taskId).status, 'done');
  store.release('held-by-another-story');
});

test('a send-back that lands before the policy approves leaves the policy nothing to integrate', async t => {
  const { c, store, review, before } = await passed(t),
    { runner } = c.app;
  enable(c, 'director');
  assert.equal((await c.request('/api/control', { paused: true })).status, 200);
  assert.equal((await sendBack(c, 'Rename it.')).status, 202);
  const kept = { story: store.task(c.taskId), ...before() };
  // The policy's approval arrives after: it finds nothing ready, and asked directly, the integration refuses the
  // story without touching it.
  const policy = enable(c, 'auto');
  runner.autonomy.integrateAccepted(store.task(c.taskId), policy);
  assert.equal(runner.autonomy.pendingIntegration(), null);
  assert.throws(
    () =>
      runner.autonomy.requestIntegration(store.task(c.taskId), review.id, review.artifacts[0].hash, {
        by: { type: 'policy', revision: policy.revision, reason: 'late' },
      }),
    /Select the exact accepted passing current candidate review for integration/,
  );
  assert.equal(runner.autonomy.pendingIntegration(), null);
  assert.deepEqual({ story: store.task(c.taskId), ...before() }, kept);
  assert.ok(!store.events().some(event => event.kind === 'integration_requested'));
});

test('a story whose integration stopped may be sent back to build it again', async t => {
  const { c, store, review } = await passed(t);
  // As a merge conflict leaves it: the integration was tried and rejected.
  const attempt = store.attempt(review.id);
  attempt.sourceIntegration = { id: 'source-integration:' + review.id, method: 'merge', state: 'rejected' };
  store.updateAttempt(attempt);
  const story = store.task(c.taskId);
  Object.assign(story.sourceStage, { phase: 'integration', current: 'failed', reason: 'Merge conflict.' });
  store.putTask(story);
  assert.equal((await c.request('/api/control', { paused: true })).status, 200);
  assert.equal((await sendBack(c, 'Rebuild it on the current main.')).status, 202);
  assert.notEqual(store.task(c.taskId).status, 'done');
  assert.equal(store.task(c.taskId).sourceStage.phase, 'implementing');
  assert.equal(store.task(c.taskId).controllerWait, true);
});
