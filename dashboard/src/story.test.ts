// The story page's reading of a task: the steps it has passed, where it stands, the house rules and the CLI an
// attempt ran on, from the records alone.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { attemptsUsed, cliName, houseRules, standing, storySteps } from './story';
import type { StudioState } from './studio-runs';

const studio = (tasks: Task[], attempts: AttemptSummary[], extra: Partial<StudioState> = {}) =>
  ({
    project: { id: 'project-x', name: 'Project X' },
    projects: [],
    workers: [
      { id: 'W-1', displayName: 'Eli', provider: 'claude', enabled: true },
      { id: 'W-2', displayName: 'Morgan', provider: 'codex', enabled: true },
    ],
    taskKinds: {
      'studio-development:change': {
        label: 'Source improvement',
        integrationLabel: 'Integrate after a passing review',
      },
      general: { label: 'General staged files', cardLabel: 'Files' },
    },
    adapters: { claude: { id: 'claude', name: 'Claude Code CLI' }, codex: { id: 'codex', name: 'Codex CLI' } },
    workflows: [],
    tasks,
    attempts,
    runs: [],
    ...extra,
  }) as unknown as StudioState;

const stage = (fields: object) => ({ version: 'source-story-stages-v1', history: [], ...fields });
const build = (fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id: 'attempt-build',
  taskId: 'T-1',
  projectId: 'project-x',
  workerId: 'W-1',
  status: 'accepted',
  provider: 'source-change',
  startedAt: '2026-10-22T18:40:00Z',
  finishedAt: '2026-10-22T18:53:00Z',
  executionTiming: { durationMs: 13 * 60000, activeStart: null },
  assignment: { kind: 'studio-development:change' },
  configuration: { mode: 'workspace', provider: 'claude' },
  testEvidence: { totals: { tests: 534, pass: 534, fail: 0 } },
  result: { outcome: 'completed', summary: 'Shows them.' },
  sourceCandidate: { sourceHash: 'candidate-hash' },
  artifacts: [{ path: 'source-change.json', kind: 'source-change', hash: 'manifest-hash' }],
  ...fields,
});
// The candidate as a story's stage pins it, and as its review received it.
const pin = {
  taskId: 'T-1',
  attemptId: 'attempt-build',
  workerId: 'W-1',
  path: 'source-change.json',
  hash: 'manifest-hash',
  candidateHash: 'candidate-hash',
};
const story = (fields: Partial<Task>): Task => ({
  id: 'T-1',
  title: 'Show the received files',
  kind: 'studio-development:change',
  status: 'running',
  workerId: 'W-1',
  approval: { status: 'approved' },
  maxSeconds: 1200,
  maxAttempts: 3,
  ...fields,
});
const labels = (task: Task, attempts: AttemptSummary[], phase: string | null = null) =>
  storySteps(task, studio([task], attempts), phase).map(step => `${step.label}:${step.state}`);

test('a story building, then testing, shows where its attempt is', () => {
  const task = story({ sourceStage: stage({ phase: 'implementing', current: 'implementing' }) }),
    running = build({ status: 'running', finishedAt: null, testEvidence: undefined });
  expect(labels(task, [running], 'source.edit')).toEqual([
    'Approved:done',
    'Building:live',
    'Test:todo',
    'Review:todo',
    'Integrate:todo',
  ]);
  expect(labels(task, [running], 'test').slice(1, 3)).toEqual(['Built:done', 'Testing:live']);
  const stand = standing(task, studio([task], [running]), 'test');
  expect(stand).toMatchObject({
    tone: 'live',
    title: 'Eli finished editing and the sandbox tests are running. Nothing needed from you.',
    workerId: 'W-1',
  });
});

