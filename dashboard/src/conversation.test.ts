// An idea's planning conversation from its records: the idea, the checks line, each plan attempt's message with its
// numbered cards, the director's replies between plans, questions with their answers in place, stopped attempts, and
// the cards that changed after a reply.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { conversation, markChanged, planArtifact, planCards, type ConversationEntry } from './conversation';
import type { RunStory, StudioState } from './studio-runs';
import { taskFixture } from './test-controller';

const at = (minute: number) => `2026-10-29T19:${String(minute).padStart(2, '0')}:00Z`;
const attempt = (id: string, taskId: string, start: number, end: number | null, fields = {}): AttemptSummary => ({
  id,
  taskId,
  status: end === null ? 'running' : 'review',
  workerId: 'W-4',
  startedAt: at(start),
  finishedAt: end === null ? null : at(end),
  ...fields,
});
const checksTask = (fields: Partial<Task> = {}) =>
  taskFixture('T-checks', { kind: 'studio-development:checks', status: 'done', workerId: 'W-3', ...fields });
const planTask = (fields: Partial<Task> = {}) =>
  taskFixture('T-plan', { kind: 'studio-development:breakdown', status: 'review', workerId: 'W-4', ...fields });
const measured = (pass: number, tests: number, fields = {}) =>
  attempt('a-checks', 'T-checks', 1, 3, {
    status: 'accepted',
    workerId: 'W-3',
    testEvidence: { totals: { tests, pass, fail: tests - pass } },
    ...fields,
  });

const files = [{ id: 'input-1', name: 'sketch.png', mediaType: 'image/png', byteLength: 2048 }];
const runOf = (tasks: Task[]) =>
  ({
    id: 'run-1',
    name: 'Idea',
    title: 'Idea',
    brief: 'Let me talk to the planner before anything starts.',
    directorInputs: files,
    graph: {
      revisions: 1,
      envelope: null,
      legacy: false,
      stages: tasks.map(item => [
        { taskId: item.id, title: item.title, kind: item.kind, status: item.status, worker: 'x' },
      ]),
    },
    startedAt: at(0),
    taskIds: tasks.map(item => item.id),
    steps: [],
    needsYou: [],
    outcome: { tone: 'busy', label: 'In progress', text: '' },
  }) as unknown as RunStory;
const stateOf = (tasks: Task[], attempts: AttemptSummary[]) =>
  ({
    project: { id: 'project-x', name: 'Project X' },
    projects: [],
    workers: [
      { id: 'W-1', displayName: 'Eli' },
      { id: 'W-3', displayName: 'Avery' },
      { id: 'W-4', displayName: 'Mara' },
    ],
    taskKinds: {},
    workflows: [],
    tasks,
    attempts,
    runs: [],
  }) as unknown as StudioState;
const read = (tasks: Task[], attempts: AttemptSummary[], texts: Record<string, string> = {}) =>
  conversation(runOf(tasks), stateOf(tasks, attempts), texts);

const story = (key: string, fields: object = {}) => ({
  key,
  kind: 'studio-development:change',
  role: 'engineer',
  title: `Title of ${key}`,
  scope: `What ${key} does.`,
  acceptance: `${key} is checked.`,
  complexity: 2,
  dependencies: [],
  files: [],
  newFiles: [`dashboard/src/${key}.ts`],
  deleteFiles: [],
  ...fields,
});
const breakdown = (stories: object[]) =>
  JSON.stringify({
    schemaVersion: 'source-breakdown-v1',
    source: { taskId: 'T-checks', attemptId: 'a-checks', path: 'check-report.json', hash: 'h' },
    summary: 'The plan.',
    stories,
  });
const firstPlan = breakdown([
  story('records', { workerId: 'W-1', role: undefined }),
  story('page', { dependencies: ['records'] }),
]);
const planned = (id: string, start: number, end: number, fields = {}) =>
  attempt(id, 'T-plan', start, end, {
    result: { summary: `Summary of ${id}.` },
    artifacts: [{ path: 'source-breakdown.json', hash: `h-${id}`, kind: 'source-breakdown' }],
    ...fields,
  });
