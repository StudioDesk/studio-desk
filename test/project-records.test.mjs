// What a project's pages read without its whole history (Decision MP-026, v1.0 item 19b): the shared shell,
// the live set, finished runs a page at a time, and the instruction texts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './studio-setup.mjs';
import { recordProject } from '../src/core/projects.mjs';

const base = {
  kind: 'general',
  team: 'Design',
  workerId: 'W-01',
  resources: [],
  brief: 'Fixture work.',
  acceptance: 'Fixture acceptance.',
  maxAttempts: 3,
  maxSeconds: 120,
};
let clock = 0;
const task = (id, status, run, extra = {}) => ({
  ...base,
  id,
  title: id,
  status,
  dependencies: [],
  createdAt: new Date(Date.UTC(2026, 9, 21, 12, 0, clock++)).toISOString(),
  ...(run ? { workflowReference: { runId: run, key: id, id: 'flow', name: 'Fixture flow', version: 1 } } : {}),
  ...extra,
});

async function records(t) {
  const c = await setup(t),
    store = c.app.store;
  for (const record of [
    task('T-open', 'failed'), // standalone, still needs attention
    task('T-accepted', 'done'), // standalone, settled
    task('T-r1-done', 'done', 'run-open'),
    task('T-r1-working', 'running', 'run-open'),
    task('T-r2-a', 'done', 'run-a'), // finished runs, created in the order a, b, c
    task('T-r2-b', 'denied', 'run-a'),
    task('T-r3', 'done', 'run-b'),
    task('T-r4', 'done', 'run-c', { closed: true }),
    task('T-waits', 'blocked', null, { dependencies: ['T-r2-a'] }), // a live task's prerequisite
    task('T-retry', 'review', null, { retryOf: 'T-r1-done' }), // joins its original's run
    task('T-elsewhere', 'running', 'run-elsewhere', { projectId: 'project-other' }),
  ])
    store.putTask(record);
  store.insertAttempt({ id: 'attempt-live', taskId: 'T-r1-working', status: 'running' }, { text: 'never summarized' });
  store.insertAttempt(
    {
      id: 'attempt-old',
      taskId: 'T-r2-a',
      status: 'accepted',
      // A code story records the work it continued from only here.
      sourceChange: {
        continueFrom: {
          attemptId: 'attempt-earlier',
          files: [{ path: 'src/a.mjs', hash: 'earlier-hash' }],
          skipped: [],
        },
      },
    },
    { text: 'never summarized' },
  );
  store.insertAttempt({ id: 'attempt-settled', taskId: 'T-accepted', status: 'accepted' }, {});
  const read = async path => {
    const response = await fetch(c.origin + path);
    return { status: response.status, body: await response.json() };
  };
  return { ...c, store, read };
}

test('the live set holds unsettled work, every task of a run with open work, and direct prerequisites only', async t => {
  const { read } = await records(t);
  const { status, body } = await read('/api/projects/project-legacy/live');
  assert.equal(status, 200);
  const ids = body.tasks.map(item => item.id),
    fixture = ids.filter(id => id.startsWith('T-'));
  assert.deepEqual(fixture.sort(), ['T-open', 'T-r1-done', 'T-r1-working', 'T-r2-a', 'T-retry', 'T-waits'].sort());
  // The starter tasks a new install has are unsettled, so they are live too; nothing settled is.
  assert.ok(body.tasks.every(item => item.status !== 'done' || ['T-r1-done', 'T-r2-a'].includes(item.id)));
  assert.ok(body.tasks.every(item => Array.isArray(item.directorInputs)));
  assert.deepEqual(
    body.attempts.map(attempt => attempt.id).sort(),
    ['attempt-live', 'attempt-old'],
    'Attempt summaries come only for live tasks.',
  );
  assert.equal(JSON.stringify(body).includes('never summarized'), false);
  // T-r2-a is a prerequisite of T-waits, so its code story attempt says what it continued from.
  assert.deepEqual(body.attempts.find(attempt => attempt.id === 'attempt-old').continueFrom, {
    attemptId: 'attempt-earlier',
    files: [{ path: 'src/a.mjs' }],
  });
  assert.equal(JSON.stringify(body).includes('earlier-hash'), false);
  assert.deepEqual(
    body.runs.map(run => run.id),
    ['run-open'],
  );
  assert.ok(Array.isArray(body.runs[0].directorInputs));
});

