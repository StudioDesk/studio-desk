// Where a task stands on the board and what its card says: stopped work stays where it stopped, a story past its
// build is in review until it is integrated, and closed work shows only when asked for.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { cardOf, columnOf, matches } from './board';
import type { StudioState } from './studio-runs';

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
