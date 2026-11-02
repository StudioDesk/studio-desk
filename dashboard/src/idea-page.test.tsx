// Bringing an idea back to an older line from its page (1.1, October 27): once every one of its source stories landed
// or was closed, and one landed, the page offers each older line the controller answers with, confirmed first; before
// then it never asks the controller. And an agent's question in What happened (1.2 step 2), with its options, its
// answers, Answer while it waits and Change the answer for auto mode's. And the checks' and the plan's own pages,
// linked under Checks and plan and, on a phone, under the stops. And where the conversation with the planner shows
// once the plan is accepted: before the stories while they all wait for approval, at the page's foot once one moves.
// And What it produced on a code idea, whose changes link to their stories, with no empty pane beside them.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, RunRecord, Task } from './api';
import { App } from './app';
import { Icon } from './design/icons';
import type { Answer } from './questions';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, whenShown, type Controller } from './test-controller';

let controller: Controller;
const change = 'studio-development:change';
beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A source story of run-1 that landed: its review passed and its change was integrated as the commit given.
const landed = (id: string, title: string, commit: string, extra: Partial<Task> = {}) => {
  controller.attempts.push({
    id: `attempt-${id}`,
    taskId: id,
    status: 'accepted',
    workerId: 'W-1',
    startedAt: '2026-10-27T10:00:00Z',
    finishedAt: '2026-10-27T10:05:00Z',
    assignment: { kind: 'studio-development:change-review' },
    candidateReviewVerdict: 'pass',
    sourceIntegration: { state: 'integrated', repository: { branch: 'main', commit } },
  } as AttemptSummary);
  return taskFixture(id, {
    title,
    kind: change,
    status: 'done',
    acceptedAttemptId: `attempt-${id}`,
    lastAttemptId: `attempt-${id}`,
    workflowReference: { runId: 'run-1', key: id },
    sourceStage: {
      version: 'source-story-stages-v1',
      phase: 'integration',
      current: 'integrated',
      review: { attemptId: `attempt-${id}`, verdict: 'pass', hash: `review-${id}` },
    },
    ...extra,
  });
};
// A source story of run-1 its agent is still working on.
const working = (id: string, title: string, extra: Partial<Task> = {}) => {
  controller.attempts.push({
    id: `attempt-${id}`,
    taskId: id,
    status: 'running',
    workerId: 'W-1',
    startedAt: new Date().toISOString(),
    assignment: { kind: change },
  });
  return taskFixture(id, {
    title,
    kind: change,
    status: 'running',
    lastAttemptId: `attempt-${id}`,
    workflowReference: { runId: 'run-1', key: id },
    sourceStage: { version: 'source-story-stages-v1', phase: 'editing', current: 'editing' },
    ...extra,
  });
};
// A source story of run-1 the director closed before it started.
const closed = (id: string, title: string) =>
  taskFixture(id, {
    title,
    kind: change,
    status: 'ready',
    closed: { reason: 'Not needed.' },
    workflowReference: { runId: 'run-1', key: id },
    sourceStage: { version: 'source-story-stages-v1', phase: 'editing', current: 'waiting' },
  });
