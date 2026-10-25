// The director edits a source story's files and sends it back, keeping its work (October 20, 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hash } from '../src/core/contracts.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { autonomyPolicy, kindMode, saveAutonomyPolicy } from '../src/core/autonomy.mjs';
import {
  approveScopeRequest,
  changeScope,
  editSourceStory,
  scopeRequest,
  stagedChanges,
  validateSourceChange,
} from '../src/connectors/source-changes.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setup } from './source-story-setup.mjs';

test("the director edits a blocked story's files; its next attempt continues from the staged work", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs', 'src/core/projects.mjs']),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    id = ids[0],
    edit = { files: ['src/core/projects.mjs', 'src/core/workflows.mjs'], reason: 'projects.mjs pins the old wording.' };
  approveWork(store, c.app.runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: 'block' });
  c.app.runner.start(id);
  // The editor stops as blocked, as T-7346a7e8 did, with its edit staged.
  const blocked = await c.wait(id, 'blocked'),
    staged = blocked.artifacts.find(item => item.path === 'changes/src/core/workflows.mjs');
  assert.ok(staged, 'A blocked attempt records the work it staged.');
  c.app.runner.autonomy.attention(store.task(id), 'The editor needs another file.');
  for (const [body, message] of [
    [{ ...edit, reason: ' ' }, /reason for the edit must contain bounded nonempty text/],
    [{ ...edit, keepWork: 'yes' }, /keepWork must be true or false/],
    [{ ...edit, scope: 'More' }, /A story edit contains unsupported fields/],
    [{ ...edit, files: ['src/core/workflows.mjs'] }, /The edit does not change the story's files/],
    [{ ...edit, files: ['AGENTS.md'] }, /unsupported or unrecorded source file AGENTS\.md/],
    [{ ...edit, newFiles: ['src/core/projects.mjs'] }, /must list each source path once/],
  ]) {
    const refused = await c.request(`/api/tasks/${id}/edit-scope`, body);
    assert.equal(refused.status, 400, JSON.stringify(refused.data));
    assert.match(refused.data.error, message);
  }
  assert.equal(store.task(id).scopeEdits, undefined, 'A refused edit records nothing.');
  assert.equal(store.task(id).autonomyNote, 'The editor needs another file.');
  const edited = await c.request(`/api/tasks/${id}/edit-scope`, edit);
  assert.equal(edited.status, 202, JSON.stringify(edited.data));
  assert.deepEqual(edited.data.continueFrom, {
    attemptId: blocked.id,
    files: [{ path: 'src/core/workflows.mjs', hash: staged.hash }],
    skipped: [],
  });
  const story = store.task(id);
  assert.equal(story.autonomyNote, undefined);
  assert.equal(story.reason, '');
  assert.equal(story.sourceStage.reason, '');
  assert.deepEqual(
    story.scopeEdits.map(({ at, ...rest }) => rest),
    [
      {
        files: edit.files,
        newFiles: [],
        deleteFiles: [],
        reason: edit.reason,
        by: { type: 'director' },
        previous: { files: ['src/core/workflows.mjs'], newFiles: [], deleteFiles: [] },
        keepWork: true,
      },
    ],
  );
  assert.match(
    story.direction,
    /^The director changed this story's files: projects\.mjs pins the old wording\.\n\nFiles added: src\/core\/projects\.mjs\.\n\n/,
  );
  assert.match(
    story.direction,
    new RegExp(`Previous attempt ${blocked.id} \\(blocked\\): Model-free source-edit fixture\\.`),
  );
  assert.match(
    story.direction,
    /src\/core\/workflows\.mjs are already in changes\/ \(continueFrom in source-scope\.json\)/,
  );
  assert.ok(store.events().some(event => event.kind === 'story_edited' && event.message.includes(edit.reason)));
  // The edit queued the story like Start; the fixture edits only the first approved file.
  const next = await c.wait(id);
  assert.deepEqual(next.sourceChange.allowedFiles, edit.files);
  assert.equal(next.sourceChange.continueFrom.attemptId, blocked.id);
  const scope = JSON.parse(fs.readFileSync(path.join(next.outputFolder, 'source-scope.json')));
  assert.deepEqual(scope.directorEdits, [
    { reason: edit.reason, at: story.scopeEdits[0].at, files: edit.files, newFiles: [], deleteFiles: [] },
  ]);
  assert.deepEqual(scope.continueFrom, next.sourceChange.continueFrom);
  // The carried edit is in the candidate although the editor did not return it this time.
  const manifest = JSON.parse(fs.readFileSync(path.join(next.outputFolder, 'source-change.json')));
  assert.deepEqual(
    manifest.changes.map(item => [item.path, item.afterHash === staged.hash]),
    [
      ['src/core/projects.mjs', false],
      ['src/core/workflows.mjs', true],
    ],
  );
  const measured = c.measuredFixture(next);
  assert.equal(
    validateSourceChange(measured, name => fs.readFileSync(path.join(next.outputFolder, name))).report.passed,
    true,
  );
  // Every later attempt continues from the latest stopped implementation, keeping the cumulative work.
  const later = changeScope(store, store.task(id), c.root).continueFrom;
  assert.equal(later.attemptId, next.id);
  assert.deepEqual(
    later.files.find(item => item.path === 'src/core/workflows.mjs'),
    { path: 'src/core/workflows.mjs', hash: staged.hash },
    'The earlier edit is carried again although the second editor changed a different file.',
  );
  assert.ok(later.files.some(item => item.path === 'src/core/projects.mjs'));
  assert.equal(later.fresh, undefined);
});

