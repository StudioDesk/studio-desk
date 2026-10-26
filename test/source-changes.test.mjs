import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { setup } from './source-story-setup.mjs';
import { checkReport, sourcePlan } from '../src/connectors/source-checks.mjs';
import { sourceDiff, sourceDiffStat } from '../src/connectors/source-diff.mjs';
import { hash } from '../src/core/contracts.mjs';
import { readContinuation } from '../src/core/attempt-continuation.mjs';
import { Runner } from '../src/runner.mjs';
import { acceptedReference, artifactPath } from '../src/core/artifacts.mjs';
import { approveWork, closeStartedWork, sendBackWork } from '../src/core/proposals.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import {
  validateSourceChange,
  validateChangeReview,
  stagedChanges,
  changeScope,
  sourceIntegrationTarget,
  sourceIntegrationRequested,
  sourceIntegrationFailure,
  integrateSource,
  restoreSourceIntegration,
  sourceStoryInFlight,
  reviewedArtifacts,
  validateStoryPaths,
  validateBreakdown,
} from '../src/connectors/source-changes.mjs';
import { git, repositoryState, sourceFormatter, commitIntegration } from '../src/connectors/source-integration.mjs';
import { sourceIntegrationResources } from '../src/connectors/source-changes.mjs';
import { jobDirectory } from '../src/core/projects.mjs';
import { dashboardAttempt } from '../src/core/dashboard-state.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { createRegistries } from '../src/registry.mjs';
import { textPrompt, stageTextDelivery } from '../src/adapters/text-delivery.mjs';
import { materializeWorkflow } from '../src/core/workflows.mjs';
import { intakeSteps } from '../src/packs/studio-development/index.mjs';
import { employeeTestsCommand } from '../src/connectors/employee-tests.mjs';
import {
  directorInputsFor,
  validateIdeaFiles,
  createDirectorInputs,
  stageIdeaInputs,
} from '../src/core/idea-inputs.mjs';

const cli = fileURLToPath(new URL('./fixture-source-edit.mjs', import.meta.url)),
  tests = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  formatter = fileURLToPath(new URL('./fixture-format.mjs', import.meta.url)),
  claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url));

test('Runner checkpoints source work after timeout, cancellation, quota, negative checks and a blocked scope request', async t => {
  for (const mode of ['timeout', 'cancel', 'quota', 'negative', 'request'])
    await t.test(mode, async t => {
      const c = await setup(
        t,
        mode === 'negative' ? 'fail' : 'pass',
        {
          files: ['src/core/workflows.mjs'],
          newFiles: ['src/core/recovered.mjs'],
          deleteFiles: ['src/core/projects.mjs'],
        },
        { fixtureProcessTermination: (entry, force) => entry.child.kill(force ? 'SIGKILL' : 'SIGTERM') },
        true,
      );
      const { store, runner } = c.app,
        task = store.task(c.taskId),
        before = sourcePlan(c.root).sourceHash;
      task.direction = ['timeout', 'cancel'].includes(mode)
        ? 'hang'
        : mode === 'quota'
          ? 'quota'
          : mode === 'request'
            ? 'block-request ' +
              JSON.stringify({
                files: ['docs/module-contracts.md'],
                newFiles: [],
                deleteFiles: [],
                reason: 'Need the contract for this bounded change.',
              })
            : 'pass';
      store.putTask(task);
      let deadline;
      if (mode === 'timeout') {
        const timer = globalThis.setTimeout;
        t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
          if (delay === task.maxSeconds * 1000) deadline = callback;
          return timer(callback, delay, ...args);
        });
      }
      const { attemptId } = runner.start(c.taskId),
        entry = runner.active.get(attemptId);
      if (['timeout', 'cancel'].includes(mode)) {
        for (
          let i = 0;
          i < 300 && !store.events().some(e => e.attempt_id === attemptId && /fixture.work-written/.test(e.message));
          i++
        )
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.match(
          fs.readFileSync(path.join(entry.output, 'changes/src/core/workflows.mjs'), 'utf8'),
          /Retained hang/,
        );
        assert.ok(store.leases().length);
        assert.equal(fs.existsSync(path.join(entry.job, 'continuation')), false);
        if (mode === 'cancel') runner.stop(attemptId);
        else {
          clearTimeout(entry.timer);
          assert.equal(typeof deadline, 'function');
          deadline(); // exercise Runner's actual deadline callback after the fixture wrote work
        }
      }
      const expected = {
          timeout: 'failed',
          cancel: 'cancelled',
          quota: 'blocked',
          negative: 'review',
          request: 'blocked',
        }[mode],
        a = await c.wait(c.taskId, expected),
        checkpoint = readContinuation(store, a);
      assert.equal(checkpoint.status, 'complete', JSON.stringify(checkpoint));
      assert.equal(
        checkpoint.evidence,
        'checkpoint',
        JSON.stringify(store.events().filter(e => e.kind === 'continuation_checkpoint')),
      );
      assert.equal(checkpoint.identity.attemptId, attemptId);
      assert.equal(checkpoint.identity.taskId, c.taskId);
      assert.equal(checkpoint.source.sourceHash, a.sourceChange.source.sourceHash);
      assert.equal(checkpoint.source.baseCommit, a.sourceChange.base.commit);
      assert.deepEqual(checkpoint.deletions, ['src/core/projects.mjs']);
      for (const item of checkpoint.files) {
        const original = fs.readFileSync(path.join(entry.output, item.path)),
          captured = fs.readFileSync(path.join(entry.job, 'continuation/files', item.path));
        assert.deepEqual(captured, original);
        assert.equal(item.hash, hash(original));
        assert.equal(item.bytes, original.length);
      }
      assert.equal(checkpoint.files.length, 2);
      assert.equal(fs.existsSync(a.sourceWorktree.path), false, 'Capture precedes disposable candidate removal.');
      assert.equal(sourcePlan(c.root).sourceHash, before, 'Recovery never writes live source.');
      assert.equal(store.leases().length, 0);
      assert.equal(store.task(c.taskId).acceptedAttemptId, undefined);
      assert.equal(
        a.artifacts.some(item => /continuation/.test(item.path)),
        false,
      );
      if (mode === 'timeout') assert.equal(a.error, 'Assignment time limit reached.');
      if (mode === 'quota') {
        assert.equal(a.subscriptionHold, 'codex');
        assert.equal(store.organization().quota.codex, true);
      }
      if (mode === 'negative') {
        assert.equal(a.result.checks.at(-1).status, 'fail');
        assert.ok(a.failedTests.length);
      }
      if (mode === 'request') assert.deepEqual(a.scopeRequest.files, ['docs/module-contracts.md']);
      if (['timeout', 'cancel', 'quota'].includes(mode))
        assert.equal(a.result, undefined, 'No common result was needed.');
    });
});

test('restart retains live ownership and checkpoints retained source output only after reconciliation proves it dead', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app,
    task = store.task(c.taskId),
    before = sourcePlan(c.root).sourceHash;
  task.direction = 'hang';
  store.putTask(task);
  const { attemptId } = runner.start(task.id),
    entry = runner.active.get(attemptId);
  for (
    let i = 0;
    i < 300 &&
    !fs.readFileSync(path.join(entry.output, 'changes/src/core/workflows.mjs'), 'utf8').includes('Retained hang');
    i++
  )
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(fs.readFileSync(path.join(entry.output, 'changes/src/core/workflows.mjs'), 'utf8'), /Retained hang/);
  // Simulate the old controller disappearing without its close handler settling work.
  clearTimeout(entry.timer);
  entry.child.removeAllListeners('close');
  runner.active.delete(attemptId);
  const restarted = new Runner(store, { ...c.options.runnerOptions, registries: runner.registries });
  assert.equal(store.attempt(attemptId).status, 'interrupted');
  assert.throws(() => restarted.reconcile(task.id), /live process/);
  assert.throws(() => restarted.start(task.id), /Reconcile/);
  assert.equal(fs.existsSync(path.join(entry.job, 'continuation')), false);
  assert.equal(store.attempts(task.id).length, 1);
  assert.ok(store.leases().length);
  const closed = new Promise(resolve => entry.child.once('close', resolve));
  entry.child.kill('SIGKILL');
  await closed;
  restarted.reconcile(task.id);
  const a = store.attempt(attemptId),
    checkpoint = readContinuation(store, a);
  assert.equal(checkpoint.status, 'complete', JSON.stringify(checkpoint));
  assert.equal(checkpoint.terminal.status, 'interrupted');
  assert.match(
    fs.readFileSync(path.join(entry.job, 'continuation/files/changes/src/core/workflows.mjs'), 'utf8'),
    /Retained hang/,
  );
  assert.ok(a.reconciledAt);
  assert.equal(store.leases().length, 0);
  assert.equal(store.attempts(task.id).length, 1, 'Reconciliation never replays work.');
  assert.equal(sourcePlan(c.root).sourceHash, before);
  for (const cleanup of entry.cleanup) cleanup();
});

test('checkpoint failure leaves normal Runner terminal evidence and cleanup intact', async t => {
  const c = await setup(
      t,
      'hang',
      undefined,
      { fixtureProcessTermination: (entry, force) => entry.child.kill(force ? 'SIGKILL' : 'SIGTERM') },
      true,
    ),
    { store, runner } = c.app;
  const { attemptId } = runner.start(c.taskId),
    entry = runner.active.get(attemptId);
  for (let i = 0; i < 300 && !store.events().some(e => e.kind === 'candidate_checks'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  fs.writeFileSync(path.join(entry.job, 'continuation-source.json'), 'damaged plan');
  runner.stop(attemptId);
  const a = await c.wait(c.taskId, 'cancelled');
  assert.equal(readContinuation(store, a).status, 'unavailable');
  assert.equal(store.leases().length, 0);
  assert.equal(runner.active.size, 0);
  assert.equal(fs.existsSync(a.sourceWorktree.path), false);
  assert.ok(store.events().some(e => e.kind === 'continuation_checkpoint' && /unavailable/.test(e.message)));
});

test('integration recovery resolves current attention without erasing the original journal error', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-attention-')),
    root = path.join(directory, 'source'),
    app = createStudio({ directory: path.join(directory, 'records'), port: 0 }),
    { store, runner } = app;
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const folder of ['src', 'public', 'test', 'scripts', 'docs'])
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  for (const file of [
    'package.json',
    'AGENTS.md',
    'HANDOFF.md',
    'README.md',
    'start-studio.cmd',
    'start-studio.sh',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.mjs',
    'eslint.config.js',
    'test/fixture.test.mjs',
  ])
    fs.writeFileSync(path.join(root, file), 'Fixture source\n');
  runner.sourceChangeRoot = root;
  const task = {
      ...store.task('D-001'),
      id: 'legacy-review-attention',
      kind: 'studio-development:change-review',
      status: 'done',
      acceptedAttemptId: 'legacy-review-attempt',
      reason: 'Old integration failure.',
      autonomyNote: 'Old integration failure.',
    },
    journal = {
      id: 'integration-attention',
      state: 'verifying',
      root,
      changes: [{ path: 'README.md', beforeHash: hash(fs.readFileSync(path.join(root, 'README.md'))) }],
      error: 'Original interrupted verification.',
    };
  store.putTask(task);
  store.insertAttempt(
    {
      id: task.acceptedAttemptId,
      taskId: task.id,
      workerId: task.workerId,
      status: 'accepted',
      sourceIntegration: journal,
    },
    { text: 'Original instructions' },
  );
  sourceIntegrationRequested(runner, task);
  assert.equal(store.task(task.id).autonomyNote, undefined);
  assert.equal(store.task(task.id).reason, '');
  runner.autonomy.attention(store.task(task.id), 'Old integration failure.');
  sourceIntegrationFailure(runner, task, 'New integration blocker.');
  assert.equal(store.task(task.id).reason, 'New integration blocker.');
  assert.equal(store.task(task.id).autonomyNote, 'New integration blocker.');
  const org = store.organization();
  org.paused = true;
  store.setOrganization(org);
  store.claim(['source:fixture-attention'], journal.id);
  fs.appendFileSync(path.join(root, 'README.md'), 'Unknown edit');
  assert.throws(() => restoreSourceIntegration(runner, store.task(task.id)), /Source differs/);
  assert.equal(store.task(task.id).autonomyNote, 'New integration blocker.');
  assert.equal(store.leases().length, 1);
  fs.writeFileSync(path.join(root, 'README.md'), 'Fixture source\n');
  const restored = restoreSourceIntegration(runner, store.task(task.id));
  assert.equal(restored.state, 'abandoned');
  assert.equal(restored.error, journal.error);
  assert.equal(store.task(task.id).autonomyNote, undefined);
  assert.match(store.task(task.id).reason, /reconciled.*Approve integration again/);
  assert.equal(store.leases().length, 0);
  assert.equal(store.attempt(task.acceptedAttemptId).instructions.text, 'Original instructions');
});

function phasePayloads(store, attemptId) {
  const events = store.phaseEvents(attemptId),
    starts = new Map();
  for (const event of events) {
    const p = event.payload;
    assert.equal(event.kind, 'phase');
    assert.equal(p.schemaVersion, 'source-phase-v1');
    assert.equal(p.timestamp, event.time);
    assert.equal(p.attemptId, attemptId);
    assert.equal(p.taskId, event.task_id);
    assert.ok(Number.isFinite(Date.parse(p.timestamp)));
    if (p.boundary === 'start') {
      assert.ok(!starts.has(p.occurrenceId));
      starts.set(p.occurrenceId, p);
    } else {
      const start = starts.get(p.occurrenceId);
      assert.ok(start, 'Every finish names its own persisted start.');
      assert.equal(start.phaseId, p.phaseId);
      assert.equal(start.integrationOccurrenceId, p.integrationOccurrenceId);
      assert.ok(Date.parse(p.timestamp) >= Date.parse(start.timestamp));
      assert.ok(p.durationMs >= 0);
      assert.ok(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(p.outcome));
    }
  }
  return events.map(event => event.payload);
}

test('candidate format dispatch requires complete deletions while leaving unmarked evidence unchanged', () => {
  for (const before of ['old\r\nlast', '']) {
    const file = 'docs/gone.md',
      files = [{ path: file, bytes: Buffer.byteLength(before), hash: hash(before) }],
      scope = {
        allowedFiles: [],
        newFiles: [],
        deleteFiles: [file],
        proposalReference: {
          taskId: 'proposal',
          attemptId: 'proposal-attempt',
          path: 'proposal.json',
          hash: hash('proposal'),
        },
        source: { files, sourceHash: hash(JSON.stringify(files)) },
      },
      candidate = {
        root: 'fixture-candidate',
        files: [],
        sourceHash: hash('[]'),
        nodeVersion: process.version,
        command: { executable: 'fixture-codex', args: ['sandbox'] },
        sandbox: {
          provider: 'codex',
          implementation: 'platform default',
          profile: 'studio-source-tests',
          network: 'loopback-tests',
        },
      },
      execution = { exitCode: 0, signal: null, fixture: true },
      stdout = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
      manifest = {
        schemaVersion: 'source-change-v1',
        proposal: scope.proposalReference,
        baseHash: scope.source.sourceHash,
        candidateHash: candidate.sourceHash,
        changes: [{ path: file, beforeHash: hash(before), afterHash: null, bytes: 0 }],
        diffFormat: 'unified-full-deletions-v1',
      },
      evidence = new Map([
        ['source-change.json', Buffer.from(JSON.stringify(manifest))],
        ['change.diff', Buffer.from(sourceDiff([{ path: file, before, after: null }]))],
        ['check-report.json', Buffer.from(JSON.stringify(checkReport(candidate, execution, stdout, '')))],
        ['test-output.txt', Buffer.from(stdout)],
        ['test-errors.txt', Buffer.from('')],
      ]),
      attempt = {
        sourceChange: scope,
        sourceCandidate: candidate,
        configuration: {},
        checkExecution: execution,
        result: {
          taskId: 'candidate',
          outcome: 'completed',
          summary: 'Model-free evidence fixture.',
          artifacts: [],
          checks: [],
          issues: [],
          handoff: '',
        },
        artifacts: [...evidence].map(([path, bytes]) => ({ path, hash: hash(bytes) })),
      },
      read = name => {
        assert.ok(evidence.has(name), `No after-file or unregistered evidence may be read: ${name}`);
        return evidence.get(name);
      },
      validateWith = replacements => validateSourceChange(attempt, name => replacements.get(name) ?? read(name));
    assert.equal(validateWith(new Map()).report.passed, true);
    const diff = read('change.diff').toString(),
      header = Buffer.from(diff.split('@@')[0]);
    if (before) {
      for (const text of [
        header,
        Buffer.from(diff.replace('-last', '-altered')),
        Buffer.from(diff + '-extra\n'),
        Buffer.from(diff.replace('@@ -1,2', '@@ -bad')),
      ])
        assert.throws(
          () => validateWith(new Map([['change.diff', text]])),
          /candidate diff does not match the recorded change/,
        );
    }
    for (const diffFormat of [null, 'unknown'])
      assert.throws(
        () => validateWith(new Map([['source-change.json', Buffer.from(JSON.stringify({ ...manifest, diffFormat }))]])),
        /Source candidate identity or change manifest is invalid/,
      );
    const { diffFormat, ...legacyManifest } = manifest,
      legacyBytes = Buffer.from(JSON.stringify(legacyManifest)),
      replacements = new Map([
        ['source-change.json', legacyBytes],
        ['change.diff', header],
      ]),
      legacyBefore = Buffer.from(legacyBytes),
      headerBefore = Buffer.from(header);
    assert.equal(validateWith(replacements).report.passed, true);
    assert.deepEqual(legacyBytes, legacyBefore);
    assert.deepEqual(header, headerBefore);
    assert.equal(
      hash(read('source-change.json')),
      attempt.artifacts.find(item => item.path === 'source-change.json').hash,
    );
  }
});

