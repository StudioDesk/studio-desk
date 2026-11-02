// The controller's own git calls run none of a repository's code (C-06, src/git.mjs): no hook, from .git/hooks or a
// configured hooks folder, and no fsmonitor command, on reads, commits, worktrees or checkouts. The director's own git
// in the same repository runs them, which the test checks first, so the fixture is real wherever hooks can run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { controllerGitArguments, runGit } from '../src/git.mjs';
import { commitIntegration, git } from '../src/connectors/source-integration.mjs';

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-trust-')),
    root = path.join(directory, 'repo'),
    markers = path.join(directory, 'markers');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root);
  fs.mkdirSync(markers);
  const plain = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  plain(['init', '-q']);
  plain(['config', 'user.name', 'Test']);
  plain(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  plain(['add', 'a.txt']);
  plain(['commit', '-q', '-m', 'first']);
  const marker = name => path.join(markers, name).replaceAll('\\', '/');
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout'])
    fs.writeFileSync(path.join(root, '.git', 'hooks', hook), `#!/bin/sh\necho ran > "${marker(hook)}"\n`, {
      mode: 0o755,
    });
  plain(['config', 'core.fsmonitor', `sh -c 'echo ran > "${marker('fsmonitor')}"'`]);
  const ran = () => fs.readdirSync(markers).sort();
  const forget = () => {
    for (const name of ran()) fs.rmSync(path.join(markers, name));
  };
  return { directory, root, plain, ran, forget };
}

test("the controller's git runs none of a repository's hooks or its fsmonitor command", t => {
  const r = repository(t);
  fs.writeFileSync(path.join(r.root, 'a.txt'), 'b\n');
  r.plain(['commit', '-q', '-am', 'control']);
  if (!r.ran().includes('pre-commit')) return t.skip('git hooks cannot run on this computer');
  assert.ok(r.ran().includes('fsmonitor'), 'the fixture names an fsmonitor command git runs');
  r.forget();
  git(r.root, ['status', '--porcelain']);
  fs.writeFileSync(path.join(r.root, 'a.txt'), 'c\n');
  commitIntegration(r.root, ['a.txt'], 'Integrated\n', r.directory);
  const copy = path.join(r.directory, 'copy');
  git(r.root, ['worktree', 'add', '--detach', copy, 'HEAD']);
  git(copy, ['checkout', '--quiet', '--detach', 'HEAD~1']);
  runGit(r.root, ['log', '--oneline']);
  assert.deepEqual(r.ran(), []);
  assert.equal(git(r.root, ['log', '-1', '--format=%s']), 'Integrated');
  assert.equal(git(copy, ['log', '-1', '--format=%s']), 'control');
});

test("every call but Push adds the same options before git's own arguments", () => {
  const options = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true'];
  assert.deepEqual(controllerGitArguments(['status']), ['--literal-pathspecs', ...options, 'status']);
  // check-ignore refuses pathspec magic, --literal-pathspecs included.
  assert.deepEqual(controllerGitArguments(['check-ignore', '-z', '--stdin']), [
    ...options,
    'check-ignore',
    '-z',
    '--stdin',
  ]);
  assert.deepEqual(controllerGitArguments(['cat-file', '-p', 'HEAD'], { literal: false }), [
    ...options,
    'cat-file',
    '-p',
    'HEAD',
  ]);
});
