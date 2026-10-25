import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Reuse the candidate-local temp policy: MXC's redirected OS temp denies Git writes.
import './model-free-studio.mjs';
import { snapshotCommit, verifySnapshot } from '../src/adapters/source-snapshot.mjs';
import {
  checkReport,
  ensureSourceDirectories,
  maxSourceFileBytes,
  sourcePaths,
  sourcePlan,
} from '../src/connectors/source-checks.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { createSourceWorktree, removeSourceWorktree } from '../src/connectors/source-worktrees.mjs';

function setup(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-snap-'))),
    root = path.join(directory, 'r'),
    parent = path.join(directory, 'wt'),
    destination = path.join(directory, 'copy');
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  ensureSourceDirectories(root);
  for (const file of sourcePaths)
    if (!fs.existsSync(path.join(root, file)))
      fs.writeFileSync(path.join(root, file), file === 'package.json' ? '{}' : 'Commit A\n');
  fs.writeFileSync(path.join(root, 'src/feature.mjs'), 'export const value = "A";\n');
  fs.writeFileSync(path.join(root, 'test/feature.test.mjs'), "import test from 'node:test';\ntest('A', () => {});\n");
  // Synthetic excluded content is committed too, proving exclusion is the source
  // allowlist's decision rather than merely git's tracked/untracked distinction.
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/fixture.json'), '{"fixture":true}');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'Excluded fixture\n');
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Commit A']);
  const base = { commit: git(root, ['rev-parse', 'HEAD']), branch: 'main' },
    plan = { ...sourcePlan(root), base },
    log = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
    report = checkReport(plan, { exitCode: 0, signal: null, fixture: false }, log, '');
  return {
    directory,
    root,
    parent,
    destination,
    base,
    plan,
    report,
    copy: (expected = report) => snapshotCommit(root, parent, 'snapshot', base, destination, expected),
  };
}

function assertClean(c) {
  assert.equal(fs.existsSync(path.join(c.parent, 'snapshot')), false);
  assert.equal((git(c.root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm) || []).length, 1);
}

for (const advance of [false, true])
  test(`a measured A snapshot survives ${advance ? 'an advance to B and ' : ''}uncommitted changes`, t => {
    const c = setup(t);
    if (advance) {
      fs.writeFileSync(path.join(c.root, 'src/feature.mjs'), 'export const value = "B";\n');
      git(c.root, ['add', 'src/feature.mjs']);
      git(c.root, ['commit', '--quiet', '-m', 'Commit B']);
      assert.notEqual(git(c.root, ['rev-parse', 'HEAD']), c.base.commit);
    }
    fs.writeFileSync(path.join(c.root, 'src/feature.mjs'), 'Uncommitted edit\n');
    fs.writeFileSync(path.join(c.root, 'src/untracked.mjs'), 'Untracked fixture\n');
    const plan = c.copy();
    assert.deepEqual(plan, c.plan);
    assert.equal(plan.root, fs.realpathSync(c.root));
    assert.equal(plan.base.commit, c.report.source.commit);
    assert.equal(sourcePlan(c.destination).sourceHash, c.report.source.hash);
    assert.deepEqual(sourcePlan(c.destination).files, c.report.source.files);
    assert.equal(fs.readFileSync(path.join(c.destination, 'src/feature.mjs'), 'utf8'), 'export const value = "A";\n');
    for (const excluded of ['data', '.git', 'outside.txt', 'src/untracked.mjs'])
      assert.equal(fs.existsSync(path.join(c.destination, excluded)), false, excluded);
    assert.equal(fs.readFileSync(path.join(c.root, 'src/feature.mjs'), 'utf8'), 'Uncommitted edit\n');
    assertClean(c);
  });

test('accepted-report identity, fingerprint and full manifest must match the copied commit', t => {
  const c = setup(t);
  for (const alter of [
    report => {
      report.source.root = c.directory;
    },
    report => {
      report.source.commit = '0'.repeat(40);
    },
    report => {
      report.source.hash = '0'.repeat(64);
    },
    report => {
      report.source.files[0].bytes++;
    },
    report => {
      report.source.files[0].hash = '0'.repeat(64);
    },
    report => {
      report.source.files.pop();
    },
  ]) {
    const report = structuredClone(c.report);
    alter(report);
    assert.throws(() => c.copy(report), /Source snapshot integrity failure:.*accepted report/);
    assert.equal(fs.existsSync(c.destination), false, 'A rejected copy is removed.');
    assertClean(c);
  }
  const negativeReport = { ...c.report, passed: false };
  assert.deepEqual(c.copy(negativeReport), c.plan, 'Accepted negative measurements may support corrective planning.');
  assertClean(c);
});

