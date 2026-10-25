// The folder list the dashboard's folder browser reads (1.0 step 4). Model-free: temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Reuse the candidate-local temp policy: MXC's redirected OS temp denies some writes.
import './model-free-studio.mjs';
import { listFolders, maxFolders } from '../src/connectors/folders.mjs';

// A file, a dot folder, a plain folder, a repository's folder and a worktree's folder (a .git file).
function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-folders-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'A file is never listed.\n');
  fs.mkdirSync(path.join(directory, '.hidden'));
  fs.mkdirSync(path.join(directory, 'plain'));
  fs.mkdirSync(path.join(directory, 'Site', '.git'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'worktree'));
  fs.writeFileSync(path.join(directory, 'worktree', '.git'), 'gitdir: ../Site/.git/worktrees/worktree\n');
  return directory;
}
const names = listing => listing.folders.map(folder => folder.name);

test('a folder lists the folders inside, sorted ignoring case and marking repositories, without files or dots', t => {
  const directory = fixture(t),
    listing = listFolders(directory);
  assert.equal(listing.path, directory);
  assert.deepEqual(listing.folders, [
    { name: 'plain', path: path.join(directory, 'plain'), repository: false },
    { name: 'Site', path: path.join(directory, 'Site'), repository: true },
    { name: 'worktree', path: path.join(directory, 'worktree'), repository: true },
  ]);
  assert.equal(listing.limited, false);
  assert.equal(listing.parent, path.dirname(directory));
  // The trail runs from the filesystem root, named as itself, down to the folder listed, one level a step.
  const root = path.parse(directory).root;
  assert.deepEqual(listing.trail[0], { name: root, path: root });
  assert.deepEqual(listing.trail.at(-1), { name: path.basename(directory), path: directory });
  for (let index = 1; index < listing.trail.length; index++) {
    assert.equal(path.dirname(listing.trail[index].path), listing.trail[index - 1].path);
    assert.equal(listing.trail[index].name, path.basename(listing.trail[index].path));
  }
  if (process.platform === 'win32') assert.ok(listing.drives.includes(root.toUpperCase()), listing.drives.join(' '));
  else assert.deepEqual(listing.drives, []);
  assert.deepEqual(listFolders(directory, { platform: 'linux' }).drives, []);
  // A repository's own .git is a dot entry, so its folder lists nothing, one level below.
  const site = listFolders(path.join(directory, 'Site'));
  assert.deepEqual(site.folders, []);
  assert.equal(site.parent, directory);
  // A root has no parent and a trail of itself.
  const top = listFolders(root);
  assert.equal(top.parent, null);
  assert.deepEqual(top.trail, [{ name: top.path, path: top.path }]);
});

test('without a folder the home folder is listed, and a path that is not an absolute folder is refused plainly', t => {
  const directory = fixture(t);
  assert.equal(listFolders().path, fs.realpathSync.native(os.homedir()));
  assert.equal(listFolders(undefined, { home: directory }).path, directory);
  assert.deepEqual(names(listFolders(null, { home: directory })), ['plain', 'Site', 'worktree']);
  for (const target of ['relative/folder', 'plain', '', 42, ['/']])
    assert.throws(() => listFolders(target), { message: 'Choose an absolute folder path.' });
  assert.throws(() => listFolders(path.join(directory, 'missing')), { message: 'The folder does not exist.' });
  assert.throws(() => listFolders(path.join(directory, 'notes.txt')), { message: 'Choose a folder, not a file.' });
});