const cardsOf = (entry?: ConversationEntry) => (entry?.type === 'planner' ? entry.cards : undefined);

test('an idea reads first, then the checks on the current code, then the planner with its numbered cards', () => {
  const tasks = [checksTask(), planTask()],
    entries = read(tasks, [measured(842, 842), planned('a-plan', 4, 7)], { 'a-plan': firstPlan });
  expect(entries.map(entry => entry.type)).toEqual(['idea', 'checks', 'planner']);
  expect(entries[0]).toEqual({
    type: 'idea',
    at: at(0),
    words: 'Let me talk to the planner before anything starts.',
    files,
  });
  expect(entries[1]).toMatchObject({
    type: 'checks',
    at: at(3),
    text: 'Checks ran on the current code: 842 tests passed.',
    taskId: 'T-checks',
  });
  expect(entries[2]).toMatchObject({
    type: 'planner',
    at: at(7),
    taskId: 'T-plan',
    attemptId: 'a-plan',
    workerId: 'W-4',
    name: 'Mara',
    summary: 'Summary of a-plan.',
  });
  expect(cardsOf(entries[2])!.map(card => [card.number, card.title, card.does, card.builder, card.buildsOn])).toEqual([
    [1, 'Title of records', 'What records does.', 'W-1', []],
    [2, 'Title of page', 'What page does.', 'engineer', [1]],
  ]);
});

test('checks with failures read how many passed, checks without totals say they ran, and no checks step reads none', () => {
  const checksLine = (attempts: AttemptSummary[], tasks = [checksTask(), planTask()]) =>
    read(tasks, attempts).find(entry => entry.type === 'checks');
  expect(checksLine([measured(840, 842)])).toMatchObject({
    text: 'Checks ran on the current code: 840 of 842 tests passed.',
  });
  expect(checksLine([measured(0, 0, { testEvidence: undefined })])).toMatchObject({
    text: 'Checks ran on the current code.',
  });
  // The accepted attempt counts over a later one that failed.
  expect(
    checksLine([
      measured(842, 842),
      attempt('a-checks-2', 'T-checks', 5, 6, { status: 'failed', testEvidence: { totals: { tests: 842, pass: 1 } } }),
    ]),
  ).toMatchObject({ attemptId: 'a-checks', text: 'Checks ran on the current code: 842 tests passed.' });
  // Checks still running have not run yet.
  expect(checksLine([attempt('a-checks', 'T-checks', 1, null)])).toBeUndefined();
  // A project without a checks step: the idea, then the plan.
  const general = [planTask({ kind: 'general:plan' })];
  expect(read(general, [planned('a-plan', 4, 7, { artifacts: [] })]).map(entry => entry.type)).toEqual([
    'idea',
    'planner',
  ]);
});

const secondPlan = breakdown([
  story('records', { workerId: 'W-1', role: undefined }),
  story('page', { dependencies: ['records'], scope: 'Show the conversation only.' }),
  story('reply', { dependencies: ['page'] }),
]);

test("the director's reply sits between the plans it separates, in the director's words", () => {
  const tasks = [checksTask(), planTask()],
    attempts = [
      measured(842, 842),
      planned('a-plan-1', 4, 7, {
        status: 'revision_requested',
        revisionRequestedBy: { type: 'director', at: at(9), reason: 'Split the second story' },
      }),
      planned('a-plan-2', 10, 14),
    ],
    entries = read(tasks, attempts, { 'a-plan-1': firstPlan, 'a-plan-2': secondPlan });
  expect(entries.map(entry => [entry.type, entry.at])).toEqual([
    ['idea', at(0)],
    ['checks', at(3)],
    ['planner', at(7)],
    ['director', at(9)],
    ['planner', at(14)],
  ]);
  expect(entries[3]).toEqual({
    type: 'director',
    at: at(9),
    taskId: 'T-plan',
    attemptId: 'a-plan-1',
    words: 'Split the second story',
  });
  expect(entries.map(entry => (entry.type === 'planner' ? entry.attemptId : ''))).toEqual([
    '',
    '',
    'a-plan-1',
    '',
    'a-plan-2',
  ]);
  // A retry the house rules asked for is not the director's reply.
  const byRules = read(tasks, [
    planned('a-plan-1', 4, 7, {
      status: 'revision_requested',
      revisionRequestedBy: { type: 'policy', at: at(9), reason: 'The plan failed validation.' },
    }),
    planned('a-plan-2', 10, 14),
  ]);
  expect(byRules.map(entry => entry.type)).toEqual(['idea', 'planner', 'planner']);
});

