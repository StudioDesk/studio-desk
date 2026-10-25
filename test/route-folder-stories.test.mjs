// Route folders such as (group), [id], [...slug] and [[...slug]] go from a breakdown through a file
// request and the director's edit to an integrated commit on the disposable fixture repository, with
// no model call. Their unsafe look-alikes are refused at each check point and change nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourcePlan } from '../src/connectors/source-checks.mjs';
import { changeScope, scopeRequest, validateSourceChange } from '../src/connectors/source-changes.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setup } from './source-story-setup.mjs';

const page = 'src/app/(frontend)/[member]/page.mjs',
  layout = 'src/app/(frontend)/layout.mjs',
  catchAll = 'src/app/[...slug]/page.mjs',
  route = 'src/[[...slug]]/route.mjs',
  // A protected name, a dot segment, a trailing dot, a device name, a stream separator, backslashes, an
  // absolute path, full-width brackets and a tool configuration.
  unsafe = [
    'src/[A]GENTS.md',
    'src/app/[..]/page.mjs',
    'src/app/[slug]./page.mjs',
    'src/app/nul.mjs',
    'src/app/[slug]:x.mjs',
    'src\\app\\[slug]\\page.mjs',
    '/src/app/[slug]/page.mjs',
    'src/app/［slug］/page.mjs',
    'dashboard/[t]sconfig.json',
  ],
  // The line the model-free editor (test/fixture-source-edit.mjs) adds to each file it edits.
  added = '\n// Bounded fixture improvement.\n',
  other = { files: ['src/core/projects.mjs'], dependencies: [] };

