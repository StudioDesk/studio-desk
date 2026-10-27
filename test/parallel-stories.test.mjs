// Parallel stories and conflicts (1.1 step 3, MP-016 step (d)): up to two stories hold a line at once, and a story
// whose change conflicts with work integrated since it started keeps its change. Git applies it to the line's tip, as
// integration does, and its editor resolves the parts git could not combine (the director, October 25: "keep the code
// that was already built and just have the agent merge it together"); its tests and a fresh review follow. The policy
// merges once, then a conflict waits for the director, who can merge again. Since October 27 a change that passed its
// own tests and fails them merged onto work that landed since it was tested is merged onto the current source the
// same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git, landedSince } from '../src/connectors/source-integration.mjs';
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
  // Each attempt's contract explains only the situations its source-scope.json can have: the first edit none, and
  // the review of a candidate with a diff and no file request neither older candidates nor added paths.
  const contract = (attempt, title = 'Bounded source change') =>
    attempt.instructions.layers.find(layer => layer.title === title).text;
  assert.doesNotMatch(contract(first), /lists (directorEdits|continueFrom|merge)/);
  assert.doesNotMatch(contract(review, 'Candidate review contract'), /Candidates made before diffs|has requestedIn/);
  assert.match(contract(review, 'Candidate review contract'), /Assess correctness and whether the edits meet/);
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
  assert.match(contract(merged), /When source-scope\.json lists merge, your earlier change/);
  assert.doesNotMatch(contract(merged), /lists (directorEdits|continueFrom)/);
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

test('a change that passed its own tests and fails them merged onto work that landed since is merged onto the current source for its editor', async t => {
  const c = await setup(t, 'together'),
    store = c.app.store;
  policyOn(c);
  await c.start();
  const first = await c.wait(c.taskId),
    review = await c.review(first);
  await c.accept(review.taskId);
  const candidate = {
    candidateCommit: first.sourceCandidate.commit,
    repository: { head: first.sourceChange.base.commit },
  };
  assert.equal(landedSince(c.root, candidate), null, 'Nothing landed on the commit it was tested on.');
  // Meanwhile a story landed that passes alone and fails with this change, then a commit by hand.
  fs.appendFileSync(path.join(c.root, 'src/core/projects.mjs'), '\n// Fails with the improvement.\n');
  git(c.root, [
    'commit',
    '--quiet',
    '-am',
    'Change projects\n\nChange: T-landed1 (attempt-landed), candidate abc\n\nStudio-Integration: source-integration:attempt-landed',
  ]);
  const landedCommit = git(c.root, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(c.root, 'README.md'), '\nBy hand.\n');
  git(c.root, ['commit', '--quiet', '-am', 'By hand']);
  const tip = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal((await c.integration(review)).status, 200);
  const journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.equal(journal.verification.conflicts, undefined);
  assert.deepEqual(journal.verification.landedSince, {
    commits: 2,
    stories: [{ storyId: 'T-landed1', commit: landedCommit }],
  });
  assert.equal(
    journal.error,
    '0/1 tests passed on the formatted change. It passed its own tests, and T-landed1 and 1 commit made by hand landed after it was tested: together they fail. Use Merge onto the current source: its editor makes the change work with what landed.',
  );
  const summary = store.dashboardAttempts('project-legacy', c.taskId).find(attempt => attempt.id === review.id);
  assert.deepEqual(summary.sourceIntegration.verification.landedSince, { commits: 2, stories: ['T-landed1'] });
  // The policy sent the story back with its change merged onto the current source, where git had nothing to mark.
  const merged = await waitFor(
    () => store.attempts(c.taskId).find(attempt => attempt.id !== first.id && attempt.sourceChange),
    'the merged attempt to start',
  );
  const story = store.task(c.taskId);
  assert.equal(story.sourceStage.merges, 1);
  assert.equal(story.sourceStage.merge.by.type, 'policy');
  assert.deepEqual(
    [story.sourceStage.merge.conflicts, story.sourceStage.merge.landed, story.sourceStage.merge.failedTests],
    [[], ['T-landed1'], (journal.verification.failedTests || []).map(item => item.name)],
  );
  assert.match(
    story.direction,
    /passed your change, and it passed its own tests, but T-landed1 and 1 commit made by hand landed since it started, and merged onto that, (these tests fail: .+|its tests fail)\. The controller merged your change onto the current source, with no conflicts: the files under changes\/ hold it\. Make your change work with what landed so the tests pass, without undoing any of what landed/,
  );
  assert.deepEqual(merged.sourceChange.merge, {
    from: first.id,
    candidateCommit: first.sourceCandidate.commit,
    files: [target],
    conflicts: [],
  });
  assert.equal(merged.sourceChange.base.commit, tip);
  assert.ok(
    store
      .events()
      .some(
        event =>
          event.kind === 'source_merged' &&
          /sent this story back to merge its change onto the current source and make it work with T-landed1 and 1 commit made by hand\.$/.test(
            event.message,
          ),
      ),
  );
});

test('a file the current source deleted since the change edited it is set aside for the editor, not a stop', async t => {
  const c = await setup(t, 'pass', [target, 'src/core/projects.mjs']),
    store = c.app.store;
  policyOn(c);
  await c.start();
  const first = await c.wait(c.taskId),
    review = await c.review(first);
  await c.accept(review.taskId);
  git(c.root, ['rm', '--quiet', target]);
  git(c.root, ['commit', '--quiet', '-m', 'Remove the workflows fixture']);
  assert.equal((await c.integration(review)).status, 200);
  const journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.deepEqual(journal.verification.conflicts, [target]);
  // The policy merged it onto the current source. Git cannot mark a deleted file, so the change's version is set
  // aside for the editor with what to do, and the attempt goes on.
  const merged = await waitFor(
    () =>
      store
        .attempts(c.taskId)
        .find(
          attempt =>
            attempt.id !== first.id &&
            attempt.assignment?.kind === 'studio-development:change' &&
            !['running', 'stopping'].includes(attempt.status),
        ),
    'the merged attempt to finish',
  );
  assert.deepEqual(merged.sourceChange.deletedSince, [target]);
  assert.deepEqual(
    merged.sourceChange.allowedFiles,
    ['src/core/projects.mjs'],
    "The deleted file is not the editor's to write.",
  );
  assert.doesNotMatch(store.task(c.taskId).reason ?? '', /no longer exist/);
  const output = merged.outputFolder,
    aside = JSON.parse(fs.readFileSync(path.join(output, 'merge-set-aside.json'), 'utf8'));
  assert.deepEqual(
    aside.map(item => item.path),
    [target],
  );
  assert.match(
    aside[0].reason,
    /^The current source deleted src\/core\/workflows\.mjs since; your change to it is under merge-set-aside\//,
  );
  assert.match(fs.readFileSync(path.join(output, 'merge-set-aside', target), 'utf8'), /Bounded fixture improvement\./);
  assert.equal(fs.existsSync(path.join(output, 'changes', target)), false);
  assert.ok(
    store
      .events()
      .some(
        event =>
          event.kind === 'merge_set_aside' &&
          event.message.startsWith(`Git could not apply the earlier change to ${target}:`),
      ),
  );
  assert.doesNotMatch(merged.error ?? '', /Resolve it in the repository by hand/);
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
