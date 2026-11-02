// What the live source must be before a story starts, a line is measured or work integrates (repositoryState,
// src/connectors/source-integration.mjs): the root of a git repository, on a branch unless a line needs none, clean
// when asked, with a commit identity, answering its branch and commit. Its answers come from four git calls since
// November 2 (C-20); each refusal reads as it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryState } from '../src/connectors/source-integration.mjs';

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-state-')),
    global = path.join(directory, 'global-gitconfig'),
    saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  fs.writeFileSync(global, '');
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    for (const [name, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['GIT_CONFIG_NOSYSTEM', saved.system],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
  git('init', '-q', '-b', 'main');
  return { directory, root, global, git };
}
const commit = r => {
  fs.writeFileSync(path.join(r.root, 'a.txt'), 'a\n');
  r.git('add', 'a.txt');
  r.git('-c', 'user.name=Setup', '-c', 'user.email=setup@example.com', 'commit', '-q', '-m', 'first');
};

test('the live source answers its branch and commit, with an identity from either settings file', t => {
  const r = folder(t);
  commit(r);
  // The name from the global settings and the email from the repository's own still make an identity.
  fs.writeFileSync(r.global, '[user]\n\tname = Global Name\n');
  r.git('config', 'user.email', 'local@example.com');
  assert.deepEqual(repositoryState(r.root, 'testing'), { branch: 'main', head: r.git('rev-parse', 'HEAD') });
  // The repository's own empty name overrides the global one, as `git config user.name` reads it.
  r.git('config', 'user.name', '');
  assert.throws(
    () => repositoryState(r.root, 'testing'),
    /^Error: Configure git user.name and user.email before testing\.$/,
  );
});

test('a source with no identity, a detached HEAD, tracked changes or no repository is refused as before', t => {
  const r = folder(t);
  commit(r);
  assert.throws(
    () => repositoryState(r.root, 'testing'),
    /^Error: Configure git user.name and user.email before testing\.$/,
  );
  r.git('config', 'user.name', 'Local Name');
  r.git('config', 'user.email', 'local@example.com');
  fs.writeFileSync(path.join(r.root, 'a.txt'), 'changed\n');
  assert.throws(
    () => repositoryState(r.root, 'testing'),
    /^Error: Commit or stash tracked changes in the live source before testing\.$/,
  );
  assert.equal(repositoryState(r.root, 'testing', { clean: false }).branch, 'main');
  r.git('checkout', '-q', '--', 'a.txt');
  r.git('checkout', '-q', '--detach');
  assert.throws(
    () => repositoryState(r.root, 'testing'),
    /^Error: Check out a branch before testing; HEAD is detached\.$/,
  );
  assert.deepEqual(repositoryState(r.root, 'testing', { attached: false }), {
    branch: null,
    head: r.git('rev-parse', 'HEAD'),
  });
  const inside = path.join(r.root, 'src');
  fs.mkdirSync(inside);
  assert.throws(
    () => repositoryState(inside, 'testing'),
    /^Error: The live source must be the root of its git repository\.$/,
  );
  const plain = path.join(r.directory, 'plain');
  fs.mkdirSync(plain);
  assert.throws(
    () => repositoryState(plain, 'testing'),
    /^Error: The live source must be a git repository before testing\.$/,
  );
});

test('a repository with no commit yet passes every check before its commit, then git refuses that', t => {
  const r = folder(t);
  r.git('config', 'user.name', 'Local Name');
  r.git('config', 'user.email', 'local@example.com');
  assert.throws(() => repositoryState(r.root, 'testing', { clean: false }), /^Error: git rev-parse failed: /);
});
