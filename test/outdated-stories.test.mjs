// A story records when the source moved past its plan, and a blocked editor's file request records whether the edit
// approving it would be refused (November 3, 2026). Model-free: temporary git sources and the protocol fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approveWork } from '../src/core/proposals.mjs';
import { editSourceStory, outdatedReason } from '../src/connectors/source-changes.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setup } from './source-story-setup.mjs';

const created = 'src/core/created.mjs',
  // The note's reason is plain words: no path, file name or identifier.
  plainWords = reason => assert.doesNotMatch(reason, /[\\/]|\.mjs|\.md|T-[0-9a-f]|attempt-/i, reason),
  note = story => {
    const { at, ...rest } = story.sourceStage?.outdated || {};
    if (story.sourceStage?.outdated) assert.ok(Number.isFinite(Date.parse(at)), 'The note says when it was seen.');
    return story.sourceStage?.outdated ? rest : undefined;
  };

test('a story whose file to create another story has since created is refused at Start and edit, and notes that its plan is out of date', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    root = runner.sourceChangeRoot,
    // Two unrelated stories from one breakdown both planned to create the same file.
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], newFiles: [created], dependencies: [] },
      { files: ['src/core/projects.mjs'], newFiles: [created], dependencies: [] },
    ]),
    id = ids[1];
  for (const story of ids) approveWork(store, runner.registries, store.task(story));
  runner.start(ids[0]);
  const { review } = await c.toReview(ids[0]);
  c.integrated(ids[0], review, { [created]: 'export const created = 1;\n' });
  // The scheduler's own readiness checks refuse it too, but note nothing.
  runner.refreshReadiness();
  assert.match(store.task(id).reason, /now exists or collides/);
  assert.equal(store.task(id).sourceStage?.outdated, undefined, 'A readiness check notes nothing.');
  // (a) The director's Start is refused as before, and the story notes that its plan is out of date.
  assert.throws(
    () => runner.queueStart(id),
    /^Error: src\/core\/created\.mjs now exists or collides with an existing path, so it cannot be created\. Request fresh measured evidence and a new breakdown\.$/,
  );
  const started = store.task(id);
  assert.deepEqual(note(started), { reason: outdatedReason, files: [created] });
  plainWords(started.sourceStage.outdated.reason);
  assert.equal(started.status, 'blocked');
  assert.match(started.reason, /^src\/core\/created\.mjs now exists or collides with an existing path/);
  assert.equal(store.attempts(id).length, 0, 'No attempt started.');
  // The dashboard's live set carries the note.
  const live = store.state('project-legacy', { mode: 'dashboard' }).tasks.find(task => task.id === id);
  assert.deepEqual(note(live), { reason: outdatedReason, files: [created] });
  // (b) An edit is refused with the existing message and leaves the same note, recorded by the edit itself.
  const cleared = store.task(id);
  delete cleared.sourceStage.outdated;
  store.putTask(cleared);
  assert.throws(
    () =>
      editSourceStory(
        store,
        store.task(id),
        { files: ['src/core/projects.mjs', 'src/core/workflows.mjs'], newFiles: [created], reason: 'Edit both.' },
        root,
      ),
    /^Error: src\/core\/created\.mjs now exists or collides with an existing path, so it cannot be created\. Request fresh measured evidence and a new breakdown\.$/,
  );
  const edited = store.task(id);
  assert.deepEqual(note(edited), { reason: outdatedReason, files: [created] });
  assert.equal(edited.scopeEdits, undefined, 'A refused edit records no edit.');
  assert.equal(edited.status, 'blocked');
});

test('a file request naming a file the source gained since the plan records the refusal as its problem, and the story notes it', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    byHand = 'test/by-hand.test.mjs',
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    id = ids[0],
    reason = 'The test added by hand pins the old wording.';
  // A file committed after the breakdown's checks measured the source: it exists now, but not in the measured list.
  fs.writeFileSync(path.join(c.root, byHand), '// Added by hand\n');
  git(c.root, ['add', byHand]);
  git(c.root, ['commit', '--quiet', '-m', 'Add a test by hand']);
  approveWork(store, runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: `block-request ${JSON.stringify({ files: [byHand], reason })}` });
  runner.start(id);
  const blocked = await c.wait(id, 'blocked'),
    { problem, ...request } = blocked.scopeRequest;
  // (c) The request keeps its paths and reason, and records why the edit approving it would be refused.
  assert.deepEqual(request, { files: [byHand], newFiles: [], deleteFiles: [], reason });
  assert.equal(
    problem,
    `The story lists unsupported or unrecorded source file ${byHand}; choose an allowed existing path from the measured manifest.`,
  );
  const story = store.task(id);
  assert.deepEqual(note(story), { reason: outdatedReason, files: [byHand] });
  assert.equal(story.scopeEdits, undefined, 'Checking the request writes no edit.');
  // The dashboard's live set carries the request's problem and the note.
  const state = store.state('project-legacy', { mode: 'dashboard' });
  assert.equal(state.attempts.find(attempt => attempt.id === blocked.id).scopeRequest.problem, problem);
  assert.deepEqual(note(state.tasks.find(task => task.id === id)), { reason: outdatedReason, files: [byHand] });
});

