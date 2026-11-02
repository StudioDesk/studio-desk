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

test('an attempt past the limit is named as the attempts row’s limit line says it, never "attempt 4 of 3"', () => {
  const story = {
      id: 'T-1',
      title: 'Story',
      kind: 'studio-development:change',
      maxAttempts: 3,
      sourceStage: { version: 'source-story-stages-v1', current: 'implementing' },
    } as Task,
    attempts = [
      attempt('a1', { status: 'failed' }),
      attempt('a2', { status: 'failed' }),
      // A usage limit's stop uses none, so the attempts after it keep their numbers.
      attempt('a3', { status: 'blocked', subscriptionHold: 'claude' }),
      attempt('a4', { status: 'revision_requested' }),
      attempt('a5', { status: 'running' }),
      attempt('r1', { status: 'accepted', assignment: { kind: 'studio-development:change-review' } }),
    ];
  expect(attempts.map(item => attemptName(story, attempts, item))).toEqual([
    'Build, attempt 1 of 3',
    'Build, attempt 2 of 3',
    'Build, stopped by a usage limit, not counted',
    'Build, attempt 3 of 3',
    'Build, fourth attempt, started by you past the limit of 3',
    'Review',
  ]);
  // Under the Attempts tab's Build heading and on Today's floor; within the limit it keeps its number.
  expect(attemptName(story, attempts, attempts[4]!, true)).toBe('Fourth attempt, started by you past the limit of 3');
  expect(attemptName(story, attempts, attempts[3]!, true)).toBe('Attempt 3 of 3');
  // Other work says it the same way, without "Build, ".
  const work = { id: 'T-2', title: 'Work', kind: 'general', maxAttempts: 3 } as Task,
    tries = attempts.slice(0, 5).map(item => ({ ...item, assignment: { kind: 'general' } }));
  expect(tries.map(item => attemptName(work, tries, item))).toEqual([
    'Attempt 1 of 3',
    'Attempt 2 of 3',
    'Stopped by a usage limit, not counted',
    'Attempt 3 of 3',
    'Fourth attempt, started by you past the limit of 3',
  ]);
  // Past the limit by more than one, each is named by its own number.
  const more = [...tries, attempt('a6', { status: 'running', assignment: { kind: 'general' } })];
  expect(attemptName(work, more, more[5]!, true)).toBe('Fifth attempt, started by you past the limit of 3');
  // With no limit recorded, nothing is past it.
  const open = { id: 'T-3', title: 'Open', kind: 'general' } as Task;
  expect(attemptName(open, tries, tries[4]!)).toBe('Attempt 4 of 4');
});

test('other work’s independent reviews are named as reviews, so its own attempts never read past its limit', () => {
  const work = {
      id: 'T-2',
      title: 'Guide',
      kind: 'general:work',
      status: 'review',
      maxAttempts: 2,
      stageState: { version: 'stage-state-v1', current: 'review' },
    } as Task,
    attempts = [
      attempt('w1', { status: 'accepted', assignment: { kind: 'general:work' } }),
      attempt('r1', { status: 'accepted', assignment: { kind: 'general:review' }, workReviewVerdict: 'needs-work' }),
      attempt('w2', { status: 'accepted', assignment: { kind: 'general:work' } }),
      attempt('r2', { status: 'running', assignment: { kind: 'general:review' } }),
    ];
  expect(attempts.map(item => attemptName(work, attempts, item))).toEqual([
    'Attempt 1 of 2',
    'Review 1',
    'Attempt 2 of 2',
    'Review 2',
  ]);
  // The work's attempts are the ones the side panel counts.
  expect(attemptsUsed(work, attempts)).toEqual({ used: 2, allowed: 2, left: 0 });
  // A first review is just the review, as on Today's floor while it runs.
  expect(attemptName(work, attempts.slice(0, 2), attempts[1]!, true)).toBe('Review');
  expect(attemptName(work, attempts.slice(0, 3), attempts[2]!, true)).toBe('Attempt 2 of 2');
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
