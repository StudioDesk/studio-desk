// The dashboard (Decision MP-026, v1.0 items 19b and 19c) is built from dashboard/ and served at the main
// address. These tests need no installed packages: the build tool is a stand-in script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { buildDashboard, dashboardSourceHash, dashboardSources } from '../scripts/build-dashboard.mjs';

const temporary = (t, prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

async function controller(t, dashboardDirectory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-next-')),
    app = createStudio({ directory, port: 0, dashboardDirectory }),
    origin = await app.start();
  // Close the controller before removing its records folder: its database holds the files open.
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  return { origin, token };
}

test('an unbuilt dashboard explains how to build it, and still carries the request token', async t => {
  const { origin, token } = await controller(t, path.join(temporary(t, 'studio-next-dist-'), 'missing'));
  const page = await fetch(origin + '/p/project-studio-desk');
  assert.equal(page.status, 503);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const text = await page.text();
  assert.match(text, /not built.*npm ci.*npm start/s);
  assert.match(text, new RegExp(`content="${token}"`));
  assert.equal((await fetch(origin + '/assets/index-abc.js')).status, 404);
});

test('every page address gets the built page with this start’s token; content-named files are kept', async t => {
  const dist = temporary(t, 'studio-next-dist-');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    '<!doctype html><meta name="studio-token" content="%STUDIO_TOKEN%"><script type="module" src="/assets/index-abc.js"></script>',
  );
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'console.log("dashboard");');
  fs.writeFileSync(path.join(path.dirname(dist), 'outside.js'), 'secret');
  t.after(() => fs.rmSync(path.join(path.dirname(dist), 'outside.js'), { force: true }));
  const { origin, token } = await controller(t, dist);
  for (const address of ['/', '/?projectId=project-legacy', '/p/project-studio-desk/tasks/T-1?attempt=a']) {
    const page = await fetch(origin + address);
    assert.equal(page.status, 200, address);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), new RegExp(`content="${token}"`));
  }
  const script = await fetch(origin + '/assets/index-abc.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(script.headers.get('cache-control'), 'max-age=31536000, immutable');
  assert.equal(await script.text(), 'console.log("dashboard");');
  for (const escape of ['/assets/..%2F..%2Foutside.js', '/assets/missing.js', '/assets/index-abc.exe', '/favicon.ico'])
    assert.equal((await fetch(origin + escape)).status, 404, escape);
  assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
  // An address from before the dashboard moved to the main address opens the same page there.
  for (const [before, after] of [
    ['/next', '/'],
    ['/next/', '/'],
    ['/next/p/project-studio-desk/board?accepted=true', '/p/project-studio-desk/board?accepted=true'],
  ]) {
    const moved = await fetch(origin + before, { redirect: 'manual' });
    assert.equal(moved.status, 302, before);
    assert.equal(moved.headers.get('location'), after, before);
  }
});

// Raw bytes as they cross the wire, with or without asking for gzip.
const raw = (url, gzip) =>
  new Promise((resolve, reject) =>
    http
      .get(url, { headers: gzip ? { 'Accept-Encoding': 'gzip' } : {} }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject),
  );

test('the dashboard’s files and larger replies cross the wire compressed for a browser that accepts it', async t => {
  const dist = temporary(t, 'studio-next-dist-'),
    script = `console.log(${JSON.stringify('dashboard '.repeat(400))});`;
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><meta name="studio-token" content="%STUDIO_TOKEN%">');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), script);
  const { origin } = await controller(t, dist);
  for (const _ of [1, 2]) {
    const packed = await raw(origin + '/assets/index-abc.js', true);
    assert.equal(packed.headers['content-encoding'], 'gzip');
    assert.equal(packed.headers.vary, 'Accept-Encoding');
    assert.ok(packed.body.length < script.length / 10);
    assert.equal(zlib.gunzipSync(packed.body).toString(), script);
  }
  const plain = await raw(origin + '/assets/index-abc.js', false);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), script);
  // A project's shell is several kilobytes of records; a small reply is sent as it is.
  const shell = await raw(origin + '/api/projects/project-legacy/shell', true);
  assert.equal(shell.headers['content-encoding'], 'gzip');
  assert.ok(JSON.parse(zlib.gunzipSync(shell.body)).project);
  const small = await raw(origin + '/api/projects', true);
  assert.equal(small.headers['content-encoding'], undefined);
  assert.ok(JSON.parse(small.body).projects.length);
});

