import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localConfiguration } from '../src/server.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { setupStable, promote } from '../scripts/stable-copy.mjs';
// Inside the candidate sandbox, temporary folders must live in the writable workspace.
import './model-free-studio.mjs';

const temporary = t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stable-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('studio.local.json points a stable copy at shared records and a development copy; environment wins', t => {
  const root = temporary(t);
  assert.deepEqual(localConfiguration(root, {}), { dataDirectory: path.join(root, 'data'), sourceRoot: undefined });
  fs.writeFileSync(
    path.join(root, 'studio.local.json'),
    JSON.stringify({ dataDirectory: '../dev/data', sourceRoot: '../dev' }),
  );
  assert.deepEqual(localConfiguration(root, {}), {
    dataDirectory: path.resolve(root, '../dev/data'),
    sourceRoot: path.resolve(root, '../dev'),
  });
  assert.equal(localConfiguration(root, { STUDIO_SOURCE_ROOT: '/elsewhere' }).sourceRoot, path.resolve('/elsewhere'));
  fs.writeFileSync(path.join(root, 'studio.local.json'), JSON.stringify({ port: 1 }));
  assert.throws(() => localConfiguration(root, {}), /only dataDirectory and sourceRoot/);
  fs.writeFileSync(path.join(root, 'studio.local.json'), '{');
  assert.throws(() => localConfiguration(root, {}), /not valid JSON/);
});

test('setup creates a stable worktree; promote fast-forwards it to committed development work only', t => {
  const base = temporary(t),
    development = path.join(base, 'dev'),
    stable = path.join(base, 'dev-stable');
  fs.mkdirSync(development);
  git(development, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(development, ['config', 'user.name', 'Fixture']);
  git(development, ['config', 'user.email', 'fixture@example.invalid']);
  git(development, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(development, 'a.txt'), 'one\n');
  git(development, ['add', '-A']);
  git(development, ['commit', '--quiet', '-m', 'Baseline']);

  const configuration = setupStable(development, stable);
  assert.equal(git(stable, ['rev-parse', '--abbrev-ref', 'HEAD']), 'stable');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stable, 'studio.local.json'), 'utf8')), configuration);
  assert.equal(path.resolve(configuration.sourceRoot), development);
  assert.throws(() => setupStable(development, stable), /already exists/);
  assert.equal(promote(stable).commits, '', 'Nothing to promote yet.');

  fs.writeFileSync(path.join(development, 'a.txt'), 'two\n');
  git(development, ['commit', '--quiet', '-am', 'Pipeline change']);
  fs.writeFileSync(path.join(development, 'a.txt'), 'uncommitted\n');
  assert.match(promote(stable).commits, /Pipeline change/);
  assert.equal(fs.readFileSync(path.join(stable, 'a.txt'), 'utf8'), 'two\n', 'Only committed work is promoted.');
  assert.throws(() => promote(development), /run promote in the stable copy/);

  fs.writeFileSync(path.join(stable, 'a.txt'), 'edited in stable\n');
  assert.throws(() => promote(stable), /uncommitted changes/);
  git(stable, ['checkout', '--quiet', '--', 'a.txt']);
  git(stable, ['commit', '--quiet', '--allow-empty', '-m', 'Diverged']);
  git(development, ['commit', '--quiet', '-am', 'More work']);
  assert.throws(() => promote(stable), /merge failed/, 'Promotion never creates a merge commit.');
});
