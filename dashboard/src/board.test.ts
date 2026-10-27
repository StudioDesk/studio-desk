// Where a task stands on the board and what its card says: stopped work stays where it stopped, a story past its
// build is in review until it is integrated, and closed work shows only when asked for.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { cardOf, columnOf, laneDetails, matches } from './board';
import type { RunStory, StudioState } from './studio-runs';

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
    workers: [{ id: 'W-1', displayName: 'Eli' }],
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
    outcome: { tone: 'busy', label: 'In progress', text: '' },
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
  // An idea whose checks run before any story is planned has no stories to count.
  const checks = story({ id: 'T-c', kind: 'studio-development:checks', status: 'running', lastAttemptId: 'a-c' }),
    checking: AttemptSummary = { ...attempts[1]!, id: 'a-c', taskId: 'T-c' };
  expect(laneDetails(idea([checks]), state([checks], [checking]))).toBe('');
});
