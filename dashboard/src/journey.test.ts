// An idea's journey from its records: the stages from Sent to Shipped, the stories in order, what happened in a
// few plain sentences with its stops and decisions marked, and who worked on it.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { firstSentence, happened, journeyStages, journeyStories, whoWorked } from './journey';
import type { RunStory, StudioState } from './studio-runs';

const at = (minute: number) => `2026-10-22T19:${String(minute).padStart(2, '0')}:00Z`;
const task = (id: string, kind: string, fields: Partial<Task> = {}): Task => ({
  id,
  title: `Title of ${id}`,
  kind,
  status: 'done',
  workerId: 'W-1',
  ...fields,
});
const attempt = (id: string, taskId: string, start: number, end: number | null, fields = {}): AttemptSummary => ({
  id,
  taskId,
  status: end === null ? 'running' : 'accepted',
  workerId: 'W-1',
  startedAt: at(start),
  finishedAt: end === null ? null : at(end),
  executionTiming: { durationMs: end === null ? null : (end - start) * 60000, activeStart: null },
  ...fields,
});
const stage = (fields: object) => ({ version: 'source-story-stages-v1', history: [], ...fields });

const checks = task('T-checks', 'studio-development:checks', { workerId: 'W-3' }),
  plan = task('T-plan', 'studio-development:breakdown', { workerId: 'W-4' }),
  first = task('T-1', 'studio-development:change', {
    approval: { status: 'approved', decidedAt: at(9), by: { type: 'director' } },
    sourceStage: stage({ phase: 'integration', current: 'integrated' }),
  }),
  second = task('T-2', 'studio-development:change', {
    status: 'running',
    dependencies: ['T-1'],
    lastAttemptId: 'a-2b',
    approval: { status: 'approved', decidedAt: at(9), by: { type: 'director' } },
    sourceStage: stage({ phase: 'implementing', current: 'implementing' }),
  });
const attempts: AttemptSummary[] = [
  attempt('a-checks', 'T-checks', 1, 3, {
    workerId: 'W-3',
    testEvidence: { totals: { tests: 539, pass: 539, fail: 0 } },
    artifacts: [{ path: 'check-report.json', kind: 'source-check-report', hash: 'h' }],
  }),
  attempt('a-plan', 'T-plan', 4, 7, { workerId: 'W-4', result: { summary: 'Two serial stories.' } }),
  attempt('a-1', 'T-1', 10, 20, {
    assignment: { kind: 'studio-development:change' },
    testEvidence: { totals: { tests: 539, pass: 539, fail: 0 } },
  }),
  attempt('a-1r', 'T-1', 21, 23, {
    workerId: 'W-2',
    assignment: { kind: 'studio-development:change-review' },
    candidateReviewVerdict: 'pass',
    candidateReviewNotes: ['A note.'],
    sourceIntegration: {
      state: 'integrated',
      finishedAt: at(25),
      approvedBy: { type: 'policy' },
      repository: { commit: 'b3f09ebc0ffee' },
    },
  }),
  attempt('a-2a', 'T-2', 26, 46, {
    status: 'failed',
    assignment: { kind: 'studio-development:change' },
    error: 'The attempt ran out of its 20 minutes.\nSecond line.',
    failedTests: [{ name: 'keeps the summary order', file: 'test/a.test.mjs' }],
  }),
  attempt('a-2b', 'T-2', 47, null, { assignment: { kind: 'studio-development:change' } }),
];
const run = {
  id: 'run-1',
  name: 'Idea',
  title: 'Title of T-1 (and 1 more)',
  brief: 'When an attempt stops, the next one starts over. It should keep going.\n\nMore detail.',
  directorInputs: [],
  graph: {
    revisions: 1,
    envelope: null,
    legacy: false,
    stages: [checks, plan, first, second].map(item => [
      { taskId: item.id, title: item.title, kind: item.kind, status: item.status, worker: 'x' },
    ]),
  },
  startedAt: at(0),
  taskIds: ['T-checks', 'T-plan', 'T-1', 'T-2'],
  steps: [],
  needsYou: [],
  outcome: { tone: 'busy', label: 'In progress', text: '' },
} as unknown as RunStory;
const state = {
  project: { id: 'project-x', name: 'Project X' },
  projects: [],
  workers: [
    { id: 'W-1', displayName: 'Eli' },
    { id: 'W-2', displayName: 'Morgan' },
    { id: 'W-3', displayName: 'Avery' },
    { id: 'W-4', displayName: 'Mara' },
  ],
  taskKinds: {},
  workflows: [],
  tasks: [checks, plan, first, second],
  attempts,
  runs: [],
} as unknown as StudioState;