test('a reviewed story waits for the director to integrate it, with the evidence in its steps', () => {
  const review: AttemptSummary = {
      id: 'attempt-review',
      taskId: 'T-1',
      projectId: 'project-x',
      workerId: 'W-2',
      status: 'accepted',
      finishedAt: '2026-10-22T18:55:00Z',
      assignment: { kind: 'studio-development:change-review' },
      candidateReviewVerdict: 'pass',
      candidateReview: { ...pin, passed: true },
      result: { outcome: 'completed', summary: 'Passes.' },
      inputReferences: [
        {
          taskId: 'T-1',
          attemptId: 'attempt-build',
          artifacts: [{ path: '../inputs/T-1/0-source-change.json', kind: 'source-change', hash: 'manifest-hash' }],
        },
      ],
      artifacts: [{ path: 'source-change-review.json', kind: 'source-change-review', hash: 'review-hash' }],
    },
    task = story({
      status: 'done',
      lastAttemptId: 'attempt-review',
      acceptedAttemptId: 'attempt-review',
      sourceStage: stage({
        phase: 'candidate-review',
        current: 'waiting-for-integration',
        candidate: pin,
        review: {
          taskId: 'T-1',
          attemptId: 'attempt-review',
          workerId: 'W-2',
          verdict: 'pass',
          path: 'source-change-review.json',
          hash: 'review-hash',
        },
      }),
    });
  expect(labels(task, [build(), review])).toEqual([
    'Approved:done',
    'Built · 13 min:done',
    'Tested · 534 of 534:done',
    'Reviewed by Morgan:done',
    'Integrate · your call:you',
  ]);
  expect(standing(task, studio([task], [build(), review]))).toMatchObject({
    tone: 'you',
    title: "Morgan passed it. It's ready to integrate.",
  });
});

test('a review that asked for changes is the director’s call, and a story sent back builds a new candidate', () => {
  const review: AttemptSummary = {
      id: 'attempt-review',
      taskId: 'T-1',
      workerId: 'W-2',
      status: 'accepted',
      assignment: { kind: 'studio-development:change-review' },
      candidateReviewVerdict: 'needs-work',
    },
    task = story({
      status: 'done',
      acceptedAttemptId: 'attempt-review',
      lastAttemptId: 'attempt-review',
      sourceStage: stage({
        phase: 'candidate-review',
        current: 'failed',
        candidate: { attemptId: 'attempt-build', workerId: 'W-1' },
        review: { attemptId: 'attempt-review', workerId: 'W-2', verdict: 'needs-work', hash: 'h' },
      }),
    });
  expect(labels(task, [build(), review]).slice(3)).toEqual(['Morgan asked for changes:you', 'Integrate:todo']);
  expect(standing(task, studio([task], [build(), review])).title).toBe('Morgan asked for changes.');
  // Sent back: the old candidate stays in the stage's record but no longer counts as built.
  const again = story({
    lastAttemptId: 'attempt-next',
    sourceStage: stage({
      phase: 'implementing',
      current: 'implementing',
      candidate: { attemptId: 'attempt-build', workerId: 'W-1' },
    }),
  });
  expect(
    labels(again, [build(), build({ id: 'attempt-next', status: 'running', testEvidence: undefined })], 'source.edit'),
  ).toEqual(['Approved:done', 'Building:live', 'Test:todo', 'Review:todo', 'Integrate:todo']);
});

test('other work runs Ready, Working, Review, Accepted', () => {
  const task: Task = { id: 'T-2', title: 'Write the notes', kind: 'general', status: 'review', workerId: 'W-2' },
    attempt: AttemptSummary = {
      id: 'attempt-2',
      taskId: 'T-2',
      status: 'review',
      workerId: 'W-2',
      executionTiming: { durationMs: 5 * 60000, activeStart: null },
    };
  expect(storySteps({ ...task, lastAttemptId: 'attempt-2' }, studio([task], [attempt])).map(s => s.label)).toEqual([
    'Done · 5 min',
    'Accept · your call',
  ]);
});