test('a folder the process cannot open is left out', t => {
  const directory = fixture(t),
    locked = path.join(directory, 'locked');
  fs.mkdirSync(locked);
  // At the boundary on every platform: opening the folder is refused, as Windows refuses a protected one.
  const opendir = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', (folder, ...rest) => {
    if (folder === locked)
      throw Object.assign(new Error(`EPERM: operation not permitted, opendir '${folder}'`), { code: 'EPERM' });
    return opendir(folder, ...rest);
  });
  assert.deepEqual(names(listFolders(directory)), ['plain', 'Site', 'worktree']);
  t.mock.restoreAll();
  assert.deepEqual(names(listFolders(directory)), ['locked', 'plain', 'Site', 'worktree']);
  // A real folder the process cannot open needs POSIX permissions and a user other than root.
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.diagnostic(
      'A real unopenable folder was not created here (Windows, or running as root); only the refused opening above was checked.',
    );
    return;
  }
  fs.chmodSync(locked, 0o000);
  try {
    assert.deepEqual(names(listFolders(directory)), ['plain', 'Site', 'worktree']);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('a folder that opens but refuses reading is left out, and each folder opened is closed again', t => {
  const directory = fixture(t),
    guarded = path.join(directory, 'guarded');
  fs.mkdirSync(guarded);
  // A handle closed once already refuses closing again, so each one the list opened was closed.
  const closed = calls => {
    for (const call of calls) assert.throws(() => call.result.closeSync(), { code: 'ERR_DIR_CLOSED' });
  };
  // At the boundary on every platform: Windows opens a protected junction such as Application Data or Cookies
  // in the home folder, then refuses to read it.
  const opendir = fs.opendirSync,
    refused = t.mock.method(fs, 'opendirSync', (folder, ...rest) => {
      const handle = opendir(folder, ...rest);
      if (folder === guarded)
        handle.readSync = () => {
          throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${folder}'`), { code: 'EPERM' });
        };
      return handle;
    });
  assert.deepEqual(names(listFolders(directory)), ['plain', 'Site', 'worktree']);
  assert.ok(refused.mock.calls.some(call => call.arguments[0] === guarded));
  closed(refused.mock.calls);
  t.mock.restoreAll();
  // Restored, the folder reads and is listed again; a spy on the real opening shows each handle closed.
  const opened = t.mock.method(fs, 'opendirSync');
  assert.deepEqual(names(listFolders(directory)), ['guarded', 'plain', 'Site', 'worktree']);
  assert.equal(opened.mock.callCount(), 4);
  closed(opened.mock.calls);
});

test("a Windows drive's own top-level $ folders are left out, and deeper ones and other platforms' are kept", t => {
  const directory = fixture(t),
    root = fs.realpathSync.native(path.parse(directory).root),
    readdir = fs.readdirSync,
    opendir = fs.opendirSync,
    read = ['$Recycle.Bin', '$WinREAgent', 'Program Files', 'Users'],
    folder = name => ({ name, isDirectory: () => true, isSymbolicLink: () => false });
  fs.mkdirSync(path.join(directory, '$data'));
  // A real drive's top level cannot be arranged: model what the root reads, each folder opening a fixture folder.
  t.mock.method(fs, 'readdirSync', (target, ...rest) => {
    if (target === root) return read.map(folder);
    return readdir(target, ...rest);
  });
  t.mock.method(fs, 'opendirSync', (target, ...rest) => {
    if (path.dirname(target) === root && read.includes(path.basename(target))) return opendir(directory, ...rest);
    return opendir(target, ...rest);
  });
  assert.deepEqual(names(listFolders(root, { platform: 'win32' })), ['Program Files', 'Users']);
  assert.deepEqual(names(listFolders(root, { platform: 'linux' })), read);
  for (const platform of ['win32', 'linux'])
    assert.deepEqual(names(listFolders(directory, { platform })), ['$data', 'plain', 'Site', 'worktree']);
});

test('with nearest, a missing folder or a file lists the nearest existing folder above it, or the home folder', t => {
  const directory = fixture(t),
    listed = listFolders(directory),
    missing = path.join(directory, 'missing', 'deeper'),
    file = path.join(directory, 'notes.txt');
  assert.equal(listed.path, directory);
  assert.deepEqual(listFolders(missing, { nearest: true }), listed);
  assert.deepEqual(listFolders(file, { nearest: true }), listed);
  assert.deepEqual(listFolders(path.join(file, 'inside'), { nearest: true }), listed);
  assert.throws(() => listFolders(missing), { message: 'The folder does not exist.' });
  assert.throws(() => listFolders(file), { message: 'Choose a folder, not a file.' });
  for (const target of ['relative/folder', '', 42])
    assert.throws(() => listFolders(target, { nearest: true }), { message: 'Choose an absolute folder path.' });
  // Nearest steps past only what is not there: a folder that exists but cannot be read is still refused.
  const readdir = fs.readdirSync,
    plain = path.join(directory, 'plain');
  t.mock.method(fs, 'readdirSync', (folder, ...rest) => {
    if (folder === plain)
      throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${folder}'`), { code: 'EPERM' });
    return readdir(folder, ...rest);
  });
  assert.throws(() => listFolders(plain, { nearest: true }), { message: 'The folder cannot be opened.' });
  t.mock.restoreAll();
  // At the boundary: every platform has its root, so a drive that is not there is modeled by refusing it.
  const root = path.parse(directory).root,
    nowhere = path.join(root, 'studio-folders-nowhere', 'deeper'),
    absent = [nowhere, path.dirname(nowhere), root],
    realpath = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (folder, ...rest) => {
    if (absent.includes(folder))
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${folder}'`), { code: 'ENOENT' });
    return realpath(folder, ...rest);
  });
  assert.deepEqual(listFolders(nowhere, { nearest: true, home: directory }), listed);
  assert.throws(() => listFolders(nowhere, { home: directory }), { message: 'The folder does not exist.' });
});

test('a link or junction is listed when it leads to a folder that opens', t => {
  const directory = fixture(t),
    readdir = fs.readdirSync,
    opendir = fs.opendirSync,
    link = name => ({ name, isDirectory: () => false, isSymbolicLink: () => true });
  // The sandbox refuses to create links: model them where the list reads the folder and opens its entries.
  t.mock.method(fs, 'readdirSync', (folder, ...rest) => {
    const entries = readdir(folder, ...rest);
    return folder === directory ? [...entries, link('Linked'), link('broken')] : entries;
  });
  t.mock.method(fs, 'opendirSync', (folder, ...rest) => {
    if (folder === path.join(directory, 'Linked')) return opendir(path.join(directory, 'plain'), ...rest);
    return opendir(folder, ...rest);
  });
  assert.deepEqual(names(listFolders(directory)), ['Linked', 'plain', 'Site', 'worktree']);
});

test('a reply lists at most the bound of folders and says when more were left out', t => {
  const directory = fixture(t),
    many = path.join(directory, 'many');
  fs.mkdirSync(many);
  for (let index = 0; index <= maxFolders; index++) fs.mkdirSync(path.join(many, 'f' + String(index).padStart(4, '0')));
  let listing = listFolders(many);
  assert.equal(listing.folders.length, maxFolders);
  assert.equal(listing.limited, true);
  assert.equal(listing.folders.at(-1).name, 'f' + String(maxFolders - 1).padStart(4, '0'));
  fs.rmdirSync(path.join(many, 'f0000'));
  listing = listFolders(many);
  assert.equal(listing.folders.length, maxFolders);
  assert.equal(listing.limited, false);
});
