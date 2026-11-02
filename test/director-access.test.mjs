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
  // The request token still guards every command, as it guards against other pages in the browser.
  const tokenless = await fetch(origin + '/api/control', {
    ...plain,
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxParallel: 2 }),
  });
  assert.equal(tokenless.status, 403);
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
