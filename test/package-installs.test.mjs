// Installed packages for the source pipeline (Decision MP-026, v1.0 item 19b): one install in the
// controller's data folder, matched to the tested copy's lockfile before its tests, and found by every copy
// under that folder the way Node finds packages. Model-free: a stand-in for npm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixtureNpm } from './model-free-studio.mjs';
import { ensureInstall, installKey, installStep } from '../src/connectors/package-installs.mjs';
import { createSourceWorktree, removeSourceWorktree } from '../src/connectors/source-worktrees.mjs';
import { git } from '../src/connectors/source-integration.mjs';

const temporary = t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-installs-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const copyWith = (data, relative, lock) => {
  const directory = path.join(data, relative);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"devDependencies":{"vite":"8.3.3"}}');
  fs.writeFileSync(path.join(directory, 'package-lock.json'), lock);
  return directory;
};
const npm = [fixtureNpm.executable, ...fixtureNpm.args];
const quiet = () => {};
const resolveFrom = copy => createRequire(path.join(copy, 'probe.js'))('fixture-tool');
const marker = data => fs.readFileSync(path.join(data, 'node_modules', '.studio-lockfile'), 'utf8');
const leftovers = data => fs.readdirSync(data).filter(name => /^\.(install|node_modules-old)-/.test(name));

test('one install in the data folder serves every copy under it and follows the lockfile', t => {
  const data = temporary(t),
    check = copyWith(data, 'jobs/attempt-a/source', '{"lockfileVersion":3}'),
    candidate = copyWith(data, 'wt/12345678', '{"lockfileVersion":3}'),
    changed = copyWith(data, 'wt/87654321', '{"lockfileVersion":3,"changed":true}');
  const messages = [];
  ensureInstall(check, data, npm, message => messages.push(message));
  assert.match(
    messages[0],
    /Installing the packages for this lockfile \([0-9a-f]{16}\) with npm ci, install scripts off/,
  );
  assert.equal(marker(data), installKey(check));
  // Copies hold no packages of their own: they find the install by walking up, as Node, TypeScript,
  // ESLint and Vite do.
  for (const copy of [check, candidate]) {
    assert.equal(resolveFrom(copy), 'fixture tool');
    assert.equal(fs.existsSync(path.join(copy, 'node_modules')), false);
  }
  // The same lockfile reuses the install; npm does not run again.
  ensureInstall(candidate, data, ['npm-would-fail-if-run'], message => messages.push(message));
  assert.match(messages.at(-1), /Using the packages installed for this lockfile/);
  // A changed lockfile replaces the install.
  ensureInstall(changed, data, npm, quiet);
  assert.equal(marker(data), installKey(changed));
  assert.notEqual(installKey(changed), installKey(check));
  assert.deepEqual(leftovers(data), [], 'No staging or replaced install is left behind.');
});

test('a failed install explains itself and keeps the install that was there', t => {
  const data = temporary(t),
    good = copyWith(data, 'wt/good', '{"lockfileVersion":3}'),
    broken = copyWith(data, 'wt/broken', '{"fixture-npm-fails":true}');
  ensureInstall(good, data, npm, quiet);
  assert.throws(
    () => ensureInstall(broken, data, npm, quiet),
    /Installing the packages failed \(npm exited with 1\)\. Check that this computer can reach the npm registry, then retry\./,
  );
  assert.equal(marker(data), installKey(good));
  assert.equal(resolveFrom(good), 'fixture tool');
  assert.deepEqual(leftovers(data), []);
});

// Windows refuses to rename a folder while something holds a file in it, as a virus scanner does just after
// files are written: the rename reports EPERM until the folder is free.
const heldFor = (refusals, held = () => true) => {
  const calls = [];
  return {
    calls,
    rename(from, to) {
      calls.push(path.basename(path.dirname(from)) + '/' + path.basename(from));
      if (held(from) && refusals-- > 0)
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
      fs.renameSync(from, to);
    },
  };
};

test('an install held for a moment is moved into place once it is free', t => {
  const data = temporary(t),
    copy = copyWith(data, 'wt/held', '{"lockfileVersion":3}'),
    held = heldFor(3);
  ensureInstall(copy, data, npm, quiet, { rename: held.rename, wait: 5000 });
  assert.equal(marker(data), installKey(copy));
  assert.equal(resolveFrom(copy), 'fixture tool');
  assert.equal(held.calls.length, 4, 'Three refusals, then the rename.');
  assert.deepEqual(leftovers(data), []);
});

test('an install held too long fails and puts the previous install back', t => {
  const data = temporary(t),
    good = copyWith(data, 'wt/good', '{"lockfileVersion":3}'),
    changed = copyWith(data, 'wt/changed', '{"lockfileVersion":3,"changed":true}');
  ensureInstall(good, data, npm, quiet);
  const held = heldFor(Infinity, from => from.includes('.install-'));
  assert.throws(
    () => ensureInstall(changed, data, npm, quiet, { rename: held.rename, wait: 300 }),
    /EPERM: operation not permitted, rename/,
  );
  assert.equal(marker(data), installKey(good));
  assert.equal(resolveFrom(good), 'fixture tool');
  assert.deepEqual(leftovers(data), []);
});

test("a copy outside the controller's data folder cannot use the installed packages", t => {
  const base = temporary(t),
    data = path.join(base, 'data'),
    outside = copyWith(base, 'elsewhere', '{}');
  fs.mkdirSync(data);
  assert.throws(() => ensureInstall(outside, data, npm, quiet), /outside the controller's data folder/);
  assert.throws(() => ensureInstall(path.join(base, 'elsewhere', '..'), data, npm, quiet), /no package\.json/);
  assert.equal(fs.existsSync(path.join(data, 'node_modules')), false);
});

// On October 21, 2026 a node_modules junction in a worktree let `git worktree remove --force` delete the
// packages it pointed to. Tested copies hold no link: removing a worktree never reaches the install.
test('removing a tested worktree leaves the install in the data folder', t => {
  const data = temporary(t),
    repository = path.join(data, 'repository');
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(repository, 'package.json'), '{}');
  fs.writeFileSync(path.join(repository, 'package-lock.json'), '{"lockfileVersion":3}');
  git(repository, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(repository, ['config', 'user.name', 'Fixture director']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'commit.gpgsign', 'false']);
  git(repository, ['add', '-A']);
  git(repository, ['commit', '--quiet', '-m', 'Fixture']);
  const worktree = createSourceWorktree(repository, path.join(data, 'wt'), 'i-12345678', 'HEAD', { directories: [] });
  ensureInstall(worktree, data, npm, quiet);
  assert.equal(resolveFrom(worktree), 'fixture tool');
  removeSourceWorktree(repository, worktree);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(marker(data), installKey(repository));
});

test('a copy installs only when its profile installs and it holds a lockfile', t => {
  const data = temporary(t),
    runtime = { store: { directory: data }, packageInstallCommand: fixtureNpm },
    copy = copyWith(data, 'wt/copy', '{}'),
    bare = path.join(data, 'wt', 'bare');
  fs.mkdirSync(bare);
  assert.equal(installStep(runtime, copy, false), null);
  assert.equal(installStep(runtime, bare, true), null);
  const step = installStep(runtime, copy, true);
  assert.equal(step.executable, process.execPath);
  assert.match(step.args[0], /package-installs\.mjs$/);
  assert.deepEqual(step.args.slice(1), [copy, data, ...npm]);
});
