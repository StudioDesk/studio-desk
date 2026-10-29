// The story page's reading of a task: the steps it has passed, where it stands, the house rules and the CLI an
// attempt ran on, from the records alone.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { attemptsUsed, cliName, houseRules, standing, storySteps } from './story';
import { explain, type StudioState } from './studio-runs';

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

// The notice reads in a line or two, and its whole account is told in full under the story's Checks tab.
test('a stopped story says its tests did not pass and what to do, and keeps its whole account in full', () => {
  const failed = build({
      status: 'failed',
      controllerChecks: [
        { name: 'Candidate tests', status: 'fail', evidence: '751 of 752 tests passed.' },
        { name: 'Artifact paths', status: 'pass', evidence: 'Every path is approved.' },
      ],
      testEvidence: {
        totals: { tests: 752, pass: 751, fail: 1 },
        failedTests: [{ file: 'test/a.test.mjs', name: 'keeps the label' }, { name: 'names the file' }],
      },
      error: 'The candidate did not pass its tests.',
      result: {
        outcome: 'completed',
        summary: 'Shows them.',
        issues: ['I could not run the browser check.', 'The fixture has no second page.'],
      },
      sourceCandidate: undefined,
    }),
    task = story({
      status: 'failed',
      lastAttemptId: 'attempt-build',
      sourceStage: stage({ phase: 'implementing', current: 'failed' }),
    }),
    state = studio([task], [failed]),
    { reason, next } = explain(task, state),
    stand = standing(task, state),
    lines = [
      'Candidate tests: 751 of 752 tests passed.',
      'test/a.test.mjs: keeps the label',
      'names the file',
      'The candidate did not pass its tests.',
      'I could not run the browser check.',
      'The fixture has no second page.',
      next,
    ];
  expect(next).toBeTruthy();
  expect(stand.full).toEqual({ title: reason, lines });
  // The notice says in plain words what the measured tests found, then the one thing the director can do.
  expect(stand.title).toBe("The attempt's tests did not pass: 751 of 752.");
  expect(stand.detail).toBe(next);
  expect(stand.detail.match(/[.!?](\s|$)/g)).toHaveLength(1);
  for (const told of lines.slice(0, -1)) expect(stand.detail).not.toContain(told);
  expect(stand.detail).not.toMatch(/keeps the label|browser check|did not pass its tests/);
  expect(stand.shortened).toBe(true);
});

test('a long reason keeps its first sentence, and the whole of it is told in full', () => {
  const why =
      'The guide was replaced by the onboarding tour that landed in October, so this work is no longer needed. Its notes were moved to the tour story, its files were never integrated, and nothing else waits on it.',
    closed = story({ status: 'cancelled', closed: { reason: why } }),
    shut = standing(closed, studio([closed], []));
  expect(why.length).toBeGreaterThan(200);
  expect(shut).toMatchObject({
    title: 'Closed.',
    detail: 'The guide was replaced by the onboarding tour that landed in October, so this work is no longer needed.',
    shortened: true,
    full: { title: 'Closed.', lines: [why] },
  });
  // A controller's reason the notice titles with is cut the same way.
  const waiting =
      'Waiting for T-0 (“Show the received files on the story page with their sizes, hashes and the attempts that made them”) to be integrated. Source stories run one at a time, in the order their idea gave them.',
    held = story({
      status: 'blocked',
      reason: waiting,
      queued: true,
      controllerWait: true,
      sourceStage: stage({ phase: 'implementing', current: 'blocked', reason: waiting }),
    }),
    stand = standing(held, studio([held], []));
  expect(waiting.length).toBeGreaterThan(160);
  expect(stand.title).toBe(
    'Waiting for T-0 (“Show the received files on the story page with their sizes, hashes and the attempts that made them”) to be integrated.',
  );
  expect(stand.full.title).toBe(waiting);
  expect(stand.shortened).toBe(true);
});

