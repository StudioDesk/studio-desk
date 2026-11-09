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
import { makeMilestone, projectMilestones, useVersionLines } from '../src/connectors/source-milestones.mjs';
import { interruptedReleases, runRelease } from '../src/connectors/source-releases.mjs';
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
