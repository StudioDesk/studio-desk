import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { dashboardAttempt } from '../src/core/dashboard-state.mjs';
import { failedTests } from '../src/connectors/source-checks.mjs';
import { newRun } from '../src/core/graph.mjs';
import { createStudio } from './model-free-studio.mjs';
import {
  directorInputsOf,
  validateIdeaFiles,
  createDirectorInputs,
  stageIdeaInputs,
  readIdeaInput,
  directorInputsFor,
} from '../src/core/idea-inputs.mjs';
import { templateStages } from '../src/core/stage-template.mjs';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../public/runs.js', import.meta.url), 'utf8'), context);
const { buildRunStories } = context.StudioRuns;

test('stage and proposal run identities retain the whole original manifest across restart without rewriting task rows', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inherited-inputs-'));
  let app = createStudio({ directory, port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const files = validateIdeaFiles([
      { name: 'first.md', data: Buffer.from('# First\n').toString('base64') },
      { name: 'second.json', data: Buffer.from('{"second":true}').toString('base64') },
    ]),
    run = { id: 'run-33333333-3333-4333-8333-333333333333', projectId: 'project-legacy' };
  run.directorInputs = createDirectorInputs(run.projectId, run.id, files);
  stageIdeaInputs(app.store, run, files);
  app.store.putRun(run);
  const task = {
      id: 'inherited-story',
      kind: 'fixture:draft',
      projectId: run.projectId,
      dependencies: [],
      runReference: { runId: run.id, revision: 2 },
      stageState: { current: 'review', staffed: { review: { workerId: 'W-07' } } },
    },
    stages = templateStages('fixture:draft', { stages: [{ key: 'draft' }, { key: 'review', kind: 'fixture:review' }] });
  app.store.putTask(task);
  const row = () => app.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id).data,
    before = row(),
    original = structuredClone(run.directorInputs);
  for (const view of [task, stages.view(task)]) {
    assert.deepEqual(directorInputsFor(app.store, view), original);
    assert.throws(() => directorInputsFor(app.store, { ...view, directorInputs: [] }), /manifest changed/);
    assert.throws(
      () => directorInputsFor(app.store, { ...view, directorInputs: original.slice(0, 1) }),
      /manifest changed/,
    );
  }
  assert.throws(
    () => directorInputsFor(app.store, { ...task, runReference: undefined, directorInputs: original.slice(0, 1) }),
    /complete original/,
  );
  assert.equal(row(), before);
  await app.close();
  app = createStudio({ directory, port: 0 });
  assert.equal(row(), before);
  assert.deepEqual(directorInputsFor(app.store, stages.view(app.store.task(task.id))), original);
  assert.deepEqual(
    directorInputsOf(app.store.task(task.id)),
    [],
    'Inherited inputs are resolved from the recorded run, not added by a model or backfilled into history.',
  );
});

test('historical run and task inputs default empty without rewriting rows or database schema', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-legacy-inputs-'));
  let app = createStudio({ directory, port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const run = { id: 'run-historical', schemaVersion: 'run-v1', projectId: 'project-legacy', revisions: [] };
  app.store.putRun(run);
  const rows = () => ({
      run: app.store.db.prepare('SELECT data FROM settings WHERE id=?').get('run:' + run.id).data,
      tasks: app.store.db.prepare('SELECT id, data FROM tasks ORDER BY id').all(),
      schema: app.store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    }),
    before = rows();
  assert.deepEqual(directorInputsOf(app.store.run(run.id)), []);
  assert.ok(
    app.store.state().tasks.every(task => Array.isArray(task.directorInputs) && task.directorInputs.length === 0),
  );
  assert.deepEqual(rows(), before);
  await app.close();
  app = createStudio({ directory, port: 0 });
  assert.deepEqual(directorInputsOf(app.store.run(run.id)), []);
  assert.deepEqual(rows(), before);
  assert.equal(Object.hasOwn(app.store.run(run.id), 'directorInputs'), false);
  assert.ok(app.store.tasks().every(task => !Object.hasOwn(task, 'directorInputs')));
});

test('local input storage rejects tampering, missing data and redirected directories without overwriting inputs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-input-storage-')),
    app = createStudio({ directory, port: 0 }),
    files = validateIdeaFiles([{ name: 'notes.txt', data: Buffer.from('Original bytes').toString('base64') }]),
    run = { id: 'run-11111111-1111-4111-8111-111111111111', projectId: 'project-legacy' };
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  run.directorInputs = createDirectorInputs(run.projectId, run.id, files);
  stageIdeaInputs(app.store, run, files);
  app.store.putRun(run);
  const item = run.directorInputs[0],
    root = path.join(directory, 'projects', run.projectId, 'idea-inputs'),
    folder = path.join(root, run.id),
    filename = path.join(folder, item.id + '.bin');
  assert.throws(() => stageIdeaInputs(app.store, run, files), /EEXIST/);
  assert.deepEqual(readIdeaInput(app.store, run.projectId, run.id, item.id).bytes, files[0].bytes);
  const snapshot = app.store.run(run.id);
  snapshot.directorInputs[0].sha256 = '0'.repeat(64);
  assert.throws(() => app.store.putRun(snapshot), /immutable/);
  fs.unlinkSync(filename);
  assert.throws(() => readIdeaInput(app.store, run.projectId, run.id, item.id), /missing|ENOENT/);
  fs.writeFileSync(filename, files[0].bytes);
  // Model a redirected component at the filesystem boundary. This avoids
  // requiring OS symlink privileges and checks both read and write refusal.
  const originalStat = fs.lstatSync,
    redirected = t.mock.method(fs, 'lstatSync', function (filename, ...args) {
      const stat = originalStat.call(this, filename, ...args);
      if (filename === root) return { isSymbolicLink: () => true, isDirectory: () => true };
      return stat;
    });
  assert.throws(() => readIdeaInput(app.store, run.projectId, run.id, item.id), /local directories/);
  const newRun = { ...run, id: 'run-22222222-2222-4222-8222-222222222222' };
  newRun.directorInputs = createDirectorInputs(run.projectId, newRun.id, files);
  assert.throws(() => stageIdeaInputs(app.store, newRun, files), /local directories/);
  redirected.mock.restore();
  assert.deepEqual(fs.readdirSync(root), [run.id], 'No writes follow a redirected input root.');
  assert.deepEqual(fs.readFileSync(filename), files[0].bytes);
});

const at = minute => new Date(Date.UTC(2026, 9, 13, 19, minute)).toISOString();
const run = { id: 'workflow-x', name: 'Check and improve', version: 1, runId: 'run-1', hash: 'h' };
const base = {
  // As the controller lists them (registries.adapters.modelFree()).
  modelFreeProviders: ['mock', 'local-operation', 'source-checks', 'unreal-gateway-fixture'],
  workers: [
    { id: 'W-02', displayName: 'Eli' },
    { id: 'W-06', displayName: 'Avery' },
    { id: 'W-07', displayName: 'Morgan' },
  ],
  taskKinds: {
    checks: { cardLabel: 'Source checks' },
    review: { cardLabel: 'Source review' },
    change: { cardLabel: 'Source improvement' },
    'studio-development:change-review': { cardLabel: 'Candidate review' },
  },
};
const task = (id, fields) => ({
  id,
  title: id + ' title',
  brief: id + ' brief',
  dependencies: [],
  status: 'done',
  createdAt: at(0),
  ...fields,
});
const attempt = (id, taskId, minute, fields) => ({
  id,
  taskId,
  status: 'accepted',
  startedAt: at(minute),
  finishedAt: at(minute + 1),
  result: { outcome: 'completed', summary: id + ' summary', checks: [], issues: [] },
  ...fields,
});

test('a run story follows proposals and retries, in order, with who decided each step', () => {
  const state = {
    ...base,
    tasks: [
      task('C', {
        kind: 'checks',
        workerId: 'W-06',
        workflowReference: { ...run, key: 'check', brief: 'Fix the panel' },
      }),
      task('R', {
        kind: 'review',
        workerId: 'W-07',
        workflowReference: { ...run, key: 'review' },
        dependencies: ['C'],
      }),
      task('X', {
        kind: 'change',
        workerId: 'W-02',
        createdAt: at(5),
        dependencies: ['R'],
        proposalReference: { taskId: 'R', attemptId: 'a-R' },
        approval: { status: 'approved', decidedAt: at(6), by: { type: 'director' } },
      }),
      task('V-old', {
        kind: 'studio-development:change-review',
        workerId: 'W-07',
        status: 'denied',
        createdAt: at(8),
        proposalReference: { taskId: 'X', attemptId: 'a-X1' },
        approval: { status: 'denied', decidedAt: at(10), by: { type: 'controller' }, reason: 'Superseded' },
      }),
      task('Y', {
        kind: 'change',
        workerId: 'W-02',
        status: 'review',
        createdAt: at(12),
        retryOf: 'X',
        proposalReference: { taskId: 'R', attemptId: 'a-R' },
        autonomyNote: 'Candidate checks failed: Candidate Node test suite. More detail.',
      }),
      task('Unrelated', { kind: 'change', workerId: 'W-02', createdAt: at(1) }),
    ],
    attempts: [
      attempt('a-C', 'C', 0, { acceptedAt: at(1), acceptedBy: { type: 'policy', reason: 'Checks passed.' } }),
      attempt('a-R', 'R', 2, { finishedAt: at(5), acceptedAt: at(5), acceptedBy: { type: 'policy' } }),
      attempt('a-X1', 'X', 7, {
        status: 'revision_requested',
        finishedAt: at(8),
        result: {
          summary: 'Negative candidate: 3/4 tests passed.',
          checks: [{ name: 'Candidate Node test suite', status: 'fail' }],
        },
        failedTests: [{ file: 'a.test.mjs', name: 'keeps records' }],
        revisionRequestedBy: { type: 'policy', at: at(8), reason: 'Candidate checks failed.' },
      }),
      attempt('a-X2', 'X', 9, { acceptedAt: at(11), acceptedBy: { type: 'director' } }),
      attempt('a-Y1', 'Y', 13, { status: 'review' }),
    ],
  };
  const [story] = buildRunStories(state);
  assert.equal(buildRunStories(state).length, 1, 'Tasks outside a workflow run are not stories.');
  assert.equal(story.brief, 'Fix the panel');
  assert.deepEqual([...story.taskIds].sort(), ['C', 'R', 'V-old', 'X', 'Y']);
  const texts = story.steps.map(step => step.text);
  const index = text => texts.findIndex(item => item.includes(text));
  assert.equal(texts[0], 'Run started with the brief above.');
  assert.ok(index('Avery finished.') < index('Autonomy accepted the result of source checks C'));
  assert.ok(index('Morgan finished.') < index('Morgan proposed a source improvement X for Eli.'));
  assert.ok(index('You approved source improvement X.') > index('Morgan proposed'));
  const failed = story.steps.find(
    step => step.text === 'Eli finished, but checks failed (Candidate Node test suite). [mode not recorded]',
  );
  assert.deepEqual([...failed.tests], ['a.test.mjs: keeps records']);
  assert.match(failed.detail, /3\/4 tests passed/);
  assert.ok(index('Autonomy sent source improvement X back for another attempt.') > index('checks failed'));
  assert.ok(index('Eli started source improvement X (attempt 2).') > 0);
  assert.ok(index('Candidate review V-old was retired: a newer attempt replaced the work it was for.') > 0);
  assert.ok(
    index('Autonomy retried X as a new source improvement Y.') >
      index('You accepted the result of source improvement X.'),
  );
  assert.equal(story.outcome.label, 'Needs you');
  assert.equal(story.needsYou.length, 1);
  assert.equal(story.needsYou[0].taskId, 'Y');
  assert.equal(story.needsYou[0].action, 'Accept result');
  assert.match(story.needsYou[0].text, /ready for acceptance/);
});