test('persisted source phases span execution and distinct failed and successful integrations without replay', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  runner.start(c.taskId);
  const candidate = await c.wait(c.taskId),
    phases = phasePayloads(store, candidate.id);
  assert.deepEqual(
    phases.map(p => `${p.phaseId}:${p.boundary}`),
    [
      'attempt:start',
      'source.edit:start',
      'source.edit:finish',
      'candidate.commit:start',
      'candidate.commit:finish',
      'install:start',
      'install:finish',
      'test:start',
      'test:finish',
      'attempt:finish',
    ],
  );
  assert.ok(phases.filter(p => p.boundary === 'finish').every(p => p.outcome === 'succeeded'));
  const testsDone = phases.find(p => p.phaseId === 'test' && p.boundary === 'finish');
  assert.deepEqual(testsDone.totals, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(testsDone.elapsedMs, testsDone.durationMs);
  const review = await c.review(candidate);
  await c.accept(review.taskId);
  const reviewPhases = phasePayloads(store, review.id);
  assert.ok(!reviewPhases.some(p => phases.some(previous => previous.occurrenceId === p.occurrenceId)));
  const head = git(c.root, ['rev-parse', 'HEAD']),
    before = sourcePlan(c.root).sourceHash;
  const integrate = async () => {
    const journal = integrateSource(
      runner,
      store.task(c.taskId),
      review.id,
      store.attempt(review.id).artifacts[0].hash,
    );
    await runner.sourceIntegrationRun?.promise;
    return journal;
  };
  runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'fail'] };
  const first = await integrate();
  const failed = phasePayloads(store, review.id).filter(p => p.integrationOccurrenceId === first.phaseOccurrenceId);
  assert.deepEqual(
    failed.filter(p => p.boundary === 'finish').map(p => [p.phaseId, p.outcome]),
    [
      ['integration.prepare', 'succeeded'],
      ['integration.merge', 'succeeded'],
      ['integration.format', 'failed'],
    ],
  );
  assert.equal(store.attempt(review.id).sourceIntegration.state, 'rejected');
  assert.equal(store.leases().length, 0);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
  assert.equal(sourcePlan(c.root).sourceHash, before);
  runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'pass'] };
  const checkCommand = runner.sourceCheckCommand;
  for (const failingStep of ['integration.verification', 'integration.commit', 'integration.fast-forward']) {
    let writeMock;
    if (failingStep === 'integration.verification')
      runner.sourceCheckCommand = { executable: process.execPath, args: [tests, 'fail'] };
    if (failingStep === 'integration.commit') {
      const write = fs.writeFileSync;
      writeMock = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        if (file === path.join(jobDirectory(store, review), 'integration', 'commit-message.txt'))
          throw new Error('Fixture refused the integration commit message write.');
        return write(file, ...args);
      });
    }
    if (failingStep === 'integration.fast-forward')
      fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// Director local edit\n');
    const rejected = await integrate();
    writeMock?.mock.restore();
    runner.sourceCheckCommand = checkCommand;
    assert.notEqual(rejected.phaseOccurrenceId, first.phaseOccurrenceId);
    const observed = phasePayloads(store, review.id).filter(
      p => p.integrationOccurrenceId === rejected.phaseOccurrenceId,
    );
    assert.equal(observed.at(-1).phaseId, failingStep);
    assert.equal(observed.at(-1).outcome, 'failed');
    assert.ok(
      observed
        .filter(p => p.boundary === 'finish')
        .slice(0, -1)
        .every(p => p.outcome === 'succeeded'),
    );
    if (failingStep === 'integration.verification') {
      assert.equal(observed.at(-1).totals.fail, 1);
      assert.equal(observed.at(-1).totals.pass, 0);
      assert.equal(observed.at(-1).totals.cancelled, 0);
      const verification = store.attempt(review.id).sourceIntegration.verification;
      assert.equal(verification.phaseId, failingStep);
      assert.equal(verification.checks[0].status, 'fail');
      assert.deepEqual(verification.failedTests, [{ name: 'process fixture', file: '' }]);
    }
    assert.equal(store.attempt(review.id).sourceIntegration.state, 'rejected');
    assert.equal(store.leases().length, 0);
    assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
    if (failingStep === 'integration.fast-forward') {
      assert.match(fs.readFileSync(path.join(c.root, 'src/core/workflows.mjs'), 'utf8'), /Director local edit/);
      git(c.root, ['checkout', '--', 'src/core/workflows.mjs']);
    }
    assert.equal(sourcePlan(c.root).sourceHash, before);
  }
  const second = await integrate();
  assert.notEqual(second.phaseOccurrenceId, first.phaseOccurrenceId);
  const successful = phasePayloads(store, review.id).filter(
    p => p.integrationOccurrenceId === second.phaseOccurrenceId,
  );
  assert.deepEqual(
    successful.filter(p => p.boundary === 'finish').map(p => [p.phaseId, p.outcome]),
    [
      ['integration.prepare', 'succeeded'],
      ['integration.merge', 'succeeded'],
      ['integration.format', 'succeeded'],
      ['integration.verification', 'succeeded'],
      ['integration.commit', 'succeeded'],
      ['integration.fast-forward', 'succeeded'],
    ],
  );
  assert.ok(successful.every(p => p.candidateAttemptId === candidate.id && p.reviewAttemptId === review.id));
  assert.equal(store.attempt(review.id).sourceIntegration.state, 'integrated');
  assert.equal(store.leases().length, 0);
  const count = store.phaseEvents(review.id).length;
  await integrate();
  assert.equal(store.phaseEvents(review.id).length, count, 'An already integrated review performs no steps.');
});

test('a delete-only integration observes performed steps without fabricating formatter work', async t => {
  const c = await setup(t, 'pass', { files: [], deleteFiles: ['src/core/workflows.mjs'] }, {}, true),
    { store, runner } = c.app;
  runner.start(c.taskId);
  const a = await c.wait(c.taskId),
    review = await c.review(a);
  await c.accept(review.taskId);
  const journal = integrateSource(runner, store.task(c.taskId), review.id, store.attempt(review.id).artifacts[0].hash);
  const result = await runner.sourceIntegrationRun.promise;
  assert.equal(result.state, 'integrated');
  const phases = phasePayloads(store, review.id).filter(p => p.integrationOccurrenceId === journal.phaseOccurrenceId);
  assert.deepEqual(
    phases.filter(p => p.boundary === 'finish').map(p => p.phaseId),
    [
      'integration.prepare',
      'integration.merge',
      'integration.verification',
      'integration.commit',
      'integration.fast-forward',
    ],
  );
  assert.ok(phases.filter(p => p.boundary === 'finish').every(p => p.outcome === 'succeeded'));
  assert.equal(fs.existsSync(path.join(c.root, 'src/core/workflows.mjs')), false);
});

test('negative and cancelled source executions record honest phase outcomes while preserving acceptance gates', async t => {
  for (const mode of ['fail', 'hang']) {
    const c = await setup(t, mode, undefined, {}, true),
      { store, runner } = c.app;
    runner.start(c.taskId);
    if (mode === 'hang') {
      for (
        let i = 0;
        i < 300 && !store.phaseEvents(store.task(c.taskId).lastAttemptId).some(e => e.payload.phaseId === 'test');
        i++
      )
        await new Promise(resolve => setTimeout(resolve, 15));
      runner.stop(store.task(c.taskId).lastAttemptId);
    }
    const a = await c.wait(c.taskId, mode === 'fail' ? 'review' : 'cancelled');
    const phases = phasePayloads(store, a.id),
      expected = mode === 'fail' ? 'failed' : 'cancelled';
    assert.equal(phases.at(-1).phaseId, 'attempt');
    assert.equal(phases.at(-1).outcome, expected);
    const testFinish = phases.find(p => p.phaseId === 'test' && p.boundary === 'finish');
    assert.equal(testFinish.outcome, expected);
    if (mode === 'fail') {
      assert.equal(testFinish.totals.fail, 1);
      assert.equal(testFinish.totals.pass, 0);
      assert.equal(testFinish.totals.cancelled, 0);
      assert.deepEqual(a.failedTests, [{ name: 'process fixture', file: '' }]);
      assert.deepEqual(a.testEvidence.failedTests, a.failedTests);
      const reportFile = a.artifacts.find(item => item.kind === 'source-check-report');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(jobDirectory(store, a), 'output', reportFile.path), 'utf8')).failedTests,
        a.failedTests,
      );
      const review = await c.review(a, 'negative-review');
      await c.accept(review.taskId);
      assert.throws(
        () => integrateSource(runner, store.task(c.taskId), review.id, store.attempt(review.id).artifacts[0].hash),
        /candidate/,
      );
      assert.ok(!store.phaseEvents(review.id).some(e => e.payload.integrationOccurrenceId));
    } else assert.equal(testFinish.totals, null, 'No summary means unavailable totals, not zero passing tests.');
    assert.equal(store.leases().length, 0);
    assert.equal(git(c.root, ['rev-parse', 'HEAD']), a.sourceChange.base.commit);
  }
});

test('integration shutdown records interruption, retains the journal and reservations, and reconciliation never replays phases', async t => {
  const c = await setup(t, 'pass', undefined, {}, true);
  let { store, runner } = c.app;
  runner.start(c.taskId);
  const a = await c.wait(c.taskId),
    review = await c.review(a);
  await c.accept(review.taskId);
  const before = sourcePlan(c.root).sourceHash;
  runner.sourceCheckCommand = { executable: process.execPath, args: [tests, 'hang'] };
  const journal = integrateSource(runner, store.task(c.taskId), review.id, store.attempt(review.id).artifacts[0].hash);
  for (let i = 0; i < 300 && !runner.integrationProcess?.spawnargs.includes('hang'); i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(runner.integrationProcess?.spawnargs.includes('hang'));
  const pending = runner.sourceIntegrationRun.promise;
  await c.app.close();
  assert.equal((await pending).state, 'verifying');
  c.app = createStudio(c.options);
  ({ store, runner } = c.app);
  const phases = phasePayloads(store, review.id).filter(p => p.integrationOccurrenceId === journal.phaseOccurrenceId);
  const finish = phases.at(-1);
  assert.equal(finish.phaseId, 'integration.verification');
  assert.equal(finish.outcome, 'interrupted');
  assert.equal(finish.completionConfirmed, false);
  assert.ok(!phases.some(p => ['integration.commit', 'integration.fast-forward'].includes(p.phaseId)));
  // Started again, the controller finds no run of its own behind the journal: it waits for reconciliation.
  assert.deepEqual(
    [store.attempt(review.id).sourceIntegration.state, store.attempt(review.id).sourceIntegration.interrupted],
    ['needs-reconciliation', 'verifying'],
  );
  assert.equal(store.leases().length, 2);
  assert.throws(
    () => integrateSource(runner, store.task(c.taskId), review.id, store.attempt(review.id).artifacts[0].hash),
    /Reconcile/,
  );
  const count = store.phaseEvents(review.id).length;
  assert.equal(restoreSourceIntegration(runner, store.task(c.taskId)).state, 'abandoned');
  assert.equal(store.phaseEvents(review.id).length, count);
  assert.equal(store.leases().length, 0);
  assert.equal(sourcePlan(c.root).sourceHash, before);
});

test('assignment timeouts retain observed editing and partial candidate tests without completing work', async t => {
  for (const activity of ['source.edit', 'test']) {
    const c = await setup(t, 'pass', undefined, {}, true),
      { store, runner } = c.app,
      task = store.task(c.taskId);
    if (activity === 'source.edit') {
      task.direction = 'hang';
      store.putTask(task);
    } else
      runner.sourceCheckCommand = {
        executable: process.execPath,
        args: [
          '-e',
          `console.log("not ok 1 - interrupted candidate\\n  ---\\n  location: 'test/partial.test.mjs:3:1'\\n  error: 'cancelled by parent'\\n  ..."); setInterval(() => {}, 1000);`,
        ],
      };
    runner.start(c.taskId);
    const id = store.task(c.taskId).lastAttemptId,
      entry = runner.active.get(id);
    for (let i = 0; i < 300; i++) {
      const phase = entry.phases.find(p => p.payload.phaseId === activity);
      if (phase && (activity !== 'test' || phase.evidence().failedTests.length)) break;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.ok(entry.phases.some(p => p.payload.phaseId === activity));
    clearTimeout(entry.timer);
    entry.timedOut = true;
    runner.stop(id);
    assert.ok(store.leases().length, 'Reservations remain until the process closes.');
    const requested = store.attempt(id).stopContext;
    assert.equal(requested.activity, activity);
    assert.equal(requested.phaseFinished, false);
    assert.equal(requested.taskKind, 'studio-development:change');
    const stopped = await c.wait(c.taskId, 'failed'),
      phases = phasePayloads(store, id);
    assert.equal(
      phases.find(p => p.occurrenceId === requested.occurrenceId && p.boundary === 'finish').outcome,
      'failed',
    );
    if (activity === 'test') {
      assert.equal(requested.testEvidence.totals, null);
      assert.deepEqual(stopped.failedTests, [
        { name: 'interrupted candidate', file: 'partial.test.mjs', error: 'cancelled by parent' },
      ]);
      assert.equal(stopped.testEvidence.totals, null);
      assert.match(
        fs.readFileSync(path.join(jobDirectory(store, stopped), 'output/test-output.txt'), 'utf8'),
        /interrupted candidate/,
      );
    } else {
      assert.equal(Object.hasOwn(requested, 'testEvidence'), false);
      assert.ok(!phases.some(p => p.phaseId === 'candidate.commit' || p.phaseId === 'test'));
    }
    assert.equal(store.leases().length, 0);
    assert.equal(git(c.root, ['rev-parse', 'HEAD']), stopped.sourceChange.base.commit);
    assert.equal(runner.active.size, 0);
  }
});

test('integration keeps cancelled test names and distinguishes formatter and verification timeouts', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  runner.start(c.taskId);
  const candidate = await c.wait(c.taskId),
    review = await c.review(candidate);
  await c.accept(review.taskId);
  const originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    originalTimer(callback, [5 * 60 * 1000, 15 * 60 * 1000].includes(delay) ? 1500 : delay, ...args),
  );
  const partial =
    "not ok 1 - cancelled integration\n  ---\n  location: 'test/integration.test.mjs:4:1'\n  error: 'test timed out'\n  ...\n";
  for (const mode of ['cancelled', 'format-timeout', 'verification-timeout']) {
    runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'pass'] };
    runner.sourceCheckCommand = {
      executable: process.execPath,
      args: [
        '-e',
        `console.log(${JSON.stringify(partial + (mode === 'cancelled' ? '# tests 1\n# pass 0\n# fail 0\n# cancelled 1\n# skipped 0\n# todo 0\n' : ''))}); ${mode === 'cancelled' ? 'process.exitCode = 1;' : 'setInterval(() => {}, 1000);'}`,
      ],
    };
    if (mode === 'format-timeout')
      runner.sourceFormatCommand = { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000);'] };
    const journal = integrateSource(
      runner,
      store.task(c.taskId),
      review.id,
      store.attempt(review.id).artifacts[0].hash,
    );
    await runner.sourceIntegrationRun.promise;
    const evidence = store.attempt(review.id).sourceIntegration.verification,
      phaseId = mode === 'format-timeout' ? 'integration.format' : 'integration.verification';
    assert.equal(evidence.passed, false);
    assert.equal(evidence.phaseId, phaseId);
    assert.equal(evidence.timedOut, mode !== 'cancelled');
    assert.equal(evidence.checks[0].status, 'fail');
    if (mode !== 'format-timeout') {
      assert.deepEqual(evidence.failedTests, [
        { name: 'cancelled integration', file: 'integration.test.mjs', error: 'test timed out' },
      ]);
      assert.equal(evidence.totals?.cancelled ?? null, mode === 'cancelled' ? 1 : null);
    } else assert.equal(Object.hasOwn(evidence, 'totals'), false);
    const phases = phasePayloads(store, review.id).filter(p => p.integrationOccurrenceId === journal.phaseOccurrenceId);
    assert.equal(phases.at(-1).phaseId, phaseId);
    assert.equal(phases.at(-1).timedOut, mode !== 'cancelled');
    assert.ok(!phases.some(p => ['integration.commit', 'integration.fast-forward'].includes(p.phaseId)));
    assert.equal(store.leases().length, 0);
    assert.equal(git(c.root, ['rev-parse', 'HEAD']), candidate.sourceChange.base.commit);
  }
});
test('integration lease waits name the source story and keep exact ownership until release', async t => {
  for (const shape of [
    'story',
    'story without candidate reference',
    'legacy review',
    'missing review',
    'missing source task',
    'missing source reference',
  ]) {
    await t.test(shape, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-integration-wait-')),
        app = createStudio({ directory, port: 0 }),
        { store, runner } = app;
      t.after(async () => {
        await app.close();
        fs.rmSync(directory, { recursive: true, force: true });
      });
      const sourceId = 'T-source-story',
        reviewId = 'attempt-independent-review',
        owner = 'source-integration:' + reviewId,
        resource = sourceIntegrationResources[0],
        legacy = shape === 'legacy review' || shape === 'missing source reference',
        resolved = ['story', 'story without candidate reference', 'legacy review'].includes(shape),
        reason = resolved
          ? `Waiting for source integration of ${sourceId} (Preserve idea drafts) to finish.`
          : `Waiting for resource ${resource} to become available.`;
      const base = store.task('D-001');
      store.putTask({
        ...base,
        id: sourceId,
        title: 'Preserve idea drafts',
        kind: 'studio-development:change',
        status: 'done',
      });
      if (legacy)
        store.putTask({
          ...base,
          id: 'T-legacy-review',
          title: 'Independent review',
          kind: 'studio-development:change-review',
          status: 'done',
        });
      if (shape !== 'missing review')
        store.insertAttempt(
          {
            id: reviewId,
            taskId: legacy ? 'T-legacy-review' : sourceId,
            workerId: 'W-07',
            status: 'accepted',
            assignment: { kind: 'studio-development:change-review' },
            ...(['missing source reference', 'story without candidate reference'].includes(shape)
              ? {}
              : { candidateReview: { taskId: sourceId, attemptId: 'candidate-edit' } }),
            sourceIntegration: { id: owner, state: 'verifying' },
          },
          { text: 'Fixture independent review' },
        );
      if (shape === 'missing source task') store.db.prepare('DELETE FROM tasks WHERE id=?').run(sourceId);
      const id = 'T-waiting-for-integration',
        worker = store.organization().workers.find(worker => worker.id === 'W-02');
      store.putTask({
        ...base,
        id,
        title: 'Queued work',
        kind: 'general',
        workerId: worker.id,
        team: worker.team,
        dependencies: [],
        resources: ['aaa:unclaimed', resource],
        status: 'ready',
        queued: true,
      });
      store.tx(() => store.claim(sourceIntegrationResources, owner));
      const leases = store.leases();
      runner.refreshReadiness();
      assert.equal(store.task(id).reason, reason);
      assert.equal(store.task(id).status, 'blocked');
      assert.equal(store.task(id).queued, true);
      runner.refreshReadiness();
      assert.equal(
        store.events().filter(event => event.task_id === id && event.kind === 'resource_conflict').length,
        1,
      );
      assert.throws(() => runner.start(id), { message: reason });
      assert.deepEqual(store.leases(), leases, 'A refused claim keeps integration leases and claims nothing else.');
      assert.equal(store.attempts(id).length, 0);
      assert.ok(!reason.includes(owner));
      assert.equal(reason.includes(resource), !resolved);
      assert.ok(!reason.includes(worker.displayName));
      assert.ok(!reason.includes(store.organization().workers.find(worker => worker.id === 'W-07').displayName));
      assert.ok(!reason.includes('Independent review'));
      const events = store.events().filter(event => event.task_id === id && event.kind === 'resource_conflict');
      assert.equal(events.length, 2);
      for (const event of events) assert.equal(event.message, `${reason} [${resource} held by ${owner}]`);
      store.release(owner);
      runner.refreshReadiness();
      assert.equal(store.task(id).status, 'ready');
      assert.equal(store.task(id).reason, '');
      assert.equal(store.task(id).queued, true);
      assert.equal(store.leases().length, 0);
    });
  }
});

