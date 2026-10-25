// The dashboard state reads every attempt's phase observations in one query (October 21, 2026).
// A query per attempt scanned the whole events table each time, and with the live history each
// state took seconds, so the dashboard's polling outran the controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStudio } from './model-free-studio.mjs';
import { dashboardAttempt } from '../src/core/dashboard-state.mjs';

test("the dashboard state reads every attempt's phase events with one query, whatever the attempt count", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-state-phases-')),
    app = createStudio({ directory, port: 0 }),
    store = app.store;
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const attempts = [0, 1, 2, 3].map(i => ({
    id: `phase-attempt-${i}`,
    taskId: `phase-task-${i}`,
    projectId: 'project-legacy',
    workerId: 'W-01',
    status: 'review',
    artifacts: [],
  }));
  for (const attempt of attempts) store.insertAttempt(attempt, { text: 'Fixture', hash: 'fixture' });
  // Phases interleaved across attempts with log lines, and one attempt without phases.
  for (const attempt of attempts.slice(0, 3)) {
    const edit = store.startPhase(attempt, 'source.edit');
    store.event('log', attempt.taskId, attempt.id, 'stdout: fixture line');
    store.finishPhase(edit, 'succeeded', {});
  }
  store.finishPhase(store.startPhase(attempts[0], 'test'), 'failed', {});
  const prepare = store.db.prepare.bind(store.db);
  let phaseQueries = 0;
  const phaseSql = [];
  store.db.prepare = sql => {
    if (sql.includes("kind='phase'")) {
      phaseQueries++;
      phaseSql.push(sql);
    }
    return prepare(sql);
  };
  const state = store.state('project-legacy');
  assert.equal(phaseQueries, 1);
  assert.match(phaseSql.at(-1), /SELECT \*/);
  phaseQueries = 0;
  const compact = store.state('project-legacy', { mode: 'dashboard' });
  assert.equal(phaseQueries, 1);
  assert.doesNotMatch(phaseSql.at(-1), /SELECT \*/);
  assert.match(phaseSql.at(-1), /phaseId'\)='attempt'/);
  for (let index = 4; index < 44; index++) store.insertAttempt({ ...attempts[0], id: `phase-attempt-${index}` }, {});
  phaseQueries = 0;
  const grown = store.state('project-legacy', { mode: 'dashboard' });
  assert.equal(phaseQueries, 1);
  assert.equal(grown.attempts.length, compact.attempts.length + 40);
  assert.ok(grown.attempts.every(attempt => !Object.hasOwn(attempt, 'phaseEvents')));
  phaseQueries = 0;
  store.state('project-legacy');
  assert.equal(phaseQueries, 1);
  delete store.db.prepare;
  const listed = state.attempts.filter(attempt => attempt.id.startsWith('phase-attempt-'));
  assert.equal(listed.length, 4);
  // The same observations, in the same order, as reading each attempt on its own.
  for (const attempt of listed) assert.deepEqual(attempt.phaseEvents, store.phaseEvents(attempt.id));
  assert.deepEqual(
    listed.map(attempt => attempt.phaseEvents.map(event => `${event.payload.phaseId} ${event.payload.boundary}`)),
    [
      ['source.edit start', 'source.edit finish', 'test start', 'test finish'],
      ['source.edit start', 'source.edit finish'],
      ['source.edit start', 'source.edit finish'],
      [],
    ],
  );
});

