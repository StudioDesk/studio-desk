// A project's library (1.2 step 6): entries added from an upload or from accepted work, revisions that keep the old
// file, edits, removal, a copy to another project with its provenance, and each revision read back by hash as an inert
// file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './studio-setup.mjs';
import { hash } from '../src/core/contracts.mjs';
import { currentEntries, libraryOf, readLibraryRevision } from '../src/core/library.mjs';
import { newRun } from '../src/core/graph.mjs';

const project = 'project-legacy',
  upload = (name, text) => ({ name, data: Buffer.from(text).toString('base64') });

// Accepted work that handed back a file, as a finished run leaves it.
function acceptedWork(store, text = '# Brand guidelines\n\nUse the studio blue.\n') {
  const attempt = {
      id: 'attempt-guidelines',
      taskId: 'T-guidelines',
      projectId: project,
      workerId: 'W-01',
      status: 'accepted',
      result: {
        taskId: 'T-guidelines',
        outcome: 'completed',
        summary: 'Wrote the guidelines.',
        artifacts: [],
        checks: [],
        issues: [],
        handoff: '',
      },
    },
    output = path.join(store.directory, 'jobs', attempt.id, 'output');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'brand.md'), text);
  attempt.outputFolder = output;
  attempt.artifacts = [{ path: 'brand.md', kind: 'document', hash: hash(Buffer.from(text)) }];
  store.putTask({
    id: 'T-guidelines',
    projectId: project,
    kind: 'general',
    title: 'Brand guidelines',
    status: 'done',
    acceptedAttemptId: attempt.id,
    lastAttemptId: attempt.id,
    dependencies: [],
  });
  store.insertAttempt(attempt, { text: 'Fixture', hash: 'fixture' });
  return attempt;
}

test('an entry joins the library from an upload or from accepted work, and a newer file makes a revision', async t => {
  const c = await setup(t),
    store = c.app.store;
  const uploaded = await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'Voice and tone',
    purpose: 'How the copy should sound.',
    file: upload('voice.md', '# Voice\n\nPlain and warm.\n'),
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  assert.match(uploaded.data.id, /^lib-/);
  assert.deepEqual(
    uploaded.data.revisions.map(item => [item.revision, item.file, item.mediaType, item.source.type]),
    [[1, 'voice.md', 'text/markdown', 'upload']],
  );
  acceptedWork(store);
  const accepted = await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'Brand guidelines',
    purpose: 'Colors, type and logo use for every page.',
    from: { taskId: 'T-guidelines', path: 'brand.md' },
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  assert.deepEqual(accepted.data.revisions[0].source, {
    type: 'accepted',
    taskId: 'T-guidelines',
    attemptId: 'attempt-guidelines',
    path: 'brand.md',
    hash: hash(Buffer.from('# Brand guidelines\n\nUse the studio blue.\n')),
  });
  // A newer file in its place keeps the old one.
  const revised = await c.request(`/api/projects/project-legacy/library/${uploaded.data.id}/revisions`, {
    projectId: project,
    file: upload('voice.md', '# Voice\n\nPlain, warm and brief.\n'),
  });
  assert.equal(revised.status, 201, JSON.stringify(revised.data));
  assert.deepEqual(
    revised.data.revisions.map(item => item.revision),
    [1, 2],
  );
  assert.equal(
    readLibraryRevision(store, project, uploaded.data.id, 1).bytes.toString(),
    '# Voice\n\nPlain and warm.\n',
  );
  assert.equal(
    readLibraryRevision(store, project, uploaded.data.id, 2).bytes.toString(),
    '# Voice\n\nPlain, warm and brief.\n',
  );
  const same = await c.request(`/api/projects/project-legacy/library/${uploaded.data.id}/revisions`, {
    projectId: project,
    file: upload('voice.md', '# Voice\n\nPlain, warm and brief.\n'),
  });
  assert.equal(same.status, 409);
  assert.match(same.data.error, /same as the newest revision/);
  // The index reads every entry and revision.
  const index = await (await fetch(`${c.origin}/api/projects/project-legacy/library?projectId=project-legacy`)).json();
  assert.deepEqual(
    index.entries.map(entry => [entry.name, entry.revisions.length]),
    [
      ['Voice and tone', 2],
      ['Brand guidelines', 1],
    ],
  );
  assert.ok(
    store.events().some(event => event.kind === 'library_added' && /added Brand guidelines/.test(event.message)),
  );
});

