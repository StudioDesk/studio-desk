// An idea's planning conversation on its page: the idea in the director's bubble, the checks line, each plan as Story
// or Step cards with who builds, who reviews and what each builds on, the director's reply between plans with the
// cards it changed marked, a question in place with its answer (answered right there while it waits, as Today's Your
// calls answers it), and a stopped attempt as one line. It is the page's main part while the idea is in planning and
// stays under Talk to <the planner> once the plan is official. The plans' texts are the stand-in's recorded files;
// reading them sends nothing. While the idea is in planning, a reply under the
// conversation asks the planner to revise the plan, then starts it, a line says while the planner is replying, and
// Make it official accepts the plan, each as the plan step's own page sends it.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
// Opens the idea, with what its record adds (its release), or another page of the project.
const open = (tasks: Task[], record: Partial<RunRecord> = {}, page = '/p/project-x/runs/run-1') => {
  controller.tasks = tasks;
  controller.runs = [{ ...idea(tasks), ...record }];
  const router = createAppRouter(createMemoryHistory({ initialEntries: [page] }));
  render(
    <App
      router={router}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
  return router;
};
// Opens the idea again on fresh records, as the idea page's tests do.
const reopen = (tasks: () => Task[], record: Partial<RunRecord> = {}, page?: string) => {
  cleanup();
  controller.requests = [];
  controller.attempts = [];
  controller.artifacts = {};
  open(tasks(), record, page);
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
  // Answered: no Answer box or link, and the director's answer in their bubble right after the question.
  expect(asking.queryByRole('link', { name: 'Answer' })).toBeNull();
  expect(within(region).queryByRole('form', { name: 'Answer Mara' })).toBeNull();
  expect(items[2]!.querySelector('.sd-bubble--mine')?.textContent).toContain(
    'You answeredInstead of them — Keep the stories in view.',
  );
  expect(posted()).toEqual([]);
  // A question still waiting holds Mara's question card with the Answer box, as Today's Your calls shows it, and no
  // answer yet; nothing in the conversation leads away to Today.
  reopen(() => {
    asked();
    return [planStep('blocked', { lastAttemptId: 'a-ask' })];
  });
  const later = await talk(),
    waiting = await entries(later);
  expect(waiting.map(item => item.getAttribute('aria-label'))).toEqual(['Your idea', "Mara's question"]);
  const card = within(within(waiting[1] as HTMLElement).getByRole('article', { name: "Mara's question" }));
  expect(card.getByText('Mara asks')).toBeTruthy();
  expect(card.getByText(question.ask)).toBeTruthy();
  expect(card.getByText(question.why)).toBeTruthy();
  const form = within(card.getByRole('form', { name: 'Answer Mara' }));
  expect(form.getByText("Mara's options")).toBeTruthy();
  expect(form.getByRole('button', { name: /^Above them/ }).textContent).not.toContain('Recommended');
  expect(within(form.getByRole('button', { name: /^Instead of them/ })).getByText('Recommended')).toBeTruthy();
  expect(form.getByRole('switch', { name: 'Auto mode' })).toBeTruthy();
  expect(within(later).queryByRole('link', { name: 'Answer' })).toBeNull();
  expect(later.querySelector('a[href="/p/project-x#calls"]')).toBeNull();
  expect(posted()).toEqual([]);
});

// The controller's answer (src/core/questions.mjs answerQuestion): the director's answer recorded on the plan step,
// which goes back to work with a running attempt, answered with the plan step's records.
const answering = (body: unknown) => {
  const { option, text } = body as { option: number; text?: string },
    given: Answer = {
      attemptId: 'a-ask',
      option,
      label: question.options[option]!.label,
      ...(text ? { text } : {}),
      by: { type: 'director', at: at(8) },
      at: at(8),
    };
  controller.attempts.push({
    id: 'a-plan',
    taskId: 'T-plan',
    status: 'running',
    workerId: 'W-4',
    startedAt: new Date().toISOString(),
  });
  controller.tasks = controller.tasks.map(task =>
    task.id === 'T-plan' ? { ...task, status: 'running', lastAttemptId: 'a-plan', answers: [given] } : task,
  );
  return { answer: given, start: { ok: true }, records: controller.records(['T-plan']) };
};

