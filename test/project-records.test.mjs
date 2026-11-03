// What a project's pages read without its whole history (Decision MP-026, v1.0 item 19b): the shared shell,
// the live set and finished runs a page at a time, and the instruction texts. Every page read says the change
// sequence it reflects (page-read-limits).
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
  ...(run
    ? { workflowReference: { runId: run, key: id, id: 'flow', name: 'Fixture flow', version: 1, brief: briefOf(run) } }
    : {}),
  ...extra,
});
// A run from before run records reads its words from its tasks (src/core/graph.mjs legacyRuns).
const briefOf = run => `The ${run} idea.\nIts second line.`;

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
  // The prerequisite from a finished idea names that idea briefly; the open run tells its own tasks, the retry too.
  const prerequisite = body.tasks.find(item => item.id === 'T-r2-a');
  assert.deepEqual(body.ideas, [
    { id: 'run-a', brief: briefOf('run-a'), createdAt: prerequisite.createdAt, taskIds: ['T-r2-a'] },
  ]);
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

test('finished runs list by when they finished, newest first, each saying when; ones with nothing recorded follow', async t => {
  const { store, read } = await records(t);
  // run-a was sent first and finished last; run-b finished before it; run-c has nothing recorded on its tasks.
  store.event('accepted', 'T-r3', null, 'Accepted.', 'project-legacy', '2026-10-22T09:00:00.000Z');
  store.event('accepted', 'T-r2-b', null, 'Denied.', 'project-legacy', '2026-10-22T10:00:00.000Z');
  store.event('accepted', 'T-r2-a', null, 'Accepted.', 'project-legacy', '2026-10-22T11:00:00.000Z');
  const first = await read('/api/projects/project-legacy/runs?limit=2');
  assert.deepEqual(
    first.body.runs.map(item => [item.run.id, item.run.finishedAt]),
    [
      ['run-a', '2026-10-22T11:00:00.000Z'],
      ['run-b', '2026-10-22T09:00:00.000Z'],
    ],
  );
  assert.equal(first.body.next, 'run-b');
  const second = await read('/api/projects/project-legacy/runs?limit=2&before=run-b');
  assert.deepEqual(
    second.body.runs.map(item => item.run.id),
    ['run-c'],
  );
  assert.equal('finishedAt' in second.body.runs[0].run, false);
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
  assert.deepEqual(counts.body, {
    tasks: [],
    attempts: [],
    next: null,
    counts: { accepted: 4, closed: 2 },
    ideas: [],
    version: store.version,
  });
  // The latest finish orders the list; work with no finished attempt falls back to when it was created.
  const first = await read('/api/projects/project-legacy/settled?kind=accepted&limit=2');
  assert.deepEqual(
    first.body.tasks.map(item => item.id),
    ['T-accepted', 'T-r3'],
  );
  assert.equal(first.body.next, 'T-r3');
  assert.deepEqual(first.body.attempts.map(attempt => attempt.id).sort(), ['attempt-late', 'attempt-settled']);
  // Each idea the page's work belongs to is named briefly; work in no idea is in none.
  const createdAt = id => store.task(id).createdAt;
  assert.deepEqual(first.body.ideas, [
    { id: 'run-b', brief: briefOf('run-b'), createdAt: createdAt('T-r3'), taskIds: ['T-r3'] },
  ]);
  const second = await read('/api/projects/project-legacy/settled?kind=accepted&limit=2&before=T-r3');
  assert.deepEqual(
    second.body.tasks.map(item => item.id),
    ['T-r2-a', 'T-r1-done'],
  );
  assert.equal(second.body.next, null);
  // Newest idea first; an idea with open work is named too, and the board tells it from the live set.
  assert.deepEqual(second.body.ideas, [
    { id: 'run-a', brief: briefOf('run-a'), createdAt: createdAt('T-r2-a'), taskIds: ['T-r2-a'] },
    { id: 'run-open', brief: briefOf('run-open'), createdAt: createdAt('T-r1-done'), taskIds: ['T-r1-done'] },
  ]);
  const closed = await read('/api/projects/project-legacy/settled?kind=closed');
  assert.deepEqual(
    closed.body.tasks.map(item => item.id),
    ['T-r4', 'T-r2-b'],
  );
  assert.equal((await read('/api/projects/project-legacy/settled?kind=other')).status, 400);
  assert.equal((await read('/api/projects/project-legacy/settled?kind=accepted&limit=51')).status, 400);
  assert.equal((await read('/api/projects/project-legacy/settled?kind=accepted&before=T-gone')).status, 404);
});

