// Story paths may hold [ ] and ( ), which git would read as pathspec globs: src/[s]/page.mjs would
// also match src/s/page.mjs. git() runs every command but check-ignore with --literal-pathspecs, so
// each listed path names exactly one file. These tests use a disposable repository holding both
// spellings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitIntegration, git, stageFiles, statusPaths } from '../src/connectors/source-integration.mjs';
import { commitCandidate, committedPaths, ignoredPaths } from '../src/connectors/source-worktrees.mjs';
// Inside the candidate sandbox, temporary folders must live in the writable workspace.
import './model-free-studio.mjs';

const write = (root, file, text) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
};
const baseline = ['src/s/page.mjs', 'src/[s]/page.mjs', 'src/(group)/page.mjs', 'src/AGENTS.md'];
// Same init and config as test/source-repository.mjs; the commit message is written beside the
// repository, not in it.
const repository = t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lit-'))),
    root = path.join(directory, 'r');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of baseline) write(root, file, `// ${file}\n`);
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Fixture source']);
  return { root, directory };
};
const lastCommitPaths = root => git(root, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n');
const tracked = (root, files = []) =>
  git(root, ['ls-files', '-z', '--', ...files], { raw: true })
    .split('\0')
    .filter(Boolean);

test('a bracketed path names only itself when checking status and committed files', t => {
  const { root } = repository(t);
  assert.deepEqual(tracked(root).sort(), [...baseline].sort(), 'git lists each name unchanged.');
  write(root, 'src/s/page.mjs', 'edited\n');
  assert.deepEqual(statusPaths(root, ['src/[s]/page.mjs']), []);
  assert.deepEqual(statusPaths(root, ['src/s/page.mjs']), ['src/s/page.mjs']);
  assert.deepEqual(committedPaths(root, ['src/[s]/page.mjs']), ['src/[s]/page.mjs']);
  assert.deepEqual(committedPaths(root, ['src/s/page.mjs']), []);
  assert.deepEqual(tracked(root, ['src/[s]/page.mjs']), ['src/[s]/page.mjs']);
  // A folder name still matches the files under it, as the snapshot paths rely on.
  assert.deepEqual(statusPaths(root, ['src/s']), ['src/s/page.mjs']);
  assert.deepEqual(statusPaths(root, ['src/[s]']), []);
  assert.deepEqual(statusPaths(root, ['src']), ['src/s/page.mjs']);
});

test('integrating a bracketed path commits only that file and leaves its look-alike edited', t => {
  const { root, directory } = repository(t);
  write(root, 'src/[s]/page.mjs', 'integrated\n');
  write(root, 'src/s/page.mjs', 'local edit\n');
  const head = commitIntegration(root, ['src/[s]/page.mjs'], 'Integrate the bracketed page\n', directory);
  assert.equal(head, git(root, ['rev-parse', 'HEAD']));
  assert.deepEqual(lastCommitPaths(root), ['src/[s]/page.mjs']);
  assert.equal(git(root, ['show', 'HEAD:src/[s]/page.mjs']), 'integrated');
  assert.equal(git(root, ['show', 'HEAD:src/s/page.mjs']), '// src/s/page.mjs');
  assert.deepEqual(statusPaths(root), ['src/s/page.mjs'], 'The look-alike stays modified in the working tree.');
  assert.equal(fs.readFileSync(path.join(root, 'src/s/page.mjs'), 'utf8'), 'local edit\n');
});

test('a bracketed look-alike of a protected name never stages or commits that file', t => {
  const { root, directory } = repository(t);
  const head = git(root, ['rev-parse', 'HEAD']),
    // The refusal may come from the helper or from git; what matters is what reaches the commit.
    attempt = operation => {
      try {
        operation();
      } catch {}
    };
  write(root, 'src/AGENTS.md', 'edited instructions\n');
  attempt(() => stageFiles(root, ['src/[A]GENTS.md']));
  attempt(() => git(root, ['add', '--', 'src/[A]GENTS.md']));
  assert.equal(git(root, ['diff', '--cached', '--name-only']), '', 'Nothing is staged.');
  attempt(() => commitIntegration(root, ['src/[A]GENTS.md'], 'Look-alike\n', directory));
  attempt(() => git(root, ['commit', '--quiet', '-m', 'Look-alike', '--', 'src/[A]GENTS.md']));
  assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'Nothing is committed.');
  assert.equal(git(root, ['show', 'HEAD:src/AGENTS.md']), '// src/AGENTS.md');
  assert.deepEqual(statusPaths(root), ['src/AGENTS.md'], 'src/AGENTS.md stays modified and uncommitted.');
});

test('a candidate commits a new bracketed file under its exact name and nothing it would match as a glob', t => {
  const { root } = repository(t);
  const file = 'src/(group)/[id]/new.mjs',
    lookAlike = 'src/(group)/i/new.mjs';
  write(root, file, 'export const created = true;\n');
  write(root, lookAlike, 'export const created = false;\n');
  const commit = commitCandidate(root, [file], 'attempt-literal', 'Literal paths');
  assert.equal(git(root, ['rev-parse', 'refs/studio/candidates/attempt-literal']), commit);
  assert.deepEqual(lastCommitPaths(root), [file]);
  assert.ok(tracked(root).includes(file), 'git ls-files -z lists the new file unchanged.');
  assert.ok(!tracked(root).includes(lookAlike));
  assert.deepEqual(statusPaths(root), [lookAlike], 'The look-alike stays untracked.');
});

// check-ignore refuses --literal-pathspecs, so git() leaves it out there; were it added, every call
// would fail and ignoredPaths would report nothing.
test('ignoredPaths reports a bracketed path only when a .gitignore names it literally', t => {
  const { root } = repository(t);
  const file = 'src/[s]/ignored.mjs',
    lookAlike = 'src/s/ignored.mjs',
    ignored = () => ignoredPaths(root, [lookAlike, file]),
    rules = (folder, text) => fs.writeFileSync(path.join(root, folder, '.gitignore'), text);
  assert.deepEqual(ignored(), []);
  rules('src/s', 'ignored.mjs\n');
  assert.deepEqual(ignored(), [lookAlike], 'Ignoring the look-alike does not ignore the bracketed path.');
  fs.rmSync(path.join(root, 'src/s/.gitignore'));
  // In a .gitignore pattern, bare brackets are themselves a glob, here for src/s/ignored.mjs.
  rules('.', 'src/[s]/ignored.mjs\n');
  assert.deepEqual(ignored(), [lookAlike]);
  rules('.', 'src/\\[s\\]/ignored.mjs\n');
  assert.deepEqual(ignored(), [file]);
  fs.rmSync(path.join(root, '.gitignore'));
  rules('src/[s]', 'ignored.mjs\npage.mjs\n');
  assert.deepEqual(ignored(), [file]);
  assert.deepEqual(
    ignoredPaths(root, ['src/[s]/page.mjs', file]),
    [file],
    'A tracked file is not reported, though a rule names it.',
  );
});
