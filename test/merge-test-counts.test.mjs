// A merge's test count (1.2.0, "Verification you can trust"): a merge whose test run reports no tests fails when the
// merged source holds test files, and a story's merge fails when it reports fewer tests than the newest integrated
// story on its line passed with, lowered to the change's own measured count. Model-free: the editor, review, formatter
// and test runs are process fixtures, on a disposable repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import { git, tooFewTests } from '../src/connectors/source-integration.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';

const tests = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  // The check fixture reporting this many passing tests.
  counting = tests_ => ({ executable: process.execPath, args: [tests, 'count', String(tests_)] }),
  suiteCheck = journal => journal.verification.checks.find(check => check.name === 'Integration Node test suite');

// A story on main, edited and tested while the check fixture reports candidateTests, reviewed, then integrated at the
// director's word while it reports mergeTests. Returns its story's ID and its settled journal.
async function land(c, name, files, candidateTests, mergeTests) {
  const runner = c.app.runner;
  c.taskId = await c.propose(name, { files });
  runner.sourceCheckCommand = counting(candidateTests);
  await c.start();
  const edit = await c.wait(c.taskId),
    review = await c.review(edit);
  await c.accept(review.taskId);
  runner.sourceCheckCommand = counting(mergeTests);
  const head = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal((await c.integration(review)).status, 200);
  return { storyId: c.taskId, head, journal: await c.settled(review) };
}

test('a merge whose test run reports no tests is rejected when its source has test files', async t => {
  const c = await setup(t),
    runner = c.app.runner;
  await c.start();
  const edit = await c.wait(c.taskId),
    review = await c.review(edit);
  await c.accept(review.taskId);
  const head = git(c.root, ['rev-parse', 'HEAD']);
  runner.sourceCheckCommand = counting(0);
  assert.equal((await c.integration(review)).status, 200);
  const journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head, "The development copy's head is unchanged.");
  assert.equal(
    journal.error,
    'The test run on the merged change reported no tests, though its source has 1 test file.',
  );
  assert.equal(journal.testFloor, undefined, 'No story was integrated on the line before it.');
  assert.equal(journal.verification.passed, false);
  assert.deepEqual(journal.verification.totals, { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(journal.verification.landedSince, undefined);
  assert.equal(suiteCheck(journal).status, 'fail');
  assert.match(suiteCheck(journal).evidence, /reported no tests, though its source has 1 test file\.$/);
});

test("a story's merge is rejected when it reports fewer tests than the line last passed with", async t => {
  const c = await setup(t),
    first = await land(c, 'first', ['src/core/workflows.mjs'], 1, 3);
  assert.equal(first.journal.state, 'integrated', JSON.stringify(first.journal.error));
  assert.equal(first.journal.testFloor, undefined, 'The first story on the line has no floor.');
  const second = await land(c, 'second', ['src/core/projects.mjs'], 3, 2);
  assert.equal(second.journal.state, 'rejected');
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), second.head, "The development copy's head is unchanged.");
  assert.deepEqual(second.journal.testFloor, {
    tests: 3,
    lineTests: 3,
    candidateTests: 3,
    taskId: first.storyId,
    integrationId: first.journal.id,
  });
  assert.equal(
    second.journal.error,
    `The test run on the merged change reported 2 tests, fewer than the 3 that main passed with when ${first.storyId} merged onto it.`,
  );
  assert.equal(second.journal.verification.landedSince, undefined, 'Too few tests is not a failure with what landed.');
  assert.equal(suiteCheck(second.journal).status, 'fail');
  assert.match(suiteCheck(second.journal).evidence, /"tests":2,.*reported 2 tests, fewer than the 3 /);
});

test("a story's merge that reports what its own run did passes when the change removed tests", async t => {
  const c = await setup(t),
    first = await land(c, 'first', ['src/core/workflows.mjs'], 1, 3);
  assert.equal(first.journal.state, 'integrated', JSON.stringify(first.journal.error));
  // The change's own recorded run reported 2 tests: it removed one, so the floor drops to 2.
  const second = await land(c, 'second', ['src/core/projects.mjs'], 2, 2);
  assert.equal(second.journal.state, 'integrated', JSON.stringify(second.journal.error));
  assert.deepEqual(second.journal.testFloor, {
    tests: 2,
    lineTests: 3,
    candidateTests: 2,
    taskId: first.storyId,
    integrationId: first.journal.id,
  });
  assert.notEqual(git(c.root, ['rev-parse', 'HEAD']), second.head);
});

test('too few tests reads in plain words, and a repository with no test files still merges a run of none', () => {
  const withTests = { files: [{ path: 'test/a.test.mjs' }, { path: 'test/b.test.mjs' }, { path: 'src/a.mjs' }] },
    without = { files: [{ path: 'src/a.mjs' }, { path: 'test/helper.mjs' }] },
    totals = tests_ => ({ tests: tests_, pass: tests_, fail: 0, cancelled: 0, skipped: 0, todo: 0 }),
    story = testFloor => ({ repository: { branch: 'main' }, ...(testFloor ? { testFloor } : {}) });
  assert.equal(
    tooFewTests(totals(0), withTests, studioDeskProfile, story()),
    'The test run on the merged change reported no tests, though its source has 2 test files.',
  );
  assert.equal(tooFewTests(totals(0), without, studioDeskProfile, story()), null);
  assert.equal(tooFewTests(totals(1), withTests, studioDeskProfile, story()), null);
  const floor = { tests: 1156, lineTests: 1156, candidateTests: 1160, taskId: 'T-abc123' };
  assert.equal(
    tooFewTests(totals(1100), withTests, studioDeskProfile, story(floor)),
    'The test run on the merged change reported 1,100 tests, fewer than the 1,156 that main passed with when T-abc123 merged onto it.',
  );
  assert.equal(tooFewTests(totals(1156), withTests, studioDeskProfile, story(floor)), null);
  assert.equal(
    tooFewTests(totals(1), withTests, studioDeskProfile, story({ ...floor, tests: 2, candidateTests: 2 })),
    'The test run on the merged change reported 1 test, fewer than the 2 its own test run reported (1,156 main passed with when T-abc123 merged onto it).',
  );
  // A carry or a release records no floor, and keeps only the no-tests rule.
  assert.equal(tooFewTests(totals(5), withTests, studioDeskProfile, { repository: { branch: 'main' } }), null);
});
