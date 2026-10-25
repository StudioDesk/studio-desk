// The director's settings that Settings and an agent's page change (v1.0 item 23): how many attempts run at
// once, a project's color, an agent's face and an existing project's repository profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './studio-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';

const running = c => c.app.store.allAttempts().filter(attempt => attempt.status === 'running');

test('the director sets how many attempts run at the same time, and the scheduler keeps to it', async t => {
  // Simulated attempts last until they are cancelled, so the slots are what decides.
  const delay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '60000';
  t.after(() => {
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
  });
  const c = await setup(t),
    store = c.app.store,
    employees = store.organization().workers.length;
  for (const value of [0, 1.5, '2', null, employees + 1]) {
    const refused = await c.request('/api/control', { maxParallel: value });
    assert.equal(refused.status, 400, String(value));
    assert.equal(refused.data.error, `Choose from 1 to ${employees} attempts at the same time.`);
  }
  assert.equal(store.organization().maxParallel, 2);
  const create = async workerId =>
    (
      await c.request('/api/tasks', {
        title: 'Independent staged work',
        brief: 'Return a bounded text file.',
        kind: 'general',
        workerId,
      })
    ).data;
  const second = await create('W-02'),
    third = await create('W-04');
  // One at a time: the second start waits for a slot.
  assert.equal((await c.request('/api/control', { maxParallel: 1 })).status, 200);
  assert.equal(store.organization().maxParallel, 1);
  assert.match(
    store.events().at(-1).message,
    /^Up to 1 attempt at the same time from now; running attempts continue\.$/,
  );
  assert.equal((await c.request('/api/tasks/D-001/start')).status, 202);
  const queued = await c.request(`/api/tasks/${second.id}/start`);
  assert.equal(queued.status, 202);
  assert.equal(queued.data.queued, true);
  assert.equal(store.attempts(second.id).length, 0);
  assert.equal(store.task(second.id).reason, 'Waiting for a studio execution slot.');
  // A higher limit starts it at once, while the first still runs.
  assert.equal((await c.request('/api/control', { maxParallel: 2 })).status, 200);
  await c.until(() => store.attempts(second.id).length === 1, 'a raised limit starts the waiting task');
  assert.equal(running(c).length, 2);
  // A lower limit stops nothing that runs, and new work waits until the running total is under it.
  assert.equal((await c.request('/api/control', { maxParallel: 1 })).status, 200);
  assert.equal(running(c).length, 2);
  assert.equal((await c.request(`/api/tasks/${third.id}/start`)).data.queued, true);
  await c.request('/api/tasks/D-001/cancel');
  await c.until(() => store.task('D-001').status !== 'running', 'the first attempt stops');
  assert.equal(store.attempts(third.id).length, 0, 'one attempt still runs, which is the limit');
  await c.request(`/api/tasks/${second.id}/cancel`);
  await c.until(() => store.attempts(third.id).length === 1, 'a slot under the limit starts the waiting task');
  await c.request(`/api/tasks/${third.id}/cancel`);
  await c.until(() => !running(c).length, 'every attempt stops');
});

