// A known random test failure outside a story's files is the studio's environment (src/core/attempt-cause.mjs
// randomTestFailures): a negative candidate whose every failed test lies outside the story's files, and failed before
// on another story of the same project outside that story's files too, records endCause environment/random-test and
// does not use up one of the story's attempts. It is still a negative candidate on the same path to review. Model-free:
// the source-story fixture's protocol CLI, a fixture test command that prints the failures each run asks for, fixture
// attempt records, temporary records and no HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { causeText, endCause, randomTestFailures } from '../src/core/attempt-cause.mjs';
import { buildAttemptHistory } from '../src/core/attempt-history.mjs';

const work = { cause: 'work' },
  random = { cause: 'environment', detail: 'random-test' },
  plainWords = 'a test outside this story that has failed on other stories failed again; not counted';

// The fixture test command: one passing test, then a failure for each name it is given, at its test file.
const tapFixture = `const failing = {
  flaky: ['settles at random', 'test/bounded.test.mjs'],
  fresh: ['fails for the first time', 'test/other.test.mjs'],
};
const asked = process.argv.slice(2),
  lines = ['TAP version 13', 'ok 1 - passes'];
asked.forEach((key, index) => {
  const [name, file] = failing[key];
  lines.push('# Subtest: ' + name, 'not ok ' + (index + 2) + ' - ' + name, '  ---',
    "  location: '/repository/" + file + ":3:1'", "  failureType: 'testCodeFailure'", "  error: 'fixture failure'", '  ...');
});
const total = asked.length + 1;
lines.push('1..' + total, '# tests ' + total, '# pass 1', '# fail ' + asked.length, '# cancelled 0', '# skipped 0', '# todo 0');
console.log(lines.join('\\n'));
process.exitCode = asked.length ? 1 : 0;
`;

async function studio(t) {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store } = c.app;
  const org = store.organization();
  org.testSandbox = 'none';
  store.setOrganization(org);
  const tap = path.join(c.directory, 'random-tap.mjs');
  fs.writeFileSync(tap, tapFixture);
  // Runs one attempt of the story with the measured tests failing on `failures`, and returns it once it settled.
  c.run = async (id, ...failures) => {
    const { runner } = c.app;
    runner.sourceCheckCommand = { executable: process.execPath, args: [tap, ...failures] };
    runner.start(id);
    const attemptId = store.task(id).lastAttemptId;
    return waitFor(
      () => {
        const attempt = store.attempt(attemptId);
        return (
          ['review', 'failed', 'blocked', 'cancelled'].includes(attempt.status) &&
          !runner.active.has(attemptId) &&
          attempt
        );
      },
      `attempt ${attemptId} to settle`,
      {
        detail: () => {
          const { status, error } = store.attempt(attemptId);
          return JSON.stringify({ status, error });
        },
      },
    );
  };
  c.counted = id => c.app.runner.registries.workflows.stageAttempts(store, store.task(id)).length;
  return c;
}
const check = (attempt, name) => attempt.result.checks.find(item => item.name === name);
const report = attempt => JSON.parse(fs.readFileSync(path.join(attempt.outputFolder, 'check-report.json'), 'utf8'));

test('a failure only in a test outside the story that failed on another story is the environment, and is not counted', async t => {
  const c = await studio(t),
    { store } = c.app;
  // (2) The first story to see the test fail has no earlier record elsewhere: the work's, and counted.
  const first = c.taskId,
    seen = await c.run(first, 'flaky');
  assert.equal(seen.status, 'review', seen.error);
  assert.deepEqual(seen.endCause, work);
  assert.deepEqual(seen.failedTests, [
    { name: 'settles at random', file: 'bounded.test.mjs', error: 'fixture failure' },
  ]);
  assert.equal(c.counted(first), 1);
  assert.equal(check(seen, 'Candidate Node test suite').evidence.includes(plainWords), false);

  // (1) Another story of the project, which does not list that test file, fails on the same test only.
  const second = await c.propose('second'),
    again = await c.run(second, 'flaky');
  assert.deepEqual(again.endCause, random, again.error);
  assert.equal(c.counted(second), 0);
  assert.equal(store.attempts(second).length, 1);
  // Still a negative candidate with its failing check report, on the same way to review.
  assert.equal(again.status, 'review');
  assert.equal(report(again).passed, false);
  assert.match(again.result.summary, /^Negative isolated source candidate: 1\/2 tests passed\./);
  const suite = check(again, 'Candidate Node test suite');
  assert.equal(suite.status, 'fail');
  assert.ok(suite.evidence.endsWith(`; ${plainWords} (settles at random, in bounded.test.mjs)`), suite.evidence);
  assert.ok(again.result.handoff.startsWith(`Ended by the environment: ${plainWords}. Accept this candidate`));
  assert.equal(causeText(again), plainWords);
  const history = buildAttemptHistory(store, store.task(second), { now: 'fixed' });
  assert.equal(history.projection.find(item => item.attemptId === again.id).endedBy, plainWords);
  // The earlier story's count is its own.
  assert.equal(c.counted(first), 1);

  // (4) A known random failure beside a new one: the work's.
  const mixed = await c.propose('mixed'),
    both = await c.run(mixed, 'flaky', 'fresh');
  assert.deepEqual(
    both.failedTests.map(item => item.name),
    ['settles at random', 'fails for the first time'],
  );
  assert.deepEqual(both.endCause, work);
  assert.equal(c.counted(mixed), 1);

  // (3) A story whose own files include the test's file: the work's, though the test failed elsewhere before.
  const own = await c.propose('own', { files: ['src/core/workflows.mjs', 'test/bounded.test.mjs'] }),
    mine = await c.run(own, 'flaky');
  assert.deepEqual(
    mine.failedTests.map(item => item.file),
    ['bounded.test.mjs'],
  );
  assert.deepEqual(mine.endCause, work);
  assert.equal(c.counted(own), 1);
  assert.equal(check(mine, 'Candidate Node test suite').evidence.includes(plainWords), false);
});