test('a commit to an edited path starts the whole work fresh, explained; an edit is refused while the story runs or is reviewed', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    root = c.app.runner.sourceChangeRoot,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/workflows.mjs'], dependencies: [] },
    ]),
    edit = { files: ['src/core/workflows.mjs'], newFiles: ['src/core/created.mjs'], reason: 'Add a helper module.' };
  for (const id of ids) approveWork(store, c.app.runner.registries, store.task(id));
  store.putTask({ ...store.task(ids[0]), direction: 'block' });
  c.app.runner.start(ids[0]);
  const blocked = await c.wait(ids[0], 'blocked');
  // Meanwhile an independent story integrates a change to the same file.
  c.app.runner.start(ids[1]);
  const { review } = await c.toReview(ids[1]);
  c.integrated(ids[1], review, 'src/core/workflows.mjs', '// Integrated by the other story\n');
  const result = editSourceStory(store, store.task(ids[0]), edit, root);
  assert.deepEqual(result.continueFrom, {
    attemptId: blocked.id,
    files: [],
    skipped: [],
    fresh: {
      reason: 'the source of files it changed was committed since that attempt',
      paths: ['src/core/workflows.mjs'],
    },
  });
  assert.ok(
    store
      .task(ids[0])
      .direction.includes(
        `This attempt starts from the current source instead of the work of ${blocked.id}: the source of files it changed was committed since that attempt (src/core/workflows.mjs). Its history still shows that work.`,
      ),
  );
  assert.ok(store.attempt(blocked.id), 'The earlier attempt and its history are kept.');
  c.app.runner.start(ids[0]);
  assert.throws(
    () => editSourceStory(store, store.task(ids[0]), { ...edit, newFiles: [] }, root),
    /Edit a story while its implementation is stopped/,
  );
  const next = await c.wait(ids[0]);
  assert.deepEqual(
    [next.sourceChange.allowedFiles, next.sourceChange.newFiles],
    [['src/core/workflows.mjs'], ['src/core/created.mjs']],
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(next.outputFolder, 'source-change.json')));
  assert.equal(
    manifest.changes.find(item => item.path === 'src/core/workflows.mjs').beforeHash,
    hash('// Integrated by the other story\n'),
    'The editor started from the integrated bytes, not the stale staged copy.',
  );
  c.measuredFixture(next);
  acceptAttempt(store, c.app.runner.registries, store.task(ids[0]));
  assert.equal(store.task(ids[0]).sourceStage.phase, 'candidate-review');
  assert.throws(
    () => editSourceStory(store, store.task(ids[0]), { ...edit, newFiles: [] }, root),
    /Edit a story while its implementation is stopped, or after its independent review requested changes/,
  );
});

