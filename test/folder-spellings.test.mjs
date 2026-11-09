// One folder written two ways is kept as one folder (November 9, 2026): a junction or symbolic link to it, macOS's
// /var for /private/var, a Windows short name such as RUNNER~1, or another letter case where the file system ignores
// case. The controller keeps the real spelling of every folder it stores or compares, where the folder comes in, so a
// path it measures inside another never reads as outside it. Model-free: temporary folders and git repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The suite's temporary folder and git identity; the studio's model-free stand-ins.
import { createStudio } from './model-free-studio.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { proposeSourceProfile } from '../src/connectors/source-projects.mjs';
import { sourcePlan } from '../src/connectors/source-checks.mjs';
import {
  createSourceWorktree,
  removeSourceWorktree,
  snapshotCommit,
  sourceWorktreeRoot,
  worktreeRepository,
} from '../src/connectors/source-worktrees.mjs';

// What a refused link creation looks like: the candidate test sandbox, or an account without the right to make links.
const refused = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL']);

// Inside, and never outside: the relative path between two spellings of one place never climbs out.
const inside = (folder, file) => {
  const relative = path.relative(folder, file);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file} is inside ${folder}.`);
};

// A Windows short name for a folder, when the volume makes them (fsutil 8dot3name); otherwise the folder as given.
function shortName(folder) {
  if (process.platform !== 'win32') return folder;
  const run = spawnSync(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', '"for %I in ("%TARGET%") do @echo %~sI"'],
    {
      windowsVerbatimArguments: true,
      env: { ...process.env, TARGET: folder },
      encoding: 'utf8',
      timeout: 20000,
    },
  );
  return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : folder;
}

// A real folder holding a git repository, and every other spelling of it this computer offers: a link (a junction on
// Windows, a symbolic link elsewhere), the temporary folder as it was given, a short name, another letter case, and
// Linux's /proc/self/root. Only spellings that really lead to the folder are kept. The link goes first when the folder
// is removed, so removing it never follows the link.
function spelledFolder(t) {
  const given = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sp-')),
    base = fs.realpathSync.native(given),
    name = 'Spelled dir',
    real = path.join(base, name),
    link = path.join(base, 'link');
  fs.mkdirSync(real);
  let linked = true;
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!refused.has(error.code)) throw error;
    linked = false;
  }
  t.after(() => {
    if (linked) fs.unlinkSync(link);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const candidates = [
    linked && link,
    path.join(given, name),
    shortName(real),
    path.join(base, name.toUpperCase()),
    process.platform === 'linux' && path.join('/proc/self/root', real),
  ];
  const spellings = [
    ...new Set(
      candidates.filter(spelling => {
        if (!spelling || spelling === real) return false;
        try {
          return fs.realpathSync.native(spelling) === real;
        } catch {
          return false;
        }
      }),
    ),
  ];
  assert.ok(spellings.length, 'This computer offers at least one other spelling of a folder.');
  // A repository with a source folder and a test, as a project's is.
  const repository = path.join(real, 'repo');
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'test'));
  fs.writeFileSync(path.join(repository, 'README.md'), '# Spelled\n');
  fs.writeFileSync(path.join(repository, 'src', 'value.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repository, 'test', 'value.test.mjs'), "import '../src/value.mjs';\n");
  git(repository, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(repository, ['config', 'core.autocrlf', 'false']);
  git(repository, ['config', 'commit.gpgsign', 'false']);
  git(repository, ['add', '-A']);
  git(repository, ['commit', '--quiet', '-m', 'Spelled baseline']);
  return { real, repository, spellings };
}

test('a studio started from another spelling of its data folder keeps the real one, and so does what it develops', async t => {
  const { real, repository, spellings } = spelledFolder(t);
  for (const [index, spelling] of spellings.entries()) {
    const studio = createStudio({
      directory: path.join(spelling, `data-${index}`),
      port: 0,
      runnerOptions: { sourceChangeRoot: path.join(spelling, 'repo') },
    });
    try {
      const data = path.join(real, `data-${index}`);
      assert.equal(studio.store.directory, data, `The data folder given as ${spelling}.`);
      assert.equal(studio.runner.sourceChangeRoot, repository, `The developed repository given as ${spelling}.`);
      // The worktrees' folder is inside the data folder by the same spelling.
      inside(studio.store.directory, sourceWorktreeRoot(studio.runner));
      inside(real, studio.store.directory);
    } finally {
      await studio.close();
    }
  }
});

test('a worktree and a measured copy made from another spelling keep the real one', t => {
  const { real, repository, spellings } = spelledFolder(t),
    profile = proposeSourceProfile(repository),
    commit = git(repository, ['rev-parse', 'HEAD']);
  for (const [index, spelling] of spellings.entries()) {
    const given = path.join(spelling, 'repo'),
      parent = path.join(spelling, 'wt');
    // A worktree made in a folder given by another spelling is recorded by its real one, with its repository.
    const worktree = createSourceWorktree(given, parent, `s${index}`, commit, profile);
    try {
      assert.equal(worktree, path.join(real, 'wt', `s${index}`), `A worktree made under ${spelling}.`);
      assert.equal(worktreeRepository(worktree), repository, `The worktree's repository, under ${spelling}.`);
      inside(path.join(real, 'wt'), worktree);
    } finally {
      removeSourceWorktree(given, worktree);
    }
    // A measured copy names the real folder it measured.
    const plan = sourcePlan(given, profile);
    assert.equal(plan.root, repository, `The source measured as ${spelling}.`);
    assert.equal(sourcePlan(path.join(real, 'repo'), profile).sourceHash, plan.sourceHash);
    // A snapshot of a commit names the real repository and measured the same files.
    const destination = path.join(real, `copy-${index}`),
      snapshot = snapshotCommit(given, parent, `c${index}`, { commit, branch: 'main' }, destination, profile);
    assert.equal(snapshot.root, repository, `The snapshot of a commit, from ${spelling}.`);
    assert.equal(snapshot.sourceHash, plan.sourceHash);
    inside(real, snapshot.root);
    assert.ok(fs.existsSync(path.join(destination, 'src', 'value.mjs')), 'The copy holds the measured files.');
  }
});