// The shared run rules the dashboard reads (public/runs.js) check decision references and outcomes, and a
// reference reading of an attempt's full phase record checks its compact timing, without browser layout or
// live model calls.
const referenceTiming = `
function phaseDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Duration unavailable';
  if (milliseconds < 1000) return Math.round(milliseconds) + ' ms';
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? (milliseconds / 1000).toFixed(1).replace(/\\.0$/, '') + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}
function attemptPhases(a) {
  const occurrences = new Map();
  for (const event of a.phaseEvents || []) {
    const p = event.payload;
    if (p?.schemaVersion !== 'source-phase-v1' || p.attemptId !== a.id || p.taskId !== a.taskId || event.attempt_id !== a.id || event.task_id !== a.taskId || !p.occurrenceId || !['start', 'finish'].includes(p.boundary)) continue;
    const key = JSON.stringify([p.occurrenceId, p.phaseId, p.integrationOccurrenceId]);
    if (!occurrences.has(key)) occurrences.set(key, { phaseId: p.phaseId, occurrenceId: p.occurrenceId });
    occurrences.get(key)[p.boundary] = p;
  }
  return [...occurrences.values()];
}
function runExecutionTime(a, now) {
  const phases = attemptPhases(a).filter(p => p.phaseId === 'attempt'),
    terminal = phases.find(p => p.finish),
    label = duration => phaseDuration(duration) + (terminal?.finish.timing ? ' observed; completion unconfirmed' : ''),
    timestamp = value => (value ? Date.parse(value) : NaN),
    between = (start, finish) => {
      const milliseconds = timestamp(finish) - timestamp(start);
      return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : NaN;
    };
  if (terminal) {
    const duration = terminal.finish.durationMs,
      measured = Number.isFinite(duration) && duration >= 0 ? duration : between(terminal.start?.timestamp, terminal.finish.timestamp);
    if (Number.isFinite(measured)) return label(measured);
  }
  const recorded = between(a.startedAt, a.finishedAt);
  if (Number.isFinite(recorded)) return label(recorded);
  if (!terminal && !a.finishedAt && ['running', 'stopping'].includes(a.status)) {
    const elapsed = now - timestamp(phases.find(p => p.start)?.start.timestamp || a.startedAt);
    if (Number.isFinite(elapsed) && elapsed >= 0) return phaseDuration(elapsed) + ' elapsed';
  }
  return 'Timing unavailable';
}`;
function consumers() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../public/runs.js', import.meta.url), 'utf8'), context);
  vm.runInContext(referenceTiming, context);
  return context;
}

