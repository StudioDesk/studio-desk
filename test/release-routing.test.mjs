// The planner's call on releases (1.1 step 2b, Decision MP-028): a breakdown may give each story the release it belongs
// on. When the director did not choose the idea's release, a story moves to another milestone on its line, or leaves
// the idea for a new intake on another line, checked and planned there. Linked stories share a release, and a release
// the director chose is never moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { validateBreakdown } from '../src/connectors/source-changes.mjs';
import { projectMilestones } from '../src/connectors/source-milestones.mjs';
import { projectOrganization, saveProjectOrganization } from '../src/core/project-organization.mjs';
import { developmentOrganization } from '../src/organizations/studio-development/project.mjs';

const project = 'project-legacy';
// The fixture's project takes ideas (so a moved part can start its own intake), and nothing in it dispatches.
async function routed(t) {
  const c = await setup(t),
    store = c.app.store;
  saveProjectOrganization(store, c.app.runner.registries, project, developmentOrganization(store.organization()));
  store.putProject({ ...store.project(project), dispatchPaused: true });
  return c;
}
// The fixture repository's history: 1.0.0 and 1.1.0 released, and main moved on toward 1.2.
const release = c => {
  git(c.root, ['tag', 'v1.0.0']);
  fs.writeFileSync(path.join(c.root, 'README.md'), '// 1.1 work\n');
  git(c.root, ['commit', '--quiet', '-am', '1.1 work']);
  git(c.root, ['tag', 'v1.1.0']);
  fs.writeFileSync(path.join(c.root, 'README.md'), '// 1.2 work\n');
  git(c.root, ['commit', '--quiet', '-am', '1.2 work']);
};
const notes = store =>
  store
    .events()
    .filter(event => event.kind === 'release_planned')
    .map(event => event.message);

test("a breakdown's story moves to the release the planner names: on its line in place, on another line to a new intake there", async t => {
  const c = await routed(t),
    store = c.app.store;
  // Planned before the releases: the fixture's breakdown measured that source.
  const { ids, planning } = await c.breakdown([
    {
      files: ['src/core/workflows.mjs'],
      dependencies: [],
      release: '1.1.1',
      releaseReason: 'A fix for the 1.1 release.',
    },
    { files: ['src/core/projects.mjs'], dependencies: [], release: '1.3.0' },
  ]);
  release(c);
  const runs = () => store.runs(project).length,
    before = runs();
  c.app.runner.autonomy.accepted(planning.taskId);
  // The story for 1.1.1 leaves this idea: its proposal is denied with the reason, and a new intake plans it on release/1.1.
  const moved = store.task(ids[0]);
  assert.equal(moved.status, 'denied');
  assert.match(
    moved.reason,
    /^Moved to 1\.1\.1 by the planner: A fix for the 1\.1 release\. Idea run \S+ checks and plans it on release\/1\.1\.$/,
  );
  assert.deepEqual({ ...moved.movedTo, runId: undefined }, { version: '1.1.1', line: 'release/1.1', runId: undefined });
  const run = store.run(moved.movedTo.runId),
    milestone = projectMilestones(store, project).find(item => item.version === '1.1.1');
  assert.deepEqual(run.release, {
    milestoneId: milestone.id,
    version: '1.1.1',
    by: { type: 'planner', taskId: planning.taskId, reason: 'A fix for the 1.1 release.' },
  });
  assert.equal(run.line, 'release/1.1');
  assert.match(run.brief, /Plan only this part:\n- Refine workflow fixture: Add a bounded comment\.$/);
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.1']), git(c.root, ['rev-parse', 'v1.1.0^{commit}']));
  // The story for 1.3.0 is on the newest line, the idea's own: it stays, on that milestone.
  const stayed = store.task(ids[1]);
  assert.equal(stayed.status, 'backlog');
  assert.deepEqual(
    { ...stayed.release, at: undefined, milestoneId: undefined },
    {
      version: '1.3.0',
      by: { type: 'planner', taskId: planning.taskId },
      line: 'main',
      at: undefined,
      milestoneId: undefined,
    },
  );
  assert.equal(notes(store).length, 2);
  assert.match(notes(store)[0], /^The planner moved “Refine workflow fixture” to 1\.1\.1 on release\/1\.1: A fix/);
  assert.equal(notes(store)[1], 'The planner put “Refine project fixture” on 1.3.0.');
  // Accepting again starts no second intake.
  assert.equal(runs(), before + 1);
  c.app.runner.autonomy.accepted(planning.taskId);
  assert.equal(runs(), before + 1);
});