// The director found stories in Ready reading "Stopped", and their idea red, while the controller only held them
// for the story before them (October 24).
test('a story the controller holds until the story before it integrates is waiting, not stopped', () => {
  const reason = 'Waiting for T-0 (“First story”) to be integrated: source stories run one at a time.',
    held = story({
      status: 'blocked',
      reason,
      queued: true,
      controllerWait: true,
      sourceStage: stage({ phase: 'implementing', current: 'blocked', reason }),
    });
  expect(labels(held, [])).toEqual(['Approved:done', 'Build:todo', 'Test:todo', 'Review:todo', 'Integrate:todo']);
  // A block that is not the controller's own wait still reads as a stop.
  expect(labels({ ...held, controllerWait: false }, [])[1]).not.toBe('Build:todo');
  // Other work held by the controller after an attempt (a usage reset) waits too.
  const work: Task = { id: 'T-2', title: 'Write the notes', kind: 'general', status: 'blocked', lastAttemptId: 'a-2' };
  expect(storySteps({ ...work, controllerWait: true }, studio([work], []))[0]).toEqual({
    label: 'Work',
    state: 'todo',
  });
  expect(storySteps(work, studio([work], []))[0]).toEqual({ label: 'Stopped', state: 'bad' });
});

// Graph test 0a (October 25): other work its review sent back read "Stopped", and its review's attempt counted as
// one of the work's, so the panel said "2 of 2 used" while the controller allowed another.
test('other work its review sent back is the director’s call, and only its own work counts toward its attempts', () => {
  const sent: Task = {
      id: 'T-3',
      title: 'Write the guide',
      kind: 'general:work',
      status: 'blocked',
      workerId: 'W-1',
      maxAttempts: 2,
      lastAttemptId: 'a-review',
      reason: 'Independent review sent this back: The guide leaves out the map. Start it to run Work again.',
      stageState: {
        current: 'work',
        history: [
          { key: 'work', outcome: 'accepted' },
          { key: 'review', outcome: 'sent-back' },
        ],
      },
    },
    attempts: AttemptSummary[] = [
      { id: 'a-cut', taskId: 'T-3', status: 'interrupted', reconciledAt: '2026-10-25T18:11:30Z' },
      { id: 'a-work', taskId: 'T-3', status: 'accepted', assignment: { kind: 'general:work' } },
      {
        id: 'a-review',
        taskId: 'T-3',
        status: 'accepted',
        workerId: 'W-2',
        assignment: { kind: 'general:review' },
        workReviewVerdict: 'needs-work',
      },
    ];
  expect(storySteps(sent, studio([sent], attempts))[0]).toEqual({ label: 'Sent back', state: 'you' });
  expect(attemptsUsed(sent, attempts)).toEqual({ used: 1, allowed: 2, left: 1 });
  // A code story's own candidate reviews never counted, and still don't.
  expect(
    attemptsUsed(story({}), [build(), build({ id: 'r', assignment: { kind: 'studio-development:change-review' } })]),
  ).toEqual({ used: 1, allowed: 3, left: 2 });
});

test('the house rules say what the director approves and what is done for them', () => {
  const task = story({}),
    rules = (kinds: object, enabled = true) =>
      houseRules(task, studio([task], [], { autonomy: { policy: { enabled, kinds } } } as Partial<StudioState>));
  expect(rules({ 'studio-development:change': { approve: 'director', accept: 'auto', integrate: 'director' } })).toBe(
    'You approve stories and integration. Results with passing checks are accepted for you.',
  );
  expect(
    rules({ 'studio-development:change': { approve: 'director', accept: 'auto', integrate: 'auto', scope: 'auto' } }),
  ).toBe(
    "You approve stories. Results with passing checks are accepted for you. Changes with a passing review are integrated for you. An editor's request for more files is approved for you.",
  );
  expect(rules({}, false)).toBe('You approve stories, results and integration.');
});

test('an attempt names the CLI it ran on, even under a wrapping adapter', () => {
  const state = studio([], []);
  expect(cliName(state, build())).toBe('Claude Code');
  expect(cliName(state, { id: 'a', taskId: 'T', status: 'accepted', provider: 'codex' })).toBe('Codex');
  // An older record of a code editor's attempt does not say which CLI ran it.
  expect(cliName(state, { id: 'a', taskId: 'T', status: 'accepted', provider: 'source-change' })).toBe('');
  expect(cliName(state, { id: 'a', taskId: 'T', status: 'accepted', provider: 'mock' })).toBe('Simulator, no model');
});
