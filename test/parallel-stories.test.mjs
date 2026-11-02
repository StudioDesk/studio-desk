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
import os from 'node:os';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git, landedSince } from '../src/connectors/source-integration.mjs';
import {
  mergeSourceStory,
  sourceStoriesInFlight,
  sourceStoryInFlight,
  sourceStoryIntegrable,
} from '../src/connectors/source-changes.mjs';
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

// A story builds in its own worktree and holds none of its project's source (October 29), so two build at the same
// time: here both are held in their setup together, and a third waits for one of them to be integrated.
test('two stories of one project build at the same time, each in its own worktree, and a third waits', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-two-hold-')),
    hold = path.join(folder, 'hold');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(hold, '');
  const c = await setup(t, 'pass', [target], { sourceSetupHold: hold }, true),
    { store, runner } = c.app,
    { ids } = await c.breakdown([
      { files: [target], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    third = await c.propose('third', { files: [target] });
  for (const id of ids) approveWork(store, runner.registries, store.task(id));
  for (const id of ids) runner.start(id);
  const attempts = ids.map(id => store.attempt(store.task(id).lastAttemptId));
  for (const id of ids) assert.equal(store.task(id).status, 'running', store.task(id).reason);
  assert.notEqual(attempts[0].sourceWorktree.path, attempts[1].sourceWorktree.path);
  assert.deepEqual(
    store.leases().filter(lease => lease.resource.startsWith('source:')),
    [],
    'No story holds its project’s source.',
  );
  await waitFor(
    () =>
      attempts.every(a =>
        store
          .phaseEvents(a.id)
          .some(event => event.payload.phaseId === 'setup.snapshot' && event.payload.boundary === 'start'),
      ),
    'both setups to be held at once',
  );
  const queued = runner.queueStart(third);
  assert.equal(queued.queued, true);
  assert.match(
    queued.reason,
    /to finish building: 2 source stories build at once, as many as Attempts at the same time\.$/,
  );
  fs.rmSync(hold);
  for (const id of ids) await c.toReview(id);
});

// A story holds its place only while it is built (the director, October 29: "I do think stories should only hold their
// spot when it's neccessary"): two that wait for their review or merge let a third start at once.
test('a story holds its place on its line only while it builds, so stories waiting for review or merge let the next start', async t => {
  const c = await setup(t, 'pass', [target], {}, true),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: [target], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    third = await c.propose('third', { files: [target] });
  for (const id of ids) approveWork(store, c.app.runner.registries, store.task(id));
  c.app.runner.start(ids[0]);
  await c.toReview(ids[0]);
  // The first waits for its review and merge, which hold no place.
  assert.deepEqual(sourceStoriesInFlight(store, store.task(ids[1])), []);
  c.app.runner.start(ids[1]);
  await c.toReview(ids[1]);
  assert.equal(sourceStoryInFlight(store, store.task(third)), undefined);
  const queued = c.app.runner.queueStart(third);
  assert.equal(queued.queued, undefined, queued.reason);
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
  // The review is named in words, never by its attempt code.
  assert.match(story.direction, /^The independent review passed your change, but work integrated since it started/);
  assert.doesNotMatch(story.direction, /attempt-[0-9a-f]/);
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
  // Ready for the policy's integration once its fresh review passes, as before the conflict (November 2, 2026: the
  // rejected earlier integration's record kept the merged story waiting for the director).
  assert.equal(sourceStoryIntegrable(store, store.task(c.taskId))?.attemptId, second.id);
  // With integration after a passing review automatic, as the house rules recommend, nothing asked for it here, as
  // after a restart; the director's Resume does, and the policy integrates it.
  saveAutonomyPolicy(c.app.store, c.app.runner.registries, 'project-legacy', {
    expectedRevision: autonomyPolicy(c.app.store, 'project-legacy').revision,
    enabled: true,
    retries: 0,
    kinds: { 'studio-development:change': { approve: 'director', accept: 'director', integrate: 'auto' } },
  });
  c.app.runner.pipeline('resume', undefined, 'project-legacy');
  const integrated = await c.settled(second);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  assert.equal(integrated.approvedBy.type, 'policy');
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
    /^The independent review passed your change, and it passed its own tests, but T-landed1 and 1 commit made by hand landed since it started, and merged onto that, (these tests fail: .+|its tests fail)\. The controller merged your change onto the current source, with no conflicts: the files under changes\/ hold it\. Make your change work with what landed so the tests pass, without undoing any of what landed/,
  );
  // The review is named in words, never by its attempt code.
  assert.doesNotMatch(story.direction, /attempt-[0-9a-f]/);
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
  // The attempt names the file with the same reason, outside its approved scope, and its summary carries it for the
  // attempt's page; an attempt that set nothing aside carries none.
  assert.deepEqual(merged.mergeSetAside, [{ path: target, reason: aside[0].reason }]);
  assert.match(merged.mergeSetAside[0].reason, /^The current source deleted src\/core\/workflows\.mjs since/);
  assert.equal(merged.sourceChange.mergeSetAside, undefined);
  const summaries = store.dashboardAttempts('project-legacy', c.taskId);
  assert.deepEqual(summaries.find(attempt => attempt.id === merged.id).setAside, [
    { path: target, reason: aside[0].reason },
  ]);
  assert.equal(summaries.find(attempt => attempt.id === first.id).setAside, undefined);
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