test('linked stories share a release, and a release the director chose is never moved', async t => {
  const c = await routed(t),
    store = c.app.store;
  const mixed = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [], release: '1.1.1' },
      { files: ['src/core/projects.mjs'], dependencies: ['workflow'], release: '1.0.1' },
    ]),
    chosen = await c.breakdown(
      [
        { files: ['src/core/workflows.mjs'], dependencies: [], release: '1.1.1', releaseReason: 'Belongs on 1.1.' },
        { files: ['src/core/projects.mjs'], dependencies: [] },
      ],
      'chosen',
    );
  release(c);
  // The second breakdown's idea is one the director sent to 1.2.0.
  store.putRun({
    id: 'run-chosen',
    projectId: project,
    brief: 'Make the board faster.',
    release: { milestoneId: 'milestone-chosen', version: '1.2.0', by: { type: 'director' } },
  });
  store.putTask({ ...store.task(chosen.planning.taskId), workflowReference: { runId: 'run-chosen' } });
  const runs = store.runs(project).length;
  c.app.runner.autonomy.accepted(mixed.planning.taskId);
  c.app.runner.autonomy.accepted(chosen.planning.taskId);
  assert.equal(store.runs(project).length, runs, 'No new intake.');
  for (const id of [...mixed.ids, ...chosen.ids]) {
    assert.equal(store.task(id).status, 'backlog');
    assert.equal(store.task(id).release, undefined);
  }
  assert.deepEqual(projectMilestones(store, project), []);
  assert.deepEqual(notes(store), [
    "The planner put linked stories “Refine workflow fixture”, “Refine project fixture” on 1.1.1 and 1.0.1; linked stories share a release, so they stay on the idea's release.",
    'The planner suggested 1.1.1 for “Refine workflow fixture”: Belongs on 1.1. The director chose 1.2.0 for this idea, which stays.',
  ]);
});

test("a breakdown is told its idea's release and the project's open milestones, and a project with neither nothing new", async t => {
  const c = await routed(t),
    store = c.app.store;
  const { planning } = await c.breakdown();
  const layers = () =>
    c.app.runner.workflows.get('studio-development:breakdown').instructions({
      org: projectOrganization(store, project),
      store,
      task: store.task(planning.taskId),
    }).layers;
  assert.deepEqual(
    layers().map(layer => layer.title),
    ['Source breakdown contract'],
  );
  release(c);
  await c.request(`/api/projects/${project}/milestones`, {
    projectId: project,
    version: '1.2.0',
    goal: 'Faster boards',
  });
  let text = layers().find(layer => layer.title === 'Releases').text;
  assert.match(
    text,
    /^This idea has no release yet\. The project's open milestones: 1\.2\.0 \(the newest line: Faster boards\)\. /,
  );
  assert.match(text, /A story may add release \(a version such as 1\.1\.3\) and releaseReason/);
  store.putRun({
    id: 'run-chosen',
    projectId: project,
    brief: 'Make the board faster.',
    release: { milestoneId: 'milestone-chosen', version: '1.2.0', by: { type: 'director' } },
  });
  store.putTask({ ...store.task(planning.taskId), workflowReference: { runId: 'run-chosen' } });
  text = layers().find(layer => layer.title === 'Releases').text;
  assert.match(text, /^This idea is for release 1\.2\.0, which the director chose\. /);
  assert.match(text, /Keep every story on it and leave release out\./);
});

test('a breakdown story gives a release as a version, and its reason only with one', async t => {
  const c = await routed(t),
    { data, planning } = await c.breakdown();
  const story = data.stories[0],
    check = change => () =>
      validateBreakdown({ ...data, stories: [{ ...story, ...change }, data.stories[1]] }, planning.sourceBreakdown);
  assert.doesNotThrow(check({ release: '1.1.3', releaseReason: 'A fix for 1.1.' }));
  assert.throws(check({ release: '1.1' }), /release must be a version such as 1\.1\.3/);
  assert.throws(check({ release: 113 }), /release must be a version such as 1\.1\.3/);
  assert.throws(check({ releaseReason: 'Why.' }), /releaseReason only with a release/);
  assert.throws(check({ release: '1.1.3', releaseReason: 'x'.repeat(1001) }), /releaseReason must contain bounded/);
});