test('dashboard summaries preserve outcomes, review actions and timing while excluding large immutable detail', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-state-summary-')),
    app = createStudio({ directory, port: 0 }),
    store = app.store,
    context = consumers(),
    startedAt = '2026-10-20T12:00:00.000Z',
    finishedAt = '2026-10-20T12:01:00.000Z',
    instructionText = 'I'.repeat(1536 * 1024),
    large = 'large detail '.repeat(16384),
    names = ['running', 'stopping', 'completed', 'blocked', 'interrupted', 'legacy', 'candidate', 'reviewer'],
    statuses = ['running', 'stopping', 'review', 'blocked', 'interrupted', 'review', 'accepted', 'accepted'];
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const task = {
    ...store.task('D-001'),
    id: 'summary-story',
    kind: 'studio-development:change',
    status: 'done',
    workerId: 'W-01',
    projectId: 'project-legacy',
    workflowReference: { runId: 'summary-run', name: 'Fixture run' },
    lastAttemptId: 'summary-reviewer',
    acceptedAttemptId: 'summary-reviewer',
    sourceStage: {
      version: 'source-story-stages-v1',
      current: 'waiting-for-integration',
      phase: 'candidate-review',
      candidate: {
        taskId: 'summary-story',
        attemptId: 'summary-candidate',
        workerId: 'W-01',
        path: 'source-change.json',
        hash: 'manifest-hash',
        candidateHash: 'candidate-hash',
      },
      review: {
        taskId: 'summary-story',
        attemptId: 'summary-reviewer',
        workerId: 'W-02',
        path: 'source-change-review.json',
        hash: 'review-hash',
        verdict: 'pass',
      },
    },
  };
  store.putTask(task);
  for (const [index, name] of names.entries()) {
    const active = ['running', 'stopping'].includes(name),
      data = {
        id: 'summary-' + name,
        taskId: task.id,
        projectId: task.projectId,
        workerId: name === 'reviewer' ? 'W-02' : 'W-01',
        provider: 'codex',
        requestedModel: 'fixture-requested',
        reportedModel: 'fixture-reported',
        requestedEffort: 'high',
        status: statuses[index],
        startedAt,
        finishedAt: active ? null : finishedAt,
        configuration: { mode: 'workspace', provider: 'claude', testSandbox: 'none', instructions: large },
        assignment: {
          kind: name === 'reviewer' ? 'studio-development:change-review' : task.kind,
          stage: 'implementation',
          stageState: { current: 'review', history: [{ body: large }] },
          sourceStage: { current: 'implementing', phase: 'implementing', history: [{ body: large }] },
          brief: large,
          inputData: large,
          resources: ['fixture'],
        },
        inputReferences: [
          {
            taskId: task.id,
            attemptId: 'summary-candidate',
            summary: large,
            artifacts: [{ path: '../inputs/source-change.json', kind: 'source-change', hash: 'manifest-hash' }],
          },
        ],
        artifacts: [
          {
            path: name === 'reviewer' ? 'source-change-review.json' : 'source-change.json',
            kind: name === 'reviewer' ? 'source-change-review' : 'source-change',
            hash: name === 'reviewer' ? 'review-hash' : 'manifest-hash',
          },
        ],
        result: {
          taskId: task.id,
          outcome: name === 'blocked' ? 'blocked' : 'completed',
          summary: name + ' summary',
          checks: [{ name: 'Measured fixture', status: 'pass', evidence: 'Fixture only' }],
          issues: ['Fixture issue'],
          detail: large,
          artifacts: [{ body: large }],
        },
        controllerChecks: [{ name: 'Provenance', status: 'pass', evidence: 'Fixture identity' }],
        failedTests: [{ file: 'test/fixture.test.mjs', name: 'Fixture failure', detail: large }],
        error: name === 'blocked' ? 'Needs approved files' : name === 'interrupted' ? 'Restart observed' : null,
        acceptedAt: index >= 6 ? finishedAt : null,
        acceptedBy: { type: 'policy', revision: 4, reason: 'Reviewed fixture' },
        revisionRequestedBy: { type: 'director', at: finishedAt, reason: 'Revise fixture' },
      };
    if (name === 'legacy') delete data.projectId;
    if (name === 'blocked')
      data.scopeRequest = { files: ['test/needed.test.mjs'], newFiles: [], deleteFiles: [], reason: 'Coverage' };
    if (name === 'candidate') data.sourceCandidate = { sourceHash: 'candidate-hash', files: [{ body: large }] };
    if (name === 'reviewer')
      Object.assign(data, {
        candidateReviewVerdict: 'pass',
        candidateReviewFindings: [],
        candidateReviewNotes: ['Nonblocking note'],
        candidateReview: {
          taskId: task.id,
          attemptId: 'summary-candidate',
          path: 'source-change.json',
          hash: 'manifest-hash',
          candidateHash: 'candidate-hash',
          passed: true,
          detail: large,
        },
      });
    store.insertAttempt(data, { text: instructionText, hash: 'immutable-fixture', layers: [{ text: large }] });
    if (name !== 'legacy') {
      const phase = {
        payload: {
          schemaVersion: 'source-phase-v1',
          taskId: task.id,
          attemptId: data.id,
          phaseId: 'attempt',
          occurrenceId: 'enclosing-' + name,
          integrationOccurrenceId: null,
          boundary: 'start',
          timestamp: startedAt,
          outcome: null,
          durationMs: null,
        },
      };
      store.event('phase', task.id, data.id, JSON.stringify(phase.payload));
      // Timestamp fallback differs from the enclosing measured time on purpose.
      if (!active)
        store.event(
          'phase',
          task.id,
          data.id,
          JSON.stringify({
            ...phase.payload,
            boundary: 'finish',
            timestamp: finishedAt,
            durationMs: 4321,
            outcome: name === 'interrupted' ? 'interrupted' : 'succeeded',
            ...(name === 'interrupted' ? { timing: 'observed-until-restart' } : {}),
          }),
        );
      const nested = store.startPhase(data, 'test');
      // Insert historical large phase bodies directly: event() bounds newly
      // recorded messages, while the read contract must retain stored bytes.
      store.db.prepare('INSERT INTO events(time,kind,task_id,attempt_id,message) VALUES (?,?,?,?,?)').run(
        finishedAt,
        'phase',
        task.id,
        data.id,
        JSON.stringify({
          ...nested.payload,
          boundary: 'finish',
          timestamp: finishedAt,
          outcome: 'succeeded',
          durationMs: 9000,
          detail: large,
        }),
      );
    }
  }
  // Realistic bounded Activity/log preview, after the large phase messages.
  for (let index = 0; index < 160; index++) store.event('log', task.id, 'summary-running', 'fixture line ' + index);
  const before = store.db.prepare('SELECT id, snapshot, data FROM attempts ORDER BY rowid').all(),
    eventsBefore = store.db.prepare('SELECT * FROM events ORDER BY seq').all(),
    full = store.state(task.projectId),
    compact = store.state(task.projectId, { mode: 'dashboard' });
  assert.deepEqual(store.state(task.projectId, { mode: 'full' }), full);
  assert.equal(full.events.length, 150);
  // Agent output stays out of the compact state (MP-026): its recent events are the recorded steps
  // the log lines would have pushed out, and an attempt's lines stream to a tab watching it.
  assert.deepEqual(compact.events, eventsBefore.filter(event => event.kind !== 'log').slice(-150));
  assert.ok(compact.events.length > 0 && compact.events.every(event => event.kind !== 'log'));
  assert.equal(compact.attempts.length, 8);
  const instructionBytes = names.length * Buffer.byteLength(instructionText),
    fullBytes = Buffer.byteLength(JSON.stringify(full)),
    summaryBytes = Buffer.byteLength(JSON.stringify(compact));
  t.diagnostic(
    `Deterministic fixture bytes: instructions=${instructionBytes}, full=${fullBytes}, dashboard=${summaryBytes}`,
  );
  assert.ok(instructionBytes >= 12 * 1024 * 1024);
  assert.ok(summaryBytes <= fullBytes * 0.1);
  for (const summary of compact.attempts) {
    const original = full.attempts.find(item => item.id === summary.id);
    for (const key of [
      'id',
      'taskId',
      'projectId',
      'workerId',
      'provider',
      'requestedModel',
      'reportedModel',
      'requestedEffort',
      'status',
      'startedAt',
      'finishedAt',
      'acceptedAt',
      'acceptedBy',
      'revisionRequestedBy',
      'controllerChecks',
      'error',
      'candidateReviewVerdict',
      'candidateReviewFindings',
      'candidateReviewNotes',
      'scopeRequest',
    ])
      assert.deepEqual(summary[key], original[key], `${summary.id}: ${key}`);
    assert.equal(summary.assignment.kind, original.assignment.kind);
    assert.equal(summary.assignment.stage, original.assignment.stage);
    assert.deepEqual(summary.assignment.stageState, { current: 'review' });
    assert.deepEqual(summary.assignment.sourceStage, { current: 'implementing', phase: 'implementing' });
    // The CLI that ran (a code editor's attempt is recorded under its wrapping adapter) and where its candidate's
    // tests ran, for the story page; never the large fields.
    assert.deepEqual(summary.configuration, { mode: 'workspace', provider: 'claude', testSandbox: 'none' });
    assert.deepEqual(summary.artifacts, original.artifacts);
    for (const key of ['outcome', 'summary', 'checks', 'issues'])
      assert.deepEqual(summary.result[key], original.result[key]);
    assert.ok(!Object.hasOwn(summary, 'instructions'));
    assert.ok(!Object.hasOwn(summary, 'phaseEvents'));
    assert.ok(!JSON.stringify(summary).includes('large detail'));
    context.fullAttempt = original;
    context.timing = summary.executionTiming;
    const fullLabel = vm.runInContext('runExecutionTime(fullAttempt, Date.parse("2026-10-21T12:00:00Z"))', context),
      summaryLabel = vm.runInContext(
        `timing.durationMs !== null
        ? phaseDuration(timing.durationMs) + (timing.completionUnconfirmed ? ' observed; completion unconfirmed' : '')
        : timing.activeStart ? phaseDuration(Date.parse('2026-10-21T12:00:00Z') - Date.parse(timing.activeStart)) + ' elapsed'
        : 'Timing unavailable'`,
        context,
      );
    assert.equal(summaryLabel, fullLabel, summary.id);
  }
  assert.equal(compact.attempts.find(a => a.id === 'summary-completed').executionTiming.durationMs, 4321);
  assert.equal(compact.attempts.find(a => a.id === 'summary-legacy').executionTiming.durationMs, 60000);
  context.fullState = full;
  context.compactState = compact;
  assert.equal(
    vm.runInContext(
      'StudioRuns.integrationReview(fullState.tasks.find(t => t.id === "summary-story"), fullState.attempts)?.id',
      context,
    ),
    'summary-reviewer',
  );
  assert.equal(
    vm.runInContext(
      'StudioRuns.integrationReview(compactState.tasks.find(t => t.id === "summary-story"), compactState.attempts)?.id',
      context,
    ),
    'summary-reviewer',
  );
  // Each run's Needs you item says what the task's own explanation says, read from either state.
  const stories = state => {
    context.fixtureState = state;
    const model = JSON.parse(vm.runInContext('JSON.stringify(StudioRuns.buildRunStories(fixtureState))', context));
    for (const run of model)
      for (const item of run.needsYou) {
        const expected = JSON.parse(
          vm.runInContext(
            `JSON.stringify(StudioRuns.taskExplanation(fixtureState.tasks.find(t => t.id === ${JSON.stringify(item.taskId)}), fixtureState))`,
            context,
          ),
        );
        for (const key of ['reason', 'next', 'action', 'requiresDirector']) assert.equal(item[key], expected[key], key);
      }
    return model;
  };
  assert.deepEqual(stories(compact), stories(full));
  // Reading does not rewrite immutable snapshots, attempt data or phase journals.
  assert.deepEqual(store.db.prepare('SELECT id, snapshot, data FROM attempts ORDER BY rowid').all(), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM events ORDER BY seq').all(), eventsBefore);
  // An unsettled historical attempt must win until reconciliation; isolate the
  // integration journal cases only after recording that fixture reconciliation.
  assert.equal(stories(compact)[0].needsYou[0].kind, 'interrupted');
  store.updateAttempt({ ...store.attempt('summary-interrupted'), reconciledAt: finishedAt });
  const review = store.attempt('summary-reviewer');
  for (const state of ['verifying', 'needs-reconciliation', 'rejected', 'integrated']) {
    store.updateAttempt({
      ...review,
      sourceIntegration: {
        id: 'integration-summary',
        state,
        method: 'merge',
        reviewTaskId: task.id,
        reviewAttemptId: review.id,
        phaseOccurrenceId: 'integration-occurrence',
        startedAt,
        finishedAt: state === 'verifying' ? null : finishedAt,
        repository: { commit: 'abcd123456', branch: 'main', detail: large },
        error: 'Fixture integration reason',
        changes: [{ body: large }],
        verification: {
          stdout: large,
          stderr: large,
          instructions: large,
          passed: false,
          phaseId: 'integration.verification',
          timedOut: true,
          totals: null,
          tapDurationMs: null,
          exitCode: null,
          signal: 'SIGTERM',
          failedTests: [{ name: 'Cancelled verification', file: 'timeout.test.mjs', error: large }],
          checks: [
            {
              name: 'Integration Node test suite',
              status: 'fail',
              evidence: 'Verification time limit reached.',
              stdout: large,
            },
          ],
        },
      },
    });
    const integratedFull = store.state(task.projectId),
      integratedCompact = store.state(task.projectId, { mode: 'dashboard' });
    assert.deepEqual(stories(integratedCompact), stories(integratedFull), state);
    const journal = integratedCompact.attempts.find(a => a.id === review.id).sourceIntegration;
    assert.equal(journal.state, state);
    assert.equal(journal.reviewAttemptId, review.id);
    assert.equal(journal.error, 'Fixture integration reason');
    assert.deepEqual(journal.verification, {
      passed: false,
      phaseId: 'integration.verification',
      timedOut: true,
      exitCode: null,
      signal: 'SIGTERM',
      tapDurationMs: null,
      totals: null,
      failedTests: [{ name: 'Cancelled verification', file: 'timeout.test.mjs' }],
      checks: [{ name: 'Integration Node test suite', status: 'fail', evidence: 'Verification time limit reached.' }],
    });
    assert.equal(integratedFull.attempts.find(a => a.id === review.id).sourceIntegration.verification.stdout, large);
    assert.ok(!JSON.stringify(journal).includes('large detail'));
    if (state === 'needs-reconciliation')
      assert.ok(stories(integratedCompact)[0].needsYou.some(item => item.action === 'Reconcile source integration'));
  }
  store.updateAttempt({
    ...review,
    candidateReviewVerdict: 'needs-work',
    candidateReviewFindings: ['Blocking defect'],
    controllerChecks: [{ name: 'Fixture failure', status: 'fail', evidence: 'Measured fixture' }],
  });
  const rejected = store.state(task.projectId, { mode: 'dashboard' });
  assert.deepEqual(rejected.attempts.find(a => a.id === review.id).candidateReviewFindings, ['Blocking defect']);
  assert.deepEqual(stories(rejected), stories(store.state(task.projectId)));
  store.db
    .prepare('UPDATE attempts SET data=? WHERE id=?')
    .run(before.find(row => row.id === review.id).data, review.id);
  store.db
    .prepare('UPDATE attempts SET data=? WHERE id=?')
    .run(before.find(row => row.id === 'summary-interrupted').data, 'summary-interrupted');
  // A growing instruction history has exactly zero effect on dashboard bytes.
  const update = store.db.prepare('UPDATE attempts SET snapshot=? WHERE id=?');
  for (const row of before) {
    const snapshot = JSON.parse(row.snapshot);
    update.run(JSON.stringify({ ...snapshot, text: snapshot.text.repeat(2) }), row.id);
  }
  assert.equal(JSON.stringify(store.state(task.projectId, { mode: 'dashboard' })), JSON.stringify(compact));
  // Even malformed snapshot JSON cannot be selected or parsed in this mode.
  for (const row of before) update.run('not JSON: instruction snapshot', row.id);
  const prepare = store.db.prepare.bind(store.db),
    queries = [];
  t.mock.method(store.db, 'prepare', sql => {
    queries.push(sql);
    if (/FROM attempts/i.test(sql)) {
      assert.ok(!/snapshot|SELECT\s+\*/i.test(sql), sql);
    }
    return prepare(sql);
  });
  t.mock.method(store, 'allAttempts', () => assert.fail('summary expanded full attempts'));
  t.mock.method(store, 'phaseEventsByAttempt', () => assert.fail('summary expanded phase histories'));
  assert.deepEqual(store.state(task.projectId, { mode: 'dashboard' }), compact);
  assert.equal(queries.filter(sql => sql.includes("kind='phase'")).length, 1);
  assert.throws(() => store.state(task.projectId, { mode: 'unknown' }), /State mode/);
});

