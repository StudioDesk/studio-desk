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
import { git, repositoryState } from '../src/connectors/source-integration.mjs';
import { projectRepository, proposeSourceProfile } from '../src/connectors/source-projects.mjs';
import { copySource, sourcePlan } from '../src/connectors/source-checks.mjs';
import { measureLine } from '../src/connectors/source-lines.mjs';
import { ensureInstall, installKey } from '../src/connectors/package-installs.mjs';
import { testRecordStream } from '../src/connectors/test-records.mjs';
import { artifactPath } from '../src/core/artifacts.mjs';
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

// A Windows short name for a fixture folder (SPELLE~1 for "Spelled dir"), as a computer with 8.3 names on answers
// it. This computer has them off, so both resolvers are stubbed at their boundary: fs.realpathSync keeps a short name
// as given, so it answers the short spelling for a path reached through the folder (under reached, the folder itself
// unless named), and the native resolver expands it, so it answers the long spelling for either one. elsewhere maps a
// path whose real place is somewhere else (a link or a moved file), for both resolvers.
function shortSpelled(t, long, { reached = long, elsewhere = new Map() } = {}) {
  const short = path.join(path.dirname(long), 'SPELLE~1'),
    native = fs.realpathSync.native,
    plain = fs.realpathSync,
    under = (value, folder) => value === folder || value.startsWith(folder + path.sep),
    toLong = value => {
      if (typeof value !== 'string') return value;
      const given = path.resolve(value);
      return under(given, short) ? long + given.slice(short.length) : given;
    },
    moved = value => elsewhere.get(value) ?? value;
  t.mock.method(fs.realpathSync, 'native', (value, ...rest) => moved(native(toLong(value), ...rest)));
  t.mock.method(fs, 'realpathSync', (value, ...rest) => {
    const real = moved(plain(toLong(value), ...rest));
    return under(real, reached) ? short + real.slice(long.length) : real;
  });
  return short;
}

test("a short spelling of the controller's default source or another project's root is still refused", t => {
  const { real, repository } = spelledFolder(t),
    short = shortSpelled(t, real),
    shortRepository = path.join(short, 'repo'),
    none = { projects: () => [] };
  assert.equal(fs.realpathSync(repository), shortRepository, 'The plain resolver keeps the short spelling.');
  assert.equal(fs.realpathSync.native(shortRepository), repository, 'The native resolver expands it.');
  // The controller's default source, reached by its short spelling.
  assert.throws(
    () => projectRepository(none, 'project-a', repository, { sourceChangeRoot: shortRepository }),
    /^Error: This repository is the controller's default source\.$/,
  );
  // Another project's root recorded by its short spelling.
  const taken = { projects: () => [{ id: 'project-b', name: 'Other', source: { root: shortRepository } }] };
  assert.throws(
    () => projectRepository(taken, 'project-a', repository, { sourceChangeRoot: path.join(real, 'elsewhere') }),
    /Project Other already works on this repository\./,
  );
  // A repository no other project uses is recorded by its real spelling, whichever spelling it was given by.
  assert.equal(projectRepository(none, 'project-a', shortRepository, {}).root, repository);
});

test('the live source by a short spelling is the root of its repository, and a subfolder is still refused', t => {
  const { real, repository } = spelledFolder(t);
  shortSpelled(t, real);
  assert.equal(repositoryState(repository, 'testing', { clean: false }).branch, 'main');
  assert.throws(
    () => repositoryState(path.join(repository, 'src'), 'testing', { clean: false }),
    /The live source must be the root of its git repository\./,
  );
});

test('a source snapshot through a short spelling still refuses a symbolic link', t => {
  const { real, repository } = spelledFolder(t),
    short = shortSpelled(t, real),
    profile = proposeSourceProfile(repository);
  assert.equal(sourcePlan(path.join(short, 'repo'), profile).root, repository);
  // The link is modeled at its boundary: the candidate test sandbox refuses to make links.
  const link = path.join(repository, 'src', 'value.mjs'),
    lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...rest) =>
    file === link
      ? { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false }
      : lstat(file, ...rest),
  );
  assert.throws(() => sourcePlan(path.join(short, 'repo'), profile), /Source snapshots do not follow symbolic links\./);
  assert.throws(() => sourcePlan(repository, profile), /Source snapshots do not follow symbolic links\./);
});

