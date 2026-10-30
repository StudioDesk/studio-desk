// The chat box (a preview behind its switch, chat-box.ts): New idea and Ctrl J open it docked beside any page of the
// project; it stays open with its words as the director moves between pages, holds Today's New idea box and sends what
// Today's box sends, and on a phone it covers the page with a back arrow. Once it sends an idea it shows that idea's
// conversation with the planner, where the director answers, replies and makes the plan official as on the idea's
// page, until New idea or Ctrl J brings the box back. The sidebar's Talking it through lists each idea whose plan is
// not official yet, and choosing one opens its conversation there. Model-free, with the stand-in controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RunRecord, Task, Worker } from './api';
import { App } from './app';
import { chatBoxKey } from './chat-box';
import { openChatConversation } from './chat-panel';
import { drafts } from './idea-composer';
import type { Answer } from './questions';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  localStorage.clear();
  localStorage.setItem(chatBoxKey, 'on');
  // Drafts stay in memory for the page's life, so each test starts with empty boxes.
  drafts.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path: string) => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <App
      router={router}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
  return router;
};
const panel = () => screen.findByRole('complementary', { name: 'The chat box' });
const shut = () => screen.queryByRole('complementary', { name: 'The chat box' });
const box = (region: HTMLElement) => within(region).findByRole('textbox', { name: 'New idea for Project X' });
const sidebarNewIdea = async () => (await screen.findAllByRole('button', { name: 'New idea' }))[0]!;
const posted = () => controller.requests.filter(request => request.method === 'POST');

test('New idea opens the chat box beside the board, which stays where it is', async () => {
  const router = open('/p/project-x/board');
  fireEvent.click(await sidebarNewIdea());
  const region = await panel();
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  const text = await box(region);
  await waitFor(() => expect(document.activeElement).toBe(text));
  // The page is still there beside it.
  expect(screen.getByRole('main')).toBeTruthy();
});

test('Ctrl J opens the chat box on another page with the cursor in its box, and puts it back there when open', async () => {
  const router = open('/p/project-x/agents');
  await screen.findByRole('navigation', { name: 'Main' });
  expect(shut()).toBeNull();
  // The key is the chat box's, not the browser's.
  expect(fireEvent.keyDown(window, { key: 'j', ctrlKey: true })).toBe(false);
  const text = await box(await panel());
  await waitFor(() => expect(document.activeElement).toBe(text));
  expect(router.history.location.pathname).toBe('/p/project-x/agents');
  // Already open, with the cursor elsewhere, Cmd J brings it back to the box.
  const search = screen.getByRole('button', { name: 'Find a project (Ctrl K)' });
  search.focus();
  expect(fireEvent.keyDown(search, { key: 'j', metaKey: true })).toBe(false);
  await waitFor(() => expect(document.activeElement).toBe(text));
  expect(screen.getAllByRole('complementary', { name: 'The chat box' })).toHaveLength(1);
});

test("Ctrl J works while typing in Today's box, and the two boxes keep their own words", async () => {
  const user = userEvent.setup();
  open('/p/project-x');
  const today = await screen.findByRole('textbox', { name: 'New idea for Project X' });
  await user.type(today, 'On Today.');
  expect(fireEvent.keyDown(today, { key: 'j', ctrlKey: true })).toBe(false);
  const text = await box(await panel());
  await waitFor(() => expect(document.activeElement).toBe(text));
  expect((text as HTMLTextAreaElement).value).toBe('');
  await user.type(text, 'In the chat box.');
  expect((today as HTMLTextAreaElement).value).toBe('On Today.');
  expect((text as HTMLTextAreaElement).value).toBe('In the chat box.');
});

test('what was typed stays in the open chat box as the director follows the sidebar to another page', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  await user.type(await box(await panel()), 'Show the runs page.');
  await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Ideas' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs'));
  expect(await screen.findByRole('heading', { level: 1, name: 'Ideas' })).toBeTruthy();
  const text = (await box(await panel())) as HTMLTextAreaElement;
  expect(text.value).toBe('Show the runs page.');
});

