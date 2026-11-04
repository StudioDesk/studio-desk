// The attempts row in words, from attempt records alone: each build's number and how it ended, a build your send-back
// started where the records say so, the review naming the build it reviewed or waiting for a newer one, the limit said
// once, and the latest four with the rest behind "N earlier".
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { attemptRow, chipText, limitLine, ordinal, sentBack, shownChips, shownName } from './attempt-row';

const passed = { totals: { tests: 752, pass: 752, fail: 0 } };
const build = (id: string, fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id,
  taskId: 'T-1',
  workerId: 'W-1',
  status: 'accepted',
  assignment: { kind: 'studio-development:change' },
  testEvidence: passed,
  result: { outcome: 'completed', summary: `${id} handed back.` },
  ...fields,
});
const failing = {
  status: 'failed',
  testEvidence: { totals: { tests: 752, pass: 750, fail: 2 } },
  failedTests: [{ name: 'the strip names it' }],
};
// A review of a build, which records the candidate it reviewed.
const review = (id: string, of: string, verdict = 'pass', fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id,
  taskId: 'T-1',
  workerId: 'W-2',
  status: 'accepted',
  assignment: { kind: 'studio-development:change-review' },
  candidateReview: { taskId: 'T-1', attemptId: of },
  candidateReviewVerdict: verdict,
  result: { outcome: 'completed', summary: `${id} reviewed ${of}.` },
  ...fields,
});
const pin = (attemptId: string) => ({ taskId: 'T-1', attemptId, workerId: 'W-1' });
const verdictOf = (attemptId: string, verdict = 'pass') => ({ attemptId, workerId: 'W-2', verdict });
const story = (fields: Partial<Task> = {}, stage: object = {}): Task => ({
  id: 'T-1',
  title: 'Name the attempts',
  kind: 'studio-development:change',
  status: 'done',
  workerId: 'W-1',
  maxAttempts: 2,
  ...fields,
  sourceStage: { version: 'source-story-stages-v1', phase: 'candidate-review', history: [], ...stage },
});
const texts = (task: Task, attempts: AttemptSummary[]) => {
  const row = attemptRow(task, attempts);
  return {
    builds: row.builds.map(chipText),
    review: row.review && chipText(row.review),
    waiting: row.waiting,
    limit: row.limit,
  };
};

// Tests failed, then a pass whose review passed, then the build the director's send-back started, which passed too.
const sentBackStory = () => ({
  task: story(
    { acceptedAttemptId: 'review-3', lastAttemptId: 'review-3' },
    {
      current: 'waiting-for-integration',
      candidate: pin('attempt-3'),
      review: verdictOf('review-3'),
      history: [{ candidate: pin('attempt-2'), review: verdictOf('review-2') }],
    },
  ),
  attempts: [
    build('attempt-1', failing),
    build('attempt-2', { acceptedBy: { type: 'policy' } }),
    review('review-2', 'attempt-2'),
    build('attempt-3'),
    review('review-3', 'attempt-3'),
  ],
});

test('each build reads its number and how it ended, one your send-back started says so, and the limit is said once in words', () => {
  const { task, attempts } = sentBackStory();
  expect(texts(task, attempts)).toEqual({
    builds: ['1 · Tests failed', '2 · Passed', '3 · You sent it back · passed'],
    review: 'Of 3 · passed',
    waiting: undefined,
    limit: 'The house rules allow 2 automatic attempts. You sent it back after the second, which started the third.',
  });
  expect(sentBack(task, attempts)).toEqual(new Map([['attempt-3', 'attempt-2']]));
  // Nothing in the row reads as an attempt of the limit.
  expect(JSON.stringify(texts(task, attempts))).not.toMatch(/Attempt \d+ of \d+|of 2/);
});