test("a project's color is the director's choice of mark and records no new direction", async t => {
  const c = await setup(t),
    store = c.app.store,
    created = await c.request('/api/projects', { name: 'Colors', goal: 'A goal', direction: 'A direction' }),
    id = created.data.id,
    edit = body => c.request(`/api/projects/${id}`, { projectId: id, expectedRevision: 1, ...body }, 'PATCH');
  assert.equal(created.status, 201);
  const colored = await edit({ color: 'mint' });
  assert.equal(colored.status, 200, JSON.stringify(colored.data));
  assert.equal(store.project(id).color, 'mint');
  assert.equal(store.project(id).revision, 1, 'a color is not direction');
  assert.equal(store.project(id).updatedAt, undefined);
  assert.equal(store.events().at(-1).message, 'Project color changed.');
  for (const color of ['Mint', 'mint!', 7, '', 'a'.repeat(25)]) {
    const refused = await edit({ color });
    assert.equal(refused.status, 400, String(color));
    assert.equal(refused.data.error, 'A project color is the name of one in the palette.');
  }
  // Saving the same name, goal and direction changes nothing and keeps the color.
  const events = store.events().length;
  assert.equal((await edit({ name: 'Colors', goal: 'A goal', direction: 'A direction' })).status, 200);
  assert.equal(store.project(id).revision, 1);
  assert.equal(store.project(id).color, 'mint');
  assert.equal(store.events().length, events);
  // A new direction with a color records both, the direction as the next revision.
  assert.equal((await edit({ name: 'Colors', goal: 'A goal', direction: 'Later', color: 'sky' })).status, 200);
  assert.deepEqual([store.project(id).revision, store.project(id).color], [2, 'sky']);
  assert.deepEqual(
    store
      .events()
      .slice(-2)
      .map(event => event.message),
    ['Project direction updated for future attempts.', 'Project color changed.'],
  );
  // Null gives the project back the color its place gives it.
  assert.equal(
    (await c.request(`/api/projects/${id}`, { projectId: id, expectedRevision: 2, color: null }, 'PATCH')).status,
    200,
  );
  assert.equal(Object.hasOwn(store.project(id), 'color'), false);
  const listed = await (await fetch(c.origin + '/api/projects')).json();
  assert.equal(listed.projects.find(project => project.id === id).revision, 2);
});

test("an agent's face is stored as its look, without changing how it runs", async t => {
  const c = await setup(t),
    store = c.app.store,
    worker = () => store.organization().workers.find(item => item.id === 'W-02'),
    version = worker().configVersion,
    look = { body: 3, color: 9, eyes: 0, mouth: 4, top: 7, detail: 2 },
    choose = body => c.request('/api/workers/W-02/look', body);
  const chosen = await choose({ look: { detail: 2, top: 7, mouth: 4, eyes: 0, color: 9, body: 3 } });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));
  assert.deepEqual(chosen.data.look, look);
  assert.deepEqual(worker().look, look);
  assert.equal(worker().configVersion, version, 'a face is not configuration');
  assert.equal(store.events().at(-1).message, `${worker().displayName}: face changed.`);
  assert.deepEqual((await c.state()).workers.find(item => item.id === 'W-02').look, look);
  for (const wrong of [
    { ...look, body: 10 },
    { ...look, eyes: -1 },
    { ...look, top: 1.5 },
    { ...look, mouth: '4' },
    { body: 3, color: 9, eyes: 0, mouth: 4, top: 7 },
    { ...look, hat: 1 },
    [3, 9, 0, 4, 7, 2],
    'look',
  ]) {
    const refused = await choose({ look: wrong });
    assert.equal(refused.status, 400, JSON.stringify(wrong));
    assert.match(refused.data.error, /^A face is six part numbers from 0 to 9/);
  }
  assert.equal((await choose({ look, name: 'Pip' })).status, 400);
  assert.equal((await c.request('/api/workers/W-99/look', { look })).status, 400);
  assert.deepEqual(worker().look, look);
  // Null gives the agent back the face picked from its project and role.
  assert.equal((await choose({ look: null })).status, 200);
  assert.equal(Object.hasOwn(worker(), 'look'), false);
});

