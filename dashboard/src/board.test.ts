// Where a task stands on the board and what its card says: stopped work stays where it stopped, a story past its
// build is in review until it is integrated, and closed work shows only when asked for. An idea's checks and plan have
// no cards: the idea's own card tells its planning until the plan is official.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { cardOf, columnOf, found, ideaCards, laneDetails, matches, unshown } from './board';
import { standing } from './story';
import { explain, type RunStory, type StudioState } from './studio-runs';

const stage = (fields: object) => ({ version: 'source-story-stages-v1', history: [], ...fields });
const story = (fields: Partial<Task>): Task => ({
  id: 'T-1',
  title: 'A story',
  kind: 'studio-development:change',
  status: 'ready',
  workerId: 'W-1',
  approval: { status: 'approved' },
  maxSeconds: 1200,
  maxAttempts: 3,
  ...fields,
});
const state = (tasks: Task[], attempts: AttemptSummary[] = []) =>
  ({
    project: { id: 'project-x', name: 'Project X' },
    projects: [],
    workers: [
      { id: 'W-1', displayName: 'Eli' },
      { id: 'W-3', displayName: 'Avery' },
      { id: 'W-4', displayName: 'Mara' },
    ],
    taskKinds: {},
    workflows: [],
    tasks,
    attempts,
    runs: [],
  }) as unknown as StudioState;
// An idea as the live set tells it: its tasks in its graph, one after another.
const idea = (tasks: Task[]) =>
  ({
    id: 'run-1',
    name: 'Idea',
    title: 'An idea',
    brief: 'An idea.',
    directorInputs: [],
    graph: {
      revisions: 1,
      envelope: null,
      legacy: false,
      stages: tasks.map(task => [{ taskId: task.id, title: task.title, kind: task.kind, status: task.status }]),
    },
    startedAt: '2026-10-22T19:00:00Z',
    taskIds: tasks.map(task => task.id),
    steps: [],
    needsYou: [],
    outcome: { state: 'in-progress', tone: 'busy', label: 'In progress', text: '' },
  }) as unknown as RunStory;

test('each task stands in one of five columns, and stopped work where it stopped', () => {
  expect(columnOf(story({ status: 'backlog', approval: { status: 'pending' } }))).toBe('planned');
  expect(columnOf(story({ status: 'ready' }))).toBe('ready');
  // Blocked before it started: it waits with what is ready. Blocked or failed after: in progress.
  expect(columnOf(story({ status: 'blocked' }))).toBe('ready');
  expect(columnOf(story({ status: 'blocked', lastAttemptId: 'a-1' }))).toBe('progress');
  expect(columnOf(story({ status: 'failed' }))).toBe('progress');
  expect(columnOf(story({ status: 'running', sourceStage: stage({ phase: 'implementing' }) }))).toBe('progress');
  // Past its build a story is in review, until it is integrated.
  expect(columnOf(story({ status: 'running', sourceStage: stage({ phase: 'candidate-review' }) }))).toBe('review');
  expect(columnOf(story({ status: 'done', sourceStage: stage({ phase: 'integration', current: 'failed' }) }))).toBe(
    'review',
  );
  expect(columnOf(story({ status: 'done', sourceStage: stage({ phase: 'integration', current: 'integrated' }) }))).toBe(
    'done',
  );
  expect(columnOf({ ...story({ status: 'done' }), kind: 'general' })).toBe('done');
  expect(columnOf(story({ status: 'cancelled' }))).toBeNull();
  expect(columnOf(story({ status: 'cancelled' }), true)).toBe('done');
});

test('a running card shows its attempt and time; a waiting one what it waits for', () => {
  const now = Date.parse('2026-10-22T20:10:00Z'),
    running = story({ status: 'running', lastAttemptId: 'a-1', sourceStage: stage({ phase: 'implementing' }) }),
    attempt: AttemptSummary = {
      id: 'a-1',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      startedAt: '2026-10-22T20:04:00Z',
      assignment: { kind: 'studio-development:change' },
    };
  const card = cardOf(running, state([running], [attempt]), [], false, now)!;
  expect(card).toMatchObject({ column: 'progress', chip: { tone: 'live', label: 'Building' } });
  expect(card.running).toEqual({ share: 30, attempt: 1, used: '6 of 20 min' });
  expect(matches(card, 'working')).toBe(true);
  expect(matches(card, 'calls')).toBe(false);
  const first = story({ id: 'T-0', title: 'First story', status: 'running' }),
    waiting = story({ id: 'T-2', dependencies: ['T-0'], queued: true });
  const next = cardOf(waiting, state([first, waiting]), [])!;
  expect(next).toMatchObject({ column: 'ready', waits: 'Waits for “First story”' });
  expect(matches(next, 'waiting')).toBe(true);
});