// The idea as the controller's run view sends it, its stories one after another.
const idea = (tasks: Task[]): RunRecord => ({
  id: 'run-1',
  createdAt: '2026-10-27T09:00:00Z',
  brief: 'Bring the fixes back.',
  workflow: { id: 'workflow-1', name: 'Source checks and review', version: 3 },
  revisions: [{ revision: 1, at: '2026-10-27T09:00:00Z', reason: 'created' }],
  nodes: tasks.map(task => ({
    taskId: task.id,
    key: task.id,
    kind: task.kind,
    title: task.title,
    workerId: 'W-1',
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
const both = () => [
  landed('T-1', 'First', 'a1b2c3d4e5'),
  landed('T-2', 'Second', 'f6a7b8c9d0', { dependencies: ['T-1'] }),
];
const targets = {
  lines: [
    { line: 'release/1.0', through: ['release/1.1', 'release/1.0'] },
    { line: 'release/0.9', reason: 'T-2 (“Second”): It builds on T-1 …' },
  ],
};
// The page reads the idea, then where it can go back to, so a loaded machine (an idea's checks beside other tests)
// takes more than the default second to show either (October 27, when this failed a candidate under load).
const backReads = () => controller.reads().filter(url => url.includes('/bring-back')),
  posted = () => controller.requests.filter(request => request.method !== 'GET'),
  offer = async () => within(await screen.findByRole('list', { name: 'Bring back' }, { timeout: 5000 })),
  title = () => screen.findByRole('heading', { level: 1, name: '“Bring the fixes back.”' }, { timeout: 5000 });

test("an idea whose stories landed offers each older line, or the controller's reason where it can't go", async () => {
  controller.runBringBack['run-1'] = targets;
  open(both());
  const items = (await offer()).getAllByRole('listitem');
  expect(backReads()).toEqual(['/api/projects/project-x/runs/run-1/bring-back?projectId=project-x']);
  // Bringing it back to release/1.0 applies it to release/1.1 on the way, and says so.
  const button = within(items[0]!).getByRole('button', { name: 'Bring the idea back to release/1.0' }),
    note = document.getElementById(button.getAttribute('aria-describedby') ?? '');
  expect(note?.textContent).toBe('Also reaches release/1.1, the line in between.');
  // A line it can't go to shows the controller's reason, with no button.
  expect(items[1]!.textContent).toBe('T-2 (“Second”): It builds on T-1 …');
  expect(within(items[1]!).queryByRole('button')).toBeNull();
  expect(items).toHaveLength(2);
});

test('Bring the idea back asks first, naming every line it reaches, and sends nothing when cancelled', async () => {
  const user = userEvent.setup();
  controller.runBringBack['run-1'] = targets;
  controller.command = url => {
    if (!url.endsWith('/bring-back')) return {};
    // Once planned, the controller offers no line until the carries finish.
    controller.runBringBack['run-1'] = {
      lines: [{ line: 'release/1.0', reason: 'T-1 (“First”): Its bringing back to release/1.1 has not finished.' }],
    };
    return {
      stories: [
        { storyId: 'T-1', lines: ['release/1.1', 'release/1.0'] },
        { storyId: 'T-2', lines: ['release/1.1', 'release/1.0'] },
      ],
    };
  };
  open(both());
  const list = await offer();
  await user.click(list.getByRole('button', { name: 'Bring the idea back to release/1.0' }));
  let dialog = within(await screen.findByRole('dialog', { name: 'Bring the idea back to release/1.0?' }));
  const words = dialog.getByText(/An older release gets this change/).textContent;
  expect(words).toMatch(/release\/1\.1, then release\/1\.0/);
  expect(words).toMatch(/all of the idea's stories go back/);
  expect(words).toMatch(/in the order they landed/);
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Bring the idea back to release/1.0?' })).toBeNull());
  expect(posted()).toEqual([]);
  await user.click(list.getByRole('button', { name: 'Bring the idea back to release/1.0' }));
  dialog = within(await screen.findByRole('dialog', { name: 'Bring the idea back to release/1.0?' }));
  await user.click(dialog.getByRole('button', { name: 'Bring the idea back to release/1.0' }));
  await waitFor(() =>
    expect(posted()).toEqual([
      {
        url: '/api/projects/project-x/runs/run-1/bring-back',
        method: 'POST',
        body: { projectId: 'project-x', line: 'release/1.0' },
      },
    ]),
  );
  // The toast names the stories the controller planned, as their cards do.
  expect(await screen.findByText('Bringing stories 1 and 2 back to release/1.1, then release/1.0.')).toBeTruthy();
  // The offer is read again and shows the controller's new answer in place of the button.
  expect(await list.findByText('T-1 (“First”): Its bringing back to release/1.1 has not finished.')).toBeTruthy();
  expect(backReads()).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /^Bring the idea back/ })).toBeNull();
});

test('an idea with a story still working never asks; one with nowhere older to go shows nothing', async () => {
  controller.runBringBack['run-1'] = targets;
  open([landed('T-1', 'First', 'a1b2c3d4e5'), working('T-2', 'Second', { dependencies: ['T-1'] })]);
  expect(await title()).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(backReads()).toEqual([]);
  expect(screen.queryByRole('list', { name: 'Bring back' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Bring the idea back/ })).toBeNull();
  cleanup();
  // Every story landed, but the project has no older line: the controller answers no lines.
  controller.requests = [];
  controller.attempts = [];
  delete controller.runBringBack['run-1'];
  open(both());
  await waitFor(() => expect(backReads()).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.queryByRole('list', { name: 'Bring back' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Bring the idea back/ })).toBeNull();
});

test('a closed story counts as settled, as long as one of the idea’s stories landed', async () => {
  controller.runBringBack['run-1'] = targets;
  open([landed('T-1', 'First', 'a1b2c3d4e5'), closed('T-2', 'Second')]);
  expect((await offer()).getByRole('button', { name: 'Bring the idea back to release/1.0' })).toBeTruthy();
  cleanup();
  // Nothing landed: every story was closed, so there is nothing to bring back.
  controller.requests = [];
  controller.attempts = [];
  open([closed('T-1', 'First'), closed('T-2', 'Second')]);
  expect(await title()).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(backReads()).toEqual([]);
  expect(screen.queryByRole('button', { name: /^Bring the idea back/ })).toBeNull();
});

// A command's answer carries the records it changed (records.ts RecordSync.answer), so the idea's page shows its
// unstarted stories closed with the command's toast, before the stream's change event for it.
const planned = (id: string, title: string, extra: Partial<Task> = {}) =>
  taskFixture(id, {
    title,
    kind: change,
    status: 'backlog',
    approval: { status: 'pending' },
    workflowReference: { runId: 'run-1', key: id },
    ...extra,
  });
const page = () => ({
  idea: document.querySelector('.sd-ideahead__meta .sd-chip')?.textContent,
  stories: [...document.querySelectorAll('.sd-storycard')].map(
    card =>
      `${card.querySelector('.sd-storycard__title')?.textContent}: ${card.querySelector('.sd-chip')?.textContent}`,
  ),
  close: !!screen.queryByRole('menuitem', { name: /^Close what is left/, hidden: true }),
});
const proposedIdea = () => [planned('T-1', 'First'), planned('T-2', 'Second')];

test("Close what is left shows the idea's unstarted stories closed with its toast, before any live update", async () => {
  const user = userEvent.setup();
  vi.stubGlobal('confirm', () => true);
  let answer: ReturnType<Controller['records']> | undefined;
  controller.command = (url, _method, body) => {
    if (url !== '/api/tasks/close') return {};
    // Each one denied (src/core/proposals.mjs closeWork).
    const ids = (body as { taskIds: string[] }).taskIds;
    controller.tasks = controller.tasks.map(task =>
      ids.includes(task.id)
        ? { ...task, status: 'denied', approval: { status: 'denied', reason: 'Closed from the idea.' }, queued: false }
        : task,
    );
    answer = controller.records(ids);
    return { closed: ids, records: answer };
  };
  open(proposedIdea());
  expect(await title()).toBeTruthy();
  await waitFor(() => expect(page().close).toBe(true));
  expect(page().stories).toEqual(['First: Your call', 'Second: Your call']);
  const seen = whenShown('Closed 2 unstarted stories.', page);
  await user.click(screen.getByRole('menuitem', { name: 'Close what is left (2)', hidden: true }));
  const closed = await seen;
  expect(posted()).toEqual([
    {
      url: '/api/tasks/close',
      method: 'POST',
      body: { projectId: 'project-x', taskIds: ['T-1', 'T-2'], reason: 'Closed from the idea.' },
    },
  ]);
  expect(closed.idea).toBe('Cancelled');
  expect(closed.close).toBe(false);
  expect(closed.stories.filter(story => story.endsWith('Your call'))).toEqual([]);
  // The stream's change for the same command leaves the page as it is.
  latest().emit('change', { version: answer!.version, start: answer!.start, changes: answer!.changes });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(page()).toEqual(closed);
});

test("a refused Close what is left leaves the idea's stories as they were and shows the controller's reason", async () => {
  const user = userEvent.setup(),
    reason = 'T-2 has started or finished, so it cannot be closed.';
  vi.stubGlobal('confirm', () => true);
  controller.command = () => {
    throw new Error(reason);
  };
  open(proposedIdea());
  expect(await title()).toBeTruthy();
  await waitFor(() => expect(page().close).toBe(true));
  const before = page(),
    seen = whenShown(reason, page);
  await user.click(screen.getByRole('menuitem', { name: 'Close what is left (2)', hidden: true }));
  expect(await seen).toEqual(before);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(page()).toEqual(before);
});

// The idea's plan step, whose first attempt stopped to ask the director a question (1.2 step 2), as the controller
// records it: the attempt blocked with its question and each answer on the task. Then the plan step planned once more
// and finished (`planned`), is planning again (`planning`), or still waits for its answer (`waiting`).
const question = {
    ask: 'Split the page part into two stories?',
    why: 'Two pages share it.',
    options: [{ label: 'One story' }, { label: 'Two stories', detail: 'one a page' }],
    recommended: 1,
    choice: 'inside-story',
    topics: [],
  },
  autoAnswer: Answer = {
    attemptId: 'attempt-ask',
    option: 1,
    label: 'Two stories',
    by: { type: 'auto-mode', at: '2026-10-27T09:06:00Z' },
  },
  yourAnswer: Answer = {
    attemptId: 'attempt-ask',
    option: 1,
    label: 'Two stories',
    text: 'Keep the shared part in the first.',
    by: { type: 'director', at: '2026-10-27T09:06:00Z' },
    at: '2026-10-27T09:06:00Z',
  };
const planStep = (next: 'planned' | 'planning' | 'waiting', extra: Partial<Task> = {}) => {
  controller.attempts.push({
    id: 'attempt-ask',
    taskId: 'T-plan',
    status: 'blocked',
    workerId: 'W-1',
    startedAt: '2026-10-27T09:01:00Z',
    finishedAt: '2026-10-27T09:05:00Z',
    error: 'Needs a call from the director.',
    question,
  });
  if (next !== 'waiting')
    controller.attempts.push({
      id: 'attempt-plan',
      taskId: 'T-plan',
      status: next === 'planned' ? 'accepted' : 'running',
      workerId: 'W-1',
      startedAt: '2026-10-27T09:07:00Z',
      ...(next === 'planned' ? { finishedAt: '2026-10-27T09:09:00Z', result: { summary: 'One story.' } } : {}),
    });
  return taskFixture('T-plan', {
    title: 'Plan the idea',
    kind: 'studio-development:breakdown',
    status: next === 'planned' ? 'done' : next === 'planning' ? 'running' : 'blocked',
    lastAttemptId: next === 'waiting' ? 'attempt-ask' : 'attempt-plan',
    ...(next === 'planned' ? { acceptedAttemptId: 'attempt-plan' } : {}),
    workflowReference: { runId: 'run-1', key: 'plan' },
    ...extra,
  });
};
// A source story of run-1 whose only attempt failed.
const failed = (id: string, title: string) => {
  controller.attempts.push({
    id: `attempt-${id}`,
    taskId: id,
    status: 'failed',
    workerId: 'W-1',
    startedAt: '2026-10-27T09:10:00Z',
    finishedAt: '2026-10-27T09:15:00Z',
    error: 'The tests failed.',
    assignment: { kind: change },
  });
  return taskFixture(id, {
    title,
    kind: change,
    status: 'failed',
    lastAttemptId: `attempt-${id}`,
    workflowReference: { runId: 'run-1', key: id },
    sourceStage: { version: 'source-story-stages-v1', phase: 'editing', current: 'editing' },
  });
};
const whatHappened = () => screen.findByRole('region', { name: 'What happened' }, { timeout: 5000 });
// What happened as the director reads it: each group's title, then each line's sentence.
const told = (region: HTMLElement) =>
  [...region.querySelectorAll('.sd-timeline')].map(list => [
    list.previousElementSibling?.querySelector('.sd-eyebrow')?.textContent,
    ...[...list.children].map(item => item.querySelector('.sd-timeline__body > span')?.textContent?.trim()),
  ]);
// The line that tells Eli's question.
const asking = (region: HTMLElement) =>
  [...region.querySelectorAll<HTMLElement>('.sd-timeline > li')].find(item =>
    item.textContent?.includes('Eli asked you:'),
  )!;

test("a plan step's question reads as Eli asking you, with its options and your answer; a failed attempt stopped", async () => {
  open([planStep('planned', { answers: [yourAnswer] }), failed('T-1', 'First')]);
  const region = await whatHappened();
  expect(told(region)).toEqual([
    [
      'Checks and plan',
      'You sent the idea.',
      'Eli asked you: Split the page part into two stories?',
      'You answered: Two stories — Keep the shared part in the first.',
      'Eli planned it as 1 story in 2 min.',
    ],
    ['Story 1', 'Attempt 1 stopped: The tests failed.'],
  ]);
  // The ask in the director's color, then the options, the recommended one marked and no other.
  const asked = within(asking(region));
  expect(asked.getByText('Split the page part into two stories?').getAttribute('style')).toContain('var(--you)');
  const options = within(asked.getByRole('list', { name: "Eli's options" })).getAllByRole('listitem');
  expect(options.map(option => option.textContent)).toEqual(['One story', 'Two stories one a page Recommended']);
  expect(within(options[0]!).queryByText('Recommended')).toBeNull();
  expect(within(options[1]!).getByText('Recommended')).toBeTruthy();
  // It was answered: nothing to answer or change, and only the failed attempt stopped.
  expect(within(region).queryByRole('link', { name: 'Answer' })).toBeNull();
  expect(within(region).queryByRole('button', { name: 'Change the answer' })).toBeNull();
  expect(told(region)[0]!.filter(line => line?.includes('stopped:'))).toEqual([]);
});

test("auto mode's answer may be changed while the plan step runs: Change the answer opens the Answer box", async () => {
  const user = userEvent.setup();
  controller.command = url => {
    if (url !== '/api/tasks/T-plan/change-answer') return {};
    // The director's answer replaces auto mode's (src/core/questions.mjs changeAnswer).
    const given: Answer = {
      attemptId: 'attempt-ask',
      option: 0,
      label: 'One story',
      replaces: 'auto-mode',
      by: { type: 'director', at: '2026-10-27T09:08:00Z' },
      at: '2026-10-27T09:08:00Z',
    };
    controller.tasks = controller.tasks.map(task =>
      task.id === 'T-plan' ? { ...task, answers: [...(task.answers as Answer[]), given] } : task,
    );
    return { answer: given, start: null, records: controller.records(['T-plan']) };
  };
  open([planStep('planning', { answers: [autoAnswer] })]);
  const section = await whatHappened(),
    region = within(section);
  expect(told(section)[0]).toEqual([
    'Checks and plan',
    'You sent the idea.',
    'Eli asked you: Split the page part into two stories?',
    'Auto mode answered for you: Two stories',
    'Eli is working on it now.',
  ]);
  expect(region.queryByRole('form', { name: 'Answer Eli' })).toBeNull();
  // Cancel closes the box and sends nothing.
  await user.click(region.getByRole('button', { name: 'Change the answer' }));
  expect(region.getByRole('form', { name: 'Answer Eli' })).toBeTruthy();
  await user.click(region.getByRole('button', { name: 'Cancel' }));
  expect(region.queryByRole('form', { name: 'Answer Eli' })).toBeNull();
  expect(posted()).toEqual([]);
  await user.click(region.getByRole('button', { name: 'Change the answer' }));
  const form = within(region.getByRole('form', { name: 'Answer Eli' }));
  expect(form.getByText("Your answer replaces auto mode's, and Eli reworks from its saved work.")).toBeTruthy();
  await user.click(form.getByRole('button', { name: /^One story/ }));
  await user.click(form.getByRole('button', { name: 'Change the answer' }));
  expect(await screen.findByText('Answer changed. Eli reworks from its saved work with yours.')).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: '/api/tasks/T-plan/change-answer',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'attempt-ask', option: 0 },
    },
  ]);
  // The answer's records show the director's after auto mode's, which can no longer be changed.
  await waitFor(() => expect(told(section)[0]).toContain("You changed auto mode's answer: One story"));
  expect(region.queryByRole('button', { name: 'Change the answer' })).toBeNull();
  expect(region.queryByRole('form', { name: 'Answer Eli' })).toBeNull();
  cleanup();
  // Once the plan step is done, auto mode's answer stays as it is.
  controller.requests = [];
  controller.attempts = [];
  open([planStep('planned', { answers: [autoAnswer] })]);
  const done = await whatHappened();
  expect(told(done)[0]).toContain('Auto mode answered for you: Two stories');
  expect(within(done).queryByRole('button', { name: 'Change the answer' })).toBeNull();
});