test('after a reply, a card whose scope changed and a card with a new key are changed; the first plan marks nothing', () => {
  const tasks = [planTask()],
    attempts = [
      planned('a-plan-1', 4, 7, {
        status: 'revision_requested',
        revisionRequestedBy: { type: 'director', at: at(9), reason: 'Split the second story' },
      }),
      planned('a-plan-2', 10, 14),
    ],
    plans = read(tasks, attempts, { 'a-plan-1': firstPlan, 'a-plan-2': secondPlan }).filter(
      entry => entry.type === 'planner',
    );
  expect(cardsOf(plans[0])!.map(card => [card.key, card.changed])).toEqual([
    ['records', false],
    ['page', false],
  ]);
  expect(cardsOf(plans[1])!.map(card => [card.key, card.number, card.changed, card.buildsOn])).toEqual([
    ['records', 1, false, []],
    ['page', 2, true, [1]],
    ['reply', 3, true, [2]],
  ]);
  // A plan whose file was not passed in has no cards, and the plan after it compares with the last readable one.
  const third = planned('a-plan-3', 15, 18);
  const later = read(tasks, [...attempts, third], { 'a-plan-1': firstPlan, 'a-plan-3': secondPlan }).filter(
    entry => entry.type === 'planner',
  );
  expect(later.map(entry => cardsOf(entry)?.map(card => card.changed) ?? null)).toEqual([
    [false, false],
    null,
    [false, true, true],
  ]);
});

test('a card changes with its acceptance, builder, dependencies or files, and not with its place alone', () => {
  const before = planCards(firstPlan)!,
    changedWith = (fields: object) =>
      markChanged(
        planCards(breakdown([story('records', { workerId: 'W-1', role: undefined }), story('page', fields)]))!,
        before,
      )[1]!.changed;
  expect(changedWith({ dependencies: ['records'] })).toBe(false);
  expect(changedWith({ dependencies: ['records'], acceptance: 'Something else.' })).toBe(true);
  expect(changedWith({ dependencies: ['records'], role: 'designer' })).toBe(true);
  expect(changedWith({ dependencies: [] })).toBe(true);
  expect(changedWith({ dependencies: ['records'], files: ['dashboard/src/app.tsx'] })).toBe(true);
  expect(changedWith({ dependencies: ['records'], newFiles: [] })).toBe(true);
  expect(changedWith({ dependencies: ['records'], deleteFiles: ['dashboard/src/old.ts'] })).toBe(true);
  expect(changedWith({ dependencies: ['records'], title: 'A new title' })).toBe(true);
  // Reordered cards keep their keys: neither changed, though their numbers did.
  const records = story('records', { workerId: 'W-1', role: undefined }),
    swapped = markChanged(
      planCards(breakdown([story('page'), records]))!,
      planCards(breakdown([records, story('page')])),
    );
  expect(swapped.map(card => [card.key, card.number, card.changed])).toEqual([
    ['page', 1, false],
    ['records', 2, false],
  ]);
  expect(markChanged(before, null).every(card => !card.changed)).toBe(true);
});

const question = {
  ask: 'Show the conversation above the stories or instead of them?',
  why: 'The page has room for one main part.',
  options: [{ label: 'Above them' }, { label: 'Instead of them', detail: 'until the plan is official' }],
  recommended: 1,
  choice: 'inside-story',
  topics: [],
};