test('a notice with one detail tells it as one line, and one without any has nothing more to tell', () => {
  const review: AttemptSummary = {
      id: 'attempt-review',
      taskId: 'T-1',
      projectId: 'project-x',
      workerId: 'W-2',
      status: 'accepted',
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
    }),
    ready = standing(task, studio([task], [build(), review]));
  expect(ready.chip).toBe('Ready to integrate');
  expect(ready.shortened).toBe(false);
  expect(ready.full).toEqual({
    title: "Morgan passed it. It's ready to integrate.",
    lines: [
      'Integrating merges it onto the current source in its own worktree, formats it, runs the full suite, then moves the branch forward. If any step fails, nothing changes.',
    ],
  });
  expect(ready.full.lines).toEqual([ready.detail]);
  // On a controller that develops itself, what integrating does and that the controller restarts stays whole.
  const restarts = standing(task, studio([task], [build(), review], { autonomy: { selfHosted: true } }));
  expect(restarts.detail.length).toBeGreaterThan(200);
  expect(restarts.detail).toMatch(/nothing changes\. The controller pauses new work.*then restarts\.$/);
  expect(restarts.shortened).toBe(false);
  // Work ready to queue is told as it was.
  const notes: Task = { id: 'T-2', title: 'Write the notes', kind: 'general', status: 'ready', workerId: 'W-2' },
    queue = standing(notes, studio([notes], []));
  expect(queue.title).toBe('This assignment is ready to be queued.');
  expect(queue.detail).toBe(queue.full.lines.join(' '));
  expect(queue.shortened).toBe(false);
  // Work moving has no detail, so nothing more to tell.
  const editing = story({ sourceStage: stage({ phase: 'implementing', current: 'implementing' }) }),
    running = build({ status: 'running', finishedAt: null, testEvidence: undefined });
  expect(standing(editing, studio([editing], [running]), 'source.edit').full).toEqual({
    title: 'Eli is editing. Nothing needed from you.',
    lines: [],
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
test('other work its review sent back is the director’s call until its rework is queued, and only its own work counts toward its attempts', () => {
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
  // The house rules queued the rework, and the controller holds it while its agent works on something else: the
  // step waits with the explanation, not in the director's colour.
  const queued: Task = {
    ...sent,
    queued: true,
    controllerWait: true,
    reason: "Waiting for Eli's work on T-4 (Draw the map) to finish.",
  };
  expect(storySteps(queued, studio([queued], attempts))[0]).toEqual({ label: 'Rework queued', state: 'todo' });
  expect(standing(queued, studio([queued], attempts)).tone).toBe('wait');
  // A code story's own candidate reviews never counted, and still don't.
  expect(
    attemptsUsed(story({}), [build(), build({ id: 'r', assignment: { kind: 'studio-development:change-review' } })]),
  ).toEqual({ used: 1, allowed: 3, left: 2 });
});

// An agent's question to the director (1.2 step 2), as the controller records it on the attempt that stopped to ask.
const question = {
    ask: 'Keep the old route for one release?',
    why: 'Two pages still call it.',
    options: [{ label: 'Keep it' }, { label: 'Remove it', detail: 'and update both pages' }],
    recommended: 1,
    choice: 'inside-story',
    topics: [],
  },
  asked = (fields: Partial<AttemptSummary> = {}) =>
    build({
      status: 'blocked',
      testEvidence: undefined,
      sourceCandidate: undefined,
      artifacts: [],
      result: { outcome: 'blocked', summary: 'I need a call on the old route.' },
      question,
      ...fields,
    }),
  askingStory = (fields: Partial<Task> = {}) =>
    story({
      status: 'blocked',
      lastAttemptId: 'attempt-build',
      sourceStage: stage({ phase: 'implementing', current: 'blocked' }),
      ...fields,
    });

test("an agent's waiting question is the director's step until it is answered", () => {
  expect(labels(askingStory(), [asked()])).toEqual([
    'Approved:done',
    'Build · asked you a question:you',
    'Test:todo',
    'Review:todo',
    'Integrate:todo',
  ]);
  // Answered, the work is ready again and continues from its saved work: nothing is the director's.
  const answered = askingStory({
    status: 'ready',
    queued: true,
    answers: [{ attemptId: 'attempt-build', option: 1, label: 'Remove it', by: { type: 'director' } }],
    sourceStage: stage({ phase: 'implementing', current: 'implementing' }),
  });
  expect(labels(answered, [asked()])).toEqual([
    'Approved:done',
    'Build:todo',
    'Test:todo',
    'Review:todo',
    'Integrate:todo',
  ]);
  // Other work's own step asks the same way.
  const work: Task = {
      id: 'T-2',
      title: 'Write the notes',
      kind: 'general',
      status: 'blocked',
      workerId: 'W-1',
      lastAttemptId: 'a-2',
    },
    asking: AttemptSummary = {
      id: 'a-2',
      taskId: 'T-2',
      status: 'blocked',
      workerId: 'W-1',
      result: { outcome: 'blocked', summary: 'Which notes?' },
      question,
    };
  expect(storySteps(work, studio([work], [asking]))).toEqual([
    { label: 'Asked you a question', state: 'you' },
    { label: 'Accept', state: 'todo' },
  ]);
  const ready = { ...work, status: 'ready', answers: [{ attemptId: 'a-2', text: 'The release notes.' }] };
  expect(storySteps(ready, studio([ready], [asking]))).toEqual([
    { label: 'Work', state: 'todo' },
    { label: 'Accept', state: 'todo' },
  ]);
});

test("a reviewer's waiting question is its review step's, not the build's", () => {
  const review = asked({
      id: 'attempt-review',
      workerId: 'W-2',
      assignment: { kind: 'studio-development:change-review' },
    }),
    task = askingStory({
      lastAttemptId: 'attempt-review',
      sourceStage: stage({ phase: 'candidate-review', current: 'blocked', candidate: pin }),
    });
  expect(labels(task, [build(), review])).toEqual([
    'Approved:done',
    'Built · 13 min:done',
    'Tested · 534 of 534:done',
    'Review · asked you a question:you',
    'Integrate:todo',
  ]);
  expect(standing(task, studio([task], [build(), review])).title).toBe('Morgan asked you a question.');
});

test("a waiting question is the director's call, worded with the agent's name and the ask", () => {
  const task = askingStory(),
    stand = standing(task, studio([task], [asked()]));
  expect(stand).toMatchObject({
    tone: 'you',
    chip: 'Asked you a question',
    title: 'Eli asked you a question.',
    detail: question.ask,
    shortened: false,
  });
  // The call is the director's, so the notice shows no agent's face; the card above it does.
  expect(stand.workerId).toBeUndefined();
  expect(stand.full).toEqual({ title: 'Eli asked you a question.', lines: [question.ask, question.why] });
  // Once answered, the notice no longer asks the director.
  const answered = askingStory({ status: 'ready', answers: [{ attemptId: 'attempt-build', option: 0 }] });
  expect(standing(answered, studio([answered], [asked()])).title).not.toMatch(/asked you a question/);
});

test("a question the work's own auto mode answers is neither the director's call nor a stop", () => {
  const task = askingStory({ autoMode: true }),
    state = studio([task], [asked()]);
  expect(explain(task, state).kind).toBe('question-auto');
  expect(labels(task, [asked()])[1]).toBe('Build:todo');
  expect(standing(task, state)).toMatchObject({ tone: 'wait', title: 'Eli asked a question that auto mode answers.' });
});

test("a question that could not be read stays the agent's stop, and its notice says why", () => {
  const problem = 'question.json must be readable JSON of at most 32 KiB.',
    unread = asked({ question: { problem } }),
    task = askingStory(),
    state = studio([task], [unread]),
    { kind, reason, next } = explain(task, state),
    stand = standing(task, state);
  expect(kind).toBe('blocked-result');
  expect(labels(task, [unread])[1]).toBe('Build · your call:you');
  expect(stand.title).toBe(reason);
  expect(stand.chip).toBeUndefined();
  expect(stand.detail).toContain(problem);
  expect(stand.detail).toBe(`The agent's question could not be read: ${problem} ${next}`);
  expect(stand.full.lines).toContain(`The agent's question could not be read: ${problem}`);
  // Another stop says only what to do, as before.
  const other = asked({ question: undefined }),
    plain = standing(task, studio([task], [other]));
  expect(plain.detail).toBe(explain(task, studio([task], [other])).next);
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