test('a question still waiting has Answer, which opens Today at Your calls, and no answer yet', async () => {
  open([planStep('waiting')]);
  const region = await whatHappened(),
    answer = within(asking(region)).getByRole('link', { name: 'Answer' });
  expect(answer.getAttribute('href')).toBe('/p/project-x#calls');
  expect(told(region)[0]).toEqual([
    'Checks and plan',
    'You sent the idea.',
    'Eli asked you: Split the page part into two stories?',
  ]);
  expect(within(region).queryByRole('button', { name: 'Change the answer' })).toBeNull();
});

test('Only stops and decisions keeps the question and its answer; on a phone, only the stop is a stop', async () => {
  const user = userEvent.setup();
  open([planStep('planned', { answers: [yourAnswer] }), failed('T-1', 'First')]);
  const region = await whatHappened();
  await user.click(within(region).getByRole('button', { name: 'Only stops and decisions' }));
  expect(told(region)).toEqual([
    [
      'Checks and plan',
      'Eli asked you: Split the page part into two stories?',
      'You answered: Two stories — Keep the shared part in the first.',
    ],
    ['Story 1', 'Attempt 1 stopped: The tests failed.'],
  ]);
  expect(within(asking(region)).getByRole('list', { name: "Eli's options" })).toBeTruthy();
  cleanup();
  // On a phone, Stops along the way lists only what stopped; Everything has the question and its answer too.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  controller.requests = [];
  controller.attempts = [];
  open([planStep('planned', { answers: [yourAnswer] }), failed('T-1', 'First')]);
  const stops = await screen.findByRole('region', { name: 'Stops along the way' }, { timeout: 5000 }),
    rows = () => [...stops.querySelectorAll('.sd-row')].map(row => row.lastElementChild?.textContent?.trim());
  expect(rows()).toEqual(['Attempt 1 stopped: The tests failed.']);
  await user.click(within(stops).getByRole('button', { name: 'Everything' }));
  expect(rows()).toContain('Eli asked you: Split the page part into two stories?');
  expect(rows()).toContain('You answered: Two stories — Keep the shared part in the first.');
});

