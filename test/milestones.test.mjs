// Milestones (1.1 step 2a, Decision MP-028): a milestone is a planned release, and every idea and story carries its
// release, picked with no extra step from the director's pick, a version the idea names, or the next release. A minor
// or major release lands on the newest line; a patch on release/x.y, made from the newest tag of its series. A story
// moves until it starts. Ideas wait in a milestone, sent by the director or by a setting when their line is free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { projectMilestones } from '../src/connectors/source-milestones.mjs';
import { autonomyPolicy } from '../src/core/autonomy.mjs';
import { runIdOf } from '../src/core/graph.mjs';

// The fixture repository's history: 1.0.0 and 1.1.0 released, and main moved on toward 1.2.
const release = c => {
  git(c.root, ['tag', 'v1.0.0']);
  fs.writeFileSync(path.join(c.root, 'README.md'), '// 1.1 work\n');
  git(c.root, ['commit', '--quiet', '-am', '1.1 work']);
  git(c.root, ['tag', 'v1.1.0']);
  fs.writeFileSync(path.join(c.root, 'README.md'), '// 1.2 work\n');
  git(c.root, ['commit', '--quiet', '-am', '1.2 work']);
};
const patch = async (c, route, data) => {
  const result = await fetch(c.origin + route, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
    body: JSON.stringify(data),
  });
  return { status: result.status, data: await result.json() };
};
const tagCommit = (c, tag) => git(c.root, ['rev-parse', `${tag}^{commit}`]);
// Studio desk's own development project, whose checks and breakdown take ideas, on the fixture repository. Nothing in
// it dispatches: what its checks would measure is read from their type's own preparation.
async function development(c) {
  const made = await c.request('/api/studio-development');
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const project = made.data.project.id;
  c.app.store.putProject({ ...c.app.store.project(project), dispatchPaused: true });
  return project;
}
const checksBase = (c, runId) => {
  const task = c.app.store.tasks().find(item => item.workflowReference?.runId === runId);
  return c.app.runner.workflows
    .get('studio-development:checks')
    .prepareAttempt({ runtime: c.app.runner, store: c.app.store, task }).sourceCheck.base;
};

