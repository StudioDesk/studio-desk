import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../src/core/entry-point.mjs';

// What a refused link creation looks like: the candidate test sandbox, or a Windows account without the right to
// make symbolic links, refuses it.
const refused = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL']);

// A folder holding a tiny program that acts only when it is the one node started, a module that imports it, and a
// link to that folder (a junction on Windows, a symbolic link elsewhere). The link goes first when it is removed, so
// removing the folder never follows it. Where links cannot be made, linked is false and no link exists.
function linkedFolder(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-entry-point-'))),
    real = path.join(base, 'real'),
    link = path.join(base, 'link');
  fs.mkdirSync(real);
  const check = new URL('../src/core/entry-point.mjs', import.meta.url).href;
  fs.writeFileSync(
    path.join(real, 'entry.mjs'),
    `import { isEntryPoint } from ${JSON.stringify(check)};\n` +
      "if (isEntryPoint(import.meta)) console.log('entry acted');\n",
  );
  fs.writeFileSync(path.join(real, 'importer.mjs'), "import './entry.mjs';\nconsole.log('imported');\n");
  let linked = true;
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!refused.has(error.code)) throw error;
    linked = false;
  }
  t.after(() => {
    if (linked) fs.unlinkSync(link);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { real, link, linked };
}

// Where links cannot be made, the link is modelled where the check reads it: its real path is the real folder's.
function modelLink(t, { real, link, linked }) {
  if (linked) return;
  const realpath = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (file, ...rest) => {
    const inside = path.relative(link, path.resolve(String(file)));
    return realpath(inside === '' || !inside.startsWith('..') ? path.join(real, inside) : file, ...rest);
  });
}

const start = file => spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 20000 });

test('a program started through a linked folder acts, and the same module imported by another does not', t => {
  const folder = linkedFolder(t),
    { real, link } = folder;
  for (const at of folder.linked ? [link, real] : [real]) {
    const run = start(path.join(at, 'entry.mjs'));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'entry acted', `Started from ${at}.`);
    const imported = start(path.join(at, 'importer.mjs'));
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim(), 'imported', `Imported from ${at}.`);
  }
  if (!folder.linked) {
    // A start through the link gives the module its real path while argv[1] keeps the linked one.
    modelLink(t, folder);
    const meta = { url: pathToFileURL(path.join(real, 'entry.mjs')).href };
    assert.equal(isEntryPoint(meta, [process.execPath, path.join(link, 'entry.mjs')]), true, 'Through the link.');
    assert.equal(isEntryPoint(meta, [process.execPath, path.join(link, 'importer.mjs')]), false, 'Imported.');
  }
});

test("Node's own answer decides when it gives one, whatever the started path", t => {
  const { real } = linkedFolder(t),
    url = pathToFileURL(path.join(real, 'entry.mjs')).href;
  assert.equal(isEntryPoint({ main: true, url }, [process.execPath, path.join(real, 'importer.mjs')]), true);
  assert.equal(isEntryPoint({ main: false, url }, [process.execPath, path.join(real, 'entry.mjs')]), false);
  assert.equal(isEntryPoint({ main: true, url }, [process.execPath]), true);
});

test('without import.meta.main (Node 24.0 and 24.1) the real paths are compared', t => {
  const folder = linkedFolder(t),
    { real, link } = folder,
    meta = { url: pathToFileURL(path.join(real, 'entry.mjs')).href },
    node = process.execPath;
  modelLink(t, folder);
  assert.equal(isEntryPoint(meta, [node, path.join(link, 'entry.mjs')]), true, 'Started through the link.');
  assert.equal(isEntryPoint(meta, [node, path.join(real, 'entry.mjs')]), true, 'Started by its real path.');
  assert.equal(isEntryPoint(meta, [node, path.relative(process.cwd(), path.join(link, 'entry.mjs'))]), true);
  assert.equal(isEntryPoint(meta, [node, path.join(link, 'importer.mjs')]), false, 'Another program was started.');
  assert.equal(isEntryPoint(meta, [node, path.join(link, 'missing.mjs')]), false, 'The started path is gone.');
  assert.equal(isEntryPoint(meta, [node]), false, 'Nothing was started by path (node -e or a REPL).');
});
