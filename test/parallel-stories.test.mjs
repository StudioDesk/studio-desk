// Parallel stories and conflicts (1.1 step 3, MP-016 step (d)): up to two stories hold a line at once, and a story
// whose change conflicts with work integrated since it started keeps its change. Git applies it to the line's tip, as
// integration does, and its editor resolves the parts git could not combine (the director, October 25: "keep the code
// that was already built and just have the agent merge it together"); its tests and a fresh review follow. The policy
// merges once, then a conflict waits for the director, who can merge again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { mergeSourceStory, sourceStoryInFlight } from '../src/connectors/source-changes.mjs';
import { autonomyPolicy, saveAutonomyPolicy } from '../src/core/autonomy.mjs';
import { approveWork } from '../src/core/proposals.mjs';

const target = 'src/core/workflows.mjs';
// Work integrated on main since the story started, changing the same lines its candidate changed.
const meanwhile = (c, text) => {
  fs.appendFileSync(path.join(c.root, target), `\n// ${text}\n`);
  git(c.root, ['commit', '--quiet', '-am', text]);
};
const policyOn = c =>
  saveAutonomyPolicy(c.app.store, c.app.runner.registries, 'project-legacy', {
    expectedRevision: autonomyPolicy(c.app.store, 'project-legacy').revision,
    enabled: true,
    kinds: {},
    retries: 0,
  });

test('two stories hold a line at once from their first edit until each is integrated, and a third waits', async t => {
  const c = await setup(t, 'pass', [target], {}, true),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: [target], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    third = await c.propose('third', { files: [target] });
  for (const id of ids) approveWork(store, c.app.runner.registries, store.task(id));
  c.app.runner.start(ids[0]);
  const { review } = await c.toReview(ids[0]);
  // The second story edits while the first waits for integration.
  assert.equal(sourceStoryInFlight(store, store.task(ids[1])), undefined);
  c.app.runner.start(ids[1]);
  await c.toReview(ids[1]);
  const queued = c.app.runner.queueStart(third);
  assert.equal(queued.queued, true);
  assert.equal(
    queued.reason,
    `Waiting for ${ids[0]} (“Refine workflow fixture”) and ${ids[1]} (“Refine project fixture”) to be integrated: source stories run two at a time.`,
  );
  assert.equal(store.attempts(third).length, 0);
  c.integrated(ids[0], review, target, '// Integrated\n');
  c.app.runner.schedule();
  const started = await c.wait(third);
  assert.deepEqual(started.sourceChange.allowedFiles, [target]);
});

test('a conflicting story keeps its change: merged onto the current source by the policy, its editor resolves the marked parts, and it integrates', async t => {
  const c = await setup(t),
    store = c.app.store;
  policyOn(c);
  await c.start();
  const first = await c.wait(c.taskId),
    review = await c.review(first);
  await c.accept(review.taskId);
  meanwhile(c, 'A different change here on main.');
  const tip = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal((await c.integration(review)).status, 200);
  const journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.deepEqual(journal.verification.conflicts, [target]);
  assert.match(journal.error, /Use Merge onto the current source: its editor resolves the conflicts/);
  // The policy sent the story back with its change merged onto the current source.
  const merged = await c.wait(c.taskId),
    story = store.task(c.taskId);
  assert.equal(story.sourceStage.merges, 1);
  assert.deepEqual(story.sourceStage.merge.by.type, 'policy');
  assert.match(
    story.direction,
    /the files under changes\/ hold it, and src\/core\/workflows\.mjs hold conflict markers/,
  );
  assert.deepEqual(merged.sourceChange.merge, {
    from: first.id,
    candidateCommit: first.sourceCandidate.commit,
    files: [target],
    conflicts: [target],
  });
  assert.equal(merged.sourceChange.base.commit, tip);
  assert.equal(merged.sourceChange.continueFrom, undefined, 'The merge replaces continuing from the earlier attempt.');
  const resolved = git(c.root, ['show', `${merged.sourceCandidate.commit}:${target}`]);
  assert.match(resolved, /A different change here on main\.\n\/\/ Bounded fixture improvement\.$/);
  assert.doesNotMatch(resolved, /^(<{7}|>{7})/m);
  assert.ok(
    store.events().some(event => event.kind === 'source_merged' && /Autonomy policy revision/.test(event.message)),
  );
  // Its tests and a fresh independent review, then integration onto the tip it was merged onto.
  const second = await c.review(merged);
  await c.accept(second.taskId);
  assert.equal((await c.integration(second)).status, 200);
  const integrated = await c.settled(second);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), tip);
  const final = fs.readFileSync(path.join(c.root, target), 'utf8');
  assert.match(final, /A different change here on main\./);
  assert.match(final, /Bounded fixture improvement\./);
});

test('a second conflict waits for the director, who can merge again; markers left in a file stop the candidate', async t => {
  const c = await setup(t),
    store = c.app.store;
  policyOn(c);
  await c.start();
  let attempt = await c.wait(c.taskId),
    review = await c.review(attempt);
  await c.accept(review.taskId);
  assert.match(
    (await c.request(`/api/tasks/${c.taskId}/merge-source`, {})).data.error,
    /Only a story whose integration stopped on a conflict/,
  );
  meanwhile(c, 'First change on main.');
  assert.equal((await c.integration(review)).status, 200);
  await c.settled(review);
  attempt = await c.wait(c.taskId);
  review = await c.review(attempt);
  await c.accept(review.taskId);
  // Another conflict: the policy has merged once, so the story stops with the files and the action.
  meanwhile(c, 'Second change on main.');
  assert.equal((await c.integration(review)).status, 200);
  assert.equal((await c.settled(review)).state, 'rejected');
  let story = store.task(c.taskId);
  assert.equal(story.sourceStage.current, 'failed');
  assert.equal(story.sourceStage.merges, 1);
  assert.match(story.autonomyNote, /conflicts with changes integrated since its base, in src\/core\/workflows\.mjs/);
  // The director merges it, and an editor that leaves a marker gets no candidate.
  mergeSourceStory(store, c.app.runner.registries, store.task(c.taskId));
  story = store.task(c.taskId);
  assert.equal(story.sourceStage.merges, 2);
  assert.equal(story.sourceStage.merge.by.type, 'director');
  store.putTask({ ...story, direction: `${story.direction} keep-markers` });
  c.app.runner.queueStart(c.taskId);
  await c.wait(c.taskId, 'failed');
  assert.match(store.task(c.taskId).reason, /Conflict markers remain in src\/core\/workflows\.mjs/);
});