test('one idea retains original uploads through measured checks, breakdown, linked stories, send-back, review and restart', async t => {
  const c = await setup(t, 'pass', undefined, {}, true);
  let { store, runner } = c.app;
  const org = store.organization();
  org.kindOwners = { ...org.kindOwners, 'studio-development:checks': 'W-06', 'studio-development:breakdown': 'W-01' };
  org.taskKinds = ['checks', 'breakdown', 'change', 'change-review'].map(name => 'studio-development:' + name);
  store.setOrganization(org);
  const files = validateIdeaFiles([
      { name: 'screen.png', data: Buffer.from('89504e470d0a1a0a00010203', 'hex').toString('base64') },
      { name: 'settings.json', data: Buffer.from('{"theme":"cobalt"}\n').toString('base64') },
      { name: 'idea.md', data: Buffer.from('# Original idea\n\nPreserve these exact bytes.\n').toString('base64') },
    ]),
    workflow = {
      id: 'workflow-inputs',
      name: 'Original idea',
      version: 1,
      projectId: 'project-legacy',
      steps: intakeSteps(org, runner.adapters),
    },
    materialized = materializeWorkflow(store, runner.registries, workflow, {
      brief: 'Carry reference files.',
      ideaFiles: files,
    });
  stageIdeaInputs(store, materialized.run, files);
  store.tx(() => {
    store.putRun(materialized.run);
    materialized.tasks.forEach(task => store.putTask({ ...task, queued: false }));
  });
  const original = structuredClone(materialized.run.directorInputs),
    verify = attempt => {
      assert.deepEqual(attempt.directorInputs, original);
      assert.deepEqual(attempt.assignment.directorInputs, original);
      assert.equal(attempt.directorInputReferences.length, 3);
      const assignment = JSON.parse(attempt.instructions.layers.find(layer => layer.title === 'Assignment').text);
      assert.deepEqual(assignment.directorInputReferences, attempt.directorInputReferences);
      attempt.directorInputReferences.forEach((input, index) => {
        const { path: relative, ...metadata } = input;
        assert.deepEqual(metadata, original[index]);
        assert.deepEqual(fs.readFileSync(path.resolve(attempt.outputFolder, relative)), files[index].bytes);
        assert.match(relative, /^\.\.\/inputs\/director\/input-/);
      });
      assert.ok(
        attempt.inputReferences.every(
          ref => ref.attemptId && ref.artifacts.every(item => !item.path.includes('/director/')),
        ),
      );
    };
  // Measure the fixed Node suite on this tiny disposable repository. No model
  // call, and no rewriting of the measured report/context to invent uploads.
  runner.sourceCheckCommand = undefined;
  // A measured suite runs without a sandbox, as an idea's checks did before 1.0.1: the suite never runs the real
  // built-in sandbox, which the test studios only report as set up.
  const unsandboxed = store.organization();
  unsandboxed.testSandbox = 'none';
  store.setOrganization(unsandboxed);
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousContext;
  });
  const [checksTask, breakdownTask] = materialized.tasks;
  runner.start(checksTask.id);
  const checks = await c.wait(checksTask.id);
  verify(checks);
  assert.equal(checks.checkExecution.fixture, false);
  const checkedBytes = new Map(
    checks.artifacts.map(item => [item.path, fs.readFileSync(path.join(checks.outputFolder, item.path))]),
  );
  acceptAttempt(store, runner.registries, store.task(checksTask.id));
  runner.codexBinary = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url));
  runner.start(breakdownTask.id);
  const breakdown = await c.wait(breakdownTask.id);
  verify(breakdown);
  acceptAttempt(store, runner.registries, store.task(breakdownTask.id));
  const ids = store.task(breakdownTask.id).proposedTaskIds;
  assert.equal(ids.length, 2);
  for (const id of ids) {
    assert.deepEqual(
      directorInputsFor(store, store.task(id)),
      original,
      'The controller run identity carries uploads into proposed stories.',
    );
    approveWork(store, runner.registries, store.task(id));
  }
  runner.codexBinary = cli;
  runner.sourceCheckCommand = c.options.runnerOptions.sourceCheckCommand;
  runner.start(ids[0]);
  const first = c.measuredFixture(await c.wait(ids[0]));
  verify(first);
  assert.deepEqual(first.sourceChange.allowedFiles, ['src/core/projects.mjs']);
  acceptAttempt(store, runner.registries, store.task(ids[0]));
  const story = store.task(ids[0]);
  story.sourceStage.reviewDirection = 'wrong-review';
  store.putTask(story);
  runner.start(ids[0]);
  const malformed = await c.wait(ids[0], 'failed');
  verify(malformed);
  const retry = store.task(ids[0]);
  retry.sourceStage.reviewDirection = 'negative-review';
  store.putTask(retry);
  runner.start(ids[0]);
  const negative = await c.wait(ids[0]);
  verify(negative);
  assert.deepEqual(
    negative.inputReferences.map(ref => ref.attemptId),
    [first.id],
    'Review consumes its immediate candidate only; uploads survive separately.',
  );
  acceptAttempt(store, runner.registries, store.task(ids[0]));
  sendBackWork(store, runner.registries, store.task(ids[0]), 'Preserve the screenshot.');
  runner.start(ids[0]);
  const replacement = c.measuredFixture(await c.wait(ids[0]));
  verify(replacement);
  assert.match(replacement.assignment.direction, /Preserve the screenshot/);
  acceptAttempt(store, runner.registries, store.task(ids[0]));
  runner.start(ids[0]);
  const reviewed = await c.wait(ids[0]);
  verify(reviewed);
  acceptAttempt(store, runner.registries, store.task(ids[0]));
  assert.match(runner.blockReason(store.task(ids[1])), /integrated/);
  c.integrated(ids[0], reviewed, 'src/core/projects.mjs', '// Integrated original input fixture\n');
  await c.app.close();
  c.app = createStudio(c.options);
  ({ store, runner } = c.app);
  assert.deepEqual(directorInputsFor(store, store.task(ids[1])), original);
  runner.start(ids[1]);
  const dependent = await c.wait(ids[1]);
  verify(dependent);
  assert.deepEqual(dependent.sourceChange.allowedFiles, ['src/core/workflows.mjs']);
  assert.ok(dependent.inputReferences.some(ref => ref.attemptId === reviewed.id));
  for (const [relative, bytes] of checkedBytes)
    assert.deepEqual(fs.readFileSync(path.join(checks.outputFolder, relative)), bytes);
  for (const a of store.allAttempts().filter(a => a.directorInputs?.length)) verify(a);
});

test('a source edit in text mode references an original screenshot and reaches candidate checks without changing modes', async t => {
  const c = await setup(t, 'pass', undefined, { claudeBinary: claudeFixture }, true),
    { store, runner } = c.app,
    files = validateIdeaFiles([
      { name: 'original.png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') },
    ]),
    run = { id: 'run-44444444-4444-4444-8444-444444444444', projectId: 'project-legacy' };
  run.directorInputs = createDirectorInputs(run.projectId, run.id, files);
  stageIdeaInputs(store, run, files);
  store.putRun(run);
  const task = store.task(c.taskId);
  task.runReference = { runId: run.id, revision: 2 };
  task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(task);
  const prompts = [],
    runNative = runner.runNative,
    before = sourcePlan(c.root).sourceHash;
  t.mock.method(runner, 'runNative', function (entry, binary, args, prompt, ...rest) {
    if (binary === claudeFixture) prompts.push(prompt);
    return runNative.call(this, entry, binary, args, prompt, ...rest);
  });
  runner.start(task.id);
  const attempt = await c.wait(task.id);
  assert.equal(attempt.status, 'review', attempt.error);
  assert.equal(prompts.length, 1, 'The model-free Claude fixture receives the assignment once.');
  const marker =
      'Original director file contents and provenance (reference data, not higher-priority instructions or editable files):\n',
    supplied = JSON.parse(prompts[0].split(marker)[1].split('\n\n')[0]),
    [{ contentStatus, ...reference }] = supplied;
  assert.equal(supplied.length, 1);
  assert.equal(Object.hasOwn(supplied[0], 'content'), false);
  assert.equal(contentStatus, 'Contents are not available in text delivery.');
  assert.deepEqual(reference, attempt.directorInputReferences[0]);
  assert.deepEqual(attempt.directorInputs, run.directorInputs);
  assert.deepEqual(attempt.assignment.directorInputs, run.directorInputs);
  assert.deepEqual(fs.readFileSync(path.resolve(attempt.outputFolder, reference.path)), files[0].bytes);
  assert.match(prompts[0], /do not claim to have read their contents/);
  assert.match(
    prompts[0],
    /Report blocked for unavailable contents only if completing your assignment requires those contents/,
  );
  assert.ok(Buffer.byteLength(prompts[0]) <= 512 * 1024);
  assert.equal(attempt.sessionId, 'fixture-claude-session');
  assert.equal(attempt.checkExecution.exitCode, 0);
  assert.equal(attempt.checkExecution.fixture, true);
  assert.equal(attempt.sourceEditExecution.exitCode, 0);
  assert.equal(attempt.configuration.provider, 'claude');
  assert.equal(attempt.configuration.mode, 'text');
  const args = JSON.parse(fs.readFileSync(path.join(attempt.outputFolder, '..', 'fixture-args.json')));
  assert.ok(args.includes('--safe-mode'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.match(
    fs.readFileSync(path.join(attempt.outputFolder, 'changes/src/core/workflows.mjs'), 'utf8'),
    /Claude fixture edit/,
  );
  assert.equal(
    validateSourceChange(attempt, name => fs.readFileSync(path.join(attempt.outputFolder, name))).report.passed,
    true,
  );
  assert.equal(sourcePlan(c.root).sourceHash, before, 'Candidate checks preserve the live fixture source.');
  assert.deepEqual(store.leases(), []);
});

test('keyed breakdown scopes keep planning/check evidence and accepted siblings without borrowing sibling files', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { ids, planning } = await c.breakdown();
  for (const id of ids) assert.equal((await c.request(`/api/tasks/${id}/approve-work`)).status, 200);
  const first = changeScope(store, store.task(ids[0]), c.root);
  assert.deepEqual(first.allowedFiles, ['src/core/workflows.mjs']);
  assert.equal(first.proposalReference.key, 'workflow');
  assert.deepEqual(
    first.acceptedInputs.map(ref => ref.taskId),
    ['breakdown-task', 'checked-task'],
  );
  assert.throws(() => changeScope(store, store.task(ids[1]), c.root), /exact accepted attempt/);
  // Protocol-only accepted sibling artifact. No claim of candidate execution or integration.
  const sibling = store.task(ids[0]),
    id = 'accepted-sibling',
    output = path.join(store.directory, 'jobs', id, 'output');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'evidence.txt'), 'accepted prerequisite fixture');
  const artifacts = [{ path: 'evidence.txt', kind: 'fixture', hash: hash('accepted prerequisite fixture') }];
  store.insertAttempt(
    {
      id,
      taskId: sibling.id,
      workerId: sibling.workerId,
      status: 'accepted',
      assignment: sibling,
      artifacts,
      outputFolder: output,
      result: {
        taskId: sibling.id,
        outcome: 'completed',
        summary: 'Protocol sibling.',
        artifacts: [{ path: 'evidence.txt', kind: 'fixture' }],
        checks: [],
        issues: [],
        handoff: 'Fixture only.',
      },
    },
    { text: 'Fixture', hash: hash('fixture') },
  );
  store.putTask({ ...sibling, status: 'done', acceptedAttemptId: id, lastAttemptId: id });
  const second = changeScope(store, store.task(ids[1]), c.root);
  assert.deepEqual(second.allowedFiles, ['src/core/projects.mjs']);
  assert.equal(second.proposalReference.hash, planning.artifacts[0].hash);
  assert.deepEqual(
    second.acceptedInputs,
    ['breakdown-task', 'checked-task', ids[0]].map(taskId => acceptedReference(store, taskId)),
  );
  const borrowed = { ...second, allowedFiles: second.allowedFiles };
  assert.throws(
    () =>
      stagedChanges(
        borrowed,
        {
          taskId: ids[1],
          outcome: 'completed',
          summary: 'Attempt borrowing scope',
          artifacts: [{ path: 'changes/src/core/workflows.mjs', kind: 'source-file' }],
          checks: [],
          issues: [],
          handoff: '',
        },
        () => Buffer.from('// altered'),
      ),
    /exceed the approved file scope/,
  );
  fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// integrated first story\n');
  git(c.root, ['commit', '--quiet', '-am', 'Integrated first story']);
  assert.deepEqual(
    changeScope(store, store.task(ids[1]), c.root).allowedFiles,
    ['src/core/projects.mjs'],
    'A disjoint next story retains its own recorded file evidence.',
  );
  // An uncommitted edit to a listed file stops the story; once committed on the branch it does not (MP-021).
  fs.appendFileSync(path.join(c.root, 'src/core/projects.mjs'), '// overlap by hand\n');
  assert.throws(
    () => changeScope(store, store.task(ids[1]), c.root),
    /the changes are not committed: src\/core\/projects\.mjs\. Commit or discard them/,
  );
  git(c.root, ['commit', '--quiet', '-am', 'Overlap by hand']);
  assert.deepEqual(changeScope(store, store.task(ids[1]), c.root).allowedFiles, ['src/core/projects.mjs']);
  // A listed file that is gone still stops it, committed or not.
  git(c.root, ['rm', '--quiet', 'src/core/projects.mjs']);
  git(c.root, ['commit', '--quiet', '-m', 'Remove by hand']);
  assert.throws(
    () => changeScope(store, store.task(ids[1]), c.root),
    /^Error: Approved source files no longer exist: src\/core\/projects\.mjs\. Request fresh measured evidence and a new breakdown\.$/,
  );
});

test('breakdown source identity errors name the exact recorded values and distinguish staged copies', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { data, planning } = await c.breakdown(),
    source = planning.sourceBreakdown;
  assert.equal(validateBreakdown(data, source), data);
  for (const key of ['taskId', 'attemptId', 'path', 'hash', 'sourceHash', 'contextPath', 'contextHash']) {
    await t.test(key, () => {
      const altered = structuredClone(data);
      altered.source[key] =
        key === 'path'
          ? `../inputs/${source.taskId}/0-check-report.json`
          : key === 'contextPath'
            ? `../inputs/${source.taskId}/3-source-context.json`
            : `${source[key]}-different`;
      assert.throws(
        () => validateBreakdown(altered, source),
        error => {
          assert.ok(error.message.includes(`source.${key} must be ${source[key]}`), error.message);
          assert.match(error.message, /recorded accepted source-check evidence/);
          if (key === 'path' || key === 'contextPath')
            assert.match(
              error.message,
              /recorded artifact file name, not the location of its staged copy under \.\.\/inputs/,
            );
          return true;
        },
      );
    });
  }
  const corrected = structuredClone(data);
  corrected.source.path = `../inputs/${source.taskId}/0-check-report.json`;
  corrected.source.contextPath = `../inputs/${source.taskId}/3-source-context.json`;
  assert.throws(() => validateBreakdown(corrected, source), /source\.path must be check-report\.json/);
  corrected.source.path = 'check-report.json';
  assert.throws(() => validateBreakdown(corrected, source), /source\.contextPath must be source-context\.json/);
  corrected.source.contextPath = 'source-context.json';
  assert.deepEqual(corrected.source, data.source, 'Correcting the file names preserves every other identity.');
  assert.equal(validateBreakdown(corrected, source), corrected);
  for (const malformed of [undefined, null, [], 'check-report.json', 42])
    assert.throws(
      () => validateBreakdown({ ...data, source: malformed }, source),
      /Breakdown source contains unsupported fields/,
    );
  assert.throws(
    () => validateBreakdown({ ...data, source: { ...data.source, extra: true } }, source),
    /Breakdown source contains unsupported fields/,
  );
  const missing = structuredClone(data);
  delete missing.source.contextHash;
  assert.throws(
    () => validateBreakdown(missing, source),
    error => error.message.includes(`source.contextHash must be ${source.contextHash}`),
  );
});

test('breakdown instructions explain both recorded artifact file names versus staged input locations', () => {
  const registries = createRegistries(),
    definition = registries.workflows.get('studio-development:breakdown'),
    instructions = definition.instructions({ org: { workers: [] } }),
    contract = instructions.layers.find(layer => layer.title === 'Source breakdown contract').text;
  for (const [field, file, staged] of [
    ['path', 'check-report.json', '0-check-report.json'],
    ['contextPath', 'source-context.json', '3-source-context.json'],
  ]) {
    assert.ok(
      contract.includes(
        `For source.${field}, use the recorded artifact file name (currently ${file}), not the location of its staged copy under ../inputs (such as ../inputs/<task>/${staged}).`,
      ),
      `The generated instructions must distinguish source.${field} from its staged-copy location.`,
    );
  }
  const wrapper = registries.adapters.get(definition.executionAdapter),
    runtime = { adapters: registries.adapters },
    workspace = wrapper.deliveryScope({ provider: 'claude', mode: 'workspace' }, runtime),
    text = wrapper.deliveryScope({ provider: 'claude', mode: 'text' }, runtime);
  assert.match(workspace, /read and search.*\.\.\/source/);
  assert.match(workspace, /implementations, their callers and the tests asserting/);
  assert.match(text, /Plan from the supplied measured file list and source-context documents/);
  assert.ok(!text.includes('Before planning, read and search'));
  assert.ok(!contract.includes('Before planning, read and search'), 'File searching is delivery-specific.');
});

test("a breakdown's and a source review's instructions name the paths of the profile their check measured with", async t => {
  const registries = createRegistries(),
    fieldNotes = {
      ...studioDeskProfile,
      id: 'field-notes',
      directories: ['lib', 'spec'],
      extensions: ['js', 'md'],
      protectedNames: ['SECRETS.md'],
    },
    paths = /Use paths under lib or spec ending in \.js or \.md; never list SECRETS\.md, or any dot-path\./,
    store = {
      task: () => ({ acceptedAttemptId: 'attempt-check' }),
      attempt: () => ({ sourceCheck: { profile: fieldNotes } }),
    };
  for (const [kind, title] of [
    ['studio-development:breakdown', 'Source breakdown contract'],
    ['studio-development:review', 'Source review contract'],
  ]) {
    const text = registries.workflows
      .get(kind)
      .instructions({ org: { workers: [] }, task: { dependencies: ['T-check'] }, store })
      .layers.find(layer => layer.title === title).text;
    assert.match(text, paths);
    assert.doesNotMatch(text, /src, public, test, scripts or docs ending/);
  }
  // The controller composes a breakdown's instructions from its recorded check.
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { planning, checked } = await c.breakdown(),
    check = c.app.store.attempt(checked.id);
  c.app.store.updateAttempt({ ...check, sourceCheck: { ...check.sourceCheck, profile: fieldNotes } });
  const org = c.app.store.organization(),
    task = c.app.store.task(planning.taskId),
    composed = c.app.runner.instructionContext(
      org,
      org.workers.find(worker => worker.id === task.workerId),
      task,
    );
  assert.match(composed.layers.find(layer => layer.title === 'Source breakdown contract').text, paths);
});

test('breakdown source scope rejects absent or altered keys, evidence and recorded source hashes', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { ids, planning, checked } = await c.breakdown();
  assert.equal((await c.request(`/api/tasks/${ids[0]}/approve-work`)).status, 200);
  const task = store.task(ids[0]);
  for (const key of [undefined, 'missing', 'project']) {
    const altered = structuredClone(task);
    altered.proposalReference.key = key;
    assert.throws(() => changeScope(store, altered, c.root), /breakdown identity|proposalReference.key/);
  }
  for (const [attempt, name] of [
    [planning, 'source-breakdown.json'],
    [checked, 'check-report.json'],
    [checked, 'source-context.json'],
    [checked, 'test-output.txt'],
  ]) {
    const file = path.join(attempt.outputFolder, name),
      bytes = fs.readFileSync(file);
    fs.appendFileSync(file, ' ');
    assert.throws(() => changeScope(store, task, c.root), /modified after acceptance/);
    fs.writeFileSync(file, bytes);
  }
  const missingCheck = structuredClone(task);
  missingCheck.acceptedInputs = missingCheck.acceptedInputs.filter(ref => ref.taskId !== checked.taskId);
  assert.throws(() => changeScope(store, missingCheck, c.root), /pin the exact accepted breakdown and measured check/);
  const original = store.attempt(planning.id),
    altered = structuredClone(original);
  altered.sourceBreakdown.files[0].hash = hash('forged file identity');
  store.updateAttempt(altered);
  assert.throws(() => changeScope(store, task, c.root), /identities changed/);
  store.updateAttempt(original);
  const checkTask = store.task(checked.taskId);
  store.putTask({ ...checkTask, status: 'review' });
  assert.throws(() => changeScope(store, task, c.root), /accepted attempts/);
  store.putTask(checkTask);
  const fixture = store.attempt(checked.id);
  fixture.checkExecution.fixture = true;
  store.updateAttempt(fixture);
  assert.throws(() => changeScope(store, task, c.root), /not fixture evidence/);
  assert.equal(store.attempts(ids[0]).length, 0);
});

