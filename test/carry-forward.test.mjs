// Carrying a fix forward (1.1 step 4, MP-028): a fix integrated on an older release line is applied to each newer
// maintained line in order with git cherry-pick, tested with that line's tests and committed naming the commit it came
// from. Carries are approved as integration is (the policy after a passing review, or the director), a line can be
// marked Not needed, a carry git applies cleanly needs no review, and one that conflicts becomes a carry story on its
// line, merged there for its editor to resolve, reviewed and integrated, after which the chain goes on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { interruptedCarries } from '../src/connectors/source-carries.mjs';
import { autonomyPolicy, saveAutonomyPolicy } from '../src/core/autonomy.mjs';

const project = 'project-legacy',
  target = 'src/core/workflows.mjs';
// A project with release lines, oldest first, the last the newest (main, which the folder has checked out).
async function lined(t, releases) {
  const c = await setup(t);
  for (const branch of releases) {
    git(c.root, ['branch', branch]);
    const added = await c.request(`/api/projects/${project}/lines`, { projectId: project, branch });
    assert.equal(added.status, 201, JSON.stringify(added.data));
  }
  return c;
}
// A fix on a release line, edited and reviewed; its review accepted.
async function reviewedFix(c, branch, name = 'fix') {
  c.taskId = await c.propose(name, { branch });
  await c.start();
  const edit = await c.wait(c.taskId),
    review = await c.review(edit);
  return review;
}
const carriesOf = (c, review) => c.app.store.attempt(review.id).sourceCarries;
const carried = (c, review, index) =>
  waitFor(
    () =>
      ['carried', 'rejected', 'merging', 'needs-reconciliation'].includes(carriesOf(c, review)?.[index]?.state) &&
      !c.app.runner.sourceIntegrationRun &&
      carriesOf(c, review)[index],
    `carry ${index} of ${review.id} to settle`,
    { detail: () => JSON.stringify(carriesOf(c, review)) },
  );
const message = (c, ref) => git(c.root, ['log', '-1', '--format=%B', ref]);

test('the policy carries a fix integrated on an older line to the newer one as soon as it integrates', async t => {
  const c = await lined(t, ['release/1.0']),
    store = c.app.store,
    review = await reviewedFix(c, 'release/1.0'),
    mainTip = git(c.root, ['rev-parse', 'HEAD']);
  // The project integrates after a passing review, so accepting the review integrates the fix, and carries it.
  saveAutonomyPolicy(store, c.app.runner.registries, project, {
    expectedRevision: autonomyPolicy(store, project).revision,
    enabled: true,
    kinds: { 'studio-development:change': { approve: 'director', accept: 'director', integrate: 'auto' } },
    retries: 0,
  });
  await c.accept(review.taskId);
  const integration = await c.settled(review, ['integrated']);
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), integration.commit);
  const carry = await carried(c, review, 0);
  assert.equal(carry.state, 'carried', JSON.stringify(carry));
  assert.deepEqual(
    { line: carry.line, fromLine: carry.fromLine, fromCommit: carry.fromCommit, by: carry.approvedBy.type },
    { line: 'main', fromLine: 'release/1.0', fromCommit: integration.commit, by: 'policy' },
  );
  // main, checked out in the folder, moved to the carried commit, which names the commit it came from.
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), carry.commit);
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), mainTip);
  assert.match(message(c, 'HEAD'), /^Carry “Improve fix” to main\n/);
  assert.match(
    message(c, 'HEAD'),
    new RegExp(
      `from release/1\\.0 \\(cherry picked from commit ${integration.commit}\\), approved by autonomy policy revision`,
    ),
  );
  assert.match(fs.readFileSync(path.join(c.root, target), 'utf8'), /Bounded fixture improvement\./);
  assert.equal(store.leases().length, 0);
  assert.ok(
    store.events().some(event => event.kind === 'carry_planned' && /carried forward to main/.test(event.message)),
  );
  assert.ok(store.events().some(event => event.kind === 'carry_done'));
});