test('a committed hand edit keeps a story startable; an edit drops a file a hand commit deleted, and it starts again', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    root = c.app.runner.sourceChangeRoot,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs', 'docs/module-contracts.md', 'src/core/projects.mjs'], dependencies: [] },
      { files: ['test/bounded.test.mjs'], dependencies: [] },
    ]),
    id = ids[0];
  approveWork(store, c.app.runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: 'block' });
  c.app.runner.start(id);
  const blocked = await c.wait(id, 'blocked'),
    staged = blocked.artifacts.find(item => item.path === 'changes/src/core/workflows.mjs');
  // The contract changes by hand, as T-3fb8e9d5's did on October 20; no integrated story recorded it.
  // Since MP-021 a change committed on the branch no longer makes the story stale.
  fs.writeFileSync(path.join(c.root, 'docs/module-contracts.md'), '// Edited by hand\n');
  git(c.root, ['commit', '--quiet', '-am', 'Edit the contract by hand']);
  assert.deepEqual(changeScope(store, store.task(id), root).allowedFiles, [
    'src/core/workflows.mjs',
    'docs/module-contracts.md',
    'src/core/projects.mjs',
  ]);
  // A file a hand commit deleted still does.
  git(c.root, ['rm', '--quiet', 'src/core/projects.mjs']);
  git(c.root, ['commit', '--quiet', '-m', 'Delete a module by hand']);
  const stale = /Approved source files no longer exist: src\/core\/projects\.mjs\./;
  assert.throws(() => changeScope(store, store.task(id), root), stale);
  assert.throws(
    () =>
      editSourceStory(
        store,
        store.task(id),
        { files: ['src/core/workflows.mjs', 'src/core/projects.mjs'], reason: 'Drop the contract.' },
        root,
      ),
    stale,
  );
  assert.equal(store.task(id).scopeEdits, undefined, 'A refused edit records nothing.');
  // Without the deleted file the story's other paths still hold, so the edit and the start pass.
  const result = editSourceStory(
    store,
    store.task(id),
    {
      files: ['src/core/workflows.mjs', 'docs/module-contracts.md'],
      reason: 'The module was deleted by hand; it is out of scope.',
    },
    root,
  );
  assert.deepEqual(result.continueFrom, {
    attemptId: blocked.id,
    files: [{ path: 'src/core/workflows.mjs', hash: staged.hash }],
    skipped: [],
  });
  assert.match(store.task(id).direction, /Files removed: src\/core\/projects\.mjs\./);
  c.app.runner.start(id);
  const next = await c.wait(id);
  assert.deepEqual(next.sourceChange.allowedFiles, ['src/core/workflows.mjs', 'docs/module-contracts.md']);
  assert.equal(next.sourceChange.continueFrom.attemptId, blocked.id);
});

