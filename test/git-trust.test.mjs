// The controller's own git calls run none of a repository's code (C-06, src/git.mjs): no hook, from .git/hooks or a
// configured hooks folder, and no fsmonitor command, on reads, commits, worktrees or checkouts. The director's own git
// in the same repository runs them, which the test checks first, so the fixture is real wherever hooks can run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { controllerGitArguments, runGit, runGitAsync } from '../src/git.mjs';
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
  // The hooks go in .git/hooks where a test may write there. The built-in test sandbox on macOS and Linux refuses every
  // .git/hooks (found in the 1.2 release proof on Linux, November 4, 2026), so there they go in a configured hooks
  // folder, which the controller's git ignores the same way (core.hooksPath=/dev/null).
  let hooks = path.join(root, '.git', 'hooks');
  try {
    fs.writeFileSync(path.join(hooks, 'probe'), '');
    fs.rmSync(path.join(hooks, 'probe'));
  } catch {
    hooks = path.join(directory, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    plain(['config', 'core.hooksPath', hooks.replaceAll('\\', '/')]);
  }
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout'])
    fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ran > "${marker(hook)}"\n`, { mode: 0o755 });
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

test("the controller's asynchronous git answers as its git does, runs no hooks, and leaves the thread free", async t => {
  const r = repository(t);
  fs.writeFileSync(path.join(r.root, 'a.txt'), 'b\n');
  r.plain(['commit', '-q', '-am', 'control']);
  const hooksRun = r.ran().includes('pre-commit');
  r.forget();
  // A timer keeps ticking while a batch of git calls is out, which a synchronous call would stop.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  const asked = Array.from({ length: 10 }, () => runGitAsync(r.root, ['log', '-1', '--format=%s']));
  const answers = await Promise.all([...asked, runGitAsync(r.root, ['status', '--porcelain'])]);
  clearInterval(timer);
  assert.ok(ticks > 0, 'the thread answered timers while git ran');
  assert.deepEqual(answers.slice(0, 10), Array(10).fill(runGit(r.root, ['log', '-1', '--format=%s'])));
  assert.equal(answers[10], runGit(r.root, ['status', '--porcelain']));
  if (hooksRun) assert.deepEqual(r.ran(), [], 'no fsmonitor command ran for status');
  await assert.rejects(
    runGitAsync(r.root, ['rev-parse', '--verify', 'no-such-branch']),
    /^Error: git rev-parse failed: /,
  );
  // Bytes come back when asked for, as the synchronous call answers them.
  assert.ok(
    Buffer.isBuffer(await runGitAsync(r.root, ['cat-file', '-p', 'HEAD:a.txt'], { encoding: null, literal: false })),
  );
});