test('run stories list approvals, stuck steps, integration and outcomes', () => {
  const stuck = buildRunStories({
    ...base,
    tasks: [
      task('C', { kind: 'checks', workerId: 'W-06', status: 'cancelled', workflowReference: { ...run, key: 'check' } }),
      task('R', {
        kind: 'review',
        workerId: 'W-07',
        status: 'blocked',
        dependencies: ['C'],
        workflowReference: { ...run, key: 'review' },
      }),
      task('P', {
        kind: 'change',
        workerId: 'W-02',
        status: 'backlog',
        approval: { status: 'pending' },
        proposalReference: { taskId: 'R', attemptId: 'none' },
      }),
    ],
    attempts: [attempt('a-C', 'C', 0, { status: 'cancelled' })],
  })[0];
  // P waits for R, which can still be accepted; once R is closed, P can be denied.
  assert.deepEqual(JSON.parse(JSON.stringify(stuck.needsYou.map(item => [item.taskId, item.action]))), [
    ['C', 'Start assignment'],
    ['R', 'Start assignment'],
    ['P', null],
  ]);
  assert.ok(stuck.steps.some(step => step.text === 'Avery was cancelled. [mode not recorded]'));

  // A step proposed when its source finished waits for that source's acceptance.
  const waitingOn = status =>
    buildRunStories({
      ...base,
      tasks: [
        task('R', { kind: 'review', workerId: 'W-07', status, workflowReference: { ...run, key: 'review' } }),
        task('P', {
          kind: 'change',
          title: 'Next step',
          workerId: 'W-02',
          status: 'backlog',
          approval: { status: 'pending' },
          proposalReference: { taskId: 'R', attemptId: 'a-R' },
        }),
      ],
      attempts: [attempt('a-R', 'R', 0, { status: status === 'done' ? 'accepted' : status })],
    })[0].needsYou;
  const actions = items => JSON.parse(JSON.stringify(items.map(item => item.taskId + ' ' + item.action)));
  const inReview = waitingOn('review');
  assert.deepEqual(actions(inReview), ['R Accept result', 'P null']);
  assert.equal(inReview[1].kind, 'prerequisite-acceptance');
  for (const status of ['done', 'denied']) assert.deepEqual(actions(waitingOn(status)), ['P Approve work'], status);
  const { awaitedSource } = context.StudioRuns,
    source = { id: 'R', status: 'review' };
  assert.equal(
    awaitedSource({ approval: { status: 'pending' }, proposalReference: { taskId: 'R' } }, () => source),
    source,
  );
  assert.equal(
    awaitedSource({ approval: { status: 'approved' }, proposalReference: { taskId: 'R' } }, () => source),
    null,
  );

  const review = task('V', {
    kind: 'studio-development:change-review',
    workerId: 'W-07',
    acceptedAttemptId: 'a-V',
    lastAttemptId: 'a-V',
    workflowReference: { ...run, key: 'v' },
  });
  const passed = attempt('a-V', 'V', 3, { candidateReviewVerdict: 'pass' });
  const ready = buildRunStories({ ...base, tasks: [review], attempts: [passed] })[0];
  assert.equal(ready.needsYou[0].action, 'Inspect stage');
  assert.equal(ready.outcome.label, 'Needs you');

  const verifying = buildRunStories({
    ...base,
    tasks: [review],
    attempts: [{ ...passed, sourceIntegration: { state: 'verifying', startedAt: at(6) } }],
  })[0];
  assert.equal(verifying.outcome.label, 'In progress');
  assert.equal(verifying.needsYou[0].requiresDirector, false);

  const rejected = buildRunStories({
    ...base,
    tasks: [review],
    attempts: [
      {
        ...passed,
        sourceIntegration: { state: 'rejected', startedAt: at(6), finishedAt: at(7), error: '0/1 tests passed.' },
      },
    ],
  })[0];
  assert.equal(rejected.needsYou[0].action, 'Inspect stage');
  assert.ok(rejected.steps.some(step => step.text === 'Integration rejected.' && step.detail === '0/1 tests passed.'));

  const done = buildRunStories({
    ...base,
    tasks: [review],
    attempts: [
      {
        ...passed,
        sourceIntegration: {
          state: 'integrated',
          startedAt: at(6),
          finishedAt: at(7),
          repository: { commit: 'abcdef1234' },
        },
      },
    ],
  })[0];
  assert.equal(done.outcome.label, 'Integrated');
  assert.equal(done.outcome.text, 'The change was committed as abcdef1.');
  assert.ok(done.steps.some(step => step.text === 'Integrated as commit abcdef1.'));
  assert.equal(done.needsYou.length, 0);
});

test("attempt steps show the delivery mode each attempt recorded, never the employee's current mode", () => {
  // Every employee's (and H's task override's) current mode is set after the attempts ran.
  const stepTexts = currentMode => {
    const [story] = buildRunStories({
      ...base,
      workers: base.workers.map(worker => ({ ...worker, provider: 'claude', mode: currentMode })),
      tasks: [
        task('C', { kind: 'checks', workerId: 'W-06', workflowReference: { ...run, key: 'check' } }),
        task('W', { kind: 'change', workerId: 'W-02', workflowReference: { ...run, key: 'w' } }),
        task('T', { kind: 'review', workerId: 'W-07', workflowReference: { ...run, key: 't' } }),
        task('H', {
          kind: 'change',
          workerId: 'W-02',
          workflowReference: { ...run, key: 'h' },
          execution: { mode: currentMode },
        }),
      ],
      attempts: [
        // The controller ran these checks; the mode it copied from the employee never applied.
        attempt('a-C', 'C', 0, {
          provider: 'source-checks',
          configuration: { provider: 'claude', mode: 'workspace', executionAdapter: 'source-checks' },
        }),
        attempt('a-W', 'W', 2, {
          provider: 'source-change',
          configuration: { provider: 'claude', mode: 'workspace', executionAdapter: 'source-change' },
        }),
        attempt('a-T', 'T', 4, { provider: 'claude', configuration: { provider: 'claude', mode: 'text' } }),
        // Recorded before attempts named a mode.
        attempt('a-H', 'H', 6, { provider: 'claude', configuration: { provider: 'claude' } }),
      ],
    });
    return [...story.steps.map(step => step.text)];
  };
  const texts = stepTexts('text');
  const expected = [
    'Eli started source improvement W. [workspace]',
    'Eli finished. [workspace]',
    'Morgan started source review T. [text]',
    'Morgan finished. [text]',
    'Eli started source improvement H. [mode not recorded]',
    'Eli finished. [mode not recorded]',
    'Avery started source checks C.',
    'Avery finished.',
  ];
  for (const text of expected) assert.ok(texts.includes(text), text);
  assert.equal(texts.filter(text => text.endsWith('[text]')).length, 2, 'Only the attempt that recorded text.');
  assert.deepEqual(stepTexts('workspace'), texts, 'Changing current settings keeps the recorded labels.');
});

test('failed test names come from top-level TAP failures with their files', () => {
  const log = [
    'TAP version 13',
    '# Subtest: keeps records',
    '    not ok 1 - nested detail',
    'not ok 1 - keeps records',
    '  ---',
    "  location: 'C:\\\\repo\\\\test\\\\records.test.mjs:12:1'",
    '  ...',
    'ok 2 - passes',
    'not ok 3 - has no location',
    '# tests 3',
  ].join('\n');
  assert.deepEqual(failedTests(log), [
    { name: 'keeps records', file: 'records.test.mjs' },
    { name: 'has no location', file: '' },
  ]);
});

test('failed tests carry the start of their error from block and inline TAP diagnostics', () => {
  const log = [
    'not ok 1 - closes the store',
    '  ---',
    "  location: 'C:\\\\repo\\\\test\\\\stage.test.mjs:40:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    ',
    "    'blocked' !== 'ready'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    'not ok 2 - reads the journal',
    '  ---',
    "  error: 'Store is closed.'",
    '  ...',
  ].join('\n');
  assert.deepEqual(failedTests(log), [
    {
      name: 'closes the store',
      file: 'stage.test.mjs',
      error: "Expected values to be strictly equal: 'blocked' !== 'ready'",
    },
    { name: 'reads the journal', file: '', error: 'Store is closed.' },
  ]);
});

// Serialized contract from controller-stages' source-changes tests: one change
// task, execution kinds on assignment, candidateReview identity on the attempt,
// and pinned candidate/review references on sourceStage (never flattened fields).
function stagedSourceState() {
  const story = task('S', {
    kind: 'studio-development:change',
    workerId: 'W-02',
    lastAttemptId: 'review-1',
    acceptedAttemptId: 'review-1',
    workflowReference: { ...run, key: 'story' },
    approval: { status: 'approved', decidedAt: at(0) },
  });
  const candidate = {
    taskId: 'S',
    attemptId: 'implementation-1',
    path: 'source-change.json',
    hash: 'manifest-1',
    candidateHash: 'candidate-1',
    workerId: 'W-02',
  };
  const implementation = attempt(candidate.attemptId, 'S', 1, {
    workerId: 'W-02',
    acceptedAt: at(2),
    assignment: { ...story, kind: 'studio-development:change' },
    sourceCandidate: { sourceHash: candidate.candidateHash },
    artifacts: [
      { path: candidate.path, hash: candidate.hash, kind: 'source-change' },
      { path: 'changes/public/runs.js', hash: 'edit-1', kind: 'source-file' },
    ],
  });
  const candidateInput = {
    taskId: 'S',
    attemptId: implementation.id,
    summary: implementation.result.summary,
    artifacts: implementation.artifacts.map(({ path, kind, hash }) => ({ path, kind, hash })),
  };
  const reviewTask = {
    kind: 'studio-development:change-review',
    workerId: 'W-07',
    team: 'Quality',
    title: 'Independent candidate review',
    resources: [],
    maxSeconds: 600,
    maxAttempts: 2,
  };
  story.sourceStage = {
    version: 'source-story-stages-v1',
    phase: 'candidate-review',
    current: 'waiting-for-integration',
    reason: '',
    history: [],
    candidate,
    candidateInput,
    reviewTask,
    attemptId: 'review-1',
    review: {
      taskId: 'S',
      attemptId: 'review-1',
      workerId: 'W-07',
      path: 'source-change-review.json',
      hash: 'review-hash-1',
      verdict: 'pass',
    },
  };
  const review = attempt('review-1', 'S', 3, {
    workerId: 'W-07',
    acceptedAt: at(4),
    assignment: { ...story, ...reviewTask, dependencies: ['S'], acceptedInputs: [candidateInput] },
    // The controller records inputs as job-relative copies (src/core/orchestrator.mjs start()).
    inputReferences: [
      {
        ...candidateInput,
        artifacts: candidateInput.artifacts.map((item, i) => ({
          ...item,
          path: `../inputs/S/${i}-${item.path.split('/').at(-1)}`,
        })),
      },
    ],
    candidateReview: {
      taskId: 'S',
      attemptId: candidate.attemptId,
      path: candidate.path,
      hash: candidate.hash,
      candidateHash: candidate.candidateHash,
      passed: true,
    },
    candidateReviewVerdict: 'pass',
    artifacts: [{ path: 'source-change-review.json', hash: 'review-hash-1', kind: 'source-change-review' }],
    configuration: { provider: 'codex', mode: 'workspace' },
    instructions: { hash: 'independent-instructions' },
  });
  return JSON.parse(JSON.stringify({ ...base, tasks: [story], attempts: [implementation, review] }));
}

