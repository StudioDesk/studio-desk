import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinGitSettings } from './model-free-studio.mjs';

// The git every test starts, with the suite's environment, on a computer whose system settings rewrite line endings
// (Git for Windows ships core.autocrlf=true there).
function setup(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-eol-'))),
    systemSettings = path.join(directory, 'system-gitconfig');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(systemSettings, '[core]\n\tautocrlf = true\n');
  const env = { ...process.env, GIT_CONFIG_SYSTEM: systemSettings };
  delete env.GIT_CONFIG_NOSYSTEM;
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error?.message}`);
    return result.stdout.trim();
  };
  return { directory, git };
}

test("the suite's git keeps a file's line endings when the computer's system settings convert them", t => {
  const { directory, git } = setup(t),
    root = path.join(directory, 'r'),
    copy = path.join(directory, 'wt'),
    content = 'first line\nsecond line\n';
  fs.mkdirSync(root);
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  // The system settings are the ones git reads, and the suite's own win over them.
  assert.equal(git(root, ['config', '--system', 'core.autocrlf']), 'true');
  assert.equal(git(root, ['config', 'core.autocrlf']), 'false');
  assert.equal(git(root, ['config', 'core.eol']), 'lf');
  fs.writeFileSync(path.join(root, 'notes.txt'), content);
  git(root, ['add', 'notes.txt']);
  git(root, ['commit', '--quiet', '-m', 'LF file']);
  git(root, ['worktree', 'add', '--quiet', '--detach', copy, 'HEAD']);
  assert.deepEqual(fs.readFileSync(path.join(copy, 'notes.txt')), Buffer.from(content));
  assert.equal(git(copy, ['status', '--porcelain']), '');
});

test('pinning line endings keeps the command settings already in the environment and is not repeated', () => {
  const environment = pinGitSettings({
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    GIT_CONFIG_KEY_1: 'core.autocrlf',
    GIT_CONFIG_VALUE_1: 'true',
  });
  pinGitSettings(environment);
  assert.deepEqual(environment, {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    GIT_CONFIG_KEY_1: 'core.autocrlf',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.eol',
    GIT_CONFIG_VALUE_2: 'lf',
  });
  assert.deepEqual(pinGitSettings({ GIT_CONFIG_COUNT: 'none' }), {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.eol',
    GIT_CONFIG_VALUE_1: 'lf',
  });
});