test('a question reads in place with its options and recommendation, then its answers in order', () => {
  const auto = {
      attemptId: 'a-plan-1',
      option: 1,
      label: 'Instead of them',
      by: { type: 'auto-mode', at: at(8) },
      at: at(8),
    },
    changed = {
      attemptId: 'a-plan-1',
      option: 0,
      label: 'Above them',
      text: 'Keep the stories in view.',
      replaces: 'auto-mode',
      by: { type: 'director', at: at(16) },
      at: at(16),
    },
    tasks = [checksTask(), planTask({ status: 'ready', answers: [auto, changed] })],
    attempts = [
      measured(842, 842),
      attempt('a-plan-1', 'T-plan', 4, 7, { status: 'blocked', question }),
      planned('a-plan-2', 9, 14, {
        status: 'revision_requested',
        // Changing auto mode's answer also sends the plan back; that reads as the answer, not twice.
        revisionRequestedBy: {
          type: 'director',
          at: at(16),
          reason: "The director changed auto mode's answer to the question of a-plan-1: …",
        },
      }),
      attempt('a-plan-3', 'T-plan', 17, null),
    ],
    entries = read(tasks, attempts, { 'a-plan-2': firstPlan });
  expect(entries.map(entry => [entry.type, entry.at])).toEqual([
    ['idea', at(0)],
    ['checks', at(3)],
    ['question', at(7)],
    ['answer', at(8)],
    ['planner', at(14)],
    ['answer', at(16)],
  ]);
  expect(entries[2]).toEqual({
    type: 'question',
    at: at(7),
    taskId: 'T-plan',
    attemptId: 'a-plan-1',
    workerId: 'W-4',
    name: 'Mara',
    ask: question.ask,
    why: question.why,
    options: [{ label: 'Above them' }, { label: 'Instead of them', detail: 'until the plan is official' }],
    recommended: 1,
    waiting: false,
  });
  expect(entries[3]).toMatchObject({ by: 'auto-mode', name: 'Auto mode', words: 'Instead of them' });
  expect(entries[5]).toMatchObject({
    by: 'director',
    name: 'You',
    words: 'Above them — Keep the stories in view.',
    replaces: 'auto-mode',
    changeable: false,
  });
  // A question still waiting has no answer yet.
  const waiting = read(
    [planTask({ status: 'blocked', lastAttemptId: 'a-plan-1' })],
    [attempt('a-plan-1', 'T-plan', 4, 7, { status: 'blocked', question })],
  );
  expect(waiting.map(entry => entry.type)).toEqual(['idea', 'question']);
  expect(waiting[1]).toMatchObject({ waiting: true, recommended: 1 });
});

test('a failed plan attempt reads one line with its first error line and the plan step; a running one adds nothing', () => {
  const entries = read(
    [planTask({ status: 'running' })],
    [
      attempt('a-plan-1', 'T-plan', 4, 24, {
        status: 'failed',
        error: 'The attempt ran out of its 20 minutes.\nSecond line.',
      }),
      attempt('a-plan-2', 'T-plan', 25, 26, {
        status: 'interrupted',
        stopContext: { reason: 'The controller restarted' },
      }),
      attempt('a-plan-3', 'T-plan', 27, 28, { status: 'cancelled' }),
      attempt('a-plan-4', 'T-plan', 29, null),
    ],
  );
  expect(entries.map(entry => entry.type)).toEqual(['idea', 'stopped', 'stopped', 'stopped']);
  expect(entries[1]).toEqual({
    type: 'stopped',
    at: at(24),
    taskId: 'T-plan',
    attemptId: 'a-plan-1',
    workerId: 'W-4',
    status: 'failed',
    text: "Mara's plan attempt failed: The attempt ran out of its 20 minutes.",
    reason: 'The attempt ran out of its 20 minutes',
    next: 'Start the plan step again from its page.',
  });
  expect(entries[2]).toMatchObject({
    text: "Mara's plan attempt stopped: The controller restarted.",
    taskId: 'T-plan',
  });
  expect(entries[3]).toMatchObject({ text: "Mara's plan attempt stopped.", status: 'cancelled' });
  expect(entries[3]).not.toHaveProperty('reason');
  // A stopping attempt adds nothing either.
  expect(read([planTask()], [attempt('a-plan-1', 'T-plan', 4, null, { status: 'stopping' })]).length).toBe(1);
});

