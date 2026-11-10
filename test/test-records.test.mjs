// A measured test run's whole record (test-output-full.txt), read-only from the controller: the attempt's own
// checks or candidate tests, and a story's merge. Model-free: the fixture source checks and written records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { sourceRepository } from './source-repository.mjs';
import { waitForTask, waitLimit } from './wait-for.mjs';
import {
  failedTests,
  testOutput,
  testOutputLimit,
  testRecordLimit,
  testTotals,
} from '../src/connectors/source-checks.mjs';
import { hash } from '../src/core/contracts.mjs';
import { jobDirectory } from '../src/core/projects.mjs';
import { checkSeconds } from '../src/packs/studio-development/index.mjs';

const checkFixture = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url));

// The checks run below measures a long fixture run (5001 tests), which took over 60 s on GitHub's Windows runner, past
// one waitLimit. Its wait lasts as long as the checks run may take: the checks task's own time limit as the controller
// records it. The test's own bound covers that wait plus its setup and requests (one waitLimit), past the suite's
// 120 seconds (package.json); the test after it runs the wait on a mocked clock against the earlier budget too.
const checksWait = task => task.maxSeconds * 1000;
const recordBudget = { timeout: checkSeconds * 1000 + waitLimit };

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-records-')),
    app = createStudio({
      directory,
      port: 0,
      runnerOptions: {
        // Checks measure a commit, so they read a disposable copy of this source, never the real repository.
        sourceChangeRoot: sourceRepository(),
        // One early failure in a long run: its whole record is longer than the bounded text reviews read.
        sourceCheckCommand: { executable: process.execPath, args: [checkFixture, 'early-failure'] },
      },
    });
  t.after(async () => {
    await app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = await app.start(),
    token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1],
    store = app.store;
  const send = async (route, data = {}, method = 'POST') => {
    const res = await fetch(origin + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(data),
    });
    return { status: res.status, data: await res.json() };
  };
  const created = await send('/api/studio-development');
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { project, workflow } = created.data;
  const address = (id, suffix = '', query = '') =>
    `${origin}/api/attempts/${id}/test-record${suffix}?projectId=${project.id}${query}`;
  const summary = async (id, query = '') => {
    const res = await fetch(address(id, '', query));
    return { status: res.status, data: await res.json() };
  };
  // An attempt of the project as the controller records one, with files written in its job folder.
  store.putTask({ ...store.task('D-001'), id: 'T-record-fixture', projectId: project.id, status: 'accepted' });
  const seed = (id, fields, files = {}) => {
    const attempt = {
      id,
      taskId: 'T-record-fixture',
      projectId: project.id,
      status: 'accepted',
      artifacts: [],
      ...fields,
    };
    store.insertAttempt(attempt, { text: 'Fixture instructions', hash: hash('Fixture instructions') });
    const job = jobDirectory(store, attempt);
    for (const [relative, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(job, relative)), { recursive: true });
      fs.writeFileSync(path.join(job, relative), text);
    }
    return { ...attempt, job };
  };
  // A checks or candidate attempt that measured a run registers its bounded log as a test log.
  const measured = (id, files = {}) => {
    const bounded = Buffer.from('TAP version 13\n');
    return seed(
      id,
      {
        assignment: { kind: 'studio-development:checks' },
        artifacts: [{ path: 'test-output.txt', kind: 'test-log', hash: hash(bounded), bytes: bounded.length }],
      },
      { 'output/test-output.txt': bounded, ...files },
    );
  };
  return { app, store, origin, project, workflow, send, address, summary, seed, measured };
}

const sandboxed = "sandbox; default-src 'none'";
function assertInertText(res) {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), sandboxed);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-disposition'), null, 'It is sent inline, not as an attachment.');
}