test('a failed build keeps the cause the work, even when the only failed test is a known random one', async t => {
  const c = await studio(t);
  // The build fails when the story changed src/core/projects.mjs, as the fixture editor does to a story's first file.
  fs.writeFileSync(
    path.join(c.root, 'scripts/build.mjs'),
    "import fs from 'node:fs';\nif (fs.readFileSync('src/core/projects.mjs', 'utf8').includes('Bounded fixture improvement')) {\n  console.error('The fixture build fails.');\n  process.exit(2);\n}\n",
  );
  git(c.root, ['add', 'scripts/build.mjs']);
  git(c.root, ['commit', '--quiet', '-m', 'A build script']);
  const profile = { ...studioDeskProfile, id: 'fixture-build', install: null, build: ['node', 'scripts/build.mjs'] };
  const earlier = await c.propose('earlier', { profile }),
    seen = await c.run(earlier, 'flaky');
  assert.equal(check(seen, 'Candidate build').status, 'pass', seen.error);
  assert.deepEqual(seen.endCause, work);
  // (5) The build failed: the work's and counted, whatever the tests did.
  const broken = await c.propose('broken', { profile, files: ['src/core/projects.mjs'] }),
    failed = await c.run(broken, 'flaky');
  assert.equal(check(failed, 'Candidate build').status, 'fail', failed.error);
  assert.deepEqual(
    failed.failedTests.map(item => item.name),
    ['settles at random'],
  );
  assert.deepEqual(failed.endCause, work);
  assert.equal(c.counted(broken), 1);
  // The same failure with a passing build is the environment's, so the build decided.
  const passing = await c.propose('passing', { profile }),
    known = await c.run(passing, 'flaky');
  assert.equal(check(known, 'Candidate build').status, 'pass', known.error);
  assert.deepEqual(known.endCause, random);
  assert.equal(c.counted(passing), 0);
});

test('the rule reads earlier failures only from other stories of the same project, outside their files', () => {
  const flaky = { name: 'settles at random', file: 'bounded.test.mjs' },
    story = (id, taskId, files, fields = {}) => ({
      id,
      taskId,
      projectId: 'project-a',
      status: 'review',
      sourceChange: { allowedFiles: files, newFiles: [], deleteFiles: [] },
      failedTests: [flaky],
      ...fields,
    }),
    attempt = story('attempt-now', 'T-now', ['src/core/workflows.mjs'], { failedTests: [] }),
    decide = (records, options = {}) =>
      randomTestFailures({ attemptsNaming: () => records }, attempt, {
        failed: [flaky],
        totals: { tests: 2, pass: 1, fail: 1 },
        ...options,
      });
  assert.deepEqual(decide([story('attempt-other', 'T-other', ['src/core/projects.mjs'])]), [flaky]);
  // The same story's own earlier attempt, another project's story, an attempt that is not a story's, or a story that
  // listed the test's file is no evidence.
  assert.equal(decide([story('attempt-before', 'T-now', ['src/core/workflows.mjs'])]), null);
  assert.equal(decide([story('attempt-other', 'T-other', ['src/a.mjs'], { projectId: 'project-b' })]), null);
  assert.equal(decide([{ ...story('attempt-check', 'T-check', []), sourceChange: undefined }]), null);
  assert.equal(decide([story('attempt-other', 'T-other', ['test/bounded.test.mjs'])]), null);
  assert.equal(
    decide([story('attempt-other', 'T-other', ['src/a.mjs'], { failedTests: [{ ...flaky, name: 'another test' }] })]),
    null,
  );
  // No named failure, a failure with no file, too many failures to name, a skipped or todo test, a failed build or a
  // stopped run keeps it the work's.
  const elsewhere = [story('attempt-other', 'T-other', ['src/core/projects.mjs'])];
  assert.equal(decide(elsewhere, { failed: [] }), null);
  assert.equal(decide(elsewhere, { failed: [{ name: flaky.name, file: '' }] }), null);
  assert.equal(decide(elsewhere, { failed: Array(20).fill(flaky) }), null);
  assert.equal(decide(elsewhere, { totals: { tests: 3, pass: 1, fail: 1, skipped: 1 } }), null);
  assert.equal(decide(elsewhere, { totals: { tests: 3, pass: 1, fail: 1, todo: 1 } }), null);
  assert.equal(decide(elsewhere, { buildFailed: true }), null);
  assert.equal(decide(elsewhere, { signal: 'SIGTERM' }), null);
  // A story's new and deleted files are its own too.
  attempt.sourceChange = { allowedFiles: [], newFiles: ['test/bounded.test.mjs'], deleteFiles: [] };
  assert.equal(decide(elsewhere), null);
  attempt.sourceChange = { allowedFiles: ['src/x.mjs'], newFiles: [], deleteFiles: ['test/bounded.test.mjs'] };
  assert.equal(decide(elsewhere), null);
  // The cause is a known one, named in plain words.
  assert.deepEqual(endCause('environment', 'random-test'), random);
  assert.equal(causeText({ endCause: random }), plainWords);
});