test("while a build newer than the one reviewed runs or waits for its review, the review step says it comes after it's built", () => {
  const stage = {
      phase: 'implementing',
      current: 'implementing',
      candidate: pin('attempt-2'),
      review: verdictOf('review-2'),
      history: [],
    },
    task = story({ status: 'running', lastAttemptId: 'attempt-3', maxAttempts: 3 }, stage),
    attempts = [
      build('attempt-1', failing),
      build('attempt-2'),
      review('review-2', 'attempt-2'),
      build('attempt-3', { status: 'running', testEvidence: undefined }),
    ];
  const row = texts(task, attempts);
  // While it runs it says only that; past the limit, the line under the row says your send-back started it.
  expect(row.builds).toEqual(['1 · Tests failed', '2 · Passed', '3 · Running now']);
  expect(row.review).toBeUndefined();
  expect(row.waiting).toBe("after it's built");
  expect(row.limit).toBe('The house rules allow 3 automatic attempts. All 3 are used.');
  expect(texts({ ...task, maxAttempts: 2 }, attempts).limit).toBe(
    'The house rules allow 2 automatic attempts. You sent it back after the second, which started the third.',
  );
  // The review of build 2 is still there to choose, behind "1 earlier".
  expect(shownChips(attemptRow(task, attempts), false, 'attempt-3')).toMatchObject({
    reviews: [],
    earlierReviews: 1,
  });
  // Built and accepted as the candidate whose review has not started, it still waits for its review.
  const waiting = [...attempts.slice(0, 3), build('attempt-3')],
    queued = story(
      { status: 'ready' },
      {
        phase: 'candidate-review',
        current: 'candidate-review',
        candidate: pin('attempt-3'),
        history: [{ candidate: pin('attempt-2'), review: verdictOf('review-2') }],
      },
    );
  expect(texts(queued, waiting).waiting).toBe("after it's built");
  // So does one you accepted as the candidate with its tests failing.
  const accepted = [...attempts.slice(0, 3), build('attempt-3', { ...failing, status: 'accepted' })];
  expect(texts(queued, accepted)).toMatchObject({ review: undefined, waiting: "after it's built" });
  // Once its review runs, the step names it.
  expect(texts(queued, [...waiting, review('review-3', 'attempt-3', '', { status: 'running' })]).review).toBe(
    'Of 3 · running',
  );
  // A newer build whose tests failed waits for no review, so the latest review still reads, naming its own build.
  expect(texts(task, [...attempts.slice(0, 3), build('attempt-3', failing)])).toMatchObject({
    review: 'Of 2 · passed',
    waiting: undefined,
  });
});

test('a story with no review yet shows the step waiting while its first build runs, and none once it stopped', () => {
  const task = story({ status: 'running', maxAttempts: 3 }, { phase: 'implementing' });
  expect(texts(task, [build('attempt-1', { status: 'running', testEvidence: undefined })])).toMatchObject({
    builds: ['1 · Running now'],
    review: undefined,
    waiting: "after it's built",
    limit: 'The house rules allow 3 automatic attempts. 1 is used and 2 are left.',
  });
  expect(texts(task, [build('attempt-1', failing)])).toMatchObject({ review: undefined, waiting: undefined });
});

test('attempts that used none of the limit read without a number, and the next one that counted keeps its number', () => {
  const task = story({ status: 'running', maxAttempts: 3 }, { phase: 'implementing' }),
    attempts = [
      build('attempt-1', failing),
      build('attempt-2', { status: 'blocked', question: { ask: 'Which name?' }, testEvidence: undefined }),
      build('attempt-3', { status: 'blocked', subscriptionHold: 'claude', testEvidence: undefined }),
      build('attempt-4', { status: 'interrupted', reconciledAt: '2026-10-28T10:25:00Z', testEvidence: undefined }),
      build('attempt-5', { status: 'running', testEvidence: undefined }),
    ];
  expect(texts(task, attempts).builds).toEqual([
    '1 · Tests failed',
    'Asked you a question',
    'Stopped: usage limit',
    'Interrupted',
    '2 · Running now',
  ]);
  expect(texts(task, attempts).limit).toBe('The house rules allow 3 automatic attempts. 2 are used and 1 is left.');
  // Not yet reconciled, an interruption counts, and says so after its number.
  expect(texts(task, [build('attempt-1', { status: 'interrupted', testEvidence: undefined })]).builds).toEqual([
    '1 · Interrupted',
  ]);
});

test('other endings keep words in the same style', () => {
  const task = story({ status: 'failed', maxAttempts: 9 }, { phase: 'implementing' }),
    ended = (fields: Partial<AttemptSummary>) =>
      texts(task, [build('attempt-1', { testEvidence: undefined, ...fields })]).builds[0];
  expect(ended({ status: 'cancelled' })).toBe('1 · Cancelled');
  expect(ended({ status: 'quarantined' })).toBe('1 · Quarantined');
  expect(ended({ status: 'uncertain' })).toBe('1 · Uncertain');
  expect(ended({ status: 'failed' })).toBe('1 · Failed');
  expect(ended({ status: 'blocked' })).toBe('1 · Stopped');
  expect(ended({ acceptedBy: { type: 'policy' } })).toBe('1 · Accepted by house rules');
  expect(ended({ acceptedBy: { type: 'director' } })).toBe('1 · Accepted');
});