test('accepted work that still waits for integration keeps its run live', async t => {
  const c = await setup(t),
    store = c.app.store,
    story = current => ({ version: 'source-story-stages-v1', phase: 'candidate-review', current });
  for (const record of [
    task('T-check', 'done', 'run-waiting'),
    task('T-story', 'done', 'run-waiting', {
      kind: 'studio-development:change',
      sourceStage: story('waiting-for-integration'),
    }),
    task('T-merged', 'done', 'run-merged', { kind: 'studio-development:change', sourceStage: story('integrated') }),
    // The older layout: a separate review task, accepted with a passing verdict and not yet integrated.
    task('T-review', 'done', 'run-review', {
      kind: 'studio-development:change-review',
      acceptedAttemptId: 'attempt-review',
    }),
    task('T-review-merged', 'done', 'run-review-merged', {
      kind: 'studio-development:change-review',
      acceptedAttemptId: 'attempt-review-merged',
    }),
  ])
    store.putTask(record);
  store.insertAttempt(
    { id: 'attempt-review', taskId: 'T-review', status: 'accepted', candidateReviewVerdict: 'pass' },
    {},
  );
  store.insertAttempt(
    {
      id: 'attempt-review-merged',
      taskId: 'T-review-merged',
      status: 'accepted',
      candidateReviewVerdict: 'pass',
      sourceIntegration: { state: 'integrated' },
    },
    {},
  );
  const live = await (await fetch(c.origin + '/api/projects/project-legacy/live')).json(),
    finished = await (await fetch(c.origin + '/api/projects/project-legacy/runs')).json();
  assert.deepEqual(live.runs.map(run => run.id).sort(), ['run-review', 'run-waiting']);
  assert.ok(['T-check', 'T-story', 'T-review'].every(id => live.tasks.some(item => item.id === id)));
  assert.deepEqual(finished.runs.map(item => item.run.id).sort(), ['run-merged', 'run-review-merged']);
});

test('finished runs come newest first, a page at a time, each with its tasks and attempts', async t => {
  const { read } = await records(t);
  const first = await read('/api/projects/project-legacy/runs?limit=2');
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.runs.map(item => item.run.id),
    ['run-c', 'run-b'],
    'A run whose tasks are closed is finished.',
  );
  assert.equal(first.body.next, 'run-b');
  const second = await read('/api/projects/project-legacy/runs?limit=2&before=run-b');
  assert.deepEqual(
    second.body.runs.map(item => item.run.id),
    ['run-a'],
  );
  const [earliest] = second.body.runs;
  assert.deepEqual(earliest.tasks.map(item => item.id).sort(), ['T-r2-a', 'T-r2-b']);
  assert.deepEqual(
    earliest.attempts.map(attempt => attempt.id),
    ['attempt-old'],
  );
  // A finished story never shows these; a task's own page reads them.
  for (const task of earliest.tasks)
    for (const field of ['direction', 'brief', 'acceptance', 'acceptedInputs'])
      assert.equal(field in task, false, field);
  for (const attempt of earliest.attempts)
    for (const field of ['inputReferences', 'artifacts', 'candidateReviewNotes', 'continueFrom'])
      assert.equal(field in attempt, false, field);
  assert.equal(second.body.next, null);
  assert.equal((await read('/api/projects/project-legacy/runs?before=run-gone')).status, 404);
  for (const limit of ['0', '51', 'x'])
    assert.equal((await read(`/api/projects/project-legacy/runs?limit=${limit}`)).status, 400);
  assert.equal((await read('/api/projects/project-missing/runs')).status, 400);
});

