// Release lines (1.1 step 1, Decision MP-028): a project keeps more than one branch, an idea lands on the line it
// names, and its stories start from and integrate onto that line. Git keeps every branch: a line the project's folder
// does not have checked out is measured at its tip commit and moved with git's compare-and-swap, and the folder and
// its checked-out branch are left alone. A project with no recorded lines works exactly as before (the other source
// tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { setup } from './source-story-setup.mjs';
import { hash } from '../src/core/contracts.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import {
  sourceIntegrationResources,
  sourceStoriesInFlight,
  sourceStoryInFlight,
} from '../src/connectors/source-changes.mjs';
import { measureLine } from '../src/connectors/source-lines.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';

const formatter = fileURLToPath(new URL('./fixture-format.mjs', import.meta.url));
// The fixture's stories belong to the legacy project; a test may work on another (c.projectId).
const projectOf = c => c.projectId ?? 'project-legacy';
const retire = async (c, data) => {
  const result = await fetch(`${c.origin}/api/projects/${projectOf(c)}/lines`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
    body: JSON.stringify({ projectId: projectOf(c), ...data }),
  });
  return { status: result.status, data: await result.json() };
};
const addLine = (c, data) => c.request(`/api/projects/${projectOf(c)}/lines`, { projectId: projectOf(c), ...data });
const keepLine = async (c, branch) => {
  const added = await addLine(c, { branch });
  assert.equal(added.status, 201, JSON.stringify(added.data));
};
const worktrees = root => git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm).length;
// What a project's next checks would measure, without running them: their type's own preparation.
const checksBase = (c, runId) => {
  const task = c.app.store.tasks().find(item => item.workflowReference?.runId === runId);
  return c.app.runner.workflows
    .get('studio-development:checks')
    .prepareAttempt({ runtime: c.app.runner, store: c.app.store, task }).sourceCheck.base;
};

