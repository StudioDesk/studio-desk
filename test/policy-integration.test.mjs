// The autonomy policy integrates a story after a passing review (MP-023, October 21, 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { approveWork } from '../src/core/proposals.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { autonomyPolicy, kindMode, saveAutonomyPolicy } from '../src/core/autonomy.mjs';
import { integrateSource, sourceStoryIntegrable } from '../src/connectors/source-changes.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';

const tests = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url));

// The story's edit acceptance stays with the director here, because a fixture candidate must be
// marked measured before its review may start; the policy accepts the review itself.
const policyFor =
  c =>
  (integrate, kind = 'studio-development:change', review = 'auto') =>
    saveAutonomyPolicy(c.app.store, c.app.runner.registries, 'project-legacy', {
      expectedRevision: autonomyPolicy(c.app.store, 'project-legacy').revision,
      enabled: true,
      retries: 0,
      kinds: {
        [kind]: { approve: 'director', accept: 'director', ...(integrate ? { integrate } : {}) },
        'studio-development:change-review': { approve: 'auto', accept: review },
      },
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
    });
async function until(check, label) {
  return waitFor(check, label);
}
const reviewOf = (store, id) =>
  store.attempts(id).find(attempt => attempt.assignment.kind === 'studio-development:change-review');
// The director accepts the story's measured edit; its independent review then runs.
async function acceptEdit(c, id) {
  const store = c.app.store,
    edit = await c.wait(id);
  c.measuredFixture(edit);
  acceptAttempt(store, c.app.runner.registries, store.task(id));
  c.app.runner.autonomy.accepted(id);
  return edit;
}
// Waits until the story's review is accepted and any integration of it has settled.
const settledReview = (c, id) =>
  until(() => {
    const story = c.app.store.task(id),
      review = reviewOf(c.app.store, id);
    return (
      story.status === 'done' &&
      review?.status === 'accepted' &&
      !c.app.runner.sourceIntegrationRun &&
      !c.app.runner.autonomy.pendingIntegration() &&
      !['verifying', 'committing'].includes(review.sourceIntegration?.state) &&
      c.app.store.attempt(review.id)
    );
  }, `the review of ${id} to settle`);

test('with integration after a passing review automatic, the policy integrates each linked story and the next starts from its commit (MP-023)', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { runner } = c.app,
    { ids } = await c.breakdown(),
    saved = policyFor(c)('auto');
  assert.equal(saved.kinds['studio-development:change'].integrate, 'auto');
  assert.match(store.events().at(-1).message, /Work set to integrate after a passing review integrates without/);
  const base = git(c.root, ['rev-parse', 'HEAD']);
  // The director approves the linked stories once; nothing else comes back to the director.
  for (const id of ids) {
    approveWork(store, runner.registries, store.task(id));
    runner.queueStart(id);
  }
  const commits = [];
  for (const id of ids) {
    const edit = await acceptEdit(c, id);
    assert.equal(edit.sourceWorktree.baseCommit, commits.at(-1) || base, 'Each story starts from the last commit.');
    const review = await settledReview(c, id),
      journal = review.sourceIntegration;
    assert.equal(journal?.state, 'integrated', JSON.stringify(journal));
    assert.deepEqual(review.acceptedBy.type, 'policy');
    assert.deepEqual(journal.approvedBy, {
      type: 'policy',
      revision: saved.revision,
      reason: `Integrate after a passing review: independent review ${review.id} passed`,
    });
    const story = store.task(id);
    assert.equal(story.sourceStage.current, 'integrated');
    assert.equal(story.autonomyNote, undefined);
    assert.equal(git(c.root, ['rev-parse', 'HEAD']), journal.repository.commit);
    assert.match(
      git(c.root, ['log', '-1', '--format=%B']),
      new RegExp(
        `Integrated by Studio desk after a passing review, approved by autonomy policy revision ${saved.revision}\\.\\n[^]*Candidate review: ${id} \\(${review.id}\\), verdict pass`,
      ),
    );
    const said = kind => store.events().filter(event => event.kind === kind && event.task_id === id);
    assert.deepEqual(
      said('integration_requested').map(event => event.message),
      [
        `Autonomy policy revision ${saved.revision} approved integration (Integrate after a passing review: independent review ${review.id} passed). The controller integrates as soon as the source is free; other work continues.`,
      ],
    );
    assert.match(
      said('source_verifying')[0].message,
      new RegExp(
        `^Integration approved by autonomy policy revision ${saved.revision} after the independent review passed\\.`,
      ),
    );
    commits.push(journal.repository.commit);
  }
  assert.equal(git(c.root, ['rev-parse', 'HEAD~2']), base);
  assert.deepEqual(
    store.events().filter(event => event.kind === 'autonomy_attention' && ids.includes(event.task_id)),
    [],
  );
});