test('after a review requests changes, an edit sends the story back with the findings and its accepted work', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs', 'src/core/projects.mjs']),
    store = c.app.store;
  await c.start();
  const first = await c.wait(c.taskId),
    negative = await c.review(first, 'negative-review');
  await c.accept(c.taskId);
  const files = [...first.sourceChange.allowedFiles, 'docs/module-contracts.md'];
  const edited = await c.request(`/api/tasks/${c.taskId}/edit-scope`, {
    files,
    reason: 'The review found the contract needs the new rule.',
    keepWork: true,
  });
  assert.equal(edited.status, 202, JSON.stringify(edited.data));
  assert.equal(edited.data.continueFrom.attemptId, first.id);
  assert.deepEqual(
    edited.data.continueFrom.files.map(item => item.path),
    first.artifacts.filter(item => item.kind === 'source-file').map(item => item.path.slice('changes/'.length)),
  );
  assert.equal(store.task(c.taskId).sourceStage.phase, 'implementing');
  const second = await c.wait(c.taskId);
  assert.equal(second.assignment.kind, 'studio-development:change');
  assert.match(
    second.assignment.direction,
    new RegExp(
      `Independent review ${negative.id} requested changes\\. Address these findings:\\n- Model-free candidate review fixture\\.\\n- Fixture requests more work\\.`,
    ),
  );
  assert.deepEqual(second.sourceChange.allowedFiles, files);
  // A review proposal's story keeps its accepted proposal; the edit decides its paths.
  assert.deepEqual(second.sourceChange.proposal, first.sourceChange.proposal);
});

test('a blocked editor names the files it needs, and the director approves them as an edit (MP-021)', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs', 'src/core/projects.mjs']),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    id = ids[0],
    request = {
      files: ['src/core/projects.mjs'],
      newFiles: ['src/core/wording.mjs'],
      reason: ' src/core/projects.mjs asserts the old wording; the new text needs a shared module. ',
    };
  approveWork(store, c.app.runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: `block-request ${JSON.stringify(request)}` });
  c.app.runner.start(id);
  // As T-7346a7e8's editor did on October 20, but naming the paths in its result.
  const blocked = await c.wait(id, 'blocked');
  assert.deepEqual(blocked.scopeRequest, {
    files: ['src/core/projects.mjs'],
    newFiles: ['src/core/wording.mjs'],
    deleteFiles: [],
    reason: request.reason.trim(),
  });
  // T-b18131f6's candidate skipped a test the sandbox could not run, and the measured suite failed it.
  assert.match(blocked.instructions.text, /fails on a skipped or todo test/);
  assert.ok(blocked.artifacts.some(item => item.path === 'scope-request.json' && item.kind === 'source-scope-request'));
  assert.ok(
    blocked.artifacts.some(item => item.path === 'changes/src/core/workflows.mjs'),
    'The staged edit is kept.',
  );
  // A request changes nothing by itself: the story keeps its paths until the director edits them.
  assert.equal(store.task(id).scopeEdits, undefined);
  assert.deepEqual(changeScope(store, store.task(id), c.root).allowedFiles, ['src/core/workflows.mjs']);
  const approval = {
    files: ['src/core/workflows.mjs', 'src/core/projects.mjs'],
    newFiles: ['src/core/wording.mjs'],
    reason: request.reason.trim(),
    request: blocked.id,
  };
  // Only the request of the story's latest blocked attempt can be approved.
  const refused = await c.request(`/api/tasks/${id}/edit-scope`, { ...approval, request: 'attempt-elsewhere' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Only the file request of the story's latest attempt can be approved/);
  // The director approves it as prefilled: the story's paths plus the requested ones, with a reason.
  const edited = await c.request(`/api/tasks/${id}/edit-scope`, approval);
  assert.equal(edited.status, 202, JSON.stringify(edited.data));
  const story = store.task(id);
  assert.deepEqual(story.scopeEdits[0].request, { attemptId: blocked.id, workerId: blocked.workerId });
  assert.equal(story.scopeEdits[0].reason, request.reason.trim());
  assert.match(
    story.direction,
    new RegExp(`^The director changed this story's files, answering the file request of ${blocked.id}: `),
  );
  assert.match(story.direction, /Files added: src\/core\/projects\.mjs\. New files added: src\/core\/wording\.mjs\./);
  assert.ok(
    store
      .events()
      .some(event => event.kind === 'story_edited' && event.message.includes(`file request of ${blocked.id}`)),
  );
  const next = await c.wait(id);
  assert.deepEqual(
    [next.sourceChange.allowedFiles, next.sourceChange.newFiles],
    [['src/core/workflows.mjs', 'src/core/projects.mjs'], ['src/core/wording.mjs']],
  );
  assert.equal(next.sourceChange.continueFrom.attemptId, blocked.id);
  assert.equal(next.scopeRequest, undefined);
  // The editor and the independent reviewer read which paths the request added, and who approved them.
  const scope = JSON.parse(fs.readFileSync(path.join(next.outputFolder, 'source-scope.json')));
  assert.deepEqual(
    [scope.directorEdits[0].requestedIn, scope.directorEdits[0].added, scope.directorEdits[0].approvedBy],
    [blocked.id, ['src/core/projects.mjs', 'src/core/wording.mjs'], 'director'],
  );
  const measured = c.measuredFixture(next);
  assert.equal(
    validateSourceChange(measured, name => fs.readFileSync(path.join(next.outputFolder, name))).report.passed,
    true,
  );
  // The request cannot be approved again once a later attempt ran.
  assert.throws(
    () => editSourceStory(store, store.task(id), { ...approval, files: ['src/core/workflows.mjs'] }, c.root),
    /Only the file request of the story's latest attempt can be approved/,
  );
});

