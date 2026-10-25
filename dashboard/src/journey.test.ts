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

test('who worked on the idea, what each did and for how long', () => {
  expect(whoWorked(run, state).map(person => `${person.name}: ${person.did}`)).toEqual([
    'Avery: checks',
    'Mara: plan',
    'Eli: stories 1 and 2',
    'Morgan: review of story 1',
  ]);
  expect(whoWorked(run, state).find(person => person.name === 'Eli')!.time).toMatch(/so far$/);
});