test('compact stop evidence is bounded and additive while legacy rows remain readable', () => {
  const large = 'x'.repeat(20000),
    failures = Array.from({ length: 30 }, () => ({ name: large, file: large, error: large })),
    detail = {
      id: 'timeout-attempt',
      taskId: 'timeout-task',
      status: 'failed',
      testEvidence: { totals: null, tapDurationMs: null, failedTests: failures, stdout: large },
      failedTests: failures,
      stopContext: {
        reason: 'time-limit',
        timedOut: true,
        requestedAt: '2026-10-21T12:00:00Z',
        taskKind: 'studio-development:change',
        stage: 'implementing',
        activity: 'test',
        phaseId: 'test',
        occurrenceId: 'test-occurrence',
        phaseFinished: false,
        testEvidence: { totals: null, tapDurationMs: null, failedTests: failures, stderr: large },
        instructions: large,
      },
    },
    compact = dashboardAttempt(detail);
  assert.equal(compact.stopContext.activity, 'test');
  assert.equal(compact.stopContext.occurrenceId, 'test-occurrence');
  assert.equal(compact.stopContext.phaseFinished, false);
  assert.equal(compact.testEvidence.totals, null);
  for (const names of [
    compact.failedTests,
    compact.testEvidence.failedTests,
    compact.stopContext.testEvidence.failedTests,
  ]) {
    assert.equal(names.length, 20);
    assert.ok(
      names.every(item => item.name.length === 300 && item.file.length === 300 && !Object.hasOwn(item, 'error')),
    );
  }
  assert.ok(!JSON.stringify(compact).includes(large));
  assert.equal(detail.failedTests[0].error, large, 'Full detail remains unchanged.');
  const legacy = dashboardAttempt({ id: 'legacy', status: 'failed', error: 'Assignment time limit reached.' });
  for (const name of ['stopContext', 'testEvidence', 'failedTests']) assert.equal(Object.hasOwn(legacy, name), false);
});