test("a page of settled work names a retry's or a proposed story's idea, by the project's every task", async t => {
  const { read, store } = await records(t);
  for (const record of [
    task('T-r3-retry', 'done', null, { retryOf: 'T-r3', workerId: 'W-02' }), // joins its original's idea
    task('T-r3-proposed', 'done', null, { proposalReference: { taskId: 'T-r3' } }), // joins its proposer's
    task('T-loose', 'done'), // in no idea
  ])
    store.putTask(record);
  const { body } = await read('/api/projects/project-legacy/settled?kind=accepted&limit=4');
  assert.deepEqual(
    body.tasks.map(item => item.id),
    ['T-loose', 'T-r3-proposed', 'T-r3-retry', 'T-r3'],
  );
  assert.deepEqual(body.ideas, [
    {
      id: 'run-b',
      brief: briefOf('run-b'),
      createdAt: store.task('T-r3').createdAt,
      taskIds: ['T-r3-proposed', 'T-r3-retry', 'T-r3'],
    },
  ]);
  // An employee's page names the idea its retry joined, though the original is another's and not on the page.
  const theirs = await read('/api/projects/project-legacy/settled?kind=accepted&workerId=W-02');
  assert.deepEqual(
    theirs.body.tasks.map(item => item.id),
    ['T-r3-retry'],
  );
  assert.deepEqual(
    theirs.body.ideas.map(idea => [idea.id, idea.taskIds]),
    [['run-b', ['T-r3-retry']]],
  );
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

test('each page read of a project answers exactly what it did before a second project had work of its own', async t => {
  const { read, store } = await records(t);
  store.insertAttempt(
    { id: 'attempt-late', taskId: 'T-accepted', status: 'accepted', finishedAt: '2026-10-23T00:00:00.000Z' },
    {},
  );
  store.event('accepted', 'T-r3', null, 'Accepted.', 'project-legacy', '2026-10-22T09:00:00.000Z');
  store.event('note', 'T-open', null, 'A task of this project');
  for (let index = 0; index < 55; index++)
    store.event('note', null, null, `Controller note ${index}`, 'project-legacy');
  const project = 'project-legacy',
    // Each answer says the change sequence it reflects, which the second project's records move on.
    ok = async path => {
      const answer = await read(`/api/projects/${project}/${path}`);
      assert.equal(answer.status, 200, path);
      const { version, ...body } = answer.body;
      assert.equal(version, store.version, path);
      return body;
    };
  // Every read the project's pages make, with each next page read from its cursor.
  const reads = async () => {
    const runs = await ok('runs?limit=2'),
      accepted = await ok('settled?kind=accepted&limit=2'),
      activity = await ok('activity');
    assert.ok(runs.next && accepted.next && activity.next, 'Each list has a next page.');
    return {
      live: await ok('live'),
      runs,
      runsNext: await ok(`runs?limit=2&before=${runs.next}`),
      openRun: await ok('runs/run-open'),
      finishedRun: await ok('runs/run-a'),
      accepted,
      acceptedNext: await ok(`settled?kind=accepted&limit=2&before=${accepted.next}`),
      counts: await ok('settled?kind=accepted&limit=0'),
      closed: await ok('settled?kind=closed'),
      theirs: await ok('settled?kind=accepted&workerId=W-01'),
      team: await ok('settled?kind=accepted&team=Design'),
      people: await ok('people'),
      activity,
      activityNext: await ok(`activity?before=${activity.next}`),
    };
  };
  const before = await reads();
  // A second project with work in every state, by the same employee and team, whose attempts finished later and
  // whose events are newer than any of the first project's.
  const second = 'project-second',
    theirs = { projectId: second };
  store.putProject({ id: second, name: 'Second', goal: '', direction: '', revision: 1 });
  for (const record of [
    task('T-s-open', 'failed', null, theirs),
    task('T-s-done', 'done', 'run-s-open', theirs),
    task('T-s-working', 'running', 'run-s-open', theirs),
    task('T-s-a', 'done', 'run-s-finished', theirs),
    task('T-s-b', 'denied', 'run-s-finished', theirs),
    task('T-s-closed', 'done', 'run-s-closed', { ...theirs, closed: true }),
    task('T-s-waits', 'blocked', null, { ...theirs, dependencies: ['T-s-a'] }),
  ])
    store.putTask(record);
  for (const [id, taskId, status] of [
    ['attempt-s-live', 'T-s-working', 'running'],
    ['attempt-s-a', 'T-s-a', 'accepted'],
    ['attempt-s-done', 'T-s-done', 'accepted'],
    ['attempt-s-closed', 'T-s-closed', 'accepted'],
  ])
    store.insertAttempt({ id, taskId, projectId: second, status, finishedAt: '2026-10-30T00:00:00.000Z' }, {});
  store.event('accepted', 'T-s-a', null, 'Accepted.', second, '2026-10-30T00:00:00.000Z');
  store.event('log', 'T-s-working', 'attempt-s-live', 'An agent line of the second project');
  for (let index = 0; index < 5; index++) store.event('note', null, null, `Second project note ${index}`, second);
  assert.deepEqual(await reads(), before);
  // The second project reads its own work and none of the first project's.
  const live = (await read(`/api/projects/${second}/live`)).body;
  assert.deepEqual(live.tasks.map(item => item.id).sort(), [
    'T-s-a',
    'T-s-done',
    'T-s-open',
    'T-s-waits',
    'T-s-working',
  ]);
  assert.deepEqual(live.attempts.map(attempt => attempt.id).sort(), [
    'attempt-s-a',
    'attempt-s-done',
    'attempt-s-live',
  ]);
  assert.deepEqual((await read(`/api/projects/${second}/runs`)).body.runs.map(item => item.run.id).sort(), [
    'run-s-closed',
    'run-s-finished',
  ]);
  assert.deepEqual((await read(`/api/projects/${second}/settled?kind=accepted&limit=0`)).body.counts, {
    accepted: 2,
    closed: 2,
  });
  assert.equal((await read(`/api/projects/${second}/people`)).body.tasks, 7);
});

// A project of its own with 7 live tasks, in record order: a finished idea's two stories that live work waits on, an
// open idea's finished story, its open one and a retry that joins it, failed work and blocked work; and settled work
// that is not live.
function pagedProject(store) {
  const project = 'project-paged',
    own = { projectId: project };
  store.putProject({ id: project, name: 'Paged', goal: '', direction: '', revision: 1 });
  for (const record of [
    task('P-prerequisite', 'done', 'run-p-finished', own),
    task('P-run-done', 'done', 'run-p-open', own),
    task('P-failed', 'failed', null, own),
    task('P-run-working', 'running', 'run-p-open', own),
    task('P-prerequisite-2', 'done', 'run-p-finished', own),
    task('P-waits', 'blocked', null, { ...own, dependencies: ['P-prerequisite'] }),
    task('P-retry', 'review', null, { ...own, retryOf: 'P-run-done', dependencies: ['P-prerequisite-2'] }),
    task('P-settled', 'done', null, own),
    task('P-finished', 'done', 'run-p-finished', own),
  ])
    store.putTask(record);
  for (const [id, taskId, status] of [
    ['attempt-p-prerequisite', 'P-prerequisite', 'accepted'],
    ['attempt-p-working', 'P-run-working', 'running'],
    ['attempt-p-retry', 'P-retry', 'review'],
    ['attempt-p-settled', 'P-settled', 'accepted'],
  ])
    store.insertAttempt({ id, taskId, projectId: project, status }, {});
  return project;
}

test('the live set reads a page at a time whose next cursors chain and whose pages hold the whole set', async t => {
  const { read, store } = await records(t),
    project = pagedProject(store),
    path = query => `/api/projects/${project}/live${query}`;
  const whole = (await read(path(''))).body;
  assert.deepEqual(
    whole.tasks.map(item => item.id),
    ['P-prerequisite', 'P-run-done', 'P-failed', 'P-run-working', 'P-prerequisite-2', 'P-waits', 'P-retry'],
    'Without a limit, the first 200 live tasks: here all 7, in record order.',
  );
  assert.equal(whole.next, null);
  assert.deepEqual((await read(path('?limit=500'))).body, whole);
  // Pages of 3, 3 and 1, each cursor the last task of its page.
  const pages = [];
  let before = null;
  do {
    const answer = await read(path(`?limit=3${before ? `&before=${before}` : ''}`));
    assert.equal(answer.status, 200);
    pages.push(answer.body);
    before = answer.body.next;
    if (before !== null) assert.equal(before, answer.body.tasks.at(-1).id);
  } while (before !== null && pages.length < 5);
  assert.deepEqual(
    pages.map(page => page.tasks.length),
    [3, 3, 1],
  );
  assert.deepEqual(
    pages.map(page => page.next),
    ['P-failed', 'P-waits', null],
  );
  // Their union is the whole set: the same tasks in the same order, and the same attempts, runs and ideas.
  assert.deepEqual(
    pages.flatMap(page => page.tasks),
    whole.tasks,
  );
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  assert.deepEqual(pages.flatMap(page => page.attempts).sort(byId), [...whole.attempts].sort(byId));
  assert.deepEqual(whole.attempts.map(attempt => attempt.id).sort(), [
    'attempt-p-prerequisite',
    'attempt-p-retry',
    'attempt-p-working',
  ]);
  // Each page carries the open run its own tasks belong to, so here the open idea comes with every page.
  assert.deepEqual(
    pages.map(page => page.runs.map(run => run.id)),
    [['run-p-open'], ['run-p-open'], ['run-p-open']],
  );
  const runs = new Map(pages.flatMap(page => page.runs).map(run => [run.id, run]));
  assert.deepEqual([...runs.values()].sort(byId), [...whole.runs].sort(byId));
  // The finished idea is named on each page by that page's own tasks; together they are the whole set's.
  assert.deepEqual(
    pages.map(page => page.ideas.map(idea => [idea.id, idea.taskIds])),
    [[['run-p-finished', ['P-prerequisite']]], [['run-p-finished', ['P-prerequisite-2']]], []],
  );
  const ideas = new Map();
  for (const idea of pages.flatMap(page => page.ideas))
    ideas.set(
      idea.id,
      ideas.has(idea.id) ? { ...idea, taskIds: [...ideas.get(idea.id).taskIds, ...idea.taskIds] } : idea,
    );
  assert.deepEqual([...ideas.values()], whole.ideas);
  assert.deepEqual(whole.ideas, [
    {
      id: 'run-p-finished',
      brief: briefOf('run-p-finished'),
      createdAt: store.task('P-prerequisite').createdAt,
      taskIds: ['P-prerequisite', 'P-prerequisite-2'],
    },
  ]);
  // A cursor that left the live set, or never was in it, answers 404; a limit outside 1 to 500 is refused.
  store.putTask({ ...store.task('P-waits'), status: 'denied' });
  assert.equal((await read(path('?limit=3&before=P-waits'))).status, 404);
  assert.equal((await read(path('?limit=3&before=P-settled'))).status, 404);
  assert.equal((await read(path('?before=T-gone'))).status, 404);
  for (const limit of ['0', '501', '1000', 'x', '2.5', '-1'])
    assert.equal((await read(path(`?limit=${limit}`))).status, 400, limit);
  assert.equal((await read('/api/projects/project-missing/live')).status, 400);
});

test("every page read says the store's change sequence it reflects", async t => {
  const { read, store } = await records(t),
    project = pagedProject(store);
  store.event('note', 'P-failed', null, 'A task of this project');
  for (const path of [
    `/api/projects/${project}/live`,
    `/api/projects/${project}/live?limit=3`,
    `/api/projects/${project}/live?limit=3&before=P-failed`,
    `/api/projects/${project}/runs`,
    `/api/projects/${project}/runs/run-p-open`,
    `/api/projects/${project}/runs/run-p-finished`,
    `/api/projects/${project}/settled?kind=accepted`,
    `/api/projects/${project}/settled?kind=closed&limit=0`,
    `/api/projects/${project}/people`,
    `/api/projects/${project}/activity`,
    `/api/tasks/P-failed?projectId=${project}`,
  ]) {
    const at = store.version,
      { status, body } = await read(path);
    assert.equal(status, 200, path);
    assert.equal(store.version, at, `reading ${path} records nothing`);
    assert.equal(body.version, at, path);
  }
  // A write moves it on, and the next read says so.
  const earlier = store.version;
  store.putTask({ ...store.task('P-failed'), title: 'Renamed' });
  const { body } = await read(`/api/projects/${project}/live`);
  assert.ok(body.version > earlier);
  assert.equal(body.version, store.version);
  // The task page and the activity keep their own fields and cursors beside it.
  const page = (await read(`/api/tasks/P-failed?projectId=${project}`)).body;
  assert.deepEqual(Object.keys(page).sort(), ['actions', 'attempts', 'task', 'version']);
  assert.equal(page.task.id, 'P-failed');
  const activity = (await read(`/api/projects/${project}/activity`)).body;
  assert.deepEqual(Object.keys(activity).sort(), ['events', 'next', 'version']);
  assert.ok(activity.events.length > 0 && activity.events.every(event => Number.isInteger(event.seq)));
});