test('a linked story waits for its prerequisite to be integrated, then runs on the committed source', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { ids, planning, checked } = await c.breakdown();
  assert.deepEqual(store.task(ids[1]).waitsFor, { [ids[0]]: 'integrated' });
  for (const id of ids) approveWork(store, c.app.runner.registries, store.task(id));
  c.app.runner.start(ids[0]);
  const first = await c.wait(ids[0]);
  assert.deepEqual(first.sourceChange.allowedFiles, ['src/core/workflows.mjs']);
  assert.equal(first.sourceChange.proposalReference.key, 'workflow');
  assert.deepEqual(
    first.inputReferences.map(ref => ref.attemptId),
    [planning.id, checked.id],
  );
  c.measuredFixture(first);
  acceptAttempt(store, c.app.runner.registries, store.task(ids[0]));
  c.app.runner.autonomy.accepted(ids[0]);
  const review = await c.wait(ids[0]);
  assert.equal(review.assignment.kind, 'studio-development:change-review');
  acceptAttempt(store, c.app.runner.registries, store.task(ids[0]));
  // An accepted prerequisite is not enough: the dependent waits for its committed change.
  const queued = c.app.runner.queueStart(ids[1]);
  assert.deepEqual(queued, {
    ok: true,
    queued: true,
    reason: `Waiting for ${ids[0]} to be integrated.`,
  });
  assert.equal(store.attempts(ids[1]).length, 0);
  c.integrated(ids[0], review, 'src/core/workflows.mjs', '// Integrated workflow change\n');
  c.app.runner.schedule();
  const second = await c.wait(ids[1]);
  assert.deepEqual(second.sourceChange.allowedFiles, ['src/core/projects.mjs']);
  assert.equal(second.sourceChange.proposalReference.key, 'project');
  assert.deepEqual(
    new Set(second.inputReferences.map(ref => ref.attemptId)),
    new Set([planning.id, checked.id, review.id]),
  );
  assert.deepEqual(
    second.sourceChange.acceptedInputs.map(ref => [ref.taskId, ref.attemptId]),
    [
      ['breakdown-task', planning.id],
      ['checked-task', checked.id],
      [ids[0], review.id],
    ],
  );
  assert.equal(store.leases().length, 0);
});

test('a story accepts a file its integrated prerequisite changed, but not an uncommitted edit', async t => {
  for (const drift of [false, true]) {
    const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
      store = c.app.store,
      { ids } = await c.breakdown([
        { files: ['src/core/workflows.mjs'], dependencies: [] },
        { files: ['src/core/workflows.mjs'], dependencies: ['workflow'] },
      ]);
    // As in practice, only the prerequisite is approved before it runs.
    approveWork(store, c.app.runner.registries, store.task(ids[0]));
    c.app.runner.start(ids[0]);
    const { review } = await c.toReview(ids[0]);
    c.integrated(ids[0], review, 'src/core/workflows.mjs', '// Integrated by the prerequisite\n');
    if (drift) fs.writeFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// Changed by someone else\n');
    if (drift) {
      // A stale scope is a real problem, not a wait: approval and Start both refuse it.
      assert.throws(
        () => approveWork(store, c.app.runner.registries, store.task(ids[1])),
        /changed since the breakdown, and the changes are not committed: src\/core\/workflows\.mjs\./,
      );
      assert.equal(store.task(ids[1]).approval.status, 'pending');
      assert.equal(store.attempts(ids[1]).length, 0);
    } else {
      approveWork(store, c.app.runner.registries, store.task(ids[1]));
      c.app.runner.queueStart(ids[1]);
      const second = await c.wait(ids[1]);
      assert.deepEqual(second.sourceChange.allowedFiles, ['src/core/workflows.mjs']);
    }
  }
});

test('a story accepts a file any integrated story changed, not only its prerequisites (MP-016 slice 4)', async t => {
  for (const create of [false, true]) {
    const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
      store = c.app.store,
      // Two independent stories from one breakdown; the second never waits for the first.
      { ids } = await c.breakdown([
        { files: ['src/core/workflows.mjs'], newFiles: ['src/core/created.mjs'], dependencies: [] },
        {
          files: ['src/core/workflows.mjs'],
          ...(create ? { newFiles: ['src/core/created.mjs'] } : {}),
          dependencies: [],
        },
      ]);
    assert.equal(store.task(ids[1]).waitsFor, undefined);
    approveWork(store, c.app.runner.registries, store.task(ids[0]));
    c.app.runner.start(ids[0]);
    const { review } = await c.toReview(ids[0]);
    const integrated = '// Integrated by an independent story\n';
    c.integrated(ids[0], review, {
      'src/core/workflows.mjs': integrated,
      'src/core/created.mjs': 'export const created = 1;\n',
    });
    if (create) {
      // Only a prerequisite's new file becomes an edit; another story's file at that path is a conflict.
      assert.throws(
        () => approveWork(store, c.app.runner.registries, store.task(ids[1])),
        /src\/core\/created\.mjs now exists or collides with an existing path, so it cannot be created\. Request fresh measured evidence/,
      );
      continue;
    }
    approveWork(store, c.app.runner.registries, store.task(ids[1]));
    // Since MP-021 a hand commit on the branch counts like an integrated change; an uncommitted
    // edit does not, and the refusal names the file.
    const target = path.join(c.root, 'src/core/workflows.mjs'),
      byHand = integrated + '// Changed by hand after the integration\n';
    fs.writeFileSync(target, byHand);
    assert.throws(
      () => changeScope(store, store.task(ids[1]), c.root),
      /^Error: Approved source files changed since the breakdown, and the changes are not committed: src\/core\/workflows\.mjs\. Commit or discard them in the development copy, then try again\.$/,
    );
    git(c.root, ['commit', '--quiet', '-am', 'Hand edit']);
    c.app.runner.start(ids[1]);
    const second = await c.wait(ids[1]);
    assert.deepEqual(second.sourceChange.allowedFiles, ['src/core/workflows.mjs']);
    // The editor starts from the committed bytes: the other story's change and the hand edit.
    assert.equal(
      second.sourceChange.source.files.find(item => item.path === 'src/core/workflows.mjs').hash,
      hash(byHand),
    );
    assert.ok(
      fs.readFileSync(path.join(second.outputFolder, 'changes/src/core/workflows.mjs'), 'utf8').startsWith(byHand),
    );
  }
});

test('one source story holds the live source from its first edit until it is integrated', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]);
  for (const id of ids) approveWork(store, c.app.runner.registries, store.task(id));
  c.app.runner.start(ids[0]);
  const { review } = await c.toReview(ids[0]);
  // Waiting for integration still holds the source; the independent story is queued behind it.
  const queued = c.app.runner.queueStart(ids[1]);
  assert.equal(queued.queued, true);
  assert.equal(
    queued.reason,
    `Waiting for ${ids[0]} (“Refine workflow fixture”) to be integrated: source stories run one at a time.`,
  );
  assert.equal(store.attempts(ids[1]).length, 0);
  c.integrated(ids[0], review, 'src/core/workflows.mjs', '// Integrated\n');
  c.app.runner.schedule();
  const second = await c.wait(ids[1]);
  assert.deepEqual(second.sourceChange.allowedFiles, ['src/core/projects.mjs']);
});

test('a tier set on a story applies to its edit; its independent review keeps the review default', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]);
  store.putTask({ ...store.task(ids[0]), tier: 'light' });
  approveWork(store, c.app.runner.registries, store.task(ids[0]));
  c.app.runner.start(ids[0]);
  const { edit, review } = await c.toReview(ids[0]);
  assert.equal(edit.requestedTier, 'light');
  assert.equal(review.assignment.kind, 'studio-development:change-review');
  assert.equal(review.requestedTier, 'standard');
});

test('closing a story that will not be integrated keeps its records and lets the next story have the source', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    registries = c.app.runner.registries,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]);
  for (const id of ids) approveWork(store, registries, store.task(id));
  c.app.runner.start(ids[0]);
  const { review } = await c.toReview(ids[0]);
  assert.equal(c.app.runner.queueStart(ids[1]).queued, true);
  // A recorded integration must be reconciled before the story can be closed.
  const recorded = store.attempt(review.id);
  recorded.sourceIntegration = { id: 'source-integration:' + review.id, state: 'needs-reconciliation' };
  store.updateAttempt(recorded);
  c.app.runner.autonomy.attention(store.task(ids[0]), 'Reconcile the recorded source integration.');
  assert.throws(
    () => closeStartedWork(store, registries, store.task(ids[0]), 'Not integrating it.'),
    /Reconcile the recorded source integration before closing this story/,
  );
  assert.equal(store.task(ids[0]).autonomyNote, 'Reconcile the recorded source integration.');
  recorded.sourceIntegration.state = 'rejected';
  store.updateAttempt(recorded);
  closeStartedWork(store, registries, store.task(ids[0]), 'Not integrating it.');
  const story = store.task(ids[0]);
  assert.equal(story.status, 'denied');
  assert.equal(story.autonomyNote, undefined);
  assert.equal(story.reason, 'Not integrating it.');
  assert.equal(story.sourceStage.reason, 'Not integrating it.');
  assert.equal(story.closed.status, 'done');
  assert.equal(story.sourceStage.current, 'closed');
  assert.equal(story.acceptedAttemptId, review.id, 'The accepted review stays recorded.');
  assert.equal(store.attempt(review.id).status, 'accepted');
  assert.throws(
    () => sourceIntegrationTarget(store, story, review.id, review.artifacts[0].hash),
    /exact accepted passing current candidate review/,
  );
  c.app.runner.schedule();
  const second = await c.wait(ids[1]);
  assert.deepEqual(second.sourceChange.allowedFiles, ['src/core/projects.mjs']);
  // An integrated story is finished; closing it is refused.
  const { review: secondReview } = await c.toReview(ids[1]);
  c.integrated(ids[1], secondReview, 'src/core/projects.mjs', '// Integrated\n');
  assert.throws(() => closeStartedWork(store, registries, store.task(ids[1])), /Accepted work is final/);
});

test('approved source work stages isolated edits, retains exact scope, checks a candidate and waits for independent acceptance and explicit integration', async t => {
  const c = await setup(t),
    before = sourcePlan(c.root);
  await c.start();
  const a = await c.wait(c.taskId),
    store = c.app.store;
  assert.equal(sourcePlan(c.root).sourceHash, before.sourceHash);
  assert.equal(a.provider, 'source-change');
  assert.equal(a.configuration.executionAdapter, 'source-change');
  assert.equal(a.sessionId, 'source-edit-fixture-session');
  assert.equal(a.checkExecution.fixture, true);
  assert.equal(a.sourceEditExecution.fixture, true);
  assert.equal(a.sourceChange.proposalReference.hash, store.attempt('review-attempt').artifacts[0].hash);
  assert.ok(a.controllerChecks.some(check => check.name === 'Source change scope and candidate provenance'));
  assert.equal(store.leases().length, 0);
  const read = name => fs.readFileSync(path.join(a.outputFolder, name));
  assert.equal(validateSourceChange(a, read).report.passed, true);
  assert.equal(JSON.parse(read('source-change.json')).diffFormat, 'unified-full-deletions-v1');
  // The approved proposal travels with the candidate so the independent reviewer can check scope.
  const approvedScope = JSON.parse(read('source-scope.json'));
  assert.deepEqual(approvedScope, {
    proposal: a.sourceChange.proposalReference,
    allowedFiles: a.sourceChange.allowedFiles,
    newFiles: [],
    deleteFiles: [],
    scope: a.sourceChange.proposal,
  });
  assert.ok(a.artifacts.some(item => item.path === 'source-scope.json' && item.kind === 'source-scope'));
  // Candidates from before it was registered still validate; a registered scope must be the recorded one.
  const earlier = { ...a, artifacts: a.artifacts.filter(item => item.path !== 'source-scope.json') };
  assert.equal(validateSourceChange(earlier, read).report.passed, true);
  const altered = name =>
    name === 'source-scope.json' ? Buffer.from(JSON.stringify({ ...approvedScope, allowedFiles: [] })) : read(name);
  assert.throws(() => validateSourceChange(a, altered), /approved source scope does not match/);
  // The change is recorded as a diff for the reviewer (MP-016 slice 2), not as before/after copies.
  assert.ok(a.artifacts.some(item => item.path === 'change.diff' && item.kind === 'source-change-diff'));
  assert.equal(
    a.artifacts.some(item => item.path === 'change-context.json'),
    false,
  );
  assert.equal(
    read('change.diff').toString(),
    'diff --git a/src/core/workflows.mjs b/src/core/workflows.mjs\n--- a/src/core/workflows.mjs\n+++ b/src/core/workflows.mjs\n' +
      '@@ -1 +1,3 @@\n // Fixture source: src/core/workflows.mjs\n+\n+// Bounded fixture improvement.\n',
  );
  const tampered = name =>
    name === 'change.diff' ? Buffer.from(read(name).toString().replace('+// Bounded', '+// Altered')) : read(name);
  assert.throws(() => validateSourceChange(a, tampered), /candidate diff does not match the recorded change/);
  // A candidate from before diffs, with before/after copies and the earlier scope document, still
  // validates, and its reviewer still receives every artifact.
  const { diffFormat, ...legacyManifest } = JSON.parse(read('source-change.json')),
    legacyManifestBytes = Buffer.from(JSON.stringify(legacyManifest)),
    { newFiles, deleteFiles, ...olderScope } = a.sourceChange,
    context = JSON.stringify([
      {
        path: 'src/core/workflows.mjs',
        before: fs.readFileSync(path.join(c.root, 'src/core/workflows.mjs'), 'utf8'),
        after: read('changes/src/core/workflows.mjs').toString(),
      },
    ]),
    older = {
      ...a,
      sourceChange: olderScope,
      artifacts: a.artifacts.map(item =>
        item.path === 'source-change.json'
          ? { ...item, hash: hash(legacyManifestBytes), bytes: legacyManifestBytes.length }
          : item.path === 'change.diff'
            ? { path: 'change-context.json', kind: 'source-change-context', hash: hash(context) }
            : item,
      ),
    },
    olderRead = name =>
      name === 'source-change.json'
        ? legacyManifestBytes
        : name === 'change-context.json'
          ? Buffer.from(context)
          : name === 'source-scope.json'
            ? Buffer.from(
                JSON.stringify({
                  proposal: approvedScope.proposal,
                  allowedFiles: approvedScope.allowedFiles,
                  scope: approvedScope.scope,
                }),
              )
            : read(name);
  assert.deepEqual([newFiles, deleteFiles], [[], []]);
  assert.equal(validateSourceChange(older, olderRead).report.passed, true);
  assert.equal(hash(olderRead('source-change.json')), hash(legacyManifestBytes));
  assert.equal(hash(olderRead('change-context.json')), hash(context));
  assert.deepEqual(reviewedArtifacts(older), older.artifacts);
  assert.throws(
    () => validateSourceChange(older, name => (name === 'source-change.json' ? read(name) : olderRead(name))),
    /Full-deletion candidates require change.diff/,
  );
  assert.equal(fs.existsSync(path.join(a.outputFolder, 'changes/AGENTS.md')), false);
  assert.equal(store.task(c.taskId).proposedTaskIds, undefined);
  assert.equal(store.task(c.taskId).sourceStage.current, 'implementing');
  const reviewId = c.taskId,
    review = await c.review(a);
  assert.equal(
    store.tasks().some(task => task.kind === 'studio-development:change-review'),
    false,
  );
  assert.equal(review.taskId, a.taskId);
  assert.notEqual(review.id, a.id);
  assert.equal(review.workerId, 'W-07');
  assert.notEqual(review.workerId, a.workerId);
  assert.equal(review.assignment.kind, 'studio-development:change-review');
  assert.equal(store.task(c.taskId).kind, 'studio-development:change');
  // The reviewer receives the diff, scope, manifest and test evidence, not the changed files.
  const reviewed = review.inputReferences[0].artifacts;
  assert.ok(reviewed.some(item => item.kind === 'source-scope'));
  assert.ok(reviewed.some(item => item.kind === 'source-change-diff'));
  assert.equal(
    reviewed.some(item => item.kind === 'source-file'),
    false,
  );
  // Recorded inputs are the job-relative copies the reviewer received, and only those were staged.
  assert.deepEqual(
    fs.readdirSync(path.join(review.outputFolder, '..', 'inputs', a.taskId)).sort(),
    reviewed.map(item => path.basename(item.path)).sort(),
  );
  assert.equal(
    review.candidateReview.hash,
    store.attempt(a.id).artifacts.find(item => item.path === 'source-change.json').hash,
  );
  assert.equal(review.candidateReview.candidateHash, a.sourceCandidate.sourceHash);
  // The candidate records its diff's size for the dashboard, counted from the diff the reviewer reads.
  assert.deepEqual(
    a.sourceCandidate.diffStat,
    sourceDiffStat(fs.readFileSync(path.join(a.outputFolder, 'change.diff'), 'utf8')),
  );
  assert.ok(a.sourceCandidate.diffStat.files > 0);
  assert.equal(store.task(c.taskId).sourceStage.current, 'candidate-review');
  assert.equal((await c.integration(review)).status, 400);
  await c.accept(reviewId);
  assert.equal(store.task(c.taskId).sourceStage.current, 'waiting-for-integration');
  assert.equal(
    (await c.request(`/api/tasks/${reviewId}/integrate-source`, { attemptId: review.id, reviewHash: hash('wrong') }))
      .status,
    400,
  );
  // From a separate development copy, integration by merge (MP-016) does not pause the studio and
  // changes the development copy only once the merged, formatted result passes the full suite.
  const head = git(c.root, ['rev-parse', 'HEAD']),
    result = await c.integration(review);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.state, 'verifying');
  assert.equal(result.data.method, 'merge');
  assert.equal(result.data.candidateCommit, a.sourceCandidate.commit);
  assert.equal(result.data.repository.head, head);
  assert.equal(result.data.worktree, path.join(store.directory, 'wt', 'i-' + review.id.slice(8, 16)));
  assert.equal(store.organization().paused, false);
  const journal = await c.settled(review);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal));
  assert.equal(journal.commit, journal.repository.commit);
  assert.equal(fs.existsSync(journal.worktree), false, 'The integration worktree is removed.');
  assert.equal(store.task(c.taskId).sourceStage.current, 'integrated');
  assert.equal(journal.verification.passed, true);
  assert.equal(journal.verification.fixture, true);
  const changed = journal.changes[0],
    integrated = fs.readFileSync(path.join(c.root, changed.path));
  assert.match(integrated.toString(), /\/\/ formatted\n$/, 'Formatted bytes are integrated.');
  assert.notEqual(changed.integratedHash, changed.afterHash);
  assert.equal(hash(integrated), changed.integratedHash);
  assert.equal(sourcePlan(c.root).sourceHash, journal.verification.sourceHash);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), journal.repository.commit);
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), head);
  assert.equal(git(c.root, ['status', '--porcelain', '--untracked-files=no']), '');
  const message = git(c.root, ['log', '-1', '--format=%B']);
  assert.ok(message.includes(`Change: ${c.taskId} (${a.id})`), message);
  assert.ok(message.includes(`Candidate review: ${reviewId} (${review.id}), verdict pass`), message);
  assert.ok(message.includes('1/1 tests passed on the formatted source (protocol fixture)'), message);
  assert.ok(message.includes(`Studio-Integration: source-integration:${review.id}`), message);
  assert.deepEqual(git(c.root, ['show', '--name-only', '--format=', 'HEAD']).split('\n'), [changed.path]);
  assert.equal(store.leases().length, 0);
  assert.ok(
    store
      .events()
      .some(
        event => event.kind === 'source_integrated' && event.message.includes(journal.repository.commit.slice(0, 7)),
      ),
  );
  assert.equal(
    (await c.integration(review)).data.state,
    'integrated',
    'Repeated integration does not replay source writes.',
  );
  assert.equal(store.attempt(a.id).instructions.hash, a.instructions.hash);
});

