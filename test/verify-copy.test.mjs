// npm run verify -- --as checks tests its copy of a commit in the same short folder an idea's checks use
// (<data>/wt/<name>, by the worktrees' folder's real spelling), not deep inside a job folder, and removes only that
// copy afterwards; --as candidate still tests a 'v-' worktree beside it. Model-free: a disposable git repository,
// an idea's checks with a gated trusted fixture test command, and no install, test suite or sandbox run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
// The candidate-local temp policy: MXC's redirected OS temp denies Git writes.
import './model-free-studio.mjs';
import { makeTestedCopy } from '../scripts/verify-copy.mjs';
import { sourcePlan } from '../src/connectors/source-checks.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { worktreeName } from '../src/connectors/source-worktrees.mjs';
import { realPath } from '../src/core/real-path.mjs';

const tap = [
  'TAP version 13',
  '1..1',
  'ok 1 - verify copy fixture',
  '# tests 1',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
].join('\n');
// A passing test run that writes its working directory to `where`, then ends once its gate file exists.
const gated = (gate, where) => ({
  executable: process.execPath,
  args: [
    '-e',
    `const fs = require('node:fs'), [gate, where] = process.argv.slice(1); fs.writeFileSync(where, process.cwd()); const wait = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(wait); console.log(${JSON.stringify(tap)}); } }, 20);`,
    gate,
    where,
  ],
});

// An idea's checks, as intake creates them.
function addChecks(c, id) {
  const worker = c.app.store.organization().workers.find(worker => worker.id === 'W-06');
  c.app.store.putTask({
    id,
    projectId: 'project-legacy',
    title: 'Check the current commit',
    brief: 'Measure the current commit.',
    acceptance: '',
    kind: 'studio-development:checks',
    workerId: 'W-06',
    team: worker.team,
    dependencies: [],
    resources: [],
    maxSeconds: 120,
    maxAttempts: 3,
    direction: '',
    status: 'ready',
    reason: '',
    hold: false,
    lastAttemptId: null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

const id = 'attempt-5e1f00d2-0000-4000-8000-000000000000';

test("verify's checks copy sits where an idea's checks put theirs, as short, and only it is removed", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner,
    gate = path.join(c.directory, 'gate'),
    where = path.join(c.directory, 'cwd.txt');
  // The folder an idea's checks attempt records, relative to the studio's data folder.
  runner.sourceCheckCommand = gated(gate, where);
  const checksId = runner.start(addChecks(c, 'T-verify-copy')).attemptId;
  await waitFor(() => fs.existsSync(where), 'the tests to start');
  const recorded = store.attempt(checksId).sourceCheckFolder.path,
    expected = path.relative(realPath(store.directory), recorded);
  fs.writeFileSync(gate, '');
  assert.equal((await c.wait('T-verify-copy')).id, checksId);

  // Verify's own data folder for the same repository (removed with the fixture's temporary folder).
  const data = path.join(c.directory, 'verify'),
    commit = git(c.root, ['rev-parse', 'HEAD']);
  fs.mkdirSync(data);
  const { copy, plan, cleanup } = makeTestedCopy({
    root: c.root,
    data,
    id,
    commit,
    as: 'checks',
    profile: studioDeskProfile,
  });
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  const relative = path.relative(realPath(data), copy);
  assert.equal(relative, path.join('wt', worktreeName(id)));
  assert.equal(
    relative.split(path.sep).length,
    expected.split(path.sep).length,
    `${relative} is as deep as ${expected}`,
  );
  assert.equal(relative.length, expected.length, `${relative} is as long as ${expected}`);
  assert.equal(path.dirname(copy), realPath(path.join(data, 'wt')), 'It sits directly under the real wt folder.');
  // It holds the measured commit's source.
  assert.ok(fs.existsSync(path.join(copy, 'package.json')));
  assert.equal(plan.base.commit, commit);
  assert.equal(sourcePlan(copy, studioDeskProfile).sourceHash, plan.sourceHash);
  assert.equal(fs.existsSync(path.join(data, 'projects')), false, 'Nothing is made under projects.');
  // The measuring worktree is already gone, and cleanup removes the copy.
  assert.deepEqual(fs.readdirSync(path.join(data, 'wt')), [worktreeName(id)]);
  cleanup();
  assert.equal(fs.existsSync(copy), false, 'The copy is removed.');
  assert.deepEqual(
    fs.readdirSync(path.join(data, 'wt')).filter(name => name.startsWith('c-')),
    [],
    'No measuring worktree is left.',
  );
  assert.equal(fs.existsSync(path.join(data, 'projects')), false);
});

test("verify's candidate copy is still a 'v-' worktree beside the candidates', removed afterwards", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    data = path.join(c.directory, 'verify'),
    commit = git(c.root, ['rev-parse', 'HEAD']);
  fs.mkdirSync(data);
  const { copy, plan, cleanup } = makeTestedCopy({
    root: c.root,
    data,
    id,
    commit,
    as: 'candidate',
    profile: studioDeskProfile,
  });
  let removed = false;
  t.after(() => {
    if (!removed) cleanup();
  });
  assert.equal(path.basename(copy), 'v-' + worktreeName(id));
  assert.equal(path.dirname(copy), realPath(path.join(data, 'wt')));
  assert.equal(git(copy, ['rev-parse', 'HEAD']), commit, 'It is a worktree at the commit.');
  assert.equal(plan.sourceHash, sourcePlan(copy, studioDeskProfile).sourceHash);
  cleanup();
  removed = true;
  assert.equal(fs.existsSync(copy), false, 'The worktree is removed.');
  assert.equal(git(c.root, ['worktree', 'list', '--porcelain']).includes('v-' + worktreeName(id)), false);
});