// These fixtures use only facts present in compact controller state. The helper
// must not depend on full instructions, artifact contents or a selected history row.
function explanationFixture(fields = {}, attemptFields = null, stateFields = {}) {
  const t = task('E', {
    kind: 'fixture:work',
    status: 'ready',
    workerId: 'W-02',
    resources: [],
    maxAttempts: 3,
    approval: { status: 'approved' },
    ...fields,
  });
  const a =
    attemptFields &&
    attempt('a-E', t.id, 1, {
      status: t.status,
      workerId: t.workerId,
      assignment: { kind: t.kind },
      ...attemptFields,
    });
  if (a) t.lastAttemptId = a.id;
  return { ...base, tasks: [t], attempts: a ? [a] : [], leases: [], pipelineEnabled: true, ...stateFields };
}
const explain = s => {
  // Exercise every explanation fixture as a run consumer as well, after the same
  // allowlisted projection used by polling. Missing historical data stays missing.
  for (const original of [s, { ...s, attempts: s.attempts.map(a => dashboardAttempt(a)) }]) {
    const current = { ...original.tasks[0], workflowReference: { runId: 'explanation-matrix', name: 'Matrix' } },
      state = { ...original, tasks: [current, ...original.tasks.slice(1)] },
      expected = context.StudioRuns.taskExplanation(current, state),
      run = buildRunStories(state).find(run => run.taskIds.includes(current.id)),
      rows = run.needsYou.filter(item => item.taskId === current.id),
      resolved = ['running', 'accepted', 'closed', 'denied', 'integrated'].includes(expected.kind);
    assert.equal(rows.length, resolved ? 0 : 1, expected.kind);
    if (!resolved) {
      for (const key of ['kind', 'reason', 'next', 'action', 'requiresDirector', 'details'])
        assert.deepEqual(rows[0][key], expected[key], `${expected.kind}: ${key}`);
      if (!expected.requiresDirector) assert.notEqual(run.outcome.label, 'Needs you', expected.kind);
    }
  }
  return context.StudioRuns.taskExplanation(s.tasks[0], s);
};
// The controller's stop reasons as recorded: the built-in sandbox's stops for candidate tests and an idea's checks
// before it is set up, and the Codex employee's Windows sandbox mode stop and the orchestrator's check of the
// employee's own workspace isolation.
const candidateSandboxStops = {
  notSetUp:
    "Candidate tests run in the built-in sandbox, and it isn't set up on this computer. Set it up under Settings → Candidate tests, or choose No sandbox there.",
  checksNotSetUp:
    "An idea's checks run in the built-in sandbox, and it isn't set up on this computer. Set it up under Settings → Candidate tests, or choose No sandbox there.",
  windowsMode: 'STUDIO_CODEX_WINDOWS_SANDBOX must be mxc or elevated. No weaker sandbox fallback is allowed.',
  workspace: 'Codex CLI workspace isolation did not pass (mxc): See sandbox diagnostics.',
};

test('task explanations distinguish director decisions from passive stops and waits', async t => {
  const cases = [
    ['unqueued', {}, null, {}, 'ready', 'Start assignment', /ready/i, /Start assignment/],
    ['queued', { queued: true }, null, {}, 'queued', null, /queued/i, /controller starts/i],
    [
      'automatic retry queued',
      { queued: true, autoRetries: 1 },
      {
        status: 'revision_requested',
        result: { outcome: 'completed', checks: [{ name: 'Old tests', status: 'fail' }] },
      },
      {},
      'retry-queued',
      null,
      /another attempt/i,
      /controller starts/i,
    ],
    [
      'automatic retry pending',
      { status: 'failed' },
      { error: 'Invalid JSON' },
      {
        autonomy: { policy: { enabled: true, retries: 1 } },
      },
      'retry-auto',
      null,
      /did not pass/i,
      /bounded retry/i,
    ],
    [
      'automatic retry allowance used',
      { status: 'failed', autoRetries: 1 },
      { error: 'Invalid JSON' },
      {
        autonomy: { policy: { enabled: true, retries: 1 } },
      },
      'retry-limit',
      'Start assignment',
      /retry allowance is used/i,
      /Start assignment/,
    ],
    [
      'resource lease',
      { status: 'blocked', queued: true, controllerWait: true, resources: ['source:repository'] },
      null,
      {
        leases: [{ resource: 'source:repository', attemptId: 'owner' }],
      },
      'resource-wait',
      null,
      /source:repository/,
      /free/i,
    ],
    [
      'employee lease',
      { queued: true },
      null,
      {
        leases: [{ resource: 'employee:W-02', attemptId: 'owner' }],
      },
      'employee-wait',
      null,
      /waits for (Eli|W-02), who is working on other work./,
      /free/i,
    ],
    [
      'unqueued lease',
      { resources: ['source:repository'] },
      null,
      {
        leases: [{ resource: 'source:repository', attemptId: 'owner' }],
      },
      'resource-wait',
      'Start assignment',
      /source:repository/,
      /queue it/i,
    ],
    [
      'studio slot',
      { queued: true, status: 'blocked', controllerWait: true, reason: 'Waiting for a studio execution slot.' },
      null,
      {},
      'slot-wait',
      null,
      /studio execution slot/i,
      /free/i,
    ],
    [
      'dispatch pause',
      { queued: true },
      null,
      { paused: true },
      'dispatch-paused',
      'Resume dispatch',
      /dispatch is paused/i,
      /Resume dispatch/,
    ],
    [
      'employee pause',
      {},
      null,
      { workers: [{ id: 'W-02', paused: true }] },
      'employee-paused',
      'Save future-run settings',
      /employee/i,
      /execution settings/i,
    ],
    ['hold', { hold: true }, null, {}, 'hold', 'Release hold', /on hold/i, /Release the hold/],
    [
      'pipeline pause',
      { queued: true },
      null,
      { pipelineEnabled: false },
      'pipeline-paused',
      'Resume pipeline',
      /pipeline is paused/i,
      /Resume pipeline/,
    ],
    [
      'subscription login',
      { status: 'blocked', reason: 'Codex needs subscription login.' },
      null,
      {},
      'subscription',
      'Check subscription',
      /subscription/i,
      /login/i,
    ],
    [
      'configuration',
      { status: 'blocked', reason: 'Adapter lacks required capability: source-edit.' },
      null,
      {},
      'configuration',
      'Execution settings',
      /configuration/i,
      /settings/i,
    ],
    [
      'candidate tests before the built-in sandbox is set up',
      { status: 'blocked', controllerWait: true, reason: candidateSandboxStops.notSetUp },
      null,
      {},
      'test-sandbox',
      'Candidate tests',
      /^This can’t start because its tests run in the built-in sandbox, which isn’t set up on this computer\. The employee and its execution settings are fine\.$/,
      /^Set up the sandbox under Settings → Candidate tests, or choose No sandbox there\.$/,
    ],
    [
      'employee workspace isolation',
      { status: 'blocked', controllerWait: true, reason: candidateSandboxStops.workspace },
      null,
      {},
      'configuration',
      'Execution settings',
      /^The current employee or execution configuration cannot run this assignment\.$/,
      /^Inspect the recorded blocker and correct the employee or task execution settings before starting it\.$/,
    ],
    [
      'Windows sandbox mode',
      { status: 'blocked', controllerWait: true, reason: candidateSandboxStops.windowsMode },
      null,
      {},
      'configuration',
      'Execution settings',
      /^The current employee or execution configuration cannot run this assignment\.$/,
      /^Inspect the recorded blocker and correct the employee or task execution settings before starting it\.$/,
    ],
    [
      'work approval',
      { status: 'backlog', approval: { status: 'pending' } },
      null,
      {},
      'work-approval',
      'Approve work',
      /approval/i,
      /Approve work/,
    ],
    [
      'automatic work approval',
      { status: 'backlog', approval: { status: 'pending' } },
      null,
      {
        autonomy: { policy: { enabled: true, kinds: { 'fixture:work': { approve: 'auto' } } } },
      },
      'work-auto',
      null,
      /automatic approval/i,
      /controller approves/i,
    ],
    [
      'director gate despite automatic policy',
      { status: 'backlog', approval: { status: 'pending', gate: true, reason: 'Choose a direction.' } },
      null,
      {
        autonomy: { policy: { enabled: true, kinds: { 'fixture:work': { approve: 'auto' } } } },
      },
      'gate-approval',
      'Approve work',
      /decision gate/i,
      /Approve work/,
    ],
    [
      'completed result',
      { status: 'review' },
      {},
      {},
      'result-approval',
      'Accept result',
      /ready for acceptance/i,
      /Accept result/,
    ],
    [
      'automatic result',
      { status: 'review' },
      {},
      {
        autonomy: { policy: { enabled: true, kinds: { 'fixture:work': { accept: 'auto' } } } },
      },
      'result-auto',
      null,
      /automatic acceptance/i,
      /controller accepts/i,
    ],
    [
      'invalid output',
      { status: 'failed' },
      { result: null, error: 'Result JSON has no taskId.' },
      {},
      'invalid-output',
      'Start assignment',
      /validated completed result/i,
      /validation detail/i,
    ],
    [
      'blocked result',
      { status: 'blocked' },
      { result: { outcome: 'blocked', summary: 'Need the approved input.', issues: ['Missing decision.'] } },
      {},
      'blocked-result',
      'Start assignment',
      /inputs or access/i,
      /missing input/i,
    ],
    ['cancelled', { status: 'cancelled' }, {}, {}, 'cancelled', 'Start assignment', /cancelled and stopped/i, /Close/],
    ['stopping', { status: 'stopping' }, {}, {}, 'stopping', null, /not yet confirmed/i, /termination/i],
    [
      'timeout stopping',
      { status: 'stopping' },
      { stopContext: { timedOut: true, activity: 'test' } },
      {},
      'stopping',
      null,
      /time limit.*running tests/i,
      /termination/i,
    ],
    ['running', { status: 'running' }, {}, {}, 'running', null, /running/i, /current attempt stops/i],
    [
      'restart interruption',
      { status: 'blocked', autonomyNote: 'Approve or deny proposed work E.' },
      { status: 'interrupted', error: 'Controller restarted.' },
      {},
      'interrupted',
      'Reconcile interrupted attempt',
      /controller stopped while this attempt was running/i,
      /checks that nothing of the attempt is still running.*does not use up one of the attempts allowed.$/,
    ],
    [
      'quarantine',
      { status: 'failed' },
      { status: 'quarantined' },
      {},
      'interrupted',
      'Reconcile interrupted attempt',
      /stop could not be confirmed/i,
      /checks that nothing of the attempt is still running/i,
    ],
    [
      // The recovery drill (v1.0 criterion 3): a reconciled interruption leaves the attempts it had.
      'a reconciled interruption does not use the attempt limit',
      { maxAttempts: 1, status: 'ready' },
      { status: 'interrupted', reconciledAt: at(1) },
      {},
      'ready',
      'Start assignment',
      /ready/i,
      /Start assignment/,
    ],
    [
      'automatic limit',
      { maxAttempts: 1, status: 'failed' },
      {},
      {},
      'attempt-limit',
      'Start assignment',
      /attempt limit/i,
      /explicit director.*override/i,
    ],
    [
      'usage limit with its hold cleared does not use the attempt limit',
      { maxAttempts: 1, status: 'blocked', reason: 'You have hit your usage limit.' },
      { subscriptionHold: 'codex', error: 'You have hit your usage limit.' },
      {},
      'subscription-cleared',
      'Start assignment',
      /usage limit stopped the last attempt/i,
      /doesn’t count toward the attempt limit/,
    ],
    [
      'usage limit under a fixed limit still counts',
      { maxAttempts: 1, status: 'blocked', reason: 'You have hit your usage limit.' },
      { subscriptionHold: 'codex', error: 'You have hit your usage limit.' },
      { taskKinds: { 'fixture:work': { fixedAttemptLimit: true } } },
      'fixed-limit',
      'Create assignment',
      /fixed attempt limit/i,
      /newly scoped/i,
    ],
    [
      // An accepted review from before stories had stages: nothing waits on the director (item 17).
      'accepted legacy review that asked for changes',
      { kind: 'studio-development:change-review', status: 'done' },
      { status: 'accepted', candidateReviewVerdict: 'needs-work' },
      {},
      'review-findings',
      null,
      /review requested changes/i,
      /create newly scoped work from its findings/,
    ],
    [
      // Other work whose independent review asked for changes waits for Start: it did not stop on a blocker.
      'other work sent back by its review',
      {
        status: 'blocked',
        reason: 'Independent review sent this back: The guide leaves out the map. Start it to run Work again.',
        stageState: {
          current: 'work',
          history: [
            { key: 'work', outcome: 'accepted' },
            { key: 'review', outcome: 'sent-back' },
          ],
        },
      },
      {
        status: 'accepted',
        assignment: { kind: 'fixture:review' },
        workReviewVerdict: 'needs-work',
        workReviewFindings: ['The guide leaves out the map.'],
      },
      {
        taskKinds: {
          'fixture:work': { stageTemplate: [{ key: 'work' }, { key: 'review', kind: 'fixture:review' }] },
        },
      },
      'sent-back',
      'Start assignment',
      /review asked for changes/i,
      /run the work again with the review's findings/,
    ],
    [
      'closed legacy attention',
      { status: 'denied', closed: { at: at(4) }, autonomyNote: 'Approve or deny proposed work E.' },
      {},
      {},
      'closed',
      null,
      /closed/i,
      /No further work/i,
    ],
    [
      'accepted legacy attention',
      { status: 'done', autonomyNote: 'Accept result or send back.' },
      { status: 'accepted' },
      {},
      'accepted',
      null,
      /accepted/i,
      /Dependent work/i,
    ],
  ];
  for (const [name, fields, attemptFields, stateFields, kind, action, reason, next] of cases)
    await t.test(name, () => {
      const s = explanationFixture(fields, attemptFields, stateFields),
        before = JSON.stringify(s),
        e = explain(s);
      assert.equal(e.kind, kind);
      assert.equal(e.action, action);
      assert.equal(e.requiresDirector, !!action);
      assert.match(e.reason, reason);
      assert.match(e.next, next);
      if (!action) assert.match(e.next, /Nothing is needed from you/);
      assert.equal(JSON.stringify(s), before, 'Presentation does not mutate controller records.');
    });
});

