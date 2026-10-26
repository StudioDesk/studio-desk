// The planner's suggestions on releases (1.1 step 2b, Decision MP-028, narrowed by MP-032): a breakdown may say a story
// belongs on another release, with its reason. Only the director picks a release, so nothing moves, no milestone or
// line is made and no intake starts; each suggestion is noted on the breakdown, once.
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
// The fixture's project is on the source workflow, which milestones need, and nothing in it dispatches.
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
const director = 'only the director moves a story to another release, from its release chip.';

test("a planner's release for a story moves nothing and makes nothing: it is noted for the director, once", async t => {
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
  const runs = store.runs(project).length,
    lines = structuredClone(store.project(project).lines);
  c.app.runner.autonomy.accepted(planning.taskId);
  for (const id of ids) {
    const story = store.task(id);
    assert.equal(story.status, 'backlog');
    assert.equal(story.approval.status, 'pending');
    assert.equal(story.release, undefined);
  }
  assert.equal(store.runs(project).length, runs, 'No new intake.');
  assert.deepEqual(projectMilestones(store, project), [], 'No milestone.');
  assert.deepEqual(store.project(project).lines, lines, 'No line.');
  assert.equal(git(c.root, ['branch', '--list', 'release/*']), '', 'No branch.');
  assert.deepEqual(notes(store), [
    `The planner suggested 1.1.1 for “Refine workflow fixture”: A fix for the 1.1 release. It stays on this idea's line; ${director}`,
    `The planner suggested 1.3.0 for “Refine project fixture”. It stays on this idea's line; ${director}`,
  ]);
  // Accepting again notes nothing twice.
  c.app.runner.autonomy.accepted(planning.taskId);
  assert.equal(notes(store).length, 2);
});

test("a release the director chose stays, and a suggestion of the idea's own release is not noted", async t => {
  const c = await routed(t),
    store = c.app.store;
  const { ids, planning } = await c.breakdown([
    { files: ['src/core/workflows.mjs'], dependencies: [], release: '1.1.1', releaseReason: 'Belongs on 1.1.' },
    { files: ['src/core/projects.mjs'], dependencies: ['workflow'], release: '1.2.0' },
  ]);
  release(c);
  // The idea is one the director sent to 1.2.0.
  store.putRun({
    id: 'run-chosen',
    projectId: project,
    brief: 'Make the board faster.',
    release: { milestoneId: 'milestone-chosen', version: '1.2.0', by: { type: 'director' } },
  });
  store.putTask({ ...store.task(planning.taskId), workflowReference: { runId: 'run-chosen' } });
  c.app.runner.autonomy.accepted(planning.taskId);
  for (const id of ids) assert.equal(store.task(id).release, undefined);
  assert.deepEqual(projectMilestones(store, project), []);
  assert.deepEqual(notes(store), [
    `The planner suggested 1.1.1 for “Refine workflow fixture”: Belongs on 1.1. It stays on 1.2.0, this idea's release; ${director}`,
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
    /^This idea has no release yet\. The project's open milestones: 1\.2\.0 \(the newest line: Faster boards\)\. Keep every story on this idea's line and leave release out: only the director picks a release\. /,
  );
  assert.match(text, /the controller keeps the story where it is and shows your suggestion to the director\.$/);
  assert.doesNotMatch(text, /next patch|makes a release/);
  store.putRun({
    id: 'run-chosen',
    projectId: project,
    brief: 'Make the board faster.',
    release: { milestoneId: 'milestone-chosen', version: '1.2.0', by: { type: 'director' } },
  });
  store.putTask({ ...store.task(planning.taskId), workflowReference: { runId: 'run-chosen' } });
  text = layers().find(layer => layer.title === 'Releases').text;
  assert.match(text, /^This idea is for release 1\.2\.0, which the director chose\. /);
  assert.match(text, /Keep every story on it and leave release out: only the director picks a release\./);
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
