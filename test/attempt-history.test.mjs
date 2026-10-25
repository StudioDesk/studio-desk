import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { createRegistries } from '../src/registry.mjs';
import { hash } from '../src/core/contracts.mjs';
import { jobDirectory } from '../src/core/projects.mjs';
import { textPrompt, TEXT_INPUT_LIMIT } from '../src/adapters/text-delivery.mjs';
import { workspacePrompt } from '../src/adapters/workspace-delivery.mjs';
import { buildAttemptHistory, historyLimits, unifiedDiff } from '../src/core/attempt-history.mjs';

const readHistory = job => {
  const folder = path.join(job, 'history');
  return fs.existsSync(folder)
    ? fs
        .readdirSync(folder)
        .sort()
        .map(name => ({
          name,
          filename: path.join(folder, name),
          content: fs.readFileSync(path.join(folder, name), 'utf8'),
        }))
    : [];
};

// A model-free consumer under a unique adapter id with every field register() requires.
function historySetup(t, mode = 'workspace') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-history-')),
    registries = createRegistries(),
    observed = [];
  registries.adapters.register({
    id: 'history-fixture',
    version: 'history-fixture-v1',
    name: 'History fixture',
    workerSelectable: true,
    capabilities: ['text-output'],
    modes: ['workspace', 'text'],
    status: () => ({ available: true, label: 'Protocol fixture' }),
    blockReason: () => '',
    configuration: () => ({ mode }),
    requestedModel: () => 'No model',
    delivery: 'Model-free history observation.',
    deliveryScope: 'Private fixture workspace.',
    start(runtime, entry) {
      this.run(runtime, entry);
    },
    run(runtime, entry) {
      const prompt =
        mode === 'text' ? textPrompt(entry, { name: 'History fixture' }) : workspacePrompt(entry, 'as JSON');
      observed.push({
        entry,
        prompt,
        agents: fs.readFileSync(path.join(entry.output, 'AGENTS.md'), 'utf8'),
        files: readHistory(entry.job),
      });
      fs.writeFileSync(path.join(entry.output, 'answer.txt'), 'Fixture result');
      runtime.finish(entry, {
        taskId: entry.attempt.taskId,
        outcome: 'completed',
        summary: 'Fixture transport.',
        artifacts: [{ path: 'answer.txt', kind: 'text' }],
        checks: [],
        issues: [],
        handoff: 'Review.',
      });
    },
  });
  const app = createStudio({ directory, port: 0, runnerOptions: { registries } }),
    org = app.store.organization(),
    worker = org.workers.find(worker => worker.id === 'W-03');
  worker.provider = 'history-fixture';
  app.store.setOrganization(org);
  const task = (id, fields = {}) => {
    const value = {
      id,
      projectId: 'project-legacy',
      kind: 'general',
      workerId: worker.id,
      team: worker.team,
      title: `History ${id}`,
      brief: 'Bounded model-free work.',
      acceptance: 'Exact history.',
      status: 'ready',
      dependencies: [],
      resources: [],
      maxSeconds: 30,
      maxAttempts: 100,
      ...fields,
    };
    app.store.putTask(value);
    return value;
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { app, observed, task };
}

const kinds = {
  'change.diff': 'source-change-diff',
  'test-output.txt': 'test-log',
  'review.json': 'source-change-review',
};
// Records a finished earlier attempt as the controller would have, with its job files.
function record(app, fields, files = {}, recordedOnly = {}) {
  const a = {
    projectId: 'project-legacy',
    workerId: 'W-03',
    provider: 'history-fixture',
    status: 'failed',
    finishedAt: fields.startedAt,
    artifacts: [],
    inputReferences: [],
    ...fields,
  };
  a.assignment = { id: a.taskId, kind: 'general', title: a.taskId, ...fields.assignment };
  const output = path.join(jobDirectory(app.store, a), 'output');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, name), content);
    a.artifacts.push({ path: name, kind: kinds[name], hash: hash(content), bytes: Buffer.byteLength(content) });
  }
  // Evidence recorded on the attempt whose bytes are now missing or altered.
  for (const [name, content] of Object.entries(recordedOnly))
    a.artifacts.push({ path: name, kind: kinds[name], hash: hash(content), bytes: Buffer.byteLength(content) });
  app.store.insertAttempt(a, { hash: 'snapshot-' + a.id, text: 'Earlier instructions.' });
  return a;
}

