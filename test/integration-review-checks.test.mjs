// The controller's integration request counts a review's failed controller checks as the story's stage and the
// autonomy policy do: without the director's reason it refuses, and with one it integrates and records which checks
// the reason covered. Model-free: the source-story fixture with its process fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';

test("integration over a passing review's failed controller check needs the director's reason, which names the check", async t => {
  const c = await setup(t),
    store = c.app.store;
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(c.taskId);
  assert.equal(store.attempt(review.id).candidateReviewVerdict, 'pass');
  // The review's own checks passed; the controller recorded a failed check on the stored attempt.
  const stored = store.attempt(review.id);
  assert.ok(!stored.result.checks.some(check => check.status === 'fail'));
  stored.controllerChecks = [
    ...(stored.controllerChecks || []),
    { name: 'Review output', status: 'fail', evidence: 'Fixture controller check failure.' },
  ];
  store.updateAttempt(stored);
  const integrate = data =>
      c.request(`/api/tasks/${c.taskId}/integrate-source`, {
        attemptId: review.id,
        reviewHash: store.attempt(review.id).artifacts[0].hash,
        ...data,
      }),
    head = git(c.root, ['rev-parse', 'HEAD']);

  const refused = await integrate({});
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  assert.equal(
    refused.data.error,
    'Integration requires a passing independent review whose checks passed, or your reason to integrate over it.',
  );
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head, 'The development copy is unchanged.');
  assert.equal(store.attempt(review.id).sourceIntegration, undefined);

  const reason = 'The controller check flagged a fixture-only artifact.',
    approved = await integrate({ overrideReason: reason });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.deepEqual(
    { ...approved.data.reviewOverride, at: undefined },
    { by: { type: 'director' }, verdict: 'pass', checks: ['Review output'], reason, at: undefined },
  );
  const journal = await c.settled(review);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal));
  assert.deepEqual(journal.reviewOverride.checks, ['Review output']);
  assert.equal(journal.reviewOverride.reason, reason);
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), head);
  assert.equal(store.task(c.taskId).sourceStage.current, 'integrated');
  const event = store.events().find(item => item.kind === 'source_verifying');
  assert.ok(event, 'The integration recorded its approval.');
  assert.match(
    event.message,
    /^Integration approved over the review's failed check Review output, by the director: The controller check flagged a fixture-only artifact\./,
  );
  assert.match(
    git(c.root, ['log', '-1', '--format=%B']),
    new RegExp(
      `Candidate review: ${c.taskId} \\(${review.id}\\), verdict pass, failed checks: Review output; integrated over it by the director: The controller check flagged a fixture-only artifact\\.`,
    ),
  );
});

test("the autonomy policy's integration request never covers a review's failed controller check", async t => {
  const c = await setup(t),
    { store, runner } = c.app;
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(c.taskId);
  const stored = store.attempt(review.id);
  stored.controllerChecks = [...(stored.controllerChecks || []), { name: 'Review output', status: 'fail' }];
  store.updateAttempt(stored);
  const head = git(c.root, ['rev-parse', 'HEAD']),
    reviewHash = store.attempt(review.id).artifacts[0].hash;
  assert.throws(
    () =>
      runner.autonomy.requestIntegration(store.task(c.taskId), review.id, reviewHash, {
        by: { type: 'policy', revision: 1, reason: 'Fixture policy.' },
        override: { reason: 'Policy cannot override.' },
      }),
    /Only the director integrates over a review/,
  );
  assert.throws(
    () =>
      runner.autonomy.requestIntegration(store.task(c.taskId), review.id, reviewHash, {
        by: { type: 'policy', revision: 1, reason: 'Fixture policy.' },
      }),
    /whose checks passed, or your reason/,
  );
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
  assert.equal(store.attempt(review.id).sourceIntegration, undefined);
});