test('Hide closes the chat box, and N opens it again with its words', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  const region = await panel();
  await user.type(await box(region), 'Kept for later.');
  await user.click(within(region).getByRole('button', { name: 'Hide' }));
  expect(shut()).toBeNull();
  fireEvent.keyDown(window, { key: 'n' });
  const text = (await box(await panel())) as HTMLTextAreaElement;
  expect(text.value).toBe('Kept for later.');
  expect(router.history.location.pathname).toBe('/p/project-x/board');
});

test("the empty chat box holds the New idea box's controls and says where earlier talks are", async () => {
  open('/p/project-x/board');
  fireEvent.click(await sidebarNewIdea());
  const element = await panel(),
    region = within(element),
    form = within((await box(element)).closest('form')!);
  expect(form.getByRole('button', { name: 'Files' })).toBeTruthy();
  expect(form.getByRole('switch', { name: 'Auto mode' })).toBeTruthy();
  expect((form.getByRole('button', { name: 'Send to Project X' }) as HTMLButtonElement).disabled).toBe(true);
  expect(
    region.getByText('Earlier talks sit under Ideas, each with its conversation, until you make them official.'),
  ).toBeTruthy();
});

test("sending from the chat box posts what Today's box posts and shows the queued toast, staying on the page", async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/intake' ? { runId: 'run-9' } : {});
  const router = open('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  const region = await panel(),
    text = await box(region),
    form = within(text.closest('form')!);
  await user.type(text, 'Show the runs page.');
  await user.upload(
    text.closest('form')!.querySelector<HTMLInputElement>('input[type=file]')!,
    new File(['# Notes'], 'notes.md', { type: 'text/markdown' }),
  );
  expect(await form.findByText('notes.md')).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Send to Project X' }));
  // The same request as today-page.test.tsx's 'an idea and its files go to the intake as one request'.
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()).toEqual([
    {
      url: '/api/intake',
      method: 'POST',
      body: {
        projectId: 'project-x',
        idea: 'Show the runs page.',
        files: [{ name: 'notes.md', mediaType: 'text/markdown', data: btoa('# Notes') }],
      },
    },
  ]);
  expect(
    await screen.findByText(
      "Idea queued: fresh checks, then the product owner's breakdown. Proposed stories will appear in Planned for your approval.",
    ),
  ).toBeTruthy();
  // The chat box stays open beside the board, and New idea brings back its box, empty for the next idea.
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  const after = (await box(await panel())) as HTMLTextAreaElement;
  expect(after.value).toBe('');
  expect(within(after.closest('form')!).queryByText('notes.md')).toBeNull();
});

