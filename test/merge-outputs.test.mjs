// What a merge's steps printed (1.2.0, "Verification you can trust"): every verification keeps the last 4,000
// characters of what its install, formatter, build and test run (its error output) printed, each only when the step
// ran and printed something, and a test run that reports no totals says why in the reason. The dashboard's attempt
// summary carries the outputs to the story's record. Model-free: the editor, review, formatter, install and test runs
// are process fixtures, on a disposable repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import { git, outputLimit } from '../src/connectors/source-integration.mjs';
import { dashboardAttempt } from '../src/core/dashboard-state.mjs';

const tests = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  formatter = fileURLToPath(new URL('./fixture-format.mjs', import.meta.url)),
  checking = mode => ({ executable: process.execPath, args: [tests, mode] });

// The story edited, tested and reviewed while the check fixture passes, then integrated at the director's word with
// the runner's commands as `before` leaves them. Returns the settled journal and the development copy's head before.
async function merge(t, before = () => {}) {
  const c = await setup(t),
    runner = c.app.runner;
  await c.start();
  const edit = await c.wait(c.taskId),
    review = await c.review(edit);
  await c.accept(review.taskId);
  const head = git(c.root, ['rev-parse', 'HEAD']);
  before(runner);
  assert.equal((await c.integration(review)).status, 200);
  const journal = await c.settled(review);
  for (const [name, text] of Object.entries(journal.verification.outputs || {}))
    assert.ok(text.length <= outputLimit, `outputs.${name} holds ${text.length} characters.`);
  return { c, review, head, journal };
}

test("a test run that reports no totals is rejected with its error output's last line, kept with the merge", async t => {
  const { c, review, head, journal } = await merge(t, runner => {
    runner.sourceCheckCommand = checking('missing-module');
  });
  assert.equal(journal.state, 'rejected');
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head, "The development copy's head is unchanged.");
  assert.match(journal.error, /did not report complete totals/);
  assert.match(journal.error, /Cannot find module fixture-missing/);
  assert.equal(
    journal.verification.error,
    'The test run did not report complete totals. Its error output ends: Error: Cannot find module fixture-missing',
  );
  assert.equal(journal.verification.totals, null);
  assert.match(journal.verification.outputs.errors, /^Error: Cannot find module fixture-missing\s*$/);
  // The install and formatter ran before the tests and printed what they did.
  assert.ok(journal.verification.outputs.install);
  // The dashboard's summary of the review attempt carries it to the story's record.
  const summary = dashboardAttempt(c.app.store.attempt(review.id));
  assert.equal(summary.sourceIntegration.state, 'rejected');
  assert.match(summary.sourceIntegration.verification.outputs.errors, /Cannot find module fixture-missing/);
  assert.match(summary.sourceIntegration.verification.error, /Its error output ends: Error: Cannot find module/);
});

test('a failing formatter records what it printed', async t => {
  const { journal } = await merge(t, runner => {
    runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'fail'] };
  });
  assert.equal(journal.state, 'rejected');
  assert.match(journal.error, /^The formatter did not complete: Fixture formatter failure\./);
  assert.match(journal.verification.outputs.format, /Fixture formatter failure\./);
  // The steps after the formatter never ran.
  assert.equal(journal.verification.outputs.install, undefined);
  assert.equal(journal.verification.outputs.errors, undefined);
});

test('a passing merge records what its package install printed, and nothing for steps that printed nothing', async t => {
  const { c, review, head, journal } = await merge(t);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal.error));
  assert.notEqual(git(c.root, ['rev-parse', 'HEAD']), head);
  assert.equal(journal.verification.passed, true);
  assert.match(journal.verification.outputs.install, /packages/);
  // The passing fixture writes nothing to its error output, and the formatter fixture prints nothing.
  assert.equal(journal.verification.outputs.errors, undefined);
  assert.equal(journal.verification.outputs.format, undefined);
  assert.equal(journal.verification.error, undefined);
  const summary = dashboardAttempt(c.app.store.attempt(review.id));
  assert.equal(summary.sourceIntegration.verification.outputs.install, journal.verification.outputs.install);
});

test('a merge keeps only the last 4,000 characters of a long output', async t => {
  const { journal } = await merge(t, runner => {
    runner.sourceCheckCommand = checking('long-errors');
  });
  assert.equal(journal.state, 'rejected');
  assert.equal(journal.verification.outputs.errors.length, outputLimit);
  assert.match(journal.verification.outputs.errors, /Error: the end of a long error output\n$/);
  assert.match(journal.error, /Its error output ends: Error: the end of a long error output$/);
});
