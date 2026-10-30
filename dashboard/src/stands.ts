// The facts line under the story page's "Where it stands" headline: a story's tests, its review and the attempts it
// used, read from its records in plain words, and what the decision row says while its review runs. Nothing here
// renders or sends anything.
import type { Task } from './api';
import { plural, testingPhases, totalsOf } from './evidence';
import { attemptsUsed, isSourceStory, phaseOf, storyPeople } from './story';
import { active, type StudioState } from './studio-runs';

export type TestsFact = 'passed' | 'failed' | 'running' | 'not-run';
export type ReviewFact = 'passed' | 'changes' | 'running' | 'not-yet';
export interface Facts {
  // A story's tests and review; other work has neither.
  tests?: TestsFact;
  review?: ReviewFact;
  used: number;
  // The attempts it may use; none for a task without a limit.
  allowed?: number;
}

const testsWords: Record<TestsFact, string> = {
  passed: 'Tests passed',
  failed: 'Tests failed',
  running: 'Tests running',
  'not-run': 'Tests not run yet',
};
const reviewWords: Record<ReviewFact, string> = {
  passed: 'Review passed',
  changes: 'Review asked for changes',
  running: 'Review running',
  'not-yet': 'Review not yet',
};

// "2 of 3 attempts used", as the attempt strip counts them; "2 attempts used" for a task without a limit.
export const attemptsWords = (used: number, allowed?: number) =>
  allowed === undefined ? `${used} ${plural(used, 'attempt')} used` : `${used} of ${allowed} attempts used`;

// "Tests passed · Review passed · 1 of 3 attempts used"; other work's line is its attempts alone.
export const factsLine = ({ tests, review, used, allowed }: Facts) =>
  [tests && testsWords[tests], review && reviewWords[review], attemptsWords(used, allowed)].filter(Boolean).join(' · ');

// The facts as the story's records hold them. The tests are the current candidate's or, while the story builds one,
// that build's: a story sent back has run none yet for its next candidate. The review is the current candidate's, so
// it is not yet one while a story builds. Attempts are counted as attemptsUsed counts them.
export function storyFacts(task: Task, studio: StudioState, phase: string | null = phaseOf(task, studio)): Facts {
  const { used } = attemptsUsed(
      task,
      studio.attempts.filter(attempt => attempt.taskId === task.id),
    ),
    counted = { used, allowed: task.maxAttempts };
  if (!isSourceStory(task)) return counted;
  const { stage, build, candidate } = storyPeople(task, studio),
    live = active(task),
    implementing = !stage.phase || stage.phase === 'implementing',
    // A story sent back still names its last candidate, which the next build replaces.
    built = implementing ? (build && build.id !== stage.candidate?.attemptId ? build : undefined) : candidate,
    totals = totalsOf(built),
    verdict = stage.review?.verdict;
  const tests: TestsFact =
    live && implementing && testingPhases.includes(phase ?? '')
      ? 'running'
      : totals?.tests
        ? totals.fail
          ? 'failed'
          : 'passed'
        : !implementing && candidate?.status === 'accepted' && candidate.result?.outcome === 'completed'
          ? 'passed'
          : 'not-run';
  const review: ReviewFact = implementing
    ? 'not-yet'
    : live && stage.phase === 'candidate-review'
      ? 'running'
      : verdict === 'pass'
        ? 'passed'
        : verdict === 'needs-work'
          ? 'changes'
          : 'not-yet';
  return { tests, review, ...counted };
}

// While a candidate that passed its tests is reviewed, the decision row says when its decisions come.
export const reviewWait = ({ tests, review }: Facts) =>
  tests === 'passed' && review === 'running' ? 'Integrate and Send back come when the review is done.' : null;
