// An idea's planning conversation on its page: the idea in the director's bubble, the checks line, each plan as Story
// or Step cards with who builds, who reviews and what each builds on, the director's reply between plans with the
// cards it changed marked, a question in place with its answer, and a stopped attempt as one line. It is the page's
// main part while the idea is in planning and stays under Talk to <the planner> once the plan is official. The plans'
// texts are the stand-in's recorded files; the page only reads.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, RunRecord, Task, Worker } from './api';
import { App } from './app';
import type { Answer } from './questions';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

let controller: Controller;
const agent = (id: string, displayName: string, roles: string[]) =>
  ({ id, displayName, team: 'Engineering', enabled: true, roles }) as Worker;
beforeEach(() => {
  controller = fakeController();
  // Mara plans, Eli and Avery build and Morgan reviews, each by their staffing role.
  controller.shell.workers = [
    agent('W-1', 'Eli', ['engineer']),
    agent('W-2', 'Avery', ['designer']),
    agent('W-4', 'Mara', ['product-owner']),
    agent('W-5', 'Morgan', ['reviewer']),
  ];
  controller.shell.roles = [
    { id: 'product-owner', label: 'Product owner' },
    { id: 'engineer', label: 'Software engineer' },
    { id: 'designer', label: 'Designer' },
    { id: 'reviewer', label: 'Software reviewer' },
    { id: 'editor', label: 'Editor' },
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = (minute: number) => `2026-10-29T19:${String(minute).padStart(2, '0')}:00Z`;
const brief = 'Let me talk to the planner before anything starts.';
// The idea as the controller's run view sends it, with the file the director attached.
const idea = (tasks: Task[]): RunRecord => ({
  id: 'run-1',
  createdAt: at(0),
  brief,
  directorInputs: [
    {
      id: 'input-1',
      name: 'sketch.png',
      mediaType: 'image/png',
      byteLength: 2048,
      projectId: 'project-x',
      runId: 'run-1',
    },
  ],
  workflow: { id: 'workflow-1', name: 'Source checks and review', version: 3 },
  revisions: [{ revision: 1, at: at(0), reason: 'created' }],
  nodes: tasks.map(task => ({
    taskId: task.id,
    key: task.id,
    kind: task.kind,
    title: task.title,
    workerId: task.workerId,
    dependencies: task.dependencies ?? [],
    revision: 1,
  })),
  archive: { archived: false },
});
const open = (tasks: Task[]) => {
  controller.tasks = tasks;
  controller.runs = [idea(tasks)];
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/runs/run-1'] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
};
// Opens the idea again on fresh records, as the idea page's tests do.
const reopen = (tasks: () => Task[]) => {
  cleanup();
  controller.requests = [];
  controller.attempts = [];
  controller.artifacts = {};
  open(tasks());
};

// The checks step, accepted with all 842 of the current code's tests passing.
const checksStep = () => {
  controller.attempts.push({
    id: 'a-checks',
    taskId: 'T-checks',
    status: 'accepted',
    workerId: 'W-1',
    startedAt: at(1),
    finishedAt: at(3),
    testEvidence: { totals: { tests: 842, pass: 842, fail: 0 } },
  });
  return taskFixture('T-checks', {
    title: 'Check the source',
    kind: 'studio-development:checks',
    status: 'done',
    acceptedAttemptId: 'a-checks',
    lastAttemptId: 'a-checks',
    workflowReference: { runId: 'run-1', key: 'checks' },
  });
};
// Mara's plan step, a code project's breakdown unless it says otherwise.
const planStep = (status: string, extra: Partial<Task> = {}) =>
  taskFixture('T-plan', {
    title: 'Plan the idea',
    kind: 'studio-development:breakdown',
    status,
    workerId: 'W-4',
    workflowReference: { runId: 'run-1', key: 'plan' },
    ...extra,
  });
// A planning attempt that finished with its plan, recorded as `text` (none recorded: its file cannot be read).
const planAttempt = (id: string, start: number, end: number, text?: string, fields: Partial<AttemptSummary> = {}) => {
  const file = fields.artifacts?.[0] ?? { path: 'source-breakdown.json', hash: `h-${id}`, kind: 'source-breakdown' };
  if (text !== undefined) controller.artifacts[`${id}/${file.path}`] = text;
  controller.attempts.push({
    id,
    taskId: 'T-plan',
    status: 'review',
    workerId: 'W-4',
    startedAt: at(start),
    finishedAt: at(end),
    result: { summary: `Summary of ${id}.` },
    artifacts: [file],
    ...fields,
  });
};

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
// Avery builds the records; the page goes to the engineer role, which only Eli holds.
const firstPlan = breakdown([
    story('records', { workerId: 'W-2', role: undefined }),
    story('page', { dependencies: ['records'] }),
  ]),
  secondPlan = breakdown([
    story('records', { workerId: 'W-2', role: undefined }),
    story('page', { dependencies: ['records'], scope: 'Show the conversation only.' }),
    story('reply', { dependencies: ['page'] }),
  ]);

const talk = (name = 'Mara') => screen.findByRole('region', { name: `Talk to ${name}` }, { timeout: 5000 });
// The conversation's entries, in order, once the plan step's page is read.
const entries = async (region: HTMLElement) => [
  ...(await within(region).findByRole('list', { name: /^Your conversation with / }, { timeout: 5000 })).children,
];
// A plan's cards as the director reads them: their number, title, what they do, who builds and reviews them and
// what they build on, and whether they changed after the reply.
const cards = async (entry: Element, name = "Mara's stories") =>
  [...(await within(entry as HTMLElement).findByRole('list', { name })).children].map(card => ({
    number: card.querySelector('.sd-eyebrow')?.textContent,
    title: card.querySelector('.sd-storycard__title')?.textContent,
    does: card.querySelector('.sd-storycard__title')?.nextElementSibling?.textContent,
    foot: [...card.querySelectorAll('.sd-storycard__foot > .sd-meta')].map(line => line.textContent),
    changed: card.textContent?.includes('Changed after your reply'),
  }));
const posted = () => controller.requests.filter(request => request.method !== 'GET');
const follows = (first: Element, second: Element) =>
  !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

test("an idea in planning shows its words and file, the checks, then Mara's plan as story cards, under the journey", async () => {
  planAttempt('a-plan', 4, 7, firstPlan);
  open([checksStep(), planStep('review', { dependencies: ['T-checks'] })]);
  const region = await talk();
  // The page's main part: under the journey, before What happened.
  expect(follows(screen.getByRole('region', { name: 'Journey' }), region)).toBe(true);
  expect(follows(region, screen.getByRole('region', { name: 'What happened' }))).toBe(true);
  const [yours, checks, plan, ...rest] = await entries(region);
  expect(rest).toEqual([]);
  // The idea first, in the director's own bubble, with the file they attached.
  expect(yours!.getAttribute('aria-label')).toBe('Your idea');
  expect(yours!.querySelector('.sd-bubble--mine')?.textContent).toContain(brief);
  const file = within(yours as HTMLElement).getByRole('link', { name: 'sketch.png' });
  expect(file.getAttribute('href')).toBe('/api/projects/project-x/runs/run-1/inputs/input-1?projectId=project-x');
  expect(file.hasAttribute('download')).toBe(true);
  expect(yours!.textContent).toContain('image/png · 2.0 KiB');
  // The checks as one line from the app, not a bubble.
  expect(checks!.textContent).toBe('Checks ran on the current code: 842 tests passed.');
  expect(checks!.querySelector('.sd-bubble')).toBeNull();
  // Mara with her face, her summary and her two stories.
  expect(plan!.getAttribute('aria-label')).toBe("Mara's plan");
  expect(plan!.querySelector('svg.sd-avatar')).toBeTruthy();
  expect(plan!.querySelector('.sd-bubble__lead')?.textContent).toBe('Mara');
  expect(plan!.querySelector('.sd-bubble__words')?.textContent).toBe('Summary of a-plan.');
  expect(await cards(plan!)).toEqual([
    {
      number: 'Story 1',
      title: 'Title of records',
      does: 'What records does.',
      foot: ['Built by Avery · reviewed by Morgan'],
      changed: false,
    },
    {
      number: 'Story 2',
      title: 'Title of page',
      does: 'What page does.',
      foot: ['Built by Eli · reviewed by Morgan', 'Builds on 1'],
      changed: false,
    },
  ]);
  // The plan step's own page holds its attempts' files; the plan's file was read once.
  expect(controller.reads()).toContain('/api/tasks/T-plan?projectId=project-x');
  expect(controller.reads().filter(url => url.includes('/artifact?'))).toEqual([
    '/api/attempts/a-plan/artifact?projectId=project-x&path=source-breakdown.json',
  ]);
  expect(posted()).toEqual([]);
});

test("the director's reply sits between the two plans, and only the cards it changed are marked", async () => {
  planAttempt('a-plan-1', 4, 7, firstPlan, {
    status: 'revision_requested',
    revisionRequestedBy: { type: 'director', at: at(9), reason: 'Split the second story' },
  });
  planAttempt('a-plan-2', 10, 14, secondPlan);
  open([checksStep(), planStep('review', { dependencies: ['T-checks'] })]);
  const region = await talk(),
    items = await entries(region);
  expect(items.map(item => item.getAttribute('aria-label'))).toEqual([
    'Your idea',
    null,
    "Mara's plan",
    'Your reply',
    "Mara's plan",
  ]);
  // The reply in the director's words, in their own bubble.
  expect(items[3]!.querySelector('.sd-bubble--mine .sd-bubble__words')?.textContent).toBe('Split the second story');
  // The first plan marks nothing; the second marks the story whose scope changed and the new one.
  expect((await cards(items[2]!)).map(card => [card.number, card.changed])).toEqual([
    ['Story 1', false],
    ['Story 2', false],
  ]);
  const second = await cards(items[4]!);
  expect(second.map(card => [card.number, card.title, card.changed])).toEqual([
    ['Story 1', 'Title of records', false],
    ['Story 2', 'Title of page', true],
    ['Story 3', 'Title of reply', true],
  ]);
  expect(second[1]!.does).toBe('Show the conversation only.');
  expect(second[2]!.foot).toEqual(['Built by Eli · reviewed by Morgan', 'Builds on 2']);
  expect(within(items[4] as HTMLElement).getAllByText('Changed after your reply')).toHaveLength(2);
  expect(posted()).toEqual([]);
});

const question = {
  ask: 'Show the conversation above the stories or instead of them?',
  why: 'The page has room for one main part.',
  options: [{ label: 'Above them' }, { label: 'Instead of them', detail: 'until the plan is official' }],
  recommended: 1,
  choice: 'inside-story',
  topics: [],
};
const asked = () =>
  controller.attempts.push({
    id: 'a-ask',
    taskId: 'T-plan',
    status: 'blocked',
    workerId: 'W-4',
    startedAt: at(4),
    finishedAt: at(7),
    error: 'Needs a call from the director.',
    question,
  });
const answered: Answer = {
  attemptId: 'a-ask',
  option: 1,
  label: 'Instead of them',
  text: 'Keep the stories in view.',
  by: { type: 'director', at: at(8) },
  at: at(8),
};

test('a question shows in place with its options, the recommended one marked, and its answer after it', async () => {
  asked();
  planAttempt('a-plan', 9, 14, firstPlan);
  open([planStep('review', { answers: [answered] })]);
  const region = await talk(),
    items = await entries(region);
  expect(items.map(item => item.getAttribute('aria-label'))).toEqual([
    'Your idea',
    "Mara's question",
    'Your answer',
    "Mara's plan",
  ]);
  // The ask in the director's color, as What happened shows it, then why, then the options.
  const asking = within(items[1] as HTMLElement);
  expect(asking.getByText(question.ask).getAttribute('style')).toContain('var(--you)');
  expect(asking.getByText(question.why)).toBeTruthy();
  const options = within(asking.getByRole('list', { name: "Mara's options" })).getAllByRole('listitem');
  expect(options.map(option => option.textContent)).toEqual([
    'Above them',
    'Instead of them until the plan is official Recommended',
  ]);
  expect(within(options[0]!).queryByText('Recommended')).toBeNull();
  // Answered: no Answer link, and the director's answer in their bubble right after the question.
  expect(asking.queryByRole('link', { name: 'Answer' })).toBeNull();
  expect(items[2]!.querySelector('.sd-bubble--mine')?.textContent).toContain(
    'You answeredInstead of them — Keep the stories in view.',
  );
  expect(posted()).toEqual([]);
  // A question still waiting has the Answer link to Today's calls, and no answer yet.
  reopen(() => {
    asked();
    return [planStep('blocked', { lastAttemptId: 'a-ask' })];
  });
  const waiting = await entries(await talk());
  expect(waiting.map(item => item.getAttribute('aria-label'))).toEqual(['Your idea', "Mara's question"]);
  const answer = within(waiting[1] as HTMLElement).getByRole('link', { name: 'Answer' });
  expect(answer.getAttribute('href')).toBe('/p/project-x#calls');
  expect(posted()).toEqual([]);
});

test('a failed plan attempt reads one line saying so with a link to the plan step; an unreadable plan says so', async () => {
  controller.attempts.push({
    id: 'a-plan',
    taskId: 'T-plan',
    status: 'failed',
    workerId: 'W-4',
    startedAt: at(4),
    finishedAt: at(6),
    error: 'The plan named a file twice.\nSecond line.',
  });
  open([checksStep(), planStep('failed', { lastAttemptId: 'a-plan', dependencies: ['T-checks'] })]);
  const items = await entries(await talk()),
    line = items[2]!;
  expect(items).toHaveLength(3);
  expect(line.firstElementChild?.textContent).toBe(
    "Mara's plan attempt failed: The plan named a file twice. Start the plan step again from its page.",
  );
  expect(line.querySelector('.sd-bubble')).toBeNull();
  expect(
    within(line as HTMLElement)
      .getByRole('link', { name: 'Open the plan step' })
      .getAttribute('href'),
  ).toBe('/p/project-x/tasks/T-plan');
  // A plan whose file cannot be read says so in one line, without cards.
  reopen(() => {
    planAttempt('a-plan', 4, 7);
    return [planStep('review')];
  });
  const plan = (await entries(await talk()))[1]!;
  expect(await within(plan as HTMLElement).findByText('This plan could not be read.')).toBeTruthy();
  expect(within(plan as HTMLElement).queryByRole('list')).toBeNull();
  expect(posted()).toEqual([]);
});

test('an idea on a general project reads Step cards and no checks line, with the role in words', async () => {
  // Two reviewers: neither one is the reviewer, so a card reads "a reviewer".
  controller.shell.workers.push(agent('W-6', 'Vera', ['reviewer']));
  const plan = JSON.stringify({
    schemaVersion: 'graph-proposal-v1',
    summary: 'Draft, then check.',
    tasks: [
      { key: 'draft', title: 'Draft the guide', kind: 'general:work', role: 'editor', brief: 'Write it.' },
      {
        key: 'check',
        title: 'Check the guide',
        kind: 'general:review',
        workerId: 'W-1',
        brief: 'Read it.',
        dependencies: ['draft'],
      },
    ],
  });
  planAttempt('a-plan', 4, 7, plan, { artifacts: [{ path: 'plan.json', hash: 'h-plan', kind: 'graph-proposal' }] });
  open([planStep('review', { kind: 'general:plan' })]);
  const region = await talk(),
    items = await entries(region);
  expect(items.map(item => item.getAttribute('aria-label'))).toEqual(['Your idea', "Mara's plan"]);
  expect(within(region).queryByText(/^Checks ran/)).toBeNull();
  expect(await cards(items[1]!, "Mara's steps")).toEqual([
    {
      number: 'Step 1',
      title: 'Draft the guide',
      does: 'Write it.',
      foot: ['Built by an editor · reviewed by a reviewer'],
      changed: false,
    },
    {
      number: 'Step 2',
      title: 'Check the guide',
      does: 'Read it.',
      foot: ['Built by Eli · reviewed by a reviewer', 'Builds on 1'],
      changed: false,
    },
  ]);
  expect(posted()).toEqual([]);
});

// The idea's stories once the plan is official, waiting for the director's approval.
const proposed = (id: string, title: string, extra: Partial<Task> = {}) =>
  taskFixture(id, {
    title,
    kind: 'studio-development:change',
    status: 'backlog',
    approval: { status: 'pending' },
    workflowReference: { runId: 'run-1', key: id },
    ...extra,
  });

test('once the plan is official, the page keeps its stories and What happened, with Talk to Mara below them', async () => {
  planAttempt('a-plan', 4, 7, firstPlan, { status: 'accepted' });
  open([
    checksStep(),
    planStep('done', { acceptedAttemptId: 'a-plan', lastAttemptId: 'a-plan', dependencies: ['T-checks'] }),
    proposed('T-1', 'First', { dependencies: ['T-plan'] }),
    proposed('T-2', 'Second', { dependencies: ['T-1'] }),
  ]);
  const region = await talk(),
    happened = screen.getByRole('region', { name: 'What happened' }),
    lane = document.querySelector('.sd-lane')!;
  // Everything the page showed before, then the conversation at its foot.
  expect([...lane.querySelectorAll('.sd-storycard__title')].map(title => title.textContent)).toEqual([
    'First',
    'Second',
  ]);
  expect(follows(lane, region)).toBe(true);
  expect(follows(happened, region)).toBe(true);
  expect(follows(screen.getByRole('region', { name: 'Your idea' }), region)).toBe(true);
  expect(region.parentElement?.lastElementChild).toBe(region);
  // The same conversation, read-only.
  const items = await entries(region);
  expect(items.map(item => item.getAttribute('aria-label'))).toEqual(['Your idea', null, "Mara's plan"]);
  expect(items[1]!.textContent).toBe('Checks ran on the current code: 842 tests passed.');
  expect((await cards(items[2]!)).map(card => [card.number, card.title])).toEqual([
    ['Story 1', 'Title of records'],
    ['Story 2', 'Title of page'],
  ]);
  expect(within(region).queryByRole('button')).toBeNull();
  expect(within(region).queryByRole('textbox')).toBeNull();
  expect(posted()).toEqual([]);
});

test('the conversation only reads: a change re-reads the plan step, not its plan; an idea without a plan has none', async () => {
  planAttempt('a-plan', 4, 7, firstPlan);
  open([checksStep(), planStep('review', { dependencies: ['T-checks'] })]);
  const region = await talk();
  expect(await cards((await entries(region))[2]!)).toHaveLength(2);
  const pageReads = () => controller.reads().filter(url => url === '/api/tasks/T-plan?projectId=project-x'),
    fileReads = () => controller.reads().filter(url => url.includes('/artifact?')),
    before = pageReads().length;
  // A change to the plan step reads its page again; its plan's file is kept.
  const records = controller.records(['T-plan']);
  latest().emit('change', { version: records.version, start: records.start, changes: records.changes });
  await waitFor(() => expect(pageReads().length).toBeGreaterThan(before));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(fileReads()).toHaveLength(1);
  expect(posted()).toEqual([]);
  // An idea whose stories came without a plan step shows no conversation.
  reopen(() => [proposed('T-1', 'First')]);
  expect(await screen.findByRole('heading', { level: 1, name: `“${brief}”` }, { timeout: 5000 })).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.queryByRole('heading', { name: /^Talk to / })).toBeNull();
  expect(posted()).toEqual([]);
});