test('the library refuses what it cannot keep: a missing purpose, an unaccepted file, an unknown kind, a name twice', async t => {
  const c = await setup(t),
    store = c.app.store;
  const attempt = acceptedWork(store);
  for (const [fields, status, problem] of [
    [{ name: 'Notes', file: upload('notes.md', 'x') }, 400, /what the entry is for/],
    [{ name: 'Notes', purpose: 'x', file: upload('tool.exe', 'MZ') }, 400, /keeps images, JSON, Markdown/],
    [
      {
        name: 'Notes',
        purpose: 'x',
        file: upload('notes.md', 'x'),
        from: { taskId: 'T-guidelines', path: 'brand.md' },
      },
      400,
      /not both/,
    ],
    [
      { name: 'Notes', purpose: 'x', from: { taskId: 'T-guidelines', path: 'other.md' } },
      404,
      /not one the accepted work handed back/,
    ],
    [{ name: 'Notes', purpose: 'x', file: { name: 'notes.md', data: 'not base64!' } }, 400, /canonical base64/],
  ]) {
    const refused = await c.request('/api/projects/project-legacy/library', { projectId: project, ...fields });
    assert.equal(refused.status, status, JSON.stringify(refused.data));
    assert.match(refused.data.error, problem);
  }
  // Work not accepted yet is not a library file.
  store.updateAttempt({ ...attempt, status: 'review' });
  const unaccepted = await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'Guidelines',
    purpose: 'x',
    from: { taskId: 'T-guidelines', path: 'brand.md' },
  });
  assert.equal(unaccepted.status, 409);
  assert.match(unaccepted.data.error, /Only a file from accepted work joins the library/);
  await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'Spec',
    purpose: 'x',
    file: upload('spec.md', 'a'),
  });
  const twice = await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'spec',
    purpose: 'y',
    file: upload('spec.md', 'b'),
  });
  assert.equal(twice.status, 409);
  assert.match(twice.data.error, /already has an entry named spec; add a new revision/);
});

test('an entry is edited, removed for later work with its record kept, and copied to another project with where it came from', async t => {
  const c = await setup(t),
    store = c.app.store;
  const added = (
    await c.request('/api/projects/project-legacy/library', {
      projectId: project,
      name: 'Spec',
      purpose: 'The rules.',
      file: upload('spec.md', '# Spec\n'),
    })
  ).data;
  const edited = await c.request(`/api/projects/project-legacy/library/${added.id}/edit`, {
    projectId: project,
    purpose: 'The product rules.',
  });
  assert.equal(edited.data.purpose, 'The product rules.');
  // A copy to another project keeps its provenance.
  store.putProject({ id: 'project-other', name: 'Other' });
  const copied = await c.request(`/api/projects/project-legacy/library/${added.id}/copy`, {
    projectId: project,
    to: 'project-other',
  });
  assert.equal(copied.status, 201, JSON.stringify(copied.data));
  assert.deepEqual(copied.data.revisions[0].source, {
    type: 'copy',
    projectId: project,
    entryId: added.id,
    revision: 1,
    sha256: hash(Buffer.from('# Spec\n')),
  });
  assert.equal(readLibraryRevision(store, 'project-other', copied.data.id, 1).bytes.toString(), '# Spec\n');
  const removed = await c.request(`/api/projects/project-legacy/library/${added.id}/remove`, { projectId: project });
  assert.ok(removed.data.removedAt);
  assert.equal(currentEntries(libraryOf(store, project)).length, 0, 'Later work no longer receives it.');
  assert.equal(libraryOf(store, project).entries.length, 1, 'Its record stays.');
  // A revision's bytes changed on disk are refused, never served.
  const file = path.join(store.directory, 'projects', 'project-other', 'library', copied.data.id, 'r1.md');
  fs.writeFileSync(file, '# Changed\n');
  assert.throws(() => readLibraryRevision(store, 'project-other', copied.data.id, 1), /changed after it was added/);
});