test('any one run, open or finished, reads on its own with its tasks and attempts', async t => {
  const { read } = await records(t);
  const finished = await read('/api/projects/project-legacy/runs/run-a');
  assert.equal(finished.status, 200);
  assert.equal(finished.body.run.id, 'run-a');
  assert.deepEqual(finished.body.tasks.map(item => item.id).sort(), ['T-r2-a', 'T-r2-b']);
  assert.deepEqual(
    finished.body.attempts.map(attempt => attempt.id),
    ['attempt-old'],
  );
  assert.equal('brief' in finished.body.tasks[0], false, 'A finished run carries what its story reads.');
  const open = await read('/api/projects/project-legacy/runs/run-open');
  // A retry joins its original's run, and open work keeps all it may still need.
  assert.deepEqual(open.body.tasks.map(item => item.id).sort(), ['T-r1-done', 'T-r1-working', 'T-retry']);
  assert.ok(open.body.tasks.every(item => typeof item.brief === 'string'));
  assert.equal((await read('/api/projects/project-legacy/runs/run-gone')).status, 404);
  assert.equal((await read('/api/projects/project-legacy/runs/run-elsewhere')).status, 404, 'Another project.');
});

test("a project's shell has no records, history or instruction text; the instructions are their own read", async t => {
  const { read, store } = await records(t);
  const { status, body } = await read('/api/projects/project-legacy/shell');
  assert.equal(status, 200);
  for (const key of ['tasks', 'attempts', 'events', 'runs', 'instructions']) assert.equal(key in body, false, key);
  if (body.organizationConfiguration)
    for (const key of ['instructions', 'history']) assert.equal(key in body.organizationConfiguration, false, key);
  for (const key of [
    'project',
    'projects',
    'teams',
    'workers',
    'taskKinds',
    'workflows',
    'autonomy',
    'adapters',
    'leases',
  ])
    assert.ok(key in body, key);
  const full = store.state('project-legacy', { mode: 'dashboard' }),
    compact = await read('/api/state?mode=dashboard');
  // Everything the shell holds is in the compact state, which also carries every record and the
  // instruction text twice; on a real project's history the shell is a few percent of it.
  assert.ok(JSON.stringify(body).length < JSON.stringify(compact.body).length);
  assert.deepEqual(body.taskKinds, compact.body.taskKinds);
  assert.deepEqual(body.autonomy, compact.body.autonomy);
  const instructions = await read('/api/projects/project-legacy/instructions');
  assert.equal(instructions.status, 200);
  assert.deepEqual(instructions.body.instructions, full.instructions);
  const list = await read('/api/projects');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { projects: body.projects }, 'A new tab chooses a project from the list alone.');
});

test('settled work reads for the board newest finished first, a page at a time, with its counts', async t => {
  const { read, store } = await records(t);
  store.insertAttempt(
    { id: 'attempt-late', taskId: 'T-accepted', status: 'accepted', finishedAt: '2026-10-23T00:00:00.000Z' },
    {},
  );
  const counts = await read('/api/projects/project-legacy/settled?kind=accepted&limit=0');
  assert.deepEqual(counts.body, { tasks: [], attempts: [], next: null, counts: { accepted: 4, closed: 2 } });
  // The latest finish orders the list; work with no finished attempt falls back to when it was created.
  const first = await read('/api/projects/project-legacy/settled?kind=accepted&limit=2');
  assert.deepEqual(
    first.body.tasks.map(item => item.id),
    ['T-accepted', 'T-r3'],
  );
  assert.equal(first.body.next, 'T-r3');
  assert.deepEqual(first.body.attempts.map(attempt => attempt.id).sort(), ['attempt-late', 'attempt-settled']);
  const second = await read('/api/projects/project-legacy/settled?kind=accepted&limit=2&before=T-r3');
  assert.deepEqual(
    second.body.tasks.map(item => item.id),
    ['T-r2-a', 'T-r1-done'],
  );
  assert.equal(second.body.next, null);
  const closed = await read('/api/projects/project-legacy/settled?kind=closed');
  assert.deepEqual(
    closed.body.tasks.map(item => item.id),
    ['T-r4', 'T-r2-b'],
  );
  assert.equal((await read('/api/projects/project-legacy/settled?kind=other')).status, 400);
  assert.equal((await read('/api/projects/project-legacy/settled?kind=accepted&limit=51')).status, 400);
  assert.equal((await read('/api/projects/project-legacy/settled?kind=accepted&before=T-gone')).status, 404);
});