test('where the records cannot tell who sent it back, the build after a review keeps its plain ending', () => {
  const after = (candidate: string, reviewed: AttemptSummary, stage: object = {}) => {
    const task = story(
      { status: 'review', maxAttempts: 3 },
      {
        current: 'review',
        candidate: pin('attempt-2'),
        review: verdictOf('review-2'),
        history: [
          {
            candidate: pin(candidate),
            review: verdictOf(reviewed.id, String(reviewed.candidateReviewVerdict)),
          },
        ],
        ...stage,
      },
    );
    return texts(task, [build('attempt-1'), reviewed, build('attempt-2'), review('review-2', 'attempt-2')]).builds;
  };
  // A review that asked for changes, which the house rules accepted: they may have retried it, or you sent it back.
  const asked = (by?: string) => review('review-1', 'attempt-1', 'needs-work', by ? { acceptedBy: { type: by } } : {});
  expect(after('attempt-1', asked())).toEqual(['1 · Passed', '2 · Passed']);
  expect(after('attempt-1', asked('policy'))).toEqual(['1 · Passed', '2 · Passed']);
  // One you accepted is never retried by the house rules, so the build after it is yours.
  expect(after('attempt-1', asked('director'))).toEqual(['1 · Passed', '2 · You sent it back · passed']);
  // A passing review with a failing check, which the house rules retry.
  const checked = review('review-1', 'attempt-1', 'pass', {
    result: { outcome: 'completed', checks: [{ name: 'Review shape', status: 'fail' }] } as AttemptSummary['result'],
  });
  expect(after('attempt-1', checked)).toEqual(['1 · Passed', '2 · Passed']);
  // A passing review whose integration stopped on a conflict, after which a merge onto the current source may follow.
  const conflicted = review('review-1', 'attempt-1', 'pass', {
    sourceIntegration: { state: 'rejected', verification: { conflicts: ['src/a.mjs'] } },
  });
  expect(after('attempt-1', conflicted)).toEqual(['1 · Passed', '2 · Passed']);
  expect(after('attempt-1', review('review-1', 'attempt-1'), { merge: { candidateAttemptId: 'attempt-1' } })).toEqual([
    '1 · Passed',
    '2 · Passed',
  ]);
  // A passing review whose integration stopped for another reason, which only you can send back.
  const stopped = review('review-1', 'attempt-1', 'pass', { sourceIntegration: { state: 'rejected' } });
  expect(after('attempt-1', stopped)).toEqual(['1 · Passed', '2 · You sent it back · passed']);
});

test('a review names the build it reviewed from its candidate or its inputs, and only its verdict when neither says', () => {
  const work = (id: string, fields: Partial<AttemptSummary> = {}) =>
      build(id, { assignment: { kind: 'general:work' }, testEvidence: undefined, ...fields }),
    task: Task = {
      id: 'T-1',
      title: 'Write the guide',
      kind: 'general:work',
      status: 'review',
      maxAttempts: 2,
      stageState: { version: 'stage-state-v1', current: 'review' },
    },
    look = (id: string, fields: Partial<AttemptSummary>) =>
      review(id, '', '', {
        assignment: { kind: 'general:review' },
        candidateReview: undefined,
        candidateReviewVerdict: undefined,
        workReviewVerdict: 'pass',
        ...fields,
      });
  const attempts = [
    work('attempt-w1'),
    look('attempt-r1', {
      workReviewVerdict: 'needs-work',
      inputReferences: [{ taskId: 'T-1', attemptId: 'attempt-w1' }],
    }),
    work('attempt-w2'),
    look('attempt-r2', { status: 'review', inputReferences: [{ taskId: 'T-1', attemptId: 'attempt-w2' }] }),
  ];
  const row = attemptRow(task, attempts);
  expect(row.builds.map(chipText)).toEqual(['1 · Accepted', '2 · Accepted']);
  expect(row.reviews.map(chipText)).toEqual(['Of 1 · asked for changes', 'Of 2 · waiting for you']);
  expect(row.review?.attempt.id).toBe('attempt-r2');
  expect(row.limit).toBe('The house rules allow 2 automatic attempts. Both are used.');
  // The line under the row names other work's attempts as attempts.
  expect(shownName(task, row.reviews[0]!)).toEqual({ name: 'Review of attempt 1', words: 'Asked for changes' });
  expect(shownName(task, row.builds[1]!)).toEqual({ name: 'Attempt 2', words: 'Accepted' });
  // A review whose record names no build reads its verdict alone.
  expect(chipText(attemptRow(task, [work('attempt-w1'), look('attempt-r1', {})]).review!)).toBe('Passed');
});