function seed(c) {
  c.task('history-origin', { title: 'Origin of the retry', status: 'done' });
  c.task('history-sibling', { title: 'Unrelated sibling', status: 'done' });
  c.task('history-task', {
    title: 'Retried work',
    retryOf: 'history-origin',
    scopeEdits: [
      {
        files: ['src/answered.mjs'],
        newFiles: [],
        deleteFiles: [],
        reason: 'Director approved the answered file',
        at: '2026-01-01T00:02:30.000Z',
        by: { type: 'director' },
        request: { attemptId: 'attempt-two', workerId: 'W-03' },
      },
    ],
  });
  record(c.app, {
    id: 'attempt-origin',
    taskId: 'history-origin',
    status: 'review',
    startedAt: '2026-01-01T00:00:00.000Z',
    result: { outcome: 'completed', summary: 'Origin summary marker', checks: [], issues: [], artifacts: [] },
  });
  record(
    c.app,
    {
      id: 'attempt-one',
      taskId: 'history-task',
      startedAt: '2026-01-01T00:01:00.000Z',
      error: 'Assignment time limit reached.',
      stopContext: { reason: 'time-limit', timedOut: true, activity: 'test', phaseId: 'test' },
      failedTests: [{ name: 'alpha fails', file: 'alpha.test.mjs', error: 'expected ONE "quoted"' }],
      controllerChecks: [{ name: 'controller-check-marker', status: 'fail', evidence: 'Measured failure.' }],
      assignment: { direction: 'Director note one' },
    },
    {
      'change.diff': '--- a/one\n+++ b/one\n+diff-one-marker\n',
      'test-output.txt': 'not ok 1 - alpha fails\n  error: expected ONE\n',
    },
  );
  record(
    c.app,
    {
      id: 'attempt-two',
      taskId: 'history-task',
      status: 'blocked',
      startedAt: '2026-01-01T00:02:00.000Z',
      error: 'Usage limit reached for this CLI.',
      subscriptionHold: { at: '2026-01-01T00:02:10.000Z', reason: 'usage-limit-marker' },
      scopeRequest: { files: ['src/answered.mjs'], newFiles: [], deleteFiles: [], reason: 'need the answered file' },
      assignment: { direction: 'Director note two' },
    },
    { 'change.diff': '+diff-two-marker\n' },
  );
  record(
    c.app,
    {
      id: 'attempt-three',
      taskId: 'history-task',
      status: 'cancelled',
      startedAt: '2026-01-01T00:03:00.000Z',
      assignment: { direction: "Findings.\n\nDirector's note: send-back note three" },
    },
    { 'change.diff': '+diff-three-marker\n' },
  );
  record(
    c.app,
    {
      id: 'attempt-review',
      taskId: 'history-review',
      workerId: 'W-02',
      status: 'review',
      startedAt: '2026-01-01T00:03:30.000Z',
      inputReferences: [{ taskId: 'history-task', attemptId: 'attempt-three', artifacts: [] }],
      assignment: { kind: 'studio-development:review' },
      result: { outcome: 'completed', summary: 'Source review summary marker', checks: [], issues: [], artifacts: [] },
    },
    {
      'review.json': JSON.stringify({
        verdict: 'changes-requested',
        findings: [{ title: 'source finding marker', blocking: true }],
        notes: ['nonblocking note marker'],
      }),
    },
  );
  record(
    c.app,
    {
      id: 'attempt-general-review',
      taskId: 'history-general-review',
      workerId: 'W-02',
      status: 'review',
      startedAt: '2026-01-01T00:03:40.000Z',
      inputReferences: [{ taskId: 'history-task', attemptId: 'attempt-two', artifacts: [] }],
      assignment: { kind: 'general:review' },
    },
    {
      'review.json': JSON.stringify({
        verdict: 'needs-work',
        findings: ['general finding marker'],
        notes: ['general note marker'],
      }),
    },
  );
  record(
    c.app,
    {
      id: 'attempt-four',
      taskId: 'history-task',
      status: 'interrupted',
      startedAt: '2026-01-01T00:04:00.000Z',
      reconciledAt: '2026-01-01T00:05:00.000Z',
      scopeRequest: { files: ['src/unanswered.mjs'], reason: 'need the unanswered file' },
      assignment: { direction: 'Director note four' },
    },
    {},
    { 'change.diff': '+recorded but missing\n' },
  );
  // Neither the unrelated sibling nor another project's review of this work belongs here.
  record(c.app, {
    id: 'attempt-sibling',
    taskId: 'history-sibling',
    status: 'review',
    startedAt: '2026-01-01T00:04:30.000Z',
    result: { outcome: 'completed', summary: 'sibling marker', checks: [], issues: [], artifacts: [] },
  });
  c.app.store.insertAttempt(
    {
      id: 'attempt-foreign',
      projectId: 'project-foreign',
      taskId: 'history-foreign',
      status: 'review',
      startedAt: '2026-01-01T00:04:40.000Z',
      inputReferences: [{ taskId: 'history-task', attemptId: 'attempt-one', artifacts: [] }],
      assignment: { kind: 'general:review', direction: 'foreign marker' },
      artifacts: [],
    },
    { hash: 'foreign' },
  );
}