test('the parser reads a source breakdown and a graph proposal, and nothing else', () => {
  expect(planCards(firstPlan)).toEqual([
    {
      key: 'records',
      number: 1,
      title: 'Title of records',
      does: 'What records does.',
      acceptance: 'records is checked.',
      builder: 'W-1',
      builderIs: 'worker',
      dependencies: [],
      buildsOn: [],
      files: [],
      newFiles: ['dashboard/src/records.ts'],
      deleteFiles: [],
    },
    {
      key: 'page',
      number: 2,
      title: 'Title of page',
      does: 'What page does.',
      acceptance: 'page is checked.',
      builder: 'engineer',
      builderIs: 'role',
      dependencies: ['records'],
      buildsOn: [1],
      files: [],
      newFiles: ['dashboard/src/page.ts'],
      deleteFiles: [],
    },
  ]);
  const graph = JSON.stringify({
    schemaVersion: 'graph-proposal-v1',
    summary: 'Draft, then check.',
    tasks: [
      {
        key: 'draft',
        title: 'Draft the guide',
        kind: 'general:work',
        role: 'writer',
        brief: 'Write it.',
        dependencies: [],
      },
      {
        key: 'check',
        title: 'Check the guide',
        kind: 'general:review',
        workerId: 'W-3',
        brief: 'Read it.',
        acceptance: 'Findings listed.',
        dependencies: ['draft'],
      },
    ],
  });
  expect(planCards(graph)).toEqual([
    {
      key: 'draft',
      number: 1,
      title: 'Draft the guide',
      does: 'Write it.',
      acceptance: '',
      builder: 'writer',
      builderIs: 'role',
      dependencies: [],
      buildsOn: [],
    },
    {
      key: 'check',
      number: 2,
      title: 'Check the guide',
      does: 'Read it.',
      acceptance: 'Findings listed.',
      builder: 'W-3',
      builderIs: 'worker',
      dependencies: ['draft'],
      buildsOn: [1],
    },
  ]);
  for (const text of [
    'not json',
    '',
    'null',
    '[]',
    JSON.stringify({ schemaVersion: 'check-report-v1', stories: [story('records')] }),
    JSON.stringify({ schemaVersion: 'source-breakdown-v1', stories: [] }),
    JSON.stringify({ schemaVersion: 'source-breakdown-v1', tasks: [story('records')] }),
    JSON.stringify({ schemaVersion: 'graph-proposal-v1', tasks: [{ title: 'No key' }] }),
  ])
    expect(planCards(text), text).toBeNull();
});

test("a planning attempt's plan file is its source breakdown or graph proposal", () => {
  const withFiles = (artifacts: { path: string; hash: string; kind?: string }[]) =>
    planArtifact(attempt('a', 'T-plan', 1, 2, { artifacts }));
  expect(
    withFiles([
      { path: 'notes.md', hash: 'h1', kind: 'text' },
      { path: 'source-breakdown.json', hash: 'h2', kind: 'source-breakdown' },
    ]),
  ).toEqual({ path: 'source-breakdown.json', hash: 'h2', kind: 'source-breakdown' });
  expect(withFiles([{ path: 'plan.json', hash: 'h3', kind: 'graph-proposal' }])?.path).toBe('plan.json');
  expect(withFiles([{ path: 'notes.md', hash: 'h1', kind: 'text' }])).toBeNull();
  expect(planArtifact(attempt('a', 'T-plan', 1, 2))).toBeNull();
});

test("a plan card carries the story's summary in plain words when the plan gives one, and none otherwise", () => {
  const cards = planCards(
    breakdown([story('records', { summary: 'Keeps your records in one place.' }), story('page')]),
  )!;
  expect(cards[0]!.summary).toBe('Keeps your records in one place.');
  expect(cards[0]!.does).toBe('What records does.');
  expect(cards[1]!.summary).toBeUndefined();
});
