// The board (the canvas's Board, v1.0 item 23): open work from the live set in five columns, stopped work where it
// stopped, done work's newest first and the rest a page at a time with the choice in the address, and its filters.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Task } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.tasks = [
    taskFixture('T-plan', { title: 'Planned work', status: 'backlog', approval: { status: 'pending' } }),
    taskFixture('T-ready', { title: 'Ready work', status: 'ready', queued: true }),
    taskFixture('T-run', { title: 'Running work', status: 'running', lastAttemptId: 'attempt-run' }),
    taskFixture('T-fail', { title: 'Failed work', status: 'failed' }),
    taskFixture('T-gone', { title: 'Cancelled work', status: 'cancelled' }),
  ];
  controller.attempts = [
    { id: 'attempt-run', taskId: 'T-run', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
  ];
  const done = (id: string) => taskFixture(id, { title: `Accepted ${id}`, status: 'done' });
  controller.settled = {
    accepted: [
      { tasks: [done('T-a1'), done('T-a2')], attempts: [], next: 'T-a2' },
      { tasks: [done('T-a3')], attempts: [], next: null },
    ],
    closed: [
      { tasks: [taskFixture('T-denied', { title: 'Denied work', status: 'denied' })], attempts: [], next: null },
    ],
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x/board') => {
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
const column = async (name: string) => within(await screen.findByRole('region', { name }));
// A card's title, its link's main line.
const titles = (region: ReturnType<typeof within>) =>
  region
    .queryAllByRole('link')
    .map((link: HTMLElement) => link.querySelector('.sd-kcard__title')?.textContent)
    .filter(Boolean);

test('open work stands in its column; stopped work stays where it stopped; done shows its newest', async () => {
  open();
  expect(titles(await column('Planned'))).toEqual(['Planned work']);
  expect(titles(await column('Ready'))).toEqual(['Ready work']);
  // Running work and work that stopped after it started stand in progress.
  expect(titles(await column('In progress')).sort()).toEqual(['Failed work', 'Running work']);
  expect(titles(await column('Review'))).toEqual([]);
  // Done reads its first page and shows its newest three, the rest counted.
  const done = await column('Done');
  await waitFor(() => expect(titles(done)).toEqual(['Accepted T-a1', 'Accepted T-a2']));
  expect(screen.getByRole('button', { name: '2 closed or cancelled' })).toBeTruthy();
  expect(controller.reads().filter(url => url.includes('/settled'))).toEqual([
    '/api/projects/project-x/settled?kind=accepted&limit=0',
    '/api/projects/project-x/settled?kind=accepted&limit=12',
  ]);
  const card = (await column('Ready')).getByRole('link', { name: /Ready work/ });
  expect(card.getAttribute('href')).toBe('/p/project-x/tasks/T-ready');
  // Running work needs no word under the board; the filters count it.
  expect(screen.queryByText('This project is paused.')).toBeNull();
});

test('the filters narrow the board to your calls, what is working or what waits, and a search finds a task', async () => {
  const user = userEvent.setup();
  open();
  expect((await screen.findByRole('button', { name: /^Open work 4/ })).getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: /^Working 1/ }));
  expect(titles(await column('In progress'))).toEqual(['Running work']);
  expect(titles(await column('Done'))).toEqual([]);
  await user.click(screen.getByRole('button', { name: /^Open work/ }));
  await user.type(screen.getByRole('searchbox', { name: 'Find a task' }), 'ready');
  expect(titles(await column('Ready'))).toEqual(['Ready work']);
  expect(titles(await column('Planned'))).toEqual([]);
});

test('more done work keeps the choice in the address and reads it a page at a time', async () => {
  const user = userEvent.setup();
  controller.settled.accepted = [
    {
      tasks: ['T-a1', 'T-a2', 'T-a3', 'T-a4'].map(id => taskFixture(id, { title: `Accepted ${id}`, status: 'done' })),
      attempts: [],
      next: 'T-a4',
    },
    { tasks: [taskFixture('T-a5', { title: 'Accepted T-a5', status: 'done' })], attempts: [], next: null },
  ];
  const router = open();
  const done = await column('Done');
  await waitFor(() => expect(titles(done)).toHaveLength(3));
  await user.click(await screen.findByRole('button', { name: /more done$/ }));
  await waitFor(() => expect(router.history.location.search).toBe('?accepted=true'));
  await waitFor(() => expect(titles(done)).toHaveLength(4));
  await user.click(done.getByRole('button', { name: 'Show more done' }));
  await waitFor(() => expect(titles(done)).toHaveLength(5));
  expect(controller.reads().filter(url => url.includes('/settled?kind=accepted&limit=12'))).toEqual([
    '/api/projects/project-x/settled?kind=accepted&limit=12',
    '/api/projects/project-x/settled?kind=accepted&limit=12&before=T-a4',
  ]);
  await user.click(done.getByRole('button', { name: 'Show only the newest' }));
  await waitFor(() => expect(titles(done)).toHaveLength(3));
});

test('closed and cancelled work joins what is done when shown, from its address', async () => {
  open('/p/project-x/board?closed=true');
  const done = await column('Done');
  await waitFor(() => expect(titles(done)).toEqual(expect.arrayContaining(['Cancelled work', 'Denied work'])));
  expect(screen.getByRole('button', { name: 'Hide 2 closed or cancelled' })).toBeTruthy();
});