test("a running card's minutes follow the time it is given, with nothing else changed", () => {
  const started = Date.parse('2026-10-22T20:04:00Z'),
    minute = 60000,
    running = story({ status: 'running', lastAttemptId: 'a-1', sourceStage: stage({ phase: 'implementing' }) }),
    attempt: AttemptSummary = {
      id: 'a-1',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      startedAt: new Date(started).toISOString(),
      assignment: { kind: 'studio-development:change' },
    },
    board = state([running], [attempt]);
  expect(cardOf(running, board, [], false, started + 6 * minute)!.running!.used).toBe('6 of 20 min');
  expect(cardOf(running, board, [], false, started + 7 * minute)!.running!.used).toBe('7 of 20 min');
});

test('work the controller holds after an attempt waits in grey; a stop is red', () => {
  const held = story({
    status: 'blocked',
    lastAttemptId: 'a-1',
    controllerWait: true,
    queued: true,
    reason: 'Waiting for the usage reset.',
  });
  expect(cardOf(held, state([held]), [])).toMatchObject({
    column: 'progress',
    chip: { tone: 'wait', label: 'Waiting' },
  });
  const stopped = { ...held, controllerWait: false };
  expect(cardOf(stopped, state([stopped]), [])).toMatchObject({ chip: { tone: 'bad' } });
});

// Review cards follow the shared rules' explanation: the director's color only for a call the rules give the
// director, grey with the controller's own words while it holds the work, and no chip otherwise.
test("a review the controller holds for a slot waits in grey with the controller's reason, and is no call", () => {
  // A built candidate the controller moved on to its review, queued for a free slot (src/connectors/source-changes.mjs).
  const built: AttemptSummary = {
      id: 'a-1',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: '2026-10-22T19:01:00Z',
      finishedAt: '2026-10-22T19:20:00Z',
      assignment: { kind: 'studio-development:change' },
    },
    held = story({
      status: 'ready',
      queued: true,
      controllerWait: true,
      reason: 'Waiting for a studio execution slot.',
      lastAttemptId: 'a-1',
      acceptedAttemptId: 'a-1',
      sourceStage: stage({
        phase: 'candidate-review',
        current: 'candidate-review',
        candidate: { taskId: 'T-1', attemptId: 'a-1' },
      }),
    }),
    board = state([held], [built]),
    explanation = explain(held, board);
  expect(explanation).toMatchObject({ kind: 'slot-wait', requiresDirector: false });
  const card = cardOf(held, board, [])!;
  expect(card).toMatchObject({ column: 'review', foot: 'Eli' });
  expect(card.chip).toEqual({ tone: 'wait', label: 'Waiting', title: explanation.reason });
  expect(JSON.stringify(card)).not.toContain('Accept?');
  expect(matches(card, 'calls')).toBe(false);
  expect(matches(card, 'waiting')).toBe(true);
});

test('a completed result the director accepts reads Accept? and is a call; one the controller accepts has no chip', () => {
  const work = story({ kind: 'general:work', status: 'review', lastAttemptId: 'a-1' }),
    attempt: AttemptSummary = {
      id: 'a-1',
      taskId: 'T-1',
      status: 'review',
      workerId: 'W-1',
      startedAt: '2026-10-22T19:01:00Z',
      finishedAt: '2026-10-22T19:20:00Z',
      result: { outcome: 'completed', summary: 'Done.' },
    },
    board = state([work], [attempt]);
  expect(explain(work, board)).toMatchObject({ kind: 'result-approval', requiresDirector: true });
  const yours = cardOf(work, board, [])!;
  expect(yours).toMatchObject({ column: 'review', chip: { tone: 'you', label: 'Accept?' } });
  expect(matches(yours, 'calls')).toBe(true);
  // With the house rules accepting results, the same result only waits for the controller, which is not queued: the
  // card has no chip, and its foot names who has it.
  const auto = {
    ...board,
    autonomy: { policy: { enabled: true, kinds: { 'general:work': { accept: 'auto' } } } },
  } as unknown as StudioState;
  expect(explain(work, auto)).toMatchObject({ kind: 'result-auto', requiresDirector: false });
  const theirs = cardOf(work, auto, [])!;
  expect(theirs.column).toBe('review');
  expect(theirs.chip).toBeUndefined();
  expect(theirs.foot).toBe('Eli');
  expect(matches(theirs, 'calls')).toBe(false);
});