test('the director carries a fix, skipping a line where it is not needed, in order', async t => {
  const c = await lined(t, ['release/1.0', 'release/1.1']),
    store = c.app.store,
    review = await reviewedFix(c, 'release/1.0');
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  const integration = await c.settled(review, ['integrated']);
  assert.deepEqual(
    carriesOf(c, review).map(item => [item.line, item.state, item.approvedBy]),
    [
      ['release/1.1', 'waiting', undefined],
      ['main', 'waiting', undefined],
    ],
    'Without the policy, each carry waits for the director.',
  );
  const act = (action, data) => c.request(`/api/tasks/${c.taskId}/${action}`, { projectId: project, ...data });
  assert.match((await act('carry', { line: 'main' })).data.error, /The next carry of this fix is to release\/1\.1/);
  assert.match(
    (await act('carry-skip', { line: 'release/1.1', reason: ' ' })).data.error,
    /Say why the fix is not needed/,
  );
  const release11 = git(c.root, ['rev-parse', 'refs/heads/release/1.1']);
  const skipped = await act('carry-skip', { line: 'release/1.1', reason: 'release/1.1 never had the bug.' });
  assert.equal(skipped.status, 202, JSON.stringify(skipped.data));
  assert.equal(skipped.data.carry.state, 'skipped');
  assert.ok(
    store
      .events()
      .some(
        event =>
          event.kind === 'carry_skipped' &&
          event.message === 'Not needed on release/1.1: release/1.1 never had the bug.',
      ),
  );
  assert.equal((await act('carry', { line: 'main' })).status, 202);
  const carry = await carried(c, review, 1);
  assert.equal(carry.state, 'carried', JSON.stringify(carry));
  assert.equal(carry.approvedBy.type, 'director');
  assert.equal(carry.fromCommit, integration.commit, 'A skipped line passes on what it would have carried.');
  assert.match(message(c, 'main'), /approved by the director/);
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.1']), release11);
  assert.match((await act('carry', {})).data.error, /carried to every newer line/);
});

test('a carry that conflicts becomes a carry story on its line, merged there for its editor, and the chain records its commit', async t => {
  const c = await lined(t, ['release/1.0']),
    store = c.app.store,
    review = await reviewedFix(c, 'release/1.0'),
    original = c.taskId;
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  const integration = await c.settled(review, ['integrated']);
  // main changed the same lines meanwhile.
  fs.appendFileSync(path.join(c.root, target), '\n// A different change on main.\n');
  git(c.root, ['commit', '--quiet', '-am', 'A different change on main']);
  const tip = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal((await c.request(`/api/tasks/${original}/carry`, { projectId: project, line: 'main' })).status, 202);
  const carry = await carried(c, review, 0);
  assert.equal(carry.state, 'merging', JSON.stringify(carry));
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), tip, 'main is unchanged until the carry story integrates.');
  const story = store.task(carry.storyId);
  assert.equal(story.title, 'Carry to main: Improve fix');
  assert.deepEqual(story.carryOf, {
    storyId: original,
    reviewAttemptId: review.id,
    carryId: carry.id,
    line: 'main',
    fromCommit: integration.commit,
  });
  assert.deepEqual(story.sourceStage.merge.conflicts, [target]);
  // The carry story's editor gets the fix merged onto main and resolves the marked part.
  c.taskId = story.id;
  const edit = await c.wait(story.id);
  assert.deepEqual(edit.sourceChange.base, { commit: tip, branch: 'main' });
  assert.equal(edit.sourceChange.merge.candidateCommit, integration.commit);
  const second = await c.review(edit);
  await c.accept(second.taskId);
  assert.equal((await c.integration(second)).status, 200);
  const landed = await c.settled(second, ['integrated']);
  const done = carriesOf(c, review)[0];
  assert.deepEqual([done.state, done.commit], ['carried', landed.commit]);
  assert.equal(
    store.attempt(second.id).sourceCarries,
    undefined,
    'A carry story continues its fix’s chain, not one of its own.',
  );
  const final = fs.readFileSync(path.join(c.root, target), 'utf8');
  assert.match(final, /A different change on main\./);
  assert.match(final, /Bounded fixture improvement\./);
});

test("a carry the controller's stop cut off waits to run again, or is carried when its line reached its commit", t => {
  const store = {
    events: [],
    attempts: [
      {
        id: 'review-a',
        taskId: 'T-a',
        sourceCarries: [
          {
            id: 'source-carry:review-a:0',
            line: 'main',
            state: 'committing',
            commit: 'abc1234',
            root: '/r',
            repository: { branch: 'main', live: false },
          },
          {
            id: 'source-carry:review-a:1',
            line: 'next',
            state: 'verifying',
            root: '/r',
            approvedBy: { type: 'director' },
          },
        ],
      },
    ],
    allAttempts() {
      return this.attempts;
    },
    release() {},
    updateAttempt(attempt) {
      this.updated = attempt;
    },
    event(kind, taskId, attemptId, text) {
      this.events.push(text);
    },
  };
  // A line that is not checked out moves in one compare-and-swap: not reached, it simply waits again.
  interruptedCarries({ store });
  assert.deepEqual(
    store.updated.sourceCarries.map(item => [item.state, item.interrupted, item.approvedBy?.type]),
    [
      ['waiting', 'committing', undefined],
      ['waiting', 'verifying', 'director'],
    ],
  );
  assert.match(store.events[1], /The carry to next was stopped when the controller stopped \(during verifying\)/);
});