test("Mara's waiting question is answered in place: one answer request, the answer under it, then Mara replying", async () => {
  const user = userEvent.setup();
  controller.command = (url, _method, body) => (url === '/api/tasks/T-plan/answer' ? answering(body) : {});
  asked();
  const router = open([planStep('blocked', { lastAttemptId: 'a-ask' })]),
    region = await talk();
  await entries(region);
  const form = within(within(region).getByRole('form', { name: 'Answer Mara' }));
  // The director picks an option and adds their own words, then sends to Mara.
  await user.click(form.getByRole('button', { name: /^Above them/ }));
  await user.type(form.getByRole('textbox', { name: 'Answer Mara' }), ' Keep the stories in view.');
  await user.click(form.getByRole('button', { name: 'Send to Mara' }));
  // The body Today's Your calls sends: the option, the added words, and no Auto mode while the switch is unchanged.
  await waitFor(() => expect(toast()).toBe('Answer sent. Mara continues from its saved work with it.'));
  expect(posted()).toEqual([
    {
      url: '/api/tasks/T-plan/answer',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'a-ask', option: 0, text: 'Keep the stories in view.' },
    },
  ]);
  // Without a reload: the question as answered, the director's answer after it, and Mara replying.
  const after = await talk(),
    shown = () => [...within(after).getByRole('list', { name: 'Your conversation with Mara' }).children];
  await waitFor(() =>
    expect(shown().map(item => item.getAttribute('aria-label'))).toEqual([
      'Your idea',
      "Mara's question",
      'Your answer',
    ]),
  );
  const [, asking, answer] = shown();
  expect(within(asking as HTMLElement).getByRole('list', { name: "Mara's options" })).toBeTruthy();
  expect(answer!.querySelector('.sd-bubble--mine')?.textContent).toContain(
    'You answeredAbove them — Keep the stories in view.',
  );
  expect(within(after).queryByRole('form', { name: 'Answer Mara' })).toBeNull();
  expect(await within(after).findByText(/^Mara is replying · /)).toBeTruthy();
  // Still on the idea's page, and nothing else was sent.
  expect(router.history.location.pathname).toBe('/p/project-x/runs/run-1');
  expect(router.history.location.hash).toBe('');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(posted()).toHaveLength(1);
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

// Mara's plan in review, the attempt the plan step's revise and accept act on.
const reviewing = () => {
  planAttempt('a-plan', 4, 7, firstPlan);
  return [checksStep(), planStep('review', { lastAttemptId: 'a-plan', dependencies: ['T-checks'] })];
};
// Under the conversation: the reply box's text and Make it official.
const replyBox = (region: HTMLElement) =>
  within(region).getByRole('textbox', { name: 'Reply to Mara' }) as HTMLTextAreaElement;
const official = (region: HTMLElement) =>
  within(region).queryByRole('button', { name: 'Make it official' }) as HTMLButtonElement | null;
const toast = () => document.querySelector('.sd-toast')?.textContent;
const revise = (direction: string) => ({
  url: '/api/tasks/T-plan/revise',
  method: 'POST',
  body: { projectId: 'project-x', direction },
});
const start = { url: '/api/tasks/T-plan/start', method: 'POST', body: { projectId: 'project-x' } };

test("a reply asks Mara to revise the plan with your words, then starts the plan step, and says what happened as Start's does", async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url.endsWith('/start') ? { queued: true, reason: 'Waiting for the usage limit to reset.' } : {};
  open(reviewing());
  const region = await talk();
  await entries(region);
  const box = replyBox(region);
  expect(box.disabled).toBe(false);
  expect(within(region).getByRole('form', { name: 'Reply to Mara' }).textContent).toContain(
    'Mara revises the plan with your words.',
  );
  await user.type(box, 'Split the second story.');
  await user.click(within(region).getByRole('button', { name: 'Send to Mara' }));
  // The revision first, with the reply as its direction, then the start, once the revision is recorded.
  await waitFor(() => expect(posted()).toEqual([revise('Split the second story.'), start]));
  await waitFor(() =>
    expect(toast()).toBe('Queued. Waiting for the usage limit to reset. It starts by itself when it can.'),
  );
  expect(box.value).toBe('');
  // A start the controller ran at once reads as Start's does.
  controller.command = () => ({});
  await user.type(box, 'Keep the records story first.');
  await user.click(within(region).getByRole('button', { name: 'Send to Mara' }));
  await waitFor(() => expect(posted().slice(2)).toEqual([revise('Keep the records story first.'), start]));
  await waitFor(() => expect(toast()).toBe('Started.'));
});