test('a settled card keeps the finished idea the records name; work in no idea has none', () => {
  const integrated = stage({ phase: 'integration', current: 'integrated' }),
    old = story({ id: 'T-old', status: 'done', sourceStage: integrated }),
    loose = story({ id: 'T-loose', kind: 'general', status: 'done' }),
    going = story({ id: 'T-going', status: 'running', lastAttemptId: 'a-1' }),
    // A page of settled work names its ideas: a finished one, and the live one the live stories tell.
    board = {
      ...state([old, loose, going]),
      ideas: [
        { id: 'run-1', brief: 'An idea.', createdAt: '2026-10-22T19:00:00Z', taskIds: ['T-going'] },
        {
          id: 'run-old',
          brief: 'Keep finished stories in place',
          createdAt: '2026-10-20T12:00:00Z',
          taskIds: ['T-old'],
        },
      ],
    } as StudioState,
    stories = [idea([going])];
  // After the one live idea, so its hue differs from the live idea's.
  expect(cardOf(old, board, stories)!).toMatchObject({
    column: 'done',
    idea: { runId: 'run-old', text: '“Keep finished stories in place”', index: 1 },
  });
  expect(cardOf(going, board, stories)!.idea).toEqual({ runId: 'run-1', text: '“An idea.”', index: 0 });
  const none = cardOf(loose, board, stories)!;
  expect(none.idea).toBeUndefined();
  expect(none.since).toMatch(/^Started /);
});

test("an idea lane's details count its stories done, running and waiting for the director", () => {
  const work = (fields: Partial<Task>) => story({ kind: 'general:work', ...fields }),
    accepted = work({ id: 'T-1', status: 'done', acceptedAttemptId: 'a-1', lastAttemptId: 'a-1' }),
    running = work({ id: 'T-2', status: 'running', lastAttemptId: 'a-2' }),
    ready = work({ id: 'T-3', status: 'ready', queued: true }),
    attempts: AttemptSummary[] = [
      { id: 'a-1', taskId: 'T-1', status: 'accepted', workerId: 'W-1', startedAt: '2026-10-22T19:01:00Z' },
      { id: 'a-2', taskId: 'T-2', status: 'running', workerId: 'W-1', startedAt: '2026-10-22T19:05:00Z' },
    ];
  const three = [accepted, running, ready];
  expect(laneDetails(idea(three), state(three, attempts))).toBe('1 of 3 done · 1 running');
  // A story that waits for the director's approval.
  const proposed = work({ id: 'T-4', status: 'backlog', approval: { status: 'pending' } }),
    two = [proposed, ready];
  expect(laneDetails(idea(two), state(two))).toBe('0 of 2 done · waits for you');
  // An idea whose checks run before any story is planned has no stories to count; its idea card tells its planning.
  const checks = story({ id: 'T-c', kind: 'studio-development:checks', status: 'running', lastAttemptId: 'a-c' }),
    plan = story({ id: 'T-p', kind: 'studio-development:breakdown', dependencies: ['T-c'], queued: true }),
    checking: AttemptSummary = { ...attempts[1]!, id: 'a-c', taskId: 'T-c' },
    planning = [checks, plan];
  expect(laneDetails(idea(planning), state(planning, [checking]))).toBe('');
  expect(ideaCards(state(planning, [checking]), [idea(planning)]).map(card => card.chip?.label)).toEqual(['Planning']);
});

// A code idea's checks, by Avery, and its plan after them, by Mara (planning.ts reads them), in an idea of two lines.
const at = (minute: number) => `2026-10-22T19:${String(minute).padStart(2, '0')}:00Z`;
const checks = (fields: Partial<Task> = {}) =>
  story({ id: 'T-checks', title: 'Check the source', kind: 'studio-development:checks', workerId: 'W-3', ...fields });
const plan = (fields: Partial<Task> = {}) =>
  story({
    id: 'T-plan',
    title: 'Plan the idea',
    kind: 'studio-development:breakdown',
    workerId: 'W-4',
    dependencies: ['T-checks'],
    ...fields,
  });
const step = (id: string, taskId: string, start: number, fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id,
  taskId,
  status: 'running',
  workerId: taskId === 'T-checks' ? 'W-3' : 'W-4',
  startedAt: at(start),
  ...fields,
});
const checked = step('a-checks', 'T-checks', 1, { status: 'accepted', finishedAt: at(3) }),
  passed = checks({ status: 'done', lastAttemptId: 'a-checks', acceptedAttemptId: 'a-checks' });
const planning = (tasks: Task[]) => ({ ...idea(tasks), brief: 'Show planning on the idea card\nIts second line.' });