test('compact general work continuation keeps the earlier attempt, carried paths and fresh reason, bounded', () => {
  const large = 'x'.repeat(5000),
    carried = {
      id: 'carried-attempt',
      status: 'review',
      assignment: { kind: 'general:work' },
      continueFrom: {
        attemptId: 'earlier-attempt',
        files: [
          { path: 'draft/plan.md', hash: 'hash-plan', bytes: 12 },
          { path: 'notes.md', hash: 'hash-notes', bytes: 7 },
        ],
      },
    },
    fresh = {
      id: 'fresh-attempt',
      status: 'review',
      continueFrom: { attemptId: 'carried-attempt', files: [], fresh: { reason: 'did not verify ' + large } },
    },
    many = {
      id: 'many-attempt',
      status: 'review',
      continueFrom: {
        attemptId: large,
        files: Array.from({ length: 35 }, (_, n) => ({ path: `${n}-${large}`, hash: 'h', bytes: 1 })),
      },
    };
  assert.deepEqual(dashboardAttempt(carried).continueFrom, {
    attemptId: 'earlier-attempt',
    files: [{ path: 'draft/plan.md' }, { path: 'notes.md' }],
  });
  const compactFresh = dashboardAttempt(fresh).continueFrom;
  assert.deepEqual([compactFresh.attemptId, compactFresh.files], ['carried-attempt', []]);
  assert.equal(compactFresh.fresh.reason, ('did not verify ' + large).slice(0, 1000));
  const compactMany = dashboardAttempt(many).continueFrom;
  assert.equal(compactMany.attemptId.length, 300);
  assert.equal(compactMany.files.length, 30);
  assert.equal(compactMany.filesOmitted, 5);
  assert.ok(compactMany.files.every((item, n) => item.path === `${n}-${large}`.slice(0, 300)));
  assert.ok(!JSON.stringify(dashboardAttempt(many)).includes(large));
  assert.equal(fresh.continueFrom.fresh.reason.length, large.length + 15, 'Full detail remains unchanged.');
  assert.equal(Object.hasOwn(dashboardAttempt({ id: 'first', status: 'review' }), 'continueFrom'), false);
});