// The idea's checks step, accepted with the source's tests run.
const checksStep = () => {
  controller.attempts.push({
    id: 'attempt-checks',
    taskId: 'T-checks',
    status: 'accepted',
    workerId: 'W-1',
    startedAt: '2026-10-27T09:00:10Z',
    finishedAt: '2026-10-27T09:00:50Z',
  });
  return taskFixture('T-checks', {
    title: 'Check the source',
    kind: 'studio-development:checks',
    status: 'done',
    acceptedAttemptId: 'attempt-checks',
    lastAttemptId: 'attempt-checks',
    workflowReference: { runId: 'run-1', key: 'checks' },
  });
};
// The plan step after the checks, whose only attempt failed.
const failedPlan = () => {
  controller.attempts.push({
    id: 'attempt-plan',
    taskId: 'T-plan',
    status: 'failed',
    workerId: 'W-1',
    startedAt: '2026-10-27T09:01:00Z',
    finishedAt: '2026-10-27T09:04:00Z',
    error: 'The plan named a file twice.',
  });
  return taskFixture('T-plan', {
    title: 'Plan the idea',
    kind: 'studio-development:breakdown',
    status: 'failed',
    lastAttemptId: 'attempt-plan',
    dependencies: ['T-checks'],
    workflowReference: { runId: 'run-1', key: 'plan' },
  });
};
// The planning steps' links as the director reads them: each one's words, where it goes and where its step stands.
const stepsIn = (container: HTMLElement) =>
  within(within(container).getByRole('list', { name: 'Checks and plan' }))
    .getAllByRole('listitem')
    .map(item => {
      const link = within(item).getByRole('link');
      return `${link.textContent} → ${link.getAttribute('href')} · ${item.querySelector('.sd-chip')?.textContent}`;
    });