test('changed, added and removed copied files cause explicit integrity failures', t => {
  const c = setup(t),
    plan = c.copy(),
    target = path.join(c.destination, 'src/feature.mjs'),
    original = fs.readFileSync(target);
  fs.writeFileSync(target, 'Changed after copying\n');
  assert.throws(() => verifySnapshot(plan, c.destination, c.report), /Source snapshot integrity failure/);
  fs.writeFileSync(target, original);
  const added = path.join(c.destination, 'src/added.mjs');
  fs.writeFileSync(added, 'Added after copying\n');
  assert.throws(() => verifySnapshot(plan, c.destination, c.report), /Source snapshot integrity failure/);
  fs.unlinkSync(added);
  fs.unlinkSync(target);
  assert.throws(() => verifySnapshot(plan, c.destination, c.report), /Source snapshot integrity failure/);
  fs.writeFileSync(target, original);
  assert.equal(verifySnapshot(plan, c.destination, c.report), plan);
  assertClean(c);
});

test('a symbolic link in copied source is rejected', t => {
  const c = setup(t),
    plan = c.copy(),
    target = path.join(c.destination, 'src/feature.mjs'),
    originalStat = fs.lstatSync;
  // Model a redirected file at the filesystem boundary without OS link privileges.
  const redirected = t.mock.method(fs, 'lstatSync', function (filename, ...args) {
    if (filename === target) return { isSymbolicLink: () => true, isDirectory: () => true };
    return originalStat.call(this, filename, ...args);
  });
  assert.throws(
    () => verifySnapshot(plan, c.destination, c.report),
    /Source snapshot integrity failure:.*symbolic links/,
  );
  redirected.mock.restore();
  assert.equal(verifySnapshot(plan, c.destination, c.report), plan);
  assertClean(c);
});

test('a missing measured commit fails rather than selecting HEAD', t => {
  const c = setup(t);
  assert.throws(
    () => snapshotCommit(c.root, c.parent, 'snapshot', { commit: '0'.repeat(40) }, c.destination, c.report),
    /git worktree failed/,
  );
  for (const commit of [undefined, '', 'HEAD', '--detach'])
    assert.throws(
      () => snapshotCommit(c.root, c.parent, 'snapshot', { commit }, c.destination),
      /recorded source commit/,
    );
  assert.equal(fs.existsSync(c.destination), false);
  assertClean(c);
});

test('temporary worktrees are removed when measuring exceeds the source limits', t => {
  const c = setup(t);
  fs.writeFileSync(path.join(c.root, 'src/large.mjs'), Buffer.alloc(maxSourceFileBytes + 1, 65));
  git(c.root, ['add', 'src/large.mjs']);
  git(c.root, ['commit', '--quiet', '-m', 'Oversized fixture']);
  const base = { commit: git(c.root, ['rev-parse', 'HEAD']), branch: 'main' };
  assert.throws(
    () => snapshotCommit(c.root, c.parent, 'snapshot', base, c.destination),
    /src\/large\.mjs is larger than the 1024 KB a file a story may edit can be/,
  );
  assert.equal(fs.existsSync(c.destination), false);
  assertClean(c);
});

test('temporary worktrees are removed even when initial directory preparation fails', t => {
  const c = setup(t),
    originalMkdir = fs.mkdirSync,
    target = path.join(c.parent, 'snapshot', 'src');
  const denied = t.mock.method(fs, 'mkdirSync', function (filename, ...args) {
    if (filename === target) throw new Error('Fixture directory preparation failure');
    return originalMkdir.call(this, filename, ...args);
  });
  assert.throws(() => c.copy(), /Fixture directory preparation failure/);
  denied.mock.restore();
  assert.equal(fs.existsSync(c.destination), false);
  assertClean(c);
});

test('copy preparation failure removes its worktree and partial destination', t => {
  const c = setup(t),
    originalWrite = fs.writeFileSync,
    target = path.join(c.destination, 'README.md');
  const denied = t.mock.method(fs, 'writeFileSync', function (filename, ...args) {
    if (filename === target) throw new Error('Fixture copy failure');
    return originalWrite.call(this, filename, ...args);
  });
  assert.throws(() => c.copy(), /Fixture copy failure/);
  denied.mock.restore();
  assert.equal(fs.existsSync(c.destination), false);
  assertClean(c);
});

test('a pre-existing worktree or destination remains owned by its original caller', t => {
  const c = setup(t),
    worktree = createSourceWorktree(c.root, c.parent, 'snapshot', c.base.commit);
  assert.throws(() => c.copy(), /worktree already exists/);
  assert.equal(fs.existsSync(path.join(worktree, '.git')), true);
  removeSourceWorktree(c.root, worktree);
  fs.mkdirSync(c.destination);
  const sentinel = path.join(c.destination, 'README.md');
  fs.writeFileSync(sentinel, 'Owned by another caller\n');
  assert.throws(() => c.copy(), /destination already exists/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Owned by another caller\n');
  assertClean(c);
});
