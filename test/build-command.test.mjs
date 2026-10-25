// A project's build command (1.1, MP-028): its repository settings can name a build or type-check command, a program
// and its arguments run without a shell, which runs before the tests on every candidate, integration, carry forward
// and Release, in the same test sandbox. A failing build makes a negative candidate whose evidence names why, so it
// goes back to its editor before review; at integration it stops the verification. A build that changes the files
// the settings cover stops the attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { studioDeskProfile, validateSourceProfile } from '../src/connectors/source-profile.mjs';
import { buildCommand, changedByBuild } from '../src/connectors/source-build.mjs';
import { validateSourceChange } from '../src/connectors/source-changes.mjs';

const withBuild = build => ({ ...studioDeskProfile, id: 'fixture-build', install: null, build }),
  profile = withBuild(['node', 'scripts/build.mjs']);

test("a build command is a program's name and its arguments, run without a shell", () => {
  for (const build of [
    undefined,
    null,
    ['npm', 'run', 'build'],
    ['npx', 'tsc', '--noEmit'],
    ['cargo', 'build', '--release'],
    ['node', 'scripts/build.mjs', 'a b; rm -rf /'],
  ])
    assert.doesNotThrow(() => validateSourceProfile(withBuild(build)), JSON.stringify(build));
  for (const build of [
    [],
    'npm run build',
    ['../tool'],
    ['/usr/bin/make'],
    ['.hidden'],
    ['npm', 'run\nbuild'],
    [7],
    ['npm', ...Array(20).fill('x')],
  ])
    assert.throws(
      () => validateSourceProfile(withBuild(build)),
      /build must be null or a program's name and up to 19 arguments/,
      JSON.stringify(build),
    );
  // npm, npx and node run with the controller's Node.js; another program runs by name.
  const npm = buildCommand(withBuild(['npm', 'run', 'build']));
  assert.equal(npm.executable, process.execPath);
  assert.match(npm.args[0], /npm-cli\.js$/);
  assert.deepEqual(npm.args.slice(1), ['run', 'build']);
  assert.match(buildCommand(withBuild(['npx', 'tsc'])).args[0], /npx-cli\.js$/);
  assert.deepEqual(buildCommand(withBuild(['node', 'b.mjs'])), { executable: process.execPath, args: ['b.mjs'] });
  assert.deepEqual(buildCommand(withBuild(['cargo', 'build'])), { executable: 'cargo', args: ['build'] });
  assert.equal(buildCommand(withBuild(null)), null);
  assert.equal(buildCommand(studioDeskProfile), null, "Studio desk's own build runs inside its tests.");
});

// The fixture repository with a build script committed, its candidates and integrations tested without a sandbox so
// the script really runs. The script writes to out/, which the settings leave out, and stops while
// scripts/stop-build.mjs exists.
const script = `import fs from 'node:fs';
if (fs.existsSync('scripts/stop-build.mjs')) {
  console.error('The fixture build stops here.');
  process.exit(3);
}
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/built.txt', 'built');
console.log('Built into out/.');
`;
async function building(t, source = script) {
  const c = await setup(t),
    store = c.app.store;
  fs.writeFileSync(path.join(c.root, 'scripts/build.mjs'), source);
  git(c.root, ['add', 'scripts/build.mjs']);
  git(c.root, ['commit', '--quiet', '-m', 'A build script']);
  const org = store.organization();
  org.testSandbox = 'none';
  store.setOrganization(org);
  return c;
}
const output = (attempt, file) => fs.readFileSync(path.join(attempt.outputFolder, file), 'utf8');
const check = (checks, name) => checks.find(item => item.name === name);