// The director's amendment of October 20: the policy approves the request, and the director is the
// fallback when the policy leaves it, cannot apply it, or the independent review says no.
test('with file requests automatic, the policy adds the requested files and the story runs on (MP-021)', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs', 'src/core/projects.mjs'], {}, true),
    store = c.app.store,
    { runner } = c.app,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]),
    id = ids[0],
    request = { files: ['src/core/projects.mjs'], newFiles: ['src/core/wording.mjs'], reason: 'projects.mjs pins it.' },
    policy = (scope, kind = 'studio-development:change') =>
      saveAutonomyPolicy(store, runner.registries, 'project-legacy', {
        expectedRevision: autonomyPolicy(store, 'project-legacy').revision,
        enabled: true,
        retries: 0,
        kinds: { [kind]: { approve: 'director', accept: 'director', ...(scope ? { scope } : {}) } },
        cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
      }),
    settle = () => new Promise(resolve => setTimeout(resolve, 60));
  // Only a task type that applies scope requests has the mode; policies without it ask the director.
  assert.throws(() => policy('auto', 'studio-development:checks'), /Unsupported autonomy mode fields/);
  assert.throws(() => policy('sometimes'), /Autonomy modes must be director or auto/);
  assert.equal(policy(undefined).kinds['studio-development:change'].scope, 'director');
  assert.equal(kindMode({ enabled: false }, 'studio-development:change').scope, 'director');
  approveWork(store, runner.registries, store.task(id));
  store.putTask({ ...store.task(id), direction: `block-request ${JSON.stringify(request)}` });
  runner.start(id);
  const blocked = await c.wait(id, 'blocked');
  await settle();
  assert.equal(store.task(id).scopeEdits, undefined, 'Asking the director leaves the request for the director.');
  // Automatic, but each fallback leaves it for the director with the reason.
  const automatic = policy('auto');
  store.putTask({ ...store.task(id), maxAttempts: 1 });
  runner.autonomy.settled(id);
  assert.match(store.task(id).autonomyNote, /^Attempt limit reached; approve or change the requested scope yourself\./);
  store.putTask({ ...store.task(id), maxAttempts: 2 });
  fs.appendFileSync(path.join(c.root, 'src/core/projects.mjs'), '// Uncommitted\n');
  runner.autonomy.settled(id);
  assert.match(
    store.task(id).autonomyNote,
    /^The requested files could not be approved automatically: Approved source files changed since the breakdown, and the changes are not committed: src\/core\/projects\.mjs\./,
  );
  assert.equal(store.task(id).scopeEdits, undefined);
  git(c.root, ['checkout', '--', 'src/core/projects.mjs']);
  // Approved: the story's paths plus the requested ones, recorded as the policy's decision.
  runner.autonomy.settled(id);
  const story = store.task(id);
  assert.deepEqual(
    story.scopeEdits.map(({ at, previous, ...edit }) => edit),
    [
      {
        files: ['src/core/workflows.mjs', 'src/core/projects.mjs'],
        newFiles: ['src/core/wording.mjs'],
        deleteFiles: [],
        reason: request.reason,
        by: {
          type: 'policy',
          revision: automatic.revision,
          reason: 'File requests from a blocked editor: approved automatically.',
        },
        keepWork: true,
        request: { attemptId: blocked.id, workerId: blocked.workerId },
      },
    ],
  );
  assert.equal(story.autonomyNote, undefined);
  assert.match(
    story.direction,
    new RegExp(
      `^The autonomy policy approved the file request of ${blocked.id} for the director, adding the paths it named: projects\\.mjs pins it\\.`,
    ),
  );
  assert.ok(
    store
      .events()
      .some(
        event =>
          event.kind === 'story_edited' &&
          event.message.startsWith(
            `Autonomy policy revision ${automatic.revision} approved the file request of ${blocked.id}`,
          ),
      ),
  );
  // The story was queued and its next attempt continues from the staged work with the added paths.
  const next = await c.wait(id);
  assert.deepEqual(
    [next.sourceChange.allowedFiles, next.sourceChange.newFiles, next.sourceChange.continueFrom.attemptId],
    [['src/core/workflows.mjs', 'src/core/projects.mjs'], ['src/core/wording.mjs'], blocked.id],
  );
  // The independent reviewer is told the policy added these paths, and how to judge them.
  const scope = JSON.parse(fs.readFileSync(path.join(next.outputFolder, 'source-scope.json')));
  assert.deepEqual(
    [scope.directorEdits[0].requestedIn, scope.directorEdits[0].added, scope.directorEdits[0].approvedBy],
    [blocked.id, ['src/core/projects.mjs', 'src/core/wording.mjs'], 'autonomy policy'],
  );
  const reviewText = runner.registries.workflows.get('studio-development:change-review').instructions().layers[0].text;
  assert.match(
    reviewText,
    /an added path the scope did not need, or changes in it beyond what the scope required, is a blocking finding/,
  );
  const measured = c.measuredFixture(next);
  assert.equal(
    validateSourceChange(measured, name => fs.readFileSync(path.join(next.outputFolder, name))).report.passed,
    true,
  );
  // A request already answered by an edit is not applied again.
  assert.equal(approveScopeRequest(store, store.task(id), blocked, c.root, story.scopeEdits[0].by), null);
});