// A stand-in for Vite: writes an index into the requested folder, or fails.
function sourceTree(t, behavior) {
  const base = temporary(t, 'studio-next-build-');
  fs.mkdirSync(path.join(base, 'dashboard', 'src'), { recursive: true });
  fs.writeFileSync(path.join(base, 'dashboard', 'index.html'), '<div id="root"></div>');
  fs.writeFileSync(path.join(base, 'dashboard', 'src', 'main.tsx'), 'export {};');
  fs.writeFileSync(path.join(base, 'package-lock.json'), '{}');
  if (behavior) {
    fs.mkdirSync(path.join(base, 'node_modules', 'vite', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'node_modules', 'vite', 'bin', 'vite.js'),
      behavior === 'fail'
        ? 'process.exit(1);'
        : `const fs = require('node:fs'), path = require('node:path');
           const out = process.argv[process.argv.indexOf('--outDir') + 1];
           fs.mkdirSync(out, { recursive: true });
           fs.writeFileSync(path.join(out, 'index.html'), 'built ' + Date.now());`,
    );
    fs.writeFileSync(path.join(base, 'node_modules', 'vite', 'package.json'), '{"type":"commonjs"}');
  }
  return base;
}

test('the build waits for installed tools, builds only changed sources, and a failure keeps the last build', t => {
  const messages = [],
    log = message => messages.push(message);
  const bare = sourceTree(t);
  assert.deepEqual(buildDashboard({ base: bare, log }), { built: false, reason: 'not-installed' });
  assert.match(messages.at(-1), /npm ci/);
  assert.equal(fs.existsSync(path.join(bare, 'dist')), false);

  const base = sourceTree(t, 'build'),
    dist = path.join(base, 'dist');
  assert.deepEqual(buildDashboard({ base, log }), { built: true });
  const first = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.equal(fs.readFileSync(path.join(dist, '.source-hash'), 'utf8'), dashboardSourceHash(base));
  assert.deepEqual(buildDashboard({ base, log }), { built: false, reason: 'current' });
  assert.equal(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), first);
  fs.writeFileSync(path.join(base, 'dashboard', 'src', 'main.tsx'), 'export const changed = true;');
  assert.notEqual(dashboardSourceHash(base), fs.readFileSync(path.join(dist, '.source-hash'), 'utf8'));
  assert.deepEqual(buildDashboard({ base, log }), { built: true });

  fs.writeFileSync(path.join(base, 'node_modules', 'vite', 'bin', 'vite.js'), 'process.exit(1);');
  fs.writeFileSync(path.join(base, 'dashboard', 'src', 'main.tsx'), 'export const broken = true;');
  const kept = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.deepEqual(buildDashboard({ base, log }), { built: false, reason: 'failed' });
  assert.equal(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), kept, 'The previous build stays in place.');
  assert.deepEqual(
    fs.readdirSync(base).filter(name => name.startsWith('.dist-')),
    [],
    'No staging folder is left behind.',
  );
});

// On October 22 a change to the shared run rules alone left the dashboard on its previous build after a restart.
test('a change to a file the dashboard imports from outside its folder starts a build', t => {
  const base = sourceTree(t),
    write = (file, text) => fs.writeFileSync(path.join(base, file), text);
  fs.mkdirSync(path.join(base, 'public'));
  write('public/rules.js', "import './nested.css';\nexport const rule = 1;");
  write('public/nested.css', 'a {}');
  write('public/other.js', 'only the current dashboard loads this');
  write('dashboard/src/main.tsx', "import '../../public/rules.js';\nimport { x } from './inside';");
  write('dashboard/src/inside.ts', 'export const x = 1;');
  assert.deepEqual(dashboardSources(base), [
    'dashboard/index.html',
    'dashboard/src/inside.ts',
    'dashboard/src/main.tsx',
    'package-lock.json',
    'public/rules.js',
    'public/nested.css',
  ]);

  const before = dashboardSourceHash(base);
  write('public/other.js', 'changed');
  assert.equal(dashboardSourceHash(base), before, 'A file the dashboard does not import starts no build.');
  write('public/nested.css', 'a { color: red }');
  const nested = dashboardSourceHash(base);
  assert.notEqual(nested, before, "An imported file's own imports are followed.");
  write('public/rules.js', "import './nested.css';\nexport const rule = 2;");
  assert.notEqual(dashboardSourceHash(base), nested);

  // This copy's dashboard imports the shared scripts it uses.
  const sources = dashboardSources();
  for (const shared of ['public/runs.js', 'public/source-diff.js', 'public/markdown-reader.js'])
    assert.ok(sources.includes(shared), shared);
});