test('a long history shows its latest four builds and the review step, with the rest behind N earlier', () => {
  const task = story(
      { status: 'review', lastAttemptId: 'attempt-6', maxAttempts: 6 },
      { phase: 'implementing', current: 'review' },
    ),
    attempts = [1, 2, 3, 4, 5]
      .map(n => build(`attempt-${n}`, failing))
      .concat(build('attempt-6', { status: 'review' }));
  const row = attemptRow(task, attempts),
    closed = shownChips(row, false, 'attempt-6');
  expect(closed.builds.map(chipText)).toEqual([
    '3 · Tests failed',
    '4 · Tests failed',
    '5 · Tests failed',
    '6 · Passed',
  ]);
  expect(closed.earlierBuilds).toBe(2);
  expect(shownChips(row, true, 'attempt-6')).toMatchObject({ earlierBuilds: 0, earlierReviews: 0 });
  expect(shownChips(row, true, 'attempt-6').builds).toHaveLength(6);
  // An earlier attempt that is shown opens them, so its chip is there to be pressed.
  expect(shownChips(row, false, 'attempt-1').builds).toHaveLength(6);
  expect(row.limit).toBe('The house rules allow 6 automatic attempts. All 6 are used.');
});

test('the limit says what went past it when the records cannot say you sent it back, and counts in words', () => {
  const task = story({ status: 'running', maxAttempts: 1 }, { phase: 'implementing' }),
    row = attemptRow(task, [build('attempt-1', failing), build('attempt-2', failing), build('attempt-3')]);
  expect(limitLine(task, row.builds)).toBe(
    'The house rules allow 1 automatic attempt. The second and third went past that limit.',
  );
  expect(limitLine({ ...task, maxAttempts: 4 }, [])).toBe(
    'The house rules allow 4 automatic attempts. None is used yet.',
  );
  expect(limitLine({ ...task, maxAttempts: 1 }, row.builds.slice(0, 1))).toBe(
    'The house rules allow 1 automatic attempt. It is used.',
  );
  expect([1, 2, 10, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual([
    'first',
    'second',
    'tenth',
    '11th',
    '12th',
    '13th',
    '21st',
    '22nd',
    '23rd',
    '101st',
  ]);
});

// The row numbers its builds as the controller counts them (the served attemptCount): on a flow's second round the
// current build is the first of its limit, and the earlier round's builds read as that, without a number.
test('a flow story on its second round numbers its current build 1 of 3, as the controller served it', () => {
  const task = story(
      { status: 'running', maxAttempts: 3, attemptCount: { used: 1, allowed: 3 } },
      { phase: 'implementing' },
    ),
    attempts = [
      build('attempt-1', failing),
      build('attempt-2', failing),
      build('attempt-3', { status: 'running', testEvidence: undefined }),
    ],
    row = attemptRow(task, attempts);
  expect(texts(task, attempts)).toMatchObject({
    builds: ['Tests failed', 'Tests failed', '1 · Running now'],
    limit: 'The house rules allow 3 automatic attempts. 1 is used and 2 are left.',
  });
  expect(shownName(task, row.builds[0]!).name).toBe('Build, earlier round');
  expect(shownName(task, row.builds[2]!).name).toBe('Build 1');
  // A record without a served count reads as before.
  const before: Task = { ...task };
  delete before.attemptCount;
  expect(texts(before, attempts).limit).toBe('The house rules allow 3 automatic attempts. All 3 are used.');
});

test('an attempt the controller stopped reads without a number, and the next is the first of the served count', () => {
  const task = story(
      { status: 'running', maxAttempts: 2, attemptCount: { used: 1, allowed: 2 } },
      { phase: 'implementing' },
    ),
    attempts = [
      build('attempt-1', {
        status: 'cancelled',
        testEvidence: undefined,
        endCause: { cause: 'environment', detail: 'controller-stop' },
      }),
      build('attempt-2', { status: 'running', testEvidence: undefined }),
    ];
  expect(texts(task, attempts)).toMatchObject({
    builds: ['Cancelled', '1 · Running now'],
    limit: 'The house rules allow 2 automatic attempts. 1 is used and 1 is left.',
  });
});
