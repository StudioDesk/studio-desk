// A story's attempts used, as the controller counts them: an attempt a usage limit stopped, or one the controller's
// stop interrupted and the director reconciled (the recovery drill, v1.0 criterion 3), leaves the attempts it had.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { attemptsUsed, countsTowardLimit, integratesController } from './story';
import { attemptName } from './story-tabs';

const attempt = (id: string, extra: Partial<AttemptSummary>) =>
  ({
    id,
    taskId: 'T-1',
    status: 'failed',
    assignment: { kind: 'studio-development:change' },
    ...extra,
  }) as AttemptSummary;

test('only attempts that say something about the work use up a story’s attempts', () => {
  const task = { id: 'T-1', title: 'Story', maxAttempts: 2 } as Task,
    attempts = [
      attempt('a1', { status: 'interrupted', reconciledAt: '2026-10-24T09:06:00Z' }),
      attempt('a2', { status: 'blocked', subscriptionHold: 'claude' }),
      attempt('a3', { status: 'failed' }),
      attempt('r1', { status: 'accepted', assignment: { kind: 'studio-development:change-review' } }),
    ];
  expect(attemptsUsed(task, attempts)).toEqual({ used: 1, allowed: 2, left: 1 });
  // Not yet reconciled, an interruption still counts; the story cannot start until it is.
  expect(countsTowardLimit(attempt('a4', { status: 'interrupted' }))).toBe(true);
});

test('an attempt that used up none is named for what stopped it, so the next never reads past the limit', () => {
  const story = {
      id: 'T-1',
      title: 'Story',
      kind: 'studio-development:change',
      maxAttempts: 2,
      sourceStage: { version: 'source-story-stages-v1', current: 'implementing' },
    } as Task,
    attempts = [
      attempt('a1', { status: 'interrupted', reconciledAt: '2026-10-24T09:06:00Z' }),
      attempt('a2', { status: 'blocked', subscriptionHold: 'claude' }),
      attempt('a3', { status: 'failed' }),
      attempt('a4', { status: 'running' }),
      attempt('r1', { status: 'accepted', assignment: { kind: 'studio-development:change-review' } }),
    ];
  expect(attempts.map(item => attemptName(story, attempts, item))).toEqual([
    'Build, interrupted, not counted',
    'Build, stopped by a usage limit, not counted',
    'Build, attempt 1 of 2',
    'Build, attempt 2 of 2',
    'Review',
  ]);
  // Under the Attempts tab's Build heading and on Today's floor.
  expect(attemptName(story, attempts, attempts[0]!, true)).toBe('Interrupted, not counted');
  expect(attemptName(story, attempts, attempts[3]!, true)).toBe('Attempt 2 of 2');
  // Other work counts the same way.
  const work = { id: 'T-2', title: 'Work', kind: 'general', maxAttempts: 3 } as Task;
  expect(attemptName(work, attempts.slice(0, 3), attempts[2]!)).toBe('Attempt 1 of 3');
});

test('only integrating the controller’s own source pauses and restarts it, never a repository project’s', () => {
  const own = { autonomy: { selfHosted: true }, project: { id: 'project-studio-desk', name: 'Studio desk' } },
    repository = {
      autonomy: { selfHosted: true },
      project: {
        id: 'project-site',
        name: 'Site',
        source: { root: 'C:/site', profile: {} as never },
      },
    };
  expect(integratesController(own)).toBe(true);
  expect(integratesController(repository)).toBe(false);
  expect(integratesController({ ...own, autonomy: { selfHosted: false } })).toBe(false);
});