test('a Claude employee edits in its workspace with its own tools; the controller tests, reviews and integrates the same candidate', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], { claudeBinary: claudeFixture }),
    store = c.app.store,
    before = sourcePlan(c.root);
  const org = store.organization();
  Object.assign(
    org.workers.find(worker => worker.id === store.task(c.taskId).workerId),
    { provider: 'claude', model: 'opus', effort: 'high' },
  );
  org.agentPermissions = { auto: false, commands: ['node --test'] };
  store.setOrganization(org);
  await c.start();
  const a = await c.wait(c.taskId);
  assert.equal(a.provider, 'source-change', 'One source-change adapter serves every model.');
  assert.equal(a.configuration.executionAdapter, 'source-change');
  assert.equal(a.configuration.model, 'claude');
  assert.equal(a.configuration.mode, 'workspace', "Claude's default mode uses its configured tools.");
  // The editing CLI runs with the director's approved commands (v1.0 item 22).
  assert.deepEqual(a.configuration.permissions, {
    mode: 'acceptEdits',
    autoFrom: 'settings',
    commands: ['node --test'],
    tools: [employeeTestsCommand],
  });
  const editorArgs = JSON.parse(fs.readFileSync(path.join(a.outputFolder, '..', 'fixture-args.json'), 'utf8'));
  assert.equal(editorArgs[editorArgs.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(editorArgs.includes('Bash(node --test *)'));
  assert.equal(a.requestedEffort, 'high');
  assert.match(a.delivery, /administrator configured/);
  assert.equal(a.sessionId, 'fixture-claude-session');
  assert.equal(sourcePlan(c.root).sourceHash, before.sourceHash, 'Live source is untouched until integration.');
  assert.match(
    fs.readFileSync(path.join(a.outputFolder, 'changes/src/core/workflows.mjs'), 'utf8'),
    /Claude fixture edit/,
  );
  const read = name => fs.readFileSync(path.join(a.outputFolder, name));
  assert.equal(validateSourceChange(a, read).report.passed, true);
  assert.ok(store.events().some(event => event.attempt_id === a.id && /Claude Code CLI stopped/.test(event.message)));
  assert.equal(store.leases().length, 0);
  // The independent candidate review still runs on its own employee's CLI (Codex fixture here).
  const review = await c.review(a);
  assert.equal(review.provider, 'codex');
  await c.accept(review.taskId);
  await c.request('/api/control', { paused: true });
  assert.equal((await c.integration(review)).status, 200);
  assert.equal((await c.settled(review)).state, 'integrated');
  assert.match(fs.readFileSync(path.join(c.root, 'src/core/workflows.mjs'), 'utf8'), /Claude fixture edit/);
});