test("an employee's or a team's page reads only its own settled work", async t => {
  const { read, store } = await records(t);
  store.putTask(task('T-build', 'done', null, { team: 'Build', workerId: 'W-02' }));
  const theirs = await read('/api/projects/project-legacy/settled?kind=accepted&workerId=W-02');
  assert.deepEqual(
    theirs.body.tasks.map(item => item.id),
    ['T-build'],
  );
  assert.deepEqual(theirs.body.counts, { accepted: 1, closed: 0 });
  const design = await read('/api/projects/project-legacy/settled?kind=accepted&team=Design');
  assert.ok(design.body.tasks.length > 0);
  assert.ok(design.body.tasks.every(item => item.team === 'Design'));
});

test('the organization pages read accepted work by employee and team, and the goal tasks, from the whole history', async t => {
  const { read, store } = await records(t);
  const { body } = await read('/api/projects/project-legacy/people'),
    shell = (await read('/api/projects/project-legacy/shell')).body,
    mine = store.tasks().filter(item => recordProject(item) === 'project-legacy'),
    done = mine.filter(item => item.status === 'done');
  assert.equal(body.tasks, mine.length);
  assert.equal(body.accepted.total, done.length);
  assert.equal(body.accepted.workers['W-01'], done.filter(item => item.workerId === 'W-01').length);
  assert.equal(body.accepted.teams.Design, done.filter(item => item.team === 'Design').length);
  assert.equal(JSON.stringify(body).includes('T-elsewhere'), false, 'Another project is not counted.');
  const goals = [...(shell.company?.goalTaskIds ?? []), ...shell.teams.flatMap(team => team.goalTaskIds ?? [])];
  assert.ok(goals.length, 'The fixture organization names goal tasks.');
  assert.deepEqual(
    Object.keys(body.goals).sort(),
    [...new Set(goals.filter(id => mine.some(item => item.id === id)))].sort(),
  );
  for (const goal of Object.values(body.goals))
    assert.deepEqual(Object.keys(goal).slice(0, 4), ['id', 'title', 'kind', 'status']);
});

test("the activity log reads a project's recorded events newest first, a page at a time, without agent output", async t => {
  const { read, store } = await records(t);
  store.event('note', 'T-open', null, 'A task of this project');
  store.event('log', 'T-open', 'attempt-live', 'An agent line');
  store.event('note', null, null, 'Tagged with another project', 'project-other');
  store.event('note', 'T-elsewhere', null, 'A task of another project');
  for (let index = 0; index < 55; index++)
    store.event('note', null, null, `Controller note ${index}`, 'project-legacy');
  const first = await read('/api/projects/project-legacy/activity');
  assert.equal(first.status, 200);
  assert.equal(first.body.events.length, 50);
  assert.equal(first.body.events[0].message, 'Controller note 54');
  assert.ok(first.body.events.every((event, index, all) => index === 0 || all[index - 1].seq > event.seq));
  const second = await read(`/api/projects/project-legacy/activity?before=${first.body.next}`),
    messages = [...first.body.events, ...second.body.events].map(event => event.message);
  assert.ok(messages.includes('A task of this project'));
  for (const hidden of ['An agent line', 'Tagged with another project', 'A task of another project'])
    assert.equal(messages.includes(hidden), false, hidden);
  assert.equal((await read('/api/projects/project-legacy/activity?before=soon')).status, 400);
});
