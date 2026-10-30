// The board (the canvas's Board, v1.0 item 23): open work from the live set in five columns, stopped work where it
// stopped, done work's newest first and the rest a page at a time with the choice in the address, and its filters.
// An idea still planning has one card of its own, in place of its checks' and plan's.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CommandRecords, Task } from './api';
import { columnOf, columns } from './board';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, whenShown, type Controller } from './test-controller';

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

test('a Review card the controller holds reads Waiting with its reason; a result for the director reads Accept?', async () => {
  const user = userEvent.setup(),
    reason = 'Waiting for a studio execution slot.';
  controller.tasks = [
    // A built candidate the controller moved on to its review, queued for a free slot.
    taskFixture('T-held', {
      title: 'Held story',
      kind: 'studio-development:change',
      status: 'ready',
      queued: true,
      controllerWait: true,
      reason,
      lastAttemptId: 'attempt-built',
      acceptedAttemptId: 'attempt-built',
      sourceStage: {
        version: 'source-story-stages-v1',
        history: [],
        phase: 'candidate-review',
        current: 'candidate-review',
        candidate: { taskId: 'T-held', attemptId: 'attempt-built' },
      },
    }),
    // A completed result that waits for the director's acceptance.
    taskFixture('T-result', { title: 'Finished work', status: 'review', lastAttemptId: 'attempt-result' }),
  ];
  controller.attempts = [
    {
      id: 'attempt-built',
      taskId: 'T-held',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: '2026-10-21T12:01:00Z',
      finishedAt: '2026-10-21T12:20:00Z',
      assignment: { kind: 'studio-development:change' },
    },
    {
      id: 'attempt-result',
      taskId: 'T-result',
      status: 'review',
      workerId: 'W-1',
      startedAt: '2026-10-21T12:01:00Z',
      finishedAt: '2026-10-21T12:20:00Z',
      result: { outcome: 'completed', summary: 'Done.' },
    },
  ];
  controller.settled = { accepted: [], closed: [] };
  open();
  const review = await column('Review');
  await waitFor(() => expect(titles(review).sort()).toEqual(['Finished work', 'Held story']));
  const chip = (title: string) =>
    review.getByRole('link', { name: new RegExp(title) }).querySelector('.sd-kcard__top .sd-chip')!;
  expect(chip('Held story').textContent).toBe('Waiting');
  expect(chip('Held story').getAttribute('title')).toBe(reason);
  expect(chip('Finished work').textContent).toBe('Accept?');
  expect(chip('Finished work').getAttribute('title')).toBeNull();
  // The list's chip says the same, with the same reason.
  await user.click(screen.getByRole('button', { name: 'List' }));
  const row = (await screen.findByRole('link', { name: 'Held story' })).closest('tr')!;
  expect(row.querySelector('.sd-chip')?.textContent).toBe('Waiting');
  expect(row.querySelector('.sd-chip')?.getAttribute('title')).toBe(reason);
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

test("lanes by idea keep a finished idea's stories in its own lane, headed as an open idea's lane is", async () => {
  const user = userEvent.setup(),
    words = 'Keep finished stories in their idea’s lane, wherever the board reads them from';
  controller.tasks = [taskFixture('T-alone', { title: 'Work in no idea', status: 'ready', queued: true })];
  controller.attempts = [];
  controller.runs = [];
  // A page of settled work holds a story whose idea has finished, and names that idea; no live run holds it.
  controller.settled = {
    accepted: [
      {
        tasks: [
          taskFixture('T-old', {
            title: 'Finished story',
            status: 'done',
            workflowReference: { runId: 'run-old', key: 'T-old', id: 'workflow-1', name: 'Fixture flow' },
          }),
          taskFixture('T-loose', { title: 'Finished work in no idea', status: 'done' }),
        ],
        attempts: [],
        next: null,
        ideas: [
          { id: 'run-old', brief: `${words}\nIts second line.`, createdAt: '2026-10-20T12:00:00Z', taskIds: ['T-old'] },
        ],
      },
    ],
    closed: [],
  };
  open();
  await user.click(await screen.findByRole('button', { name: 'Lanes by idea' }));
  // Its lane is named by the idea's words, and its head is one link to the idea, holding its dot and words.
  const lane = await screen.findByRole('region', { name: words });
  expect(titles(within(lane))).toEqual(['Finished story']);
  const toIdea = within(lane)
    .getAllByRole('link')
    .filter(link => link.getAttribute('href') === '/p/project-x/runs/run-old');
  expect(toIdea).toHaveLength(1);
  const head = toIdea[0]!;
  expect(head.classList.contains('sd-lanehead__open')).toBe(true);
  expect(head.querySelector('.sd-ideadot')).toBeTruthy();
  expect(head.querySelector('.sd-lanehead__name')?.textContent).toBe(words);
  // It counts none of the idea's stories, which the board has not all read.
  expect(head.querySelector('.sd-meta')?.textContent).toBe('Finished');
  // Only work in no idea at all, open or settled, is not part of one; its head has no dot and no link.
  const none = await screen.findByRole('region', { name: 'Not part of an idea' });
  expect(titles(within(none)).sort()).toEqual(['Finished work in no idea', 'Work in no idea']);
  const noneHead = none.querySelector('.sd-lanehead')!;
  expect(noneHead.querySelector('.sd-ideadot')).toBeNull();
  expect(noneHead.querySelector('a')).toBeNull();
  // The list names the idea too.
  await user.click(screen.getByRole('button', { name: 'List' }));
  const row = (await screen.findByRole('link', { name: 'Finished story' })).closest('tr')!;
  expect(within(row).getByText('“Keep finished stories in their…”')).toBeTruthy();
});

test("lanes by idea show an idea's lane only while it has cards shown, a finished idea the live set names too", async () => {
  const user = userEvent.setup(),
    member = (id: string, runId: string, extra: Partial<Task>) =>
      taskFixture(id, { workflowReference: { runId, key: id, id: 'workflow-1', name: 'Fixture flow' }, ...extra }),
    // The live set holds a finished idea's story as a direct prerequisite of open work, and names that idea.
    earlier = member('T-earlier', 'run-old', { title: 'Earlier story', status: 'done' }),
    going = member('T-going', 'run-1', {
      title: 'Open story',
      status: 'running',
      lastAttemptId: 'attempt-going',
      dependencies: ['T-earlier'],
    });
  controller.tasks = [
    earlier,
    going,
    taskFixture('T-alone', { title: 'Work in no idea', status: 'ready', queued: true }),
  ];
  controller.attempts = [
    { id: 'attempt-going', taskId: 'T-going', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
  ];
  controller.runs = [
    {
      id: 'run-1',
      createdAt: '2026-10-21T12:00:00Z',
      brief: 'Open idea',
      workflow: { id: 'workflow-1', name: 'Fixture flow', version: 3 },
      revisions: [{ revision: 1, at: '2026-10-21T12:00:00Z', reason: 'created' }],
      nodes: [
        {
          taskId: going.id,
          key: going.id,
          kind: going.kind,
          title: going.title,
          workerId: 'W-1',
          dependencies: [],
          revision: 1,
        },
      ],
      archive: { archived: false },
    },
  ];
  controller.ideas = [
    { id: 'run-old', brief: 'Finished idea', createdAt: '2026-10-20T12:00:00Z', taskIds: ['T-earlier'] },
  ];
  controller.settled = { accepted: [], closed: [] };
  open();
  await user.click(await screen.findByRole('button', { name: 'Lanes by idea' }));
  expect(titles(within(await screen.findByRole('region', { name: 'Open idea' })))).toEqual(['Open story']);
  const finished = await screen.findByRole('region', { name: 'Finished idea' });
  expect(titles(within(finished))).toEqual(['Earlier story']);
  expect(finished.querySelector('.sd-lanehead__open')?.getAttribute('href')).toBe('/p/project-x/runs/run-old');
  // A search that hides every card of both ideas leaves neither idea's lane, open or finished.
  const search = screen.getByRole('searchbox', { name: 'Find a task' });
  await user.type(search, 'no idea');
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Finished idea' })).toBeNull());
  expect(screen.queryByRole('region', { name: 'Open idea' })).toBeNull();
  expect(titles(within(screen.getByRole('region', { name: 'Not part of an idea' })))).toEqual(['Work in no idea']);
  // One that hides the work in no idea leaves no lane for it either.
  await user.clear(search);
  await user.type(search, 'earlier');
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Not part of an idea' })).toBeNull());
  expect(screen.queryByRole('region', { name: 'Open idea' })).toBeNull();
  expect(titles(within(screen.getByRole('region', { name: 'Finished idea' })))).toEqual(['Earlier story']);
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

// A command's answer carries the records it changed (records.ts RecordSync.answer), so the board moves the card with
// the command's toast, before the stream's change event for it, which changes nothing more.
const standing = () =>
  Object.fromEntries(
    ['Planned', 'Ready'].map(name => {
      const region = screen.getByRole('region', { name });
      return [
        name,
        { cards: titles(within(region)).sort(), count: region.querySelector('.sd-colhead__count')?.textContent },
      ];
    }),
  );
// Drag data as a browser keeps it, which jsdom lacks: what the card's drag start sets, the drop reads.
const dragData = () => {
  const data: Record<string, string> = {},
    types: string[] = [];
  return {
    types,
    setData: (type: string, value: string) => {
      if (!(type in data)) types.push(type);
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? '',
  };
};
const dragToReady = async (title: string) => {
  const dataTransfer = dragData(),
    ready = screen.getByRole('region', { name: 'Ready' });
  fireEvent.dragStart((await column('Planned')).getByRole('link', { name: new RegExp(title) }), { dataTransfer });
  fireEvent.dragOver(ready, { dataTransfer });
  fireEvent.drop(ready, { dataTransfer });
};
const before = {
  Planned: { cards: ['Planned work'], count: '1' },
  Ready: { cards: ['Ready work'], count: '1' },
};

test("approving a Planned card moves it to its approved status's column with both counts, before any live update", async () => {
  let answer: CommandRecords | undefined;
  controller.command = url => {
    if (url !== '/api/tasks/T-plan/approve-work') return {};
    // Approved, and queued by the house rules (src/core/proposals.mjs approveWork, autonomy approved).
    controller.tasks = controller.tasks.map(task =>
      task.id === 'T-plan'
        ? { ...task, status: 'ready', approval: { status: 'approved', by: { type: 'director' } }, queued: true }
        : task,
    );
    answer = controller.records(['T-plan']);
    return { ok: true, records: answer };
  };
  open();
  await waitFor(() => expect(standing()).toEqual(before));
  const reads = controller.reads().length,
    seen = whenShown('Approved. It joins Ready.', () => ({
      standing: standing(),
      reads: controller.reads().slice(reads),
    }));
  await dragToReady('Planned work');
  // The approved task's status stands in Ready.
  const approved = controller.tasks.find(task => task.id === 'T-plan')!;
  expect(columns.find(item => item.id === columnOf(approved))?.name).toBe('Ready');
  // With the toast, the card has moved and both counts changed, with nothing read again.
  expect(await seen).toEqual({
    standing: { Planned: { cards: [], count: '0' }, Ready: { cards: ['Planned work', 'Ready work'], count: '2' } },
    reads: [],
  });
  // The stream's change for the same command reads the task again and leaves the board as it is.
  latest().emit('change', { version: answer!.version, start: answer!.start, changes: answer!.changes });
  await waitFor(() => expect(controller.reads().slice(reads)).toEqual(['/api/tasks/T-plan?projectId=project-x']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(standing()).toEqual({
    Planned: { cards: [], count: '0' },
    Ready: { cards: ['Planned work', 'Ready work'], count: '2' },
  });
});

test("a refused approval leaves the card in Planned and both counts as they were, with the controller's reason", async () => {
  controller.command = () => {
    throw new Error('Only pending Planned work can be approved.');
  };
  open();
  await waitFor(() => expect(standing()).toEqual(before));
  const seen = whenShown('Only pending Planned work can be approved.', standing);
  await dragToReady('Planned work');
  expect(await seen).toEqual(before);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(standing()).toEqual(before);
  expect(controller.requests.filter(request => request.method === 'POST').map(request => request.url)).toEqual([
    '/api/tasks/T-plan/approve-work',
  ]);
});

// A code idea as the controller sends it while it plans: its checks, by Avery, then its plan, by Mara, in its run's
// graph (src/core/graph.mjs runView), with the stories the plan proposed once it has.
const ideaWords = 'Show where an idea’s planning stands on its own card';
const planningIdea = (checks: Partial<Task>, plan: Partial<Task>, stories: Task[] = []) => {
  const member = (id: string, extra: Partial<Task>) =>
      taskFixture(id, {
        workflowReference: { runId: 'run-1', key: id, id: 'workflow-1', name: 'Fixture flow' },
        ...extra,
      }),
    steps = [
      member('T-checks', { title: 'Check the source', kind: 'studio-development:checks', workerId: 'W-3', ...checks }),
      member('T-breakdown', {
        title: 'Plan the idea into stories',
        kind: 'studio-development:breakdown',
        workerId: 'W-4',
        dependencies: ['T-checks'],
        ...plan,
      }),
    ];
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-3', displayName: 'Avery', team: 'Engineering' },
    { id: 'W-4', displayName: 'Mara', team: 'Engineering' },
  ];
  controller.tasks = [...steps, ...stories];
  controller.runs = [
    {
      id: 'run-1',
      createdAt: '2026-10-21T12:00:00Z',
      brief: `${ideaWords}\nIts second line.`,
      workflow: { id: 'workflow-1', name: 'Fixture flow', version: 3 },
      revisions: [{ revision: 1, at: '2026-10-21T12:00:00Z', reason: 'created' }],
      nodes: [...steps, ...stories].map(task => ({
        taskId: task.id,
        key: task.id,
        kind: task.kind,
        title: task.title,
        workerId: task.workerId,
        dependencies: task.dependencies ?? [],
        revision: 1,
      })),
      archive: { archived: false },
    },
  ];
  controller.settled = { accepted: [], closed: [] };
  return steps;
};
const stepTitles = ['Check the source', 'Plan the idea into stories'];
// Every card the board shows, in its columns or under any lanes, and every row of its list.
const shownCards = () =>
  [...document.querySelectorAll<HTMLElement>('a.sd-kcard, tbody tr')].map(item => ({
    eyebrow: item.querySelector('.sd-eyebrow')?.textContent,
    title: item.querySelector('.sd-kcard__title')?.textContent ?? item.querySelector('a')?.textContent,
    href: item.getAttribute('href') ?? item.querySelector('a')?.getAttribute('href'),
  }));
// No card or row for the idea's checks or plan, and exactly one for the idea, which opens it.
const onlyTheIdea = () => {
  const shown = shownCards();
  expect(shown.filter(item => stepTitles.includes(item.title ?? ''))).toEqual([]);
  expect(shown.filter(item => ['Checks', 'Plan'].includes(item.eyebrow ?? ''))).toEqual([]);
  expect(shown.filter(item => item.title === ideaWords)).toEqual([
    { eyebrow: 'Idea', title: ideaWords, href: '/p/project-x/runs/run-1' },
  ]);
  for (const title of stepTitles) expect(document.querySelector('.sd-boardpage')!.textContent).not.toContain(title);
};
const ideaCard = async () => (await column('Planned')).getByRole('link', { name: new RegExp(ideaWords) });

test('an idea whose checks run and whose plan is queued has one card of its own reading Planning, under any lanes and in the list', async () => {
  const user = userEvent.setup();
  planningIdea({ status: 'running', lastAttemptId: 'attempt-checks' }, { queued: true });
  controller.tasks.push(taskFixture('T-alone', { title: 'Work in no idea', status: 'ready', queued: true }));
  controller.attempts = [
    {
      id: 'attempt-checks',
      taskId: 'T-checks',
      status: 'running',
      workerId: 'W-3',
      startedAt: new Date(Date.now() - 6 * 60000).toISOString(),
    },
  ];
  open();
  await waitFor(async () => expect(titles(await column('Planned'))).toEqual([ideaWords]));
  const card = await ideaCard();
  expect(card.getAttribute('href')).toBe('/p/project-x/runs/run-1');
  expect(card.querySelector('.sd-eyebrow')?.textContent).toBe('Idea');
  expect(card.querySelector('.sd-kcard__top .sd-chip')?.textContent).toBe('Planning');
  expect(card.classList.contains('sd-kcard--live')).toBe(true);
  // The planner's name and the minutes since the checks started; no question or stop under the title.
  expect(card.querySelector('.sd-kcard__foot')?.textContent).toBe('Mara · 6 min');
  expect(card.querySelector('.sd-kcard__title + .sd-meta')).toBeNull();
  // It opens the idea; it is not dragged.
  expect(card.getAttribute('draggable')).toBeNull();
  expect(titles(await column('In progress'))).toEqual([]);
  expect(titles(await column('Ready'))).toEqual(['Work in no idea']);
  onlyTheIdea();
  // The step runs, so Working counts it.
  await user.click(screen.getByRole('button', { name: /^Working 1/ }));
  expect(titles(await column('Planned'))).toEqual([ideaWords]);
  await user.click(screen.getByRole('button', { name: /^Open work 2/ }));
  // A search finds it by the idea's words, its second line too, and not by its steps' titles.
  const search = screen.getByRole('searchbox', { name: 'Find a task' });
  await user.type(search, 'second line');
  await waitFor(async () => expect(titles(await column('Ready'))).toEqual([]));
  expect(titles(await column('Planned'))).toEqual([ideaWords]);
  await user.clear(search);
  await user.type(search, 'Check the source');
  await waitFor(async () => expect(titles(await column('Planned'))).toEqual([]));
  await user.clear(search);
  // Lanes by idea put it in its idea's lane, with nothing of its checks or plan.
  await user.click(screen.getByRole('button', { name: 'Lanes by idea' }));
  const lane = await screen.findByRole('region', { name: ideaWords });
  expect(titles(within(lane))).toEqual([ideaWords]);
  expect(titles(within(screen.getByRole('region', { name: 'Not part of an idea' })))).toEqual(['Work in no idea']);
  onlyTheIdea();
  // Lanes by person put it with the planner.
  await user.click(screen.getByRole('button', { name: 'Lanes by person' }));
  const mara = await waitFor(() => {
    const head = [...document.querySelectorAll<HTMLElement>('.sd-lanehead')].find(item =>
      item.textContent?.includes('Mara'),
    );
    expect(head).toBeTruthy();
    return head!.closest('section')!;
  });
  expect(titles(within(mara))).toEqual([ideaWords]);
  onlyTheIdea();
  // The list's row opens the idea too, and reads Planning.
  await user.click(screen.getByRole('button', { name: 'List' }));
  const row = (await screen.findByRole('link', { name: ideaWords })).closest('tr')!;
  expect(within(row).getByRole('link', { name: ideaWords }).getAttribute('href')).toBe('/p/project-x/runs/run-1');
  expect(row.querySelector('.sd-chip')?.textContent).toBe('Planning');
  expect(within(row).getByText('Mara · 6 min')).toBeTruthy();
  onlyTheIdea();
});

test("a plan blocked on an unanswered question: the idea card reads Waiting for you, the question's first line, and is a call", async () => {
  const user = userEvent.setup();
  planningIdea(
    { status: 'done', lastAttemptId: 'attempt-checks', acceptedAttemptId: 'attempt-checks' },
    { status: 'blocked', lastAttemptId: 'attempt-ask' },
  );
  controller.attempts = [
    {
      id: 'attempt-checks',
      taskId: 'T-checks',
      status: 'accepted',
      workerId: 'W-3',
      startedAt: '2026-10-21T12:01:00Z',
      finishedAt: '2026-10-21T12:03:00Z',
    },
    {
      id: 'attempt-ask',
      taskId: 'T-breakdown',
      status: 'blocked',
      workerId: 'W-4',
      startedAt: '2026-10-21T12:04:00Z',
      finishedAt: '2026-10-21T12:05:00Z',
      question: {
        ask: 'Split the page part into two stories?\nTwo pages share it, so either way works.',
        why: 'Two pages share it.',
        options: [{ label: 'One story' }, { label: 'Two stories', detail: 'one a page' }],
        recommended: 1,
        choice: 'inside-story',
        topics: [],
      },
    },
  ];
  open();
  await user.click(await screen.findByRole('button', { name: /^Your calls 1/ }));
  await waitFor(async () => expect(titles(await column('Planned'))).toEqual([ideaWords]));
  const card = await ideaCard();
  expect(card.querySelector('.sd-kcard__top .sd-chip')?.textContent).toBe('Waiting for you');
  expect(card.classList.contains('sd-kcard--you')).toBe(true);
  expect(card.querySelector('.sd-kcard__title + .sd-meta')?.textContent).toBe('Split the page part into two stories?');
  expect(card.textContent).not.toContain('Two pages share it');
  expect(card.querySelector('.sd-kcard__foot')?.textContent).toBe('Mara');
  expect(card.getAttribute('href')).toBe('/p/project-x/runs/run-1');
  onlyTheIdea();
  // Its accepted checks have no Done card.
  await user.click(screen.getByRole('button', { name: /^Open work/ }));
  expect(titles(await column('Done'))).toEqual([]);
  onlyTheIdea();
});

test("a failed plan: the idea card reads Stopped with the plan step's reason and what to do, not '<name> stopped'", async () => {
  planningIdea(
    { status: 'done', lastAttemptId: 'attempt-checks', acceptedAttemptId: 'attempt-checks' },
    { status: 'failed', lastAttemptId: 'attempt-plan' },
  );
  controller.attempts = [
    {
      id: 'attempt-checks',
      taskId: 'T-checks',
      status: 'accepted',
      workerId: 'W-3',
      startedAt: '2026-10-21T12:01:00Z',
      finishedAt: '2026-10-21T12:03:00Z',
    },
    {
      id: 'attempt-plan',
      taskId: 'T-breakdown',
      status: 'failed',
      workerId: 'W-4',
      startedAt: '2026-10-21T12:04:00Z',
      finishedAt: '2026-10-21T12:07:00Z',
      error: 'The plan was not valid.',
    },
  ];
  open();
  await waitFor(async () => expect(titles(await column('Planned'))).toEqual([ideaWords]));
  const card = await ideaCard(),
    chip = card.querySelector('.sd-kcard__top .sd-chip')!;
  expect(chip.textContent).toBe('Stopped');
  expect(chip.classList.contains('sd-chip--bad')).toBe(true);
  expect(card.querySelector('.sd-kcard__title + .sd-meta')?.textContent).toBe(
    'The attempt stopped without a validated completed result. Inspect the validation detail, correct the output or scope, then use Start assignment.',
  );
  expect(card.textContent).not.toMatch(/Mara stopped|\w stopped:/);
  expect(titles(await column('In progress'))).toEqual([]);
  onlyTheIdea();
});

test('once the plan is official the idea has no card of its own, its stories stand in Planned, and its steps none in Done', async () => {
  const story = (id: string, title: string) =>
      taskFixture(id, {
        title,
        kind: 'studio-development:change',
        status: 'backlog',
        approval: { status: 'pending' },
        proposalReference: { taskId: 'T-breakdown', attemptId: 'attempt-plan', key: id },
      }),
    steps = planningIdea(
      { status: 'done', lastAttemptId: 'attempt-checks', acceptedAttemptId: 'attempt-checks' },
      {
        status: 'done',
        lastAttemptId: 'attempt-plan',
        acceptedAttemptId: 'attempt-plan',
        proposedTaskIds: ['T-s1', 'T-s2'],
      },
      [story('T-s1', 'Story one'), story('T-s2', 'Story two')],
    ),
    attempts = [
      {
        id: 'attempt-checks',
        taskId: 'T-checks',
        status: 'accepted',
        workerId: 'W-3',
        startedAt: '2026-10-21T12:01:00Z',
        finishedAt: '2026-10-21T12:03:00Z',
      },
      {
        id: 'attempt-plan',
        taskId: 'T-breakdown',
        status: 'accepted',
        workerId: 'W-4',
        startedAt: '2026-10-21T12:04:00Z',
        finishedAt: '2026-10-21T12:07:00Z',
      },
    ];
  controller.attempts = attempts;
  // A page of settled work holds the accepted checks and plan too, and names their idea, with other accepted work.
  controller.settled = {
    accepted: [
      {
        tasks: [...steps, taskFixture('T-other', { title: 'Other accepted work', status: 'done' })],
        attempts,
        next: null,
        ideas: [
          {
            id: 'run-1',
            brief: ideaWords,
            createdAt: '2026-10-21T12:00:00Z',
            taskIds: ['T-checks', 'T-breakdown', 'T-s1', 'T-s2'],
          },
        ],
      },
    ],
    closed: [],
  };
  open();
  const planned = await column('Planned');
  await waitFor(() => expect(titles(planned)).toEqual(['Story one', 'Story two']));
  const links = planned.getAllByRole('link');
  expect(links.map(link => link.querySelector('.sd-eyebrow')?.textContent)).toEqual(['Story 1', 'Story 2']);
  expect(links.map(link => link.getAttribute('href'))).toEqual(['/p/project-x/tasks/T-s1', '/p/project-x/tasks/T-s2']);
  // Done shows the other work alone and counts only it, of the three the controller counts, so it has no more to ask
  // for.
  const done = await column('Done'),
    doneHead = screen.getByRole('region', { name: 'Done' }).querySelector('.sd-colhead__count')!;
  await waitFor(() => expect(titles(done)).toEqual(['Other accepted work']));
  await waitFor(() => expect(controller.reads()).toContain('/api/projects/project-x/settled?kind=accepted&limit=0'));
  await waitFor(() => expect(doneHead.textContent).toBe('1'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(doneHead.textContent).toBe('1');
  expect(screen.queryByRole('button', { name: /more done$/ })).toBeNull();
  const shown = shownCards();
  expect(shown.filter(item => item.eyebrow === 'Idea' || item.href === '/p/project-x/runs/run-1')).toEqual([]);
  expect(
    shown.filter(item => stepTitles.includes(item.title ?? '') || ['Checks', 'Plan'].includes(item.eyebrow ?? '')),
  ).toEqual([]);
});