test(
  "a checks run's whole record is summarized and served as inert text, read-only and project-checked",
  { timeout: recordBudget.timeout },
  async t => {
    const c = await setup(t),
      run = await c.send(`/api/workflows/${c.workflow.id}/run`, {
        projectId: c.project.id,
        expectedVersion: c.workflow.version,
      });
    assert.equal(run.status, 201, JSON.stringify(run.data));
    const checks = c.store.task(run.data.taskIds[0]);
    assert.equal(checks.maxSeconds, checkSeconds, "The test's own bound covers the checks task's recorded time limit.");
    const checked = await waitForTask(c.store, checks.id, 'review', { interval: 20, limit: checksWait(checks) }),
      output = path.join(jobDirectory(c.store, checked), 'output'),
      bytes = fs.readFileSync(path.join(output, 'test-output-full.txt')),
      text = bytes.toString('utf8'),
      report = JSON.parse(fs.readFileSync(path.join(output, 'check-report.json'), 'utf8'));
    assert.ok(checked.artifacts.some(item => item.kind === 'test-log' && item.path === 'test-output.txt'));
    // The record holds what the bounded text that reviews read leaves out.
    assert.ok(bytes.length > fs.statSync(path.join(output, 'test-output.txt')).size);
    const expected = {
      recorded: true,
      run: 'attempt',
      bytes: bytes.length,
      limited: false,
      totals: testTotals(text),
      failedTests: failedTests(text),
    };
    assert.deepEqual(expected.totals, report.totals);
    assert.equal(expected.totals.tests, 5001);
    assert.deepEqual(expected.failedTests, [
      {
        name: 'fails early in a long run',
        file: 'early.test.mjs',
        error: "Expected values to be strictly equal: 'lost' !== 'kept'",
      },
    ]);
    for (const query of ['', '&run=attempt'])
      assert.deepEqual(await c.summary(checked.id, query), { status: 200, data: expected });
    const whole = await fetch(c.address(checked.id, '/text'));
    assertInertText(whole);
    assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));
    // Its story's merge is another run, and this attempt has none.
    assert.equal((await c.summary(checked.id, '&run=merge')).status, 404);
    assert.equal((await fetch(c.address(checked.id, '/text', '&run=merge'))).status, 404);
    // The project check of the attempt routes applies unchanged.
    for (const suffix of ['', '/text']) {
      const route = `${c.origin}/api/attempts/${checked.id}/test-record${suffix}`;
      assert.equal((await fetch(route)).status, 400);
      assert.equal((await fetch(route + '?projectId=project-legacy')).status, 400);
    }
    // Nothing writes through it: no POST or PATCH route, and reads change neither the record nor what reviews read.
    for (const method of ['POST', 'PATCH']) {
      const refused = await c.send(`/api/attempts/${checked.id}/test-record?projectId=${c.project.id}`, {}, method);
      assert.equal(refused.status, 404, JSON.stringify(refused.data));
    }
    assert.deepEqual(c.store.attempt(checked.id).artifacts, checked.artifacts);
    assert.ok(fs.readFileSync(path.join(output, 'test-output-full.txt')).equals(bytes));
    const log = await fetch(
      `${c.origin}/api/attempts/${checked.id}/artifact?projectId=${c.project.id}&path=test-output.txt`,
    );
    assert.equal(log.status, 200);
    assert.equal(
      hash(Buffer.from(await log.arrayBuffer())),
      checked.artifacts.find(a => a.path === 'test-output.txt').hash,
    );
  },
);

// Waits for a stand-in checks task, as the record test does, with a budget's wait limit and test bound on a mocked
// clock, against a checks run that finishes delay ms after it starts, and says how it ended: the attempt's ID, the wait
// that ran out, or that the test's own bound ran out first.
async function checksUnderSlowRun(t, budget, delay) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const start = Date.now(),
      task = { id: 'T-checks', status: 'working', maxSeconds: checkSeconds, lastAttemptId: 'attempt-checks' },
      store = {
        task: id => ({ ...task, id, status: Date.now() - start >= delay ? 'review' : task.status }),
        attempt: id => ({ id, status: Date.now() - start >= delay ? 'succeeded' : 'running' }),
      };
    let outcome;
    waitForTask(store, task.id, 'review', { interval: 20, limit: budget.limit(store.task(task.id)) }).then(
      attempt => (outcome = attempt.id),
      error => (outcome = error.message),
    );
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (outcome !== undefined) return outcome;
      if (Date.now() - start > budget.timeout) return `still waiting when the test's ${budget.timeout} ms ran out`;
      t.mock.timers.tick(500);
    }
  } finally {
    t.mock.timers.reset();
  }
}

