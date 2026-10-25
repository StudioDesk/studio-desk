// The fixed source test command (src/connectors/source-checks.mjs) that intake checks, candidates
// and integration verification run. Model-free: Node's test runner on a disposable folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
// Reuse the candidate-local temp policy: MXC's redirected OS temp denies Git writes.
import { fixtureNpm } from './model-free-studio.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { sourceChecksAdapter } from '../src/adapters/source-checks.mjs';
import { Store } from '../src/core/store.mjs';
import { Runner } from '../src/core/orchestrator.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import {
  checkReport,
  ensureSourceDirectories,
  failedTests,
  sourcePaths,
  sourcePlan,
  sourceTestArgs,
  sourceTestTimeoutMs,
  testTotals,
  testPhaseEvidence,
  validateCheckReport,
} from '../src/connectors/source-checks.mjs';

test('a hung test or a file that never exits ends the measured suite with a report (MP-016 slice 4b)', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-timeout-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  ensureSourceDirectories(directory);
  for (const file of studioDeskProfile.files)
    fs.writeFileSync(path.join(directory, file), file === 'package.json' ? '{}' : 'Fixture source\n');
  // As T-96187ec6's first candidate did on October 19: one file stops producing output while the
  // others finish. Here one test never settles, and another file's process never exits by itself.
  fs.writeFileSync(
    path.join(directory, 'test/hang.test.mjs'),
    "import test from 'node:test';\ntest('quick', () => {});\ntest('never settles', async () => {\n  setInterval(() => {}, 1000);\n  await new Promise(() => {});\n});\ntest('after the hang', () => {});\n",
  );
  fs.writeFileSync(
    path.join(directory, 'test/open.test.mjs'),
    "import test from 'node:test';\nsetInterval(() => {}, 1000);\ntest('passes but leaves a timer running', () => {});\n",
  );
  // Every measured run bounds each test and exits once every test has finished.
  const plan = sourcePlan(directory);
  assert.deepEqual(plan.command.args, [
    '--test',
    '--test-reporter=tap',
    `--test-timeout=${sourceTestTimeoutMs}`,
    '--test-force-exit',
    'test/hang.test.mjs',
    'test/open.test.mjs',
  ]);
  assert.deepEqual(plan.command.args, sourceTestArgs(['test/hang.test.mjs', 'test/open.test.mjs']));
  // The same command with a one-second limit, so the test stays fast. The nested runner must not
  // report to this one.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const started = Date.now(),
    run = spawnSync(process.execPath, sourceTestArgs(['test/hang.test.mjs', 'test/open.test.mjs'], 1000), {
      cwd: directory,
      env: environment,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
  assert.equal(run.error, undefined, 'The suite exits by itself.');
  assert.ok(Date.now() - started < 30000, `The suite took ${Date.now() - started} ms.`);
  assert.notEqual(run.status, 0);
  assert.deepEqual(testTotals(run.stdout), { tests: 4, pass: 3, fail: 0, cancelled: 1, skipped: 0, todo: 0 });
  const store = new Store(path.join(directory, 'events'), () => ({ organization: {}, tasks: [] }));
  try {
    const a = { id: 'cancelled-tap', taskId: 'T-cancelled' },
      phase = store.startPhase(a, 'test');
    store.finishPhase(phase, 'failed', testPhaseEvidence(run.stdout));
    const finished = store.phaseEvents(a.id).at(-1).payload;
    assert.equal(finished.totals.cancelled, 1);
    assert.equal(finished.totals.pass, 3);
    assert.equal(finished.totals.fail, 0);
    assert.ok(finished.elapsedMs >= 0);
    assert.ok(finished.tapDurationMs >= 0);
    assert.equal(finished.outcome, 'failed');
  } finally {
    store.close();
  }
  // The run story and an automatic retry name the test and its timeout.
  assert.deepEqual(failedTests(run.stdout), [
    { name: 'never settles', file: 'hang.test.mjs', error: 'test timed out after 1000ms' },
  ]);
  const execution = { exitCode: run.status, signal: run.signal },
    report = checkReport(plan, execution, run.stdout, run.stderr),
    legacy = { ...report };
  assert.equal(report.passed, false);
  assert.deepEqual(report.failedTests, failedTests(run.stdout));
  assert.deepEqual(validateCheckReport(report, plan, execution, run.stdout, run.stderr), report);
  delete legacy.failedTests;
  assert.deepEqual(validateCheckReport(legacy, plan, execution, run.stdout, run.stderr), legacy);
  assert.throws(
    () =>
      validateCheckReport(
        { ...report, failedTests: [{ name: 'Invented failure' }] },
        plan,
        execution,
        run.stdout,
        run.stderr,
      ),
    /does not match/,
  );
});

// Exercise the adapter's actual fixed Node command on a tiny committed repository.
// The process supervisor is represented by a local harness, with no models or HTTP.
function measuredConsumer(t, mode, partial) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-check-'))),
    root = path.join(directory, 'r'),
    job = path.join(directory, 'job'),
    output = path.join(job, 'output');
  t.after(() => {
    phaseStore.close();
    assert.ok(path.resolve(directory).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  ensureSourceDirectories(root);
  for (const file of sourcePaths)
    if (!fs.existsSync(path.join(root, file)))
      fs.writeFileSync(path.join(root, file), file === 'package.json' ? '{}' : 'Fixture source\n');
  fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
  for (const file of ['src/core/projects.mjs', 'src/core/workflows.mjs', 'docs/module-contracts.md'])
    fs.writeFileSync(path.join(root, file), '// Fixture source\n');
  const body =
    mode === 'fail'
      ? "throw new Error('Fixture failure');"
      : mode === 'mutate'
        ? "fs.writeFileSync('README.md', 'Changed by test');"
        : '';
  fs.writeFileSync(
    path.join(root, 'test/measured.test.mjs'),
    `import test from 'node:test';\nimport fs from 'node:fs';\ntest('measured fixture', () => { ${body} });\n`,
  );
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Measured fixture']);
  const original = sourcePlan(root),
    base = { commit: git(root, ['rev-parse', 'HEAD']), branch: 'main' },
    attempt = { id: 'attempt-12345678', taskId: 'T-check-consumer', pid: 123, sourceCheck: { ...original, base } },
    entry = { attempt, job, output };
  fs.mkdirSync(output, { recursive: true });
  let invocation, recorded, installed;
  const phaseStore = new Store(path.join(directory, 'events'), () => ({ organization: {}, tasks: [] }));
  const runtime = {
    startPhase: Runner.prototype.startPhase,
    sourceWorktreeRoot: path.join(directory, 'wt'),
    packageInstallCommand: fixtureNpm,
    store: {
      // Check copies live under the data folder, as in a real controller (MP-026).
      directory,
      startPhase: phaseStore.startPhase.bind(phaseStore),
      finishPhase: phaseStore.finishPhase.bind(phaseStore),
      updateAttempt: a => {
        recorded = structuredClone(a);
      },
    },
    runNative(entry, executable, args, input, complete, options) {
      entry.child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
      // The install step (MP-026) runs for real with the stand-in for npm; then the tests start.
      if (options.onComplete) {
        installed = spawnSync(executable, args, {
          cwd: options.cwd,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
        });
        return options.onComplete(null, installed.status);
      }
      invocation = { executable, args, input, complete, options };
    },
  };
  sourceChecksAdapter.start(runtime, entry);
  assert.deepEqual(recorded.sourceCheck, { ...original, base });
  assert.equal(installed?.status, 0, installed?.stderr);
  assert.equal(
    fs.existsSync(path.join(job, 'source', 'node_modules')),
    false,
    'The copy holds no packages of its own.',
  );
  assert.ok(fs.existsSync(path.join(directory, 'node_modules', 'fixture-tool')), 'It finds the install above it.');
  assert.equal(invocation.executable, original.command.executable);
  assert.deepEqual(invocation.args, original.command.args);
  assert.equal(invocation.input, '');
  assert.equal(invocation.options.cwd, path.join(job, 'source'));
  assert.equal(invocation.options.resultOnFailure, true);
  assert.equal(
    Object.keys(invocation.options.environment).some(key => /^STUDIO_/i.test(key)),
    false,
  );
  assert.deepEqual(fs.readdirSync(runtime.sourceWorktreeRoot), [], 'The worktree is gone before tests start.');
  const environment = { ...invocation.options.environment };
  delete environment.NODE_TEST_CONTEXT;
  const run = spawnSync(invocation.executable, invocation.args, {
    cwd: invocation.options.cwd,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(run.error, undefined);
  entry.child.stdout.emit('data', partial ?? run.stdout);
  entry.child.stderr.emit('data', run.stderr);
  return {
    original,
    base,
    attempt,
    output,
    run,
    phaseStore,
    runtime,
    entry,
    finish: () => invocation.complete(run.status, run.signal),
  };
}

for (const mode of ['pass', 'fail'])
  test(`the checks adapter retains measured ${mode} reports when using the shared snapshot helper`, t => {
    const c = measuredConsumer(t, mode),
      result = c.finish(),
      report = JSON.parse(fs.readFileSync(path.join(c.output, 'check-report.json'), 'utf8')),
      context = JSON.parse(fs.readFileSync(path.join(c.output, 'source-context.json'), 'utf8'));
    assert.equal(result.outcome, 'completed');
    assert.equal(result.taskId, c.attempt.taskId);
    assert.equal(result.checks[0].status, mode);
    assert.match(result.summary, /^Measured source checks:/);
    assert.equal(report.schemaVersion, 'source-check-report-v1');
    assert.equal(report.execution.fixture, false);
    assert.equal(report.execution.taskId, c.attempt.taskId);
    assert.equal(report.execution.attemptId, c.attempt.id);
    assert.deepEqual(report.source, {
      root: c.original.root,
      commit: c.base.commit,
      hash: c.original.sourceHash,
      files: c.original.files,
    });
    assert.deepEqual(report.command, c.original.command);
    assert.deepEqual(report.totals, {
      tests: 1,
      pass: mode === 'pass' ? 1 : 0,
      fail: mode === 'fail' ? 1 : 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    });
    assert.equal(report.passed, mode === 'pass');
    assert.deepEqual(
      report.failedTests,
      mode === 'fail' ? [{ name: 'measured fixture', file: 'measured.test.mjs', error: 'Fixture failure' }] : [],
    );
    const all = c.phaseStore.phaseEvents(c.attempt.id).map(event => event.payload);
    // The copy gets its installed packages first, as its own phase (MP-026).
    assert.deepEqual(
      all.slice(0, 2).map(phase => [phase.phaseId, phase.boundary, phase.outcome]),
      [
        ['install', 'start', null],
        ['install', 'finish', 'succeeded'],
      ],
    );
    const phases = all.filter(phase => phase.phaseId === 'test');
    assert.equal(phases.length, 2);
    assert.equal(phases[1].occurrenceId, phases[0].occurrenceId);
    assert.equal(phases[1].outcome, mode === 'pass' ? 'succeeded' : 'failed');
    assert.deepEqual(phases[1].totals, report.totals);
    assert.ok(phases[1].durationMs >= 0);
    assert.deepEqual(report, checkReport(c.attempt.sourceCheck, c.attempt.checkExecution, c.run.stdout, c.run.stderr));
    assert.deepEqual(
      validateCheckReport(report, c.attempt.sourceCheck, c.attempt.checkExecution, c.run.stdout, c.run.stderr),
      report,
    );
    const legacy = { ...report };
    delete legacy.failedTests;
    assert.deepEqual(
      validateCheckReport(legacy, c.attempt.sourceCheck, c.attempt.checkExecution, c.run.stdout, c.run.stderr),
      legacy,
    );
    assert.throws(
      () =>
        validateCheckReport(
          { ...report, failedTests: [{ name: 'Invented failure' }] },
          c.attempt.sourceCheck,
          c.attempt.checkExecution,
          c.run.stdout,
          c.run.stderr,
        ),
      /does not match/,
    );
    assert.equal(context.schemaVersion, 'source-context-v1');
    assert.equal(context.sourceHash, report.source.hash);
    assert.equal(context.documents.length, 5);
    assert.equal(fs.readFileSync(path.join(c.output, 'test-output.txt'), 'utf8'), c.run.stdout);
    assert.equal(fs.readFileSync(path.join(c.output, 'test-errors.txt'), 'utf8'), c.run.stderr);
    assert.deepEqual(
      result.artifacts.map(item => item.kind),
      ['source-check-report', 'test-log', 'test-log', 'source-context'],
    );
  });

test('the checks adapter still rejects source modified by the measured tests', t => {
  const c = measuredConsumer(t, 'mutate');
  assert.equal(c.run.status, 0);
  assert.throws(c.finish, /A source test changed the copied source/);
  assert.equal(fs.existsSync(path.join(c.output, 'check-report.json')), false);
});

test('partial TAP retains only bounded top-level failures and never invents totals', () => {
  const log = [
    'TAP version 13',
    '    not ok 1 - nested detail',
    'not ok 1 - timed out',
    '  ---',
    "  location: 'C:\\repo\\test\\timeout.test.mjs:8:1'",
    "  failureType: 'testTimeoutFailure'",
    "  error: 'test timed out after 1000ms'",
    '  ...',
  ].join('\n');
  assert.deepEqual(testPhaseEvidence(log), {
    totals: null,
    tapDurationMs: null,
    failedTests: [{ name: 'timed out', file: 'timeout.test.mjs', error: 'test timed out after 1000ms' }],
  });
  assert.equal(testPhaseEvidence('Editing files; tests failed in arbitrary log text').failedTests.length, 0);
  assert.equal(
    failedTests(Array.from({ length: 30 }, (_, i) => `not ok ${i + 1} - ${'x'.repeat(500)}`).join('\n')).length,
    20,
  );
  assert.equal(failedTests('not ok 1 - ' + 'x'.repeat(500))[0].name.length, 300);
});

test('a source-check timeout snapshots partial TAP before an unconfirmed stop', t => {
  const log =
      "TAP version 13\nnot ok 1 - cancelled check\n  ---\n  location: 'test/check.test.mjs:2:1'\n  error: 'cancelled by parent'\n  ...\n",
    c = measuredConsumer(t, 'pass', log);
  c.entry.timedOut = true;
  c.entry.adapter = { stop() {} }; // The process has not confirmed termination.
  c.runtime.active = new Map([[c.attempt.id, c.entry]]);
  Runner.prototype.stop.call(c.runtime, c.attempt.id);
  assert.equal(c.attempt.stopContext.activity, 'test');
  assert.equal(c.attempt.stopContext.phaseFinished, false);
  const testPhases = () =>
    c.phaseStore
      .phaseEvents(c.attempt.id)
      .map(event => event.payload)
      .filter(phase => phase.phaseId === 'test');
  assert.equal(c.attempt.stopContext.occurrenceId, testPhases()[0].occurrenceId);
  assert.equal(c.attempt.stopContext.testEvidence.totals, null);
  assert.deepEqual(c.attempt.failedTests, [
    { name: 'cancelled check', file: 'check.test.mjs', error: 'cancelled by parent' },
  ]);
  assert.equal(fs.readFileSync(path.join(c.output, 'test-output.txt'), 'utf8'), log);
  assert.equal(testPhases().length, 1, 'A stop request cannot complete a phase.');
});