test('a story stopped because its candidate tests have no sandbox needs the director at Candidate tests, not the employee settings', () => {
  const stopped = (reason, stateFields) =>
      explanationFixture({ status: 'blocked', controllerWait: true, reason }, null, stateFields),
    plain = value => JSON.parse(JSON.stringify(value));
  for (const reason of [candidateSandboxStops.notSetUp, candidateSandboxStops.checksNotSetUp]) {
    const s = stopped(reason),
      e = explain(s);
    assert.equal(e.kind, 'test-sandbox', reason);
    assert.equal(e.action, 'Candidate tests', reason);
    assert.doesNotMatch(e.reason, /configuration cannot run/, reason);
    assert.match(e.next, /^Set up the sandbox under Settings → Candidate tests, or choose No sandbox there\.$/, reason);
    assert.deepEqual(plain(e.details), [], 'The controller’s reason is not repeated under the explanation.');
    assert.deepEqual(
      plain(context.StudioRuns.needsYou(s).map(item => [item.taskId, item.kind, item.action, item.requiresDirector])),
      [['E', 'test-sandbox', 'Candidate tests', true]],
      reason,
    );
    const run = buildRunStories({
      ...s,
      tasks: [{ ...s.tasks[0], workflowReference: { runId: 'sandbox-stop', name: 'Sandbox stop' } }],
    }).find(story => story.taskIds.includes('E'));
    assert.equal(run.outcome.label, 'Needs you', reason);
    assert.deepEqual(plain(run.needsYou.map(item => [item.taskId, item.action])), [['E', 'Candidate tests']], reason);
    // A paused employee still comes first, with its own settings.
    const paused = explain(stopped(reason, { workers: [{ id: 'W-02', paused: true }] }));
    assert.equal(paused.kind, 'employee-paused', reason);
    assert.equal(paused.action, 'Save future-run settings', reason);
  }
  // The employee's own stops keep the configuration explanation and list the controller's reason.
  for (const reason of [
    'Adapter lacks required capability: source-edit.',
    candidateSandboxStops.workspace,
    candidateSandboxStops.windowsMode,
  ]) {
    const e = explain(stopped(reason));
    assert.equal(e.kind, 'configuration', reason);
    assert.equal(e.reason, 'The current employee or execution configuration cannot run this assignment.', reason);
    assert.equal(
      e.next,
      'Inspect the recorded blocker and correct the employee or task execution settings before starting it.',
      reason,
    );
    assert.equal(e.action, 'Execution settings', reason);
    assert.deepEqual(plain(e.details), [reason], reason);
  }
});

// A reset time later today reads as the local clock time alone.
const tonight = () => {
  const at = new Date();
  at.setHours(22, 25, 0, 0);
  return at.toISOString();
};
const heldClis = {
  adapters: {
    codex: { id: 'codex', name: 'Codex CLI', quotaLabel: 'Codex' },
    claude: { id: 'claude', name: 'Claude Code CLI', quotaLabel: 'Claude' },
  },
};

test('work on a held CLI only waits, and names the reset time when its CLI recorded one', () => {
  const cli = { ...heldClis, workers: [{ id: 'W-02', displayName: 'Eli', provider: 'codex' }] },
    reset = tonight(),
    limit = 'You have hit your usage limit. Try again at 10:25 PM.',
    // As the controller records it: queued work the limit stopped stays queued while its hold has a reset time.
    known = explanationFixture(
      {
        status: 'blocked',
        queued: true,
        controllerWait: true,
        reason: 'Waiting for the Codex usage limit to reset at 10:25 PM.',
      },
      { status: 'blocked', result: null, error: limit, subscriptionHold: 'codex', subscriptionReset: reset },
      { ...cli, quota: { codex: true }, quotaResets: { codex: reset } },
    );
  let e = explain(known);
  assert.equal(e.kind, 'subscription-wait');
  assert.equal(e.action, null);
  assert.equal(e.requiresDirector, false);
  assert.equal(e.reason, 'Waiting for the Codex usage limit to reset at 10:25 PM. It clears itself.');
  assert.equal(e.next, 'Nothing is needed from you. The controller starts it once the hold clears.');
  assert.ok(e.details.includes(limit), 'The CLI’s own message stays as evidence.');
  assert.ok(!e.details.includes(known.tasks[0].reason), 'The controller’s reason is not repeated.');
  known.quotaResets.codex = new Date(2030, 0, 5, 9, 5).toISOString();
  assert.equal(
    explain(known).reason,
    'Waiting for the Codex usage limit to reset at 9:05 AM on Jan 5. It clears itself.',
    'A reset on another day names its date.',
  );

  const ready = explanationFixture({}, null, { ...cli, quota: { codex: true }, quotaResets: { codex: reset } });
  e = explain(ready);
  assert.equal(e.kind, 'subscription-wait');
  assert.equal(e.requiresDirector, false);
  assert.equal(e.next, 'Nothing is needed from you. Start assignment queues it to start once the hold clears.');

  // With no known reset, the hold is the director's once for its CLI (holdItems), not once for each task.
  const unknown = explanationFixture(
    { status: 'blocked', reason: 'You have hit your usage limit.' },
    { status: 'blocked', result: null, error: 'You have hit your usage limit.', subscriptionHold: 'codex' },
    { ...cli, quota: { codex: true } },
  );
  e = explain(unknown);
  assert.equal(e.kind, 'subscription-wait');
  assert.equal(e.action, null);
  assert.equal(e.requiresDirector, false);
  assert.equal(
    e.reason,
    'Waiting for the Codex usage limit, which has no known reset time. Its hold is listed once in Needs you.',
  );
  assert.equal(e.next, 'Nothing is needed from you. Once the hold is cleared, use Start assignment to run it.');
  assert.deepEqual([...e.details], ['You have hit your usage limit.']);
  unknown.quotaResets = { codex: 'after lunch' };
  assert.match(explain(unknown).reason, /no known reset time/, 'An unreadable recorded time is unknown.');

  // The controller's reason names a hold that is not recorded under this CLI's name here.
  const named = explanationFixture(
    {
      status: 'blocked',
      queued: true,
      controllerWait: true,
      reason: 'This CLI has a subscription hold. Clear it when usable again.',
    },
    null,
    { ...cli, quota: {} },
  );
  e = explain(named);
  assert.equal(e.kind, 'subscription-wait');
  assert.equal(e.requiresDirector, false);
  assert.match(e.reason, /Codex usage limit, which has no known reset time/);
  assert.equal(e.next, 'Nothing is needed from you. The controller starts it once the hold is cleared.');
  // A recorded hold cleared since then wins over the reason it left behind, as before this change.
  named.quota = { codex: false };
  assert.equal(explain(named).kind, 'subscription');
  assert.equal(explain(named).action, 'Check subscription');

  // As in the controller, a deliberate hold on the assignment comes first.
  const deliberate = explanationFixture({ hold: true }, null, { ...cli, quota: { codex: true } });
  assert.equal(explain(deliberate).kind, 'hold');
  assert.equal(explain(deliberate).action, 'Release hold');

  // A missing login stays the director's, and so does starting work again after its hold was cleared by hand.
  const login = explanationFixture({ status: 'blocked', reason: 'Codex needs subscription login.' }, null, {
    ...cli,
    quota: { codex: false },
  });
  e = explain(login);
  assert.equal(e.kind, 'subscription');
  assert.equal(e.action, 'Check subscription');
  assert.equal(e.requiresDirector, true);
  const cleared = explanationFixture(
    { maxAttempts: 1, status: 'blocked', reason: 'You have hit your usage limit.' },
    { status: 'blocked', result: null, error: 'You have hit your usage limit.', subscriptionHold: 'codex' },
    { ...cli, quota: { codex: false } },
  );
  e = explain(cleared);
  assert.equal(e.kind, 'subscription-cleared');
  assert.equal(e.action, 'Start assignment');
  assert.equal(e.requiresDirector, true);
});