test("Checks and plan links each planning step's own page, while the plan runs and once it is accepted", async () => {
  open([checksStep(), planStep('planning', { answers: [yourAnswer], dependencies: ['T-checks'] })]);
  const region = await whatHappened();
  expect(stepsIn(region)).toEqual([
    'Open the checks → /p/project-x/tasks/T-checks · Done',
    'Open the plan → /p/project-x/tasks/T-plan · Running',
  ]);
  // The links follow the checks and plan group's lines.
  const list = within(region).getByRole('list', { name: 'Checks and plan' }),
    lines = list.previousElementSibling;
  expect(lines?.classList.contains('sd-timeline')).toBe(true);
  expect(lines?.previousElementSibling?.querySelector('.sd-eyebrow')?.textContent).toBe('Checks and plan');
  // What happened reads as before.
  expect(told(region)[0]![0]).toBe('Checks and plan');
  expect(told(region)[0]).toContain('Eli is working on it now.');
  cleanup();
  // Accepted, with its story proposed: the story keeps its own card and gets no link here.
  controller.requests = [];
  controller.attempts = [];
  open([
    checksStep(),
    planStep('planned', { answers: [yourAnswer], dependencies: ['T-checks'] }),
    planned('T-1', 'First', { dependencies: ['T-plan'] }),
  ]);
  const done = await whatHappened();
  expect(stepsIn(done)).toEqual([
    'Open the checks → /p/project-x/tasks/T-checks · Done',
    'Open the plan → /p/project-x/tasks/T-plan · Done',
  ]);
  expect([...document.querySelectorAll('.sd-storycard__title')].map(item => item.textContent)).toEqual(['First']);
});