test("an existing project's profile is edited only while nothing in it runs, and once its tests pass", async t => {
  const c = await setup(t),
    store = c.app.store,
    root = path.join(c.dir, 'site'),
    write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    },
    commit = message => {
      git(root, ['add', '-A']);
      git(root, ['commit', '--quiet', '-m', message]);
    },
    contactTest = expected =>
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isEmail } from '../lib/contact.mjs';\n" +
      `test('a bare name is not an email address', () => assert.equal(isEmail('director'), ${expected}));\n`;
  write('README.md', '# A site\n');
  write('lib/contact.mjs', 'export const isEmail = value => /^[^\\s@]+@[^\\s@]+$/.test(value);\n');
  write('tests/contact.test.mjs', contactTest(false));
  write('docs/notes.md', '# Notes\n');
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  commit('A site');
  const created = await c.request('/api/projects', { name: 'Site', repository: { root } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id,
    profile = store.project(id).source.profile,
    url = `/api/projects/${id}/source`,
    save = (edited, expectedRevision = 1) => c.request(url, { projectId: id, expectedRevision, profile: edited });
  // Check again reads the repository as it is now, with its recorded profile, and records nothing.
  const inspected = await c.request(url + '/inspect', { projectId: id });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
  assert.deepEqual([inspected.data.clean, inspected.data.problems, inspected.data.revision], [true, [], 1]);
  assert.deepEqual(inspected.data.profile, profile);
  assert.equal(inspected.data.branch, 'main');
  // An edited profile records its next revision once the tests pass with it; the tree need not be clean.
  write('README.md', '# A site, being edited\n');
  const edited = { ...profile, contextFiles: ['README.md', 'docs/notes.md'], id: 'another-id' },
    saved = await save(edited);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.tests.pass, 1);
  const source = store.project(id).source;
  assert.equal(source.revision, 2);
  assert.deepEqual(source.profile, { ...edited, id: profile.id }, 'the profile keeps its identity');
  assert.match(
    store.events().at(-1).message,
    /^Repository settings revision 2 recorded for future stories; its tests: 1\/1 tests passed\.$/,
  );
  // A stale revision, an invalid profile or failing tests record nothing.
  const refusedStale = await save(edited, 1);
  assert.equal(refusedStale.status, 409);
  assert.equal(refusedStale.data.error, 'The repository settings changed. Refresh before saving.');
  const invalid = await save({ ...edited, contextFiles: ['elsewhere/file.md'] }, 2);
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /contextFiles must be files the snapshot covers/);
  git(root, ['checkout', '--quiet', '--', 'README.md']);
  write('tests/contact.test.mjs', contactTest(true));
  commit('A failing test');
  const failing = await save({ ...edited, contextFiles: ['README.md'] }, 2);
  assert.equal(failing.status, 400);
  assert.match(
    failing.data.error,
    /^The repository's tests must pass before these settings are saved: 0 of 1 passed \(failing: a bare name is not an email address\)\. They run on a copy holding only the folders and top-level files in the repository settings\. If they pass in the repository itself, add the folders they need to those settings and save the settings again; otherwise fix the failing tests, commit, then save the settings again\.$/,
  );
  assert.equal(store.project(id).source.revision, 2);
  // Nothing in the project may hold its source while the profile changes.
  write('tests/contact.test.mjs', contactTest(false));
  commit('Fix the test');
  store.claim([`source:${id}:tests`], 'held-by-a-story');
  const busy = await save({ ...edited, contextFiles: ['README.md'] }, 2);
  assert.equal(busy.status, 409);
  assert.equal(busy.data.error, 'Wait until nothing in this project is running, then save the repository settings.');
  store.release('held-by-a-story');
  assert.equal((await save({ ...edited, contextFiles: ['README.md'] }, 2)).status, 200);
  assert.deepEqual(store.project(id).source.profile.contextFiles, ['README.md']);
  // A project on the controller's own source has the built-in profile, which is not edited here.
  const general = (await c.request('/api/projects', { name: 'General' })).data.id;
  const own = await c.request(`/api/projects/${general}/source/inspect`, { projectId: general });
  assert.equal(own.status, 400);
  assert.match(own.data.error, /built-in repository settings/);
});

// Each setting changes only through the protected API: the dashboard's request token on a loopback request.
test('every setting refuses a request without the dashboard request token', async t => {
  const c = await setup(t),
    store = c.app.store,
    id = store.projects()[0].id,
    before = JSON.stringify([store.organization(), store.projects()]);
  for (const [url, body, method] of [
    ['/api/control', { maxParallel: 1 }, 'POST'],
    [`/api/projects/${id}`, { projectId: id, expectedRevision: store.project(id).revision, color: 'sky' }, 'PATCH'],
    ['/api/workers/W-02/look', { look: { body: 1, color: 1, eyes: 1, mouth: 1, top: 1, detail: 1 } }, 'POST'],
    [`/api/projects/${id}/source/inspect`, { projectId: id }, 'POST'],
    [`/api/projects/${id}/source`, { projectId: id, expectedRevision: 1, profile: {} }, 'POST'],
  ]) {
    const res = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 403, url);
  }
  assert.equal(JSON.stringify([store.organization(), store.projects()]), before);
});

test("Settings names the app's own version, from its package.json", async t => {
  const c = await setup(t),
    state = await (await fetch(c.origin + '/api/state?mode=dashboard')).json(),
    manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(state.runtime.version, manifest.version);
});