test('a milestone lands on the newest line, or a patch on its release line made from the newest tag of its series', async t => {
  const c = await setup(t),
    store = c.app.store,
    project = 'project-legacy';
  release(c);
  const make = data => c.request(`/api/projects/${project}/milestones`, { projectId: project, ...data });
  let made = await make({ version: '1.2.0', goal: 'Faster boards' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.milestone.line, null);
  assert.equal(made.data.milestone.goal, 'Faster boards');
  assert.equal(store.project(project).lines, undefined, 'A release on the newest line needs no second line.');
  made = await make({ version: '1.1.1' });
  assert.equal(made.data.milestone.line, 'release/1.1');
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.1']), tagCommit(c, 'v1.1.0'));
  made = await make({ version: '1.0.1' });
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), tagCommit(c, 'v1.0.0'));
  assert.deepEqual(
    store.project(project).lines.map(line => line.branch),
    ['release/1.0', 'release/1.1', 'main'],
    'Release lines stay oldest first, whatever order they were made in.',
  );
  assert.equal(git(c.root, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(
    (await make({ version: '1.0.1' })).data.milestone.id,
    made.data.milestone.id,
    'A version has one milestone.',
  );
  for (const [version, error] of [
    ['1.1.0', /1\.1\.0 is already released/],
    ['0.9.0', /0\.9\.0 is older than 1\.1\.0, the newest release/],
    ['1.3.1', /1\.3 has no release yet, so 1\.3\.1 has nothing to fix/],
    ['1.0', /version such as 1\.2\.0/],
  ]) {
    const refused = await make({ version });
    assert.equal(refused.status, 400, version);
    assert.match(refused.data.error, error);
  }
  const edited = await patch(c, `/api/projects/${project}/milestones`, {
    projectId: project,
    id: made.data.milestone.id,
    goal: 'Security fixes',
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.milestone.goal, 'Security fixes');
  assert.ok(
    store
      .events()
      .some(event => event.kind === 'milestone_made' && /1\.1\.1 made on release\/1\.1/.test(event.message)),
  );
});

test('an idea lands on the release the director picks, one its words name, or the next; a release named before it exists is made', async t => {
  const c = await setup(t),
    store = c.app.store,
    project = await development(c),
    send = data => c.request('/api/studio-development/intake', { projectId: project, ...data }),
    runOf = sent => {
      assert.equal(sent.status, 201, JSON.stringify(sent.data));
      return store.run(sent.data.runId);
    };
  // Before the project has a release, a version in an idea is nobody's release.
  assert.equal(runOf(await send({ idea: 'Upgrade the parser to 2.4.1.' })).release, undefined);
  release(c);
  const next = (await c.request(`/api/projects/${project}/milestones`, { projectId: project, version: '1.2.0' })).data
    .milestone;
  // A short version in passing, a library's version, or none: the next release, on the newest line.
  for (const idea of ['Since 1.0 the board is slow.', 'Upgrade lodash to 4.17.21.', 'Make the board faster.']) {
    const run = runOf(await send({ idea }));
    assert.deepEqual(run.release, { milestoneId: next.id, version: '1.2.0', by: { type: 'default' } }, idea);
    assert.equal(run.line, undefined, 'Nothing has added a second line yet.');
  }
  // Words without a version need nothing from the repository, so an idea is taken even where git cannot read its tags,
  // as in the test sandbox, where a worktree's git folder is out of reach.
  fs.renameSync(path.join(c.root, '.git'), path.join(c.root, '.git-away'));
  try {
    const run = runOf(await send({ idea: 'Make the board faster, again.' }));
    assert.equal(run.release.version, '1.2.0');
  } finally {
    fs.renameSync(path.join(c.root, '.git-away'), path.join(c.root, '.git'));
  }
  // The New idea box hears the release an idea's words name as the director writes, and nothing is made by asking.
  const preview = async idea =>
    (await (await fetch(`${c.origin}/api/projects/${project}/releases/named?idea=${encodeURIComponent(idea)}`)).json())
      .named;
  const linesBefore = structuredClone(store.project(project).lines);
  assert.equal(await preview('Make the board faster.'), null);
  assert.deepEqual(await preview('Security fix for 1.1.3: tokens never expire.'), {
    version: '1.1.3',
    named: '1.1.3',
    line: 'release/1.1',
  });
  assert.deepEqual(await preview('A fix for 1.1.0.'), { version: '1.1.1', named: '1.1.0', line: 'release/1.1' });
  assert.equal(projectMilestones(store, project).length, 1, 'Asking makes no milestone.');
  assert.deepEqual(store.project(project).lines, linesBefore, 'Asking makes no line.');
  // A full version the idea names is made, with its release line from the newest tag of its series.
  let sent = await send({ idea: 'Security fix for 1.1.3: tokens never expire.' }),
    run = runOf(sent);
  const named = projectMilestones(store, project).find(item => item.version === '1.1.3');
  assert.deepEqual(await preview('Security fix for 1.1.3.'), {
    version: '1.1.3',
    named: '1.1.3',
    line: 'release/1.1',
    milestoneId: named.id,
  });
  // The idea's own view carries its release and line, for its chip on the idea page.
  const live = await (await fetch(`${c.origin}/api/projects/${project}/live`)).json(),
    view = live.runs.find(item => item.id === sent.data.runId);
  assert.deepEqual([view.release, view.line], [run.release, 'release/1.1']);
  assert.deepEqual(run.release, { milestoneId: named.id, version: '1.1.3', by: { type: 'idea', named: '1.1.3' } });
  assert.equal(run.line, 'release/1.1');
  assert.deepEqual(sent.data.release, run.release);
  assert.deepEqual(checksBase(c, sent.data.runId), { commit: tagCommit(c, 'v1.1.0'), branch: 'release/1.1' });
  assert.ok(
    store
      .events()
      .some(
        event =>
          event.kind === 'workflow_started' &&
          event.message.endsWith('It is for 1.1.3 on release/1.1, which the idea names ("1.1.3").'),
      ),
  );
  // A released version means its next patch.
  run = runOf(await send({ idea: 'The crash in 1.0.0 is back.' }));
  assert.equal(run.release.version, '1.0.1');
  assert.equal(run.line, 'release/1.0');
  // Now that 1.0 has a release line, a short mention of it is its open milestone.
  assert.equal(runOf(await send({ idea: 'Since 1.0 the board is slow.' })).release.version, '1.0.1');
  // The director's pick wins over the words, and may name a release that does not exist yet.
  run = runOf(await send({ idea: 'Security fix for 1.1.3, on the next release instead.', milestone: next.id }));
  assert.deepEqual(run.release, { milestoneId: next.id, version: '1.2.0', by: { type: 'director' } });
  assert.equal(run.line, 'main');
  run = runOf(await send({ idea: 'Another 1.0 fix.', milestone: '1.0.2' }));
  assert.equal(run.release.version, '1.0.2');
  assert.equal(run.line, 'release/1.0');
  assert.equal(run.release.by.type, 'director');
  run = runOf(await send({ idea: 'Backport the parser fix.', line: 'release/1.1' }));
  assert.deepEqual(run.release, { milestoneId: named.id, version: '1.1.3', by: { type: 'director' } });
  for (const [data, error] of [
    [{ milestone: '1.1.0' }, /1\.1\.0 is already released/],
    [{ milestone: 'milestone-none' }, /milestone-none is not a milestone of this project/],
    [{ milestone: next.id, line: 'release/1.1' }, /lands on the newest line, not release\/1\.1/],
  ]) {
    const refused = await send({ idea: 'Refused.', ...data });
    assert.equal(refused.status, 400, JSON.stringify(data));
    assert.match(refused.data.error, error);
  }
});

test('a story moves to another release until it starts, and to another line only when no story of its idea is linked to it', async t => {
  const c = await setup(t),
    store = c.app.store,
    project = 'project-legacy',
    // Two linked stories of one idea, planned before the releases (the fixture's breakdown measured that source).
    { ids } = await c.breakdown();
  release(c);
  const make = async version =>
      (await c.request(`/api/projects/${project}/milestones`, { projectId: project, version })).data.milestone,
    move = (id, milestone) => patch(c, `/api/tasks/${id}`, { projectId: project, release: milestone });
  const next = await make('1.2.0'),
    fix = await make('1.1.1'),
    story = await c.propose('fix');
  const moved = await move(story, fix.id);
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const { at, ...release_ } = store.task(story).release;
  assert.deepEqual(release_, {
    milestoneId: fix.id,
    version: '1.1.1',
    by: { type: 'director' },
    line: 'release/1.1',
  });
  c.taskId = story;
  await c.start();
  const a = await c.wait(story);
  assert.deepEqual(a.sourceChange.base, { commit: tagCommit(c, 'v1.1.0'), branch: 'release/1.1' });
  assert.match((await move(story, next.id)).data.error, /has started, so its work stays on its branch/);
  // Linked stories cannot move to another line one at a time; on their own line a release changes freely.
  assert.match((await move(ids[1], fix.id)).data.error, new RegExp(`linked to ${ids[0]} on its branch`));
  const later = await make('1.3.0');
  assert.equal((await move(ids[1], later.id)).status, 200);
  assert.equal(store.task(ids[1]).release.version, '1.3.0');
  assert.match((await move(ids[1], 'milestone-none')).data.error, /not a milestone of this project/);
});

test('ideas wait in a milestone and are sent by the director or, with the setting on, when their line is free', async t => {
  const c = await setup(t),
    store = c.app.store,
    project = await development(c);
  release(c);
  const milestone = (await c.request(`/api/projects/${project}/milestones`, { projectId: project, version: '1.2.0' }))
      .data.milestone,
    ideas = `/api/projects/${project}/milestones/${milestone.id}/ideas`,
    write = async idea => {
      const written = await c.request(ideas, { projectId: project, idea });
      assert.equal(written.status, 201, JSON.stringify(written.data));
      return written.data;
    },
    waiting = () =>
      projectMilestones(store, project)
        .find(item => item.id === milestone.id)
        .waiting.map(item => item.id);
  const first = await write('Make the board faster.');
  assert.deepEqual(waiting(), [first.id]);
  // The director sends it; it keeps the milestone the director wrote it into.
  const sent = await c.request(`${ideas}/${first.id}/send`, { projectId: project });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.deepEqual(store.run(sent.data.runId).release, {
    milestoneId: milestone.id,
    version: '1.2.0',
    by: { type: 'director' },
    waiting: { id: first.id, by: { type: 'director' } },
  });
  assert.equal(store.run(sent.data.runId).brief, 'Make the board faster.');
  assert.deepEqual(waiting(), []);
  const second = await write('Show the release on each card.'),
    third = await write('Drop the old forms.');
  assert.equal((await c.request(`${ideas}/${third.id}/remove`, { projectId: project })).status, 200);
  assert.deepEqual(waiting(), [second.id]);
  assert.match((await c.request(`${ideas}/${third.id}/send`, { projectId: project })).data.error, /not found/);
  // With the setting on, the next waiting idea goes only when nothing is open on its line.
  const saved = await c.request(`/api/projects/${project}/autonomy`, {
    projectId: project,
    expectedRevision: autonomyPolicy(store, project).revision,
    enabled: true,
    kinds: {},
    retries: 0,
    sendWaiting: true,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.sendWaiting, true);
  assert.deepEqual(waiting(), [second.id], 'The first idea is still open on the newest line.');
  for (const task of store.tasks().filter(item => runIdOf(item) === sent.data.runId))
    store.putTask({ ...task, status: 'cancelled' });
  c.app.runner.autonomy.sendWaiting(project);
  assert.deepEqual(waiting(), []);
  const automatic = store.runs(project).find(run => run.release?.waiting?.id === second.id);
  assert.deepEqual(automatic.release.waiting.by, { type: 'policy', revision: saved.data.revision });
  // A policy saved without the field keeps it; saved off, nothing more is sent.
  const again = await c.request(`/api/projects/${project}/autonomy`, {
    projectId: project,
    expectedRevision: saved.data.revision,
    enabled: true,
    kinds: {},
    retries: 0,
  });
  assert.equal(again.data.sendWaiting, true);
  const off = await c.request(`/api/projects/${project}/autonomy`, {
    projectId: project,
    expectedRevision: again.data.revision,
    enabled: true,
    kinds: {},
    retries: 0,
    sendWaiting: false,
  });
  assert.equal(off.data.sendWaiting, undefined);
});