test("an idea's checks and plan have no cards of their own in any column; a plan in no idea keeps its own", () => {
  const steps = [
    checks({ status: 'running', lastAttemptId: 'a-checks' }),
    checks({ status: 'failed', lastAttemptId: 'a-checks' }),
    passed,
    plan({ queued: true }),
    plan({ status: 'backlog', approval: { status: 'pending' } }),
    plan({ status: 'review', lastAttemptId: 'a-plan' }),
    plan({ status: 'done', lastAttemptId: 'a-plan', acceptedAttemptId: 'a-plan' }),
    plan({ kind: 'general:plan', status: 'done', lastAttemptId: 'a-plan', acceptedAttemptId: 'a-plan' }),
  ];
  // Each would stand in a column of its own, Done among them.
  expect(new Set(steps.map(task => columnOf(task)))).toEqual(
    new Set(['progress', 'done', 'ready', 'planned', 'review']),
  );
  for (const task of steps) {
    const records = state([task], [step('a-checks', 'T-checks', 1), step('a-plan', 'T-plan', 4)]);
    // A live idea's.
    expect(cardOf(task, records, [planning([task])])).toBeNull();
    // A finished idea's, which the records name, and with closed work shown.
    const named = {
      ...records,
      ideas: [{ id: 'run-old', brief: 'An older idea', createdAt: at(0), taskIds: [task.id] }],
    } as StudioState;
    expect(cardOf(task, named, [])).toBeNull();
    expect(cardOf(task, named, [], true)).toBeNull();
  }
  // A plan in no idea is the director's own work: it keeps its card.
  const loose = plan({ status: 'done', lastAttemptId: 'a-plan', acceptedAttemptId: 'a-plan' });
  expect(cardOf(loose, state([loose]), [])).toMatchObject({ column: 'done', eyebrow: 'Plan' });
});

test('while the checks run and the plan is queued, one idea card in Planned reads Planning with the planner and minutes', () => {
  const tasks = [checks({ status: 'running', lastAttemptId: 'a-checks' }), plan({ queued: true })],
    records = state(tasks, [step('a-checks', 'T-checks', 1)]),
    stories = [planning(tasks)],
    now = Date.parse(at(7));
  expect(tasks.map(task => cardOf(task, records, stories, false, now))).toEqual([null, null]);
  const cards = ideaCards(records, stories, now);
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  // Built on the step the idea is on, the checks, with the planner's name and the minutes since the checks started.
  expect(card).toMatchObject({
    task: tasks[0],
    column: 'planned',
    eyebrow: 'Idea',
    runId: 'run-1',
    title: 'Show planning on the idea card',
    chip: { tone: 'live', label: 'Planning' },
    idea: { runId: 'run-1', text: '“Show planning on the idea card…”', index: 0 },
    workerId: 'W-4',
    foot: 'Mara · 6 min',
    calls: false,
  });
  expect(card.text).toBeUndefined();
  expect(matches(card, 'working')).toBe(true);
  expect(matches(card, 'calls')).toBe(false);
  expect(matches(card, 'waiting')).toBe(false);
  // A search finds it by the idea's words, its second line too, and not by its step's title.
  expect(found(card, 'planning on the idea')).toBe(true);
  expect(found(card, 'second line')).toBe(true);
  expect(found(card, 'Check the source')).toBe(false);
  // Nothing started yet: Planning in grey, with no minutes, and waiting.
  const queued = [checks({ queued: true }), plan({ queued: true })],
    waiting = ideaCards(state(queued), [planning(queued)], now)[0]!;
  expect(waiting).toMatchObject({ chip: { tone: 'wait', label: 'Planning' }, foot: 'Mara' });
  expect(matches(waiting, 'waiting')).toBe(true);
  expect(matches(waiting, 'working')).toBe(false);
});

test("a plan's unanswered question makes the idea card read Waiting for you, its first line, and a call", () => {
  const question = {
      ask: 'Split the page part into two stories?\nTwo pages share it, so either way works.',
      why: 'Two pages share it.',
      options: [{ label: 'One story' }, { label: 'Two stories', detail: 'one a page' }],
      recommended: 1,
      choice: 'inside-story',
      topics: [] as string[],
    },
    asked = step('a-ask', 'T-plan', 4, { status: 'blocked', finishedAt: at(5), question }),
    tasks = [passed, plan({ status: 'blocked', lastAttemptId: 'a-ask' })],
    records = state(tasks, [checked, asked]);
  const card = ideaCards(records, [planning(tasks)], Date.parse(at(10)))[0]!;
  expect(card).toMatchObject({
    task: tasks[1],
    column: 'planned',
    eyebrow: 'Idea',
    chip: { tone: 'you', label: 'Waiting for you' },
    text: 'Split the page part into two stories?',
    workerId: 'W-4',
    foot: 'Mara',
    calls: true,
  });
  expect(matches(card, 'calls')).toBe(true);
  expect(matches(card, 'waiting')).toBe(false);
});

