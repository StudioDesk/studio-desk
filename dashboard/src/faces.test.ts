// An agent's face tells what the records say: working while it runs an attempt, and on a piece of work its part
// in it (done when it passed, stuck when it stopped there).
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { agentState, attemptState } from './faces';
import type { StudioState } from './studio-runs';

const task = (id: string, status: string): Task => ({ id, title: id, kind: 'studio-development:change', status }),
  attempt = (id: string, taskId: string, workerId: string, status: string, extra: Partial<AttemptSummary> = {}) =>
    ({ id, taskId, workerId, status, startedAt: `2026-10-23T0${id.at(-1)}:00:00Z`, ...extra }) as AttemptSummary,
  studio = (tasks: Task[], attempts: AttemptSummary[]) => ({ tasks, attempts }) as unknown as StudioState;

test('an agent is working while it runs an attempt, and idle otherwise', () => {
  const records = studio([task('T-1', 'running')], [attempt('a1', 'T-1', 'W-1', 'running')]);
  expect(agentState(records, 'W-1')).toBe('working');
  expect(agentState(records, 'W-2')).toBe('idle');
  expect(agentState(records, undefined)).toBe('idle');
});

test('on a piece of work, a face shows its part: working there, stuck where it stopped, done when it passed', () => {
  const stopped = task('T-1', 'blocked'),
    done = task('T-2', 'done'),
    other = task('T-3', 'running'),
    records = studio(
      [stopped, done, other],
      [
        attempt('a1', 'T-1', 'W-1', 'blocked'),
        attempt('a2', 'T-2', 'W-1', 'failed'),
        attempt('a3', 'T-2', 'W-1', 'accepted'),
        attempt('a4', 'T-2', 'W-2', 'accepted', { candidateReviewVerdict: 'pass' }),
        attempt('a5', 'T-3', 'W-1', 'running'),
      ],
    );
  expect(agentState(records, 'W-1', stopped)).toBe('stuck');
  expect(agentState(records, 'W-1', done)).toBe('done');
  expect(agentState(records, 'W-1', other)).toBe('working');
  expect(agentState(records, 'W-2', done)).toBe('done');
  // Across an idea's stories, one stop makes the face stuck, and only all done makes it happy.
  expect(agentState(records, 'W-1', [stopped, done])).toBe('stuck');
});

test('a review did its part whatever it found; only a passing one is happy', () => {
  expect(attemptState(attempt('a1', 'T-1', 'W-2', 'accepted', { candidateReviewVerdict: 'needs-work' }))).toBe('idle');
  expect(attemptState(attempt('a1', 'T-1', 'W-2', 'accepted', { candidateReviewVerdict: 'pass' }))).toBe('done');
  expect(attemptState(attempt('a1', 'T-1', 'W-1', 'interrupted'))).toBe('stuck');
  // Other work's independent review too (graph test 0a, October 25).
  expect(attemptState(attempt('a1', 'T-1', 'W-2', 'accepted', { workReviewVerdict: 'needs-work' }))).toBe('idle');
  expect(attemptState(attempt('a1', 'T-1', 'W-2', 'accepted', { workReviewVerdict: 'pass' }))).toBe('done');
});