test('a project adds release lines from a tag or a branch, retires and keeps them, and an idea lands on the line it names', async t => {
  const c = await setup(t),
    store = c.app.store,
    made = await c.request('/api/studio-development');
  // Studio desk's own development project, whose checks and breakdown take ideas, on the fixture repository.
  assert.equal(made.status, 201, JSON.stringify(made.data));
  c.projectId = made.data.project.id;
  // Nothing dispatches: the checks' preparation is read directly.
  store.putProject({ ...store.project(c.projectId), dispatchPaused: true });
  const intake = data =>
    c.request('/api/studio-development/intake', { projectId: c.projectId, idea: 'Fix the login timeout.', ...data });
  // Before any line is recorded, an idea lands on whatever the folder has checked out, as in 1.0.
  let sent = await intake({});
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(store.run(sent.data.runId).line, undefined);
  assert.deepEqual(checksBase(c, sent.data.runId), { commit: git(c.root, ['rev-parse', 'HEAD']), branch: 'main' });
  assert.equal((await intake({ line: 'main' })).status, 201);
  assert.match((await intake({ line: 'release/1.0' })).data.error, /keeps one line/);

  git(c.root, ['tag', 'v1.0.0']);
  fs.writeFileSync(path.join(c.root, 'README.md'), '// Newer work on main\n');
  git(c.root, ['commit', '--quiet', '-am', 'Newer work on main']);
  let added = await addLine(c, { branch: 'release/1.0', from: 'v1.0.0' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.deepEqual(
    added.data.lines.map(line => [line.branch, line.state]),
    [
      ['release/1.0', 'maintained'],
      ['main', 'maintained'],
    ],
  );
  const released = git(c.root, ['rev-parse', 'v1.0.0^{commit}']);
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), released);
  assert.equal(git(c.root, ['symbolic-ref', '--short', 'HEAD']), 'main', 'The folder keeps its branch.');
  assert.ok(
    store
      .events()
      .some(event => event.kind === 'project_line' && /release\/1\.0 added from v1\.0\.0/.test(event.message)),
  );
  for (const [data, error] of [
    [{ branch: 'release/1.0' }, /release\/1\.0 is already a line of this project/],
    [{ branch: 'bad..name' }, /not a name git allows/],
    [{ branch: '-x' }, /branch name/],
    [{ branch: 'release/0.9', from: 'v0.9.0' }, /no tag, branch or commit named v0\.9\.0/],
    [{ branch: 'missing' }, /The repository has no branch named missing/],
    [{ branch: 'release/0.9', from: 'v1.0.0', extra: true }, /takes a branch and an optional starting point/],
  ]) {
    const refused = await addLine(c, data);
    assert.equal(refused.status, 400, JSON.stringify(data));
    assert.match(refused.data.error, error);
  }
  // An existing branch becomes a line without a starting point; with one, an existing name is refused.
  git(c.root, ['branch', 'release/0.9', released]);
  assert.match((await addLine(c, { branch: 'release/0.9', from: 'v1.0.0' })).data.error, /already exists/);
  added = await addLine(c, { branch: 'release/0.9' });
  assert.deepEqual(
    added.data.lines.map(line => line.branch),
    ['release/0.9', 'release/1.0', 'main'],
    'Release lines go before the newest one, oldest first whatever order they were made in (1.1 step 2a).',
  );
  // A line that is not a release line goes just before the newest one.
  git(c.root, ['branch', 'hotfix', released]);
  added = await addLine(c, { branch: 'hotfix' });
  assert.deepEqual(
    added.data.lines.map(line => line.branch),
    ['release/0.9', 'release/1.0', 'hotfix', 'main'],
  );

  // An idea lands on the line it names, or on the newest line.
  sent = await intake({ line: 'release/1.0' });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(store.run(sent.data.runId).line, 'release/1.0');
  assert.deepEqual(checksBase(c, sent.data.runId), { commit: released, branch: 'release/1.0' });
  sent = await intake({});
  assert.equal(store.run(sent.data.runId).line, 'main');
  assert.deepEqual(checksBase(c, sent.data.runId), { commit: git(c.root, ['rev-parse', 'HEAD']), branch: 'main' });
  assert.match((await intake({ line: 'feature' })).data.error, /feature is not a line of this project/);

  // A retired line takes no new idea until it is kept again; the newest line cannot be retired.
  let retired = await retire(c, { branch: 'release/0.9', retired: true });
  assert.equal(retired.status, 200, JSON.stringify(retired.data));
  assert.equal(retired.data.lines.find(line => line.branch === 'release/0.9').state, 'retired');
  assert.match((await intake({ line: 'release/0.9' })).data.error, /release\/0\.9 is retired/);
  assert.match((await retire(c, { branch: 'main', retired: true })).data.error, /newest line/);
  retired = await retire(c, { branch: 'release/0.9', retired: false });
  assert.equal(retired.data.lines.find(line => line.branch === 'release/0.9').state, 'maintained');
  assert.equal((await intake({ line: 'release/0.9' })).status, 201);
});