// The journey's stations as drawn: each one's words and the icon it shows, told by the icon's own drawing. The page
// tells the Checked and Planned stations apart by their fixed step, so each keeps its icon until it is done.
const stations = async () => {
  const journey = await screen.findByRole('region', { name: 'Journey' }, { timeout: 5000 }),
    drawings = (['check', 'test', 'ideas', 'build', 'flag', 'arrow'] as const).map(
      name => [name, render(<Icon name={name} />, { container: document.createElement('div') }).container] as const,
    );
  return [...journey.querySelectorAll('.sd-journey__station')].map(station => {
    const drawn = station.querySelector('.sd-journey__node svg')?.innerHTML,
      icon = drawings.find(([, container]) => container.querySelector('svg')?.innerHTML === drawn)?.[0];
    return `${station.querySelector('.sd-journey__label')?.textContent}: ${icon}`;
  });
};

test('the journey draws the checks running as a test and the plan running as an idea, each a check once done', async () => {
  controller.attempts.push({
    id: 'attempt-checks',
    taskId: 'T-checks',
    status: 'running',
    workerId: 'W-1',
    startedAt: new Date().toISOString(),
  });
  open([
    taskFixture('T-checks', {
      title: 'Check the source',
      kind: 'studio-development:checks',
      status: 'running',
      lastAttemptId: 'attempt-checks',
      workflowReference: { runId: 'run-1', key: 'checks' },
    }),
  ]);
  expect(await stations()).toEqual(['Sent: check', 'Checked: test']);
  cleanup();
  controller.requests = [];
  controller.attempts = [];
  open([checksStep(), planStep('planning', { answers: [yourAnswer], dependencies: ['T-checks'] })]);
  expect(await stations()).toEqual(['Sent: check', 'Checked: check', 'Planned: ideas']);
});