test('compact code story continuation reads sourceChange.continueFrom in the general work shape, which a top-level continueFrom overrides', () => {
  const story = (id, continueFrom, extra = {}) => ({
      id,
      status: 'review',
      assignment: { kind: 'studio-development:change' },
      sourceChange: {
        allowedFiles: ['src/a.mjs'],
        source: { files: [{ path: 'src/a.mjs', hash: 'base-a' }] },
        ...(continueFrom ? { continueFrom } : {}),
      },
      ...extra,
    }),
    carried = story('carried-story', {
      attemptId: 'earlier-story',
      files: [
        { path: 'src/a.mjs', hash: 'hash-a' },
        { path: 'test/a.test.mjs', hash: 'hash-test' },
      ],
      skipped: [{ path: 'src/gone.mjs', reason: 'no longer in the approved files' }],
    }),
    many = story('many-story', {
      attemptId: 'earlier-many',
      files: Array.from({ length: 35 }, (_, n) => ({ path: `src/${n}.mjs`, hash: `hash-${n}` })),
      skipped: [],
    }),
    fresh = story('fresh-story', {
      attemptId: 'earlier-fresh',
      files: [],
      skipped: [],
      fresh: {
        reason: 'the source of files it changed was committed since that attempt',
        paths: ['src/a.mjs', 'test/a.test.mjs'],
      },
    }),
    longFresh = story('long-fresh', {
      attemptId: 'earlier-long',
      files: [],
      skipped: [],
      fresh: {
        reason: 'committed since',
        paths: Array.from({ length: 200 }, (_, n) => `src/${'p'.repeat(20)}-${n}.mjs`),
      },
    }),
    first = story('first-story'),
    both = story(
      'both-story',
      { attemptId: 'story-continuation', files: [{ path: 'src/a.mjs', hash: 'hash-a' }], skipped: [] },
      { continueFrom: { attemptId: 'general-continuation', files: [{ path: 'notes.md', hash: 'hash-notes' }] } },
    ),
    records = [carried, many, fresh, longFresh, first, both],
    before = structuredClone(records);
  const compact = dashboardAttempt(carried);
  assert.deepEqual(compact.continueFrom, {
    attemptId: 'earlier-story',
    files: [{ path: 'src/a.mjs' }, { path: 'test/a.test.mjs' }],
  });
  assert.equal(Object.hasOwn(compact, 'sourceChange'), false, 'No other sourceChange field is projected.');
  assert.ok(!JSON.stringify(compact).includes('hash-a'), 'Carried file hashes stay in the full record.');
  assert.ok(!JSON.stringify(compact).includes('src/gone.mjs'), 'Skipped paths are not projected.');
  const compactMany = dashboardAttempt(many).continueFrom;
  assert.equal(compactMany.files.length, 30);
  assert.equal(compactMany.filesOmitted, 5);
  assert.deepEqual(compactMany.files.at(-1), { path: 'src/29.mjs' });
  assert.deepEqual(dashboardAttempt(fresh).continueFrom, {
    attemptId: 'earlier-fresh',
    files: [],
    fresh: { reason: 'the source of files it changed was committed since that attempt (src/a.mjs, test/a.test.mjs)' },
  });
  const longReason = dashboardAttempt(longFresh).continueFrom.fresh.reason;
  assert.equal(longReason.length, 1000, 'The named paths share the 1000-character cut.');
  assert.ok(longReason.startsWith('committed since (src/'));
  assert.equal(Object.hasOwn(dashboardAttempt(first), 'continueFrom'), false);
  assert.deepEqual(dashboardAttempt(both).continueFrom, {
    attemptId: 'general-continuation',
    files: [{ path: 'notes.md' }],
  });
  assert.deepEqual(records, before, 'Full records remain unchanged.');
});