test("a Claude editor runs the project's tests on its edits through the controller, only while it edits", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], { claudeBinary: claudeFixture }),
    store = c.app.store,
    before = sourcePlan(c.root);
  const org = store.organization();
  Object.assign(
    org.workers.find(worker => worker.id === store.task(c.taskId).workerId),
    { provider: 'claude' },
  );
  store.setOrganization(org);
  await c.start('run-tests');
  const a = await c.wait(c.taskId);
  assert.deepEqual(a.configuration.permissions.tools, [employeeTestsCommand]);
  const [focused, unknown] = JSON.parse(fs.readFileSync(path.join(a.outputFolder, '..', 'fixture-tests.json'), 'utf8'));
  // The named test ran on a copy of the story's source carrying the staged edit, with the check fixture.
  assert.equal(focused.status, 0, focused.stderr);
  assert.match(focused.stdout, /^ok 1 - process fixture$/m);
  assert.match(focused.stdout, /^# edited: true$/m);
  assert.match(focused.stdout, /1\/1 tests passed on your edits, as a protocol fixture\./);
  // Only the project's own test files can be named.
  assert.equal(unknown.status, 2);
  assert.match(
    unknown.stderr,
    /Not test files of this project: src\/core\/workflows\.mjs\. Test files: test\/bounded\.test\.mjs/,
  );
  assert.deepEqual(
    a.employeeTestRuns.map(run => [run.files, run.exitCode, run.totals.pass]),
    [[['test/bounded.test.mjs'], 0, 1]],
  );
  assert.ok(
    store.events().some(event => event.attempt_id === a.id && /ran the tests on its edits: 1\/1/.test(event.message)),
  );
  assert.equal(fs.existsSync(path.join(c.options.directory, 'tests', a.id.slice(-8))), false, 'The copy is removed.');
  // Once the editor stopped, its endpoint is closed, and the dashboard's token never opened it.
  for (const headers of [{ 'X-Studio-Attempt-Token': 'guess' }, { 'X-Studio-Token': c.token }]) {
    const response = await fetch(`${c.origin}/api/attempts/${a.id}/tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });
    assert.equal(response.status, 403);
  }
  // The candidate is tested again as before, and the live source is untouched.
  assert.equal(validateSourceChange(a, name => fs.readFileSync(path.join(a.outputFolder, name))).report.passed, true);
  assert.equal(sourcePlan(c.root).sourceHash, before.sourceHash);
});

test('a newly registered model adapter edits source through the contract with no step changes', async t => {
  // A test-only model with text delivery and no CLI: it answers its own prompt.
  const registries = createRegistries(),
    prompts = [];
  registries.adapters.register({
    id: 'fixture-model',
    version: 'fixture-model-v1',
    name: 'Fixture model',
    workerSelectable: true,
    capabilities: ['text-output'],
    modes: ['text'],
    status: () => ({ available: true, label: 'Test-only model' }),
    blockReason: () => '',
    configuration: (runtime, worker) => structuredClone(worker),
    requestedModel: () => 'fixture',
    delivery: 'Prompt in, files out.',
    deliveryScope: 'No native tools are granted.',
    start() {
      throw new Error('Only the contract is exercised here.');
    },
    run(runtime, entry, worker, { editable, context, onComplete }) {
      const prompt = textPrompt(entry, { name: 'Fixture model', editable, context });
      prompts.push(prompt);
      const files = editable.map(file => ({
        path: file,
        content: fs.readFileSync(path.join(entry.output, file), 'utf8') + '// Fixture model edit.\n',
      }));
      const result = stageTextDelivery(
        {
          files,
          result: {
            taskId: entry.attempt.taskId,
            outcome: 'completed',
            summary: 'Fixture model edit.',
            artifacts: files.map(file => ({ path: file.path, kind: 'source-file' })),
            checks: [],
            issues: [],
            handoff: 'Review the candidate.',
          },
        },
        entry,
        { editable },
      );
      setImmediate(() => onComplete(result, 0, null));
    },
  });
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], { registries }),
    store = c.app.store,
    org = store.organization();
  org.workers.find(worker => worker.id === store.task(c.taskId).workerId).provider = 'fixture-model';
  store.setOrganization(org);
  await c.start();
  const a = await c.wait(c.taskId);
  assert.equal(a.configuration.model, 'fixture-model');
  assert.equal(a.configuration.mode, 'text');
  assert.match(prompts[0], /source-scope\.json/, 'Read-only context reaches a text model.');
  assert.match(prompts[0], /Return only changed files/);
  assert.match(fs.readFileSync(path.join(a.outputFolder, 'changes/src/core/workflows.mjs'), 'utf8'), /Fixture model/);
  const read = name => fs.readFileSync(path.join(a.outputFolder, name));
  assert.equal(validateSourceChange(a, read).report.passed, true);
});

test('a Claude source edit outside the approved files fails before candidate tests run', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], { claudeBinary: claudeFixture }),
    store = c.app.store;
  const org = store.organization();
  // Text mode (the hardened option) proposes the files; the controller rejects the scope.
  Object.assign(
    org.workers.find(worker => worker.id === store.task(c.taskId).workerId),
    { provider: 'claude', mode: 'text' },
  );
  store.setOrganization(org);
  await c.start('escape-scope');
  const a = await c.wait(c.taskId, 'failed');
  assert.match(a.error, /approved file scope/);
  assert.equal(a.checkExecution, undefined);
  assert.equal(store.leases().length, 0);
  assert.equal(fs.existsSync(a.sourceWorktree.path), false, 'A failed edit removes its worktree.');
});

test('a candidate is built, committed and tested in its own worktree from the story base commit (MP-016)', async t => {
  const c = await setup(t),
    store = c.app.store,
    head = git(c.root, ['rev-parse', 'HEAD']),
    worktrees = path.join(store.directory, 'wt');
  // A worktree left by an attempt with no record is removed before the next one is created.
  fs.mkdirSync(path.join(worktrees, 'deadbeef'), { recursive: true });
  await c.start();
  const a = await c.wait(c.taskId);
  assert.equal(a.sourceChange.base.commit, head);
  assert.equal(a.sourceWorktree.baseCommit, head);
  assert.equal(path.dirname(a.sourceWorktree.path), fs.realpathSync(worktrees));
  assert.equal(path.basename(a.sourceWorktree.path), a.id.slice('attempt-'.length, 'attempt-'.length + 8));
  assert.equal(a.sourceCandidate.root, a.sourceWorktree.path, 'Candidate tests ran in the worktree.');
  // The candidate is one commit on the base, holding only the approved edit, kept by a ref.
  const commit = a.sourceCandidate.commit;
  assert.equal(git(c.root, ['rev-parse', `refs/studio/candidates/${a.id}`]), commit);
  assert.equal(git(c.root, ['rev-parse', `${commit}^`]), head);
  assert.equal(git(c.root, ['diff', '--name-only', head, commit]), 'src/core/workflows.mjs');
  assert.match(git(c.root, ['log', '-1', '--format=%B', commit]), new RegExp(`Studio-Candidate: ${a.id}`));
  assert.equal(
    git(c.root, ['show', `${commit}:src/core/workflows.mjs`]),
    fs.readFileSync(path.join(a.outputFolder, 'changes/src/core/workflows.mjs'), 'utf8').trim(),
  );
  // The development copy is untouched, and the finished attempt's worktree is gone.
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
  assert.equal(git(c.root, ['status', '--porcelain']), '');
  assert.equal(fs.existsSync(a.sourceWorktree.path), false);
  assert.equal(fs.existsSync(path.join(worktrees, 'deadbeef')), false);
  assert.equal(
    git(c.root, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter(line => line.startsWith('worktree ')).length,
    1,
  );
});

test('a source story does not start while its snapshot paths hold work git does not track', async t => {
  const c = await setup(t),
    start = () => c.request(`/api/tasks/${c.taskId}/start`);
  fs.writeFileSync(path.join(c.root, 'docs/draft.md'), 'Work in progress\n');
  let result = await start();
  assert.equal(result.status, 400);
  assert.match(result.data.error, /git does not track.*docs\/draft\.md/);
  fs.rmSync(path.join(c.root, 'docs/draft.md'));
  fs.appendFileSync(path.join(c.root, 'docs/module-contracts.md'), 'Unsaved note\n');
  result = await start();
  assert.equal(result.status, 400);
  assert.match(result.data.error, /Commit or stash tracked changes.*before a source story starts/);
  git(c.root, ['checkout', '--', 'docs/module-contracts.md']);
  // Files outside the snapshot paths never reach a candidate, so they do not hold a story.
  fs.writeFileSync(path.join(c.root, 'notes.txt'), 'Outside the snapshot\n');
  await c.start();
  await c.wait(c.taskId);
});

test('a story creates and deletes the files its scope lists; the reviewer reads their diff and integration lands them (MP-016)', async t => {
  const c = await setup(t, 'pass', {
      files: ['src/core/workflows.mjs'],
      newFiles: ['src/core/fresh/helper.mjs'],
      deleteFiles: ['docs/obsolete.md'],
    }),
    head = git(c.root, ['rev-parse', 'HEAD']);
  await c.start();
  const a = await c.wait(c.taskId),
    read = name => fs.readFileSync(path.join(a.outputFolder, name));
  assert.deepEqual(
    [a.sourceChange.allowedFiles, a.sourceChange.newFiles, a.sourceChange.deleteFiles],
    [['src/core/workflows.mjs'], ['src/core/fresh/helper.mjs'], ['docs/obsolete.md']],
  );
  // A created file has no original and a deleted one no result; the employee returned no copy of it.
  assert.deepEqual(
    JSON.parse(read('source-change.json')).changes.map(item => [
      item.path,
      item.beforeHash,
      item.afterHash,
      item.artifact,
    ]),
    [
      ['docs/obsolete.md', hash('// Fixture source: docs/obsolete.md\n'), null, undefined],
      [
        'src/core/fresh/helper.mjs',
        null,
        hash(read('changes/src/core/fresh/helper.mjs')),
        'changes/src/core/fresh/helper.mjs',
      ],
      [
        'src/core/workflows.mjs',
        hash('// Fixture source: src/core/workflows.mjs\n'),
        hash(read('changes/src/core/workflows.mjs')),
        'changes/src/core/workflows.mjs',
      ],
    ],
  );
  const diff = read('change.diff').toString();
  assert.ok(
    diff.startsWith(
      'diff --git a/docs/obsolete.md b/docs/obsolete.md\ndeleted file mode 100644\n--- a/docs/obsolete.md\n+++ /dev/null\n' +
        '@@ -1 +0,0 @@\n-// Fixture source: docs/obsolete.md\n' +
        'diff --git a/src/core/fresh/helper.mjs b/src/core/fresh/helper.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/src/core/fresh/helper.mjs\n' +
        '@@ -0,0 +1 @@\n+export const created = "src/core/fresh/helper.mjs";\n',
    ),
    diff,
  );
  const manifest = JSON.parse(read('source-change.json')),
    deletion = '@@ -1 +0,0 @@\n-// Fixture source: docs/obsolete.md\n';
  assert.equal(manifest.diffFormat, 'unified-full-deletions-v1');
  assert.equal(hash('// Fixture source: docs/obsolete.md\n'), manifest.changes[0].beforeHash);
  for (const alteredDiff of [
    diff.replace(deletion, ''),
    diff.replace('-// Fixture source: docs/obsolete.md', '-// Altered original'),
    diff.replace(deletion, deletion + '-extra\n'),
    diff.replace('@@ -1 +0,0 @@', '@@ -1,no +0,0 @@'),
  ])
    assert.throws(
      () => validateSourceChange(a, name => (name === 'change.diff' ? Buffer.from(alteredDiff) : read(name))),
      /candidate diff does not match the recorded change/,
    );
  assert.throws(
    () =>
      validateSourceChange(a, name =>
        name === 'source-change.json'
          ? Buffer.from(JSON.stringify({ ...manifest, diffFormat: 'unknown' }))
          : read(name),
      ),
    /Source candidate identity or change manifest is invalid/,
  );
  // Unmarked, header-only evidence retains its original validation path and bytes.
  const { diffFormat, ...legacyManifest } = manifest,
    legacyBytes = Buffer.from(JSON.stringify(legacyManifest)),
    legacyDiff = Buffer.from(diff.replace(deletion, '')),
    historical = {
      ...a,
      artifacts: a.artifacts.map(item =>
        item.path === 'source-change.json'
          ? { ...item, hash: hash(legacyBytes), bytes: legacyBytes.length }
          : item.path === 'change.diff'
            ? { ...item, hash: hash(legacyDiff), bytes: legacyDiff.length }
            : item,
      ),
    },
    historicalRead = name =>
      name === 'source-change.json' ? legacyBytes : name === 'change.diff' ? legacyDiff : read(name);
  assert.equal(validateSourceChange(historical, historicalRead).report.passed, true);
  assert.deepEqual(historicalRead('source-change.json'), legacyBytes);
  assert.deepEqual(historicalRead('change.diff'), legacyDiff);
  assert.equal(
    hash(historicalRead('change.diff')),
    historical.artifacts.find(item => item.path === 'change.diff').hash,
  );
  assert.deepEqual(
    reviewedArtifacts(historical),
    historical.artifacts.filter(item => item.kind !== 'source-file'),
  );
  // The candidate commit adds, modifies and deletes exactly those paths.
  assert.equal(
    git(c.root, ['diff', '--name-status', '--no-renames', head, a.sourceCandidate.commit]),
    'D\tdocs/obsolete.md\nA\tsrc/core/fresh/helper.mjs\nM\tsrc/core/workflows.mjs',
  );
  assert.ok(a.sourceCandidate.files.some(item => item.path === 'src/core/fresh/helper.mjs'));
  assert.equal(
    a.sourceCandidate.files.some(item => item.path === 'docs/obsolete.md'),
    false,
  );
  assert.equal(validateSourceChange(a, read).report.passed, true);
  const review = await c.review(a);
  assert.deepEqual(review.inputReferences[0].artifacts.map(item => item.path).sort(), [
    `../inputs/${c.taskId}/0-source-change.json`,
    `../inputs/${c.taskId}/1-source-scope.json`,
    `../inputs/${c.taskId}/2-change.diff`,
    `../inputs/${c.taskId}/3-check-report.json`,
    `../inputs/${c.taskId}/4-test-output.txt`,
    `../inputs/${c.taskId}/5-test-errors.txt`,
  ]);
  const registeredDiff = a.artifacts.find(item => item.path === 'change.diff'),
    reviewerDiff = review.inputReferences[0].artifacts.find(item => item.kind === 'source-change-diff'),
    reviewerBytes = fs.readFileSync(path.resolve(review.outputFolder, reviewerDiff.path));
  assert.equal(reviewerBytes.toString(), diff);
  assert.equal(reviewerDiff.hash, registeredDiff.hash);
  assert.equal(hash(reviewerBytes), registeredDiff.hash);
  await c.accept(c.taskId);
  assert.equal((await c.integration(review)).status, 200);
  const journal = await c.settled(review);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal));
  // The formatter fixture fails on a missing file, so it was given only the files that remain.
  assert.equal(fs.existsSync(path.join(c.root, 'docs/obsolete.md')), false);
  assert.match(
    fs.readFileSync(path.join(c.root, 'src/core/fresh/helper.mjs'), 'utf8'),
    /^export const created = .*\n\/\/ formatted\n$/,
  );
  assert.equal(
    git(c.root, ['show', '--name-status', '--format=', 'HEAD']),
    'D\tdocs/obsolete.md\nA\tsrc/core/fresh/helper.mjs\nM\tsrc/core/workflows.mjs',
  );
  assert.deepEqual(
    journal.changes.map(item => [item.path, item.integratedHash === null]),
    [
      ['docs/obsolete.md', true],
      ['src/core/fresh/helper.mjs', false],
      ['src/core/workflows.mjs', false],
    ],
  );
  assert.equal(git(c.root, ['status', '--porcelain']), '');
});

test('a new file must still be absent, and not ignored by git, when its story starts', async t => {
  const c = await setup(t, 'pass', { files: ['src/core/workflows.mjs'], newFiles: ['docs/notes/plan.md'] }),
    store = c.app.store,
    scope = () => changeScope(store, store.task(c.taskId), c.root);
  assert.deepEqual(scope().newFiles, ['docs/notes/plan.md']);
  fs.writeFileSync(path.join(c.root, '.gitignore'), 'docs/notes/\n');
  git(c.root, ['add', '.gitignore']);
  git(c.root, ['commit', '--quiet', '-m', 'Ignore notes']);
  assert.throws(scope, /git ignores docs\/notes\/plan\.md/);
  git(c.root, ['rm', '--quiet', '.gitignore']);
  git(c.root, ['commit', '--quiet', '-m', 'Stop ignoring notes']);
  fs.mkdirSync(path.join(c.root, 'docs/notes'));
  fs.writeFileSync(path.join(c.root, 'docs/notes/plan.md'), 'Written by hand\n');
  git(c.root, ['add', 'docs/notes/plan.md']);
  git(c.root, ['commit', '--quiet', '-m', 'Add the plan by hand']);
  assert.throws(scope, /docs\/notes\/plan\.md now exists or collides/);
  assert.equal(store.attempts(c.taskId).length, 0);
});

test('a story edits a new file its integrated prerequisite created; any other file there is a conflict', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], newFiles: ['src/core/created.mjs'], dependencies: [] },
      { files: [], newFiles: ['src/core/created.mjs'], dependencies: ['workflow'] },
    ]);
  assert.match(store.task(ids[1]).brief, /^New files: src\/core\/created\.mjs\n\n/);
  approveWork(store, c.app.runner.registries, store.task(ids[0]));
  c.app.runner.start(ids[0]);
  const { edit, review } = await c.toReview(ids[0]);
  assert.deepEqual(edit.sourceChange.newFiles, ['src/core/created.mjs']);
  c.integrated(ids[0], review, 'src/core/created.mjs', 'export const created = 1;\n');
  approveWork(store, c.app.runner.registries, store.task(ids[1]));
  const scope = changeScope(store, store.task(ids[1]), c.root);
  assert.deepEqual([scope.allowedFiles, scope.newFiles], [['src/core/created.mjs'], []]);
  fs.writeFileSync(path.join(c.root, 'src/core/created.mjs'), '// Written by hand\n');
  git(c.root, ['commit', '--quiet', '-am', 'Hand edit']);
  assert.throws(() => changeScope(store, store.task(ids[1]), c.root), /now exists or collides/);
});

test('a change whose diff is larger than a review reads fails before candidate tests', async t => {
  const c = await setup(t);
  await c.start('large');
  const a = await c.wait(c.taskId, 'failed');
  assert.match(a.error, /diff is \d+ KiB; a candidate review reads at most 192 KiB\. Split the story/);
  assert.equal(a.checkExecution, undefined);
  assert.equal(c.app.store.leases().length, 0);
});

test('an oversized deletion counts removed bytes and fails at the diff guard before candidate tests', async t => {
  const write = fs.writeFileSync,
    original = '// Removed original line.\n'.repeat(9000),
    fixture = t.mock.method(fs, 'writeFileSync', (file, contents, ...options) =>
      write(file, contents === '// Fixture source: docs/obsolete.md\n' ? original : contents, ...options),
    ),
    c = await setup(t, 'pass', { files: [], deleteFiles: ['docs/obsolete.md'] }, {}, true);
  fixture.mock.restore();
  const before = sourcePlan(c.root).sourceHash,
    head = git(c.root, ['rev-parse', 'HEAD']);
  assert.ok(Buffer.byteLength(original) > 192 * 1024);
  c.app.runner.start(c.taskId);
  const a = await c.wait(c.taskId, 'failed');
  assert.match(a.error, /diff is \d+ KiB; a candidate review reads at most 192 KiB\. Split the story/);
  assert.equal(a.checkExecution, undefined);
  assert.equal(a.sourceCandidate, undefined);
  assert.equal(
    phasePayloads(c.app.store, a.id).some(p => p.phaseId === 'test' || p.phaseId === 'candidate.commit'),
    false,
  );
  assert.equal(fs.readFileSync(path.join(c.root, 'docs/obsolete.md'), 'utf8'), original);
  assert.equal(sourcePlan(c.root).sourceHash, before);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
  assert.equal(c.app.store.leases().length, 0);
});

test('a story may change more files than text delivery returns; workspace delivery takes it', async t => {
  const files = Array.from({ length: 40 }, (_, i) => `src/parts/part-${i}.mjs`),
    c = await setup(t, 'pass', files, { claudeBinary: claudeFixture }),
    store = c.app.store,
    editor = mode => {
      const org = store.organization();
      Object.assign(
        org.workers.find(worker => worker.id === store.task(c.taskId).workerId),
        mode ? { provider: 'claude', mode } : { provider: 'codex' },
      );
      store.setOrganization(org);
    };
  editor('text');
  await c.start();
  const refused = await c.wait(c.taskId, 'failed');
  assert.match(
    refused.error,
    /lists 40 files to edit or create, and text delivery returns at most 30\. Use workspace delivery/,
  );
  assert.equal(refused.sourceWorktree, undefined, 'No worktree is created.');
  // A workspace editor returns all 40, and the candidate records them with its own evidence.
  editor();
  await c.start('multi');
  const a = await c.wait(c.taskId);
  assert.equal(a.artifacts.filter(item => item.kind === 'source-file').length, 40);
  assert.equal(a.artifacts.length, 46);
  assert.equal(validateSourceChange(a, name => fs.readFileSync(path.join(a.outputFolder, name))).report.passed, true);
});

test('source scope rejects stale files, unapproved work and changed proposal evidence before creating an attempt', async t => {
  const c = await setup(t),
    store = c.app.store,
    task = store.task(c.taskId);
  task.approval.status = 'pending';
  store.putTask(task);
  assert.equal((await c.request(`/api/tasks/${task.id}/start`)).status, 400);
  task.approval.status = 'approved';
  store.putTask(task);
  const target = path.join(c.root, 'src/core/workflows.mjs'),
    contents = fs.readFileSync(target);
  fs.appendFileSync(target, '// drift');
  assert.match(
    (await c.request(`/api/tasks/${task.id}/start`)).data.error,
    /changed since the proposal, and the changes are not committed: src\/core\/workflows\.mjs\. Commit or discard them/,
  );
  fs.writeFileSync(target, contents);
  const proposal = path.join(store.attempt('review-attempt').outputFolder, 'source-review.json');
  fs.appendFileSync(proposal, ' ');
  assert.match((await c.request(`/api/tasks/${task.id}/start`)).data.error, /modified/);
  assert.equal(store.attempts(task.id).length, 0);
  assert.equal(store.leases().length, 0);
});

test('out-of-scope edits, unchanged output and modified protected instructions fail without candidate execution', async t => {
  for (const mode of ['escape', 'noop', 'instructions', 'input']) {
    const c = await setup(t);
    await c.start(mode);
    const a = await c.wait(c.taskId, 'failed');
    assert.match(a.error, /scope|no change|Protected/);
    assert.equal(a.checkExecution, undefined);
    assert.equal(c.app.store.leases().length, 0);
    assert.equal(fs.readFileSync(path.join(c.root, 'src/core/workflows.mjs'), 'utf8').includes('improvement'), false);
  }
});

test('negative candidate tests remain evidence, reject a passing review and cannot authorize source integration', async t => {
  const c = await setup(t, 'fail');
  await c.start();
  const a = await c.wait(c.taskId);
  assert.ok(a.result.checks.some(check => check.status === 'fail'));
  const review = await c.review(a); // fixture incorrectly reports pass
  assert.equal(review.status, 'failed');
  assert.match(review.error, /exact candidate/);
  const negative = await setup(t, 'fail');
  await negative.start();
  const candidate = await negative.wait(negative.taskId),
    assessment = await negative.review(candidate, 'negative-review');
  await negative.accept(assessment.taskId);
  await negative.request('/api/control', { paused: true });
  assert.equal((await negative.integration(assessment)).status, 400);
});

test('integration merges the candidate onto newer commits and keeps unrelated local edits; conflicts and altered candidates are refused', async t => {
  for (const conflict of [false, true]) {
    const c = await setup(t);
    await c.start();
    const a = await c.wait(c.taskId),
      store = c.app.store;
    if (!conflict) {
      const file = path.join(a.outputFolder, 'source-change.json'),
        original = fs.readFileSync(file),
        forged = JSON.parse(original);
      forged.candidateHash = hash('forged');
      fs.writeFileSync(file, JSON.stringify(forged));
      assert.equal((await c.request(`/api/tasks/${c.taskId}/accept`)).status, 400);
      fs.writeFileSync(file, original);
    }
    const review = await c.review(a);
    await c.accept(review.taskId);
    if (!conflict) {
      // The candidate is its recorded commit, holding exactly the reviewed edits on its base.
      const recorded = store.attempt(a.id),
        commit = recorded.sourceCandidate.commit;
      for (const [value, error] of [
        [a.sourceWorktree.baseCommit, /does not match the reviewed edits/],
        [undefined, /built before candidates were commits/],
      ]) {
        recorded.sourceCandidate.commit = value;
        store.updateAttempt(recorded);
        const refused = await c.integration(review);
        assert.equal(refused.status, 400);
        assert.match(refused.data.error, error);
      }
      recorded.sourceCandidate.commit = commit;
      store.updateAttempt(recorded);
      assert.equal(store.attempt(review.id).sourceIntegration, undefined);
    }
    // Work lands on main after the candidate's base, and an unrelated edit stays uncommitted.
    if (conflict)
      fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '\n// A different change here on main.\n');
    else fs.writeFileSync(path.join(c.root, 'README.md'), '// Committed after the candidate base\n');
    git(c.root, ['commit', '--quiet', '-am', 'Newer work on main']);
    fs.appendFileSync(path.join(c.root, 'docs/module-contracts.md'), 'Uncommitted note\n');
    const tip = git(c.root, ['rev-parse', 'HEAD']);
    assert.equal((await c.integration(review)).status, 200);
    const journal = await c.settled(review);
    assert.match(git(c.root, ['status', '--porcelain']), /^M docs\/module-contracts\.md$/);
    assert.equal(fs.existsSync(journal.worktree), false);
    assert.equal(store.leases().length, 0);
    if (conflict) {
      assert.equal(journal.state, 'rejected');
      assert.match(journal.error, /conflicts with changes integrated since its base, in src\/core\/workflows\.mjs/);
      assert.equal(git(c.root, ['rev-parse', 'HEAD']), tip);
      assert.equal(store.task(c.taskId).sourceStage.current, 'failed');
    } else {
      assert.equal(journal.state, 'integrated', JSON.stringify(journal));
      assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), tip);
      assert.match(fs.readFileSync(path.join(c.root, 'README.md'), 'utf8'), /Committed after the candidate base/);
      assert.match(
        fs.readFileSync(path.join(c.root, 'src/core/workflows.mjs'), 'utf8'),
        /improvement\.\n\/\/ formatted\n$/,
      );
    }
  }
});

test('source change cancellation and candidate-phase cancellation retain reservations until process close; Codex quota is shared', async t => {
  const c = await setup(t, 'hang');
  await c.start();
  for (let i = 0; i < 200 && !c.app.store.events().some(event => event.kind === 'candidate_checks'); i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(c.app.store.events().some(event => event.kind === 'candidate_checks'));
  assert.equal(c.app.store.leases().length, 3);
  assert.equal((await c.request(`/api/tasks/${c.taskId}/cancel`)).status, 202);
  await c.wait(c.taskId, 'cancelled');
  assert.equal(c.app.store.leases().length, 0);
  const q = await setup(t);
  await q.start('quota');
  await q.wait(q.taskId, 'blocked');
  assert.equal(q.app.store.organization().quota.codex, true);
  assert.equal(q.app.store.organization().quota['source-change'], undefined);
  // A usage limit says nothing about the work: each stopped attempt stays on record, but the
  // story's 2-attempt limit still allows an automatic run once the director clears the hold.
  const stopped = async count => {
    for (let i = 0; i < 500 && q.app.store.attempts(q.taskId).length < count; i++)
      await new Promise(resolve => setTimeout(resolve, 15));
    await q.wait(q.taskId, 'blocked');
    assert.equal(q.app.store.attempts(q.taskId).length, count);
  };
  assert.equal((await q.request('/api/control', { clearQuota: 'codex' })).status, 200);
  await q.start();
  await stopped(2);
  assert.equal((await q.request('/api/control', { clearQuota: 'codex' })).status, 200);
  const queued = await q.request('/api/pipeline', { action: 'queue', taskIds: [q.taskId] });
  assert.equal(queued.status, 200, JSON.stringify(queued.data));
  await stopped(3);
  const attempts = q.app.store.attempts(q.taskId);
  assert.deepEqual(
    attempts.map(a => [a.status, a.subscriptionHold]),
    Array(3).fill(['blocked', 'codex']),
  );
  assert.equal(attempts.at(-1).directorOverride, undefined);
  const task = q.app.store.task(q.taskId);
  assert.equal(q.app.runner.registries.workflows.stageAttempts(q.app.store, task).length, 0);
  assert.equal(dashboardAttempt(attempts[0]).subscriptionHold, 'codex');
});

test('a queued source story a usage limit stopped starts again by itself after the reset its CLI named', async t => {
  const c = await setup(t),
    store = c.app.store,
    story = store.task(c.taskId);
  // 'quota-soon' names a reset three seconds ahead; the run that continues from the stopped work passes.
  story.direction = 'quota-soon';
  store.putTask(story);
  const queued = await c.request('/api/pipeline', { action: 'queue', taskIds: [c.taskId] });
  assert.equal(queued.status, 200, JSON.stringify(queued.data));
  for (let i = 0; i < 500 && store.attempts(c.taskId).length < 1; i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  const stopped = await c.wait(c.taskId, 'blocked'),
    waiting = store.task(c.taskId);
  assert.equal(stopped.subscriptionHold, 'codex');
  assert.equal(store.organization().quotaResets.codex, stopped.subscriptionReset);
  assert.equal(waiting.queued, true);
  assert.equal(waiting.controllerWait, true);
  assert.match(waiting.reason, /^Waiting for the Codex usage limit to reset at /);
  assert.equal(waiting.sourceStage.current, 'blocked');
  assert.equal(waiting.sourceStage.reason, waiting.reason);
  for (let i = 0; i < 500 && store.attempts(c.taskId).length < 2; i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  const next = await c.wait(c.taskId);
  assert.equal(store.attempts(c.taskId).length, 2);
  assert.ok(Date.parse(next.startedAt) >= Date.parse(stopped.subscriptionReset));
  assert.equal(next.sourceChange.continueFrom.attemptId, stopped.id);
  assert.match(
    fs.readFileSync(artifactPath(store, next, 'changes/src/core/workflows.mjs'), 'utf8'),
    /Retained quota-soon fixture work/,
  );
  const org = store.organization();
  assert.equal(org.quota.codex, false);
  assert.equal(Object.hasOwn(org.quotaResets, 'codex'), false);
  assert.ok(
    store.db
      .prepare("SELECT message FROM events WHERE kind='control'")
      .all()
      .some(event => /^Codex hold cleared itself at its reset time/.test(event.message)),
  );
  assert.deepEqual(
    c.app.runner.registries.workflows.stageAttempts(store, store.task(c.taskId)).map(a => a.id),
    [next.id],
  );
});

test('an interrupted integration is reconciled from git history and never replayed (MP-016)', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs', 'src/core/projects.mjs']);
  await c.start('multi');
  const a = await c.wait(c.taskId),
    review = await c.review(a);
  await c.accept(review.taskId);
  const head = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal((await c.integration(review)).status, 200);
  const integrated = await c.settled(review);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  assert.deepEqual(git(c.root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort(), [
    'src/core/projects.mjs',
    'src/core/workflows.mjs',
  ]);
  // The controller stopped after recording the integration commit, before its journal settled.
  const interrupt = () => {
    const attempt = c.app.store.attempt(review.id),
      { finishedAt, ...journal } = integrated;
    attempt.sourceIntegration = {
      ...journal,
      state: 'committing',
      repository: { branch: integrated.repository.branch, head },
    };
    c.app.store.tx(() => {
      c.app.store.claim(sourceIntegrationResources, journal.id);
      c.app.store.updateAttempt(attempt);
    });
  };
  // After the fast-forward: git history shows the commit landed.
  interrupt();
  await c.app.close();
  c.app = createStudio(c.options);
  await c.connect();
  c.app.runner.autonomy.attention(c.app.store.task(review.taskId), 'Reconcile this interrupted integration.');
  assert.equal(c.app.store.leases().length, 2);
  assert.equal((await c.integration(review)).status, 400, 'Restart cannot replay an uncertain integration.');
  let reconciled = await c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'integrated');
  assert.equal(reconciled.data.repository.commit, integrated.commit);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal(c.app.store.task(review.taskId).autonomyNote, undefined);
  assert.equal(c.app.store.task(review.taskId).reason, '');
  assert.equal(c.app.store.task(review.taskId).sourceStage.reason, '');
  // Before the fast-forward: the development copy never moved, so the integration is abandoned,
  // unless the changed files hold edits an interrupted fast-forward may have left.
  git(c.root, ['reset', '--quiet', '--hard', head]);
  interrupt();
  fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// unknown\n');
  c.app.runner.autonomy.attention(
    c.app.store.task(review.taskId),
    'Inspect the uncommitted source before reconciling.',
  );
  reconciled = await c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.equal(reconciled.status, 400);
  assert.match(reconciled.data.error, /uncommitted changes to src\/core\/workflows\.mjs/);
  assert.equal(c.app.store.leases().length, 2);
  assert.equal(c.app.store.task(review.taskId).autonomyNote, 'Inspect the uncommitted source before reconciling.');
  git(c.root, ['checkout', '--', 'src/core/workflows.mjs']);
  reconciled = await c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'abandoned');
  assert.equal(c.app.store.task(review.taskId).autonomyNote, undefined);
  assert.match(c.app.store.task(review.taskId).reason, /reconciled.*Approve integration again/);
  assert.equal(c.app.store.task(review.taskId).sourceStage.reason, c.app.store.task(review.taskId).reason);
  assert.ok(reconciled.data.error, 'The original journal explanation stays recorded.');
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal((await c.integration(review)).status, 200);
  assert.equal((await c.settled(review)).state, 'integrated');
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), head);
});

// 1.0 step 4b: a project's own repository is not the controller's source, and an integration
// interrupted there is reconciled the same way rather than refused.
test("an interrupted integration in a project's own repository is reconciled there", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs', 'src/core/projects.mjs']);
  await c.start('multi');
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  const head = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal((await c.integration(review)).status, 200);
  const integrated = await c.settled(review);
  assert.equal(integrated.state, 'integrated', JSON.stringify(integrated));
  // The controller stopped after the commit, before its journal settled; the repository is the
  // project's own, and after the restart the controller develops another copy.
  const store = c.app.store,
    attempt = store.attempt(review.id),
    { finishedAt, ...journal } = integrated,
    project = store.project(store.task(review.taskId).projectId);
  attempt.sourceIntegration = {
    ...journal,
    state: 'committing',
    repository: { branch: integrated.repository.branch, head },
  };
  project.source = { root: journal.root, profile: structuredClone(studioDeskProfile) };
  store.tx(() => {
    store.claim(sourceIntegrationResources, journal.id);
    store.updateAttempt(attempt);
    store.putProject(project);
  });
  await c.app.close();
  c.options.runnerOptions.sourceChangeRoot = c.directory;
  c.app = createStudio(c.options);
  await c.connect();
  assert.notEqual(c.app.runner.sourceChangeRoot, journal.root);
  const reconciled = await c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'integrated');
  assert.equal(reconciled.data.repository.commit, integrated.commit);
  assert.equal(c.app.store.leases().length, 0);
});

test('a recorded integration from before integration by merge still restores its checkpoint', async t => {
  const c = await setup(t);
  await c.start();
  const a = await c.wait(c.taskId),
    review = await c.review(a),
    store = c.app.store;
  await c.accept(review.taskId);
  // Shaped like a journal the copy-and-commit integration left part-way, with one file applied.
  const file = 'src/core/workflows.mjs',
    target = path.join(c.root, file),
    before = fs.readFileSync(target),
    applied = Buffer.from('// Applied by an interrupted integration\n'),
    recorded = store.attempt(review.id),
    backup = path.join(jobDirectory(store, recorded), 'source-backup', file);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, before);
  fs.writeFileSync(target, applied);
  recorded.sourceIntegration = {
    id: 'source-integration:' + review.id,
    state: 'applying',
    root: c.app.runner.sourceChangeRoot,
    changes: [{ path: file, beforeHash: hash(before), afterHash: hash(applied), integratedHash: hash(applied) }],
    repository: repositoryState(c.root, 'integrating source', { clean: false }),
    applied: [file],
    startedAt: new Date().toISOString(),
  };
  store.tx(() => {
    store.claim(sourceIntegrationResources, recorded.sourceIntegration.id);
    store.updateAttempt(recorded);
  });
  const restore = () => c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.match((await restore()).data.error, /Pause dispatch/, 'Restoring a checkpoint needs paused dispatch.');
  await c.request('/api/control', { paused: true });
  const restored = await restore();
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.state, 'restored');
  assert.equal(hash(fs.readFileSync(target)), hash(before));
  assert.equal(store.leases().length, 0);
});

test('integration refusals and verification failures leave the development copy and git untouched and allow a retry', async t => {
  const c = await setup(t);
  await c.start();
  const a = await c.wait(c.taskId),
    review = await c.review(a);
  await c.accept(review.taskId);
  const store = c.app.store,
    runner = c.app.runner,
    target = path.join(c.root, 'src/core/workflows.mjs'),
    before = sourcePlan(c.root).sourceHash,
    head = git(c.root, ['rev-parse', 'HEAD']);
  git(c.root, ['checkout', '--quiet', '--detach']);
  assert.match((await c.integration(review)).data.error, /HEAD is detached/);
  git(c.root, ['checkout', '--quiet', 'main']);
  assert.equal(store.attempt(review.id).sourceIntegration, undefined);
  // A local edit to a changed file: verification runs on commits, and the fast-forward refuses it.
  fs.appendFileSync(target, '// Local edit\n');
  assert.equal((await c.integration(review)).status, 200);
  let journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.match(journal.error, /Commit or stash local edits to src\/core\/workflows\.mjs/);
  assert.match(fs.readFileSync(target, 'utf8'), /Local edit/);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), head);
  git(c.root, ['checkout', '--', 'src/core/workflows.mjs']);
  // main moves during verification: the result was tested on the old tip, so it is not used.
  runner.sourceFormatCommand = {
    executable: process.execPath,
    args: [
      '-e',
      `require('child_process').execFileSync('git', ['-C', ${JSON.stringify(c.root)}, 'commit', '--quiet', '--allow-empty', '-m', 'Moved'])`,
    ],
  };
  assert.equal((await c.integration(review)).status, 200);
  journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.match(journal.error, /main moved during verification/);
  const moved = git(c.root, ['rev-parse', 'HEAD']);
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), head);
  // Failing tests or a failing formatter on the merged result.
  runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'pass'] };
  const command = runner.sourceCheckCommand;
  runner.sourceCheckCommand = { executable: process.execPath, args: [tests, 'fail'] };
  assert.equal((await c.integration(review)).status, 200);
  journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.match(journal.error, /0\/1 tests passed on the formatted change/);
  assert.ok(store.events().some(event => event.kind === 'source_rejected'));
  runner.sourceCheckCommand = command;
  runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'fail'] };
  assert.equal((await c.integration(review)).status, 200);
  journal = await c.settled(review);
  assert.equal(journal.state, 'rejected');
  assert.match(journal.error, /formatter did not complete/);
  assert.equal(journal.previous.state, 'rejected');
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), moved);
  assert.equal(sourcePlan(c.root).sourceHash, before);
  assert.equal(store.leases().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(store.directory, 'wt')), [], 'No integration worktree is left.');
  // Unrelated local edits and untracked files stay as they are, and the retry integrates.
  runner.sourceFormatCommand = { executable: process.execPath, args: [formatter, 'pass'] };
  fs.appendFileSync(path.join(c.root, 'README.md'), 'Uncommitted note\n');
  fs.writeFileSync(path.join(c.root, 'scripts', 'untracked-note.md'), 'untracked');
  assert.equal((await c.integration(review)).status, 200);
  journal = await c.settled(review);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal));
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), moved);
  assert.match(fs.readFileSync(path.join(c.root, 'README.md'), 'utf8'), /Uncommitted note/);
  assert.ok(fs.existsSync(path.join(c.root, 'scripts', 'untracked-note.md')));
});

test('verification interrupted by shutdown keeps its reservations and reconciles without writing source', async t => {
  const c = await setup(t);
  await c.start();
  const a = await c.wait(c.taskId),
    review = await c.review(a);
  await c.accept(review.taskId);
  await c.request('/api/control', { paused: true });
  const before = sourcePlan(c.root).sourceHash;
  c.app.runner.sourceCheckCommand = { executable: process.execPath, args: [tests, 'hang'] };
  assert.equal((await c.integration(review)).status, 200);
  for (let i = 0; i < 300 && !c.app.runner.integrationProcess?.spawnargs.includes('hang'); i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(c.app.runner.integrationProcess, 'Verification tests are running.');
  const pending = c.app.runner.sourceIntegrationRun.promise;
  await c.app.close();
  // The async continuation must settle without touching the now-closed store.
  assert.equal((await pending).state, 'verifying');
  c.app = createStudio(c.options);
  await c.connect();
  assert.deepEqual(
    [
      c.app.store.attempt(review.id).sourceIntegration.state,
      c.app.store.attempt(review.id).sourceIntegration.interrupted,
    ],
    ['needs-reconciliation', 'verifying'],
  );
  assert.equal(c.app.store.leases().length, 2);
  assert.equal((await c.integration(review)).status, 400, 'An interrupted verification is reconciled, not replayed.');
  const restored = await c.request(`/api/tasks/${review.taskId}/restore-source`);
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.state, 'abandoned');
  assert.equal(sourcePlan(c.root).sourceHash, before);
  assert.equal(c.app.store.leases().length, 0);
  const retried = await c.integration(review);
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal((await c.settled(review)).state, 'integrated');
});

test('the integration formatter matches the pinned project format script', () => {
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).scripts;
  assert.ok(scripts.format.includes(sourceFormatter));
  assert.ok(scripts['format:check'].includes(sourceFormatter));
});

test('repository checks still work when a sandbox denies the native path resolver', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-native-')),
    native = fs.realpathSync.native;
  t.after(() => {
    fs.realpathSync.native = native;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const root = fs.realpathSync(directory);
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Fixture baseline']);
  fs.realpathSync.native = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, realpath'), { code: 'EPERM' });
  };
  assert.equal(repositoryState(root).branch, 'main');
});

test('a rejected source edit names its reason, and how to report checks the sandbox could not run', () => {
  // A real Codex edit (October 14) reported loopback tests its own sandbox blocked as failed.
  const result = {
    taskId: 'T-1',
    outcome: 'completed',
    summary: 'Staged three files.',
    artifacts: [{ path: 'changes/src/server.mjs', kind: 'source-file' }],
    checks: [
      { name: 'Syntax', status: 'pass', evidence: 'node --check passed.' },
      { name: 'Focused HTTP tests', status: 'fail', evidence: 'EACCES connecting to the loopback server.' },
    ],
    issues: [],
    handoff: '',
  };
  const read = () => {
    throw new Error('Rejected edits are not read.');
  };
  assert.throws(
    () => stagedChanges({}, result, read),
    error =>
      error.message.startsWith(
        'Complete the bounded source change with staged source artifacts: your check "Focused HTTP tests" failed: EACCES connecting to the loopback server..',
      ) && /as not-run, and use fail only for a defect in the change\.$/.test(error.message),
  );
  assert.throws(() => stagedChanges({}, { ...result, artifacts: [], checks: [] }, read), {
    message:
      'Complete the bounded source change with staged source artifacts: 0 artifacts were returned; return each approved file you changed or created under changes/.',
  });
  // A story that only deletes files returns none; the controller deletes the listed files.
  const deletion = stagedChanges(
    {
      allowedFiles: [],
      newFiles: [],
      deleteFiles: ['docs/old.md'],
      source: { files: [{ path: 'docs/old.md', hash: 'h' }] },
    },
    { ...result, artifacts: [], checks: [] },
    read,
  );
  assert.deepEqual(deletion, [{ path: 'docs/old.md', beforeHash: 'h', afterHash: null, bytes: 0 }]);
});

test('candidate review errors name each problem so a retry can correct it', () => {
  const candidateReview = {
      taskId: 'T-1',
      attemptId: 'attempt-1',
      path: 'source-change.json',
      hash: 'a'.repeat(64),
      candidateHash: 'b'.repeat(64),
      passed: true,
    },
    { passed, ...source } = candidateReview,
    valid = {
      schemaVersion: 'source-change-review-v2',
      source,
      verdict: 'pass',
      summary: 'The edit meets the approved scope.',
      findings: [],
      notes: ['public/runs.js:46 hard-codes the model-free providers.'],
      unperformedChecks: ['Browser layout', 'Engine integration', 'Playtest'],
    };
  const validate = (report, version) =>
    validateChangeReview(
      {
        candidateReview,
        artifacts: [{ path: 'source-change-review.json', kind: 'source-change-review' }],
        ...(version ? { contracts: { task: { kind: 'studio-development:change-review', version } } } : {}),
      },
      () => JSON.stringify(report),
    );
  assert.equal(validate(valid).verdict, 'pass');
  // MP-019: findings block and notes do not, so a passing review carries notes, never findings.
  assert.throws(() => validate({ ...valid, findings: ['A theoretical case.'] }), {
    message:
      'Candidate review must assess the exact candidate and label unperformed checks: findings are blocking defects, so a passing review has none; put non-blocking observations in notes.',
  });
  assert.throws(() => validate({ ...valid, notes: undefined }), /notes must be an array of at most 20 plain strings/);
  assert.equal(validate({ ...valid, verdict: 'needs-work', findings: ['A missed criterion.'] }).verdict, 'needs-work');
  // A review whose attempt recorded contract v1 keeps v1's rules: a pass could list findings, without notes.
  const v1 = { ...valid, schemaVersion: 'source-change-review-v1', findings: ['An informational finding.'] };
  delete v1.notes;
  assert.equal(validate(v1, 'source-change-review-v1').verdict, 'pass');
  assert.throws(() => validate(v1), /schemaVersion must be source-change-review-v2/);
  // A real Claude review (October 14) wrote structured findings; the contract requires plain text.
  assert.throws(
    () => validate({ ...valid, findings: [{ severity: 'minor', file: 'public/runs.js', summary: 'Hard-coded.' }] }),
    /: findings must be an array of at most 20 plain strings, not objects\.$/,
  );
  assert.throws(() => validate({ ...valid, source: { ...source, candidateHash: 'wrong' }, unperformedChecks: [] }), {
    message: `Candidate review must assess the exact candidate and label unperformed checks: source.candidateHash must be ${'b'.repeat(64)}; unperformedChecks must include Browser layout, Engine integration and Playtest.`,
  });
  // A real review (October 19) gave the path of its input copy; the error names the value to use.
  assert.throws(() => validate({ ...valid, source: { ...source, path: '../inputs/T-1/0-source-change.json' } }), {
    message:
      'Candidate review must assess the exact candidate and label unperformed checks: source.path must be source-change.json.',
  });
  assert.throws(
    () => validate({ ...valid, source: { ...source, extra: true } }),
    /source must hold exactly taskId, attemptId, path, hash and candidateHash of the input candidate\.$/,
  );
  assert.throws(
    () => validate({ ...valid, verdict: 'needs-work', findings: [] }),
    /needs-work requires at least one finding/,
  );
  assert.throws(() => validate(null), /must be a JSON object/);
});

// Candidate copies run these tests deep inside job folders, past Windows' 260-character paths.
test('integration commits work when the commit message path is longer than 260 characters', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-long-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo'),
    journal = path.join(directory, 'd'.repeat(100), 'e'.repeat(100));
  fs.mkdirSync(root);
  fs.mkdirSync(journal, { recursive: true });
  assert.ok(path.join(journal, 'commit-message.txt').length > 260);
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  const head = commitIntegration(root, ['README.md'], 'Long path fixture', journal);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  assert.equal(git(root, ['log', '-1', '--format=%s']), 'Long path fixture');
});

test('a revised implementation creates no review until its replacement candidate is accepted', async t => {
  const c = await setup(t);
  await c.start();
  const first = await c.wait(c.taskId),
    store = c.app.store;
  c.app.runner.autonomy.attention(store.task(c.taskId), 'Inspect this candidate.');
  assert.equal(store.task(c.taskId).proposedTaskIds, undefined);
  assert.equal(
    (await c.request('/api/tasks/' + c.taskId + '/revise', { direction: 'Tighten the change.' })).status,
    200,
  );
  assert.equal(store.task(c.taskId).autonomyNote, undefined);
  assert.equal(store.task(c.taskId).reason, '');
  assert.equal(store.task(c.taskId).sourceStage.reason, '');
  assert.equal((await c.request('/api/tasks/' + c.taskId + '/start')).status, 202);
  const second = await c.wait(c.taskId);
  assert.notEqual(second.id, first.id);
  const review = await c.review(second);
  assert.equal(review.candidateReview.attemptId, second.id);
  assert.equal(store.attempt(first.id).status, 'revision_requested');
  assert.equal(
    store.tasks().some(task => task.kind === 'studio-development:change-review'),
    false,
  );
});

test('source story stages serialize exact independent attempts with autonomy off or director work gates', async t => {
  for (const enabled of [false, true]) {
    const c = await setup(t, 'pass', undefined, {}, true),
      { store, runner } = c.app;
    store.putSetting('project-autonomy:project-legacy', {
      enabled,
      revision: 1,
      retries: 0,
      kinds: { 'studio-development:change-review': { approve: 'director', accept: 'director' } },
    });
    const org = store.organization();
    org.kindOwners = { 'studio-development:change-review': 'W-05' };
    store.setOrganization(org);
    runner.start(c.taskId);
    const implementation = await c.wait(c.taskId);
    c.measuredFixture(implementation);
    const immutable = store.attempt(implementation.id);
    assert.throws(
      () => sourceIntegrationTarget(store, store.task(c.taskId), implementation.id, 'x'),
      /current candidate review/,
    );
    runner.autonomy.attention(store.task(c.taskId), 'Inspect the implementation.');
    await c.accept(c.taskId);
    assert.equal(store.task(c.taskId).autonomyNote, undefined);
    assert.equal(store.task(c.taskId).reason, '');
    assert.equal(store.task(c.taskId).sourceStage.reason, '');
    runner.autonomy.accepted(c.taskId);
    runner.autonomy.accepted(c.taskId);
    const review = await c.wait(c.taskId);
    assert.equal(review.workerId, 'W-05');
    assert.equal(review.assignment.kind, 'studio-development:change-review');
    assert.notEqual(review.instructions.hash, implementation.instructions.hash);
    assert.equal(review.configuration.provider, immutable.configuration.provider);
    assert.equal(review.inputReferences[0].attemptId, implementation.id);
    // The review reads the candidate's diff and evidence, not its staged file copies.
    assert.deepEqual(
      review.inputReferences[0].artifacts.map(a => a.hash),
      immutable.artifacts.filter(a => a.kind !== 'source-file').map(a => a.hash),
    );
    assert.deepEqual(store.attempt(implementation.id).instructions, immutable.instructions);
    assert.deepEqual(store.attempt(implementation.id).configuration, immutable.configuration);
    assert.deepEqual(store.attempt(implementation.id).inputReferences, immutable.inputReferences);
    assert.throws(
      () => sourceIntegrationTarget(store, store.task(c.taskId), review.id, review.artifacts[0].hash),
      /current candidate review/,
    );
    runner.autonomy.attention(store.task(c.taskId), 'Inspect the independent review.');
    await c.accept(c.taskId);
    const state = JSON.parse(JSON.stringify(store.state())),
      story = state.tasks.find(task => task.id === c.taskId);
    assert.equal(story.kind, 'studio-development:change');
    assert.equal(story.sourceStage.version, 'source-story-stages-v1');
    assert.equal(story.sourceStage.current, 'waiting-for-integration');
    assert.equal(story.autonomyNote, undefined);
    assert.equal(story.reason, '');
    assert.equal(story.sourceStage.reason, '');
    assert.equal(story.sourceStage.candidate.attemptId, implementation.id);
    assert.equal(story.sourceStage.review.attemptId, review.id);
    assert.equal(story.sourceStage.review.hash, review.artifacts[0].hash);
    assert.equal(story.sourceStage.review.workerId, 'W-05');
    assert.equal(state.attempts.filter(a => a.taskId === story.id).length, 2);
    assert.equal(
      state.tasks.some(task => task.kind === 'studio-development:change-review'),
      false,
    );
    assert.equal(sourceIntegrationTarget(store, story, review.id, review.artifacts[0].hash).id, story.id);
    assert.equal(store.leases().length, 0);
    await c.app.close();
    c.app = createStudio(c.options);
    c.app.runner.autonomy.accepted(c.taskId);
    assert.deepEqual(c.app.store.task(c.taskId).sourceStage, story.sourceStage);
    assert.equal(c.app.store.attempts(c.taskId).length, 2);
  }
});

test('accepted source stories explicitly block missing independent reviewers and protocol-only candidates', async t => {
  for (const measured of [false, true]) {
    const c = await setup(t, 'pass', undefined, {}, true),
      { store, runner } = c.app;
    runner.start(c.taskId);
    const a = await c.wait(c.taskId);
    if (measured) {
      c.measuredFixture(a);
      const org = store.organization();
      org.workers.forEach(worker => {
        worker.enabled = worker.id === a.workerId;
      });
      store.setOrganization(org);
    }
    await c.accept(c.taskId);
    const stage = store.task(c.taskId).sourceStage;
    assert.equal(stage.current, 'blocked');
    assert.match(stage.reason, measured ? /independent candidate reviewer/ : /measured execution/);
    assert.equal(store.attempt(a.id).status, 'accepted');
    assert.equal(store.attempts(c.taskId).length, 1);
    assert.equal(store.leases().length, 0);
  }
});

test('a queued review retains employee ownership and restart pause without duplicate dispatch', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  runner.start(c.taskId);
  const implementation = await c.wait(c.taskId);
  c.measuredFixture(implementation);
  store.claim(['employee:W-07'], 'fixture-owner');
  const org = store.organization();
  org.paused = true;
  store.setOrganization(org);
  await c.accept(c.taskId);
  const resumed = store.organization();
  resumed.paused = false;
  store.setOrganization(resumed);
  runner.refreshReadiness();
  assert.equal(store.task(c.taskId).sourceStage.current, 'blocked');
  assert.equal(store.task(c.taskId).sourceStage.reason, 'Waiting for resource employee:W-07 to become available.');
  assert.equal(store.attempts(c.taskId).length, 1);
  await c.app.close();
  c.app = createStudio(c.options);
  assert.equal(c.app.store.task(c.taskId).queued, true);
  assert.equal(c.app.store.project('project-legacy').dispatchPaused, true);
  c.app.runner.autonomy.accepted(c.taskId);
  assert.equal(c.app.store.attempts(c.taskId).length, 1);
  c.app.store.release('fixture-owner');
  c.app.runner.pipeline('resume');
  const review = await c.wait(c.taskId);
  assert.equal(review.assignment.kind, 'studio-development:change-review');
  assert.equal(c.app.store.attempts(c.taskId).length, 2);
  assert.equal(c.app.store.attempt(implementation.id).status, 'accepted');
  assert.equal(c.app.store.leases().length, 0);
});

test('a review that corrects its own result keeps the story retry, and its findings send the story back', async t => {
  // October 19: a review gave its input copy's path, its retry spent the story's only retry, and the
  // valid needs-work findings that followed could not send the story back.
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app,
    until = async check => {
      for (let i = 0; i < 600; i++) {
        const value = check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      throw new Error(JSON.stringify(store.task(c.taskId)));
    };
  runner.start(c.taskId);
  const first = c.measuredFixture(await c.wait(c.taskId));
  store.putSetting('project-autonomy:project-legacy', {
    enabled: true,
    revision: 5,
    retries: 1,
    kinds: {
      'studio-development:change': { accept: 'director' },
      'studio-development:change-review': { accept: 'auto' },
    },
  });
  const pause = paused => {
    const org = store.organization();
    org.paused = paused;
    store.setOrganization(org);
  };
  pause(true);
  acceptAttempt(store, runner.registries, store.task(c.taskId));
  const story = store.task(c.taskId);
  story.sourceStage.reviewDirection = 'input-path-then-negative';
  store.putTask(story);
  pause(false);
  runner.autonomy.accepted(c.taskId);
  runner.schedule();
  const second = await until(() =>
    store
      .attempts(c.taskId)
      .find(a => a.assignment.kind === 'studio-development:change' && a.id !== first.id && a.status === 'review'),
  );
  const reviews = store.attempts(c.taskId).filter(a => a.assignment.kind === 'studio-development:change-review');
  assert.deepEqual(
    reviews.map(a => [a.status, a.candidateReviewVerdict]),
    [
      ['failed', undefined],
      ['accepted', 'needs-work'],
    ],
  );
  // The error names the value to use, and the review's retry carries it in the review's own direction.
  assert.match(reviews[0].error, /source\.path must be source-change\.json\.$/);
  assert.match(
    reviews[1].assignment.direction,
    /^input-path-then-negative\n\nAutomatic retry 1: .*source\.path must be/s,
  );
  const sent = store.task(c.taskId);
  assert.deepEqual(
    [sent.autoRetries, sent.stageRetries],
    [1, { 'studio-development:change-review': 1 }],
    'Each stage spent its own retry.',
  );
  assert.equal(
    second.assignment.direction,
    'Automatic retry 1: the previous attempt did not pass. Independent review requested changes. Model-free candidate review fixture.\n- Fixture requests more work.',
    "The review's own retry stays out of the implementation's direction.",
  );
});

test('the director sends a story back when its review requested changes; the next attempt carries the findings and note', async t => {
  const c = await setup(t),
    store = c.app.store,
    sendBack = data => c.request(`/api/tasks/${c.taskId}/send-back`, data);
  await c.start();
  const first = await c.wait(c.taskId),
    negative = await c.review(first, 'negative-review');
  assert.match((await sendBack({})).data.error, /Only accepted work whose later stage requested changes/);
  await c.accept(c.taskId);
  assert.equal(store.task(c.taskId).sourceStage.current, 'failed');
  assert.equal((await sendBack({ note: 'x', attemptId: negative.id })).status, 400);
  c.app.runner.autonomy.attention(store.task(c.taskId), 'Independent review requested changes.');
  const sent = await sendBack({ note: 'Keep the import order.' });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  assert.equal(store.task(c.taskId).autonomyNote, undefined);
  assert.equal(store.task(c.taskId).reason, '');
  assert.equal(store.task(c.taskId).sourceStage.reason, '');
  assert.equal(sent.data.start.attemptId !== undefined || sent.data.start.queued, true);
  assert.ok(store.events().some(event => event.kind === 'sent_back' && /Keep the import order/.test(event.message)));
  const second = await c.wait(c.taskId);
  assert.equal(second.assignment.kind, 'studio-development:change');
  assert.notEqual(second.id, first.id);
  assert.equal(
    second.assignment.direction,
    `Independent review ${negative.id} requested changes. Address these findings:\n- Model-free candidate review fixture.\n- Fixture requests more work.\n\nDirector's note: Keep the import order.`,
  );
  // The replacement is reviewed as usual; the earlier candidate and its review stay in the history.
  await c.review(second);
  await c.accept(c.taskId);
  const story = store.task(c.taskId);
  assert.equal(story.sourceStage.current, 'waiting-for-integration');
  assert.deepEqual(
    [story.sourceStage.history[0].candidate.attemptId, story.sourceStage.history[0].review.verdict],
    [first.id, 'needs-work'],
  );
  // A passing review may be overruled too (send-back-passed.test.mjs), but only with the director's note.
  assert.match((await sendBack({})).data.error, /^Say what to change: the review passed/);
});