test('an idea without checks links only its plan, waiting for you while its question does, in either view', async () => {
  const user = userEvent.setup();
  open([planStep('waiting')]);
  const region = await whatHappened();
  expect(stepsIn(region)).toEqual(['Open the plan → /p/project-x/tasks/T-plan · Waiting for you']);
  // The question's own Answer link is unchanged.
  expect(within(asking(region)).getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe('/p/project-x#calls');
  await user.click(within(region).getByRole('button', { name: 'Only stops and decisions' }));
  expect(stepsIn(region)).toEqual(['Open the plan → /p/project-x/tasks/T-plan · Waiting for you']);
});

test('on a phone, the stops end with the planning steps’ own pages, a failed plan reading Stopped', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  open([checksStep(), failedPlan()]);
  const stops = await screen.findByRole('region', { name: 'Stops along the way' }, { timeout: 5000 });
  expect([...stops.querySelectorAll('.sd-row')].map(row => row.lastElementChild?.textContent?.trim())).toEqual([
    'Eli stopped: The plan named a file twice.',
  ]);
  expect(stepsIn(stops)).toEqual([
    'Open the checks → /p/project-x/tasks/T-checks · Done',
    'Open the plan → /p/project-x/tasks/T-plan · Stopped',
  ]);
});

// A story the accepted plan proposed, pinned to the plan step and its accepted attempt as src/core/proposals.mjs
// records it.
const proposedBy = (id: string, extra: Partial<Task> = {}): Partial<Task> => ({
  proposalReference: { taskId: 'T-plan', attemptId: 'attempt-plan', path: 'source-breakdown.json', hash: 'h', key: id },
  dependencies: ['T-plan'],
  ...extra,
});
const acceptedIdea = (second: () => Task) => [
  checksStep(),
  planStep('planned', { dependencies: ['T-checks'] }),
  planned('T-1', 'First', proposedBy('T-1')),
  second(),
];
const talkTo = () => screen.findByRole('region', { name: 'Talk to Eli' }, { timeout: 5000 });
const follows = (first: Element, second: Element) =>
  !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