test('a file request naming a file an earlier story in the chain created is recorded as one to create, and that edit is accepted', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    root = runner.sourceChangeRoot,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], newFiles: [created], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: ['workflow'] },
    ]),
    id = ids[1],
    reason = 'The module the earlier story created needs the new wording.';
  approveWork(store, runner.registries, store.task(ids[0]));
  runner.start(ids[0]);
  const first = await c.toReview(ids[0]);
  c.integrated(ids[0], first.review, created, '// Created by the earlier story in the chain\n');
  approveWork(store, runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: `block-request ${JSON.stringify({ files: [created], reason })}` });
  runner.start(id);
  const blocked = await c.wait(id, 'blocked');
  // (d) Recorded as Allow and continue would send it: the file under newFiles, with no problem.
  assert.deepEqual(blocked.scopeRequest, { files: [], newFiles: [created], deleteFiles: [], reason });
  assert.equal(store.task(id).sourceStage?.outdated, undefined);
  const request = blocked.scopeRequest,
    result = editSourceStory(
      store,
      store.task(id),
      {
        files: ['src/core/projects.mjs', ...request.files],
        newFiles: request.newFiles,
        deleteFiles: request.deleteFiles,
        reason: request.reason,
        request: blocked.id,
      },
      root,
    );
  assert.equal(result.ok, true);
  assert.deepEqual(result.paths, { files: ['src/core/projects.mjs'], newFiles: [created], deleteFiles: [] });
  assert.equal(store.task(id).sourceStage?.outdated, undefined);
});

test('a file request the edit would accept is recorded with no problem, as before', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs', 'src/core/projects.mjs'], {}, true),
    { store, runner } = c.app,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    id = ids[0],
    asked = { files: ['src/core/projects.mjs'], newFiles: ['src/core/wording.mjs'], reason: 'projects.mjs pins it.' };
  approveWork(store, runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: `block-request ${JSON.stringify(asked)}` });
  runner.start(id);
  const blocked = await c.wait(id, 'blocked');
  // (e) Exactly the recorded request of before: no problem, and no note on the story.
  assert.deepEqual(blocked.scopeRequest, { ...asked, deleteFiles: [] });
  assert.equal(store.task(id).sourceStage?.outdated, undefined);
});

test('a refusal the director can fix in place, such as uncommitted edits, notes nothing', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    root = runner.sourceChangeRoot,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    id = ids[0];
  approveWork(store, runner.registries, store.task(id));
  fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// Uncommitted\n');
  // (f) Start and an edit are refused as before, and the story's plan is not out of date.
  assert.throws(() => runner.queueStart(id), /the changes are not committed: src\/core\/workflows\.mjs\./);
  assert.match(store.task(id).reason, /the changes are not committed/);
  assert.throws(
    () =>
      editSourceStory(
        store,
        store.task(id),
        { files: ['src/core/workflows.mjs', 'src/core/projects.mjs'], reason: 'Edit both.' },
        root,
      ),
    /the changes are not committed: src\/core\/workflows\.mjs\./,
  );
  assert.equal(store.task(id).sourceStage?.outdated, undefined);
  // An uncommitted deletion can be restored too, so it notes nothing either.
  git(c.root, ['checkout', '--quiet', '--', 'src/core/workflows.mjs']);
  fs.rmSync(path.join(c.root, 'src/core/workflows.mjs'));
  assert.throws(() => runner.queueStart(id), /Approved source files no longer exist: src\/core\/workflows\.mjs\./);
  assert.equal(store.task(id).sourceStage?.outdated, undefined);
  // A deletion committed on the line moved the source past the plan.
  git(c.root, ['rm', '--quiet', '--cached', 'src/core/workflows.mjs']);
  git(c.root, ['commit', '--quiet', '-m', 'Delete a module by hand']);
  assert.throws(() => runner.queueStart(id), /Approved source files no longer exist: src\/core\/workflows\.mjs\./);
  assert.deepEqual(note(store.task(id)), { reason: outdatedReason, files: ['src/core/workflows.mjs'] });
});
