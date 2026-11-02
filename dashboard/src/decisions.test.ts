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
