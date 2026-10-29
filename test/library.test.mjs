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
  const created = await c.request('/api/tasks', {
    title,
    workerId: 'W-03',
    kind: 'general',
    brief: 'Bounded model-free work.',
    ...extra,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  c.app.runner.start(created.data.id);
  const done = await c.wait(created.data.id);
  return done.attempt || c.app.store.attempt(c.app.store.task(created.data.id).lastAttemptId);
}

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
  assert.equal(after.libraryReferences, undefined);
  assert.doesNotMatch(store.attempt(after.id).instructions.text, /# Project library/);
});

test('files past the size limit are in the index alone, and a review receives the same files as the work it reviews', async t => {
  const c = await setup(t),
    store = c.app.store,
    { libraryFor, libraryDeliveryBytes } = await import('../src/core/library.mjs');
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
  // A review takes the reviewed attempt's references exactly, whatever the library holds now.
  const reviewed = { libraryReferences: references.slice(0, 2), libraryLeftOut: [{ entryId: 'lib-x', name: 'Gone' }] };
  const fake = { ...store, attempt: id => (id === 'attempt-reviewed' ? reviewed : store.attempt(id)) };
  Object.setPrototypeOf(fake, Object.getPrototypeOf(store));
  const review = libraryFor(fake, { projectId: project, kind: 'studio-development:change-review' }, [
    { taskId: 'T-1', attemptId: 'attempt-reviewed' },
  ]);
  assert.deepEqual(review.references, reviewed.libraryReferences);
  assert.deepEqual(review.leftOut, reviewed.libraryLeftOut);
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
