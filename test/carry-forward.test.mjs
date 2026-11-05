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
import { sourceResources } from '../src/connectors/source-projects.mjs';
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

// Events of a kind, read from the records themselves (the store's list keeps only the latest ones).
const count = (store, kind) => store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind=?').get(kind).n;
const tick = () => new Promise(resolve => setImmediate(resolve));
// A fix integrated on release/1.0 whose carry to main the director approved while the project was paused.
async function pausedCarry(t) {
  const c = await lined(t, ['release/1.0']),
    review = await reviewedFix(c, 'release/1.0');
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  await c.settled(review, ['integrated']);
  const pipeline = action => c.request('/api/pipeline', { projectId: project, action });
  assert.equal((await pipeline('pause')).status, 200);
  const approved = await c.request(`/api/tasks/${c.taskId}/carry`, { projectId: project, line: 'main' });
  assert.equal(approved.status, 202, JSON.stringify(approved.data));
  return { c, review, pipeline, mainTip: git(c.root, ['rev-parse', 'main']) };
}
// While the project is held, its carry stays waiting with its approval across tries and the settling of other work,
// and never starts.
async function stillWaits(c, review, mainTip) {
  for (let i = 0; i < 2; i++) {
    c.app.runner.autonomy.tryCarries();
    c.app.runner.autonomy.settled(review.taskId);
    await tick();
  }
  const carry = carriesOf(c, review)[0];
  assert.deepEqual([carry.state, carry.approvedBy?.type], ['waiting', 'director'], JSON.stringify(carry));
  assert.equal(count(c.app.store, 'carry_verifying'), 0);
  assert.ok(!c.app.runner.sourceIntegrationRun);
  assert.equal(git(c.root, ['rev-parse', 'main']), mainTip, 'main is unchanged.');
}
// After the Resume it runs once and lands once: main moves to one new commit.
async function landsOnce(c, review, mainTip) {
  const carry = await carried(c, review, 0);
  assert.equal(carry.state, 'carried', JSON.stringify(carry));
  c.app.runner.autonomy.tryCarries();
  await tick();
  assert.equal(count(c.app.store, 'carry_verifying'), 1);
  assert.equal(count(c.app.store, 'carry_done'), 1);
  assert.equal(git(c.root, ['rev-parse', 'main']), carry.commit);
  assert.equal(git(c.root, ['rev-parse', 'main~1']), mainTip);
  assert.equal(c.app.store.leases().length, 0);
}

test("a paused project's approved carry waits for the director's Resume, which starts it once", async t => {
  const { c, review, pipeline, mainTip } = await pausedCarry(t);
  await stillWaits(c, review, mainTip);
  assert.equal((await pipeline('resume')).status, 200);
  await landsOnce(c, review, mainTip);
});

test("a carry the controller's stop cut off while it was tested holds its project through the restart, and runs once after Resume", async t => {
  const { c, review, pipeline, mainTip } = await pausedCarry(t);
  let store = c.app.store;
  // The stop came while the carry was being tested, as runCarry records one, in a project that was running; a planned
  // restart had been asked for that project.
  const attempt = store.attempt(review.id),
    journal = attempt.sourceCarries[0];
  Object.assign(journal, { state: 'verifying', startedAt: new Date().toISOString() });
  store.tx(() => {
    store.claim(sourceResources(store, store.task(c.taskId)), journal.id);
    store.updateAttempt(attempt);
  });
  const running = store.project(project);
  running.dispatchPaused = false;
  store.putProject(running);
  store.putSetting('planned-restart', {
    reason: 'Load the integrated source.',
    resumeProjects: [project],
    requestedAt: new Date().toISOString(),
  });
  await c.app.close();
  await c.reopen();
  store = c.app.store;
  assert.ok(!store.tasks().some(task => task.queued), 'The project has no queued work to hold.');
  const held = store.project(project);
  assert.deepEqual(
    [held.dispatchPaused, held.restartPaused],
    [true, true],
    'The restart holds the project, and its planned resume does not lift that hold.',
  );
  const paused = store.db
    .prepare("SELECT seq, message FROM events WHERE kind='pipeline_paused' AND message LIKE 'Controller restarted%'")
    .all();
  assert.deepEqual(
    paused.map(event => [event.message, store.setting('event-project:' + event.seq)]),
    [
      [
        'Controller restarted while a carry was running. The project is held; the carry runs again on its own when you resume it.',
        project,
      ],
    ],
  );
  const interrupted = store.db.prepare("SELECT message FROM events WHERE kind='carry_interrupted'").all();
  assert.deepEqual(
    interrupted.map(event => event.message),
    [
      'The carry to main was stopped when the controller stopped (during verifying); it runs again on its own when the project is resumed.',
    ],
  );
  assert.doesNotMatch(interrupted[0].message, /carry the fix again/);
  assert.equal(store.leases().length, 0, 'Its resources are released at restart, as before.');
  await stillWaits(c, review, mainTip);
  assert.equal((await pipeline('resume')).status, 200);
  await landsOnce(c, review, mainTip);
});

test("a carry the controller's stop cut off waits for the project's Resume, or is carried when its line reached its commit", t => {
  const stand = (dispatchPaused, carries) => ({
    events: [],
    projects: { p: { id: 'p', dispatchPaused } },
    attempts: [{ id: 'review-a', taskId: 'T-a', projectId: 'p', sourceCarries: carries }],
    allAttempts() {
      return this.attempts;
    },
    project(id) {
      return structuredClone(this.projects[id]);
    },
    putProject(record) {
      this.projects[record.id] = record;
    },
    release() {},
    updateAttempt(attempt) {
      this.updated = attempt;
    },
    event(kind, taskId, attemptId, text, projectId) {
      this.events.push({ kind, text, projectId });
    },
  });
  const store = stand(false, [
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
  ]);
  // A line that is not checked out moves in one compare-and-swap: not reached, it simply waits again.
  const runtime = { store };
  interruptedCarries(runtime);
  assert.deepEqual(
    store.updated.sourceCarries.map(item => [item.state, item.interrupted, item.approvedBy?.type]),
    [
      ['waiting', 'committing', undefined],
      ['waiting', 'verifying', 'director'],
    ],
  );
  // The project is held once, with the restart's mark, and remembered so a planned restart does not lift it.
  assert.deepEqual(store.projects.p, { id: 'p', dispatchPaused: true, restartPaused: true });
  assert.deepEqual([...runtime.interruptedHolds], ['p']);
  assert.deepEqual(
    store.events.map(event => [event.kind, event.projectId]),
    [
      ['carry_interrupted', 'p'],
      ['pipeline_paused', 'p'],
      ['carry_interrupted', 'p'],
    ],
  );
  assert.equal(
    store.events[2].text,
    'The carry to next was stopped when the controller stopped (during verifying); it runs again on its own when the project is resumed.',
  );
  for (const event of store.events) assert.doesNotMatch(event.text, /carry the fix again|release it again/);
  // A project the director paused keeps their pause, unmarked, and no pause is recorded for it.
  const theirs = stand(true, [{ id: 'source-carry:review-a:0', line: 'main', state: 'verifying', root: '/r' }]);
  interruptedCarries({ store: theirs });
  assert.deepEqual(theirs.projects.p, { id: 'p', dispatchPaused: true });
  assert.deepEqual(
    theirs.events.map(event => event.kind),
    ['carry_interrupted'],
  );
});