// The idea as the controller's run view sends it (idea-conversation.test.tsx's), with its checks and Mara's plan step.
const at = (minute: number) => `2026-10-29T19:${String(minute).padStart(2, '0')}:00Z`;
const brief = 'Let me talk to the planner before anything starts.';
const idea = (tasks: Task[]): RunRecord => ({
  id: 'run-1',
  createdAt: at(0),
  brief,
  directorInputs: [],
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
const agent = (id: string, displayName: string, roles: string[]) =>
  ({ id, displayName, team: 'Engineering', enabled: true, roles }) as Worker;
// Mara plans, Eli builds and Morgan reviews, and the idea's records are the controller's.
const holding = (tasks: Task[]) => {
  controller.shell.workers = [
    agent('W-1', 'Eli', ['engineer']),
    agent('W-4', 'Mara', ['product-owner']),
    agent('W-5', 'Morgan', ['reviewer']),
  ];
  controller.tasks = tasks;
  controller.runs = [idea(tasks)];
};
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
const planStep = (status: string, extra: Partial<Task> = {}) =>
  taskFixture('T-plan', {
    title: 'Plan the idea',
    kind: 'studio-development:breakdown',
    status,
    workerId: 'W-4',
    workflowReference: { runId: 'run-1', key: 'plan' },
    ...extra,
  });
const plan = JSON.stringify({
  schemaVersion: 'source-breakdown-v1',
  source: { taskId: 'T-checks', attemptId: 'a-checks', path: 'check-report.json', hash: 'h' },
  summary: 'The plan.',
  stories: ['records', 'page'].map(key => ({
    key,
    kind: 'studio-development:change',
    role: 'engineer',
    title: `Title of ${key}`,
    scope: `What ${key} does.`,
    acceptance: `${key} is checked.`,
    complexity: 2,
    dependencies: key === 'page' ? ['records'] : [],
    files: [],
    newFiles: [`dashboard/src/${key}.ts`],
    deleteFiles: [],
  })),
});
// Mara's plan in review, the attempt the plan step's revise and accept act on.
const reviewing = () => {
  controller.artifacts['a-plan/source-breakdown.json'] = plan;
  controller.attempts.push({
    id: 'a-plan',
    taskId: 'T-plan',
    status: 'review',
    workerId: 'W-4',
    startedAt: at(4),
    finishedAt: at(7),
    result: { summary: 'Summary of a-plan.' },
    artifacts: [{ path: 'source-breakdown.json', hash: 'h-a-plan', kind: 'source-breakdown' }],
  });
  return [checksStep(), planStep('review', { lastAttemptId: 'a-plan', dependencies: ['T-checks'] })];
};
const talk = (region: HTMLElement) => within(region).findByRole('region', { name: 'Talk to Mara' }, { timeout: 5000 });
const entries = async (region: HTMLElement) => [
  ...(await within(region).findByRole('list', { name: 'Your conversation with Mara' }, { timeout: 5000 })).children,
];
const labels = (items: Element[]) => items.map(item => item.getAttribute('aria-label'));
const sentLine = "Your idea is sent. The planner's reply will appear here.";
// Sends an idea from the chat box on the board; the intake answers with run-1.
const sendIdea = async (user: ReturnType<typeof userEvent.setup>, words = 'Talk first.') => {
  const router = open('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  const region = await panel(),
    text = await box(region);
  await user.type(text, words);
  await user.click(within(text.closest('form')!).getByRole('button', { name: 'Send to Project X' }));
  return { router, region };
};
const intake = (url: string) => (url === '/api/intake' ? { runId: 'run-1' } : {});
const revise = (direction: string) => ({
  url: '/api/tasks/T-plan/revise',
  method: 'POST',
  body: { projectId: 'project-x', direction },
});
const start = { url: '/api/tasks/T-plan/start', method: 'POST', body: { projectId: 'project-x' } };
const accept = { url: '/api/tasks/T-plan/accept', method: 'POST', body: { projectId: 'project-x' } };

test("after sending on the board, the chat box says the idea is sent, then shows the idea's conversation with Mara", async () => {
  const user = userEvent.setup();
  controller.shell.workers = [agent('W-4', 'Mara', ['product-owner']), agent('W-5', 'Morgan', ['reviewer'])];
  // The intake records the idea; the stream names its run only later.
  controller.command = url => {
    if (url !== '/api/intake') return {};
    holding(reviewing());
    return { runId: 'run-1' };
  };
  const { router, region } = await sendIdea(user, brief);
  // Before the records hold the run: one line, and no box.
  expect((await within(region).findByRole('status')).textContent).toBe(sentLine);
  expect(within(region).queryByRole('textbox', { name: 'New idea for Project X' })).toBeNull();
  expect(posted()).toEqual([{ url: '/api/intake', method: 'POST', body: { projectId: 'project-x', idea: brief } }]);
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  latest().emit('change', { version: 2, start: 'start-a', changes: [{ seq: 2, type: 'run', id: 'run-1' }] });
  // Then the conversation as the idea's page shows it: the idea's words, the checks and Mara's plan.
  const conversation = await talk(region),
    items = await entries(conversation);
  expect(labels(items)).toEqual(['Your idea', null, "Mara's plan"]);
  expect(items[0]!.textContent).toContain(brief);
  const cards = await within(items[2] as HTMLElement).findByRole('list', { name: "Mara's stories" });
  expect([...cards.querySelectorAll('.sd-storycard__title')].map(title => title.textContent)).toEqual([
    'Title of records',
    'Title of page',
  ]);
  // Above it, the idea's title and its page.
  expect(within(region).getByText(`“${brief}”`)).toBeTruthy();
  expect(within(region).getByRole('link', { name: "Open the idea's page" }).getAttribute('href')).toBe(
    '/p/project-x/runs/run-1',
  );
  expect(within(region).queryByText(sentLine)).toBeNull();
  expect(router.history.location.pathname).toBe('/p/project-x/board');
});

// Mara's plan step, blocked on attempt a-ask with its question for the director.
const question = {
  ask: 'Show the conversation above the stories or instead of them?',
  why: 'The page has room for one main part.',
  options: [{ label: 'Above them' }, { label: 'Instead of them', detail: 'until the plan is official' }],
  recommended: 1,
  choice: 'inside-story',
  topics: [],
};
const asked = () => {
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
  return [planStep('blocked', { lastAttemptId: 'a-ask' })];
};

test("Mara's waiting question shows in the chat box as its question card with the Answer box, as on the idea's page", async () => {
  const user = userEvent.setup();
  holding(asked());
  controller.command = intake;
  const { region } = await sendIdea(user);
  const conversation = await talk(region),
    items = await entries(conversation);
  expect(labels(items)).toEqual(['Your idea', "Mara's question"]);
  const card = within(within(items[1] as HTMLElement).getByRole('article', { name: "Mara's question" }));
  expect(card.getByText('Mara asks')).toBeTruthy();
  expect(card.getByText(question.ask)).toBeTruthy();
  expect(card.getByText(question.why)).toBeTruthy();
  // The Answer box with Mara's options as suggestions, the recommended one marked, and the Auto mode switch.
  const form = within(card.getByRole('form', { name: 'Answer Mara' }));
  expect(form.getByText("Mara's options")).toBeTruthy();
  expect(form.getByRole('button', { name: /^Above them/ }).textContent).not.toContain('Recommended');
  expect(within(form.getByRole('button', { name: /^Instead of them/ })).getByText('Recommended')).toBeTruthy();
  expect(form.getByRole('switch', { name: 'Auto mode' })).toBeTruthy();
  // Nothing in the conversation leads out of the chat box to Today.
  expect(within(conversation).queryByRole('link', { name: 'Answer' })).toBeNull();
  expect(conversation.querySelector('a[href="/p/project-x#calls"]')).toBeNull();
  expect(within(conversation).getByText('Mara asked you a question; answer it first.')).toBeTruthy();
  expect(posted()).toHaveLength(1);
});

test('an answer sent in the chat box posts what Your calls posts, then shows under the question with Mara replying, on the same page', async () => {
  const user = userEvent.setup();
  holding(asked());
  // The controller records the answer on the plan step, which goes back to work with a running attempt
  // (src/core/questions.mjs answerQuestion), and answers with the plan step's records.
  controller.command = (url, _method, body) => {
    if (url !== '/api/tasks/T-plan/answer') return intake(url);
    const { option } = body as { option: number },
      given: Answer = {
        attemptId: 'a-ask',
        option,
        label: question.options[option]!.label,
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
  const { router, region } = await sendIdea(user);
  const conversation = await talk(region);
  await entries(conversation);
  const form = within(within(conversation).getByRole('form', { name: 'Answer Mara' }));
  // The director picks the recommended option and sends it to Mara.
  await user.click(form.getByRole('button', { name: /^Instead of them/ }));
  await user.click(form.getByRole('button', { name: 'Send to Mara' }));
  await waitFor(() =>
    expect(document.querySelector('.sd-toast')?.textContent).toBe(
      'Answer sent. Mara continues from its saved work with it.',
    ),
  );
  // One request after the idea, with the body Today's Your calls sends for the same pick.
  expect(posted().slice(1)).toEqual([
    {
      url: '/api/tasks/T-plan/answer',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'a-ask', option: 1 },
    },
  ]);
  // Without a reload, the answer under the question, no Answer box, and Mara replying.
  const after = await talk(region),
    shown = () => [...within(after).getByRole('list', { name: 'Your conversation with Mara' }).children];
  await waitFor(() => expect(labels(shown())).toEqual(['Your idea', "Mara's question", 'Your answer']));
  expect(shown()[2]!.querySelector('.sd-bubble--mine')?.textContent).toContain('You answeredInstead of them');
  expect(within(after).queryByRole('form', { name: 'Answer Mara' })).toBeNull();
  expect(await within(after).findByText(/^Mara is replying · /)).toBeTruthy();
  // The chat box stays open beside the board.
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  expect(router.history.location.hash).toBe('');
  expect(screen.getByRole('complementary', { name: 'The chat box' })).toBe(region);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(posted()).toHaveLength(2);
});

test("a reply typed in the chat box sends the plan step's revise, then its start, as the idea's page does", async () => {
  const user = userEvent.setup();
  holding(reviewing());
  controller.command = intake;
  const { region } = await sendIdea(user);
  const conversation = await talk(region);
  await entries(conversation);
  const reply = within(conversation).getByRole('textbox', { name: 'Reply to Mara' }) as HTMLTextAreaElement;
  expect(reply.disabled).toBe(false);
  await user.type(reply, 'Split the second story.');
  await user.click(within(conversation).getByRole('button', { name: 'Send to Mara' }));
  await waitFor(() => expect(posted().slice(1)).toEqual([revise('Split the second story.'), start]));
  await waitFor(() => expect(document.querySelector('.sd-toast')?.textContent).toBe('Started.'));
  expect(reply.value).toBe('');
});

test("Make it official in the chat box sends the plan step's accept, and the conversation stays readable after", async () => {
  const user = userEvent.setup();
  holding(reviewing());
  // Accepting the plan makes the plan step done, with its records in the answer.
  controller.command = url => {
    if (!url.endsWith('/accept')) return intake(url);
    controller.tasks = controller.tasks.map(task =>
      task.id === 'T-plan' ? { ...task, status: 'done', acceptedAttemptId: 'a-plan' } : task,
    );
    controller.attempts = controller.attempts.map(attempt =>
      attempt.id === 'a-plan' ? { ...attempt, status: 'accepted' } : attempt,
    );
    return { ok: true, records: controller.records(['T-plan']) };
  };
  const { region } = await sendIdea(user);
  const conversation = await talk(region);
  await entries(conversation);
  await user.click(within(conversation).getByRole('button', { name: 'Make it official' }));
  await waitFor(() => expect(posted().slice(1)).toEqual([accept]));
  // Official: no reply box and no Make it official, the plan still there with the idea's page above it.
  await waitFor(() => expect(within(region).queryByRole('button', { name: 'Make it official' })).toBeNull());
  expect(within(region).queryByRole('textbox')).toBeNull();
  expect(labels(await entries(await talk(region)))).toEqual(['Your idea', null, "Mara's plan"]);
  expect(within(region).getByRole('link', { name: "Open the idea's page" })).toBeTruthy();
  // Once the idea finishes and leaves the live records, its finished record keeps the conversation.
  const tasks = controller.tasks,
    attempts = controller.attempts;
  controller.finished = { runs: [{ run: idea(tasks), tasks, attempts }], next: null };
  controller.runs = [];
  latest().emit('change', { version: 9, start: 'start-a', changes: [{ seq: 9, type: 'run', id: 'run-1' }] });
  await waitFor(() => expect(controller.reads().filter(url => url.includes('/runs?')).length).toBeGreaterThan(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(labels(await entries(await talk(region)))).toEqual(['Your idea', null, "Mara's plan"]);
  expect(within(region).queryByText(sentLine)).toBeNull();
  expect(posted().slice(1)).toEqual([accept]);
});

test('New idea or Ctrl J while a conversation shows brings back the New idea box, with its own words', async () => {
  const user = userEvent.setup();
  holding(reviewing());
  controller.command = intake;
  const { region } = await sendIdea(user);
  await talk(region);
  expect(within(region).queryByText(/^Earlier talks sit under Ideas/)).toBeNull();
  await user.click(await sidebarNewIdea());
  const text = (await box(region)) as HTMLTextAreaElement;
  expect(text.value).toBe('');
  await waitFor(() => expect(document.activeElement).toBe(text));
  expect(within(region).queryByRole('region', { name: 'Talk to Mara' })).toBeNull();
  expect(within(region).getByText(/^Earlier talks sit under Ideas/)).toBeTruthy();
  // The frame opens a conversation by its run; the box keeps what was typed, and Ctrl J brings it back.
  await user.type(text, 'Half a thought.');
  act(() => openChatConversation('run-1'));
  await talk(region);
  expect(within(region).queryByRole('textbox', { name: 'New idea for Project X' })).toBeNull();
  fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
  expect(((await box(region)) as HTMLTextAreaElement).value).toBe('Half a thought.');
  expect(within(region).queryByRole('region', { name: 'Talk to Mara' })).toBeNull();
  expect(posted()).toHaveLength(1);
});

test("the sidebar's Talking it through lists the idea in planning, opens its conversation beside the page, and drops it once official", async () => {
  const user = userEvent.setup();
  holding(reviewing());
  const router = open('/p/project-x/board');
  const links = within(await screen.findByRole('navigation', { name: 'Talking it through' })).getAllByRole('link');
  // The idea by its run's title; its address is the idea's page, for a new tab.
  expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Let me talk to the planner before anything starts', '/p/project-x/runs/run-1'],
  ]);
  expect(shut()).toBeNull();
  await user.click(links[0]!);
  const region = await panel();
  expect(labels(await entries(await talk(region)))).toEqual(['Your idea', null, "Mara's plan"]);
  expect(within(region).getByRole('button', { name: 'Make it official' })).toBeTruthy();
  // Choosing a talk is no New idea: no box, and the page stays where it is.
  expect(within(region).queryByRole('textbox', { name: 'New idea for Project X' })).toBeNull();
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  expect(posted()).toEqual([]);
  // The plan is made official elsewhere; the stream's change takes the idea off the list, and with no talks going
  // the section goes. The conversation stays in the chat box.
  controller.tasks = controller.tasks.map(task =>
    task.id === 'T-plan' ? { ...task, status: 'done', acceptedAttemptId: 'a-plan' } : task,
  );
  controller.attempts = controller.attempts.map(attempt =>
    attempt.id === 'a-plan' ? { ...attempt, status: 'accepted' } : attempt,
  );
  latest().emit('change', { version: 2, start: 'start-a', changes: [{ seq: 2, type: 'task', id: 'T-plan' }] });
  await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Talking it through' })).toBeNull());
  await waitFor(() => expect(within(region).queryByRole('button', { name: 'Make it official' })).toBeNull());
  expect(labels(await entries(await talk(region)))).toEqual(['Your idea', null, "Mara's plan"]);
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  expect(posted()).toEqual([]);
});

test('a project whose work takes no ideas shows no box in the chat box', async () => {
  controller.shell.organizationConfiguration = { taskKinds: ['studio-development:checks'] };
  open('/p/project-x/board');
  fireEvent.click(await sidebarNewIdea());
  const region = within(await panel());
  expect(await region.findByText(/Project X takes no ideas/)).toBeTruthy();
  expect(region.queryByRole('textbox')).toBeNull();
});

test('on a phone the chat box covers the page from the middle tab, with a back arrow that closes it', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const user = userEvent.setup();
  const router = open('/p/project-x/board');
  const tabs = within(await screen.findByRole('navigation', { name: 'Pages' }));
  await user.click(tabs.getByRole('button', { name: 'New idea' }));
  const region = await panel();
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  // No sheet rises over it: the chat box itself holds the box.
  expect(region.querySelector('dialog')).toBeNull();
  expect(await box(region)).toBeTruthy();
  expect(within(region).queryByRole('button', { name: 'Hide' })).toBeNull();
  await user.click(within(region).getByRole('button', { name: 'Back' }));
  expect(shut()).toBeNull();
});