test('holdItems gives one item for each held CLI with the work waiting on it, for the director only without a known reset', () => {
  const { holdItems, needsYou } = context.StudioRuns,
    reset = tonight(),
    work = (id, workerId, fields = {}) =>
      task(id, {
        kind: 'fixture:work',
        status: 'ready',
        workerId,
        resources: [],
        maxAttempts: 3,
        approval: { status: 'approved' },
        ...fields,
      }),
    tried = (id, taskId, minute, fields) =>
      attempt(id, taskId, minute, { workerId: 'W-02', assignment: { kind: 'fixture:work' }, ...fields }),
    s = {
      ...base,
      ...heldClis,
      workers: [
        { id: 'W-02', displayName: 'Eli', provider: 'codex' },
        { id: 'W-06', displayName: 'Avery', provider: 'claude' },
        { id: 'W-07', displayName: 'Morgan', provider: 'mock' },
      ],
      quota: { codex: true, claude: true, mock: false },
      quotaResets: { claude: reset },
      tasks: [
        work('codex-ready', 'W-02'),
        work('codex-waiting', 'W-02', {
          status: 'blocked',
          queued: true,
          controllerWait: true,
          reason: 'This CLI has a subscription hold. Clear it when usable again.',
        }),
        work('codex-stopped', 'W-02', {
          status: 'blocked',
          reason: 'You have hit your usage limit.',
          lastAttemptId: 'stopped-1',
        }),
        // Work on a held CLI that is not waiting on it: a result to accept, accepted work and running work.
        work('codex-review', 'W-02', { status: 'review', lastAttemptId: 'review-1' }),
        work('codex-done', 'W-02', { status: 'done' }),
        work('codex-running', 'W-02', { status: 'running', lastAttemptId: 'running-1' }),
        work('claude-ready', 'W-06'),
        work('claude-waiting', 'W-06', {
          status: 'blocked',
          queued: true,
          controllerWait: true,
          reason: 'Waiting for the Claude usage limit to reset at 10:25 PM.',
        }),
        work('mock-ready', 'W-07'),
      ],
      attempts: [
        tried('stopped-1', 'codex-stopped', 1, {
          status: 'blocked',
          result: null,
          error: 'You have hit your usage limit.',
          subscriptionHold: 'codex',
        }),
        tried('review-1', 'codex-review', 2, { status: 'review' }),
        tried('running-1', 'codex-running', 3, { status: 'running', finishedAt: null }),
      ],
      leases: [],
      pipelineEnabled: true,
    },
    before = JSON.stringify(s),
    items = JSON.parse(JSON.stringify(holdItems(s)));
  assert.deepEqual(
    items.map(({ reason, next, ...item }) => item),
    [
      {
        kind: 'subscription-hold',
        provider: 'codex',
        label: 'Codex',
        resetAt: null,
        resetTime: null,
        taskIds: ['codex-ready', 'codex-waiting', 'codex-stopped'],
        action: 'Clear hold',
        requiresDirector: true,
      },
      {
        kind: 'subscription-hold',
        provider: 'claude',
        label: 'Claude',
        resetAt: reset,
        resetTime: '10:25 PM',
        taskIds: ['claude-ready', 'claude-waiting'],
        action: null,
        requiresDirector: false,
      },
    ],
    'One item for each held CLI however many tasks wait on it; a hold on mock is not set.',
  );
  assert.equal(items[0].reason, 'The Codex usage limit has no known reset time, so its hold stays until you clear it.');
  assert.match(items[0].next, /^Clear the hold once the Codex CLI is usable again\./);
  assert.equal(items[1].reason, 'The Claude usage limit resets at 10:25 PM, and its hold clears itself then.');
  assert.match(items[1].next, /^Nothing is needed from you\./);
  // Each task keeps its own explanation: waiting on a hold is no decision for the director.
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        needsYou(s)
          .filter(item => item.requiresDirector)
          .map(item => [item.taskId, item.action]),
      ),
    ),
    [
      ['codex-review', 'Accept result'],
      ['mock-ready', 'Start assignment'],
    ],
  );
  assert.equal(JSON.stringify(s), before, 'Presentation does not mutate controller records.');
  assert.equal(holdItems({ ...s, quota: { codex: false } }).length, 0);
  assert.equal(holdItems({ tasks: [] }).length, 0, 'Older records have no holds.');
});

test('fixed attempt limits prohibit another attempt but preserve successful result acceptance', () => {
  for (const kind of ['unreal-integration', 'fixture:fixed'])
    for (const accept of ['director', 'auto'])
      for (const status of ['ready', 'blocked', 'failed', 'cancelled', 'review']) {
        const s = explanationFixture(
          { kind, status, maxAttempts: 1 },
          {
            result: { outcome: 'completed', checks: [{ name: 'Validation', status: 'fail' }] },
          },
          {
            taskKinds: { [kind]: { fixedAttemptLimit: true } },
            autonomy: { policy: { enabled: true, retries: 1, kinds: { [kind]: { accept } } } },
          },
        );
        const e = explain(s);
        assert.equal(e.kind, 'fixed-limit', `${kind}, ${accept}, ${status}`);
        assert.equal(e.action, 'Create assignment');
        assert.match(e.next, /newly scoped assignment/);
        assert.doesNotMatch(e.next, /Start assignment/);
      }
  for (const kind of ['unreal-integration', 'fixture:fixed'])
    for (const enabled of [false, true])
      for (const accept of ['director', 'auto']) {
        const s = explanationFixture(
            { kind, status: 'review', maxAttempts: 1 },
            {},
            {
              taskKinds: { [kind]: { fixedAttemptLimit: true } },
              autonomy: { policy: { enabled, retries: 1, kinds: { [kind]: { accept } } } },
            },
          ),
          e = explain(s),
          automatic = enabled && accept === 'auto';
        assert.equal(e.kind, automatic ? 'result-auto' : 'result-approval', `${kind}, ${enabled}, ${accept}`);
        assert.equal(e.action, automatic ? null : 'Accept result');
        assert.equal(e.requiresDirector, !automatic);
        assert.match(e.next, automatic ? /controller accepts/i : /Accept result/);
        assert.doesNotMatch(e.reason + e.next, /exhaust|newly scoped|another attempt/i);
      }
});

test('failure explanations retain named checks, tests, paths, findings and timeout evidence as raw text', () => {
  const hostile = '<img src=x onerror=alert(1)>',
    checks = explanationFixture(
      { status: 'review' },
      {
        result: { outcome: 'completed', checks: [{ name: 'Candidate suite', status: 'fail', evidence: '2/3 passed' }] },
        controllerChecks: [{ name: 'Controller validation', status: 'fail', evidence: 'Wrong artifact kind' }],
        failedTests: [{ file: 'test/ownership.test.mjs', name: hostile }],
      },
    ),
    e = explain(checks);
  assert.equal(e.kind, 'failed-checks');
  assert.match(e.reason, /Candidate suite.*Controller validation/);
  assert.ok(e.details.includes('test/ownership.test.mjs: ' + hostile));
  assert.ok(e.details.includes('Controller validation: Wrong artifact kind'));
  assert.equal(e.action, 'Request revision');
  assert.doesNotMatch(JSON.stringify(e), /&lt;|&gt;/, 'Escaping belongs to the renderer.');

  const outside = explanationFixture(
    {
      kind: 'studio-development:change',
      status: 'failed',
      reason: 'Returned changes/src/private.mjs outside approved scope.',
    },
    { result: null },
  );
  assert.equal(explain(outside).kind, 'outside-scope');
  assert.equal(explain(outside).action, "Edit this story's files");
  assert.match(explain(outside).details.join('\n'), /changes\/src\/private.mjs/);
  const scope = explanationFixture(
    { kind: 'studio-development:change', status: 'blocked' },
    {
      scopeRequest: {
        files: ['test/new.test.mjs'],
        newFiles: ['src/new.mjs'],
        deleteFiles: ['src/old.mjs'],
        reason: 'The caller needs updating.',
      },
      result: { outcome: 'blocked', summary: 'Need file scope.' },
    },
  );
  assert.equal(explain(scope).kind, 'scope-request');
  for (const text of ['test/new.test.mjs', 'src/new.mjs', 'src/old.mjs', 'The caller needs updating.'])
    assert.ok(explain(scope).details.includes(text));
  scope.tasks[0].scopeEdits = [{ at: at(3) }];
  assert.notEqual(explain(scope).kind, 'scope-request', 'Answered file requests are historical.');

  const review = stagedSourceState();
  review.tasks[0].sourceStage.current = 'failed';
  review.tasks[0].sourceStage.review.verdict = 'needs-work';
  review.attempts[1].candidateReviewVerdict = 'needs-work';
  review.attempts[1].candidateReviewFindings = [
    'Blocking: Keep employee ownership.',
    {
      severity: 'major',
      summary: hostile,
      path: 'src/ownership.mjs',
    },
  ];
  assert.equal(explain(review).action, 'Send back to implementation');
  assert.match(explain(review).details.join('\n'), /Blocking: Keep employee ownership/);
  assert.match(explain(review).details.join('\n'), /major: <img.*src\/ownership.mjs/);
  for (const activity of ['source.edit', 'candidate.commit', 'test', 'unknown', undefined]) {
    const s = explanationFixture(
        { status: 'failed' },
        {
          error: 'Assignment time limit reached.',
          ...(activity
            ? {
                stopContext: {
                  timedOut: true,
                  activity,
                  testEvidence: {
                    failedTests: [{ name: 'preserves state', file: 'test/state.test.mjs' }],
                  },
                },
              }
            : {}),
        },
      ),
      value = explain(s);
    assert.equal(value.kind, 'timeout');
    assert.match(
      value.reason,
      activity === 'source.edit'
        ? /editing/
        : activity === 'candidate.commit'
          ? /commit/
          : activity === 'test'
            ? /running tests/
            : /not recorded/,
    );
    if (activity) assert.match(value.details.join('\n'), /test\/state.test.mjs: preserves state/);
  }
});

test('dependency milestones distinguish acceptance from integration and do not require action for queued work', () => {
  for (const queued of [false, true])
    for (const milestone of ['accepted', 'integrated']) {
      const s = explanationFixture({
        status: 'blocked',
        controllerWait: true,
        queued,
        dependencies: ['D'],
        waitsFor: { D: milestone },
      });
      s.tasks.push(
        task('D', {
          status: milestone === 'accepted' ? 'cancelled' : 'done',
          sourceStage: { current: 'waiting-for-integration' },
        }),
      );
      const e = explain(s);
      assert.equal(e.kind, 'prerequisite-wait');
      assert.match(e.reason, new RegExp('D to be ' + milestone));
      assert.equal(e.requiresDirector, !queued);
      assert.equal(e.action, queued ? null : 'Start assignment');
      assert.doesNotMatch(e.reason + e.next, /permanently|impossible/i);
      if (milestone === 'integrated') s.tasks[1].sourceStage.current = 'integrated';
      else s.tasks[1].status = 'done';
      assert.notEqual(explain(s).kind, 'prerequisite-wait');
    }
  const s = explanationFixture({
    status: 'backlog',
    approval: { status: 'pending' },
    proposalReference: { taskId: 'D' },
  });
  s.tasks.push(task('D', { status: 'review' }));
  assert.equal(explain(s).kind, 'prerequisite-acceptance');
  s.tasks[1].status = 'done';
  assert.equal(explain(s).action, 'Approve work');
});

