// The computer's test turn (src/core/test-turn.mjs): an idea's checks and a story's candidate tests run one full
// suite at a time, whichever project they belong to, and only their test run waits for it. Model-free: the protocol
// fixtures and the fixture test command (runtime.sourceCheckCommand) on disposable repositories, with no HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { recordProjectSource } from '../src/connectors/source-projects.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { testTurnResource } from '../src/core/test-turn.mjs';

const fixture = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  command = mode => ({ executable: process.execPath, args: [fixture, mode] }),
  tap = [
    'TAP version 13',
    '1..1',
    'ok 1 - gated fixture',
    '# tests 1',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n');
// A passing test run that ends once its gate file exists, so a test decides when a run holding the turn ends. Given a
// log, each run writes a line there as it starts and another as it ends, so a test reads whether two runs overlapped.
const gated = (gate, log) => ({
  executable: process.execPath,
  args: [
    '-e',
    `const fs = require('node:fs'), [gate, log] = process.argv.slice(1), note = line => log && fs.appendFileSync(log, line + '\\n'); note('start'); const wait = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(wait); note('end'); console.log(${JSON.stringify(tap)}); } }, 20);`,
    gate,
    ...(log ? [log] : []),
  ],
});
const turnSentence = holder => `Waiting for ${holder} to finish: this computer runs one full test suite at a time.`;
const holder = store => store.leases().find(lease => lease.resource === testTurnResource)?.attemptId ?? null;
const phases = (store, attemptId, phaseId) =>
  store.phaseEvents(attemptId).filter(event => event.payload.phaseId === phaseId);
const turnEvents = (store, attemptId) => store.events(attemptId).filter(event => event.kind === 'test_turn');

// An idea's checks, as intake creates them.
function addChecks(c, id, { projectId = 'project-legacy', workerId = 'W-06', maxSeconds = 120 } = {}) {
  const worker = c.app.store.organization().workers.find(worker => worker.id === workerId);
  c.app.store.putTask({
    id,
    projectId,
    title: 'Check the current commit',
    brief: 'Measure the current commit.',
    acceptance: '',
    kind: 'studio-development:checks',
    workerId,
    team: worker.team,
    dependencies: [],
    resources: [],
    maxSeconds,
    maxAttempts: 3,
    direction: '',
    status: 'ready',
    reason: '',
    hold: false,
    lastAttemptId: null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

// A second project with its own repository, whose profile installs nothing: its checks reach their test run while
// they start.
function fieldProject(c) {
  const store = c.app.store,
    id = 'project-field',
    root = path.join(c.directory, 'field-notes'),
    profile = {
      id: 'field-notes',
      directories: ['lib', 'spec', 'notes'],
      files: ['README.md'],
      extensions: ['js', 'md', 'txt'],
      protectedNames: ['SECRETS.md'],
      contextFiles: ['README.md', 'notes/overview.md'],
      tests: { directory: 'spec', suffix: '.spec.mjs' },
      formatter: null,
      limits: { files: 50, fileBytes: 64 * 1024, totalBytes: 1024 * 1024 },
    };
  for (const [file, text] of Object.entries({
    'README.md': '# Field notes\n',
    'lib/notes.js': 'export const notes = [];\n',
    'notes/overview.md': 'How the notes are kept.\n',
    'spec/notes.spec.mjs': 'import test from "node:test"; test("notes", () => {});\n',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Field notes']);
  store.putProject({ id, name: 'Field notes', goal: 'Fixture', direction: '', revision: 1 });
  recordProjectSource(store, id, { root, profile }, c.app.runner);
  return id;
}

test("an idea's checks wait for a candidate's test run, then run and pass; the wait names the holder and clears", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner,
    gate = path.join(c.directory, 'candidate-gate');
  runner.sourceCheckCommand = gated(gate);
  const story = runner.start(c.taskId).attemptId;
  await waitFor(() => holder(store) === story, "the candidate's test run to take the turn");
  runner.sourceCheckCommand = command('pass');
  const check = runner.start(addChecks(c, 'T-check-a')).attemptId;
  const waiting = await waitFor(() => store.attempt(check).testTurn, 'the checks to wait for the turn');
  // The checks wait before they install their packages (C-10's interim): the data folder holds one lockfile's packages
  // at a time, so an install while another suite runs could replace the packages under it.
  assert.deepEqual(phases(store, check, 'install'), [], 'Nothing is installed while it waits.');
  assert.deepEqual(phases(store, check, 'test'), [], 'No test process starts while it waits.');
  assert.equal(store.attempt(check).pid, null);
  assert.equal(store.attempt(check).status, 'running');
  assert.equal(waiting.reason, turnSentence(`the tests of ${c.taskId} (${store.task(c.taskId).title})`));
  assert.equal(waiting.holder, story);
  assert.ok(Date.parse(waiting.since) <= Date.now());
  assert.deepEqual(
    turnEvents(store, check).map(event => event.message),
    [waiting.reason],
  );
  fs.writeFileSync(gate, '');
  const done = await c.wait('T-check-a');
  assert.equal(done.testTurn, undefined, 'Taking the turn clears the record.');
  assert.equal(done.result.checks[0].status, 'pass');
  assert.equal(turnEvents(store, check).length, 1);
  const ended = phases(store, story, 'test').at(-1),
    installed = phases(store, check, 'install')[0],
    began = phases(store, check, 'test')[0];
  assert.equal(ended.payload.boundary, 'finish');
  assert.ok(installed.seq > ended.seq, "The checks' install starts once the candidate's tests have ended.");
  assert.ok(began.seq > ended.seq, "The checks' tests start once the candidate's have ended.");
  assert.equal((await c.wait(c.taskId)).id, story);
  assert.equal(holder(store), null);
});

test("a candidate's test run waits while an idea's checks run their tests, though its editor runs meanwhile", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner,
    gate = path.join(c.directory, 'checks-gate');
  runner.sourceCheckCommand = gated(gate);
  const check = runner.start(addChecks(c, 'T-check-b')).attemptId;
  await waitFor(() => holder(store) === check, "the checks' test run to take the turn");
  runner.sourceCheckCommand = command('pass');
  // The story is dispatched and its editor runs while the checks' tests run: only its test run waits.
  const story = runner.start(c.taskId).attemptId;
  const waiting = await waitFor(() => store.attempt(story).testTurn, "the candidate's test run to wait for the turn");
  const edit = phases(store, story, 'source.edit');
  assert.deepEqual(
    edit.map(event => [event.payload.boundary, event.payload.outcome]),
    [
      ['start', null],
      ['finish', 'succeeded'],
    ],
  );
  assert.ok(edit[0].seq > phases(store, check, 'test')[0].seq);
  assert.deepEqual(phases(store, story, 'test'), []);
  assert.equal(holder(store), check);
  assert.equal(waiting.reason, turnSentence('the tests of T-check-b (Check the current commit)'));
  assert.equal(waiting.holder, check);
  fs.writeFileSync(gate, '');
  const done = await c.wait(c.taskId);
  assert.equal(done.id, story);
  assert.equal(done.testTurn, undefined);
  assert.equal(done.result.checks.find(item => item.name === 'Candidate Node test suite').status, 'pass');
  assert.ok(phases(store, story, 'test')[0].seq > phases(store, check, 'test').at(-1).seq);
  assert.equal((await c.wait('T-check-b')).result.checks[0].status, 'pass');
  assert.equal(turnEvents(store, story).length, 1);
  assert.equal(holder(store), null);
});

test('the turn is held from the install through the tests: free while editing, and after a failing or stopped run', async t => {
  const c = await setup(t, 'fail', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner,
    seen = [],
    startPhase = runner.startPhase;
  runner.startPhase = function (entry, phaseId, evidence) {
    const phase = startPhase.call(this, entry, phaseId, evidence);
    seen.push([entry.attempt.id, phaseId, holder(store)]);
    return phase;
  };
  const story = runner.start(c.taskId).attemptId,
    failed = await c.wait(c.taskId);
  assert.equal(failed.result.checks.find(item => item.name === 'Candidate Node test suite').status, 'fail');
  const during = Object.fromEntries(
    seen.filter(([id, phaseId]) => id === story && phaseId !== 'attempt').map(([, phaseId, held]) => [phaseId, held]),
  );
  assert.equal(during['source.edit'], null);
  // Held through the install, so another lockfile's install never replaces the packages under this run (C-10).
  assert.equal(during.install, story);
  assert.equal(during.test, story);
  assert.equal(holder(store), null, 'A failing run gives the turn back.');
  // A run stopped while it holds the turn gives it back, and a stopped waiter leaves the queue without it.
  runner.sourceCheckCommand = command('hang');
  const hanging = runner.start(addChecks(c, 'T-check-hang')).attemptId;
  await waitFor(() => holder(store) === hanging, 'the hanging checks to take the turn');
  const waiter = runner.start(addChecks(c, 'T-check-wait', { workerId: 'W-07' })).attemptId;
  await waitFor(() => store.attempt(waiter).testTurn, 'the second checks to wait for the turn');
  runner.stop(waiter);
  assert.equal(store.attempt(waiter).status, 'cancelled', 'A waiting attempt has no process to wait for.');
  assert.equal(store.attempt(waiter).testTurn, undefined);
  assert.equal(holder(store), hanging);
  runner.stop(hanging);
  assert.equal((await c.wait('T-check-hang', 'cancelled')).id, hanging);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(holder(store), null);
  assert.deepEqual(phases(store, waiter, 'test'), [], 'The stopped waiter never took the turn.');
  assert.equal(store.leases().length, 0);
});

test("waiting for the turn never counts toward a check's time limit", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner,
    projectId = fieldProject(c);
  // The turn is held, as by a run whose holder is not yet reconciled, for longer than the check's limit.
  store.claim([testTurnResource], 'held-suite');
  const id = addChecks(c, 'T-check-limit', { projectId, maxSeconds: 2 }),
    attempt = runner.start(id).attemptId,
    // Its copy is made in a process of its own first (src/adapters/source-snapshot.mjs).
    waiting = await waitFor(() => store.attempt(attempt).testTurn, 'the checks to wait for the turn');
  assert.equal(waiting.reason, turnSentence('another full test suite'));
  assert.equal(waiting.holder, 'held-suite');
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(store.attempt(attempt).status, 'running');
  assert.equal(store.task(id).status, 'running');
  store.releaseResource(testTurnResource, 'held-suite');
  const done = await c.wait(id);
  assert.equal(done.id, attempt);
  assert.equal(done.error ?? null, null);
  assert.equal(done.result.checks[0].status, 'pass');
  assert.equal(holder(store), null);
});

test("two projects' runs take turns too, one on its own repository", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    store = c.app.store,
    runner = c.app.runner,
    projectId = fieldProject(c),
    gate = path.join(c.directory, 'field-gate');
  runner.sourceCheckCommand = gated(gate);
  const field = runner.start(addChecks(c, 'T-check-field', { projectId })).attemptId;
  // Its checks install nothing and take the turn once their copy is made.
  await waitFor(() => holder(store) === field, 'the field checks to take the turn');
  runner.sourceCheckCommand = command('pass');
  const studio = runner.start(addChecks(c, 'T-check-studio', { workerId: 'W-07' })).attemptId;
  const waiting = await waitFor(() => store.attempt(studio).testTurn, "the other project's checks to wait");
  assert.equal(waiting.reason, turnSentence('the tests of T-check-field (Check the current commit)'));
  assert.deepEqual(phases(store, studio, 'test'), []);
  fs.writeFileSync(gate, '');
  const first = await c.wait('T-check-field'),
    second = await c.wait('T-check-studio');
  assert.equal(first.projectId, projectId);
  assert.equal(second.projectId, 'project-legacy');
  for (const done of [first, second]) assert.equal(done.result.checks[0].status, 'pass');
  assert.ok(phases(store, studio, 'test')[0].seq > phases(store, field, 'test').at(-1).seq);
  assert.equal(holder(store), null);
});

// Two approved stories of one project on separate files, which build at the same time (October 29).
async function twoStories(c) {
  const { store, runner } = c.app,
    { ids } = await c.breakdown([
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: [] },
    ]);
  for (const id of ids) approveWork(store, runner.registries, store.task(id));
  return ids;
}
const candidateSuite = attempt => attempt.result.checks.find(item => item.name === 'Candidate Node test suite');

test('two stories whose editors finish together test one after the other, and the second names the first until its turn', async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    hold = path.join(c.directory, 'setup-hold'),
    gate = path.join(c.directory, 'first-gate'),
    log = path.join(c.directory, 'test-runs.log'),
    ids = await twoStories(c),
    seen = [],
    startPhase = runner.startPhase;
  runner.startPhase = function (entry, phaseId, evidence) {
    const phase = startPhase.call(this, entry, phaseId, evidence);
    seen.push([entry.attempt.id, phaseId, holder(store), store.attempt(entry.attempt.id).testTurn ?? null]);
    return phase;
  };
  // Both setups are held until both have begun, so the two editors run, and finish, together.
  fs.writeFileSync(hold, '');
  runner.sourceSetupHold = hold;
  runner.sourceCheckCommand = gated(gate, log);
  const attempts = ids.map(id => runner.start(id).attemptId);
  await waitFor(
    () => attempts.every(id => phases(store, id, 'setup.snapshot').length),
    'both setups to be held at once',
  );
  fs.rmSync(hold);
  // Whichever candidate asked first holds the turn until the test lets its run end.
  const first = await waitFor(() => attempts.find(id => id === holder(store)), "a candidate's tests to take the turn"),
    second = attempts.find(id => id !== first),
    firstTask = store.attempt(first).taskId,
    waiting = await waitFor(() => store.attempt(second).testTurn, 'the other candidate to wait for the turn');
  assert.equal(waiting.reason, turnSentence(`the tests of ${firstTask} (${store.task(firstTask).title})`));
  assert.equal(waiting.holder, first);
  assert.equal(phases(store, second, 'source.edit').at(-1).payload.boundary, 'finish', 'Its editor has finished.');
  assert.deepEqual(phases(store, second, 'install'), [], 'Nothing is installed while it waits.');
  assert.deepEqual(phases(store, second, 'test'), [], 'No test process starts while it waits.');
  assert.equal(store.attempt(second).pid, null);
  assert.equal(store.attempt(second).status, 'running');
  // While the first run is going, the second still waits.
  await waitFor(() => fs.existsSync(log), "the first candidate's test run to start");
  assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n'), ['start', ''], 'Only the first run has started.');
  assert.equal(store.attempt(second).testTurn.holder, first);
  assert.deepEqual(phases(store, second, 'test'), []);
  fs.writeFileSync(gate, '');
  const done = await Promise.all(ids.map(id => c.wait(id)));
  for (const attempt of done) assert.equal(candidateSuite(attempt).status, 'pass', attempt.id);
  // Each run started after the one before it ended, as the runs themselves wrote, and as the attempts recorded.
  assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n'), ['start', 'end', 'start', 'end', '']);
  const ended = phases(store, first, 'test').at(-1);
  assert.equal(ended.payload.boundary, 'finish');
  for (const phaseId of ['install', 'test'])
    assert.ok(
      phases(store, second, phaseId)[0].seq > ended.seq,
      `The second's ${phaseId} starts once the first's tests end.`,
    );
  // Its record names the first while it waits and is cleared once its run begins, holding the turn itself.
  assert.deepEqual(
    seen.filter(([id, phaseId]) => id === second && ['install', 'test'].includes(phaseId)).map(([, ...rest]) => rest),
    [
      ['install', second, null],
      ['test', second, null],
    ],
  );
  assert.equal(store.attempt(second).testTurn, undefined);
  assert.deepEqual(
    turnEvents(store, second).map(event => event.message),
    [waiting.reason],
  );
  assert.deepEqual(turnEvents(store, first), [], 'The first never waited.');
  assert.equal(holder(store), null);
});

test("a candidate's time limit stops while it waits for another candidate's tests that outlast it", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    gate = path.join(c.directory, 'first-gate'),
    ids = await twoStories(c),
    limit = 2000;
  runner.sourceCheckCommand = gated(gate);
  const first = runner.start(ids[0]).attemptId;
  await waitFor(() => holder(store) === first, "the first candidate's tests to take the turn");
  // The second candidate gets a limit shorter than the first's run, which keeps the controller's own limit.
  runner.sourceCheckCommand = command('pass');
  runner.candidateTimeoutMs = limit;
  const second = runner.start(ids[1]).attemptId,
    waiting = await waitFor(() => store.attempt(second).testTurn, 'the second candidate to wait for the turn');
  assert.equal(waiting.reason, turnSentence(`the tests of ${ids[0]} (${store.task(ids[0]).title})`));
  await new Promise(resolve => setTimeout(resolve, limit + 500));
  assert.equal(store.attempt(second).status, 'running');
  assert.equal(store.task(ids[1]).status, 'running');
  assert.deepEqual(phases(store, second, 'test'), []);
  fs.writeFileSync(gate, '');
  const ran = await c.wait(ids[0]),
    done = await c.wait(ids[1]);
  assert.ok(
    Date.parse(ran.checkExecution.finishedAt) - Date.parse(ran.checkExecution.startedAt) > limit,
    "The first candidate's tests ran longer than the second's limit.",
  );
  assert.equal(done.id, second);
  assert.equal(done.error ?? null, null);
  assert.equal(done.stopContext, undefined);
  assert.equal(done.testTurn, undefined);
  assert.equal(candidateSuite(done).status, 'pass');
  assert.ok(
    Date.parse(phases(store, second, 'install')[0].time) - Date.parse(waiting.since) > limit,
    'It waited longer than its limit before its install began.',
  );
  assert.ok(phases(store, second, 'test')[0].seq > phases(store, first, 'test').at(-1).seq);
  assert.equal(holder(store), null);
});

test("a candidate's tests that reach their time limit give the turn back, and the next candidate's tests run and pass", async t => {
  const c = await setup(t, 'pass', ['src/core/workflows.mjs'], {}, true),
    { store, runner } = c.app,
    ids = await twoStories(c),
    limit = 2000;
  // The turn is held while both candidates line up, so the first in line is known: its tests never end within its
  // short limit; the next one's tests pass under the controller's own limit.
  store.claim([testTurnResource], 'held-suite');
  runner.sourceCheckCommand = command('hang');
  runner.candidateTimeoutMs = limit;
  const first = runner.start(ids[0]).attemptId;
  await waitFor(() => store.attempt(first).testTurn, 'the first candidate to wait for the turn');
  runner.sourceCheckCommand = command('pass');
  delete runner.candidateTimeoutMs;
  const second = runner.start(ids[1]).attemptId;
  assert.equal(
    (await waitFor(() => store.attempt(second).testTurn, 'the second candidate to wait for the turn')).reason,
    turnSentence('another full test suite'),
  );
  store.releaseResource(testTurnResource, 'held-suite');
  await waitFor(() => holder(store) === first, 'the first in line to take the turn');
  const waiting = await waitFor(
    () => store.attempt(second).testTurn?.holder === first && store.attempt(second).testTurn,
    'the second candidate to name the first',
  );
  assert.equal(waiting.reason, turnSentence(`the tests of ${ids[0]} (${store.task(ids[0]).title})`));
  const stopped = await c.wait(ids[0], 'failed');
  assert.equal(stopped.id, first);
  assert.equal(stopped.error, 'Assignment time limit reached.');
  assert.equal(stopped.stopContext.activity, 'test');
  const done = await c.wait(ids[1]);
  assert.equal(done.id, second);
  assert.equal(done.error ?? null, null);
  assert.equal(done.testTurn, undefined);
  assert.equal(candidateSuite(done).status, 'pass');
  const ended = phases(store, first, 'test').at(-1);
  assert.equal(ended.payload.boundary, 'finish');
  for (const phaseId of ['install', 'test'])
    assert.ok(
      phases(store, second, phaseId)[0].seq > ended.seq,
      `The next ${phaseId} starts once the stopped run ends.`,
    );
  assert.equal(holder(store), null);
  assert.equal(store.leases().length, 0);
});
