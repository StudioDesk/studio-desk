// Integrating over a review that asked for changes (MP-019) when the change's own tests failed: the controller never
// offers it, refuses it before anything moves, with the autonomy policy on or off, and a story an earlier refusal left
// waiting for an integration that never came goes back with the review's findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { artifactPath } from '../src/core/artifacts.mjs';
import { sourceIntegrationRequested, sourceStoryReturnable } from '../src/connectors/source-changes.mjs';
import { studioDeskSourceResources } from '../src/connectors/source-projects.mjs';
import { setup } from './source-story-setup.mjs';

const project = 'project-legacy',
  findingsText = 'The independent review requested changes. Address these findings:';

// The keys of the actions the task's read serves.
const served = async (c, id) =>
  (await (await fetch(`${c.origin}/api/tasks/${id}?projectId=${project}`)).json()).actions.map(action => action.key);

// The project's autonomy policy, on: the path on which an integration request records itself and moves the story.
const enable = store =>
  store.putSetting(`project-autonomy:${project}`, {
    enabled: true,
    revision: 1,
    retries: 0,
    kinds: {
      'studio-development:change': { approve: 'director', accept: 'director' },
      'studio-development:change-review': { approve: 'director', accept: 'director' },
    },
  });

// A story whose edit and independent review are accepted, the review asking for changes; with checkMode 'fail' the
// change's own tests failed.
async function changesRequested(t, checkMode) {
  const c = await setup(t, checkMode),
    store = c.app.store;
  await c.start();
  const candidate = await c.wait(c.taskId),
    review = await c.review(candidate, 'negative-review');
  await c.accept(c.taskId);
  const story = store.task(c.taskId);
  assert.equal(story.status, 'done');
  assert.equal(story.sourceStage.current, 'failed');
  assert.equal(story.sourceStage.review.verdict, 'needs-work');
  assert.equal(store.attempt(review.id).candidateReview.passed, checkMode !== 'fail');
  const over = reason =>
    c.request(`/api/tasks/${c.taskId}/integrate-source`, {
      attemptId: review.id,
      reviewHash: store.attempt(review.id).artifacts[0].hash,
      overrideReason: reason,
    });
  const report = JSON.parse(
    fs.readFileSync(artifactPath(store, store.attempt(review.id), store.attempt(review.id).artifacts[0].path)),
  );
  return { c, store, review, over, report };
}

// Everything a refused request must leave as it was.
const recorded = async (c, review) => {
  const { store } = c.app,
    task = store.task(c.taskId);
  return {
    status: task.status,
    reason: task.reason,
    autonomyNote: task.autonomyNote,
    stage: {
      phase: task.sourceStage.phase,
      current: task.sourceStage.current,
      reason: task.sourceStage.reason,
      integration: task.sourceStage.integration,
    },
    journal: store.attempt(review.id).sourceIntegration,
    pending: store.setting('autonomy-integration') ?? null,
    paused: !!store.organization().paused,
    actions: await served(c, c.taskId),
  };
};

test('a change whose own tests failed is offered Send back and Close, never integration over its review', async t => {
  const { c, review, over } = await changesRequested(t, 'fail');
  assert.deepEqual(await served(c, c.taskId), ['send-back', 'close']);
  // With the policy off, the refusal is the one it always was.
  const refused = await over('Integrate anyway.');
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /candidate tests to pass/);
  assert.equal(c.app.store.attempt(review.id).sourceIntegration, undefined);
});

test('with the autonomy policy on, a refused integration over the review moves nothing, and Send back still works', async t => {
  const { c, store, review, over, report } = await changesRequested(t, 'fail');
  enable(store);
  const before = await recorded(c, review);
  assert.equal(before.pending, null);
  assert.deepEqual(before.actions, ['send-back', 'close']);
  const refused = await over('Integrate anyway.');
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  assert.match(refused.data.error, /candidate tests to pass/);
  assert.deepEqual(await recorded(c, review), before);
  assert.ok(!store.events().some(event => event.kind === 'integration_requested'));
  const sent = await c.request(`/api/tasks/${c.taskId}/send-back`, {});
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  assert.ok(store.task(c.taskId).direction.startsWith(`${findingsText}\n- ${report.summary}`));
});

test('a story a refused integration left waiting goes back with its review findings', async t => {
  const { c, store, review, report } = await changesRequested(t, 'fail');
  // The shape the refusal left before it was checked first: the request moved the story, then integration refused.
  sourceIntegrationRequested(c.app.runner, store.task(c.taskId));
  const stranded = store.task(c.taskId);
  assert.equal(stranded.sourceStage.phase, 'integration');
  assert.equal(stranded.sourceStage.current, 'waiting-for-integration');
  assert.equal(stranded.sourceStage.integration, undefined);
  assert.equal(store.attempt(review.id).sourceIntegration, undefined);
  assert.equal(store.setting('autonomy-integration') ?? null, null);
  const findings = [findingsText, `- ${report.summary}`, ...report.findings.map(finding => `- ${finding}`)].join('\n');
  assert.deepEqual(sourceStoryReturnable(store, stranded), { findings, passed: false, needsNote: false });
  assert.deepEqual(await served(c, c.taskId), ['send-back', 'close']);
  const first = store.task(c.taskId).lastAttemptId,
    sent = await c.request(`/api/tasks/${c.taskId}/send-back`, {});
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  const story = store.task(c.taskId);
  assert.ok(['ready', 'running'].includes(story.status), story.status);
  assert.equal(story.sourceStage.phase, 'implementing');
  assert.equal(story.direction, findings);
  assert.ok(sent.data.start.ok !== false, JSON.stringify(sent.data.start));
  const next = await c.wait(c.taskId);
  assert.notEqual(next.id, first);
  assert.equal(next.assignment.kind, 'studio-development:change');
  assert.equal(next.assignment.direction, findings);
});

test('a change whose tests passed may still be integrated over its review, and is not sent back while that waits', async t => {
  const { c, store, review, over } = await changesRequested(t, 'pass');
  assert.deepEqual(await served(c, c.taskId), ['send-back', 'over', 'close']);
  enable(store);
  // The integration waits for its source, which another story holds.
  store.claim([...studioDeskSourceResources], 'held-by-another-story');
  const waiting = await over('The finding is a case this repository never uses.');
  assert.equal(waiting.status, 200, JSON.stringify(waiting.data));
  assert.equal(waiting.data.state, 'waiting');
  assert.equal(store.setting('autonomy-integration').taskId, c.taskId);
  const story = store.task(c.taskId);
  assert.equal(story.sourceStage.phase, 'integration');
  assert.equal(story.sourceStage.current, 'waiting-for-integration');
  // Its own request waits for its turn: the same stage as a stranded story, but it is not sent back.
  assert.equal(sourceStoryReturnable(store, story), null);
  assert.ok(!(await served(c, c.taskId)).includes('send-back'));
  const refused = await c.request(`/api/tasks/${c.taskId}/send-back`, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(store.task(c.taskId).sourceStage.phase, 'integration');
  assert.equal(store.attempt(review.id).sourceIntegration, undefined);
  store.putSetting('autonomy-integration', null);
  store.release('held-by-another-story');
});