test('a story on a line that is not checked out starts from its tip and integrates there, leaving the folder alone', async t => {
  const c = await setup(t),
    store = c.app.store;
  git(c.root, ['branch', 'release/1.0']);
  await keepLine(c, 'release/1.0');
  // main moves on with work the release line does not have.
  fs.writeFileSync(path.join(c.root, 'README.md'), '// Only on main\n');
  git(c.root, ['commit', '--quiet', '-am', 'Newer work on main']);
  const mainTip = git(c.root, ['rev-parse', 'HEAD']),
    releaseTip = git(c.root, ['rev-parse', 'refs/heads/release/1.0']);
  c.taskId = await c.propose('fix', { branch: 'release/1.0' });
  await c.start();
  const a = await c.wait(c.taskId);
  assert.deepEqual(a.sourceChange.base, { commit: releaseTip, branch: 'release/1.0' });
  assert.equal(a.sourceWorktree.baseCommit, releaseTip);
  // The editor read the release line's files, not the folder's newer README.
  assert.equal(
    a.sourceChange.source.files.find(item => item.path === 'README.md').hash,
    hash('// Fixture source: README.md\n'),
  );
  assert.equal(worktrees(c.root), 1, 'No measurement worktree is left behind.');
  const review = await c.review(a);
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  const journal = await c.settled(review);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal));
  assert.deepEqual(journal.repository, {
    branch: 'release/1.0',
    head: releaseTip,
    live: false,
    commit: journal.commit,
  });
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), journal.commit);
  assert.equal(git(c.root, ['rev-parse', `${journal.commit}~1`]), releaseTip);
  assert.equal(git(c.root, ['show', `${journal.commit}:README.md`]), '// Fixture source: README.md');
  assert.match(git(c.root, ['show', `${journal.commit}:src/core/workflows.mjs`]), /formatted$/);
  // main and the folder are as they were.
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), mainTip);
  assert.equal(git(c.root, ['status', '--porcelain']), '');
  assert.doesNotMatch(fs.readFileSync(path.join(c.root, 'src/core/workflows.mjs'), 'utf8'), /formatted/);
  assert.ok(
    store
      .events()
      .some(
        event => event.kind === 'source_verifying' && /release\/1\.0 is unchanged until it passes/.test(event.message),
      ),
  );
  assert.equal(store.task(c.taskId).sourceStage.current, 'integrated');
});

test('each line holds its own story, so a fix on an older release does not wait for a feature on the newest line', async t => {
  const c = await setup(t),
    store = c.app.store,
    seeded = c.taskId;
  git(c.root, ['branch', 'release/1.0']);
  await keepLine(c, 'release/1.0');
  const feature = await c.propose('feature', { branch: 'main' }),
    fix = await c.propose('fix', { branch: 'release/1.0' }),
    next = await c.propose('next', { branch: 'release/1.0', files: ['src/core/projects.mjs'] });
  c.taskId = feature;
  await c.start();
  await c.wait(feature);
  // A story waiting for its review holds no place (October 29).
  assert.equal(sourceStoryInFlight(store, store.task(fix)), undefined);
  c.taskId = fix;
  await c.start();
  await c.wait(fix);
  c.taskId = next;
  await c.start();
  await c.wait(next);
  const last = await c.propose('last', { branch: 'release/1.0', files: ['src/core/projects.mjs'] });
  for (const id of [feature, fix, next]) assert.equal(store.task(id).status, 'review');
  assert.deepEqual(sourceStoriesInFlight(store, store.task(last)), []);
  // While two are built on release/1.0 in a studio of two attempts at once, one more on that line waits for one of
  // them, and main counts its own builds.
  const org = store.organization();
  org.maxParallel = 2;
  store.setOrganization(org);
  for (const id of [feature, fix, next]) store.putTask({ ...store.task(id), status: 'running' });
  assert.equal(sourceStoryInFlight(store, store.task(last))?.id, fix);
  assert.equal(
    c.app.runner.blockReason(store.task(last)),
    `Waiting for ${fix} (“Improve fix”) or ${next} (“Improve next”) to finish building: 2 source stories build on release/1.0 at once, as many as Attempts at the same time.`,
  );
  // A story whose checks recorded no line works on the newest one, where only the feature is built.
  assert.deepEqual(
    sourceStoriesInFlight(store, store.task(seeded)).map(item => item.id),
    [feature],
  );
});