test('current-stage evidence takes precedence over history, obsolete notes and selected attempt data', () => {
  const s = stagedSourceState(),
    story = s.tasks[0];
  story.autonomyNote = 'Approve or deny proposed work S.';
  Object.assign(story, {
    status: 'ready',
    queued: true,
    lastAttemptId: 'implementation-1',
    acceptedAttemptId: 'implementation-1',
  });
  story.sourceStage.current = 'candidate-review';
  delete story.sourceStage.review;
  s.attempts.pop();
  s.attempts[0].failedTests = [{ name: 'Historical failure' }];
  s.attempts[0].result.checks = [{ name: 'Historical checks', status: 'fail' }];
  let e = explain(s);
  assert.equal(e.attemptId, null);
  assert.equal(e.requiresDirector, false);
  assert.doesNotMatch(JSON.stringify(e), /Historical|Approve or deny/);
  const current = attempt('review-new', 'S', 8, {
    status: 'running',
    workerId: 'W-07',
    assignment: { kind: 'studio-development:change-review' },
    candidateReview: { attemptId: 'implementation-1' },
  });
  s.attempts.push(current);
  Object.assign(story, { status: 'running', lastAttemptId: current.id });
  assert.equal(explain(s).attemptId, current.id);
  assert.equal(explain(s).kind, 'running');
  const before = JSON.stringify(s);
  explain(s);
  assert.equal(JSON.stringify(s), before);

  Object.assign(story, {
    status: 'ready',
    queued: true,
    dependencies: ['historical-input'],
    resources: ['source:implementation-only'],
    execution: { provider: 'implementation-cli' },
  });
  story.sourceStage.current = 'candidate-review';
  story.autoRetries = 1;
  story.lastAttemptId = 'implementation-1';
  s.leases = [{ resource: 'source:implementation-only', attemptId: 'other' }];
  s.quota = { 'implementation-cli': true };
  s.tasks.push(task('historical-input', { status: 'denied' }));
  e = explain(s);
  assert.equal(e.kind, 'queued', 'Review uses its own dependencies, resources, execution and retry allowance.');
  assert.equal(e.requiresDirector, false);

  const generic = explanationFixture(
    {
      kind: 'fixture:staged',
      queued: true,
      stageState: { current: 'verify', enteredAt: at(5), staffed: { verify: { workerId: 'W-07' } } },
    },
    { status: 'failed', error: 'Old draft error', assignment: { kind: 'fixture:staged' } },
    {
      taskKinds: {
        'fixture:staged': {
          stageTemplate: [
            { key: 'draft', kind: 'fixture:staged' },
            { key: 'verify', kind: 'fixture:verify' },
          ],
        },
      },
    },
  );
  assert.equal(explain(generic).attemptId, null);
  assert.doesNotMatch(JSON.stringify(explain(generic)), /Old draft/);
  generic.attempts.push(
    attempt('old-verify', 'E', 2, {
      status: 'failed',
      error: 'Earlier stage visit',
      assignment: { kind: 'fixture:verify' },
    }),
  );
  assert.equal(explain(generic).attemptId, null);
  generic.attempts.push(
    attempt('current-verify', 'E', 6, { status: 'review', assignment: { kind: 'fixture:verify' } }),
  );
  Object.assign(generic.tasks[0], { status: 'review', lastAttemptId: 'current-verify' });
  generic.autonomy = {
    policy: {
      enabled: true,
      kinds: { 'fixture:staged': { accept: 'director' }, 'fixture:verify': { accept: 'auto' } },
    },
  };
  assert.equal(explain(generic).kind, 'result-auto', 'Use the current execution kind policy.');
});

test('integration explanations retain exact eligibility and distinguish automatic progress and recovery', () => {
  const policy = { enabled: true, kinds: { 'studio-development:change': { integrate: 'auto' } } };
  for (const [mutate, kind, action, next] of [
    [() => {}, 'integration-auto', null, /controller requests integration automatically/i],
    [
      s => {
        s.autonomy.policy.enabled = false;
      },
      'integration-approval',
      'Approve integration',
      /Approve integration/,
    ],
    [
      s => {
        s.autonomy.pendingIntegration = { taskId: 'S', attemptId: 'review-1', paused: true };
      },
      'integration-pending',
      null,
      /active work.*restarts/,
    ],
    [
      s => {
        s.tasks[0].reason = s.tasks[0].sourceStage.reason =
          'The policy could not request integration; approve it yourself.';
        Object.assign(s.tasks[0].sourceStage, { phase: 'integration', current: 'failed' });
      },
      'integration-stopped',
      'Approve integration again',
      /recorded failure/,
    ],
    [
      s => {
        s.attempts[1].sourceIntegration = { state: 'rejected', error: 'The candidate conflicts in src/a.mjs.' };
      },
      'integration-conflict',
      'Approve integration again',
      /fresh candidate.*new independent review/,
    ],
    [
      s => {
        s.attempts[1].sourceIntegration = {
          state: 'rejected',
          error: 'Formatter failed.',
          verification: { phaseId: 'integration.format' },
        };
      },
      'integration-formatter',
      'Approve integration again',
      /formatter failure/,
    ],
    [
      s => {
        s.attempts[1].sourceIntegration = {
          state: 'abandoned',
          verification: {
            passed: false,
            phaseId: 'integration.verification',
            failedTests: [{ file: 'test/source.test.mjs', name: 'keeps local work' }],
          },
        };
      },
      'integration-tests',
      'Approve integration again',
      /failing tests/,
    ],
    [
      s => {
        s.attempts[1].sourceIntegration = {
          state: 'rejected',
          error: 'Source branch moved; local edits remain.',
          verification: { passed: true, phaseId: 'integration.verification' },
        };
      },
      'integration-source-moved',
      'Approve integration again',
      /preserve local edits/,
    ],
    [
      s => {
        s.attempts[1].sourceIntegration = { state: 'needs-reconciliation', error: 'Uncertain write.' };
      },
      'integration-uncertain',
      'Reconcile source integration',
      /Reconcile source integration before another write. It checks the repository/,
    ],
    [
      s => {
        s.attempts[1].sourceIntegration = { state: 'verifying' };
      },
      'integration-running',
      null,
      /finish verification/,
    ],
    [
      s => {
        s.attempts[1].sourceIntegration = { state: 'integrated' };
        s.tasks[0].sourceStage.current = 'integrated';
      },
      'integrated',
      null,
      /complete/,
    ],
  ]) {
    const s = stagedSourceState();
    s.autonomy = { policy: structuredClone(policy) };
    s.tasks[0].autonomyNote = 'Approve or deny proposed work S.';
    mutate(s);
    const before = JSON.stringify(s),
      e = explain(s);
    assert.equal(e.kind, kind);
    assert.equal(e.action, action);
    assert.equal(e.requiresDirector, !!action);
    assert.match(e.next, next);
    assert.doesNotMatch(e.reason + e.next, /Approve or deny proposed work/);
    if (kind === 'integration-tests') assert.ok(e.details.includes('test/source.test.mjs: keeps local work'));
    assert.equal(JSON.stringify(s), before);
  }
  for (const mutate of [
    s => {
      s.attempts[1].candidateReview.candidateHash = 'stale';
    },
    s => {
      s.attempts[0].result.checks = [{ name: 'Candidate tests', status: 'fail' }];
    },
    s => {
      s.attempts[1].inputReferences = [];
    },
    s => {
      s.tasks[0].lastAttemptId = 'different';
    },
  ]) {
    const s = stagedSourceState();
    s.autonomy = { policy };
    mutate(s);
    assert.equal(context.StudioRuns.integrationReview(s.tasks[0], s.attempts), null);
    assert.equal(explain(s).kind, 'integration-ineligible');
    assert.doesNotMatch(explain(s).action, /Approve integration/);
  }
});

test('legacy separate reviews require the same current candidate checks before offering integration', () => {
  const legacy = () => {
    const s = stagedSourceState(),
      original = s.tasks[0],
      candidate = s.attempts[0],
      review = s.attempts[1];
    const source = { ...original, lastAttemptId: candidate.id, acceptedAttemptId: candidate.id };
    delete source.sourceStage;
    const t = task('V', {
      kind: 'studio-development:change-review',
      workerId: review.workerId,
      dependencies: ['S'],
      status: 'done',
      acceptedAttemptId: review.id,
      lastAttemptId: review.id,
    });
    review.taskId = 'V';
    review.assignment = { kind: t.kind };
    s.tasks = [t, source];
    return s;
  };
  const { integrationReview } = context.StudioRuns;
  const s = legacy();
  assert.equal(integrationReview(s.tasks[0], s.attempts, null, s.tasks)?.id, 'review-1');
  assert.equal(explain(s).action, 'Integrate reviewed source');
  s.autonomy = { policy: { enabled: true, kinds: {} } };
  assert.equal(explain(s).action, 'Approve integration');
  s.attempts[1].sourceIntegration = { state: 'rejected', error: 'Verification stopped.' };
  assert.equal(explain(s).action, 'Approve integration again');
  s.autonomy.policy.enabled = false;
  assert.equal(explain(s).action, 'Integrate again');
  for (const mutate of [
    s => {
      s.tasks[1].acceptedAttemptId = 'superseded';
    },
    s => {
      s.tasks[1].lastAttemptId = 'superseded';
    },
    s => {
      s.tasks[0].lastAttemptId = 'superseded';
    },
    s => {
      s.tasks[0].dependencies = [];
    },
    s => {
      s.attempts[1].workerId = s.attempts[0].workerId;
    },
    s => {
      s.tasks[0].workerId = 'different-reviewer';
    },
    s => {
      s.tasks[1].workerId = 'different-producer';
    },
    s => {
      s.attempts[1].candidateReview.candidateHash = 'stale';
    },
    s => {
      s.attempts[1].inputReferences = [];
    },
    s => {
      s.attempts[0].status = 'review';
    },
    s => {
      s.attempts[0].result.checks = [{ name: 'Candidate tests', status: 'fail' }];
    },
    s => {
      s.attempts[1].controllerChecks = [{ name: 'Review validation', status: 'fail' }];
    },
  ]) {
    const s = legacy(),
      before = JSON.stringify(s);
    mutate(s);
    const changed = JSON.stringify(s);
    assert.notEqual(changed, before);
    assert.equal(integrationReview(s.tasks[0], s.attempts, null, s.tasks), null, mutate.toString());
    assert.doesNotMatch(explain(s).action || '', /Approve integration|Integrate reviewed source/);
    assert.equal(JSON.stringify(s), changed);
  }
});

test('resolved transitions remove earlier requests without rewriting their historical evidence', () => {
  const s = explanationFixture(
    { status: 'blocked', autonomyNote: 'Approve or deny proposed work E.' },
    {
      status: 'interrupted',
      error: 'Controller restarted before the process settled.',
    },
  );
  assert.equal(explain(s).action, 'Reconcile interrupted attempt');
  s.attempts[0].reconciledAt = at(4);
  Object.assign(s.tasks[0], { status: 'ready', queued: true });
  assert.equal(explain(s).action, null);
  assert.equal(explain(s).kind, 'queued');
  const history = JSON.stringify(s.attempts);
  Object.assign(s.tasks[0], { status: 'denied', closed: { at: at(5) } });
  const closed = explain(s);
  assert.equal(closed.action, null);
  assert.equal(closed.details.length, 0, 'Historical failure is not a current request after closure.');
  assert.equal(JSON.stringify(s.attempts), history);

  const source = stagedSourceState(),
    story = source.tasks[0],
    review = source.attempts[1];
  story.autonomyNote = 'Approve integration again. A previous integration failed.';
  review.sourceIntegration = { state: 'needs-reconciliation', error: 'An uncertain write remains.' };
  story.sourceStage.reason = 'Candidate checks failed in an older attempt.';
  assert.equal(explain(source).kind, 'integration-uncertain', 'The journal wins over an obsolete stage reason.');
  review.sourceIntegration.state = 'abandoned';
  assert.equal(explain(source).action, 'Approve integration again');
  review.sourceIntegration.state = 'integrated';
  story.sourceStage.current = 'integrated';
  const integrated = explain(source);
  assert.equal(integrated.kind, 'integrated');
  assert.equal(integrated.action, null);
  assert.equal(integrated.details.length, 0);
  assert.match(story.autonomyNote, /Approve integration again/, 'Legacy attention is ignored, not rewritten.');
});