test('a revision reads back as an inert file: images as themselves, everything else as plain text', async t => {
  const c = await setup(t);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  const image = (
      await c.request('/api/projects/project-legacy/library', {
        projectId: project,
        name: 'Logo',
        purpose: 'The mark.',
        file: { name: 'logo.png', data: png.toString('base64') },
      })
    ).data,
    page = (
      await c.request('/api/projects/project-legacy/library', {
        projectId: project,
        name: 'Landing',
        purpose: 'The page.',
        file: upload('landing.html', '<script>alert(1)</script>'),
      })
    ).data;
  const read = id =>
    fetch(`${c.origin}/api/projects/project-legacy/library/${id}/revisions/1?projectId=project-legacy`);
  const logo = await read(image.id);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), png);
  const html = await read(page.id);
  assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(html.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(await html.text(), '<script>alert(1)</script>');
  assert.equal(
    (await fetch(`${c.origin}/api/projects/project-legacy/library/${page.id}/revisions/9?projectId=project-legacy`))
      .status,
    404,
  );
});

// A plain task on the test studio's model-free employee, run to review.
async function runTask(c, title, extra = {}) {
  const { runReference, ...fields } = extra;
  const created = await c.request('/api/tasks', {
    title,
    workerId: 'W-03',
    kind: 'general',
    brief: 'Bounded model-free work.',
    ...fields,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  // Run membership is controller-owned, rather than a field the creation route takes.
  if (runReference) c.app.store.putTask({ ...c.app.store.task(created.data.id), runReference });
  c.app.runner.start(created.data.id);
  const done = await c.wait(created.data.id);
  return done.attempt || c.app.store.attempt(c.app.store.task(created.data.id).lastAttemptId);
}

// Exercise delivery contracts through real claims and stored attempts, using only the simulator.
function librarySteps(c) {
  const workflows = c.app.runner.workflows,
    general = workflows.get('general');
  workflows.register({
    id: 'library-fixture',
    version: 'library-fixture-v1',
    tasks: [
      { ...general, kind: 'library-fixture:none', step: { kind: 'work', receives: { library: 'none' } } },
      { ...general, kind: 'library-fixture:consumer', step: { kind: 'review' } },
    ],
  });
}

function assertEmptyLibrary(store, attempt) {
  assert.deepEqual(attempt.libraryReferences, []);
  assert.deepEqual(attempt.libraryLeftOut, []);
  assert.equal(fs.existsSync(path.resolve(attempt.outputFolder, '../library')), false);
  assert.ok(!store.attempt(attempt.id).instructions.layers.some(layer => layer.title === 'Project library'));
}

test('a persisted none delivery stays empty for a same-as-inputs consumer despite an existing library entry', async t => {
  const c = await setup(t),
    store = c.app.store;
  librarySteps(c);
  const added = await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'Spec',
    purpose: 'The rules.',
    file: upload('spec.md', '# Spec\n'),
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const work = await runTask(c, 'Work without the library', { kind: 'library-fixture:none' });
  assert.equal((await c.request(`/api/tasks/${work.taskId}/accept`)).status, 200);
  const producer = store.attempt(store.task(work.taskId).acceptedAttemptId),
    review = await runTask(c, 'Consume the accepted work', {
      kind: 'library-fixture:consumer',
      dependencies: [producer.taskId],
    });
  assert.equal(producer.status, 'accepted');
  assert.equal(review.status, 'review');
  assert.equal(review.inputReferences[0].attemptId, producer.id);
  assert.deepEqual(
    { producer: producer.libraryReferences, consumer: review.libraryReferences },
    { producer: [], consumer: [] },
  );
  assertEmptyLibrary(store, producer);
  assertEmptyLibrary(store, store.attempt(review.id));
});

test('an initially empty current library stays empty through review and retry of the same accepted work', async t => {
  const c = await setup(t),
    store = c.app.store;
  librarySteps(c);
  const work = await runTask(c, 'Work before library uploads');
  assert.equal((await c.request(`/api/tasks/${work.taskId}/accept`)).status, 200);
  const producer = store.attempt(store.task(work.taskId).acceptedAttemptId);
  assertEmptyLibrary(store, producer);
  const added = await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'New spec',
    purpose: 'For later work.',
    file: upload('spec.md', '# Added after the work\n'),
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const first = await runTask(c, 'Review the earlier work', {
    kind: 'library-fixture:consumer',
    dependencies: [producer.taskId],
  });
  assert.equal(first.status, 'review');
  assert.equal(first.inputReferences[0].attemptId, producer.id);
  assertEmptyLibrary(store, store.attempt(first.id));
  const revised = await c.request(`/api/tasks/${first.taskId}/revise`, {
    direction: 'Check the same accepted work again.',
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.data));
  c.app.runner.start(first.taskId);
  await c.wait(first.taskId);
  const retry = store.attempt(store.task(first.taskId).lastAttemptId);
  assert.equal(retry.status, 'review');
  assert.notEqual(retry.id, first.id);
  assert.equal(retry.inputReferences[0].attemptId, producer.id);
  assertEmptyLibrary(store, retry);
  assertEmptyLibrary(store, store.attempt(producer.id));
});

test('a legacy accepted attempt without a library snapshot keeps the current-library fallback', async t => {
  const c = await setup(t),
    store = c.app.store;
  librarySteps(c);
  const legacy = acceptedWork(store),
    added = await c.request('/api/projects/project-legacy/library', {
      projectId: project,
      name: 'Spec',
      purpose: 'The current rules.',
      file: upload('spec.md', '# Current spec\n'),
    });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(store.attempt(legacy.id).libraryReferences, undefined);
  const review = await runTask(c, 'Review legacy work', {
    kind: 'library-fixture:consumer',
    dependencies: [legacy.taskId],
  });
  assert.equal(review.status, 'review');
  assert.equal(review.inputReferences[0].attemptId, legacy.id);
  assert.equal(review.libraryReferences[0].entryId, added.data.id);
  assert.equal(review.libraryReferences[0].sha256, hash(Buffer.from('# Current spec\n')));
  assert.equal(
    fs.readFileSync(path.resolve(review.outputFolder, review.libraryReferences[0].path), 'utf8'),
    '# Current spec\n',
  );
  assert.equal(store.attempt(legacy.id).libraryReferences, undefined, 'Reading legacy work does not rewrite it.');
});

test("every attempt receives the library's index in its instructions and its files beside the work, recorded by hash", async t => {
  const c = await setup(t),
    store = c.app.store;
  const spec = (
    await c.request('/api/projects/project-legacy/library', {
      projectId: project,
      name: 'Spec',
      purpose: 'The rules every page follows.',
      file: upload('spec.md', '# Spec\n\nEvery page has a title.\n'),
    })
  ).data;
  const attempt = await runTask(c, 'Write the about page');
  assert.deepEqual(
    attempt.libraryReferences.map(item => [item.entryId, item.name, item.revision, item.delivered, item.path]),
    [[spec.id, 'Spec', 1, true, `../library/${spec.id}-r1.md`]],
  );
  assert.equal(attempt.libraryReferences[0].sha256, hash(Buffer.from('# Spec\n\nEvery page has a title.\n')));
  const staged = path.resolve(attempt.outputFolder, attempt.libraryReferences[0].path);
  assert.equal(fs.readFileSync(staged, 'utf8'), '# Spec\n\nEvery page has a title.\n');
  const instructions = store.attempt(attempt.id).instructions.text;
  assert.match(instructions, /# Project library/);
  assert.ok(
    instructions.includes(
      `- Spec (revision 1, spec.md): The rules every page follows. At ../library/${spec.id}-r1.md.`,
    ),
  );
  // A newer revision reaches later work; the earlier attempt keeps the one it read, and the entry names its readers.
  await c.request(`/api/projects/project-legacy/library/${spec.id}/revisions`, {
    projectId: project,
    file: upload('spec.md', '# Spec\n\nEvery page has a title and a summary.\n'),
  });
  const later = await runTask(c, 'Write the contact page');
  assert.equal(later.libraryReferences[0].revision, 2);
  assert.equal(store.attempt(attempt.id).libraryReferences[0].revision, 1);
  const readers = await (
    await fetch(`${c.origin}/api/projects/project-legacy/library/${spec.id}/readers?projectId=project-legacy`)
  ).json();
  assert.deepEqual(
    readers.map(item => [item.attemptId, item.revision]).sort(),
    [
      [attempt.id, 1],
      [later.id, 2],
    ].sort(),
  );
  // A removed entry reaches no later work.
  await c.request(`/api/projects/project-legacy/library/${spec.id}/remove`, { projectId: project });
  const after = await runTask(c, 'Write the jobs page');
  assert.deepEqual(after.libraryReferences, []);
  assert.deepEqual(after.libraryLeftOut, []);
  assert.doesNotMatch(store.attempt(after.id).instructions.text, /# Project library/);
});

test('files past the size limit are in the index alone, and a review receives the same files as the work it reviews', async t => {
  const c = await setup(t),
    store = c.app.store,
    { libraryFor, libraryDeliveryBytes } = await import('../src/core/library.mjs');
  librarySteps(c);
  const big = 'x'.repeat(4 * 1024 * 1024);
  for (let i = 1; i <= 6; i++)
    assert.equal(
      (
        await c.request('/api/projects/project-legacy/library', {
          projectId: project,
          name: `Data ${i}`,
          purpose: 'A large table.',
          file: upload(`data-${i}.csv`, big),
        })
      ).status,
      201,
    );
  const { references } = libraryFor(store, { projectId: project, kind: 'general' });
  assert.equal(libraryDeliveryBytes, 20 * 1024 * 1024);
  assert.deepEqual(
    references.map(item => item.delivered),
    [true, true, true, true, true, false],
  );
  const dropped = await c.request('/api/projects/project-legacy/library', {
    projectId: project,
    name: 'Old brand',
    purpose: 'Leave this out of the idea.',
    file: upload('old.md', '# Old\n'),
  });
  assert.equal(dropped.status, 201, JSON.stringify(dropped.data));
  const runId = 'run-00000000-0000-4000-8000-000000000002';
  store.putRun(
    newRun({
      id: runId,
      projectId: project,
      workflow: { id: 'library-fixture', name: 'Library fixture', version: 1 },
      graph: { nodes: [], edges: [] },
      envelope: { nodes: 2, attemptSeconds: 120 },
      taskIds: [],
      at: new Date().toISOString(),
    }),
  );
  const excluded = await c.request(`/api/projects/project-legacy/runs/${runId}/library`, {
    projectId: project,
    leftOut: [dropped.data.id],
  });
  assert.equal(excluded.status, 200, JSON.stringify(excluded.data));
  const work = await runTask(c, 'Use the large library', { runReference: { runId } });
  assert.equal((await c.request(`/api/tasks/${work.taskId}/accept`)).status, 200);
  const producer = store.attempt(store.task(work.taskId).acceptedAttemptId),
    leftOut = [{ entryId: dropped.data.id, name: 'Old brand' }];
  assert.deepEqual(producer.libraryReferences, references);
  assert.deepEqual(producer.libraryLeftOut, leftOut);
  // Change both the current revision and exclusions before the consumer is claimed.
  const revised = await c.request(`/api/projects/project-legacy/library/${references[0].entryId}/revisions`, {
    projectId: project,
    file: upload('data-1.csv', 'Updated data\n'),
  });
  assert.equal(revised.status, 201, JSON.stringify(revised.data));
  assert.equal(
    (await c.request(`/api/projects/project-legacy/runs/${runId}/library`, { projectId: project, leftOut: [] })).status,
    200,
  );
  const review = await runTask(c, 'Consume the original large library', {
    kind: 'library-fixture:consumer',
    dependencies: [producer.taskId],
    runReference: { runId },
  });
  const storedReview = store.attempt(review.id);
  assert.equal(storedReview.status, 'review');
  assert.equal(storedReview.inputReferences[0].attemptId, producer.id);
  assert.deepEqual(
    storedReview.libraryReferences,
    references,
    'Revisions, hashes, paths and delivery flags stay pinned.',
  );
  assert.deepEqual(storedReview.libraryLeftOut, leftOut);
  for (const reference of storedReview.libraryReferences) {
    const staged = path.resolve(storedReview.outputFolder, reference.path);
    assert.equal(fs.existsSync(staged), reference.delivered);
    if (reference.delivered) assert.equal(hash(fs.readFileSync(staged)), reference.sha256);
  }
  assert.match(storedReview.instructions.layers.find(layer => layer.title === 'Project library').text, /Old brand/);
  assert.deepEqual(store.attempt(producer.id).libraryReferences, references);
  // Without same-as-inputs, even a review-named task still gets the current library.
  const inputs = [{ taskId: producer.taskId, attemptId: producer.id }];
  const current = libraryFor(store, { projectId: project, kind: 'studio-development:change-review' }, inputs);
  assert.equal(current.references[0].revision, 2);
  assert.ok(current.references.some(item => item.entryId === dropped.data.id));
  assert.deepEqual(libraryFor(store, { projectId: project, kind: 'general' }, inputs, { delivery: 'none' }), {
    references: [],
    leftOut: [],
  });
});

test("the director leaves named files out of an idea's work, and each attempt records what it left out", async t => {
  const c = await setup(t),
    store = c.app.store;
  const keep = (
      await c.request('/api/projects/project-legacy/library', {
        projectId: project,
        name: 'Spec',
        purpose: 'The rules.',
        file: upload('spec.md', '# Spec\n'),
      })
    ).data,
    drop = (
      await c.request('/api/projects/project-legacy/library', {
        projectId: project,
        name: 'Old brand',
        purpose: 'Last year.',
        file: upload('old.md', '# Old\n'),
      })
    ).data;
  const runId = 'run-00000000-0000-4000-8000-000000000001';
  store.putRun({ id: runId, projectId: project, createdAt: new Date().toISOString() });
  const set = await c.request(`/api/projects/project-legacy/runs/${runId}/library`, {
    projectId: project,
    leftOut: [drop.id],
  });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const { libraryFor } = await import('../src/core/library.mjs');
  const forIdea = libraryFor(store, { projectId: project, kind: 'general', runReference: { runId } });
  assert.deepEqual(
    forIdea.references.map(item => item.entryId),
    [keep.id],
  );
  assert.deepEqual(forIdea.leftOut, [{ entryId: drop.id, name: 'Old brand' }]);
  const unknown = await c.request(`/api/projects/project-legacy/runs/${runId}/library`, {
    projectId: project,
    leftOut: ['lib-00000000-0000-4000-8000-000000000000'],
  });
  assert.equal(unknown.status, 404);
});

// Work in review that handed back a file and a proposal for the library, as an agent returns them.
function proposingWork(store, id, proposals, files = { 'guide.md': '# Guide\n' }) {
  const attempt = {
      id: `attempt-${id}`,
      taskId: `T-${id}`,
      projectId: project,
      workerId: 'W-03',
      status: 'review',
      result: {
        taskId: `T-${id}`,
        outcome: 'completed',
        summary: 'Done.',
        artifacts: [],
        checks: [],
        issues: [],
        handoff: '',
      },
      contracts: { task: { kind: 'general', version: 'general-v1', acceptFailedChecks: false } },
    },
    output = path.join(store.directory, 'jobs', attempt.id, 'output');
  fs.mkdirSync(output, { recursive: true });
  const all = {
    ...files,
    'library-proposal.json': JSON.stringify({ schemaVersion: 'library-proposal-v1', proposals }),
  };
  attempt.outputFolder = output;
  attempt.artifacts = Object.entries(all).map(([file, text]) => {
    fs.writeFileSync(path.join(output, file), text);
    return {
      path: file,
      kind: file === 'library-proposal.json' ? 'library-proposal' : 'document',
      hash: hash(Buffer.from(text)),
    };
  });
  attempt.result.artifacts = attempt.artifacts.map(({ path: file, kind }) => ({ path: file, kind }));
  store.putTask({
    id: attempt.taskId,
    projectId: project,
    kind: 'general',
    workerId: 'W-03',
    title: `Work ${id}`,
    status: 'review',
    lastAttemptId: attempt.id,
    dependencies: [],
  });
  store.insertAttempt(attempt, { text: 'Fixture', hash: 'fixture' });
  return store.task(attempt.taskId);
}

test('a proposed library file waits for the director, who approves or rejects it, once the work is accepted', async t => {
  const c = await setup(t),
    store = c.app.store,
    { acceptAttempt } = await import('../src/core/acceptance.mjs');
  const task = proposingWork(store, 'guide', [
    { name: 'House guide', purpose: 'How pages are written.', path: 'guide.md' },
  ]);
  acceptAttempt(store, c.app.runner.registries, task);
  let [proposal] = libraryOf(store, project).proposals;
  assert.equal(proposal.state, 'waiting');
  assert.deepEqual(proposal.from, { taskId: task.id, attemptId: 'attempt-guide', path: 'guide.md' });
  assert.equal(currentEntries(libraryOf(store, project)).length, 0, 'Nothing joins until it is approved.');
  const approved = await c.request(`/api/projects/project-legacy/library/proposals/${proposal.id}/approve`, {
    projectId: project,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.state, 'approved');
  const [entry] = currentEntries(libraryOf(store, project));
  assert.equal(entry.name, 'House guide');
  assert.equal(entry.revisions[0].source.attemptId, 'attempt-guide');
  const again = await c.request(`/api/projects/project-legacy/library/proposals/${proposal.id}/reject`, {
    projectId: project,
  });
  assert.equal(again.status, 409);
  // A rejected proposal adds nothing.
  const other = proposingWork(store, 'notes', [{ name: 'Notes', purpose: 'Loose notes.', path: 'guide.md' }]);
  acceptAttempt(store, c.app.runner.registries, other);
  proposal = libraryOf(store, project).proposals.find(item => item.name === 'Notes');
  const rejected = await c.request(`/api/projects/project-legacy/library/proposals/${proposal.id}/reject`, {
    projectId: project,
  });
  assert.equal(rejected.data.state, 'rejected');
  assert.equal(currentEntries(libraryOf(store, project)).length, 1);
  assert.ok(
    store.events().some(event => event.kind === 'library_decided' && /The director rejected Notes/.test(event.message)),
  );
});

test("with the project's autonomy policy on, the policy approves a proposal at once, and a revision of an existing entry", async t => {
  const c = await setup(t),
    store = c.app.store,
    { acceptAttempt } = await import('../src/core/acceptance.mjs');
  store.putSetting('project-autonomy:project-legacy', {
    revision: 4,
    enabled: true,
    kinds: {},
    retries: 0,
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  acceptAttempt(
    store,
    c.app.runner.registries,
    proposingWork(store, 'first', [{ name: 'Guide', purpose: 'The guide.', path: 'guide.md' }]),
  );
  const [entry] = currentEntries(libraryOf(store, project));
  assert.equal(entry.by.type, 'policy');
  assert.equal(libraryOf(store, project).proposals[0].decidedBy.revision, 4);
  acceptAttempt(
    store,
    c.app.runner.registries,
    proposingWork(
      store,
      'second',
      [{ name: 'Guide', purpose: 'The guide, revised.', path: 'guide.md', entryId: entry.id }],
      { 'guide.md': '# Guide, second\n' },
    ),
  );
  assert.deepEqual(
    currentEntries(libraryOf(store, project))[0].revisions.map(item => item.revision),
    [1, 2],
  );
  // One the library cannot take is recorded as refused, with the reason, and the work stays accepted.
  const twice = proposingWork(store, 'third', [{ name: 'guide', purpose: 'Again.', path: 'guide.md' }], {
    'guide.md': '# Third\n',
  });
  acceptAttempt(store, c.app.runner.registries, twice);
  const refused = libraryOf(store, project).proposals.at(-1);
  assert.equal(refused.state, 'refused');
  assert.match(refused.problem, /already has an entry named guide/);
  assert.equal(store.task(twice.id).status, 'done');
});

test('a proposal must name one of the files the work handed back; one that does not leaves the acceptance standing', async t => {
  const c = await setup(t),
    store = c.app.store,
    { acceptAttempt } = await import('../src/core/acceptance.mjs');
  const task = proposingWork(store, 'stray', [{ name: 'Elsewhere', purpose: 'x', path: '../secrets.md' }]);
  assert.equal(acceptAttempt(store, c.app.runner.registries, task).ok, true);
  assert.equal(store.task(task.id).status, 'done');
  assert.equal(libraryOf(store, project).proposals, undefined);
  assert.ok(
    store
      .events()
      .some(
        event =>
          event.kind === 'library_proposed' &&
          /must name one of the files this attempt handed back/.test(event.message),
      ),
  );
});

// October 29: a glossary proposed by a step whose review was still to come was refused by the policy at the step's
// acceptance, since the work was not finished, and nothing decided it again once the review passed.
test("a proposal made before the work's review passes waits for it, then the policy adds it, and approving it early is refused without deciding", async t => {
  const c = await setup(t),
    store = c.app.store,
    { recordLibraryProposals } = await import('../src/core/library.mjs'),
    policy = {
      revision: 4,
      enabled: true,
      kinds: {},
      retries: 0,
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
    };
  store.putSetting('project-autonomy:project-legacy', policy);
  const task = proposingWork(store, 'staged', [
    { name: 'Glossary', purpose: 'The words the menu uses.', path: 'guide.md' },
  ]);
  // The step's attempt is accepted while its review is still to come, as a task with stages leaves it.
  const attempt = store.attempt('attempt-staged');
  store.updateAttempt({ ...attempt, status: 'accepted', acceptedAt: new Date().toISOString() });
  store.putTask({ ...store.task(task.id), status: 'ready', acceptedAttemptId: attempt.id });
  recordLibraryProposals(
    store,
    store.task(task.id),
    store.attempt(attempt.id),
    name => fs.readFileSync(path.join(attempt.outputFolder, name)),
    policy,
  );
  let [proposal] = libraryOf(store, project).proposals;
  assert.equal(proposal.state, 'waiting');
  assert.equal(currentEntries(libraryOf(store, project)).length, 0);
  const early = await c.request(`/api/projects/project-legacy/library/proposals/${proposal.id}/approve`, {
    projectId: project,
  });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /That work isn't finished yet: its file can join the library once its review passes/);
  assert.equal(libraryOf(store, project).proposals[0].state, 'waiting');
  // The review is accepted and the work finished: its acceptance, with no proposal of its own, settles the step's.
  store.putTask({ ...store.task(task.id), status: 'done' });
  recordLibraryProposals(store, store.task(task.id), { artifacts: [] }, () => '', policy);
  [proposal] = libraryOf(store, project).proposals;
  assert.equal(proposal.state, 'approved', JSON.stringify(proposal));
  assert.equal(proposal.decidedBy.revision, 4);
  assert.equal(currentEntries(libraryOf(store, project))[0].name, 'Glossary');
});