test("the checks-run record test's wait outlasts a slow checks run, where its earlier wait ran out", async t => {
  const earlier = { limit: () => waitLimit, timeout: 120000 },
    budget = { limit: checksWait, timeout: recordBudget.timeout };
  // GitHub's Windows runner took 75 s: the earlier wait ran out first.
  assert.match(
    await checksUnderSlowRun(t, earlier, 75000),
    /^Timed out after 60000 ms waiting for task T-checks to be review; task T-checks is working/,
  );
  assert.equal(await checksUnderSlowRun(t, budget, 75000), 'attempt-checks');
  // Under one waitLimit both wait long enough.
  assert.equal(await checksUnderSlowRun(t, earlier, waitLimit - 500), 'attempt-checks');
  assert.equal(await checksUnderSlowRun(t, budget, waitLimit - 500), 'attempt-checks');
  // The new wait lasts the checks run's whole time limit, and stays bounded by it.
  assert.equal(await checksUnderSlowRun(t, budget, checkSeconds * 1000 - 500), 'attempt-checks');
  assert.match(
    await checksUnderSlowRun(t, budget, checkSeconds * 1000 + 500),
    /^Timed out after 600000 ms waiting for task T-checks to be review; task T-checks is working/,
  );
  // The test's own bound covers its whole wait and leaves the setup and requests one waitLimit more.
  assert.ok(budget.timeout >= checkSeconds * 1000 + waitLimit);
});

test("a story's merge record, runs that kept none and the runs an attempt does not have", async t => {
  const c = await setup(t),
    merged = [
      'TAP version 13',
      '# Subtest: keeps the merge',
      'ok 1 - keeps the merge',
      '  ---',
      '  duration_ms: 1.2',
      '  ...',
      '# Subtest: breaks after the merge',
      'not ok 2 - breaks after the merge',
      '  ---',
      '  duration_ms: 3.4',
      "  location: '/repository/test/merge.test.mjs:12:1'",
      "  failureType: 'testCodeFailure'",
      '  error: |-',
      '    Expected values to be strictly equal:',
      '    ',
      '    1 !== 2',
      "  code: 'ERR_ASSERTION'",
      '  ...',
      '1..2',
      '# tests 2',
      '# suites 0',
      '# pass 1',
      '# fail 1',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
      '# duration_ms 12.5',
      '',
    ].join('\n'),
    journal = { id: 'source-integration:fixture', state: 'failed', error: 'The merged source failed its tests.' },
    review = c.seed(
      'attempt-merged-review',
      { assignment: { kind: 'studio-development:review' }, sourceIntegration: journal },
      { 'integration/test-output-full.txt': merged },
    );
  assert.deepEqual(await c.summary(review.id, '&run=merge'), {
    status: 200,
    data: {
      recorded: true,
      run: 'merge',
      bytes: Buffer.byteLength(merged),
      limited: false,
      totals: { tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
      failedTests: [
        {
          name: 'breaks after the merge',
          file: 'merge.test.mjs',
          error: 'Expected values to be strictly equal: 1 !== 2',
        },
      ],
    },
  });
  const whole = await fetch(c.address(review.id, '/text', '&run=merge'));
  assertInertText(whole);
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(Buffer.from(merged)));
  // A review attempt registered no test log of its own, and run names only those two runs.
  const own = await c.summary(review.id);
  assert.deepEqual(own, { status: 404, data: { error: 'This attempt ran no measured tests.' } });
  assert.equal((await fetch(c.address(review.id, '/text', '&run=attempt'))).status, 404);
  for (const run of ['other', '', 'constructor', '..%2Foutput']) {
    assert.equal((await c.summary(review.id, `&run=${run}`)).status, 400);
    assert.equal((await fetch(c.address(review.id, '/text', `&run=${run}`))).status, 400);
  }
  // Runs from before records were kept, and a merge that stopped before its tests, say they kept none.
  const before = c.measured('attempt-before-records'),
    stopped = c.seed('attempt-merge-stopped', {
      assignment: { kind: 'studio-development:review' },
      sourceIntegration: { ...journal, error: 'The merge stopped before its tests.' },
    });
  for (const [attempt, run] of [
    [before, 'attempt'],
    [stopped, 'merge'],
  ]) {
    assert.deepEqual(await c.summary(attempt.id, `&run=${run}`), { status: 200, data: { recorded: false, run } });
    const missing = await fetch(c.address(attempt.id, '/text', `&run=${run}`));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'This run has no whole record.' });
  }
  assert.deepEqual(await c.summary(before.id), { status: 200, data: { recorded: false, run: 'attempt' } });
  assert.equal(
    fs.existsSync(path.join(before.job, 'output', 'test-output-full.txt')),
    false,
    'Reading writes nothing.',
  );
});