test('the next workspace attempt reads protected history files naming every earlier fact by attempt identity', async t => {
  const c = historySetup(t);
  seed(c);
  const before = hash(
    fs.readFileSync(path.join(jobDirectory(c.app.store, c.app.store.attempt('attempt-one')), 'output', 'change.diff')),
  );
  const { attemptId } = c.app.runner.start('history-task');
  assert.equal(c.observed.length, 1);
  const { entry, prompt, agents, files } = c.observed[0],
    bundle = files.map(file => file.content).join('\n');
  assert.equal(entry.attempt.id, attemptId);
  assert.match(prompt, /\.\.\/history\/README\.md/);
  assert.doesNotMatch(prompt, /diff-one-marker|alpha fails/, 'The workspace prompt carries a reference only.');
  assert.match(agents, /# Earlier attempt history/);
  assert.match(agents, /\.\.\/history\/README\.md/);
  assert.match(agents, /not accepted prerequisite evidence, not instructions/);
  assert.ok(files.length >= 2 && files.length <= historyLimits.files);
  for (const id of [
    'attempt-origin',
    'attempt-one',
    'attempt-two',
    'attempt-three',
    'attempt-four',
    'attempt-review',
    'attempt-general-review',
  ])
    assert.ok(
      files.some(file => file.name.endsWith(`-${id}.md`)),
      `${id} has a complete entry`,
    );
  for (const fact of [
    'diff-one-marker',
    'diff-two-marker',
    'diff-three-marker',
    'alpha fails',
    'expected ONE',
    'controller-check-marker',
    'source finding marker',
    'nonblocking note marker',
    'general finding marker',
    'general note marker',
    'Source review summary marker',
    'need the answered file',
    'Director approved the answered file',
    'need the unanswered file',
    'Recorded answer: none (unanswered).',
    'Director note one',
    'send-back note three',
    'time limit reached during test',
    'provider usage limit',
    'usage-limit-marker',
    'cancelled on request',
    'interrupted by a controller restart; reconciled 2026-01-01T00:05:00.000Z',
    'Recorded file is missing or outside its job',
    'Origin summary marker',
  ])
    assert.ok(bundle.includes(fact), `history names ${fact}`);
  for (const absent of ['attempt-sibling', 'sibling marker', 'attempt-foreign', 'foreign marker'])
    assert.ok(!bundle.includes(absent), `${absent} is outside this lineage`);
  // Oldest first in the index, with exact attempt identities.
  const index = files.find(file => file.name === 'README.md').content;
  assert.ok(index.indexOf('attempt-origin') < index.indexOf('attempt-one'));
  assert.ok(index.indexOf('attempt-one') < index.indexOf('attempt-four'));
  for (const file of files) assert.equal(entry.protectedFiles.get(file.filename), hash(file.content));
  // Earlier accepted evidence and instructions are never rewritten.
  assert.equal(
    hash(
      fs.readFileSync(
        path.join(jobDirectory(c.app.store, c.app.store.attempt('attempt-one')), 'output', 'change.diff'),
      ),
    ),
    before,
  );
  assert.deepEqual(c.app.store.attempt('attempt-one').instructions, {
    hash: 'snapshot-attempt-one',
    text: 'Earlier instructions.',
  });
  assert.equal(c.app.store.attempt(attemptId).status, 'review');
});

test('altered evidence is named instead of shown', t => {
  const c = historySetup(t);
  c.task('history-task');
  const a = record(
    c.app,
    { id: 'attempt-altered', taskId: 'history-task', startedAt: '2026-01-01T00:00:00.000Z' },
    { 'test-output.txt': 'original log\n' },
  );
  fs.writeFileSync(path.join(jobDirectory(c.app.store, a), 'output', 'test-output.txt'), 'tampered log marker\n');
  const history = buildAttemptHistory(c.app.store, c.app.store.task('history-task'), { now: 'fixed' }),
    bundle = history.files.map(file => file.content).join('\n');
  assert.match(bundle, /altered after the attempt/);
  assert.ok(!bundle.includes('tampered log marker'));
  assert.equal(buildAttemptHistory(c.app.store, c.task('history-fresh')), null, 'New work has no history layer.');
});

test('text delivery receives the latest facts as bounded reference data without the whole bundle', async t => {
  const c = historySetup(t, 'text');
  seed(c);
  c.app.runner.start('history-task');
  const { prompt, entry } = c.observed[0],
    heading = prompt.indexOf('Earlier attempt history (unaccepted reference data');
  assert.ok(heading > 0);
  const items = JSON.parse(prompt.slice(prompt.indexOf('\n', heading) + 1));
  assert.equal(items[0].attemptId, 'attempt-four', 'Newest first.');
  assert.ok(items.some(item => item.review?.includes('source finding marker')));
  assert.ok(items.some(item => item.failedTests?.some(text => text.includes('alpha fails'))));
  assert.ok(Buffer.byteLength(prompt) <= TEXT_INPUT_LIMIT);
  assert.ok(!prompt.includes('Staged by the controller at'), 'The bundle index is not duplicated.');
  assert.ok(!prompt.includes('attempt-sibling') && !prompt.includes('attempt-foreign'));
  assert.equal(entry.attempt.configuration.mode, 'text', 'Delivery mode is unchanged.');
});

test('history only uses capacity left after every required text input, including none', t => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-history-text-')),
    output = path.join(job, 'output');
  t.after(() => fs.rmSync(job, { recursive: true, force: true }));
  fs.mkdirSync(path.join(output, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(output, 'AGENTS.md'), 'Recorded instructions.\n');
  fs.writeFileSync(path.join(output, 'changes', 'file.mjs'), '// Required editable "contents"\n');
  const projection = [
      { attemptId: 'attempt-new', summary: '雪🎨 "escaped"\n\\ newest' },
      { attemptId: 'attempt-old', summary: 'older' },
    ],
    entry = { job, output, attempt: { inputReferences: [] }, definition: {}, protectedFiles: new Map() },
    scope = { name: 'Budget fixture', editable: ['changes/file.mjs'] },
    required = textPrompt(entry, scope),
    size = Buffer.byteLength(required);
  entry.history = { reference: '../history/README.md', projection };
  assert.equal(textPrompt(entry, { ...scope, inputLimit: size }), required, 'No optional history fits.');
  const all = textPrompt(entry, scope);
  assert.ok(all.startsWith(required));
  assert.match(all, /0 older items not shown/);
  assert.ok(all.includes(JSON.stringify(projection)));
  const one = textPrompt(entry, { ...scope, inputLimit: Buffer.byteLength(all) - 1 });
  assert.ok(one.startsWith(required));
  assert.ok(Buffer.byteLength(one) < Buffer.byteLength(all));
  const shown = JSON.parse(one.slice(one.indexOf('\n', one.indexOf('Earlier attempt history')) + 1));
  assert.deepEqual(shown, [projection[0]], 'The newest item is offered first.');
  assert.match(one, /1 older items not shown/);
});

test('a long history with oversized logs and escaped text stays within byte and file ceilings', t => {
  const c = historySetup(t);
  c.task('history-task');
  const count = historyLimits.attempts + 12,
    unicode = '雪🎨 "quoted" \\ \n\t'.repeat(4000),
    stamp = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  for (let n = 0; n < count; n++)
    record(
      c.app,
      {
        id: `attempt-long-${String(n).padStart(3, '0')}`,
        taskId: 'history-task',
        startedAt: stamp(n),
        failedTests: [{ name: `test ${n}`, error: unicode.slice(0, 900) }],
        assignment: { direction: unicode },
      },
      n === count - 1
        ? { 'test-output.txt': 'not ok 1 - huge\n' + 'x'.repeat(historyLimits.readBytes + 4096) + '\nTAIL-MARKER\n' }
        : n >= count - 3
          ? { 'test-output.txt': `log ${n}\n` + unicode }
          : {},
    );
  const task = c.app.store.task('history-task'),
    first = buildAttemptHistory(c.app.store, task, { attemptId: 'attempt-current', now: 'fixed' }),
    second = buildAttemptHistory(c.app.store, task, { attemptId: 'attempt-current', now: 'fixed' });
  assert.deepEqual(first, second, 'Deterministic for the same records.');
  const total = first.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  assert.ok(first.files.length <= historyLimits.files);
  assert.ok(total <= historyLimits.bundleBytes);
  const [index, ...entries] = first.files;
  assert.ok(Buffer.byteLength(index.content) <= historyLimits.indexBytes);
  for (const file of entries) assert.ok(Buffer.byteLength(file.content) <= historyLimits.entryBytes);
  // The newest attempts are complete, newest first.
  assert.equal(entries.length, historyLimits.completeEntries);
  for (let n = count - historyLimits.completeEntries; n < count; n++)
    assert.ok(entries.some(file => file.path.endsWith(`attempt-long-${String(n).padStart(3, '0')}.md`)));
  const newest = entries.find(file =>
    file.path.endsWith(`attempt-long-${String(count - 1).padStart(3, '0')}.md`),
  ).content;
  assert.match(newest, /history read limit: \d+ of \d+ bytes not read; hash not verified/);
  assert.match(newest, /\[… truncated: \d+ of \d+ bytes omitted …\]/);
  assert.match(newest, /TAIL-MARKER/);
  // Older attempts are summarized or named, with omission markers.
  assert.match(index.content, /attempt-long-000 .*not read \(older than the 40-attempt read limit\)/);
  assert.match(index.content, /summarized: full entry omitted/);
  assert.match(index.content, /12 older attempts were not read/);
  assert.match(index.content, /32 older attempts are summarized/);
  assert.equal(first.projection.length, historyLimits.attempts);
  for (const item of first.projection) {
    const serialized = JSON.stringify(item);
    assert.ok(Buffer.byteLength(serialized) <= historyLimits.projectionItemBytes);
    assert.deepEqual(JSON.parse(serialized), item);
  }
  assert.equal(first.projection[0].attemptId, `attempt-long-${String(count - 1).padStart(3, '0')}`);
});

test('general work history names what each attempt continued from, or why it started fresh', t => {
  const c = historySetup(t);
  c.task('history-task');
  const work = { kind: 'general:work' },
    carried = ['draft/plan.md', 'notes.md'].map(file => ({ path: file, hash: hash(file), bytes: file.length })),
    reason = 'its recorded work could not be verified (Continuation hash/size mismatch.)',
    long = Array.from({ length: 30 }, (_, n) => ({ path: `deep/${'x'.repeat(2000)}-${n}.md`, hash: 'h', bytes: 1 }));
  record(c.app, {
    id: 'attempt-first',
    taskId: 'history-task',
    startedAt: '2026-01-01T00:00:00.000Z',
    assignment: work,
  });
  record(c.app, {
    id: 'attempt-carried',
    taskId: 'history-task',
    startedAt: '2026-01-01T00:01:00.000Z',
    assignment: work,
    continueFrom: { attemptId: 'attempt-first', files: carried },
  });
  record(c.app, {
    id: 'attempt-fresh',
    taskId: 'history-task',
    startedAt: '2026-01-01T00:02:00.000Z',
    assignment: work,
    continueFrom: { attemptId: 'attempt-carried', files: [], fresh: { reason } },
  });
  record(c.app, {
    id: 'attempt-long',
    taskId: 'history-task',
    startedAt: '2026-01-01T00:03:00.000Z',
    assignment: work,
    continueFrom: { attemptId: 'attempt-fresh', files: long },
  });
  const build = () => buildAttemptHistory(c.app.store, c.app.store.task('history-task'), { now: 'fixed' }),
    history = build(),
    entry = id => history.files.find(file => file.path.endsWith(`-${id}.md`)).content,
    item = id => history.projection.find(value => value.attemptId === id),
    continuedText = 'Continued from attempt-first: draft/plan.md, notes.md.',
    freshText = `Started fresh instead of the work of attempt-carried: ${reason}. Its history still shows that work.`;
  assert.ok(entry('attempt-carried').includes(`\n- continuation: ${continuedText}\n`));
  assert.ok(entry('attempt-fresh').includes(`\n- continuation: ${freshText}\n`));
  assert.equal(item('attempt-carried').continuation, continuedText);
  assert.equal(item('attempt-fresh').continuation, freshText);
  // Thirty long carried paths stay within the entry and projection item limits, with a marker.
  assert.match(
    entry('attempt-long'),
    /\n- continuation: Continued from attempt-fresh: deep\/x+ \[… truncated: \d+ of \d+ bytes omitted …\] x+-29\.md\.\n/,
  );
  assert.ok(Buffer.byteLength(entry('attempt-long')) <= historyLimits.entryBytes);
  assert.match(
    item('attempt-long').continuation,
    /^Continued from attempt-fresh: deep\/x+\n\[… truncated: \d+ of \d+ bytes omitted …\]\nx+-29\.md\.$/,
  );
  for (const value of history.projection)
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= historyLimits.projectionItemBytes);
  // An attempt without continueFrom states nothing; once removed from the others, every entry and
  // item renders exactly as it does without the continuation line.
  assert.doesNotMatch(entry('attempt-first'), /continuation:|Continued from|Started fresh/);
  assert.equal(Object.hasOwn(item('attempt-first'), 'continuation'), false);
  for (const id of ['attempt-carried', 'attempt-fresh', 'attempt-long']) {
    const { continueFrom, ...rest } = c.app.store.attempt(id);
    assert.ok(continueFrom);
    c.app.store.updateAttempt(rest);
  }
  const plain = build();
  assert.deepEqual(
    plain.files.map(file => file.content),
    history.files.map(file => file.content.replace(/\n- continuation: [^\n]*/, '')),
  );
  assert.deepEqual(
    plain.projection,
    history.projection.map(({ continuation, ...rest }) => rest),
  );
});

test('generated diffs are readable unified diffs without executing anything', () => {
  assert.equal(
    unifiedDiff('a.mjs', 'one\ntwo\nthree\n', 'one\n2\nthree\n'),
    '--- a/a.mjs\n+++ b/a.mjs\n@@ -1,4 +1,4 @@\n one\n-two\n+2\n three\n ',
  );
  assert.equal(unifiedDiff('new.mjs', null, 'x\n'), '--- /dev/null\n+++ b/new.mjs\n@@ -0,0 +1,2 @@\n+x\n+');
  assert.equal(unifiedDiff('same.mjs', 'x', 'x'), '');
});
