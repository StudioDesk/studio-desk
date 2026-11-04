// The facts line under "Where it stands": a story's tests, its review and the attempts it used, from its records
// alone, and what the decision row says while its review runs.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { attemptsWords, factsLine, reviewWait, storyFacts } from './stands';
import type { StudioState } from './studio-runs';

const studio = (attempts: AttemptSummary[]) =>
  ({
    project: { id: 'project-x', name: 'Project X' },
    projects: [],
    workers: [
      { id: 'W-1', displayName: 'Eli', provider: 'claude', enabled: true },
      { id: 'W-2', displayName: 'Morgan', provider: 'codex', enabled: true },
    ],
    taskKinds: {},
    adapters: {},
    workflows: [],
    tasks: [],
    attempts,
    runs: [],
  }) as unknown as StudioState;

const build = (fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id: 'attempt-build',
  taskId: 'T-1',
  workerId: 'W-1',
  status: 'accepted',
  assignment: { kind: 'studio-development:change' },
  testEvidence: { totals: { tests: 534, pass: 534, fail: 0 } },
  result: { outcome: 'completed', summary: 'Shows them.' },
  ...fields,
});
const review = (fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id: 'attempt-review',
  taskId: 'T-1',
  workerId: 'W-2',
  status: 'accepted',
  assignment: { kind: 'studio-development:change-review' },
  result: { outcome: 'completed' },
  ...fields,
});
const stage = (fields: object) => ({
  version: 'source-story-stages-v1',
  history: [],
  candidate: { taskId: 'T-1', attemptId: 'attempt-build', workerId: 'W-1' },
  ...fields,
});
const story = (fields: Partial<Task>): Task => ({
  id: 'T-1',
  title: 'Show the received files',
  kind: 'studio-development:change',
  status: 'done',
  workerId: 'W-1',
  maxSeconds: 1200,
  maxAttempts: 3,
  ...fields,
});
const line = (task: Task, attempts: AttemptSummary[], phase: string | null = null) =>
  factsLine(storyFacts(task, studio(attempts), phase));

test('the facts read as one line, and attempts are counted against the limit when there is one', () => {
  expect(factsLine({ tests: 'passed', review: 'passed', used: 1, allowed: 3 })).toBe(
    'Tests passed · Review passed · 1 of 3 attempts used',
  );
  expect(factsLine({ tests: 'failed', review: 'not-yet', used: 2, allowed: 3 })).toBe(
    'Tests failed · Review not yet · 2 of 3 attempts used',
  );
  expect(factsLine({ tests: 'running', review: 'not-yet', used: 1, allowed: 3 })).toBe(
    'Tests running · Review not yet · 1 of 3 attempts used',
  );
  expect(factsLine({ tests: 'passed', review: 'changes', used: 1, allowed: 3 })).toBe(
    'Tests passed · Review asked for changes · 1 of 3 attempts used',
  );
  expect(factsLine({ tests: 'passed', review: 'running', used: 1, allowed: 3 })).toBe(
    'Tests passed · Review running · 1 of 3 attempts used',
  );
  expect(factsLine({ tests: 'not-run', review: 'not-yet', used: 0, allowed: 3 })).toBe(
    'Tests not run yet · Review not yet · 0 of 3 attempts used',
  );
  // Other work has no tests or review of its own; a task without a limit counts what it used.
  expect(factsLine({ used: 2, allowed: 2 })).toBe('2 of 2 attempts used');
  expect(attemptsWords(1)).toBe('1 attempt used');
  expect(attemptsWords(2)).toBe('2 attempts used');
});

test("a story whose review passed reads its candidate's tests and the review, its review attempt not counted", () => {
  const passed = story({
    acceptedAttemptId: 'attempt-review',
    lastAttemptId: 'attempt-review',
    sourceStage: stage({
      phase: 'candidate-review',
      current: 'waiting-for-integration',
      review: { attemptId: 'attempt-review', workerId: 'W-2', verdict: 'pass' },
    }),
  });
  expect(line(passed, [build(), review({ candidateReviewVerdict: 'pass' })])).toBe(
    'Tests passed · Review passed · 1 of 3 attempts used',
  );
  // A candidate accepted with a completed result passed its tests, though older records hold no totals.
  expect(line(passed, [build({ testEvidence: undefined }), review()])).toBe(
    'Tests passed · Review passed · 1 of 3 attempts used',
  );
  // The review asked for changes.
  const changes = story({
    ...passed,
    sourceStage: stage({
      phase: 'candidate-review',
      current: 'failed',
      review: { attemptId: 'attempt-review', workerId: 'W-2', verdict: 'needs-work' },
    }),
  });
  expect(line(changes, [build(), review({ candidateReviewVerdict: 'needs-work' })])).toBe(
    'Tests passed · Review asked for changes · 1 of 3 attempts used',
  );
});

