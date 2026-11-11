import { expect, test } from 'vitest';
import type { Task } from './api';
import { reviewReturnable } from './decisions';

// A story accepted over its review, failed at that review with the given verdict and phase.
const story = (verdict: string, phase: string, current = 'failed') =>
  ({
    id: 'T-1',
    kind: 'studio-development:change',
    title: 'Story',
    status: 'done',
    acceptedAttemptId: 'review-1',
    sourceStage: { current, phase, review: { verdict, attemptId: 'review-1' } },
  }) as unknown as Task;

test('a story goes back over a review that asked for changes, or a passing review whose own checks failed', () => {
  expect(reviewReturnable(story('needs-work', 'candidate-review'))).toBe(true);
  // November 1, 2026: a visual check that captured an error page failed a passing review's stage.
  expect(reviewReturnable(story('pass', 'candidate-review'))).toBe(true);
  // A passing review waiting to merge goes back through Send back beside Integrate, not as requested changes.
  expect(reviewReturnable(story('pass', 'candidate-review', 'waiting-for-integration'))).toBe(false);
  expect(reviewReturnable(story('pass', 'integration'))).toBe(false);
});

// A refused integration over a review that asked for changes once moved the story to wait for integration with
// nothing to run it; it goes back, unless an integration of it is recorded or its own request waits for its turn.
test('a story a refused integration left waiting goes back over its review that asked for changes', () => {
  const stranded = story('needs-work', 'integration', 'waiting-for-integration'),
    studio = (attempt: Record<string, unknown> = {}, pendingIntegration: unknown = null) =>
      ({
        attempts: [{ id: 'review-1', taskId: 'T-1', status: 'accepted', ...attempt }],
        autonomy: { pendingIntegration },
      }) as unknown as Parameters<typeof reviewReturnable>[1];
  expect(reviewReturnable(stranded, studio())).toBe(true);
  expect(reviewReturnable(stranded)).toBe(true);
  // An integration over the review that is recorded, or its request waiting for its turn, keeps it.
  expect(reviewReturnable(stranded, studio({ sourceIntegration: { state: 'verifying' } }))).toBe(false);
  expect(reviewReturnable(stranded, studio({}, { taskId: 'T-1' }))).toBe(false);
  expect(reviewReturnable(stranded, studio({}, { taskId: 'T-2' }))).toBe(true);
  const integrating = {
    ...stranded,
    sourceStage: { ...stranded.sourceStage, integration: { attemptId: 'review-1', state: 'verifying' } },
  } as Task;
  expect(reviewReturnable(integrating, studio())).toBe(false);
  // A passing review waiting in the integration phase is not this case.
  expect(reviewReturnable(story('pass', 'integration', 'waiting-for-integration'), studio())).toBe(false);
});