test('a requested deletion stays with the director even when file requests are automatic', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { runner } = c.app,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['test/bounded.test.mjs'], dependencies: [] },
    ]),
    request = { deleteFiles: ['src/core/projects.mjs'], reason: 'projects.mjs is replaced.' };
  saveAutonomyPolicy(store, runner.registries, 'project-legacy', {
    expectedRevision: 0,
    enabled: true,
    retries: 0,
    kinds: { 'studio-development:change': { approve: 'director', accept: 'director', scope: 'auto' } },
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  approveWork(store, runner.registries, store.task(ids[0]));
  store.putTask({ ...store.task(ids[0]), direction: `block-request ${JSON.stringify(request)}` });
  runner.start(ids[0]);
  const blocked = await c.wait(ids[0], 'blocked');
  assert.deepEqual(blocked.scopeRequest.deleteFiles, ['src/core/projects.mjs']);
  for (let i = 0; i < 100 && !store.task(ids[0]).autonomyNote; i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  assert.match(
    store.task(ids[0]).autonomyNote,
    /^The editor asked to delete src\/core\/projects\.mjs; deletions stay with the director\. Approve or change the requested files in the story\.$/,
  );
  assert.equal(store.task(ids[0]).scopeEdits, undefined);
  assert.equal(store.task(ids[0]).status, 'blocked');
});

test('a file request is recorded only when it names new, allowed paths, and only with a blocked outcome', () => {
  const scope = {
      allowedFiles: ['src/core/workflows.mjs'],
      newFiles: ['src/core/created.mjs'],
      deleteFiles: [],
      source: {
        files: ['src/core/workflows.mjs', 'src/core/projects.mjs', 'test/bounded.test.mjs', 'AGENTS.md'].map(file => ({
          path: file,
          bytes: 1,
          hash: hash(file),
        })),
      },
    },
    blocked = (body, artifacts = [{ path: 'scope-request.json', kind: 'source-scope-request' }]) =>
      scopeRequest(
        scope,
        { taskId: 'T-1', outcome: 'blocked', summary: 'Needs a file.', artifacts, checks: [], issues: [], handoff: '' },
        () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      ),
    valid = {
      schemaVersion: 'source-scope-request-v1',
      files: ['test/bounded.test.mjs'],
      deleteFiles: ['src/core/projects.mjs'],
      reason: 'The bounded test pins the old wording, and projects.mjs is replaced.',
    };
  assert.equal(blocked(valid, []), null, 'No request artifact, no request.');
  assert.deepEqual(blocked(valid), {
    files: ['test/bounded.test.mjs'],
    newFiles: [],
    deleteFiles: ['src/core/projects.mjs'],
    reason: valid.reason,
  });
  for (const [body, problem, artifacts] of [
    [
      valid,
      /^Return scope-request\.json once, with kind source-scope-request\.$/,
      [{ path: 'scope-request.json', kind: 'report' }],
    ],
    [
      valid,
      /once/,
      [
        { path: 'scope-request.json', kind: 'source-scope-request' },
        { path: 'scope-request.json', kind: 'source-scope-request' },
      ],
    ],
    ['{ not json', /must be readable JSON of at most 64 KiB/],
    [{ ...valid, reason: 'x'.repeat(70 * 1024) }, /must be readable JSON of at most 64 KiB/],
    [{ ...valid, scope: 'More work' }, /^The file request contains unsupported fields\.$/],
    [{ ...valid, schemaVersion: 'v2' }, /schemaVersion source-scope-request-v1/],
    [{ ...valid, reason: ' ' }, /reason must contain bounded nonempty text/],
    [{ ...valid, files: 'test/bounded.test.mjs' }, /arrays of source paths/],
    [{ ...valid, files: [], deleteFiles: [] }, /^The file request names no path\.$/],
    [
      { ...valid, files: ['src/core/workflows.mjs', 'src/core/created.mjs'] },
      /already has: src\/core\/workflows\.mjs, src\/core\/created\.mjs\.$/,
    ],
    [{ ...valid, files: ['test/missing.test.mjs'] }, /unsupported or unrecorded source file test\/missing\.test\.mjs/],
    [{ ...valid, files: ['AGENTS.md'] }, /unsupported or unrecorded source file AGENTS\.md/],
    [
      { ...valid, files: [], newFiles: ['test/bounded.test.mjs'] },
      /cannot create test\/bounded\.test\.mjs: it already exists/,
    ],
    [
      { ...valid, files: [], newFiles: ['scripts/.hidden.mjs'] },
      /cannot create scripts\/\.hidden\.mjs: new files go under/,
    ],
  ]) {
    const recorded = blocked(body, artifacts);
    assert.deepEqual(Object.keys(recorded), ['problem'], JSON.stringify(body).slice(0, 80));
    assert.match(recorded.problem, problem);
  }
  // A completed change never carries a request; it stays inside the approved paths.
  assert.throws(
    () =>
      stagedChanges(
        scope,
        {
          taskId: 'T-1',
          outcome: 'completed',
          summary: 'Done.',
          artifacts: [{ path: 'scope-request.json', kind: 'source-scope-request' }],
          checks: [],
          issues: [],
          handoff: '',
        },
        () => Buffer.from(JSON.stringify(valid)),
      ),
    /Return scope-request\.json only with outcome blocked/,
  );
});