test('a line measured through a short spelling is not seen as changed, and a real change still is', t => {
  const { real, repository } = spelledFolder(t);
  git(repository, ['branch', 'fixes']);
  const profile = proposeSourceProfile(repository);
  shortSpelled(t, real);
  // The fixes branch is not checked out, so it is measured in a worktree of its commit and recorded by the repository.
  const plan = measureLine(repository, 'fixes', profile, path.join(real, 'wt'));
  assert.equal(plan.root, repository);
  copySource(plan, path.join(real, 'copy-1'));
  assert.ok(fs.existsSync(path.join(real, 'copy-1', 'src', 'value.mjs')), 'The copy holds the measured files.');
  fs.writeFileSync(path.join(repository, 'src', 'value.mjs'), 'export const value = 2;\n');
  assert.throws(
    () => copySource(plan, path.join(real, 'copy-2')),
    /Source changed after its attempt snapshot\. Start a newly scoped attempt\./,
  );
});

test('the package install takes a tested copy reached by a short spelling inside the data folder, and no other', t => {
  const { real } = spelledFolder(t),
    data = path.join(real, 'data'),
    copy = path.join(data, 'tests', 'copy'),
    outside = path.join(real, 'outside');
  for (const folder of [copy, outside]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), '{"name":"spelled","private":true}\n');
    fs.writeFileSync(path.join(folder, 'package-lock.json'), '{"name":"spelled","lockfileVersion":3}\n');
  }
  // The packages for this lockfile are already installed, so nothing runs npm.
  fs.mkdirSync(path.join(data, 'node_modules'));
  fs.writeFileSync(path.join(data, 'node_modules', '.studio-lockfile'), installKey(copy));
  // The tested copies are reached by the short spelling; the data folder is kept by its long one.
  shortSpelled(t, real, { reached: path.join(data, 'tests') });
  const said = [],
    npm = [process.execPath, '--eval', 'process.exit(9)'];
  ensureInstall(copy, data, npm, line => said.push(line));
  assert.match(said.join('\n'), /Using the packages installed for this lockfile/);
  assert.throws(
    () => ensureInstall(outside, data, npm, line => said.push(line)),
    /^Error: The tested copy is outside the controller's data folder, so it cannot use the installed packages\.$/,
  );
});

test('an artifact or test record reached by a short spelling inside its job folder is read, and one outside is not', async t => {
  const { real } = spelledFolder(t),
    store = { directory: path.join(real, 'data') },
    measured = [{ kind: 'test-log', path: 'test-output.txt' }],
    attempt = { id: 'attempt-short', artifacts: measured },
    moved = { id: 'attempt-moved', artifacts: measured },
    output = path.join(store.directory, 'jobs', attempt.id, 'output'),
    movedOutput = path.join(store.directory, 'jobs', moved.id, 'output'),
    elsewhere = path.join(real, 'elsewhere.txt');
  for (const folder of [output, movedOutput]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'result.txt'), 'done\n');
    fs.writeFileSync(path.join(folder, 'test-output-full.txt'), '# pass 1\n');
  }
  fs.writeFileSync(path.join(output, 'moved.txt'), 'moved\n');
  fs.writeFileSync(elsewhere, '# pass 1\n');
  // The output folders are reached by the short spelling; the store keeps the data folder by its long one. Two files
  // are really elsewhere, outside their job folders, as behind a link or after a move.
  shortSpelled(t, real, {
    reached: path.join(store.directory, 'jobs', attempt.id, 'output'),
    elsewhere: new Map([
      [path.join(output, 'moved.txt'), elsewhere],
      [path.join(movedOutput, 'test-output-full.txt'), elsewhere],
    ]),
  });
  // An artifact is recorded by its real spelling.
  assert.equal(artifactPath(store, attempt, 'result.txt'), path.join(output, 'result.txt'));
  assert.throws(
    () => artifactPath(store, attempt, 'moved.txt'),
    /Artifact symlinks outside the workspace are not allowed\./,
  );
  const stream = testRecordStream(store, attempt, 'attempt');
  assert.equal(Buffer.concat(await stream.toArray()).toString('utf8'), '# pass 1\n');
  assert.throws(() => testRecordStream(store, moved, 'attempt'), /The whole record is outside its job folder\./);
});