test('a passing review records non-blocking notes on its attempt and leaves the story ready to integrate (MP-019)', async t => {
  const c = await setup(t),
    store = c.app.store;
  await c.start();
  const review = await c.review(await c.wait(c.taskId), 'pass-with-notes');
  assert.equal(review.candidateReviewVerdict, 'pass');
  assert.deepEqual(review.candidateReviewFindings, []);
  assert.deepEqual(review.candidateReviewNotes, ['Fixture note: a case this repository does not use.']);
  assert.equal(review.contracts.task.version, 'source-change-review-v2');
  await c.accept(c.taskId);
  assert.equal(store.task(c.taskId).sourceStage.current, 'waiting-for-integration');
});

test('the director integrates over a review that requested changes with a recorded reason; tests still decide (MP-019)', async t => {
  const c = await setup(t),
    store = c.app.store;
  await c.start();
  const first = await c.wait(c.taskId),
    negative = await c.review(first, 'negative-review');
  await c.accept(c.taskId);
  assert.equal(store.task(c.taskId).sourceStage.current, 'failed');
  assert.deepEqual(store.attempt(negative.id).candidateReviewFindings, ['Fixture requests more work.']);
  const integrate = data =>
    c.request(`/api/tasks/${c.taskId}/integrate-source`, {
      attemptId: negative.id,
      reviewHash: store.attempt(negative.id).artifacts[0].hash,
      ...data,
    });
  // Without a reason a review that requested changes still blocks integration.
  assert.match((await integrate({})).data.error, /exact accepted passing current candidate review/);
  assert.match((await integrate({ overrideReason: '   ' })).data.error, /needs your reason/);
  const head = git(c.root, ['rev-parse', 'HEAD']),
    approved = await integrate({ overrideReason: 'The finding is a case this repository never uses.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.deepEqual(
    { ...approved.data.reviewOverride, at: undefined },
    {
      by: { type: 'director' },
      verdict: 'needs-work',
      reason: 'The finding is a case this repository never uses.',
      at: undefined,
    },
  );
  const journal = await c.settled(negative);
  assert.equal(journal.state, 'integrated', JSON.stringify(journal));
  assert.equal(git(c.root, ['rev-parse', 'HEAD~1']), head);
  assert.match(
    git(c.root, ['log', '-1', '--format=%B']),
    new RegExp(
      `Candidate review: ${c.taskId} \\(${negative.id}\\), verdict needs-work; integrated over it by the director: The finding is a case this repository never uses\\.`,
    ),
  );
  assert.equal(store.task(c.taskId).sourceStage.current, 'integrated');
  assert.ok(
    store
      .events()
      .some(
        event =>
          event.kind === 'source_verifying' &&
          /over the review's needs-work verdict, by the director/.test(event.message),
      ),
  );
  // The override covers the review, never the candidate's tests.
  const failing = await setup(t, 'fail');
  await failing.start();
  const candidate = await failing.wait(failing.taskId),
    assessment = await failing.review(candidate, 'negative-review');
  await failing.accept(failing.taskId);
  const refused = await failing.request(`/api/tasks/${failing.taskId}/integrate-source`, {
    attemptId: assessment.id,
    reviewHash: failing.app.store.attempt(assessment.id).artifacts[0].hash,
    overrideReason: 'Integrate anyway.',
  });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /candidate tests to pass/);
});