test("an idea's title is its first sentence in the director's words", () => {
  expect(firstSentence(run.brief)).toBe('“When an attempt stops, the next one starts over.”');
  expect(firstSentence('No full stop here')).toBe('“No full stop here”');
});

test('the journey runs from Sent through the checks, the plan and the stories to Shipped', () => {
  expect(journeyStages(run, state).map(item => `${item.label}:${item.state}:${item.note}`)).toEqual([
    expect.stringMatching(/^Sent:done:You · /),
    'Checked:done:Avery · 539 of 539 passed',
    'Planned:done:Mara · 2 stories',
    'Building:live:1 of 2 integrated',
    'Shipped:todo:when story 2 integrates',
  ]);
});

test('each story says where it is: integrated with its commit, or the attempt running now', () => {
  const [one, two] = journeyStories(run, state);
  expect(one).toMatchObject({ number: 1, chip: { tone: 'ok', label: 'Integrated' }, commit: 'b3f09eb' });
  expect(two!.chip).toEqual({ tone: 'live', label: 'Building' });
  expect(two!.foot).toMatch(/^Attempt 2 of Eli's · \d+ min in$/);
  expect(two!.current).toBe(true);
});

test("the running story's minutes follow the page's clock, not the time of the call", () => {
  const started = Date.parse(at(47)),
    foot = (now: number) => journeyStories(run, state, now)[1]!.foot;
  expect(foot(started + 60000)).toBe("Attempt 2 of Eli's · 1 min in");
  expect(foot(started + 3 * 60000)).toBe("Attempt 2 of Eli's · 3 min in");
});

test('what happened is told in plain sentences, with its stops and decisions marked', () => {
  const groups = happened(run, state);
  expect(groups.map(group => group.title)).toEqual(['Checks and plan', 'Story 1', 'Story 2']);
  expect(groups[0]!.entries.map(entry => `${entry.lead} ${entry.text ?? ''}`.trim())).toEqual([
    'You sent the idea.',
    'Avery checked the source: 539 of 539 tests passed in 2 min.',
    'Mara planned it as 2 stories that run one after another, in 3 min.',
    'The 2 stories were approved.',
  ]);
  expect(groups[0]!.entries[3]!.decision).toBe(true);
  expect(groups[1]!.entries.map(entry => [entry.lead, entry.commit ?? '', entry.decision ?? false])).toEqual([
    ['Eli built it', '', false],
    ['Morgan passed the review', '', false],
    ['Integrated', 'b3f09eb', true],
  ]);
  const stopped = groups[2]!.entries.find(entry => entry.stop)!;
  expect(stopped).toMatchObject({
    lead: 'Attempt 1 stopped:',
    text: 'The attempt ran out of its 20 minutes.',
    failures: ['test/a.test.mjs: keeps the summary order'],
  });
  expect(groups[2]!.entries.map(entry => entry.lead)).toEqual([
    'Attempt 1 stopped:',
    'Attempt 2 started',
    'Eli is working on it now.',
  ]);
});

// Graph test 0a (October 25): a review of other work that asked for changes read "passed the review with no
// blocking findings", since only a code candidate's review verdict was read.
test("other work's review that asked for changes says so, with its finding, before the review that passed", () => {
  const work = task('T-w', 'general:work'),
    general = {
      ...run,
      taskIds: ['T-w'],
      graph: { ...run.graph, stages: [[{ taskId: 'T-w', title: work.title, kind: work.kind, status: 'done' }]] },
    } as RunStory,
    review = (id: string, start: number, fields: object) =>
      attempt(id, 'T-w', start, start + 1, { workerId: 'W-2', assignment: { kind: 'general:review' }, ...fields }),
    records = {
      ...state,
      tasks: [work],
      attempts: [
        attempt('a-w1', 'T-w', 1, 3, { assignment: { kind: 'general:work' } }),
        review('a-r1', 4, { workReviewVerdict: 'needs-work', workReviewFindings: ['The guide leaves out the map.'] }),
        attempt('a-w2', 'T-w', 6, 8, { assignment: { kind: 'general:work' } }),
        review('a-r2', 9, { workReviewVerdict: 'pass', workReviewFindings: [], workReviewNotes: ['A note.'] }),
      ],
    } as unknown as StudioState;
  const entries = happened(general, records)[1]!.entries.filter(entry => entry.lead.startsWith('Morgan'));
  expect(entries.map(entry => `${entry.lead} ${entry.text ?? ''}`.trim())).toEqual([
    'Morgan asked for changes: The guide leaves out the map.',
    'Morgan passed the review with no blocking findings and 1 note.',
  ]);
});

// An agent that stopped to ask the director (1.2 step 2) asked; it did not stop. Its question and each answer read
// in the director's color, with the recommended option marked and auto mode's answer marked while it may change.
const question = {
    ask: 'Split the page part into two stories?',
    why: 'Two pages share it.',
    options: [{ label: 'One story' }, { label: 'Two stories', detail: 'one a page' }],
    recommended: 1,
    choice: 'inside-story',
    topics: [],
  },
  byAuto = { type: 'auto-mode', at: at(6) },
  autoAnswer = { attemptId: 'a-ask', option: 1, label: 'Two stories', by: byAuto },
  directorAnswer = {
    attemptId: 'a-ask',
    option: 1,
    label: 'Two stories',
    text: 'Keep the shared part in the first.',
    by: { type: 'director', at: at(7) },
    at: at(7),
  },
  // The plan step asked at minute 5; then, once answered, it planned again.
  planAsked = (fields: Partial<Task>, later: AttemptSummary[] = []) =>
    ({
      ...state,
      tasks: [checks, { ...plan, ...fields }, first, second],
      attempts: [
        ...attempts.filter(item => item.taskId !== 'T-plan'),
        attempt('a-ask', 'T-plan', 4, 5, {
          workerId: 'W-4',
          status: 'blocked',
          error: 'Needs a call from the director.',
          question,
        }),
        ...later,
      ],
    }) as unknown as StudioState,
  planned = attempt('a-plan', 'T-plan', 8, 9, { workerId: 'W-4', result: { summary: 'Two serial stories.' } }),
  told = (records: StudioState, group = 0) =>
    happened(run, records)[group]!.entries.map(entry => `${entry.lead} ${entry.text ?? ''}`.trim());

test("a plan step's question reads as asked, with its options and the director's answer, not as a stop", () => {
  const records = planAsked({ answers: [directorAnswer] }, [planned]),
    entries = happened(run, records)[0]!.entries;
  expect(told(records)).toEqual([
    'You sent the idea.',
    'Avery checked the source: 539 of 539 tests passed in 2 min.',
    'Mara asked you: Split the page part into two stories?',
    'You answered: Two stories — Keep the shared part in the first.',
    'Mara planned it as 2 stories that run one after another, in 1 min.',
    'The 2 stories were approved.',
  ]);
  const asking = entries.find(entry => entry.question)!;
  expect(asking).toMatchObject({ at: at(5), icon: 'note', tone: 'you', decision: true, taskId: 'T-plan' });
  expect(asking.stop).toBeUndefined();
  expect(asking.question).toEqual({
    attemptId: 'a-ask',
    options: [
      { label: 'One story', recommended: false },
      { label: 'Two stories', detail: 'one a page', recommended: true },
    ],
    waiting: false,
  });
  expect(entries.find(entry => entry.answer)).toMatchObject({
    at: at(7),
    tone: 'you',
    decision: true,
    answer: { attemptId: 'a-ask', by: 'director', changeable: false },
  });
  expect(entries.filter(entry => `${entry.lead} ${entry.text}`.includes('stopped'))).toEqual([]);
});

test("auto mode's answer says so, and may be changed only while the work it started is open", () => {
  const answerOf = (fields: Partial<Task>) =>
    happened(run, planAsked(fields, [planned]))[0]!.entries.filter(entry => entry.answer);
  const running = answerOf({ status: 'running', answers: [autoAnswer] });
  expect(running.map(entry => `${entry.lead} ${entry.text}`)).toEqual(['Auto mode answered for you: Two stories']);
  // Auto mode's answer recorded no time of its own, so it reads at the time auto mode gave it.
  expect(running[0]).toMatchObject({ at: at(6), answer: { attemptId: 'a-ask', by: 'auto-mode', changeable: true } });
  expect(answerOf({ status: 'done', answers: [autoAnswer] })[0]!.answer!.changeable).toBe(false);
  expect(answerOf({ status: 'running', closed: true, answers: [autoAnswer] })[0]!.answer!.changeable).toBe(false);
  // The director's answer that replaced auto mode's says so; auto mode's can no longer be changed.
  const changed = answerOf({ status: 'running', answers: [autoAnswer, { ...directorAnswer, replaces: 'auto-mode' }] });
  expect(changed.map(entry => [entry.lead, entry.answer])).toEqual([
    ['Auto mode answered for you:', { attemptId: 'a-ask', by: 'auto-mode', changeable: false }],
    ["You changed auto mode's answer:", { attemptId: 'a-ask', by: 'director', changeable: false }],
  ]);
});

test('a question still waiting for the director says so, with no answer yet', () => {
  const records = planAsked({ status: 'blocked', lastAttemptId: 'a-ask' }),
    entries = happened(run, records)[0]!.entries;
  expect(told(records)).toContain('Mara asked you: Split the page part into two stories?');
  expect(entries.find(entry => entry.question)!.question!.waiting).toBe(true);
  expect(entries.filter(entry => entry.answer)).toEqual([]);
  expect(entries.filter(entry => entry.stop)).toEqual([]);
});

test("a story's build attempt that asked reads as its agent asking, in that story", () => {
  const records = {
    ...state,
    tasks: [checks, plan, first, { ...second, status: 'blocked' }],
    attempts: attempts.map(item =>
      item.id === 'a-2b' ? { ...item, status: 'blocked', finishedAt: at(48), question } : item,
    ),
  } as unknown as StudioState;
  const story = happened(run, records)[2]!;
  expect(story.entries.map(entry => entry.lead)).toEqual(['Attempt 1 stopped:', 'Attempt 2 started', 'Eli asked you:']);
  expect(story.entries.at(-1)).toMatchObject({
    at: at(48),
    tone: 'you',
    text: 'Split the page part into two stories?',
    taskId: 'T-2',
    question: { attemptId: 'a-2b', waiting: true },
  });
});

test('a failed attempt, and a blocked one without a readable question, still read as stops', () => {
  const blocked = (fields: object) => {
    const records = planAsked({ status: 'blocked', lastAttemptId: 'a-ask' });
    records.attempts = records.attempts.map(item => (item.id === 'a-ask' ? { ...item, ...fields } : item));
    return happened(run, records)[0]!.entries.find(entry => entry.taskId === 'T-plan')!;
  };
  for (const fields of [
    { question: undefined },
    { question: { problem: 'question.json must be readable JSON.' } },
    { status: 'failed' },
  ])
    expect(blocked(fields)).toMatchObject({
      lead: 'Mara stopped:',
      text: 'Needs a call from the director.',
      tone: 'bad',
      stop: true,
    });
  // A story's build attempt whose question could not be read stopped, as a failed one does.
  const records = {
    ...state,
    attempts: attempts.map(item =>
      item.id === 'a-2b'
        ? { ...item, status: 'blocked', finishedAt: at(48), error: 'Asks: nothing.', question: { problem: 'No ask.' } }
        : item,
    ),
  } as unknown as StudioState;
  const stops = happened(run, records)[2]!.entries.filter(entry => entry.stop);
  expect(stops.map(entry => `${entry.lead} ${entry.text}`)).toEqual([
    'Attempt 1 stopped: The attempt ran out of its 20 minutes.',
    'Attempt 2 stopped: Asks: nothing.',
  ]);
  expect(stops.every(entry => !entry.question)).toBe(true);
});

test('who worked on the idea, what each did and for how long', () => {
  expect(whoWorked(run, state).map(person => `${person.name}: ${person.did}`)).toEqual([
    'Avery: checks',
    'Mara: plan',
    'Eli: stories 1 and 2',
    'Morgan: review of story 1',
  ]);
  expect(whoWorked(run, state).find(person => person.name === 'Eli')!.time).toMatch(/so far$/);
});
