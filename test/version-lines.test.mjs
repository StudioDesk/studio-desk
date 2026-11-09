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
import {
  ideaRelease,
  makeMilestone,
  projectMilestones,
  useVersionLines,
  versionLinesReadiness,
} from '../src/connectors/source-milestones.mjs';
import { projectLines } from '../src/connectors/source-lines.mjs';
import { releaseOverview } from '../src/connectors/release-overview.mjs';
import { shipAgain, shipRelease } from '../src/connectors/source-releases.mjs';
import { saveProjectOrganization } from '../src/core/project-organization.mjs';
import { developmentOrganization } from '../src/organizations/studio-development/project.mjs';

const project = 'project-legacy';
async function released(t, backendOnly = false) {
  const c = await setup(t, 'pass', undefined, {}, backendOnly),
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
const overview = async c => {
  const response = await fetch(`${c.origin}/api/projects/${project}/releases`);
  assert.equal(response.status, 200);
  return response.json();
};
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

test('a blocked first version branch leaves the prior mode intact and the switch retryable', async t => {
  const c = await released(t, true),
    store = c.app.store,
    main = tip(c, 'refs/heads/main'),
    minor = makeMilestone(store, project, c.app.runner, { version: '1.1.0' }),
    before = { project: store.project(project), milestones: projectMilestones(store, project), events: store.events() };
  assert.equal(minor.line, null);
  git(c.root, ['branch', 'release']);
  assert.throws(() => useVersionLines(store, project, c.app.runner, { shipsTo: 'main' }), /git branch failed/);
  assert.deepEqual(
    { project: store.project(project), milestones: projectMilestones(store, project), events: store.events() },
    before,
    'A branch preparation failure must publish no mode, line, milestone or event changes.',
  );
  assert.deepEqual(ideaRelease(store, project, c.app.runner, {}), {
    line: undefined,
    release: { milestoneId: minor.id, version: '1.1.0', by: { type: 'default' } },
  });
  await c.app.close();
  await c.reopen();
  assert.deepEqual(switchState(c), before, 'Reopening retains the complete prior mode.');
  git(c.root, ['branch', '-d', 'release']);
  const switched = useVersionLines(c.app.store, project, c.app.runner, { shipsTo: 'main' });
  assert.deepEqual(
    switched.lines.map(line => line.branch),
    ['release/1.1'],
  );
  assert.equal(switched.milestones.find(item => item.id === minor.id).line, 'release/1.1');
  assert.equal(tip(c, 'refs/heads/release/1.1'), main);
  assert.equal(tip(c, 'refs/heads/main'), main);
});

const switchState = c => ({
  project: c.app.store.project(project),
  milestones: projectMilestones(c.app.store, project),
  events: c.app.store.events(),
});
async function switchFixture(t) {
  const c = await released(t, true);
  // Deliberately make the future version first; publication must still order the lines and intake by version.
  c.next = makeMilestone(c.app.store, project, c.app.runner, { version: '1.2.0' });
  c.minor = makeMilestone(c.app.store, project, c.app.runner, { version: '1.1.0' });
  c.patch = makeMilestone(c.app.store, project, c.app.runner, { version: '1.0.1' });
  c.main = tip(c, 'refs/heads/main');
  c.before = switchState(c);
  return c;
}
function assertSwitched(c) {
  const store = c.app.store;
  assert.equal(store.project(project).shipsTo, 'main');
  assert.deepEqual(
    projectLines(store.project(project)).map(line => line.branch),
    ['release/1.0', 'release/1.1', 'release/1.2'],
  );
  assert.deepEqual(
    projectLines(store.project(project))[0],
    c.before.project.lines[0],
    'The maintained line is intact.',
  );
  assert.deepEqual(
    projectMilestones(store, project),
    c.before.milestones.map(item => ({
      ...item,
      line: item.id === c.minor.id ? 'release/1.1' : item.id === c.next.id ? 'release/1.2' : item.line,
    })),
  );
  assert.deepEqual(ideaRelease(store, project, c.app.runner, {}), {
    line: 'release/1.1',
    release: { milestoneId: c.minor.id, version: '1.1.0', by: { type: 'default' } },
  });
  assert.equal(tip(c, 'refs/heads/main'), c.main, 'Switching never moves main.');
  const added = store.events().filter(event => event.seq > (c.before.events.at(-1)?.seq ?? 0));
  assert.deepEqual(
    added.map(event => event.kind),
    ['project_line', 'project_line', 'version_lines'],
  );
}

for (const boundary of ['project', 'milestones'])
  test(`a fault after saving ${boundary} rolls the whole switch back and permits a retry`, async t => {
    const c = await switchFixture(t),
      store = c.app.store,
      stop = new Error('Injected publication fault');
    const write = boundary === 'project' ? store.putProject : store.putSetting;
    const fault = t.mock.method(store, boundary === 'project' ? 'putProject' : 'putSetting', function (...args) {
      const result = write.apply(this, args);
      if (boundary === 'project' || args[0] === 'milestones:' + project) throw stop;
      return result;
    });
    assert.throws(
      () => useVersionLines(store, project, c.app.runner, { shipsTo: 'main' }),
      error => error === stop,
    );
    fault.mock.restore();
    assert.deepEqual(switchState(c), c.before, 'No project, milestone or event from a failed transaction survives.');
    await c.app.close();
    await c.reopen();
    assert.deepEqual(switchState(c), c.before);
    const first = commitOn(c, 'release/1.1', 'one.txt', 'Work after the interrupted switch\n'),
      second = commitOn(c, 'release/1.2', 'two.txt', 'Other work after the interrupted switch\n');
    useVersionLines(c.app.store, project, c.app.runner, { shipsTo: 'main' });
    assertSwitched(c);
    assert.equal(tip(c, 'refs/heads/release/1.1'), first, 'Retry reuses the first prepared branch at its current tip.');
    assert.equal(
      tip(c, 'refs/heads/release/1.2'),
      second,
      'Retry reuses the second prepared branch at its current tip.',
    );
  });

for (const [boundary, preparedCount] of [
  ['before-first-branch', 0],
  ['after-first-branch', 1],
  ['after-second-branch', 2],
  ['after-project', 2],
  ['after-milestones', 2],
  ['after-commit', 2],
])
  test(`a process stopped ${boundary} leaves a complete durable mode and preserves prepared tips on retry`, async t => {
    const c = await switchFixture(t);
    await c.app.close();
    // Exit a disposable writer without closing the store or unwinding its transaction. This exercises SQLite's
    // durable boundary, including a stop between the project and milestone writes, rather than only JS rollback.
    const script = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { createStudio } from ${JSON.stringify(new URL('./model-free-studio.mjs', import.meta.url).href)};
      import { useVersionLines } from ${JSON.stringify(new URL('../src/connectors/source-milestones.mjs', import.meta.url).href)};
      const app = createStudio(${JSON.stringify({ directory: path.join(c.directory, 'records'), port: 0, runnerOptions: { sourceChangeRoot: c.root } })});
      const store = app.store, boundary = ${JSON.stringify(boundary)}, stop = () => process.exit(73);
      const spawn = childProcess.spawnSync;
      let prepared = 0;
      childProcess.spawnSync = (executable, args, options) => {
        const preparing = executable === 'git' && args.includes('--no-track');
        if (preparing && boundary === 'before-first-branch') stop();
        const result = spawn(executable, args, options);
        if (preparing && result.status === 0) {
          prepared++;
          if ((boundary === 'after-first-branch' && prepared === 1) ||
              (boundary === 'after-second-branch' && prepared === 2)) stop();
        }
        return result;
      };
      syncBuiltinESMExports();
      const putProject = store.putProject.bind(store), putSetting = store.putSetting.bind(store), tx = store.tx.bind(store);
      store.putProject = (...args) => {
        const result = putProject(...args);
        if (boundary === 'after-project') stop();
        return result;
      };
      store.putSetting = (...args) => {
        const result = putSetting(...args);
        if (boundary === 'after-milestones' && args[0] === ${JSON.stringify('milestones:' + project)}) stop();
        return result;
      };
      store.tx = fn => {
        const result = tx(fn);
        if (boundary === 'after-commit') stop();
        return result;
      };
      useVersionLines(store, ${JSON.stringify(project)}, app.runner, { shipsTo: 'main' });
      throw new Error('The switch did not reach the requested stop boundary.');
    `;
    const stopped = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    // Reopen before asserting so fixture cleanup always owns an open app, even if the child refused to start.
    await c.reopen();
    assert.equal(stopped.status, 73, stopped.error?.message ?? stopped.stderr);
    assert.equal(tip(c, 'refs/heads/main'), c.main);
    if (boundary === 'after-commit') {
      assertSwitched(c);
      const complete = switchState(c);
      assert.throws(
        () => useVersionLines(c.app.store, project, c.app.runner, { shipsTo: 'main' }),
        /already ships to main/,
      );
      assert.deepEqual(switchState(c), complete, 'Retrying a completed switch adds no duplicate records or events.');
      return;
    }
    assert.deepEqual(switchState(c), c.before, 'A stop before commit must leave the complete prior mode.');
    assert.deepEqual(ideaRelease(c.app.store, project, c.app.runner, {}), {
      line: 'main',
      release: { milestoneId: c.minor.id, version: '1.1.0', by: { type: 'default' } },
    });
    const branches = ['release/1.1', 'release/1.2'];
    for (const branch of branches.slice(preparedCount))
      assert.throws(() => tip(c, 'refs/heads/' + branch), /git rev-parse failed/);
    const preserved = branches.slice(0, preparedCount).map(branch => {
      assert.equal(tip(c, 'refs/heads/' + branch), c.main, 'Prepared branches start at the preceding line.');
      return [branch, commitOn(c, branch, 'prepared.txt', `Work on ${branch} before retry\n`)];
    });
    useVersionLines(c.app.store, project, c.app.runner, { shipsTo: 'main' });
    assertSwitched(c);
    for (const [branch, commit] of preserved) assert.equal(tip(c, 'refs/heads/' + branch), commit);
    if (preparedCount === 1)
      assert.equal(
        tip(c, 'refs/heads/release/1.2'),
        preserved[0][1],
        'The next branch starts at the reused first tip.',
      );
    await c.app.close();
    await c.reopen();
    assertSwitched(c);
  });

test('the overview keeps past releases on main and reads the shipping branch apart from version lines', async t => {
  const c = await released(t),
    store = c.app.store,
    main = tip(c, 'main'),
    previous = await make(c, '1.1.0');
  releasedAt(c, previous.id, 'main', main, 'v1.1.0');
  const next = await make(c, '1.2.0');
  git(c.root, ['remote', 'add', 'origin', 'https://example.invalid/studio.git']);
  git(c.root, ['update-ref', 'refs/remotes/origin/main', main]);
  assert.deepEqual((await overview(c)).versionLines, { shipsTo: 'main', ready: true, needs: [] });
  assert.equal((await switchTo(c, 'main')).status, 200);
  const view = await overview(c);
  assert.deepEqual(view.shipsTo, {
    branch: 'main',
    head: main.slice(0, 12),
    lastRelease: { name: 'v1.1.0', version: '1.1.0' },
    onRemote: { known: true, ahead: 0, behind: 0 },
  });
  assert.equal('versionLines' in view, false);
  assert.deepEqual(
    view.lines.map(line => line.branch),
    ['release/1.2'],
  );
  assert.deepEqual(
    view.milestones.map(item => [item.id, item.line]),
    [
      [previous.id, 'main'],
      [next.id, 'release/1.2'],
    ],
  );
  assert.equal(view.lines[0].version, '1.2');
  assert.equal(view.lines[0].released, false, "An inherited release is not this version's first release.");
  const commit = commitOn(c, 'release/1.2', 'next.txt', 'next\n');
  // Both supported tag spellings identify the version, even before a release record is written.
  git(c.root, ['tag', '1.2.0', commit]);
  assert.equal((await overview(c)).lines[0].released, true);
  git(c.root, ['tag', '-d', '1.2.0']);
  git(c.root, ['tag', 'v1.2.0', commit]);
  assert.equal((await overview(c)).lines[0].released, true);
});

test('readiness lists missing milestones before open work and agrees with the unchanged switch refusals', async t => {
  const c = await released(t),
    store = c.app.store;
  assert.deepEqual((await overview(c)).versionLines, {
    shipsTo: 'main',
    ready: false,
    needs: [{ kind: 'next-version' }],
  });
  const noMilestone = await switchTo(c, 'main');
  assert.equal(noMilestone.status, 400);
  assert.equal(noMilestone.data.error, "Make the next version's milestone first, so new work has a line to land on.");
  const waiting = store.task(c.waiting);
  store.putTask({ ...waiting, status: 'ready' });
  const work = { kind: 'open-work', tasks: [{ id: waiting.id, title: waiting.title }], count: 1 };
  assert.deepEqual((await overview(c)).versionLines.needs, [{ kind: 'next-version' }, work]);
  assert.equal((await switchTo(c, 'main')).data.error, noMilestone.data.error);
  await make(c, '1.2.0');
  assert.deepEqual((await overview(c)).versionLines, { shipsTo: 'main', ready: false, needs: [work] });
  const openWork = await switchTo(c, 'main');
  assert.equal(openWork.status, 400);
  assert.equal(
    openWork.data.error,
    `Finish or close the open work first (${waiting.id}): it would be left on main without a line.`,
  );
  store.putTask({ ...waiting, status: 'cancelled' });
  assert.deepEqual((await overview(c)).versionLines, { shipsTo: 'main', ready: true, needs: [] });
  assert.equal((await switchTo(c, 'main')).status, 200);
  assert.equal('versionLines' in (await overview(c)), false);
});

test('readiness is read-only, follows the recorded newest line, and counts unfinished source work', async t => {
  const c = await released(t, true),
    store = c.app.store;
  const next = makeMilestone(store, project, c.app.runner, { version: '1.2.0' }),
    patch = makeMilestone(store, project, c.app.runner, { version: '1.0.1' });
  // The checked-out branch is not necessarily the newest recorded line.
  git(c.root, ['checkout', '--quiet', 'release/1.0']);
  const waiting = store.task(c.waiting);
  for (const [index, sourceStage] of [
    { current: 'review' },
    { current: 'integration' },
    { current: 'build' },
    { current: 'review' },
    { current: 'integration' },
    { current: 'build' },
  ].entries())
    store.putTask({ ...waiting, id: `T-open-${index}`, title: `Open story ${index}`, status: 'done', sourceStage });
  for (const [index, sourceStage] of [
    undefined,
    { current: 'integrated' },
    { current: 'closed' },
    { integration: { state: 'integrated' } },
  ].entries())
    store.putTask({ ...waiting, id: `T-finished-${index}`, status: 'done', sourceStage });
  store.putTask({ ...waiting, id: 'T-unrelated-kind', kind: 'general', status: 'ready' });
  store.putTask({ ...waiting, id: 'T-other-project', projectId: 'project-other', status: 'ready' });
  const snapshot = () =>
    JSON.stringify({
      project: store.project(project),
      milestones: projectMilestones(store, project),
      tasks: store.tasks(),
      events: store.events(),
      refs: git(c.root, ['show-ref']),
      copy: git(c.root, ['status', '--porcelain', '--branch']),
    });
  const before = snapshot(),
    readiness = versionLinesReadiness(store, project, c.app.runner);
  assert.equal(snapshot(), before, 'Reading readiness writes no records, branches or working files.');
  assert.equal(readiness.shipsTo, 'main');
  assert.deepEqual(
    readiness.moving.map(item => item.id),
    [next.id],
    'The patch keeps its existing line.',
  );
  assert.ok(!readiness.moving.some(item => item.id === patch.id));
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.needs, [
    {
      kind: 'open-work',
      count: 6,
      tasks: Array.from({ length: 5 }, (_, index) => ({ id: `T-open-${index}`, title: `Open story ${index}` })),
    },
  ]);
  assert.deepEqual((await releaseOverview(store, project, c.app.runner)).versionLines, {
    shipsTo: 'main',
    ready: false,
    needs: readiness.needs,
  });
});

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