test('a build whose tests failed, one testing now and one not yet tested each say so', () => {
  const failed = story({
    status: 'failed',
    lastAttemptId: 'attempt-build',
    sourceStage: { version: 'source-story-stages-v1', history: [], phase: 'implementing', current: 'failed' },
  });
  expect(
    line(failed, [build({ status: 'failed', testEvidence: { totals: { tests: 752, pass: 751, fail: 1 } } })]),
  ).toBe('Tests failed · Review not yet · 1 of 3 attempts used');
  const running = { ...failed, status: 'running' },
    live = build({ status: 'running', testEvidence: undefined, result: undefined });
  expect(line(running, [live], 'test')).toBe('Tests running · Review not yet · 1 of 3 attempts used');
  expect(line(running, [live], 'source.edit')).toBe('Tests not run yet · Review not yet · 1 of 3 attempts used');
  // Approved and never started.
  expect(line(story({ status: 'ready', sourceStage: { version: 'source-story-stages-v1' } }), [])).toBe(
    'Tests not run yet · Review not yet · 0 of 3 attempts used',
  );
});

test('a story sent back reads neither its last candidate’s tests nor its review as the next one’s', () => {
  const sentBack = story({
    status: 'ready',
    lastAttemptId: 'attempt-review',
    sourceStage: stage({
      phase: 'implementing',
      current: 'implementing',
      review: { attemptId: 'attempt-review', workerId: 'W-2', verdict: 'needs-work' },
    }),
  });
  expect(line(sentBack, [build(), review({ candidateReviewVerdict: 'needs-work' })])).toBe(
    'Tests not run yet · Review not yet · 1 of 3 attempts used',
  );
});

test('while a candidate that passed its tests is reviewed, Integrate and Send back wait for the review', () => {
  const reviewing = story({
      status: 'running',
      acceptedAttemptId: 'attempt-build',
      lastAttemptId: 'attempt-review',
      sourceStage: stage({
        phase: 'candidate-review',
        current: 'candidate-review',
        review: { attemptId: 'attempt-review', workerId: 'W-2' },
      }),
    }),
    attempts = [build(), review({ status: 'running', result: undefined })],
    facts = storyFacts(reviewing, studio(attempts));
  expect(factsLine(facts)).toBe('Tests passed · Review running · 1 of 3 attempts used');
  expect(reviewWait(facts)).toBe('Integrate and Send back come when the review is done.');
  // Once it passed, the row offers them instead; a candidate whose tests failed has nothing to wait for.
  expect(reviewWait({ tests: 'passed', review: 'passed', used: 1, allowed: 3 })).toBeNull();
  expect(reviewWait({ tests: 'failed', review: 'running', used: 1, allowed: 3 })).toBeNull();
});

test("other work's line is the attempts it used, as attemptsUsed counts them", () => {
  const work = story({ kind: 'general', status: 'failed', lastAttemptId: 'attempt-2' }),
    attempts = [
      build({ id: 'attempt-1', assignment: { kind: 'general' }, status: 'failed' }),
      // An attempt a usage limit stopped uses up none.
      build({ id: 'attempt-2', assignment: { kind: 'general' }, status: 'blocked', subscriptionHold: 'claude' }),
    ];
  expect(storyFacts(work, studio(attempts))).toEqual({ used: 1, allowed: 3 });
  expect(line(work, attempts)).toBe('1 of 3 attempts used');
});

test('a flow story on its second round reads the count the controller served, not its earlier rounds', () => {
  const work = story({ kind: 'general', status: 'running', attemptCount: { used: 1, allowed: 3 } }),
    attempts = [
      build({ id: 'attempt-1', assignment: { kind: 'general' }, status: 'failed' }),
      build({ id: 'attempt-2', assignment: { kind: 'general' }, status: 'accepted' }),
      build({ id: 'attempt-3', assignment: { kind: 'general' }, status: 'running' }),
    ];
  expect(storyFacts(work, studio(attempts))).toEqual({ used: 1, allowed: 3 });
  expect(line(work, attempts)).toBe('1 of 3 attempts used');
  // Without a served count it is counted from the records, as before.
  expect(line(story({ kind: 'general', status: 'running' }), attempts)).toBe('3 of 3 attempts used');
});
