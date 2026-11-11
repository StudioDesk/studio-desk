// Releasing a milestone and pushing it (1.1 step 5, MP-028): Release moves open work to the next milestone when asked,
// the planner drafts the notes, and accepting them writes the version and the notes, verifies the release as an
// integration is verified, moves the line and tags it. Push sends the line and its tag to the remote, only when the
// director confirms. The first release of a new major moves the older major to a line of its own (Start 2.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import {
  addWaitingIdea,
  makeMilestone,
  projectMilestones,
  useVersionLines,
} from '../src/connectors/source-milestones.mjs';
import { interruptedReleases, runRelease, startRelease } from '../src/connectors/source-releases.mjs';
import { Store } from '../src/store.mjs';
import { sourceResources } from '../src/connectors/source-projects.mjs';
import { saveProjectOrganization } from '../src/core/project-organization.mjs';
import { developmentOrganization } from '../src/organizations/studio-development/project.mjs';

const project = 'project-legacy';
// The fixture's project with a planner, a version in package.json, and 1.0.0 released.
async function released(t) {
  const c = await setup(t),
    store = c.app.store;
  saveProjectOrganization(store, c.app.runner.registries, project, developmentOrganization(store.organization()));
  fs.writeFileSync(path.join(c.root, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  git(c.root, ['commit', '--quiet', '-am', 'Version 1.0.0']);
  git(c.root, ['tag', 'v1.0.0']);
  return c;
}
const make = async (c, version) => {
  const made = await c.request(`/api/projects/${project}/milestones`, { projectId: project, version });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data.milestone;
};
const milestone = (c, id) => projectMilestones(c.app.store, project).find(item => item.id === id);

for (const [version, nextVersion, reuse] of [
  ['1.1.0', '1.2.0', false],
  ['1.1.0', '1.2.0', true],
  ['1.0.1', '1.0.2', false],
  ['1.0.1', '1.0.2', true],
]) {
  test(`move-open preserves ${version} progression to ${nextVersion} (${reuse ? 'reuse' : 'create'})`, async t => {
    const c = await setup(t, 'pass', undefined, {}, true),
      store = c.app.store,
      runtime = c.app.runner;
    saveProjectOrganization(store, runtime.registries, project, developmentOrganization(store.organization()));
    store.setOrganization({ ...store.organization(), paused: true });
    git(c.root, ['tag', 'v1.0.0']);
    const current = makeMilestone(store, project, runtime, { version });
    if (reuse) makeMilestone(store, project, runtime, { version: nextVersion });
    const base = store.task(c.taskId),
      release = { milestoneId: current.id, version, line: current.line };
    store.putTask({ ...base, id: 'T-open', status: 'ready', release });
    assert.throws(() => startRelease(store, runtime, project, current.id, { moveOpen: true }), /Nothing.*integrated/);
    assert.equal(store.task('T-open').release.milestoneId, current.id);
    store.putTask({ ...base, id: 'T-done', status: 'done', release, sourceStage: { current: 'integrated' } });
    const before = projectMilestones(store, project).length;
    const notes = startRelease(store, runtime, project, current.id, { moveOpen: true });
    assert.equal(store.task('T-open').release.version, nextVersion);
    assert.equal(projectMilestones(store, project).length, before + (reuse ? 0 : 1));
    assert.match(notes.brief, /- T-done:/);
    assert.equal(milestone(c, current.id).release.state, 'drafting');
  });
}

// Waiting ideas are open work too: a released milestone never sends them, so a release moves them on or refuses.
// 1.1.0 with one integrated story, in a paused organization; the next milestone it moves to is 1.2.0.
function ideasRelease(t) {
  return setup(t, 'pass', undefined, {}, true).then(c => {
    const store = c.app.store,
      runtime = c.app.runner;
    saveProjectOrganization(store, runtime.registries, project, developmentOrganization(store.organization()));
    store.setOrganization({ ...store.organization(), paused: true });
    git(c.root, ['tag', 'v1.0.0']);
    const current = makeMilestone(store, project, runtime, { version: '1.1.0' }),
      base = store.task(c.taskId),
      release = { milestoneId: current.id, version: '1.1.0', line: current.line };
    store.putTask({ ...base, id: 'T-done', status: 'done', release, sourceStage: { current: 'integrated' } });
    return { c, store, runtime, current, base, release };
  });
}
const ideasOf = (count, prefix) =>
  Array.from({ length: count }, (_, i) => ({ id: `waiting-${prefix}${i}`, idea: `Idea ${prefix}${i}`, at: `t${i}` }));
const setWaiting = (store, milestoneId, waiting) => {
  const milestones = projectMilestones(store, project);
  milestones.find(item => item.id === milestoneId).waiting = waiting;
  store.putSetting(`milestones:${project}`, milestones);
};
const movedEvents = store =>
  store.db
    .prepare("SELECT message FROM events WHERE kind='release_moved' ORDER BY seq")
    .all()
    .map(event => event.message);

test('a release with moveOpen moves its waiting idea to the next milestone, unchanged, and still drafts its notes', async t => {
  const { c, store, runtime, current } = await ideasRelease(t),
    idea = addWaitingIdea(store, project, { milestoneId: current.id, idea: 'Show the release date', autoMode: true });
  const notes = startRelease(store, runtime, project, current.id, { moveOpen: true });
  assert.deepEqual(milestone(c, current.id).waiting, [], 'The released milestone holds no waiting ideas.');
  const next = projectMilestones(store, project).find(item => item.version === '1.2.0');
  assert.deepEqual(next.waiting[0], idea, 'The idea keeps its id, words, auto mode and time.');
  assert.match(notes.brief, /- T-done:/);
  assert.equal(notes.title, 'Draft the 1.1.0 release notes');
  assert.equal(milestone(c, current.id).release.state, 'drafting');
  assert.deepEqual(movedEvents(store), [`Open work on 1.1.0 moved to 1.2.0: waiting idea ${idea.id}.`]);
});

test('a release whose only open work is waiting ideas makes the next milestone and moves them in their order', async t => {
  const { store, runtime, current } = await ideasRelease(t),
    ideas = ideasOf(3, 'a');
  setWaiting(store, current.id, ideas);
  const before = projectMilestones(store, project).length;
  startRelease(store, runtime, project, current.id, { moveOpen: true });
  const after = projectMilestones(store, project);
  assert.equal(after.length, before + 1);
  const next = after.at(-1);
  assert.equal(next.version, '1.2.0');
  assert.deepEqual(next.waiting, ideas);
  assert.deepEqual(after.find(item => item.id === current.id).waiting, []);
  assert.deepEqual(movedEvents(store), [
    'Open work on 1.1.0 moved to 1.2.0: waiting ideas waiting-a0, waiting-a1, waiting-a2.',
  ]);
});

test('a release without moveOpen refuses while ideas wait, names them and changes nothing', async t => {
  const { c, store, runtime, current, base, release } = await ideasRelease(t);
  setWaiting(store, current.id, [
    { id: 'waiting-first', idea: 'Let the director pin a milestone to the top of the board', at: 't0' },
    ...ideasOf(5, 'b'),
  ]);
  const before = projectMilestones(store, project);
  assert.throws(
    () => startRelease(store, runtime, project, current.id),
    error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /^6 ideas still wait on 1\.1\.0: waiting-first \(“Let the director pin a milestone/);
      assert.match(error.message, /waiting-b3 \(“Idea b3”\) and more\. /);
      assert.doesNotMatch(error.message, /waiting-b4/);
      assert.deepEqual(error.open, []);
      assert.deepEqual(error.waiting, ['waiting-first', ...ideasOf(5, 'b').map(idea => idea.id)]);
      return true;
    },
  );
  assert.deepEqual(projectMilestones(store, project), before, 'No milestone is made and every idea stays in place.');
  assert.equal(milestone(c, current.id).release, undefined);
  // Open stories and waiting ideas are named in the same refusal, the stories' words as before.
  store.putTask({ ...base, id: 'T-open', title: 'Improve later', status: 'ready', release });
  assert.throws(
    () => startRelease(store, runtime, project, current.id),
    error =>
      error.status === 409 &&
      /^1 piece of work is still open on 1\.1\.0: T-open \(“Improve later”\); 6 ideas still wait on 1\.1\.0: /.test(
        error.message,
      ) &&
      error.open.join() === 'T-open' &&
      error.waiting.length === 6,
  );
  assert.deepEqual(projectMilestones(store, project), before);
  assert.equal(store.task('T-open').release.milestoneId, current.id);
  assert.deepEqual(movedEvents(store), []);
});

test('moved ideas follow those already waiting in the next milestone, and the event names the stories and the ideas', async t => {
  const { c, store, runtime, current, base, release } = await ideasRelease(t),
    next = makeMilestone(store, project, runtime, { version: '1.2.0' }),
    earlier = ideasOf(2, 'n'),
    moving = ideasOf(2, 'm');
  setWaiting(store, next.id, earlier);
  setWaiting(store, current.id, moving);
  store.putTask({ ...base, id: 'T-open', status: 'ready', release });
  const before = projectMilestones(store, project).length;
  startRelease(store, runtime, project, current.id, { moveOpen: true });
  assert.equal(projectMilestones(store, project).length, before, 'The existing next milestone is used.');
  assert.deepEqual(milestone(c, next.id).waiting, [...earlier, ...moving]);
  assert.deepEqual(milestone(c, current.id).waiting, []);
  assert.equal(store.task('T-open').release.milestoneId, next.id);
  assert.deepEqual(movedEvents(store), [
    'Open work on 1.1.0 moved to 1.2.0: T-open; waiting ideas waiting-m0, waiting-m1.',
  ]);
});

test('a release refuses, changing nothing, when the moved ideas would take the next milestone past 100', async t => {
  const { c, store, runtime, current, base, release } = await ideasRelease(t),
    next = makeMilestone(store, project, runtime, { version: '1.2.0' });
  setWaiting(store, next.id, ideasOf(99, 'n'));
  setWaiting(store, current.id, ideasOf(2, 'm'));
  store.putTask({ ...base, id: 'T-open', status: 'ready', release });
  const before = projectMilestones(store, project),
    open = store.task('T-open').release;
  assert.throws(
    () => startRelease(store, runtime, project, current.id, { moveOpen: true }),
    error => error.status === 409 && /at most 100 waiting ideas/.test(error.message),
  );
  assert.deepEqual(projectMilestones(store, project), before);
  assert.deepEqual(store.task('T-open').release, open);
  assert.equal(milestone(c, current.id).release, undefined);
  assert.equal(store.tasks().filter(task => task.releaseOf).length, 0, 'No notes task is made.');
  assert.deepEqual(movedEvents(store), []);
  // Exactly 100 fits.
  setWaiting(store, current.id, ideasOf(1, 'm'));
  startRelease(store, runtime, project, current.id, { moveOpen: true });
  assert.equal(milestone(c, next.id).waiting.length, 100);
  assert.equal(milestone(c, next.id).waiting.at(-1).id, 'waiting-m0');
});

// Whether git can push to a repository in a folder here. Every such push runs git's receiving side through its shell,
// which the Codex test sandbox does not let git start, so there Push refuses with git's own reason instead. The probe's
// repository has a name as long as the test's remote.git: git's receiving side writes each object at a path that, at
// the depth of an idea's checks, can pass Windows' 260 characters, and the probe must fail exactly when Push does
// (October 27, when a probe name four characters longer failed while Push passed).
function pushesToAFolder(directory) {
  const probe = path.join(directory, 'push-probe'),
    bare = path.join(directory, 'probes.git');
  git(directory, ['init', '--quiet', '--bare', bare]);
  git(directory, ['-c', 'init.defaultBranch=main', 'init', '--quiet', probe]);
  git(probe, [
    '-c',
    'user.name=Probe',
    '-c',
    'user.email=probe@example.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'Probe',
  ]);
  try {
    git(probe, ['push', '--quiet', bare, 'HEAD:refs/heads/main']);
    return true;
  } catch {
    return false;
  }
}
const move = (c, id, to) =>
  fetch(`${c.origin}/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
    body: JSON.stringify({ projectId: project, release: to }),
  });

test('Release moves open work on when asked, the planner drafts the notes, and accepting them writes the version, the notes and the tag', async t => {
  const c = await released(t),
    store = c.app.store,
    fix = await make(c, '1.0.1');
  // A fix on 1.0.1, integrated on release/1.0, and one more story that has not started.
  c.taskId = await c.propose('fix', { branch: 'release/1.0' });
  assert.equal((await move(c, c.taskId, fix.id)).status, 200);
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  const integration = await c.settled(review, ['integrated']);
  const later = await c.propose('later', { branch: 'release/1.0', files: ['src/core/projects.mjs'] });
  assert.equal((await move(c, later, fix.id)).status, 200);
  const release = data =>
    c.request(`/api/projects/${project}/milestones/${fix.id}/release`, { projectId: project, ...data });
  const refused = await release({});
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, new RegExp(`still open on 1\\.0\\.1: ${later} \\(“Improve later”\\)`));
  const started = await release({ moveOpen: true });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const next = projectMilestones(store, project).find(item => item.version === '1.0.2');
  assert.equal(next.line, 'release/1.0');
  assert.equal(store.task(later).release.version, '1.0.2', 'The open story moved to the next milestone on its line.');
  // The planner drafts the notes from the integrated story; the director accepts them, which releases.
  const notes = started.data.task;
  assert.equal(notes.title, 'Draft the 1.0.1 release notes');
  assert.equal(
    notes.workerId,
    developmentOrganization(store.organization()).kindOwners['studio-development:breakdown'],
  );
  assert.match(notes.brief, new RegExp(`- ${c.taskId}: Improve fix`));
  await c.wait(notes.id);
  // The release's tests run where the director chose for candidate tests, as a story's do: here, without a sandbox.
  const chosen = store.organization();
  chosen.testSandbox = 'none';
  store.setOrganization(chosen);
  await c.accept(notes.id);
  await waitFor(
    () =>
      ['released', 'rejected', 'needs-reconciliation'].includes(milestone(c, fix.id).release?.state) &&
      !c.app.runner.sourceIntegrationRun,
    'the release to settle',
    { detail: () => JSON.stringify(milestone(c, fix.id).release) },
  );
  const done = milestone(c, fix.id);
  assert.equal(done.release.state, 'released', JSON.stringify(done.release));
  assert.equal(done.state, 'released');
  assert.equal(done.release.tag, 'v1.0.1');
  assert.deepEqual(done.release.configuration, { testSandbox: 'none' });
  const tip = git(c.root, ['rev-parse', 'refs/heads/release/1.0']);
  assert.equal(tip, done.release.commit);
  assert.equal(git(c.root, ['rev-parse', `${tip}~1`]), integration.commit);
  assert.equal(git(c.root, ['rev-parse', 'v1.0.1^{commit}']), tip);
  assert.equal(git(c.root, ['cat-file', '-t', 'v1.0.1']), 'tag', 'An annotated tag.');
  assert.match(git(c.root, ['show', `${tip}:package.json`]), /"version": "1\.0\.1"/);
  assert.match(
    git(c.root, ['show', `${tip}:RELEASE-NOTES.md`]),
    /^# Release notes\n\n## 1\.0\.1\n\n- Fixture notes for 1\.0\.1\./,
  );
  assert.match(git(c.root, ['log', '-1', '--format=%B', tip]), /^Release 1\.0\.1\n/);
  assert.equal(git(c.root, ['symbolic-ref', '--short', 'HEAD']), 'main', 'The folder keeps its branch.');
  assert.equal(store.leases().length, 0);
  assert.ok(
    store.events().some(event => event.kind === 'release_done' && /tagged v1\.0\.1\. Push it/.test(event.message)),
  );
  // Push asks for confirmation, needs a remote, and then sends the line and the tag.
  const push = data => c.request(`/api/projects/${project}/milestones/${fix.id}/push`, { projectId: project, ...data });
  assert.match((await push({})).data.error, /Confirm the push/);
  assert.match((await push({ confirm: true })).data.error, /no remote to push to/);
  const remote = path.join(c.directory, 'remote.git');
  git(c.directory, ['init', '--quiet', '--bare', remote]);
  git(c.root, ['remote', 'add', 'upstream', remote]);
  git(c.root, ['remote', 'add', 'mirror', remote]);
  assert.match((await push({ confirm: true })).data.error, /several remotes and none is origin/);
  git(c.root, ['remote', 'rename', 'upstream', 'origin']);
  const pushed = await push({ confirm: true });
  if (pushesToAFolder(c.directory)) {
    assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
    assert.equal(pushed.data.pushed.remote, 'origin');
    assert.equal(git(remote, ['rev-parse', 'refs/heads/release/1.0']), tip);
    assert.equal(git(remote, ['rev-parse', 'refs/tags/v1.0.1^{commit}']), tip);
    assert.throws(
      () => git(remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']),
      'Only the released line goes.',
    );
  } else {
    assert.equal(pushed.status, 400);
    assert.match(
      pushed.data.error,
      /^Git could not push release\/1\.0 and v1\.0\.1 to origin: .+ Run it yourself with git push origin release\/1\.0 v1\.0\.1\.$/s,
    );
    assert.equal(milestone(c, fix.id).release.pushed, undefined, 'A refused push records nothing.');
  }
  assert.match((await release({})).data.error, /already released/);
});

test("a release's notes name the fixes carried to its line from another since its last release, once", async t => {
  const c = await released(t),
    store = c.app.store;
  await make(c, '1.0.1');
  const made = await c.request(`/api/projects/${project}/milestones`, {
    projectId: project,
    version: '1.1.0',
    goal: 'New features.',
  });
  const feature = made.data.milestone;
  c.taskId = await c.propose('feature');
  assert.equal((await move(c, c.taskId, feature.id)).status, 200);
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  await c.settled(review, ['integrated']);
  // A fix of 1.0.1 carried to main, as the carry flow records one: its release names the line, not a milestone.
  const { workflowReference, runReference, proposalReference, ...base } = store.task(c.taskId);
  store.putTask({
    ...base,
    id: 'T-carried',
    title: 'Carry to main: Accept a number written as text',
    brief: 'Marking an item done accepts its number written as text.',
    carryOf: { storyId: 'T-fix', line: 'main' },
    release: { line: 'main', by: { type: 'carry', storyId: 'T-fix' } },
  });
  const started = await c.request(`/api/projects/${project}/milestones/${feature.id}/release`, { projectId: project });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const { brief } = started.data.task;
  assert.match(brief, new RegExp(`- ${c.taskId}: Improve feature`));
  assert.match(
    brief,
    /carried to this one; say so:\n- T-carried: Carry to main: Accept a number written as text \(Marking an item done/,
  );
  assert.match(brief, /whose goal is: New features\. Start with/, 'The goal ends the sentence with one full stop.');
  assert.deepEqual(milestone(c, feature.id).release.carried, ['T-carried']);
});

test('the first release of a new major moves the older major to a line of its own, and its later minors land there', async t => {
  const c = await released(t),
    store = c.app.store;
  const next = await make(c, '1.1.0');
  assert.equal(next.line, null);
  const major = await make(c, '2.0.0');
  assert.equal(major.line, null, '2.0 is made on the newest line.');
  assert.deepEqual(
    store.project(project).lines.map(line => line.branch),
    ['release/1.x', 'main'],
  );
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.x']), git(c.root, ['rev-parse', 'main']));
  assert.equal(projectMilestones(store, project).find(item => item.id === next.id).line, 'release/1.x');
  assert.equal((await make(c, '1.2.0')).line, 'release/1.x');
  assert.equal((await make(c, '2.1.0')).line, null);
  assert.ok(
    store
      .events()
      .some(event => event.kind === 'major_started' && /1\.x continues on release\/1\.x/.test(event.message)),
  );
});

// Events of a kind, read from the records themselves (the store's list keeps only the latest ones).
const count = (store, kind) => store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind=?').get(kind).n;
const tick = () => new Promise(resolve => setImmediate(resolve));
// 1.0.1, with a fix integrated on release/1.0, whose notes the director accepted while the project was paused.
async function pausedRelease(t) {
  const c = await released(t),
    store = c.app.store,
    fix = await make(c, '1.0.1');
  c.taskId = await c.propose('fix', { branch: 'release/1.0' });
  assert.equal((await move(c, c.taskId, fix.id)).status, 200);
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  const integration = await c.settled(review, ['integrated']);
  const started = await c.request(`/api/projects/${project}/milestones/${fix.id}/release`, { projectId: project });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const notes = started.data.task;
  await c.wait(notes.id);
  const chosen = store.organization();
  chosen.testSandbox = 'none';
  store.setOrganization(chosen);
  const pipeline = action => c.request('/api/pipeline', { projectId: project, action });
  assert.equal((await pipeline('pause')).status, 200);
  await c.accept(notes.id);
  assert.equal(milestone(c, fix.id).release.state, 'ready');
  return { c, fix, notes, pipeline, line: integration.commit };
}
// While the project is held, its release stays ready across tries and the settling of other work, and never starts.
async function stillReady(c, fix, notes, line) {
  for (let i = 0; i < 2; i++) {
    c.app.runner.autonomy.tryReleases();
    c.app.runner.autonomy.settled(notes.id);
    await tick();
  }
  assert.equal(milestone(c, fix.id).release.state, 'ready', JSON.stringify(milestone(c, fix.id).release));
  assert.equal(count(c.app.store, 'release_verifying'), 0);
  assert.ok(!c.app.runner.sourceIntegrationRun);
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), line, 'release/1.0 is unchanged.');
  assert.equal(git(c.root, ['tag', '--list', 'v1.0.1']), '', 'Nothing is tagged.');
}
// After the Resume it runs once: release/1.0 gets its one commit, tagged once.
async function releasedOnce(c, fix, line) {
  await waitFor(
    () =>
      ['released', 'rejected', 'needs-reconciliation'].includes(milestone(c, fix.id).release?.state) &&
      !c.app.runner.sourceIntegrationRun,
    'the release to settle',
    { detail: () => JSON.stringify(milestone(c, fix.id).release) },
  );
  const done = milestone(c, fix.id);
  assert.equal(done.release.state, 'released', JSON.stringify(done.release));
  c.app.runner.autonomy.tryReleases();
  await tick();
  assert.equal(count(c.app.store, 'release_verifying'), 1);
  assert.equal(count(c.app.store, 'release_done'), 1);
  const tip = git(c.root, ['rev-parse', 'refs/heads/release/1.0']);
  assert.equal(tip, done.release.commit);
  assert.equal(git(c.root, ['rev-list', '--count', `${line}..${tip}`]), '1');
  assert.equal(git(c.root, ['tag', '--list', 'v1.0.1']), 'v1.0.1');
  assert.equal(git(c.root, ['rev-parse', 'v1.0.1^{commit}']), tip);
  assert.equal(c.app.store.leases().length, 0);
}

test("a paused project's ready release waits for the director's Resume, which starts it once", async t => {
  const { c, fix, notes, pipeline, line } = await pausedRelease(t);
  await stillReady(c, fix, notes, line);
  assert.equal((await pipeline('resume')).status, 200);
  await releasedOnce(c, fix, line);
});

test("a release the controller's stop cut off while it was tested holds its project through the restart, and runs once after Resume", async t => {
  const { c, fix, notes, pipeline, line } = await pausedRelease(t);
  let store = c.app.store;
  // The stop came while the release was being tested, as runRelease records one, in a project that was running.
  const milestones = projectMilestones(store, project),
    release = milestones.find(item => item.id === fix.id).release;
  Object.assign(release, {
    id: `source-release:${project}:${fix.id}`,
    state: 'verifying',
    startedAt: new Date().toISOString(),
  });
  store.tx(() => {
    store.claim(sourceResources(store, store.task(notes.id)), release.id);
    store.putSetting(`milestones:${project}`, milestones);
  });
  const running = store.project(project);
  running.dispatchPaused = false;
  store.putProject(running);
  await c.app.close();
  await c.reopen();
  store = c.app.store;
  assert.ok(!store.tasks().some(task => task.queued), 'The project has no queued work to hold.');
  const held = store.project(project);
  assert.deepEqual([held.dispatchPaused, held.restartPaused], [true, true]);
  const paused = store.db
    .prepare("SELECT seq, message FROM events WHERE kind='pipeline_paused' AND message LIKE 'Controller restarted%'")
    .all();
  assert.deepEqual(
    paused.map(event => [event.message, store.setting('event-project:' + event.seq)]),
    [
      [
        'Controller restarted while a release was running. The project is held; the release runs again on its own when you resume it.',
        project,
      ],
    ],
  );
  const interrupted = store.db.prepare("SELECT message FROM events WHERE kind='release_interrupted'").all();
  assert.deepEqual(
    interrupted.map(event => event.message),
    [
      'The release of 1.0.1 was stopped when the controller stopped (during verifying); it runs again on its own when the project is resumed.',
    ],
  );
  assert.doesNotMatch(interrupted[0].message, /release it again/);
  assert.equal(store.leases().length, 0, 'Its resources are released at restart, as before.');
  await stillReady(c, fix, notes, line);
  assert.equal((await pipeline('resume')).status, 200);
  await releasedOnce(c, fix, line);
});

test("a release the controller's stop cut off waits for the project's Resume", () => {
  const stand = dispatchPaused => {
    const milestones = [
      {
        id: 'milestone-a',
        version: '1.0.1',
        state: 'open',
        release: {
          id: 'source-release:p:milestone-a',
          state: 'verifying',
          root: '/r',
          repository: { branch: 'release/1.0' },
        },
      },
    ];
    return {
      events: [],
      records: { p: { id: 'p', dispatchPaused } },
      projects() {
        return Object.values(this.records).map(record => structuredClone(record));
      },
      project(id) {
        return structuredClone(this.records[id]);
      },
      putProject(record) {
        this.records[record.id] = record;
      },
      setting: () => milestones,
      putSetting(key, value) {
        this.saved = [key, value];
      },
      release() {},
      event(kind, taskId, attemptId, text, projectId) {
        this.events.push({ kind, text, projectId });
      },
    };
  };
  const store = stand(false),
    runtime = { store };
  interruptedReleases(runtime);
  assert.deepEqual(store.saved[0], 'milestones:p');
  assert.deepEqual([store.saved[1][0].release.state, store.saved[1][0].release.interrupted], ['ready', 'verifying']);
  assert.deepEqual(
    store.events.map(event => [event.kind, event.projectId]),
    [
      ['release_interrupted', 'p'],
      ['pipeline_paused', 'p'],
    ],
  );
  assert.equal(
    store.events[0].text,
    'The release of 1.0.1 was stopped when the controller stopped (during verifying); it runs again on its own when the project is resumed.',
  );
  assert.doesNotMatch(store.events[0].text, /release it again|carry the fix again/);
  // The project is held with the restart's mark, and remembered so a planned restart does not lift it.
  assert.deepEqual(store.records.p, { id: 'p', dispatchPaused: true, restartPaused: true });
  assert.deepEqual([...runtime.interruptedHolds], ['p']);
  // A project the director paused keeps their pause, unmarked, and no pause is recorded for it.
  const theirs = stand(true);
  interruptedReleases({ store: theirs });
  assert.deepEqual(theirs.records.p, { id: 'p', dispatchPaused: true });
  assert.deepEqual(
    theirs.events.map(event => event.kind),
    ['release_interrupted'],
  );
});

test('a real release stopped after saving released recovers its unfinished shipping from the reopened store', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    store = c.app.store,
    runner = c.app.runner;
  saveProjectOrganization(store, runner.registries, project, developmentOrganization(store.organization()));
  for (const task of store.tasks().filter(task => task.status === 'ready'))
    store.putTask({ ...task, status: 'cancelled', queued: false });
  fs.writeFileSync(path.join(c.root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  git(c.root, ['commit', '--quiet', '-am', 'Version 1.0.0']);
  git(c.root, ['tag', 'v1.0.0']);
  const next = makeMilestone(store, project, runner, { version: '1.1.0' });
  useVersionLines(store, project, runner, { shipsTo: 'main' });
  // Accepted notes and measured verification are model-free fixtures; runRelease performs the real local release.
  const notes = store.task('checked-task'),
    attempt = store.attempt('checked-attempt');
  store.putTask({ ...notes, status: 'done', acceptedAttemptId: attempt.id });
  fs.writeFileSync(path.join(attempt.outputFolder, 'release-notes.md'), '## 1.1.0\n\n- Recover shipping.\n');
  attempt.artifacts = [{ path: 'release-notes.md' }];
  store.updateAttempt(attempt);
  const milestones = projectMilestones(store, project);
  milestones.find(item => item.id === next.id).release = {
    state: 'ready',
    notesTaskId: notes.id,
    tag: 'v1.1.0',
    line: 'release/1.1',
  };
  store.putSetting(`milestones:${project}`, milestones);
  const org = store.organization();
  org.testSandbox = 'none';
  store.setOrganization(org);
  const main = git(c.root, ['rev-parse', 'main']),
    stop = new Error('Fixture stop immediately after the released transaction'),
    tx = store.tx.bind(store),
    put = store.putSetting.bind(store);
  let stopped = false;
  const writes = t.mock.method(store, 'putSetting', (...args) => {
    if (stopped) throw stop; // No catch handler may write after this simulated process stop.
    return put(...args);
  });
  const transactions = t.mock.method(store, 'tx', fn => {
    const result = tx(fn);
    if (milestone(c, next.id).release.state === 'released') {
      stopped = true;
      throw stop;
    }
    return result;
  });
  runRelease(runner, project, next.id);
  await assert.rejects(runner.sourceIntegrationRun.promise, error => error === stop);
  transactions.mock.restore();
  writes.mock.restore();
  const saved = milestone(c, next.id);
  assert.equal(saved.state, 'released');
  assert.equal(saved.release.state, 'released');
  assert.equal(saved.release.shipped?.pending, true);
  assert.equal(store.leases().length, 0);
  assert.equal(git(c.root, ['rev-parse', 'main']), main);
  const restarted = new Store(store.directory);
  try {
    interruptedReleases({ store: restarted });
    const done = projectMilestones(restarted, project).find(item => item.id === next.id);
    assert.equal(done.release.shipped?.commit, saved.release.commit, JSON.stringify(done.release));
    const refs = git(c.root, ['show-ref']);
    interruptedReleases({ store: restarted });
    assert.equal(git(c.root, ['show-ref']), refs);
    assert.equal(git(c.root, ['rev-parse', 'v1.1.0^{commit}']), saved.release.commit);
    assert.equal(done.line, saved.line);
    assert.equal(done.release.tag, saved.release.tag);
    assert.equal(done.release.pushed, undefined);
  } finally {
    restarted.close();
  }
});
