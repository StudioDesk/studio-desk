// What the Releases page reads (1.1 step 6, MP-028): each line with its last release and what landed since, by the
// studio or by hand; each milestone with its ideas, stories and waiting ideas; the director's copy; and what the
// remote is known to have, without reaching it. Waiting ideas keep the order the director gives them and move between
// milestones; one that fails to send goes back to its place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { projectMilestones, restoreWaitingIdea, takeWaitingIdea } from '../src/connectors/source-milestones.mjs';

const project = 'project-legacy';
const make = async (c, version) => {
  const made = await c.request(`/api/projects/${project}/milestones`, { projectId: project, version });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data.milestone;
};
const overview = async c => {
  const result = await fetch(`${c.origin}/api/projects/${project}/releases`);
  assert.equal(result.status, 200);
  return result.json();
};

test('the Releases page reads each line, what landed on it since its last release, and each milestone with its work', async t => {
  const c = await setup(t),
    store = c.app.store;
  git(c.root, ['tag', 'v1.0.0']);
  const fix = await make(c, '1.0.1'),
    next = await make(c, '1.1.0');
  // A fix integrated on release/1.0 by the studio, and a commit by hand on main.
  c.taskId = await c.propose('fix', { branch: 'release/1.0' });
  const moved = await fetch(`${c.origin}/api/tasks/${c.taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
    body: JSON.stringify({ projectId: project, release: fix.id }),
  });
  assert.equal(moved.status, 200);
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  assert.equal((await c.settled(review)).state, 'integrated');
  fs.writeFileSync(path.join(c.root, 'README.md'), '// By hand\n');
  git(c.root, ['commit', '--quiet', '-am', 'A change by hand']);
  // The remote is known only from its tracking branches, and its address never shows a token.
  git(c.root, ['remote', 'add', 'origin', 'https://director:secret-token@example.invalid/studio.git']);
  git(c.root, ['update-ref', 'refs/remotes/origin/main', git(c.root, ['rev-parse', 'main~1'])]);
  const view = await overview(c);
  assert.equal(view.available, true);
  assert.deepEqual(view.copy, { branch: 'main', clean: true });
  assert.deepEqual(view.remote, { name: 'origin', url: 'https://example.invalid/studio.git' });
  assert.deepEqual(
    view.lines.map(line => [line.branch, line.newest, line.lastRelease?.name, line.landed.studio, line.landed.hand]),
    [
      ['release/1.0', false, 'v1.0.0', 1, 0],
      ['main', true, 'v1.0.0', 0, 1],
    ],
  );
  assert.equal(view.lines[1].landed.commits[0].subject, 'A change by hand');
  assert.deepEqual(view.lines[1].onRemote, { known: true, ahead: 1, behind: 0 });
  assert.deepEqual(view.lines[0].onRemote, { known: false });
  assert.deepEqual(
    view.milestones.map(item => [item.version, item.line]),
    [
      ['1.0.1', 'release/1.0'],
      ['1.1.0', 'main'],
    ],
  );
  const patch = view.milestones[0];
  assert.deepEqual(
    patch.movedIn.map(item => [item.id, item.integration, item.started]),
    [[c.taskId, 'integrated', true]],
    'A story moved into a milestone is listed there.',
  );
  assert.deepEqual(patch.movedIn[0].carries, [{ line: 'main', state: 'waiting' }]);
  // The story's page reads the same carry, so it can offer Carry to main and Not needed on main.
  const page = await (await fetch(`${c.origin}/api/tasks/${c.taskId}?projectId=${project}`)).json();
  assert.deepEqual(page.attempts.find(attempt => attempt.id === review.id).sourceCarries, [
    { line: 'main', state: 'waiting' },
  ]);
  assert.deepEqual(patch.counts, { ideas: 0, waiting: 0, stories: 1, integrated: 1, started: 0 });
  assert.equal(view.milestones[1].id, next.id);
  assert.deepEqual(view.tags, ['v1.0.0']);
  assert.equal(store.leases().length, 0);
});

test('waiting ideas keep the order the director gives them and move between milestones', async t => {
  const c = await setup(t),
    store = c.app.store;
  git(c.root, ['tag', 'v1.0.0']);
  const fix = await make(c, '1.0.1'),
    next = await make(c, '1.1.0');
  const write = async idea => {
    const written = await c.request(`/api/projects/${project}/milestones/${next.id}/ideas`, {
      projectId: project,
      idea,
    });
    assert.equal(written.status, 201, JSON.stringify(written.data));
    return written.data.id;
  };
  const first = await write('The Releases page'),
    second = await write("A milestone's page"),
    third = await write('Planned work in milestones');
  const waiting = id =>
    projectMilestones(store, project)
      .find(item => item.id === id)
      .waiting.map(item => item.id);
  const route = (id, action) => `/api/projects/${project}/milestones/${next.id}/ideas/${id}/${action}`;
  assert.equal((await c.request(route(third, 'order'), { projectId: project, index: 0 })).status, 200);
  assert.deepEqual(waiting(next.id), [third, first, second]);
  const refused = await c.request(route(third, 'order'), { projectId: project, index: 3 });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /place is a whole number from 0 to 2/);
  const movedIdea = await c.request(route(first, 'move'), { projectId: project, milestone: '1.0.1' });
  assert.equal(movedIdea.status, 200, JSON.stringify(movedIdea.data));
  assert.deepEqual(waiting(next.id), [third, second]);
  assert.deepEqual(waiting(fix.id), [first]);
  assert.ok(
    store
      .events()
      .some(event => event.kind === 'idea_moved' && /from milestone 1\.1\.0 to 1\.0\.1/.test(event.message)),
  );
  // An idea that could not be sent goes back to the place it held.
  const taken = takeWaitingIdea(store, project, next.id, second);
  assert.equal(taken.index, 1);
  restoreWaitingIdea(store, project, next.id, taken.waiting, taken.index);
  assert.deepEqual(waiting(next.id), [third, second]);
});

test('a project without the source workflow has no Releases page', async t => {
  const c = await setup(t);
  const made = await c.request('/api/projects', { name: 'Notes' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const result = await (await fetch(`${c.origin}/api/projects/${made.data.id}/releases`)).json();
  assert.deepEqual(result, { available: false, reason: 'Only a project on the source workflow has releases.' });
});