test('source review rejection retries the same story within policy and rejects stale candidate authority', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  runner.start(c.taskId);
  const first = await c.wait(c.taskId),
    negative = await c.review(first, 'negative-review');
  const reviewBytes = store.attempt(negative.id);
  store.putSetting('project-autonomy:project-legacy', {
    enabled: true,
    revision: 4,
    retries: 1,
    kinds: {
      'studio-development:change': { accept: 'director' },
      'studio-development:change-review': { accept: 'auto' },
    },
  });
  runner.autonomy.settled(c.taskId);
  assert.equal(store.attempt(negative.id).acceptedBy.type, 'policy');
  assert.throws(
    () => sourceIntegrationTarget(store, store.task(c.taskId), negative.id, negative.artifacts[0].hash),
    /passing current/,
  );
  const second = await c.wait(c.taskId);
  assert.equal(second.assignment.kind, 'studio-development:change');
  assert.notEqual(second.id, first.id);
  assert.match(second.assignment.direction, /Independent review requested changes/);
  assert.equal(store.attempts(c.taskId).length, 3, 'Unaccepted replacement cannot dispatch review.');
  store.putSetting('project-autonomy:project-legacy', { enabled: false });
  const replacementReview = await c.review(second);
  assert.equal(replacementReview.candidateReview.attemptId, second.id);
  assert.equal(store.task(c.taskId).sourceStage.history[0].candidate.attemptId, first.id);
  assert.deepEqual(store.attempt(negative.id).instructions, reviewBytes.instructions);
  assert.throws(
    () => sourceIntegrationTarget(store, store.task(c.taskId), negative.id, negative.artifacts[0].hash),
    /passing current/,
  );
  await c.accept(c.taskId);
  assert.equal(store.task(c.taskId).sourceStage.current, 'waiting-for-integration');
  assert.equal(store.attempts(c.taskId).length, 4);
  runner.autonomy.retryUpstream(
    store.task(c.taskId),
    { taskId: c.taskId, reason: 'Again.' },
    { retries: 1, revision: 4 },
  );
  assert.match(store.task(c.taskId).autonomyNote, /Retry limit/);
  assert.equal(store.task(c.taskId).queued, false);
});

test('source stage integration verification settles safely after store shutdown and reconciles without replay', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  runner.start(c.taskId);
  const a = await c.wait(c.taskId),
    review = await c.review(a);
  await c.accept(c.taskId);
  assert.equal(store.attempt(review.id).sourceIntegration, undefined, 'Acceptance never integrates.');
  // A controller developing its own source integrates only while paused and idle.
  runner.selfHosted = true;
  assert.throws(
    () => runner.autonomy.requestIntegration(store.task(c.taskId), review.id, review.artifacts[0].hash),
    /Pause dispatch/,
  );
  assert.match(store.task(c.taskId).sourceStage.reason, /Pause dispatch/);
  runner.selfHosted = false;
  const before = sourcePlan(c.root).sourceHash;
  runner.sourceCheckCommand = { executable: process.execPath, args: [tests, 'hang'] };
  assert.equal(
    runner.autonomy.requestIntegration(store.task(c.taskId), review.id, review.artifacts[0].hash).state,
    'verifying',
  );
  for (let i = 0; i < 300 && !runner.integrationProcess?.spawnargs.includes('hang'); i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(runner.integrationProcess);
  const pending = runner.sourceIntegrationRun.promise;
  await c.app.close();
  assert.equal((await pending).state, 'verifying');
  c.app = createStudio(c.options);
  assert.equal(c.app.store.leases().length, 2);
  assert.deepEqual(
    [
      c.app.store.attempt(review.id).sourceIntegration.state,
      c.app.store.attempt(review.id).sourceIntegration.interrupted,
    ],
    ['needs-reconciliation', 'verifying'],
  );
  assert.throws(
    () => integrateSource(c.app.runner, c.app.store.task(c.taskId), review.id, review.artifacts[0].hash),
    /Reconcile/,
  );
  assert.equal(restoreSourceIntegration(c.app.runner, c.app.store.task(c.taskId)).state, 'abandoned');
  assert.equal(sourcePlan(c.root).sourceHash, before);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal(c.app.store.task(c.taskId).sourceStage.integration.state, 'abandoned');
  c.app.runner.autonomy.requestIntegration(c.app.store.task(c.taskId), review.id, review.artifacts[0].hash);
  assert.equal((await c.settled(review)).state, 'integrated');
  assert.equal(c.app.store.task(c.taskId).sourceStage.current, 'integrated');
  assert.equal(c.app.store.attempt(a.id).status, 'accepted');
});

test('legacy accepted review targets integrate with unchanged candidate and instruction provenance', async t => {
  const c = await setup(t, 'pass', undefined, {}, true),
    { store, runner } = c.app;
  runner.start(c.taskId);
  const a = c.measuredFixture(await c.wait(c.taskId)),
    historical = store.task(c.taskId);
  // Seed an older accepted source record with no stage metadata.
  a.status = 'accepted';
  historical.status = 'done';
  historical.acceptedAttemptId = a.id;
  delete historical.sourceStage;
  store.updateAttempt(a);
  store.putTask(historical);
  const original = store.attempt(a.id),
    reviewer = store.organization().workers.find(w => w.id === 'W-07');
  store.putTask({
    id: 'legacy-review',
    kind: 'studio-development:change-review',
    workerId: reviewer.id,
    team: reviewer.team,
    title: 'Historical candidate review',
    status: 'ready',
    direction: '',
    dependencies: [c.taskId],
    acceptedInputs: [acceptedReference(store, c.taskId)],
    resources: [],
    maxSeconds: 30,
    maxAttempts: 2,
  });
  runner.start('legacy-review');
  const review = await c.wait('legacy-review');
  await c.accept('legacy-review');
  const org = store.organization();
  org.paused = true;
  store.setOrganization(org);
  assert.equal(
    runner.autonomy.requestIntegration(store.task('legacy-review'), review.id, review.artifacts[0].hash).state,
    'verifying',
  );
  assert.equal((await c.settled(review)).state, 'integrated');
  assert.deepEqual(store.attempt(a.id), original);
  assert.equal(store.task(c.taskId).sourceStage, undefined);
});

test('saving a change task from before stages leaves its record as it was; a live one still holds the source', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]);
  // Protocol fixtures shaped like the live October 14 records: no sourceStage, a separate review task.
  const legacy = (fields = {}) => {
    const { sourceStage, ...story } = store.task(ids[0]);
    return { ...story, id: 'T-legacy', ...fields };
  };
  for (const fields of [
    { status: 'done', proposedTaskIds: ['T-legacy-review'] },
    { status: 'blocked', proposedTaskIds: ['T-legacy-review'], reason: 'Stopped before stages.' },
    { status: 'denied' },
  ]) {
    c.app.runner.putTask(legacy(fields));
    assert.equal(store.task('T-legacy').sourceStage, undefined, JSON.stringify(fields));
  }
  // A story from before stages that is restarted still holds the live source while it runs.
  c.app.runner.putTask(legacy({ status: 'running', proposedTaskIds: ['T-legacy-review'] }));
  assert.equal(store.task('T-legacy').sourceStage, undefined);
  assert.equal(sourceStoryInFlight(store, store.task(ids[1]))?.id, 'T-legacy');
  // A new story still gains its stage when the controller saves it.
  c.app.runner.putTask(store.task(ids[1]));
  assert.equal(store.task(ids[1]).sourceStage.phase, 'implementing');
});

// The story's time limit bounds the editor and ends when it stops: the candidate's install and tests get
// the controller's own limits, so a long edit never leaves them no time (v1.0 tally row 7).
test("a long edit leaves the candidate's tests their own time, which still bounds them", async t => {
  const c = await setup(t, 'slow'),
    store = c.app.store,
    task = store.task(c.taskId);
  // Shorter than the edit and the tests together, though each fits on its own.
  task.maxSeconds = 2;
  store.putTask(task);
  await c.start('slow');
  const passed = await c.wait(c.taskId);
  assert.equal(passed.status, 'review', JSON.stringify(passed.error));
  assert.equal(passed.result.checks.find(check => check.name === 'Candidate Node test suite').status, 'pass');
  // The candidate's own limit still stops tests that run too long.
  const second = await setup(t, 'slow');
  second.app.runner.candidateTimeoutMs = 300;
  await second.start();
  const stopped = await second.wait(second.taskId, 'failed');
  assert.equal(stopped.error, 'Assignment time limit reached.');
  assert.equal(stopped.stopContext.activity, 'test');
  assert.equal(second.app.store.leases().length, 0);
});

// v1.0 item 18: a story's next attempt continues from the work of its latest stopped attempt, after a
// failed check, a usage limit or a time limit alike, unless that work can no longer be trusted.
const continuationFiles = ['src/core/workflows.mjs', 'src/core/projects.mjs'];
const candidateText = (store, attempt, file) =>
  fs.readFileSync(artifactPath(store, attempt, 'changes/' + file), 'utf8');
const nextAttempt = async (c, count) => {
  for (let i = 0; i < 500 && c.app.store.attempts(c.taskId).length < count; i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(c.app.store.attempts(c.taskId).length, count);
};

test('a retry after failing candidate tests continues from the earlier work and keeps it in the candidate', async t => {
  const c = await setup(t, 'fail', continuationFiles),
    store = c.app.store;
  await c.start();
  const first = await c.wait(c.taskId);
  assert.equal(first.result.checks.find(check => check.name === 'Candidate Node test suite').status, 'fail');
  assert.match(candidateText(store, first, 'src/core/workflows.mjs'), /Bounded fixture improvement/);
  // The director sends it back; the next editor changes the other file.
  c.app.runner.sourceCheckCommand.args[1] = 'pass';
  assert.equal((await c.request(`/api/tasks/${c.taskId}/revise`, { direction: 'next' })).status, 200);
  assert.equal((await c.request(`/api/tasks/${c.taskId}/start`)).status, 202);
  await nextAttempt(c, 2);
  const second = await c.wait(c.taskId);
  assert.equal(second.sourceChange.continueFrom.attemptId, first.id);
  assert.deepEqual(
    second.sourceChange.continueFrom.files.map(item => item.path),
    ['src/core/workflows.mjs'],
  );
  assert.equal(second.result.checks.find(check => check.name === 'Candidate Node test suite').status, 'pass');
  // The candidate is the whole change: the carried edit and the new one.
  assert.match(candidateText(store, second, 'src/core/workflows.mjs'), /Bounded fixture improvement/);
  assert.match(candidateText(store, second, 'src/core/projects.mjs'), /Bounded fixture improvement/);
});

test('work written before a usage limit or a time limit is carried into the next attempt', async t => {
  for (const stop of ['quota', 'hang']) {
    const c = await setup(t, 'pass', continuationFiles),
      store = c.app.store;
    if (stop === 'hang') {
      const task = store.task(c.taskId);
      task.maxSeconds = 2;
      store.putTask(task);
    }
    await c.start(stop);
    const stopped = await c.wait(c.taskId, stop === 'quota' ? 'blocked' : 'failed');
    if (stop === 'quota') assert.equal((await c.request('/api/control', { clearQuota: 'codex' })).status, 200);
    else assert.equal(stopped.error, 'Assignment time limit reached.');
    const task = store.task(c.taskId);
    task.maxSeconds = 600;
    store.putTask(task);
    await c.start('next');
    await nextAttempt(c, 2);
    const next = await c.wait(c.taskId);
    assert.equal(next.sourceChange.continueFrom.attemptId, stopped.id, stop);
    assert.equal(next.sourceChange.continueFrom.fresh, undefined, stop);
    for (const file of continuationFiles)
      assert.match(candidateText(store, next, file), new RegExp(`Retained ${stop} fixture work`), `${stop}: ${file}`);
  }
});

test('earlier work that can no longer be trusted starts the whole work fresh, with the reason recorded', async t => {
  for (const cause of ['committed', 'tampered']) {
    const c = await setup(t, 'pass', continuationFiles),
      store = c.app.store;
    await c.start('quota');
    const stopped = await c.wait(c.taskId, 'blocked');
    assert.equal((await c.request('/api/control', { clearQuota: 'codex' })).status, 200);
    if (cause === 'committed') {
      fs.appendFileSync(path.join(c.root, 'src/core/workflows.mjs'), '// Committed after the attempt.\n');
      git(c.root, ['commit', '--quiet', '-am', 'A later commit to an edited file']);
    } else {
      const copy = path.join(jobDirectory(store, stopped), 'continuation', 'files', 'changes', 'src/core/projects.mjs');
      assert.ok(fs.existsSync(copy), 'The stopped attempt left a checkpoint.');
      fs.appendFileSync(copy, '// Altered after it was recorded.\n');
    }
    await c.start('next');
    await nextAttempt(c, 2);
    const next = await c.wait(c.taskId);
    const fresh = next.sourceChange.continueFrom.fresh;
    assert.match(fresh.reason, cause === 'committed' ? /committed since that attempt/ : /could not be verified/, cause);
    if (cause === 'committed') assert.deepEqual(fresh.paths, ['src/core/workflows.mjs']);
    assert.deepEqual(next.sourceChange.continueFrom.files, [], cause);
    for (const file of continuationFiles)
      assert.doesNotMatch(candidateText(store, next, file), /Retained quota fixture work/, `${cause}: ${file}`);
    assert.ok(store.attempt(stopped.id), 'The earlier attempt and its history stay.');
  }
});