test("a failed plan makes the idea card read Stopped with the step's reason and what to do, never '<name> stopped'", () => {
  const failed = step('a-plan', 'T-plan', 4, { status: 'failed', finishedAt: at(7), error: 'The plan was not valid.' }),
    tasks = [passed, plan({ status: 'failed', lastAttemptId: 'a-plan' })],
    records = state(tasks, [checked, failed]),
    stand = standing(tasks[1]!, records);
  const card = ideaCards(records, [planning(tasks)], Date.parse(at(10)))[0]!;
  expect(card).toMatchObject({
    task: tasks[1],
    chip: { tone: 'bad', label: 'Stopped' },
    text: `${stand.title} ${stand.detail}`,
    foot: 'Mara',
    calls: false,
  });
  expect(card.text).toContain('then use Start assignment.');
  expect(card.text).not.toMatch(/Mara stopped|\w stopped:/);
  expect(matches(card, 'waiting')).toBe(true);
});

test('once the plan is official the idea has no idea card, its stories stand in Planned, and its steps have no Done cards', () => {
  const accepted = step('a-plan', 'T-plan', 4, { status: 'accepted', finishedAt: at(7) }),
    official = plan({
      status: 'done',
      lastAttemptId: 'a-plan',
      acceptedAttemptId: 'a-plan',
      proposedTaskIds: ['T-s1', 'T-s2'],
    }),
    proposed = ['T-s1', 'T-s2'].map(id =>
      story({ id, title: `Story ${id}`, status: 'backlog', approval: { status: 'pending' } }),
    ),
    tasks = [passed, official, ...proposed],
    records = state(tasks, [checked, accepted]);
  expect(ideaCards(records, [planning(tasks)])).toEqual([]);
  expect(cardOf(passed, records, [planning(tasks)])).toBeNull();
  expect(cardOf(official, records, [planning(tasks)])).toBeNull();
  expect(proposed.map(task => cardOf(task, records, [planning(tasks)]))).toMatchObject([
    { column: 'planned', eyebrow: 'Story 1', chip: { tone: 'you', label: 'Approve?' } },
    { column: 'planned', eyebrow: 'Story 2', chip: { tone: 'you', label: 'Approve?' } },
  ]);
  // Another live idea, still planning, has its card, with its own place among the live ideas for its hue.
  const others = [
      checks({ id: 'T-c2', status: 'running', lastAttemptId: 'a-c2' }),
      plan({ id: 'T-p2', dependencies: ['T-c2'], queued: true }),
    ],
    other = { ...idea(others), id: 'run-2', brief: 'Another idea' },
    all = state([...tasks, ...others], [checked, accepted, step('a-c2', 'T-c2', 2)]);
  expect(ideaCards(all, [planning(tasks), other])).toMatchObject([
    { runId: 'run-2', title: 'Another idea', idea: { runId: 'run-2', text: '“Another idea”', index: 1 } },
  ]);
});

test("Done counts none of the checks and plans the board has read of an idea's, accepted or closed", () => {
  const official = plan({ status: 'done', lastAttemptId: 'a-plan', acceptedAttemptId: 'a-plan' }),
    shut = [plan({ id: 'T-old', status: 'failed', closed: true }), plan({ id: 'T-no', status: 'denied' })],
    gone = checks({ id: 'T-gone', status: 'cancelled' }),
    // A finished idea's plan, which a page of settled work names.
    older = plan({ id: 'T-older', status: 'done', lastAttemptId: 'a-old', acceptedAttemptId: 'a-old' }),
    // Work the board draws: a story done, a plan in no idea, and a step still open.
    drawn = [
      story({ id: 'T-9', status: 'done' }),
      plan({ id: 'T-loose', status: 'done' }),
      plan({ id: 'T-next', queued: true }),
    ],
    live = [passed, official, ...shut, gone],
    records = {
      ...state([...live, older, ...drawn]),
      ideas: [{ id: 'run-old', brief: 'An older idea', createdAt: at(0), taskIds: ['T-older'] }],
    } as StudioState;
  expect(unshown(records, [planning(live)])).toEqual({ accepted: 3, closed: 3 });
  // Without the ideas, every one is drawn and counted.
  expect(unshown(state([...live, older, ...drawn]), [])).toEqual({ accepted: 0, closed: 0 });
});
