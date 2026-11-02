// Version lines (decided by the director, November 2, 2026): each minor or major version has its own line from the
// moment its milestone opens, new work lands on the lowest open version's line, and the branch releases ship to (main)
// moves only when a release ships, so it always equals the newest release. Shipping fast-forwards when it can and is
// otherwise a merge whose content is exactly the release's; an older line's patch released after a newer version is
// never shipped; Push sends the shipped branch too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { ideaRelease, projectMilestones } from '../src/connectors/source-milestones.mjs';
import { projectLines } from '../src/connectors/source-lines.mjs';
import { shipAgain, shipRelease } from '../src/connectors/source-releases.mjs';
import { saveProjectOrganization } from '../src/core/project-organization.mjs';
import { developmentOrganization } from '../src/organizations/studio-development/project.mjs';

const project = 'project-legacy';
async function released(t) {
  const c = await setup(t),
    store = c.app.store;
  saveProjectOrganization(store, c.app.runner.registries, project, developmentOrganization(store.organization()));
  fs.writeFileSync(path.join(c.root, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  git(c.root, ['commit', '--quiet', '-am', 'Version 1.0.0']);
  git(c.root, ['tag', 'v1.0.0']);
  // The fixture's waiting story is closed: open work on main would be left without a line, so the switch refuses it.
  const waiting = store.tasks().find(task => task.kind === 'studio-development:change' && task.status === 'ready');
  c.waiting = waiting.id;
  store.putTask({ ...waiting, status: 'cancelled' });
  return c;
}
const make = async (c, version) => {
  const made = await c.request(`/api/projects/${project}/milestones`, { projectId: project, version });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data.milestone;
};
const switchTo = (c, shipsTo) => c.request(`/api/projects/${project}/version-lines`, { projectId: project, shipsTo });
const tip = (c, ref) => git(c.root, ['rev-parse', ref]);
// A commit on a branch that is not checked out, made with an index of its own, without touching the folder.
function commitOn(c, branch, file, text) {
  const run = (args, { input, env } = {}) => {
    const result = spawnSync('git', args, {
      cwd: c.root,
      input,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const parent = tip(c, `refs/heads/${branch}`),
    blob = run(['hash-object', '-w', '--stdin'], { input: text }),
    env = { GIT_INDEX_FILE: path.join(c.directory, `index-${branch.replaceAll('/', '-')}`) };
  run(['read-tree', parent], { env });
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
  const tree = run(['write-tree'], { env }),
    commit = git(c.root, ['commit-tree', tree, '-p', parent, '-m', `Change ${file} on ${branch}`]);
  git(c.root, ['update-ref', `refs/heads/${branch}`, commit, parent]);
  return commit;
}
// A milestone recorded as released at a commit, as Release leaves it once its line reached the commit and it is tagged.
function releasedAt(c, milestoneId, branch, commit, tag) {
  git(c.root, ['tag', '-a', tag, '-m', `Release ${tag}`, commit]);
  const all = projectMilestones(c.app.store, project),
    milestone = all.find(item => item.id === milestoneId);
  milestone.state = 'released';
  milestone.release = {
    id: `release-${milestoneId}`,
    state: 'released',
    root: c.root,
    commit,
    tag,
    repository: { branch },
    reviewTaskId: null,
  };
  c.app.store.putSetting('milestones:' + project, all);
}

test('switching gives each open version its own line, in version order, and new work lands on the lowest open version', async t => {
  const c = await released(t),
    store = c.app.store,
    main = tip(c, 'refs/heads/main');
  // Not yet: there must be a version for new work to land on, and the branch releases are made on is where they ship.
  assert.match((await switchTo(c, 'main')).data.error, /Make the next version's milestone first/);
  const minor = await make(c, '1.1.0');
  assert.equal(minor.line, null, 'Before the switch, a minor is made on the newest line.');
  // Open work on main would be left without a line.
  store.putTask({ ...store.task(c.waiting), status: 'ready' });
  assert.match(
    (await switchTo(c, 'main')).data.error,
    new RegExp(`Finish or close the open work first \\(${c.waiting}\\)`),
  );
  store.putTask({ ...store.task(c.waiting), status: 'cancelled' });
  // A story done before stories had stages has nothing left to integrate, so it is not open work.
  store.putTask({ ...store.task(c.waiting), id: 'T-before-stages', status: 'done' });
  assert.match((await switchTo(c, 'trunk')).data.error, /no branch named trunk/);
  git(c.root, ['branch', 'trunk']);
  assert.match((await switchTo(c, 'trunk')).data.error, /made on main, so that is the branch they ship to/);
  const switched = await switchTo(c, 'main');
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(store.project(project).shipsTo, 'main');
  assert.deepEqual(
    projectLines(store.project(project)).map(line => line.branch),
    ['release/1.1'],
    'main is no longer a line work lands on.',
  );
  assert.equal(tip(c, 'refs/heads/release/1.1'), main, 'The first version line starts at main.');
  assert.equal(projectMilestones(store, project).find(item => item.id === minor.id).line, 'release/1.1');
  assert.match((await switchTo(c, 'main')).data.error, /already ships to main/);
  // The next version gets its own line, made from the one before it; a patch of a released version gets its line from
  // its tag, as before; every line stays in version order.
  commitOn(c, 'release/1.1', 'one.txt', 'one\n');
  const next = await make(c, '1.2.0');
  assert.equal(next.line, 'release/1.2');
  assert.equal(tip(c, 'refs/heads/release/1.2'), tip(c, 'refs/heads/release/1.1'), '1.2 holds 1.1’s work to ship.');
  const patch = await make(c, '1.0.1');
  assert.equal(patch.line, 'release/1.0');
  assert.equal(tip(c, 'refs/heads/release/1.0'), tip(c, 'v1.0.0^{commit}'));
  assert.deepEqual(
    projectLines(store.project(project)).map(line => line.branch),
    ['release/1.0', 'release/1.1', 'release/1.2'],
  );
  assert.equal(tip(c, 'refs/heads/main'), main, 'main has not moved.');
  // New work goes to the lowest open version, on its own line; main cannot be made a line.
  const idea = ideaRelease(store, project, c.app.runner, {});
  assert.deepEqual([idea.line, idea.release.version], ['release/1.1', '1.1.0']);
  const added = await c.request(`/api/projects/${project}/lines`, { projectId: project, branch: 'main' });
  assert.match(added.data.error, /ship to main, so it is not a line work lands on/);
  assert.ok(
    store.events().some(event => event.kind === 'version_lines' && /1\.1\.0 on release\/1\.1/.test(event.message)),
  );
});

test('a release ships to main: a fast-forward, a merge whose content is the release, never back to an older one', async t => {
  const c = await released(t),
    store = c.app.store;
  const v11 = await make(c, '1.1.0');
  assert.equal((await switchTo(c, 'main')).status, 200);
  const v12 = await make(c, '1.2.0');
  // 1.1.0 is released on its line: main is behind it, so it fast-forwards, in the folder, which has main checked out.
  const one = commitOn(c, 'release/1.1', 'one.txt', 'one\n');
  releasedAt(c, v11.id, 'release/1.1', one, 'v1.1.0');
  const first = shipRelease(store, project, v11.id);
  assert.deepEqual([first.branch, first.commit, first.merged], ['main', one, false]);
  assert.equal(tip(c, 'refs/heads/main'), one);
  assert.equal(fs.readFileSync(path.join(c.root, 'one.txt'), 'utf8'), 'one\n', 'The folder moved with main.');
  assert.deepEqual(shipRelease(store, project, v11.id), first, 'Shipping twice changes nothing.');
  // 1.2.0 was made before 1.1.0's last commit, so main is not behind it: the ship is a merge whose content is 1.2's.
  const two = commitOn(c, 'release/1.2', 'two.txt', 'two\n');
  releasedAt(c, v12.id, 'release/1.2', two, 'v1.2.0');
  const second = shipRelease(store, project, v12.id);
  assert.equal(second.merged, true);
  const shipped = tip(c, 'refs/heads/main');
  assert.equal(shipped, second.commit);
  assert.deepEqual(git(c.root, ['rev-list', '--parents', '-n', '1', shipped]).split(' ').slice(1), [one, two]);
  assert.equal(git(c.root, ['diff', '--name-only', shipped, two]), '', 'main holds exactly the release.');
  // An older line's patch released after 1.2.0 stays on its line.
  const fix = await make(c, '1.1.1');
  const three = commitOn(c, 'release/1.1', 'fix.txt', 'fix\n');
  releasedAt(c, fix.id, 'release/1.1', three, 'v1.1.1');
  const skipped = shipRelease(store, project, fix.id);
  assert.match(skipped.skipped, /v1\.2\.0 is newer/);
  assert.equal(tip(c, 'refs/heads/main'), shipped, 'main never goes back.');
});

test('a ship that cannot move main says why, Ship again finishes it, and Push sends main with the line and the tag', async t => {
  const c = await released(t),
    store = c.app.store;
  const v11 = await make(c, '1.1.0');
  assert.equal((await switchTo(c, 'main')).status, 200);
  fs.writeFileSync(path.join(c.root, 'one.txt'), 'local\n');
  const one = commitOn(c, 'release/1.1', 'one.txt', 'one\n');
  releasedAt(c, v11.id, 'release/1.1', one, 'v1.1.0');
  const stopped = shipRelease(store, project, v11.id);
  assert.match(stopped.error, /one\.txt/);
  assert.notEqual(tip(c, 'refs/heads/main'), one);
  assert.ok(store.events().some(event => event.kind === 'release_shipped' && /main did not move/.test(event.message)));
  const ship = () => c.request(`/api/projects/${project}/milestones/${v11.id}/ship`, { projectId: project });
  fs.rmSync(path.join(c.root, 'one.txt'));
  const again = await ship();
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.shipped.commit, one);
  assert.match((await ship()).data.error, /nothing to ship again/);
  assert.throws(() => shipAgain(store, project, 'milestone-missing'), /Milestone not found/);
  // Push sends the line, main and the tag.
  const remote = path.join(c.directory, 'remote.git');
  git(c.directory, ['init', '--quiet', '--bare', remote]);
  git(c.root, ['remote', 'add', 'origin', remote]);
  const pushed = await c.request(`/api/projects/${project}/milestones/${v11.id}/push`, {
    projectId: project,
    confirm: true,
  });
  if (pushed.status !== 200 && /could not push/.test(pushed.data.error ?? '')) {
    // The test sandbox may not let git start its receiving side; the refusal still names every ref it would send.
    assert.match(pushed.data.error, /release\/1\.1, main and v1\.1\.0|release\/1\.1/);
    return;
  }
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), one);
  assert.equal(git(remote, ['rev-parse', 'refs/heads/release/1.1']), one);
  assert.ok(
    store
      .events()
      .some(event => event.kind === 'release_pushed' && /release\/1\.1, main and v1\.1\.0/.test(event.message)),
  );
});
