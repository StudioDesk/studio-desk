// Who may use the controller (C-01, src/director-access.mjs): every request needs the director's session cookie,
// set by this start's launch link, or the data folder's key; a program on this computer with neither (an agent's
// tests reach every loopback port, even inside the built-in sandbox) reads nothing and changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createStudio } from './model-free-studio.mjs';
import { closeAndRemove } from './fixture-cleanup.mjs';
import { directorKey, directorKeyFile } from '../src/director-access.mjs';

const tokenMeta = /name="studio-token" content="[0-9a-f]{48}"/;
const plain = { directorKey: false };

async function studio(t, options = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'studio-access-'));
  const app = createStudio({ directory, port: 0, ...options });
  const origin = await app.start();
  if (!options.directory) t.after(() => closeAndRemove(app, directory));
  return { app, origin, directory };
}

test('a request with neither the session nor the key reads nothing and changes nothing', async t => {
  const { origin } = await studio(t);
  const page = await fetch(origin, plain);
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.doesNotMatch(html, tokenMeta, 'the page hands out no request token');
  assert.match(html, /Open Studio desk from its link/);
  for (const route of ['/api/projects', '/api/state', '/api/templates', '/api/changes?after=0'])
    assert.equal((await fetch(origin + route, plain)).status, 401, route);
  const stream = await fetch(origin + '/api/events', plain);
  assert.equal(stream.status, 401);
  const answer = await (await fetch(origin + '/api/projects', plain)).json();
  assert.match(answer.error, /launch/);
  const write = await fetch(origin + '/api/control', {
    ...plain,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': 'f'.repeat(48) },
    body: JSON.stringify({ maxParallel: 3 }),
  });
  assert.equal(write.status, 401);
  // The built dashboard's files hold no records and need no session.
  assert.equal((await fetch(origin + '/assets/missing.js', plain)).status, 404);
});