test('route-folder paths go from a breakdown to integration, and their unsafe look-alikes are refused at each step', async t => {
  const c = await setup(t, 'pass', [page, layout]),
    store = c.app.store,
    tracked = () => git(c.root, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean),
    repository = () => ({
      head: git(c.root, ['rev-parse', 'HEAD']),
      files: tracked(),
      sourceHash: sourcePlan(c.root).sourceHash,
      status: git(c.root, ['status', '--porcelain']),
    }),
    baseline = repository(),
    created = (message, name, file) => message.includes(`${name} cannot create ${file}: new files go under`);
  assert.equal(baseline.status, '');
  assert.ok(baseline.files.includes(page) && baseline.files.includes(layout));

  // (a) The breakdown lists an existing route-folder file to edit and a catch-all page to create.
  const { ids } = await c.breakdown([{ files: [page], newFiles: [catchAll], dependencies: [] }, other]),
    id = ids[0],
    planned = store.task(id);
  assert.deepEqual([planned.status, planned.approval.status, planned.queued], ['backlog', 'pending', false]);
  assert.ok(planned.brief.startsWith(`Files: ${page}\nNew files: ${catchAll}\n\n`), planned.brief);
  // At the breakdown, a plan naming any unsafe path is refused and proposes no story.
  for (const [i, file] of unsafe.entries()) {
    const name = `refused-${i}`;
    await assert.rejects(
      c.breakdown([{ files: [page], newFiles: [catchAll, file], dependencies: [] }, other], name),
      error => created(error.message, 'Story workflow', file),
    );
    assert.equal(store.task(`${name}-task`).proposedTaskIds, undefined);
    assert.ok(!store.tasks().some(task => task.proposalReference?.attemptId === `${name}-attempt`));
  }
  assert.deepEqual(repository(), baseline, 'Refused breakdowns leave the repository unchanged.');

  // (b) The editor stops as blocked, asking for the layout and a catch-all route.
  assert.equal((await c.request(`/api/tasks/${id}/approve-work`)).status, 200);
  const request = {
    files: [layout],
    newFiles: [route],
    reason: 'The member page reads its layout, and unmatched paths need a catch-all route.',
  };
  store.putTask({ ...store.task(id), direction: `block-request ${JSON.stringify(request)}` });
  assert.equal((await c.request(`/api/tasks/${id}/start`)).status, 202);
  const blocked = await c.wait(id, 'blocked');
  assert.deepEqual(
    [blocked.sourceChange.allowedFiles, blocked.sourceChange.newFiles, blocked.sourceChange.deleteFiles],
    [[page], [catchAll], []],
  );
  assert.deepEqual(blocked.scopeRequest, {
    files: [layout],
    newFiles: [route],
    deleteFiles: [],
    reason: request.reason,
  });
  for (const file of [page, catchAll])
    assert.ok(
      blocked.artifacts.some(item => item.path === `changes/${file}`),
      `The staged ${file} is kept.`,
    );
  // In a file request, an unsafe path is recorded only as the request's problem: none of its paths is added.
  const requested = body =>
    scopeRequest(blocked.sourceChange, blocked.result, () =>
      Buffer.from(JSON.stringify({ schemaVersion: 'source-scope-request-v1', ...body })),
    );
  assert.deepEqual(requested(request), blocked.scopeRequest, 'The check records the editor’s own request.');
  for (const file of unsafe) {
    const recorded = requested({ ...request, newFiles: [route, file] });
    assert.deepEqual(Object.keys(recorded), ['problem'], file);
    assert.ok(created(recorded.problem, 'The story with the requested paths', file), recorded.problem);
  }
  assert.deepEqual(changeScope(store, store.task(id), c.root, { dryRun: true }).allowedFiles, [page]);
  // An edit to the story's files that names an unsafe path is refused with 400 and records nothing.
  for (const file of unsafe) {
    const refused = await c.request(`/api/tasks/${id}/edit-scope`, {
      files: [page, layout],
      newFiles: [catchAll, route, file],
      reason: request.reason,
      request: blocked.id,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.data));
    assert.ok(created(refused.data.error, 'The story', file), refused.data.error);
  }
  assert.equal(store.task(id).scopeEdits, undefined, 'A refused edit records nothing.');
  assert.equal(store.task(id).status, 'blocked');
  assert.equal(store.attempts(id).length, 1);
  assert.deepEqual(repository(), baseline, 'Refused requests and edits leave the repository unchanged.');

  // (c) The director approves the request. The fixture editor edits the first approved file, so the
  // layout comes first; the page's edit is carried from the blocked attempt.
  const edited = await c.request(`/api/tasks/${id}/edit-scope`, {
    files: [layout, page],
    newFiles: [catchAll, route],
    reason: request.reason,
    request: blocked.id,
  });
  assert.equal(edited.status, 202, JSON.stringify(edited.data));
  assert.equal(edited.data.continueFrom.attemptId, blocked.id);
  assert.deepEqual(edited.data.continueFrom.files.map(item => item.path).sort(), [page, catchAll].sort());
  assert.deepEqual(store.task(id).scopeEdits[0].request, { attemptId: blocked.id, workerId: blocked.workerId });

  // (d) The next attempt continues from the staged work and builds the candidate in its worktree.
  const next = await c.wait(id);
  assert.deepEqual(
    [next.sourceChange.allowedFiles, next.sourceChange.newFiles],
    [
      [layout, page],
      [catchAll, route],
    ],
  );
  assert.equal(next.sourceChange.continueFrom.attemptId, blocked.id);
  assert.equal(next.scopeRequest, undefined);
  const read = name => fs.readFileSync(path.join(next.outputFolder, name)),
    scope = JSON.parse(read('source-scope.json'));
  assert.deepEqual([scope.directorEdits[0].requestedIn, scope.directorEdits[0].added], [blocked.id, [layout, route]]);
  // The candidate lists exactly the edited and created bracket paths.
  const changed = [page, layout, catchAll, route].sort(),
    manifest = JSON.parse(read('source-change.json'));
  assert.deepEqual(manifest.changes.map(item => item.path).sort(), changed);
  for (const item of manifest.changes)
    assert.equal(item.beforeHash === null, [catchAll, route].includes(item.path), item.path);
  assert.deepEqual(
    [
      ...read('change.diff')
        .toString()
        .matchAll(/^diff --git a\/(.+) b\/\1$/gm),
    ]
      .map(match => match[1])
      .sort(),
    changed,
  );
  assert.equal(validateSourceChange(c.measuredFixture(next), read).report.passed, true);

  // (e) Accepted, reviewed and integrated.
  const { review } = await c.toReview(id);
  assert.equal(review.assignment.kind, 'studio-development:change-review');
  const integration = await c.integration(review);
  assert.equal(integration.status, 200, JSON.stringify(integration.data));
  const journal = await c.settled(review);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal));
  assert.equal(store.task(id).sourceStage.current, 'integrated');
  const files = tracked();
  for (const file of [catchAll, route]) assert.ok(files.includes(file), `git ls-files -z lists ${file}.`);
  assert.deepEqual(files.sort(), [...baseline.files, catchAll, route].sort());
  for (const file of [page, layout])
    assert.ok(fs.readFileSync(path.join(c.root, file), 'utf8').includes(added), `${file} holds the edit.`);
  assert.deepEqual(git(c.root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort(), changed);
  assert.equal(git(c.root, ['status', '--porcelain']), '');
});