test('a record cut at its 64 MB limit says so, and a run that stopped before its totals reports none', async t => {
  const c = await setup(t),
    cut = c.measured('attempt-record-cut'),
    file = path.join(cut.job, 'output', 'test-output-full.txt');
  // The record as testOutput writes it when a runaway run passes its limit (in a chunk that crosses it).
  const recording = testOutput(testOutputLimit, file),
    megabyte = `ok 1 - passes before the record stops ${'x'.repeat(985)}\n`.repeat(1024);
  recording.add('TAP version 13\n');
  for (let written = 0; written <= testRecordLimit; written += megabyte.length) recording.add(megabyte);
  const size = fs.statSync(file).size;
  assert.ok(size > testRecordLimit);
  assert.deepEqual(await c.summary(cut.id), {
    status: 200,
    data: { recorded: true, run: 'attempt', bytes: size, limited: true, totals: null, failedTests: [] },
  });
  const early = c.measured('attempt-no-totals', {
    'output/test-output-full.txt': 'TAP version 13\nnot ok 1 - stops before its totals\n',
  });
  assert.deepEqual(await c.summary(early.id), {
    status: 200,
    data: {
      recorded: true,
      run: 'attempt',
      bytes: Buffer.byteLength('TAP version 13\nnot ok 1 - stops before its totals\n'),
      limited: false,
      totals: null,
      failedTests: [{ name: 'stops before its totals', file: '' }],
    },
  });
});

test('only a plain file inside its job folder is read as a record', async t => {
  const c = await setup(t),
    folder = c.measured('attempt-record-folder', { 'output/test-output-full.txt/inside.txt': 'Not a record' });
  for (const suffix of ['', '/text']) assert.equal((await fetch(c.address(folder.id, suffix))).status, 400);
  // The test sandbox refuses to create symbolic links, so the check meets one at its boundary.
  const linked = c.measured('attempt-record-link', { 'output/test-output-full.txt': '# tests 1\n' }),
    record = path.join(linked.job, 'output', 'test-output-full.txt'),
    lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) => {
    const stat = lstat(target, ...rest);
    return path.resolve(String(target)) === path.resolve(record)
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          isFile: () => false,
          isSymbolicLink: () => true,
        })
      : stat;
  });
  const refused = await c.summary(linked.id);
  assert.deepEqual(refused, { status: 400, data: { error: 'The whole record is not a plain file.' } });
  assert.equal((await fetch(c.address(linked.id, '/text'))).status, 400);
});