test('a program started on this computer without the key cannot read the records or the token', async t => {
  const { origin } = await studio(t);
  const probe = `const o=process.argv[1];Promise.all([fetch(o+'/api/projects'),fetch(o)]).then(async([a,b])=>console.log(JSON.stringify({records:a.status,page:b.status,token:/studio-token" content="[0-9a-f]{20,}/.test(await b.text())})))`;
  const output = await new Promise((resolve, reject) =>
    execFile(process.execPath, ['-e', probe, origin], { timeout: 30000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
  assert.deepEqual(JSON.parse(output), { records: 401, page: 401, token: false });
});

test('the launch link signs a browser in with a session cookie that opens the dashboard and its commands', async t => {
  const { app, origin, directory } = await studio(t);
  assert.equal(fs.readFileSync(path.join(directory, 'launch-url'), 'utf8').trim(), app.launchUrl);
  assert.ok(app.launchUrl.startsWith(origin + '/launch/'));
  const launched = await fetch(app.launchUrl, { ...plain, redirect: 'manual' });
  assert.equal(launched.status, 303);
  assert.equal(launched.headers.get('location'), '/');
  const setCookie = launched.headers.get('set-cookie');
  assert.match(setCookie, /^studio_desk_[0-9a-f]{12}=[0-9a-f]{64}; /);
  for (const part of ['Path=/', 'HttpOnly', 'SameSite=Strict']) assert.ok(setCookie.includes(part), part);
  const cookie = setCookie.split(';')[0],
    signedIn = { ...plain, headers: { cookie } };
  const page = await fetch(origin, signedIn);
  // 503 is the page for a copy whose dashboard is not built yet, which carries the token as the built one does.
  assert.ok([200, 503].includes(page.status), String(page.status));
  const token = (await page.text()).match(/name="studio-token" content="([0-9a-f]{48})"/)[1];
  assert.equal((await fetch(origin + '/api/projects', signedIn)).status, 200);
  const write = await fetch(origin + '/api/control', {
    ...plain,
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', 'X-Studio-Token': token },
    body: JSON.stringify({ maxParallel: 3 }),
  });
  assert.equal(write.status, 200);
  assert.equal(app.store.organization().maxParallel, 3);
  // The request token still guards every command the cookie signs in, as it guards against other pages in the
  // browser. A command without the header is told which header it lacks, where its value comes from, and that a local
  // tool sends the key instead.
  const command = headers =>
    fetch(origin + '/api/control', {
      ...plain,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ maxParallel: 2 }),
    });
  const tokenless = await command({ cookie });
  assert.equal(tokenless.status, 403);
  const refusal = (await tokenless.json()).error;
  assert.match(refusal, /X-Studio-Token header/);
  assert.match(refusal, /studio-token meta tag/);
  assert.match(refusal, /X-Studio-Key/);
  // One whose token is not this start's is told it is from an earlier start, in the words the dashboard reads as a
  // restart (dashboard/src/api.ts staleToken).
  const wrong = await command({ cookie, 'X-Studio-Token': 'f'.repeat(48) });
  assert.equal(wrong.status, 403);
  const earlier = (await wrong.json()).error;
  assert.match(earlier, /from an earlier start of the controller/);
  assert.match(earlier, /Reload the page/);
  const dashboardApi = fs.readFileSync(new URL('../dashboard/src/api.ts', import.meta.url), 'utf8');
  assert.ok(dashboardApi.includes(earlier), 'the dashboard recognises the earlier-start message');
  // An empty header carries a token too, just not this start's: the dashboard sends one when its page has none.
  const empty = await command({ cookie, 'X-Studio-Token': '' });
  assert.equal(empty.status, 403);
  assert.equal((await empty.json()).error, earlier);
  assert.equal(app.store.organization().maxParallel, 3, 'no refused command changed anything');
  // A link that is not this start's, or a cookie made up, signs nothing in.
  const stale = await fetch(origin + '/launch/' + 'f'.repeat(48), plain);
  assert.equal(stale.status, 403);
  assert.match(await stale.text(), /from an earlier start/);
  const forged = cookie.replace(/=.*/, '=' + '0'.repeat(64));
  assert.equal((await fetch(origin + '/api/projects', { ...plain, headers: { cookie: forged } })).status, 401);
});

test("local tools send the data folder's key; a wrong key is refused", async t => {
  const { app, origin, directory } = await studio(t);
  assert.equal(fs.readFileSync(directorKeyFile(directory), 'utf8').trim(), app.directorKey);
  assert.equal(
    (await fetch(origin + '/api/projects', { ...plain, headers: { 'x-studio-key': app.directorKey } })).status,
    200,
  );
  assert.equal(
    (await fetch(origin + '/api/projects', { ...plain, headers: { 'x-studio-key': 'a'.repeat(64) } })).status,
    401,
  );
  assert.equal((await fetch(origin + '/api/projects', { ...plain, headers: { 'x-studio-key': 'é' } })).status, 401);
});

const keyedEvents = app =>
  app.store.db.prepare("SELECT message FROM events WHERE kind='director_key' ORDER BY seq").all();

test("a command sent with the director's key needs no request token, and leaves a line in the activity once it succeeds", async t => {
  const { app, origin } = await studio(t);
  const keyed = (route, body, headers = {}) =>
    fetch(origin + route, {
      ...plain,
      method: 'POST',
      headers: { 'x-studio-key': app.directorKey, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  // A command no route lists reaches no handler and leaves no line in any activity.
  const unlisted = await keyed('/api/no-such-command', '{}');
  assert.equal(unlisted.status, 404);
  assert.deepEqual(keyedEvents(app), []);
  // A listed command its handler refuses changes nothing and leaves none either.
  const before = app.store.organization().maxParallel;
  const refused = await keyed('/api/control', { maxParallel: 'many' });
  assert.ok(refused.status >= 400 && refused.status < 500, String(refused.status));
  assert.match((await refused.json()).error, /attempts at the same time/);
  const unknownField = await keyed('/api/control', { paused: 'yes' });
  assert.ok(unknownField.status >= 400 && unknownField.status < 500, String(unknownField.status));
  assert.equal(app.store.organization().maxParallel, before);
  assert.deepEqual(keyedEvents(app), []);
  // One that succeeds leaves exactly one line, worded as before.
  const sent = await keyed('/api/control', { maxParallel: 3 });
  assert.equal(sent.status, 200);
  assert.equal(app.store.organization().maxParallel, 3);
  assert.deepEqual(
    keyedEvents(app).map(line => line.message),
    ["A local tool sent POST /api/control with the director's key."],
  );
  // A command's answer still carries only the records the command made: its line is written after them.
  const projectId = app.store.projects()[0]?.id;
  if (projectId) {
    const recorded = await keyed('/api/control', { projectId, maxParallel: 4 }, { 'X-Studio-Records': '1' });
    assert.equal(recorded.status, 200);
    const { records } = await recorded.json();
    assert.ok(Array.isArray(records.changes), 'The answer carries its records.');
    assert.ok(!records.changes.some(change => change.kind === 'director_key'), 'The line is not among the records.');
    assert.ok(records.version < app.store.version, 'The line was recorded after the records were read.');
    assert.equal(keyedEvents(app).length, 2);
  }
});

test('only the key header stands for the key, and the session cookie alone still needs the token', async t => {
  const { app, origin } = await studio(t);
  const cookie = (await fetch(app.launchUrl, { ...plain, redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const command = (headers, { query = '', body = { maxParallel: 5 } } = {}) =>
    fetch(origin + '/api/control' + query, {
      ...plain,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  // Signed in by the cookie, the key in a query string, a cookie or the body changes nothing: the token is needed.
  for (const attempt of [
    command({ cookie }, { query: '?key=' + app.directorKey }),
    command({ cookie: `${cookie}; x-studio-key=${app.directorKey}` }),
    command({ cookie }, { body: { maxParallel: 5, key: app.directorKey, 'x-studio-key': app.directorKey } }),
  ])
    assert.equal((await attempt).status, 403);
  // Without the cookie, those are not signed in at all; a wrong key is refused before any token is weighed.
  assert.equal((await command({}, { query: '?key=' + app.directorKey })).status, 401);
  assert.equal((await command({ 'x-studio-key': 'b'.repeat(64) })).status, 401);
  // Another page in the browser, even one that somehow knew the key, is refused for its origin first.
  const crossOrigin = await command({ 'x-studio-key': app.directorKey, Origin: 'http://127.0.0.1:1' });
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin/);
  assert.notEqual(app.store.organization().maxParallel, 5);
});

test('reads answer an unknown route with 404 and other methods with 405', async t => {
  const { app, origin } = await studio(t);
  const key = { ...plain, headers: { 'x-studio-key': app.directorKey } };
  const unknown = await fetch(origin + '/api/no-such-read', key);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /Unknown read route\. Commands are sent with POST or PATCH\./);
  // A command asked for with GET is no read either, for the dashboard as for a tool.
  assert.equal((await fetch(origin + '/api/control', key)).status, 404);
  const deleted = await fetch(origin + '/api/control', { ...key, method: 'DELETE' });
  assert.equal(deleted.status, 405);
  assert.equal(deleted.headers.get('allow'), 'POST, PATCH');
  assert.match((await deleted.json()).error, /POST or PATCH/);
});

test("no page, read or export hands out the director's key", async t => {
  const { app, origin } = await studio(t);
  const key = { ...plain, headers: { 'x-studio-key': app.directorKey } };
  const project = (await (await fetch(origin + '/api/projects', key)).json()).projects[0]?.id;
  const routes = ['/', '/api/projects', '/api/templates', '/api/changes?after=0', '/api/state'];
  if (project)
    routes.push(
      `/api/state?mode=dashboard&projectId=${encodeURIComponent(project)}`,
      `/api/export?projectId=${encodeURIComponent(project)}`,
    );
  for (const route of routes) {
    const answer = await fetch(origin + route, key);
    assert.doesNotMatch(await answer.text(), new RegExp(app.directorKey), route);
  }
  for (const route of ['/', '/api/projects', app.launchUrl.slice(origin.length), '/launch/' + 'f'.repeat(48)]) {
    const answer = await fetch(origin + route, { ...plain, redirect: 'manual' });
    assert.ok(!(await answer.text()).includes(app.directorKey), route);
    assert.ok(!(answer.headers.get('set-cookie') || '').includes(app.directorKey), route);
  }
});

test('a browser stays signed in across a restart, and an old launch link stops working', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-access-'));
  const first = await studio(t, { directory });
  t.after(() => first.app.close());
  const cookie = (await fetch(first.app.launchUrl, { ...plain, redirect: 'manual' })).headers
    .get('set-cookie')
    .split(';')[0];
  const oldLink = first.app.launchUrl.slice(first.origin.length),
    key = first.app.directorKey;
  await first.app.close();
  const second = await studio(t, { directory });
  t.after(() => closeAndRemove(second.app, directory));
  assert.equal(second.app.directorKey, key, 'the key is kept in the data folder');
  assert.equal((await fetch(second.origin + '/api/projects', { ...plain, headers: { cookie } })).status, 200);
  assert.equal((await fetch(second.origin + oldLink, plain)).status, 403);
});

test("an agent's own test run is authorized by its attempt's token, not the director's session", async t => {
  const { origin } = await studio(t);
  const response = await fetch(origin + '/api/attempts/A-none/tests', {
    ...plain,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-studio-attempt-token': 'f'.repeat(64) },
    body: JSON.stringify({ files: [] }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /cannot run tests now/);
});

test('open access is only for a studio of sample data, and nothing else is accepted', async t => {
  const { origin } = await studio(t, { access: 'open' });
  const page = await fetch(origin, plain);
  assert.ok([200, 503].includes(page.status), String(page.status));
  assert.match(await page.text(), tokenMeta);
  assert.equal((await fetch(origin + '/api/projects', plain)).status, 200);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-access-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => createStudio({ directory, port: 0, access: 'loopback' }), /Access must be session or open/);
});

test('the key is made once per data folder and a damaged key file is replaced', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-access-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = directorKey(directory);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(directorKey(directory), key);
  fs.writeFileSync(directorKeyFile(directory), 'not a key');
  const replaced = directorKey(directory);
  assert.match(replaced, /^[0-9a-f]{64}$/);
  assert.notEqual(replaced, key);
});
