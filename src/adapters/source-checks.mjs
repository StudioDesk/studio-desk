import fs from 'node:fs';
import path from 'node:path';
import {
  sourceChecksConnector,
  verifyCopy,
  sourceContext,
  checkReport,
  failedTests,
  testPhaseEvidence,
  testsSentence,
} from '../connectors/source-checks.mjs';
import { sourceWorktreeRoot, worktreeName } from '../connectors/source-worktrees.mjs';
import { installsPackages, profileOf } from '../connectors/source-profile.mjs';
import { runInstallStep } from '../connectors/package-installs.mjs';
import { snapshotCommit } from './source-snapshot.mjs';
import { subscriptionEnvironment } from './process.mjs';
import { chosenTestSandbox } from './source-test-sandbox.mjs';
import { builtInSandboxCommand, builtInSandboxReady } from './built-in-sandbox.mjs';

// An idea's first checks run in the built-in sandbox when candidate tests do (1.0.1), so the pipeline
// tests in one place; without a sandbox, by the director's choice, they run on the copy as before.
const checksSandbox = runtime => chosenTestSandbox(runtime.store.organization()) === 'built-in';

export const sourceChecksAdapter = {
  id: 'source-checks',
  version: 'source-checks-adapter-v1',
  name: 'Local source checks',
  workerSelectable: false,
  capabilities: ['source-checks'],
  initialize(runtime, options) {
    runtime.sourceCheckCommand = options.sourceCheckCommand; // trusted model-free test seam, never exposed by HTTP
    runtime.packageInstallCommand = options.packageInstallCommand; // trusted model-free stand-in for npm ci, never exposed by HTTP
  },
  status: () => ({ available: true, label: 'Node tests on an allowlisted copy of the current commit; no model calls' }),
  blockReason: (runtime, verifyAuth, task) =>
    !runtime.workflows.get(task.kind).requiredCapabilities.includes('source-checks')
      ? 'A registered source-check assignment is required.'
      : checksSandbox(runtime) && !builtInSandboxReady(runtime)
        ? "An idea's checks run in the built-in sandbox, and it isn't set up on this computer. Set it up under Settings → Candidate tests, or choose No sandbox there."
        : '',
  configuration: (runtime, worker) => ({
    ...structuredClone(worker),
    // Recorded only when the checks run in the built-in sandbox; earlier checks ran without one.
    ...(checksSandbox(runtime) ? { testSandbox: 'built-in' } : {}),
    executionAdapter: 'source-checks',
    connector: sourceChecksConnector,
  }),
  requestedModel: () => 'No model',
  delivery: 'The controller copies the current commit and records the test process, logs and totals.',
  deliveryScope:
    'Only the controller runs the fixed Node test command on copied source. Assignments cannot select shell commands, source paths or external tools.',
  start(runtime, entry) {
    const a = entry.attempt,
      snapshot = path.join(entry.job, 'source');
    // Measure the recorded commit in its own worktree (MP-016 slice 4), which is removed again
    // before the tests start; the copy is what the tests run on. The project's source profile
    // was recorded with the commit when the attempt was prepared.
    a.sourceCheck = snapshotCommit(
      a.sourceCheck.root,
      sourceWorktreeRoot(runtime),
      'c-' + worktreeName(a.id),
      a.sourceCheck.base,
      snapshot,
      undefined,
      profileOf(a.sourceCheck),
    );
    runtime.store.updateAttempt(a);
    const sandboxed = a.configuration?.testSandbox === 'built-in',
      command =
        runtime.sourceCheckCommand ||
        (sandboxed ? builtInSandboxCommand({ root: snapshot, command: a.sourceCheck.command }) : a.sourceCheck.command);
    const environment = subscriptionEnvironment();
    // Snapshot tests must not inherit live provider/engine overrides.
    for (const key of Object.keys(environment)) if (/^STUDIO_/i.test(key)) delete environment[key];
    // In a sandbox the copied harness runs as candidate tests do; only it reads this marker.
    if (sandboxed) environment.STUDIO_MODEL_FREE_LEAF_FIXTURES = '1';
    // The copy gets its installed packages first (MP-026), then the tests run on it.
    runInstallStep(runtime, entry, snapshot, installsPackages(profileOf(a.sourceCheck)), environment, () =>
      runTests(runtime, entry, a, command, snapshot, environment),
    );
  },
};

function runTests(runtime, entry, a, command, snapshot, environment) {
  const startedAt = new Date().toISOString();
  let stdout = '',
    stderr = '';
  const testPhase = runtime.startPhase(entry, 'test', () => {
    a.testEvidence = testPhaseEvidence(stdout);
    a.failedTests = a.testEvidence.failedTests;
    fs.writeFileSync(path.join(entry.output, 'test-output.txt'), stdout);
    fs.writeFileSync(path.join(entry.output, 'test-errors.txt'), stderr);
    return a.testEvidence;
  });
  runtime.runNative(
    entry,
    command.executable,
    command.args,
    '',
    (exitCode, signal) => {
      verifyCopy(a.sourceCheck, snapshot);
      if (Buffer.byteLength(stdout + stderr) > 192 * 1024) throw new Error('Source test evidence exceeds 192 KB.');
      a.checkExecution = {
        taskId: a.taskId,
        attemptId: a.id,
        pid: a.pid,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        signal,
        fixture: !!runtime.sourceCheckCommand,
      };
      const report = checkReport(a.sourceCheck, a.checkExecution, stdout, stderr);
      runtime.store.finishPhase(testPhase, report.passed ? 'succeeded' : 'failed', testPhaseEvidence(stdout));
      a.failedTests = failedTests(stdout);
      fs.writeFileSync(path.join(entry.output, 'test-output.txt'), stdout);
      fs.writeFileSync(path.join(entry.output, 'test-errors.txt'), stderr);
      fs.writeFileSync(
        path.join(entry.output, 'source-context.json'),
        JSON.stringify(sourceContext(a.sourceCheck, snapshot), null, 2),
      );
      fs.writeFileSync(path.join(entry.output, 'check-report.json'), JSON.stringify(report, null, 2));
      return {
        taskId: a.taskId,
        outcome: 'completed',
        summary: `${a.checkExecution.fixture ? 'Protocol fixture' : 'Measured source checks'}: ${testsSentence(report.totals)}.`,
        artifacts: [
          { path: 'check-report.json', kind: 'source-check-report' },
          { path: 'test-output.txt', kind: 'test-log' },
          { path: 'test-errors.txt', kind: 'test-log' },
          { path: 'source-context.json', kind: 'source-context' },
        ],
        checks: [
          {
            name: 'Node test suite',
            status: report.passed ? 'pass' : 'fail',
            evidence: `Exit ${exitCode}; ${JSON.stringify(report.totals)}. ${a.checkExecution.fixture ? 'Model-free process fixture.' : 'Actual copied-source execution.'}`,
          },
          { name: 'Browser layout', status: 'not-run', evidence: 'The event harness has no browser renderer.' },
        ],
        issues: report.passed
          ? []
          : ['Accepting this report records negative evidence; it does not approve a release.'],
        handoff: 'Inspect the measured report. Director acceptance releases the dependent CLI review.',
      };
    },
    { cwd: snapshot, environment, resultOnFailure: true },
  );
  entry.child.stdout.on('data', text => {
    stdout += text;
  });
  entry.child.stderr.on('data', text => {
    stderr += text;
  });
}
