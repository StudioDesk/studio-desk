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
import { projectMilestones } from '../src/connectors/source-milestones.mjs';
import { interruptedReleases } from '../src/connectors/source-releases.mjs';
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

test("a release the controller's stop cut off waits to run again", () => {
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
    ],
    events = [],
    store = {
      projects: () => [{ id: 'p' }],
      setting: () => milestones,
      putSetting(key, value) {
        this.saved = [key, value];
      },
      release() {},
      event: (kind, taskId, attemptId, text) => events.push(text),
    };
  interruptedReleases({ store });
  assert.deepEqual(store.saved[0], 'milestones:p');
  assert.deepEqual([store.saved[1][0].release.state, store.saved[1][0].release.interrupted], ['ready', 'verifying']);
  assert.match(
    events[0],
    /The release of 1\.0\.1 was stopped when the controller stopped \(during verifying\); release it again\./,
  );
});