test('a revision the controller refuses shows its reason, keeps the reply in the box and starts nothing', async () => {
  const user = userEvent.setup();
  controller.command = url => {
    if (url.endsWith('/revise')) throw new Error('Only work awaiting review can be revised.');
    return {};
  };
  open(reviewing());
  const region = await talk(),
    box = replyBox(region);
  await user.type(box, 'Split the second story.');
  await user.click(within(region).getByRole('button', { name: 'Send to Mara' }));
  expect((await within(region).findByRole('alert')).textContent).toBe('Only work awaiting review can be revised.');
  expect(box.value).toBe('Split the second story.');
  expect(box.disabled).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(posted()).toEqual([revise('Split the second story.')]);
  // Changing the reply clears the reason.
  await user.type(box, ' Please.');
  expect(within(region).queryByRole('alert')).toBeNull();
  expect(posted()).toHaveLength(1);
});

test('while the plan attempt runs, "Mara is replying" follows the clock under the last message, and nothing can be sent', async () => {
  const real = Date.now.bind(Date);
  let shift = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + shift);
  try {
    planAttempt('a-plan-1', 4, 7, firstPlan, {
      status: 'revision_requested',
      revisionRequestedBy: { type: 'director', at: at(9), reason: 'Split the second story' },
    });
    controller.attempts.push({
      id: 'a-plan-2',
      taskId: 'T-plan',
      status: 'running',
      workerId: 'W-4',
      startedAt: new Date(real() - 3 * 60000).toISOString(),
    });
    open([checksStep(), planStep('running', { lastAttemptId: 'a-plan-2', dependencies: ['T-checks'] })]);
    const region = await talk(),
      items = await entries(region);
    expect(items.map(item => item.getAttribute('aria-label'))).toEqual([
      'Your idea',
      null,
      "Mara's plan",
      'Your reply',
    ]);
    // The line comes after the director's reply, the last message, with the minutes so far.
    const line = await within(region).findByText(/^Mara is replying · /);
    expect(line.textContent).toBe('Mara is replying · 3 min so far');
    expect(follows(items.at(-1)!, line)).toBe(true);
    // Two minutes on, the clock's next tick reads them.
    shift = 2 * 60000;
    await waitFor(() => expect(line.textContent).toBe('Mara is replying · 5 min so far'), { timeout: 3000 });
    // The reply box is off and says why; Make it official is off too.
    expect(replyBox(region).disabled).toBe(true);
    expect((within(region).getByRole('button', { name: 'Send to Mara' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(region).getByText('Mara is replying; you can reply once the plan arrives.')).toBeTruthy();
    expect(official(region)!.disabled).toBe(true);
    expect(posted()).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("Make it official sends the plan step's accept, as its own page's decision does, and says the plan's release", async () => {
  const user = userEvent.setup();
  open(reviewing(), { release: { milestoneId: 'milestone-1.1.0', version: '1.1.0', by: { type: 'director' } } });
  const region = await talk();
  expect(within(region).getByText('Lands in 1.1.0 · nothing starts until you make it official')).toBeTruthy();
  const button = official(region)!;
  expect(button.disabled).toBe(false);
  await user.click(button);
  await waitFor(() =>
    expect(posted()).toEqual([{ url: '/api/tasks/T-plan/accept', method: 'POST', body: { projectId: 'project-x' } }]),
  );
  await waitFor(() => expect(toast()).toBe('Result accepted.'));
  // The plan step's own page sends the same request for its decision.
  const sent = posted();
  reopen(reviewing, {}, '/p/project-x/tasks/T-plan');
  const decisions = within(await screen.findByRole('region', { name: 'Where it stands' }, { timeout: 5000 }));
  await user.click(decisions.getByRole('button', { name: 'Accept result' }));
  await waitFor(() => expect(posted()).toEqual(sent));
  // An idea without a release says only that nothing starts.
  reopen(reviewing);
  const plain = await talk();
  expect(within(plain).getByText('Nothing starts until you make it official')).toBeTruthy();
  expect(within(plain).queryByText(/^Lands in/)).toBeNull();
});

test('once the plan is official, the conversation under Talk to Mara has no reply box and no Make it official', async () => {
  const user = userEvent.setup();
  // Accepting the plan makes the plan step done, with its records in the answer.
  controller.command = url => {
    if (!url.endsWith('/accept')) return {};
    controller.tasks = controller.tasks.map(task =>
      task.id === 'T-plan' ? { ...task, status: 'done', acceptedAttemptId: 'a-plan' } : task,
    );
    controller.attempts = controller.attempts.map(attempt =>
      attempt.id === 'a-plan' ? { ...attempt, status: 'accepted' } : attempt,
    );
    return { ok: true, records: controller.records(['T-plan']) };
  };
  open(reviewing());
  const before = await talk();
  expect(replyBox(before)).toBeTruthy();
  await user.click(official(before)!);
  // The conversation moves to the page's foot, with neither the reply box nor Make it official.
  await waitFor(() => expect(screen.getByRole('region', { name: 'Talk to Mara' })).not.toBe(before));
  const region = await talk();
  expect(region.parentElement?.lastElementChild).toBe(region);
  expect((await entries(region)).map(item => item.getAttribute('aria-label'))).toEqual([
    'Your idea',
    null,
    "Mara's plan",
  ]);
  expect(within(region).queryByRole('form', { name: 'Reply to Mara' })).toBeNull();
  expect(within(region).queryByRole('textbox')).toBeNull();
  expect(official(region)).toBeNull();
  expect(within(region).queryByText(/nothing starts until you make it official/i)).toBeNull();
  expect(posted()).toEqual([{ url: '/api/tasks/T-plan/accept', method: 'POST', body: { projectId: 'project-x' } }]);
});

test('the reply box says in one line why it is off: a question waits, the plan step stopped, or no plan yet', async () => {
  asked();
  open([planStep('blocked', { lastAttemptId: 'a-ask' })]);
  let region = await talk();
  expect(replyBox(region).disabled).toBe(true);
  expect(within(region).getByText('Mara asked you a question; answer it first.')).toBeTruthy();
  expect(official(region)!.disabled).toBe(true);
  expect(within(region).getByText('Nothing starts until you make it official')).toBeTruthy();
  // A failed plan attempt: the plan step stopped.
  reopen(() => {
    controller.attempts.push({
      id: 'a-plan',
      taskId: 'T-plan',
      status: 'failed',
      workerId: 'W-4',
      startedAt: at(4),
      finishedAt: at(6),
      error: 'The plan named a file twice.',
    });
    return [planStep('failed', { lastAttemptId: 'a-plan' })];
  });
  region = await talk();
  expect(replyBox(region).disabled).toBe(true);
  expect(within(region).getByText('The plan step stopped; start it again from its page to reply.')).toBeTruthy();
  expect(official(region)!.disabled).toBe(true);
  // Before the planner sends a plan.
  reopen(() => [checksStep(), planStep('backlog', { dependencies: ['T-checks'] })]);
  region = await talk();
  expect(replyBox(region).disabled).toBe(true);
  expect(within(region).getByText('You can reply once Mara sends a plan.')).toBeTruthy();
  expect(official(region)!.disabled).toBe(true);
  expect(posted()).toEqual([]);
});
