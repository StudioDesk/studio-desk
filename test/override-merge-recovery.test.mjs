// A merge the director approved over a review that requested changes (MP-019) and that a restart cut off part-way is
// reconciled like any other: Reconcile source integration checks it with the reason its journal recorded, settles it
// from git history and releases the repository it held. Until then the story is not sent back, so its journal and the
// repository's lease are never left behind by a rewound story.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import {
  interruptedSourceIntegrations,
  sourceIntegrationResources,
  sourceStoryReturnable,
} from '../src/connectors/source-changes.mjs';

const reason = 'The finding is a case this repository never uses.',
  findings =
    'The independent review requested changes. Address these findings:\n- Model-free candidate review fixture.\n- Fixture requests more work.';

// A story whose review requested changes, integrated over it with the director's reason, then left part-way as a
// restart leaves it: needs-reconciliation, interrupted in `interrupted`, its repository leases held.
async function overrideMergeCutOff(t, interrupted) {
  const c = await setup(t);
  await c.start();
  const negative = await c.review(await c.wait(c.taskId), 'negative-review');
  await c.accept(c.taskId);
  assert.equal(c.app.store.task(c.taskId).sourceStage.current, 'failed');
  const head = git(c.root, ['rev-parse', 'HEAD']),
    approved = await c.request(`/api/tasks/${c.taskId}/integrate-source`, {
      attemptId: negative.id,
      reviewHash: c.app.store.attempt(negative.id).artifacts[0].hash,
      overrideReason: reason,
    });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const integrated = await c.settled(negative);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  assert.equal(integrated.reviewOverride.reason, reason);
  // Shaped as the merge was when the controller stopped: in verification the development copy had not moved; while
  // committing it had reached the integration commit.
  const { finishedAt, commit, ...journal } = integrated,
    store = c.app.store,
    attempt = store.attempt(negative.id);
  if (interrupted === 'verifying') git(c.root, ['reset', '--quiet', '--hard', head]);
  attempt.sourceIntegration = {
    ...journal,
    ...(interrupted === 'verifying' ? {} : { commit }),
    state: interrupted,
    repository: { branch: integrated.repository.branch, head },
  };
  const story = store.task(c.taskId);
  Object.assign(story.sourceStage, {
    phase: 'integration',
    current: 'waiting-for-integration',
    integration: { attemptId: negative.id, id: journal.id, state: 'verifying' },
  });
  store.tx(() => {
    store.claim(sourceIntegrationResources, journal.id);
    store.updateAttempt(attempt);
    store.putTask(story);
  });
  // What the controller does for such journals when it starts again.
  interruptedSourceIntegrations(c.app.runner);
  assert.deepEqual(
    [
      c.app.store.attempt(negative.id).sourceIntegration.state,
      c.app.store.attempt(negative.id).sourceIntegration.interrupted,
    ],
    ['needs-reconciliation', interrupted],
  );
  assert.equal(c.app.store.leases().length, 2);
  return { c, negative, head, integrated };
}

// Before Reconcile, Send back is refused and changes nothing; the journal keeps the repository.
async function sendBackRefused(c, negative) {
  const store = c.app.store,
    before = store.task(c.taskId);
  assert.equal(sourceStoryReturnable(store, before), null);
  const refused = await c.request(`/api/tasks/${c.taskId}/send-back`, { note: 'Try again.' });
  assert.ok([400, 409].includes(refused.status), JSON.stringify(refused.data));
  assert.match(refused.data.error, /Only accepted work whose later stage requested changes/);
  const after = store.task(c.taskId);
  assert.deepEqual(
    [after.status, after.sourceStage, after.direction],
    [before.status, before.sourceStage, before.direction],
  );
  assert.equal(store.attempt(negative.id).sourceIntegration.state, 'needs-reconciliation');
  assert.equal(store.leases().length, 2);
}

// Another story in the same repository, on another of its files, then integrates: nothing holds the repository now.
async function anotherStoryIntegrates(c) {
  const id = await c.propose('another', { files: ['src/core/projects.mjs'] }),
    started = await c.request(`/api/tasks/${id}/start`);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const { review } = await c.toReview(id);
  const integration = await c.integration(review);
  assert.equal(integration.status, 200, JSON.stringify(integration.data));
  assert.equal((await c.settled(review)).state, 'integrated');
  assert.equal(c.app.store.leases().length, 0);
}

test('an override merge cut off in verification is reconciled as abandoned, and only then sent back', async t => {
  const { c, negative, head } = await overrideMergeCutOff(t, 'verifying');
  await sendBackRefused(c, negative);
  const reconciled = await c.request(`/api/tasks/${c.taskId}/restore-source`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'abandoned');
  assert.equal(reconciled.data.reviewOverride.reason, reason, 'The override stays recorded on its journal.');
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
  assert.equal(c.app.store.leases().length, 0);
  await anotherStoryIntegrates(c);
  // The reconciled story goes back with its review's findings, as a review that requested changes does.
  const sent = await c.request(`/api/tasks/${c.taskId}/send-back`, { note: 'Keep the import order.' });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  assert.equal(sent.data.direction, `${findings}\n\nDirector's note: Keep the import order.`);
  assert.equal(c.app.store.task(c.taskId).direction, sent.data.direction);
});

test('an override merge cut off after it reached the branch is reconciled as integrated and stays merged', async t => {
  const { c, negative, integrated } = await overrideMergeCutOff(t, 'committing');
  await sendBackRefused(c, negative);
  const reconciled = await c.request(`/api/tasks/${c.taskId}/restore-source`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'integrated');
  assert.equal(reconciled.data.repository.commit, integrated.commit);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), integrated.commit);
  assert.equal(c.app.store.task(c.taskId).sourceStage.current, 'integrated');
  assert.equal(c.app.store.leases().length, 0);
  // A merged story is not sent back.
  assert.equal(sourceStoryReturnable(c.app.store, c.app.store.task(c.taskId)), null);
  await anotherStoryIntegrates(c);
});

test('a journal that recorded no override is still refused for a review that requested changes', async t => {
  const c = await setup(t);
  await c.start();
  const negative = await c.review(await c.wait(c.taskId), 'negative-review');
  await c.accept(c.taskId);
  const store = c.app.store,
    attempt = store.attempt(negative.id);
  attempt.sourceIntegration = {
    id: 'source-integration:' + negative.id,
    method: 'merge',
    state: 'needs-reconciliation',
    root: c.app.runner.sourceChangeRoot,
    reviewHash: attempt.artifacts[0].hash,
    changes: [],
  };
  store.tx(() => {
    store.claim(sourceIntegrationResources, attempt.sourceIntegration.id);
    store.updateAttempt(attempt);
  });
  const reconciled = await c.request(`/api/tasks/${c.taskId}/restore-source`);
  assert.equal(reconciled.status, 400);
  assert.match(reconciled.data.error, /exact accepted passing current candidate review/);
  assert.equal(store.attempt(negative.id).sourceIntegration.state, 'needs-reconciliation');
  assert.equal(store.leases().length, 2);
});