test('negative independent reviews name recording and send-back, using the review acceptance policy', () => {
  for (const accept of ['director', 'auto']) {
    const s = stagedSourceState(),
      story = s.tasks[0],
      review = s.attempts[1];
    story.status = review.status = 'review';
    delete story.acceptedAttemptId;
    delete story.sourceStage.review;
    review.candidateReviewVerdict = 'needs-work';
    review.candidateReviewFindings = ['Blocking: The wrong source path was changed.'];
    s.autonomy = {
      policy: {
        enabled: true,
        retries: 1,
        kinds: {
          'studio-development:change-review': { accept },
          'studio-development:change': { accept: 'auto' },
        },
      },
    };
    const e = explain(s);
    assert.equal(e.kind, accept === 'auto' ? 'review-auto' : 'review-result');
    assert.equal(e.requiresDirector, accept !== 'auto');
    assert.equal(e.action, accept === 'auto' ? null : 'Accept result');
    assert.match(e.details.join('\n'), /Blocking: The wrong source path/);
    assert.match(e.next, accept === 'auto' ? /controller records.*bounded send-back/i : /Send back to implementation/);
  }
});

test('source story stages retain one identity and the independent review in Runs', () => {
  const state = stagedSourceState(),
    story = state.tasks[0],
    stage = story.sourceStage;
  const [waiting] = buildRunStories(state);
  assert.deepEqual([...waiting.taskIds], ['S']);
  assert.deepEqual(
    [...waiting.needsYou].map(item => item.action),
    ['Approve integration'],
  );
  assert.ok(waiting.steps.some(step => /Morgan started candidate review for source story S/.test(step.text)));
  assert.ok(waiting.steps.some(step => /Morgan reviewed it: pass/.test(step.text) && step.attemptId === 'review-1'));
  assert.equal(waiting.steps.filter(step => /approved/.test(step.text)).length, 1, 'Only original work approval.');

  // Acceptance of implementation schedules review: task status ready, while the
  // earlier acceptedAttemptId/lastAttemptId may still point to implementation.
  Object.assign(story, {
    status: 'ready',
    queued: true,
    lastAttemptId: 'implementation-1',
    acceptedAttemptId: 'implementation-1',
  });
  stage.current = 'candidate-review';
  delete stage.review;
  delete stage.attemptId;
  state.attempts.pop();
  let runStory = buildRunStories(state)[0];
  assert.equal(runStory.outcome.label, 'In progress');
  assert.equal(runStory.needsYou[0].kind, 'queued');
  Object.assign(story, { queued: false, status: 'done' });
  assert.equal(
    buildRunStories(state)[0].outcome.label,
    'Needs you',
    'Missing current review evidence is an inspection decision.',
  );
  for (const current of ['blocked', 'failed']) {
    Object.assign(stage, { current, reason: 'No independent reviewer is available; configure Quality.' });
    runStory = buildRunStories(state)[0];
    assert.equal(runStory.outcome.label, 'Needs you');
    assert.equal(runStory.needsYou.length, 1);
    assert.match(runStory.needsYou[0].details.join('\n'), /configure Quality/i);
  }
  story.status = 'denied';
  assert.equal(buildRunStories(state)[0].outcome.label, 'Finished', 'Closed work is not an active stage.');
});

test('Runs assigns one execution disclosure to each recorded attempt, including retries, stages and missing timestamps', () => {
  const state = stagedSourceState(),
    story = state.tasks[0],
    implementation = state.attempts[0],
    review = state.attempts[1];
  review.sourceIntegration = {
    state: 'rejected',
    startedAt: at(50),
    finishedAt: at(51),
    error: 'Verification failed.',
  };
  state.attempts.push(
    { ...implementation, id: 'implementation-2', startedAt: at(52), finishedAt: at(53) },
    { ...review, id: 'review-2', startedAt: at(54), finishedAt: null, status: 'running', sourceIntegration: null },
    { ...implementation, id: 'old-without-times', startedAt: null, finishedAt: null },
    { ...review, id: 'foreign-project', taskId: 'other-story' },
  );
  const before = JSON.stringify(state),
    [run] = buildRunStories(state),
    executions = run.steps.filter(step => step.execution);
  assert.equal(executions.length, 5);
  for (const a of state.attempts.filter(a => a.taskId === story.id)) {
    const own = executions.filter(step => step.execution.attemptId === a.id);
    assert.equal(own.length, 1, a.id);
    assert.equal(own[0].taskId, a.taskId);
    assert.equal(own[0].attemptId, a.id);
    assert.equal(own[0].kind, a.status === 'running' ? 'start' : 'finish');
  }
  assert.match(
    executions.find(step => step.attemptId === implementation.id).execution.label,
    /implementation · attempt 2/,
  );
  assert.match(executions.find(step => step.attemptId === review.id).execution.label, /candidate review · attempt 3/);
  assert.match(
    executions.find(step => step.attemptId === 'implementation-2').execution.label,
    /implementation · attempt 4/,
  );
  assert.equal(executions.find(step => step.attemptId === 'old-without-times').at, null);
  assert.ok(run.steps.some(step => step.kind === 'integrate' && step.detail === 'Verification failed.'));
  assert.equal(JSON.stringify(state), before, 'Story building preserves the recorded history.');
});

test('only current accepted passing source evidence offers integration, including integration retries', () => {
  const { integrationReview } = context.StudioRuns;
  const mutations = [
    s => {
      delete s.tasks[0].sourceStage.review;
    },
    s => {
      s.attempts.pop();
    },
    s => {
      s.attempts[1].status = 'review';
    },
    s => {
      s.tasks[0].acceptedAttemptId = 'implementation-1';
    },
    s => {
      s.tasks[0].lastAttemptId = 'newer-review';
    },
    s => {
      s.tasks[0].sourceStage.review.verdict = 'needs-work';
    },
    s => {
      s.attempts[1].candidateReviewVerdict = 'needs-work';
    },
    s => {
      s.attempts[1].candidateReview.passed = false;
    },
    s => {
      s.attempts[1].controllerChecks = [{ name: 'Validation', status: 'fail' }];
    },
    s => {
      s.attempts[0].result.checks = [{ name: 'Candidate tests', status: 'fail' }];
    },
    s => {
      s.attempts[1].candidateReview.attemptId = 'superseded-candidate';
    },
    s => {
      s.attempts[1].candidateReview.candidateHash = 'stale';
    },
    s => {
      s.tasks[0].sourceStage.review.hash = 'stale';
    },
    s => {
      s.attempts[1].inputReferences = [];
    },
    s => {
      s.attempts[1].workerId = 'W-02';
    },
    s => {
      s.tasks[0].sourceStage.phase = 'implementing';
    },
  ];
  for (const mutate of mutations) {
    const s = stagedSourceState();
    mutate(s);
    assert.equal(integrationReview(s.tasks[0], s.attempts), null, mutate.toString());
    assert.ok(
      !buildRunStories(s)[0].needsYou.some(item => /^(Approve integration|Integrate)/i.test(item.action)),
      mutate.toString(),
    );
  }
  for (const state of [
    'verifying',
    'preparing',
    'prepared',
    'applying',
    'committing',
    'needs-reconciliation',
    'integrated',
  ]) {
    const s = stagedSourceState();
    s.attempts[1].sourceIntegration = { state, startedAt: at(5), finishedAt: at(6) };
    s.tasks[0].sourceStage.integration = { id: 'integration-1', attemptId: 'review-1', state };
    s.tasks[0].sourceStage.phase = 'integration';
    if (state === 'integrated') s.tasks[0].sourceStage.current = 'integrated';
    const [result] = buildRunStories(s);
    assert.equal(integrationReview(s.tasks[0], s.attempts), null, state);
    assert.ok(!result.needsYou.some(item => /^(Approve integration|Integrate)/i.test(item.action)), state);
    assert.equal(
      result.outcome.label,
      state === 'integrated' ? 'Integrated' : state === 'needs-reconciliation' ? 'Needs you' : 'In progress',
    );
  }
  const pending = stagedSourceState();
  pending.autonomy = {
    pendingIntegration: { taskId: 'S', attemptId: 'review-1', reviewHash: 'review-hash-1', requestedAt: at(5) },
  };
  assert.equal(buildRunStories(pending)[0].needsYou[0].kind, 'integration-pending');
  assert.equal(buildRunStories(pending)[0].outcome.label, 'In progress');
  for (const state of ['rejected', 'abandoned']) {
    const s = stagedSourceState();
    s.attempts[1].sourceIntegration = {
      state,
      startedAt: at(5),
      finishedAt: at(6),
      error: 'Verification failed; inspect test output.',
    };
    Object.assign(s.tasks[0].sourceStage, {
      phase: 'integration',
      current: 'failed',
      reason: s.attempts[1].sourceIntegration.error,
      integration: { id: 'integration-1', attemptId: 'review-1', state },
    });
    const [result] = buildRunStories(s);
    assert.equal(result.needsYou.length, 1);
    assert.equal(result.needsYou[0].action, 'Approve integration again');
    assert.match(result.needsYou[0].details.join('\n'), /Verification failed/);
    assert.ok(result.steps.some(step => step.text === `Integration ${state}.`));
  }
});

test('needs-work review and replacement implementation stay on the source story timeline', () => {
  const s = stagedSourceState(),
    story = s.tasks[0],
    negative = s.attempts[1];
  negative.candidateReviewVerdict = 'needs-work';
  negative.revisionRequestedBy = {
    type: 'policy',
    revision: 2,
    at: at(5),
    reason: 'Independent review requested changes. Repair the label.',
  };
  story.sourceStage.review.verdict = 'needs-work';
  Object.assign(story.sourceStage, { phase: 'implementing', current: 'implementing' });
  Object.assign(story, { status: 'running', queued: true, lastAttemptId: 'implementation-2', autoRetries: 1 });
  s.attempts.push(
    attempt('implementation-2', 'S', 6, {
      status: 'running',
      workerId: 'W-02',
      assignment: { ...story, kind: 'studio-development:change' },
    }),
  );
  const [result] = buildRunStories(s);
  assert.deepEqual([...result.taskIds], ['S']);
  assert.equal(result.outcome.label, 'In progress');
  assert.equal(result.needsYou.length, 0);
  assert.ok(result.steps.some(step => /Morgan reviewed it: needs work/.test(step.text)));
  assert.ok(result.steps.some(step => step.kind === 'revise' && /Repair the label/.test(step.detail)));
  assert.ok(
    result.steps.some(step => step.kind === 'retry' && step.taskId === 'S' && step.attemptId === 'implementation-2'),
  );
  assert.ok(
    result.steps.some(
      step => /Eli started implementation for source story S/.test(step.text) && step.attemptId === 'implementation-2',
    ),
  );
});