test('integration onto a line refuses while a worktree has its branch checked out or it moved, and an interrupted one is reconciled from the line', async t => {
  const c = await setup(t),
    store = c.app.store;
  git(c.root, ['branch', 'release/1.0']);
  await keepLine(c, 'release/1.0');
  c.taskId = await c.propose('fix', { branch: 'release/1.0' });
  await c.start();
  const a = await c.wait(c.taskId),
    review = await c.review(a);
  await c.accept(review.taskId);
  const mainTip = git(c.root, ['rev-parse', 'HEAD']);
  // Another worktree has the branch checked out: moving it would leave that tree behind.
  const elsewhere = path.join(c.directory, 'other');
  git(c.root, ['worktree', 'add', '--quiet', elsewhere, 'release/1.0']);
  assert.equal((await c.integration(review)).status, 200);
  let journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.match(journal.error, /release\/1\.0 is checked out in .*other\. Studio desk moves a branch only/);
  git(c.root, ['worktree', 'remove', '--force', elsewhere]);
  // The branch moves during verification: the result was tested on the old tip, so it is not used.
  const move = `const { execFileSync } = require('child_process'),
    g = args => execFileSync('git', ['-C', ${JSON.stringify(c.root)}, ...args]).toString().trim(),
    tip = g(['rev-parse', 'refs/heads/release/1.0']);
  g(['update-ref', 'refs/heads/release/1.0', g(['commit-tree', tip + '^{tree}', '-p', tip, '-m', 'Moved'])]);`;
  c.app.runner.sourceFormatCommand = { executable: process.execPath, args: ['-e', move] };
  assert.equal((await c.integration(review)).status, 200);
  journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.match(journal.error, /release\/1\.0 moved during verification\. Approve integration again/);
  const moved = git(c.root, ['rev-parse', 'refs/heads/release/1.0']);
  c.app.runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'pass'] };
  assert.equal((await c.integration(review)).status, 200);
  const integrated = await c.settled(review);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  assert.equal(git(c.root, ['rev-parse', `${integrated.commit}~1`]), moved);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), mainTip);

  // The controller stopped after recording the integration commit, before its journal settled.
  const interrupt = () => {
    const attempt = c.app.store.attempt(review.id),
      { finishedAt, ...rest } = integrated;
    attempt.sourceIntegration = {
      ...rest,
      state: 'committing',
      repository: { branch: 'release/1.0', head: moved, live: false },
    };
    c.app.store.tx(() => {
      c.app.store.claim(sourceIntegrationResources, rest.id);
      c.app.store.updateAttempt(attempt);
    });
  };
  interrupt();
  await c.app.close();
  c.app = createStudio(c.options);
  await c.connect();
  c.app.runner.autonomy.attention(c.app.store.task(review.taskId), 'Reconcile this interrupted integration.');
  let reconciled = await c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'integrated', 'The commit is on the line, though not on the checked-out branch.');
  // Before the line moved: it is abandoned, and an edit in the folder, which is on another branch, is not asked about.
  git(c.root, ['update-ref', 'refs/heads/release/1.0', moved]);
  interrupt();
  fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// a local edit on main\n');
  c.app.runner.autonomy.attention(c.app.store.task(review.taskId), 'Reconcile this interrupted integration.');
  reconciled = await c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'abandoned');
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), moved);
  assert.equal(c.app.store.leases().length, 0);
});

test('a line that is not checked out is measured once per commit, in a worktree removed at once', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    parent = path.join(c.directory, 'measure');
  git(c.root, ['branch', 'release/1.0']);
  const first = measureLine(c.root, 'release/1.0', studioDeskProfile, parent);
  assert.equal(first.root, fs.realpathSync(c.root));
  assert.deepEqual(fs.readdirSync(parent), []);
  assert.equal(worktrees(c.root), 1);
  // The same commit is not checked out again; a new tip is.
  fs.rmSync(parent, { recursive: true });
  assert.deepEqual(measureLine(c.root, 'release/1.0', studioDeskProfile, parent), first);
  assert.equal(fs.existsSync(parent), false);
  const live = measureLine(c.root, 'main', studioDeskProfile, parent);
  assert.equal(live.sourceHash, first.sourceHash, 'The checked-out branch is measured in its folder.');
  assert.throws(() => measureLine(c.root, 'gone', studioDeskProfile, parent), /The branch gone no longer exists/);
});