test("an accepted plan's talk shows before its stories while they all wait, at the page's foot once one moves", async () => {
  open(acceptedIdea(() => planned('T-2', 'Second', proposedBy('T-2', { dependencies: ['T-1'] }))));
  const waiting = await talkTo();
  expect(screen.getAllByRole('region', { name: 'Talk to Eli' })).toEqual([waiting]);
  // Under the journey, before the stories lane and What happened.
  const lane = document.querySelector('.sd-lane')!;
  expect([...lane.querySelectorAll('.sd-storycard__title')].map(title => title.textContent)).toEqual([
    'First',
    'Second',
  ]);
  expect(follows(screen.getByRole('region', { name: 'Journey' }), waiting)).toBe(true);
  expect(follows(waiting, lane)).toBe(true);
  expect(follows(waiting, screen.getByRole('region', { name: 'What happened' }))).toBe(true);
  expect(waiting.parentElement?.lastElementChild).not.toBe(waiting);
  // Once the second story is approved, or has started, the conversation shows only at the page's foot.
  for (const second of [
    () => planned('T-2', 'Second', proposedBy('T-2', { status: 'ready', approval: { status: 'approved' } })),
    () => working('T-2', 'Second', proposedBy('T-2', { approval: { status: 'approved' }, dependencies: ['T-1'] })),
  ]) {
    cleanup();
    controller.requests = [];
    controller.attempts = [];
    open(acceptedIdea(second));
    const region = await talkTo();
    expect(screen.getAllByRole('region', { name: 'Talk to Eli' })).toEqual([region]);
    expect(region.parentElement?.lastElementChild).toBe(region);
    expect(follows(document.querySelector('.sd-lane')!, region)).toBe(true);
    expect(follows(screen.getByRole('region', { name: 'What happened' }), region)).toBe(true);
  }
});

// A landed story whose candidate changed two files, and whose review left the files given (November 2, 2026).
const changed = (reviewFiles: NonNullable<AttemptSummary['artifacts']>) => {
  const story = landed('T-1', 'First', 'a1b2c3d4e5');
  story.sourceStage = { ...story.sourceStage, candidate: { attemptId: 'candidate-T-1' } };
  controller.attempts.push({
    id: 'candidate-T-1',
    taskId: 'T-1',
    status: 'accepted',
    workerId: 'W-1',
    startedAt: '2026-10-27T09:30:00Z',
    finishedAt: '2026-10-27T09:50:00Z',
    assignment: { kind: change },
    sourceCandidate: { diffStat: { files: 2, added: 10, removed: 3 } },
  } as AttemptSummary);
  controller.attempts.find(attempt => attempt.id === 'attempt-T-1')!.artifacts = reviewFiles;
  return story;
};
const produced = async () => within(await screen.findByRole('region', { name: 'What it produced' }, { timeout: 5000 }));

test("a code idea's changes stand alone in What it produced while nothing there is a file to read", async () => {
  open([changed([])]);
  const made = await produced();
  expect(made.getByRole('link', { name: /Story 1's change/ })).toBeTruthy();
  // No pane waits beside the list for a file that isn't there.
  expect(made.queryByRole('region', { name: 'No file open' })).toBeNull();
  expect(made.queryByText('Each of these opens its story.')).toBeNull();
});

test('beside changes that link to their stories, the pane points to the review whose file reads there', async () => {
  const user = userEvent.setup();
  controller.artifacts['attempt-T-1/source-change-review.json'] = JSON.stringify({ verdict: 'pass', findings: [] });
  open([changed([{ path: 'source-change-review.json', hash: 'h-review', kind: 'source-change-review' }])]);
  const made = await produced(),
    pane = made.getByRole('region', { name: 'No file open' });
  expect(within(pane).getByText('Each of these opens its story.')).toBeTruthy();
  await user.click(within(pane).getByRole('button', { name: 'Reviews · 1' }));
  expect(await made.findByRole('heading', { level: 3, name: 'source-change-review.json' })).toBeTruthy();
});