test("lanes by idea head each idea's lane with its dot, its words and its details, the whole head opening it", async () => {
  const user = userEvent.setup(),
    words =
      'Make the board read the same way in both of its lane views, so an idea is headed as plainly as a person is',
    member = (id: string, extra: Partial<Task>) =>
      taskFixture(id, {
        title: `Story ${id}`,
        workflowReference: { runId: 'run-1', key: id, id: 'workflow-1', name: 'Fixture flow' },
        ...extra,
      }),
    done = member('T-done', { status: 'done', acceptedAttemptId: 'attempt-done', lastAttemptId: 'attempt-done' }),
    running = member('T-going', { status: 'running', lastAttemptId: 'attempt-going' });
  expect(words.length).toBeGreaterThan(90);
  controller.shell.workers = [{ id: 'W-1', displayName: 'Eli', team: 'Engineering', jobTitle: 'Software engineer' }];
  controller.tasks = [
    done,
    running,
    taskFixture('T-alone', { title: 'Work in no idea', status: 'ready', queued: true }),
  ];
  controller.attempts = [
    { id: 'attempt-done', taskId: 'T-done', status: 'accepted', workerId: 'W-1', startedAt: '2026-10-21T12:01:00Z' },
    { id: 'attempt-going', taskId: 'T-going', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
  ];
  // A run as the controller's run view sends it (src/core/graph.mjs runView), with one node per task.
  controller.runs = [
    {
      id: 'run-1',
      createdAt: '2026-10-21T12:00:00Z',
      brief: `${words}\nThe whole head opens the idea.`,
      workflow: { id: 'workflow-1', name: 'Fixture flow', version: 3 },
      revisions: [{ revision: 1, at: '2026-10-21T12:00:00Z', reason: 'created' }],
      nodes: [done, running].map(task => ({
        taskId: task.id,
        key: task.id,
        kind: task.kind,
        title: task.title,
        workerId: 'W-1',
        dependencies: [],
        revision: 1,
      })),
      archive: { archived: false },
    },
  ];
  controller.settled = { accepted: [], closed: [] };
  open();
  await user.click(await screen.findByRole('button', { name: 'Lanes by idea' }));
  // The idea's lane is named by its words; its head is one link to the idea, holding its dot, words and details.
  const lane = await screen.findByRole('region', { name: words }),
    toIdea = within(lane)
      .getAllByRole('link')
      .filter(link => link.getAttribute('href') === '/p/project-x/runs/run-1');
  expect(toIdea).toHaveLength(1);
  const head = toIdea[0]!;
  expect(head.classList.contains('sd-lanehead__open')).toBe(true);
  expect(head.querySelector('.sd-ideadot')).toBeTruthy();
  expect(head.querySelector('.sd-lanehead__name')?.textContent).toBe(words);
  expect(head.querySelector('.sd-meta')?.textContent).toBe('1 of 2 done · 1 running');
  expect(head.textContent).not.toMatch(/[“”"]|The whole head/);
  // Work in no idea is headed in the same words' place, with no dot and no link.
  const none = (await screen.findByRole('region', { name: 'Not part of an idea' })).querySelector('.sd-lanehead')!;
  expect(none.querySelector('.sd-lanehead__name')?.textContent).toBe('Not part of an idea');
  expect(none.querySelector('.sd-ideadot')).toBeNull();
  expect(none.querySelector('a')).toBeNull();
  // Person lanes keep their heads: the agent's name and job title.
  await user.click(screen.getByRole('button', { name: 'Lanes by person' }));
  const person = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('.sd-lanehead')!;
    within(found).getByText('Eli');
    return found;
  });
  expect(within(person).getByText('Software engineer').className).toBe('sd-meta');
  expect(person.querySelector('.sd-lanehead__open')).toBeNull();
});

test('a paused project says so above the board, and resumes from there', async () => {
  const user = userEvent.setup();
  controller.shell.project.dispatchPaused = true;
  open();
  expect(await screen.findByText('This project is paused.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Resume this project' }));
  await waitFor(() =>
    expect(controller.requests.find(request => request.method === 'POST')).toEqual({
      url: '/api/pipeline',
      method: 'POST',
      body: { projectId: 'project-x', action: 'resume' },
    }),
  );
});

test('a queue that ran empty is no pause: the board says nothing above its columns', async () => {
  // The controller turns pipelineEnabled off when nothing queued is left (pipeline_finished); nobody paused.
  controller.shell.pipelineEnabled = false;
  open();
  expect(titles(await column('Ready'))).toEqual(['Ready work']);
  expect(screen.queryByText('This project is paused.')).toBeNull();
  expect(screen.queryByText('New work is paused in every project.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resume this project' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resume all work' })).toBeNull();
});

test("a restart's pause on queued work reads as this project's pause, resumed from the board", async () => {
  // A restart pauses the project's queued work and marks it so (src/core/orchestrator.mjs).
  Object.assign(controller.shell.project, { dispatchPaused: true, restartPaused: true });
  open();
  expect(await screen.findByText('This project is paused.')).toBeTruthy();
  expect(screen.queryByText('New work is paused in every project.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Resume this project' })).toBeTruthy();
});

test('new work paused in every project says so, and resumes everywhere', async () => {
  const user = userEvent.setup();
  controller.shell.paused = true;
  open();
  expect(await screen.findByText('New work is paused in every project.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Resume all work' }));
  await waitFor(() =>
    expect(controller.requests.find(request => request.method === 'POST')).toEqual({
      url: '/api/control',
      method: 'POST',
      body: { projectId: 'project-x', paused: false },
    }),
  );
});