test('a run that integrated several stories is named for its current stories and names every commit', () => {
  const story = (id, minute, fields = {}) =>
      task(id, {
        kind: 'change',
        workerId: 'W-02',
        title: id + ' story',
        createdAt: at(minute),
        proposalReference: { taskId: 'B', attemptId: 'a-B' },
        ...fields,
      }),
    integrated = (id, storyId, minute, commit) => [
      task(id, {
        kind: 'studio-development:change-review',
        workerId: 'W-07',
        acceptedAttemptId: 'a-' + id,
        dependencies: [storyId],
        proposalReference: { taskId: storyId, attemptId: 'a-' + storyId },
      }),
      attempt('a-' + id, id, minute, {
        candidateReviewVerdict: 'pass',
        sourceIntegration: {
          state: 'integrated',
          startedAt: at(minute + 1),
          finishedAt: at(minute + 2),
          repository: { commit },
        },
      }),
    ],
    later = integrated('V3', 'S3', 20, 'bbbbbbb9999'),
    earlier = integrated('V2', 'S2', 10, 'aaaaaaa9999');
  const stories = shape =>
    buildRunStories({
      ...base,
      tasks: [
        task('B', { kind: 'review', workerId: 'W-07', workflowReference: { ...run, key: 'breakdown' } }),
        ...shape.tasks,
      ],
      attempts: [attempt('a-B', 'B', 0), ...shape.attempts],
    })[0];
  // The first story was retired when the breakdown was sent back, so it no longer names the run.
  const retired = story('S1', 1, { status: 'denied', approval: { status: 'denied', by: { type: 'controller' } } });
  const several = stories({
    tasks: [retired, story('S2', 2), story('S3', 3), later[0], earlier[0]],
    attempts: [later[1], earlier[1]],
  });
  assert.equal(several.title, 'S2 story (and 1 more)');
  assert.equal(several.outcome.text, 'The changes were committed as aaaaaaa and bbbbbbb.');
  assert.equal(
    stories({ tasks: [retired], attempts: [] }).title,
    'S1 story',
    'Only retired work: it still names the run.',
  );
  assert.equal(stories({ tasks: [retired, story('S2', 2)], attempts: [] }).title, 'S2 story');
});

test('a step waiting on work that was closed after it ran is named as stuck behind closed work', () => {
  const [story] = buildRunStories({
    ...base,
    tasks: [
      task('C', {
        kind: 'change',
        workerId: 'W-02',
        status: 'denied',
        closed: { at: at(5), reason: 'Closed without integrating.', status: 'done', by: { type: 'director' } },
        workflowReference: { ...run, key: 'change' },
      }),
      task('D', {
        kind: 'change',
        workerId: 'W-02',
        status: 'blocked',
        dependencies: ['C'],
        workflowReference: { ...run, key: 'next' },
      }),
    ],
    attempts: [attempt('a-C', 'C', 0)],
  });
  assert.match(story.needsYou.find(item => item.taskId === 'D').text, /C to be accepted/);
  assert.ok(
    story.steps.some(step => step.text.startsWith('You closed source improvement C without taking it further.')),
  );
});

test('a run that ended in reviews asking for changes is finished, while any other wait keeps it in progress', () => {
  // As the October 13 run was recorded: two changes from before stories had stages, each with a separate accepted
  // review that asked for changes. Nothing was integrated, nothing runs or is queued and no CLI is held.
  const change = (id, minute) => [
      task(id, {
        kind: 'studio-development:change',
        workerId: 'W-02',
        acceptedAttemptId: 'a-' + id,
        lastAttemptId: 'a-' + id,
        createdAt: at(minute),
        workflowReference: { ...run, key: 'change-' + id },
      }),
      attempt('a-' + id, id, minute, { workerId: 'W-02', assignment: { kind: 'studio-development:change' } }),
    ],
    review = (id, changeId, minute) => [
      task(id, {
        kind: 'studio-development:change-review',
        workerId: 'W-07',
        dependencies: [changeId],
        acceptedAttemptId: 'a-' + id,
        lastAttemptId: 'a-' + id,
        createdAt: at(minute),
        workflowReference: { ...run, key: 'review-' + id },
      }),
      attempt('a-' + id, id, minute, {
        workerId: 'W-07',
        assignment: { kind: 'studio-development:change-review' },
        candidateReview: { taskId: changeId, attemptId: 'a-' + changeId },
        candidateReviewVerdict: 'needs-work',
      }),
    ],
    records = [change('C1', 1), review('R1', 'C1', 3), change('C2', 5), review('R2', 'C2', 7)],
    ended = () => ({ ...base, tasks: records.map(([t]) => t), attempts: records.map(([, a]) => a) }),
    story = state => buildRunStories(state).find(candidate => candidate.id === run.runId),
    items = result => result.needsYou.map(item => [item.taskId, item.kind, item.action, item.requiresDirector]),
    plain = value => JSON.parse(JSON.stringify(value)),
    waiting = { tone: 'busy', label: 'In progress', text: 'The controller is waiting; nothing is needed from you.' };

  const finished = story(ended());
  assert.deepEqual(plain(items(finished)), [
    ['R1', 'review-findings', null, false],
    ['R2', 'review-findings', null, false],
  ]);
  assert.deepEqual(plain(finished.outcome), {
    tone: 'muted',
    label: 'Finished',
    text: "Ended without integrating because the review asked for changes. If you still want the change, start new work from the review's findings.",
  });
  assert.notEqual(finished.outcome.label, 'In progress');

  // The same run with work waiting for a usage limit that resets by itself.
  const held = {
    ...ended(),
    ...heldClis,
    workers: [...base.workers, { id: 'W-03', displayName: 'Quinn', provider: 'codex' }],
    quota: { codex: true },
    quotaResets: { codex: tonight() },
  };
  held.tasks.push(
    task('H', {
      kind: 'studio-development:change',
      workerId: 'W-03',
      status: 'blocked',
      queued: true,
      controllerWait: true,
      reason: 'Waiting for the Codex usage limit to reset at 10:25 PM.',
      createdAt: at(9),
      workflowReference: { ...run, key: 'held' },
    }),
  );
  const usage = story(held);
  assert.deepEqual(plain(items(usage)).at(-1), ['H', 'subscription-wait', null, false]);
  assert.deepEqual(plain(usage.outcome), waiting);

  // The same run with queued work waiting for another story, still in another run, to be integrated.
  const behind = ended();
  behind.tasks.push(
    task('P', {
      kind: 'studio-development:change',
      workerId: 'W-02',
      status: 'blocked',
      queued: true,
      controllerWait: true,
      dependencies: ['X'],
      waitsFor: { X: 'integrated' },
      createdAt: at(9),
      workflowReference: { ...run, key: 'next' },
    }),
    task('X', {
      kind: 'studio-development:change',
      workerId: 'W-02',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'candidate-review',
        current: 'waiting-for-integration',
      },
      workflowReference: { ...run, runId: 'run-2', key: 'other' },
    }),
  );
  const prerequisite = story(behind);
  assert.deepEqual(plain(items(prerequisite)).at(-1), ['P', 'prerequisite-wait', null, false]);
  assert.match(prerequisite.needsYou.at(-1).reason, /X to be integrated/);
  assert.deepEqual(plain(prerequisite.outcome), waiting);
});

// Serialized /api/state run views: archive belongs to the persisted run, not
// its tasks, workflowReference or outcome. Legacy views deliberately omit it.
function archiveState(specs) {
  const project = { id: 'project-runs-fixture', name: 'Run archive fixture' },
    state = {
      ...base,
      project,
      projects: [project],
      tasks: [],
      attempts: [],
      runs: [],
      teams: [],
      events: [],
      quota: {},
      company: { name: project.name, goalTaskIds: [] },
      runtime: { version: 'fixture' },
    };
  for (const [index, spec] of specs.entries()) {
    const id = spec.id,
      createdAt = at(spec.minute ?? index),
      t = task('T-' + id, {
        projectId: project.id,
        kind: 'change',
        workerId: 'W-02',
        createdAt,
        queued: false,
        resources: [],
        maxSeconds: 30,
        maxAttempts: 1,
        approval: { status: 'approved' },
        workflowReference: { ...run, runId: id, key: 'work' },
        acceptedAttemptId: 'A-' + id,
        lastAttemptId: 'A-' + id,
      }),
      a = attempt('A-' + id, t.id, spec.minute ?? index, {
        projectId: project.id,
        workerId: t.workerId,
        acceptedAt: createdAt,
      });
    switch (spec.outcome || 'Finished') {
      case 'Integrated':
        a.sourceIntegration = { state: 'integrated', finishedAt: createdAt, repository: { commit: 'abcdef1234' } };
        break;
      case 'Stopped':
        t.status = a.status = 'failed';
        t.autonomyNote = 'Stopped after the attempt limit.';
        delete a.acceptedAt;
        delete t.acceptedAttemptId;
        break;
      case 'Cancelled':
        t.status = 'denied';
        t.approval = { status: 'denied', decidedAt: createdAt };
        delete t.lastAttemptId;
        delete t.acceptedAttemptId;
        break;
      case 'In progress':
        t.status = a.status = 'running';
        delete a.finishedAt;
        delete a.acceptedAt;
        delete t.acceptedAttemptId;
        break;
      case 'Needs you':
        t.status = a.status = 'review';
        delete a.acceptedAt;
        delete t.acceptedAttemptId;
        break;
    }
    state.tasks.push(t);
    if (spec.outcome !== 'Cancelled') state.attempts.push(a);
    if (spec.recorded !== false)
      state.runs.push({
        id,
        projectId: project.id,
        workflow: { id: run.id, name: run.name, version: run.version },
        brief: 'Brief for ' + id,
        createdAt,
        revisions: [{ revision: 1, at: createdAt, reason: 'Run created from workflow version 1.' }],
        nodes: [
          {
            taskId: t.id,
            key: 'work',
            kind: t.kind,
            title: t.title,
            workerId: t.workerId,
            dependencies: [],
            revision: 1,
          },
        ],
        ...(spec.legacy ? { legacy: true } : { archive: { archived: !!spec.archived } }),
      });
  }
  return state;
}

// The dashboard offers Archive for these final outcomes on a recorded run (dashboard/src/runs-page.tsx).
test('a run shows a final outcome when it integrated, finished, stopped or was cancelled, and not while open', () => {
  const finals = ['Integrated', 'Finished', 'Stopped', 'Cancelled'],
    labels = [...finals, 'In progress', 'Needs you'],
    state = archiveState([
      ...labels.map((outcome, index) => ({ id: 'recorded-' + index, outcome })),
      ...finals.map((outcome, index) => ({ id: 'task-only-' + index, outcome, recorded: false })),
      { id: 'legacy-final', legacy: true },
    ]),
    stories = buildRunStories(state);
  for (const [index, label] of labels.entries())
    assert.equal(stories.find(story => story.id === 'recorded-' + index).outcome.label, label);
  assert.ok(stories.filter(story => story.id.startsWith('task-only-')).every(story => !story.archive));
  assert.match(
    stories
      .find(story => story.id === 'recorded-0')
      .steps.map(step => step.text)
      .join(' '),
    /abcdef1/,
  );
});