test('compact execution timing keeps enclosing ownership, terminal precedence and historical fallback', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-state-timing-')),
    app = createStudio({ directory, port: 0 }),
    store = app.store,
    context = consumers(),
    start = '2026-10-20T12:00:00Z',
    end = '2026-10-20T12:00:10Z',
    cases = [
      { name: 'measured-zero', duration: 0, expected: 0 },
      { name: 'negative', duration: -1, expected: 10000 },
      { name: 'boolean', duration: false, expected: 10000 },
      { name: 'timestamp', duration: null, expected: 10000 },
      { name: 'orphan-finish', duration: null, noStart: true, expected: 60000 },
      { name: 'terminal-unknown', duration: null, noStart: true, noFinish: true, expected: null },
      { name: 'unconfirmed', duration: 2000, timing: 'shutdown-requested', expected: 2000 },
      { name: 'stopping', active: true, expected: null },
      { name: 'interrupted-no-terminal', interrupted: true, noFinish: true, expected: null },
    ];
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const item of cases) {
    const attempt = {
      id: item.name,
      taskId: 'timing-task',
      startedAt: start,
      finishedAt: item.active || item.noFinish ? null : '2026-10-20T12:01:00Z',
      status: item.active ? 'stopping' : item.interrupted ? 'interrupted' : 'review',
      artifacts: [],
    };
    store.insertAttempt(attempt, { text: 'Immutable fixture' });
    const payload = {
        schemaVersion: 'source-phase-v1',
        attemptId: attempt.id,
        taskId: attempt.taskId,
        phaseId: 'attempt',
        occurrenceId: 'enclosing',
        integrationOccurrenceId: null,
      },
      append = value => store.event('phase', attempt.taskId, attempt.id, JSON.stringify({ ...payload, ...value }));
    // Foreign payloads cannot supply enclosing times even on an owned event row.
    append({ boundary: 'finish', taskId: 'foreign-task', durationMs: 999 });
    append({ boundary: 'finish', schemaVersion: 'other-v1', durationMs: 888 });
    append({ boundary: 'finish', attemptId: 'foreign-attempt', durationMs: 777 });
    if (!item.noStart) append({ boundary: 'start', timestamp: start });
    if (!item.active && !item.interrupted)
      append({ boundary: 'finish', timestamp: end, durationMs: item.duration, timing: item.timing });
    // Nested and integration durations do not contribute to execution totals.
    append({ boundary: 'finish', phaseId: 'test', occurrenceId: 'test', durationMs: 900000 });
    append({
      boundary: 'finish',
      phaseId: 'integration.verification',
      occurrenceId: 'integration',
      durationMs: 900000,
    });
  }
  const full = store.state(),
    compact = store.state(undefined, { mode: 'dashboard' });
  for (const item of cases) {
    const summary = compact.attempts.find(a => a.id === item.name),
      original = full.attempts.find(a => a.id === item.name),
      timing = summary.executionTiming;
    assert.equal(timing.durationMs, item.expected, item.name);
    assert.equal(timing.activeStart, item.active ? start : null, item.name);
    assert.equal(timing.completionUnconfirmed, !!item.timing, item.name);
    context.original = original;
    context.compactTiming = timing;
    assert.equal(
      vm.runInContext(
        `compactTiming.durationMs !== null
      ? phaseDuration(compactTiming.durationMs) + (compactTiming.completionUnconfirmed ? ' observed; completion unconfirmed' : '')
      : compactTiming.activeStart ? phaseDuration(Date.parse('2026-10-20T12:02:00Z') - Date.parse(compactTiming.activeStart)) + ' elapsed'
      : 'Timing unavailable'`,
        context,
      ),
      vm.runInContext(`runExecutionTime(original, Date.parse('2026-10-20T12:02:00Z'))`, context),
      item.name,
    );
  }
});