test('the director stays the fallback: the policy waits when set to, never acts on a review that requested changes, and does not retry a failed integration (MP-023)', async t => {
  // Only a task type with an integration step has the mode; policies without it ask the director.
  const waiting = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    policy = policyFor(waiting);
  assert.throws(() => policy('auto', 'studio-development:checks'), /Unsupported autonomy mode fields/);
  assert.throws(() => policy('sometimes'), /Autonomy modes must be director or auto/);
  assert.equal(policy(undefined).kinds['studio-development:change'].integrate, 'director');
  assert.equal(kindMode({ enabled: false }, 'studio-development:change').integrate, 'director');
  // As the live policy was saved before the mode: file requests automatic, integration not named.
  assert.equal(
    kindMode(
      { enabled: true, kinds: { 'studio-development:change': { approve: 'director', accept: 'auto', scope: 'auto' } } },
      'studio-development:change',
    ).integrate,
    'director',
  );
  waiting.app.runner.start(waiting.taskId);
  await acceptEdit(waiting, waiting.taskId);
  const waited = await settledReview(waiting, waiting.taskId);
  assert.equal(waited.acceptedBy.type, 'policy');
  assert.equal(waited.sourceIntegration, undefined);
  assert.equal(waiting.app.store.task(waiting.taskId).sourceStage.current, 'waiting-for-integration');
  assert.ok(!waiting.app.store.events().some(event => event.kind === 'integration_requested'));

  // A review that requested changes is never integrated by the policy, even when the director accepts it.
  const rejected = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = rejected.app.store,
    { runner } = rejected.app,
    automatic = policyFor(rejected)('auto', undefined, 'director');
  runner.start(rejected.taskId);
  const negative = await rejected.review(await rejected.wait(rejected.taskId), 'negative-review');
  await rejected.accept(rejected.taskId);
  assert.equal(store.task(rejected.taskId).sourceStage.current, 'failed');
  assert.equal(sourceStoryIntegrable(store, store.task(rejected.taskId)), null);
  assert.equal(store.attempt(negative.id).sourceIntegration, undefined);
  assert.equal(runner.autonomy.pendingIntegration(), null);
  // Integrating over a review stays the director's (MP-019).
  const by = { type: 'policy', revision: automatic.revision, reason: 'Fixture.' },
    reviewHash = negative.artifacts[0].hash,
    override = { reason: 'Integrate anyway.' };
  assert.throws(
    () => runner.autonomy.requestIntegration(store.task(rejected.taskId), negative.id, reviewHash, { by, override }),
    /Only the director integrates over a review/,
  );
  assert.throws(
    () => integrateSource(runner, store.task(rejected.taskId), negative.id, reviewHash, undefined, { by, override }),
    /Only the director, or the autonomy policy after a passing review, approves integration/,
  );
  assert.equal(store.attempt(negative.id).sourceIntegration, undefined);

  // Verification that fails brings the story to the director, and the policy does not try again.
  const failing = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    failingStore = failing.app.store,
    failingRunner = failing.app.runner,
    revision = policyFor(failing)('auto').revision,
    head = git(failing.root, ['rev-parse', 'HEAD']);
  failingRunner.start(failing.taskId);
  const command = failingRunner.sourceCheckCommand;
  await acceptEdit(failing, failing.taskId);
  failingRunner.sourceCheckCommand = { executable: process.execPath, args: [tests, 'fail'] };
  const review = await settledReview(failing, failing.taskId),
    journal = review.sourceIntegration;
  assert.equal(journal.state, 'rejected', JSON.stringify(journal));
  assert.equal(journal.approvedBy.type, 'policy');
  assert.equal(git(failing.root, ['rev-parse', 'HEAD']), head);
  let story = failingStore.task(failing.taskId);
  assert.equal(story.sourceStage.current, 'failed');
  assert.match(story.autonomyNote, /^Integration did not complete\. 0\/1 tests passed on the formatted change\./);
  failingRunner.autonomy.accepted(failing.taskId);
  assert.equal(sourceStoryIntegrable(failingStore, story), null);
  assert.equal(failingRunner.autonomy.pendingIntegration(), null);
  assert.equal(failingStore.attempt(review.id).sourceIntegration.state, 'rejected');
  // The director approves again; that integration is recorded as the director's.
  failingRunner.sourceCheckCommand = command;
  failingRunner.autonomy.requestIntegration(story, review.id, review.artifacts[0].hash);
  assert.equal(failingStore.task(failing.taskId).autonomyNote, undefined);
  assert.equal(failingStore.task(failing.taskId).reason, '');
  assert.equal(failingStore.task(failing.taskId).sourceStage.reason, '');
  const integrated = await failing.settled(review);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  assert.deepEqual(integrated.approvedBy, { type: 'director' });
  assert.equal(integrated.previous.state, 'rejected');
  assert.match(
    git(failing.root, ['log', '-1', '--format=%B']),
    /\n\nIntegrated by Studio desk after director approval\.\n/,
  );
  story = failingStore.task(failing.taskId);
  assert.equal(story.sourceStage.current, 'integrated');
  assert.equal(story.autonomyNote, undefined);
  assert.equal(story.reason, '');
  assert.equal(story.sourceStage.reason, '');
  assert.match(integrated.previous.error, /0\/1 tests passed/);
  assert.ok(
    failingStore
      .events()
      .some(
        event => event.kind === 'integration_requested' && event.message.startsWith('Director approved integration.'),
      ),
  );
  assert.ok(revision > 0);
});