test('a passing build runs before the tests on the candidate and again at integration', async t => {
  const c = await building(t),
    store = c.app.store;
  c.taskId = await c.propose('built', { profile });
  await c.start();
  const candidate = await c.wait(c.taskId),
    attempt = store.attempt(candidate.id);
  assert.match(attempt.result.summary, /^Passing isolated source candidate: the build passed; 1\/1 tests passed\./);
  assert.deepEqual(check(attempt.result.checks, 'Candidate build'), {
    name: 'Candidate build',
    status: 'pass',
    evidence: 'node scripts/build.mjs, without a sandbox: the build passed.',
  });
  assert.equal(check(attempt.result.checks, 'Candidate Node test suite').status, 'pass');
  assert.match(output(attempt, 'build-output.txt'), /Built into out\//);
  const report = JSON.parse(output(attempt, 'check-report.json'));
  assert.equal(report.passed, true);
  assert.deepEqual([report.build.passed, report.build.execution.exitCode], [true, 0]);
  assert.deepEqual(attempt.sourceCandidate.build, {
    executable: process.execPath,
    args: ['scripts/build.mjs'],
  });
  assert.equal(attempt.buildExecution.exitCode, 0);
  const review = await c.review(candidate);
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  const integration = await c.settled(review);
  assert.equal(integration.state, 'integrated', JSON.stringify(integration));
  assert.deepEqual(
    integration.verification.checks.map(item => [item.name, item.status]),
    [
      ['Integration build', 'pass'],
      ['Integration Node test suite', 'pass'],
    ],
  );
  assert.equal(git(c.root, ['status', '--porcelain']), '', 'The build wrote only inside the copies it tested.');
});

test('a failing build makes a negative candidate whose evidence says why, and its tests still run', async t => {
  const c = await building(
      t,
      "console.error('src/core/workflows.mjs(3,1): error TS1005: a fixture error.');\nprocess.exit(2);\n",
    ),
    store = c.app.store;
  c.taskId = await c.propose('broken', { profile });
  await c.start();
  const attempt = store.attempt((await c.wait(c.taskId)).id);
  assert.match(
    attempt.result.summary,
    /^Negative isolated source candidate: the build failed \(exit 2\); 1\/1 tests passed\./,
  );
  const built = check(attempt.result.checks, 'Candidate build');
  assert.equal(built.status, 'fail');
  assert.equal(
    built.evidence,
    'node scripts/build.mjs, without a sandbox: the build failed (exit 2).\nsrc/core/workflows.mjs(3,1): error TS1005: a fixture error.',
  );
  assert.equal(check(attempt.result.checks, 'Candidate Node test suite').status, 'pass');
  const report = JSON.parse(output(attempt, 'check-report.json'));
  assert.deepEqual([report.passed, report.build.passed, report.build.execution.exitCode], [false, false, 2]);
  // The recorded evidence checks out, and a changed build log does not.
  const read = file => fs.readFileSync(path.join(attempt.outputFolder, file));
  assert.doesNotThrow(() => validateSourceChange(attempt, read));
  fs.writeFileSync(path.join(attempt.outputFolder, 'build-output.txt'), 'Nothing went wrong.');
  assert.throws(() => validateSourceChange(attempt, read), /does not match its recorded execution and logs/);
});

test('a build that fails on the merged source stops the integration with its reason', async t => {
  const c = await building(t),
    store = c.app.store;
  c.taskId = await c.propose('later', { profile });
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  // A hand commit meanwhile breaks the build, though not the story's own candidate.
  fs.writeFileSync(path.join(c.root, 'scripts/stop-build.mjs'), '// Stops the fixture build.\n');
  git(c.root, ['add', 'scripts/stop-build.mjs']);
  git(c.root, ['commit', '--quiet', '-m', 'Stop the build']);
  assert.equal((await c.integration(review)).status, 200);
  const integration = await c.settled(review);
  assert.equal(integration.state, 'rejected', JSON.stringify(integration));
  assert.match(integration.verification.error, /^The build failed: The fixture build stops here\./);
  assert.deepEqual(
    integration.verification.checks.map(item => [item.name, item.status]),
    [['Integration build', 'fail']],
  );
  assert.match(integration.verification.checks[0].evidence, /exit 3\.\nThe fixture build stops here\./);
  assert.equal(store.leases().length, 0);
});

test('a build that changes the files the settings cover stops the attempt', async t => {
  const c = await building(t, "import fs from 'node:fs';\nfs.writeFileSync('docs/generated.md', 'Generated');\n"),
    store = c.app.store;
  c.taskId = await c.propose('writes', { profile });
  await c.start();
  const attempt = store.attempt((await c.wait(c.taskId, 'failed')).id);
  assert.match(attempt.error, new RegExp(changedByBuild.replace(/[.]/g, '\\.')));
  assert.equal(store.leases().length, 0);
});
