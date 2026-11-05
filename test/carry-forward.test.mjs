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
import {
  approveCarry,
  carryWaits,
  interruptedCarries,
  nextCarry,
  runCarry,
  skipCarry,
} from '../src/connectors/source-carries.mjs';
import { sourceResources } from '../src/connectors/source-projects.mjs';
import { autonomyPolicy, saveAutonomyPolicy } from '../src/core/autonomy.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';

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

// Closing or denying a carry story frees its carry: the original story offers the carry's choices again.
const labels = async (c, id) =>
  (await (await fetch(`${c.origin}/api/tasks/${id}?projectId=${project}`)).json()).actions.map(action => action.label);
const closedEvents = store =>
  store.db
    .prepare("SELECT task_id, attempt_id, message FROM events WHERE kind='carry_story_closed' ORDER BY seq")
    .all()
    .map(event => [event.task_id, event.attempt_id, event.message]);
// A fix integrated on release/1.0 whose carry to main conflicts, since main changed the same lines meanwhile.
async function conflictingFix(t) {
  const c = await lined(t, ['release/1.0']),
    review = await reviewedFix(c, 'release/1.0'),
    original = c.taskId;
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  await c.settled(review, ['integrated']);
  fs.appendFileSync(path.join(c.root, target), '\n// A different change on main.\n');
  git(c.root, ['commit', '--quiet', '-am', 'A different change on main']);
  return { c, review, original, pipeline: action => c.request('/api/pipeline', { projectId: project, action }) };
}
test("closing a carry's own story rejects its carry, so the director can carry it again or mark it not needed; an open one is still refused", async t => {
  const { c, review, original } = await conflictingFix(t),
    store = c.app.store,
    act = (action, data) => c.request(`/api/tasks/${original}/${action}`, { projectId: project, ...data });
  assert.equal((await act('carry', { line: 'main' })).status, 202);
  const carry = await carried(c, review, 0);
  assert.equal(carry.state, 'merging', JSON.stringify(carry));
  // While its carry story is open, the carry is refused as before.
  assert.equal(
    (await act('carry', { line: 'main' })).data.error,
    `The carry to main is a story of its own, ${carry.storyId}.`,
  );
  assert.equal(
    (await act('carry-skip', { line: 'main', reason: 'Not wanted.' })).data.error,
    `The carry to main is a story of its own, ${carry.storyId}; close it first.`,
  );
  assert.equal(carriesOf(c, review)[0].state, 'merging');
  assert.equal(count(store, 'carry_story_closed'), 0);
  // Its editor finishes; the director closes the story instead of accepting it.
  await c.wait(carry.storyId);
  const closed = await c.request(`/api/tasks/${carry.storyId}/close`, {
    projectId: project,
    reason: 'The conflict needs a different approach.',
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const reopened = carriesOf(c, review)[0];
  assert.equal(reopened.state, 'rejected', JSON.stringify(reopened));
  assert.equal(
    reopened.error,
    `Its carry story, ${carry.storyId}, was closed: The conflict needs a different approach.`,
  );
  assert.deepEqual(
    [reopened.storyId, reopened.previous.state, reopened.previous.storyId],
    [undefined, 'merging', carry.storyId],
  );
  assert.deepEqual(closedEvents(store), [
    [
      original,
      review.id,
      `The carry story ${carry.storyId} to main was closed: carry the fix again or mark it Not needed on main.`,
    ],
  ]);
  assert.equal(store.task(original).autonomyNote, `Carrying the fix to main did not complete. ${reopened.error}`);
  const offered = await labels(c, original);
  assert.ok(offered.includes('Carry to main again'), JSON.stringify(offered));
  assert.ok(offered.includes('Not needed on main…'), JSON.stringify(offered));
  // Carry again runs a fresh carry, which conflicts again and becomes a new carry story.
  const again = await act('carry', { line: 'main' });
  assert.equal(again.status, 202, JSON.stringify(again.data));
  assert.equal(again.data.carry.previous.previous.storyId, carry.storyId, 'The closed story stays recorded.');
  const second = await waitFor(
    () => {
      const now = carriesOf(c, review)[0];
      return now.state === 'merging' && now.storyId && !c.app.runner.sourceIntegrationRun && now;
    },
    'the fresh carry to settle',
    { detail: () => JSON.stringify(carriesOf(c, review)) },
  );
  assert.notEqual(second.storyId, carry.storyId);
  assert.equal(count(store, 'carry_verifying'), 2);
  assert.equal(store.task(second.storyId).carryOf.carryId, carry.id);
});

test("denying an unstarted carry story frees its carry: Not needed lets the chain go on to the next line, and another story's carry that waited goes on", async t => {
  const c = await lined(t, ['release/1.0', 'release/1.1']),
    store = c.app.store,
    { runner } = c.app;
  saveAutonomyPolicy(store, runner.registries, project, {
    expectedRevision: autonomyPolicy(store, project).revision,
    enabled: true,
    retries: 0,
    kinds: {
      'studio-development:change': { approve: 'director', accept: 'director', integrate: 'auto' },
      'studio-development:change-review': { approve: 'auto', accept: 'auto' },
    },
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  // Two stories of one idea land on main, the second building on the first.
  const { ids } = await c.breakdown(),
    [first, second] = ids,
    planning = store.task('breakdown-task');
  planning.runReference = { runId: 'run-closed-carry' };
  store.putTask(planning);
  for (const id of ids) {
    approveWork(store, runner.registries, store.task(id));
    runner.queueStart(id);
  }
  const reviews = [];
  for (const id of ids) {
    const edit = await c.wait(id);
    c.measuredFixture(edit);
    acceptAttempt(store, runner.registries, store.task(id));
    runner.autonomy.accepted(id);
    reviews.push(
      await waitFor(() => {
        const review = store.attempts(id).find(attempt => attempt.sourceIntegration?.state === 'integrated');
        return !runner.sourceIntegrationRun && review;
      }, `${id} to integrate`),
    );
  }
  // release/1.1 changed the first story's lines meanwhile; the project is paused so carry stories wait unstarted.
  const worktree = path.join(c.directory, 'w-release-1-1');
  git(c.root, ['worktree', 'add', '--quiet', worktree, 'release/1.1']);
  fs.appendFileSync(path.join(worktree, target), '\n// A different change on release/1.1.\n');
  git(worktree, ['commit', '--quiet', '-am', 'A change on release/1.1']);
  git(c.root, ['worktree', 'remove', '--force', worktree]);
  assert.equal((await c.request('/api/pipeline', { projectId: project, action: 'pause' })).status, 200);
  const brought = await c.request(`/api/projects/${project}/runs/run-closed-carry/bring-back`, {
    projectId: project,
    line: 'release/1.0',
  });
  assert.equal(brought.status, 202, JSON.stringify(brought.data));
  const [firstReview, secondReview] = reviews;
  assert.deepEqual(
    carriesOf(c, firstReview).map(item => item.line),
    ['release/1.1', 'release/1.0'],
  );
  const firstStory = store.task(first);
  runCarry(runner, firstStory, result => runner.autonomy.carrySettled(firstStory, result));
  const carry = await carried(c, firstReview, 0);
  assert.equal(carry.state, 'merging', JSON.stringify(carry));
  assert.equal(store.attempts(carry.storyId).length, 0, 'The carry story has not started.');
  const waiting = carriesOf(c, secondReview)[0];
  assert.equal(carryWaits(store, waiting)?.id, carry.id, "The second story's carry waits for the first's.");
  // The director denies the carry story before it starts.
  const denied = await c.request(`/api/tasks/${carry.storyId}/deny-work`, {
    projectId: project,
    reason: 'Not this way.',
  });
  assert.equal(denied.status, 200, JSON.stringify(denied.data));
  const reopened = carriesOf(c, firstReview)[0];
  assert.deepEqual([reopened.state, reopened.previous.storyId], ['rejected', carry.storyId]);
  assert.equal(reopened.error, `Its story bringing the fix back, ${carry.storyId}, was closed: Not this way.`);
  assert.deepEqual(closedEvents(store), [
    [
      first,
      firstReview.id,
      `The story ${carry.storyId} bringing the fix back to release/1.1 was closed: bring the fix back again or mark it Not needed on release/1.1.`,
    ],
  ]);
  const offered = await labels(c, first);
  assert.ok(offered.includes('Bring back to release/1.1 again'), JSON.stringify(offered));
  assert.ok(offered.includes('Not needed on release/1.1…'), JSON.stringify(offered));
  assert.ok(carryWaits(store, carriesOf(c, secondReview)[0]), 'A rejected carry still holds back the one after it.');
  // Not needed on release/1.1: the chain goes on to release/1.0, and the second story's carries follow.
  const skipped = await c.request(`/api/tasks/${first}/carry-skip`, {
    projectId: project,
    line: 'release/1.1',
    reason: 'release/1.1 is fixed another way.',
  });
  assert.equal(skipped.status, 202, JSON.stringify(skipped.data));
  assert.equal(skipped.data.carry.state, 'skipped');
  assert.equal(nextCarry(store.attempt(firstReview.id)).line, 'release/1.0');
  assert.equal(carryWaits(store, carriesOf(c, secondReview)[0]), null);
  assert.equal((await c.request('/api/pipeline', { projectId: project, action: 'resume' })).status, 200);
  await waitFor(
    () =>
      [...carriesOf(c, firstReview), ...carriesOf(c, secondReview)].every(item =>
        ['carried', 'skipped', 'rejected', 'merging', 'needs-reconciliation'].includes(item.state),
      ) && !runner.sourceIntegrationRun,
    'every carry to settle',
    { detail: () => JSON.stringify([carriesOf(c, firstReview), carriesOf(c, secondReview)]) },
  );
  assert.deepEqual(
    [...carriesOf(c, firstReview), ...carriesOf(c, secondReview)].map(item => [item.line, item.state]),
    [
      ['release/1.1', 'skipped'],
      ['release/1.0', 'carried'],
      ['release/1.1', 'carried'],
      ['release/1.0', 'carried'],
    ],
  );
  assert.match(git(c.root, ['show', `release/1.0:${target}`]), /Bounded fixture improvement\./);
  assert.match(git(c.root, ['show', 'release/1.1:src/core/projects.mjs']), /Bounded fixture improvement\./);
});

test("a carry left merging with a closed carry story before this change is reopened at the controller's start", async t => {
  const { c, review, original, pipeline } = await conflictingFix(t);
  assert.equal((await pipeline('pause')).status, 200);
  assert.equal((await c.request(`/api/tasks/${original}/carry`, { projectId: project, line: 'main' })).status, 202);
  const story = c.app.store.task(original);
  runCarry(c.app.runner, story, result => c.app.runner.autonomy.carrySettled(story, result));
  const carry = await carried(c, review, 0);
  assert.equal(carry.state, 'merging', JSON.stringify(carry));
  // Recorded as a close was before closing reopened the carry: the story closed, the carry still merging.
  let store = c.app.store;
  const closed = store.task(carry.storyId);
  Object.assign(closed, {
    status: 'denied',
    queued: false,
    reason: 'Closed long ago.',
    closed: { at: new Date().toISOString(), reason: 'Closed long ago.', status: 'ready', by: { type: 'director' } },
  });
  store.putTask(closed);
  assert.equal(carriesOf(c, review)[0].state, 'merging');
  await c.app.close();
  await c.reopen();
  store = c.app.store;
  const reopened = carriesOf(c, review)[0];
  assert.deepEqual(
    [reopened.state, reopened.storyId, reopened.previous.storyId, reopened.error],
    ['rejected', undefined, carry.storyId, `Its carry story, ${carry.storyId}, was closed: Closed long ago.`],
  );
  assert.equal(closedEvents(store).length, 1);
  assert.match(store.task(original).autonomyNote, /did not complete\. Its carry story/);
  assert.ok((await labels(c, original)).includes('Carry to main again'));
  // Once reopened, a second start leaves it as it is.
  await c.app.close();
  await c.reopen();
  assert.equal(closedEvents(c.app.store).length, 1);
});

test('Carry again and Not needed accept a carry still merging whose story was closed, reopening it first', () => {
  const stand = storyStatus => ({
    events: [],
    tasks: {
      'T-orig': { id: 'T-orig', projectId: 'p', sourceStage: { review: { attemptId: 'review-a' } } },
      'T-carry': {
        id: 'T-carry',
        projectId: 'p',
        status: storyStatus,
        reason: 'Set aside.',
        carryOf: { storyId: 'T-orig' },
      },
    },
    review: {
      id: 'review-a',
      taskId: 'T-orig',
      projectId: 'p',
      sourceIntegration: { state: 'integrated' },
      sourceCarries: [{ id: 'source-carry:review-a:0', line: 'main', state: 'merging', storyId: 'T-carry' }],
    },
    tx: fn => fn(),
    task(id) {
      return structuredClone(this.tasks[id]);
    },
    putTask(task) {
      this.tasks[task.id] = task;
    },
    attempt() {
      return this.review;
    },
    updateAttempt(attempt) {
      this.review = attempt;
    },
    event(kind, taskId, attemptId, text) {
      this.events.push([kind, taskId, text]);
    },
  });
  const story = { id: 'T-orig', projectId: 'p', sourceStage: { review: { attemptId: 'review-a' } } };
  // An open carry story keeps the refusals.
  const open = stand('ready');
  assert.throws(() => approveCarry(open, story, 'main'), {
    message: 'The carry to main is a story of its own, T-carry.',
  });
  assert.throws(() => skipCarry(open, story, 'main', 'No.'), {
    message: 'The carry to main is a story of its own, T-carry; close it first.',
  });
  assert.deepEqual(open.events, []);
  // A closed one is reopened, then carried again or skipped; the director is acting, so no note is left.
  const again = stand('denied'),
    approved = approveCarry(again, story, 'main');
  assert.deepEqual(
    [approved.state, approved.previous.state, approved.previous.previous.storyId],
    ['waiting', 'rejected', 'T-carry'],
  );
  assert.deepEqual(
    again.events.map(event => event[0]),
    ['carry_story_closed'],
  );
  assert.equal(again.tasks['T-orig'].autonomyNote, undefined);
  const skip = stand('denied');
  assert.equal(skipCarry(skip, story, 'main', 'Fixed another way.').state, 'skipped');
  assert.deepEqual(
    skip.events.map(event => event[0]),
    ['carry_story_closed', 'carry_skipped'],
  );
});
