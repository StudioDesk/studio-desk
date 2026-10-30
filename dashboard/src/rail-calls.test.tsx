// The project rail's calls (the attention indicator, October 29): each tile counts its project's calls by Today's
// rule, the open project's from its own records and every other project's from its shell and live set, read once and
// read again only a moment after the stream's `projects` event names it, at most once a second; the tab's title
// counts them all.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, Live, Shell, Task } from './api';
import { App } from './app';
import { ProjectLive } from './live-context';
import { useRailCalls } from './rail-calls';
import { createAppRouter } from './router';
import { StreamFactoryContext } from './stream-context';
import { liveSummary } from './studio-runs';
import { createStream, fakeController, latest, shellFixture, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const open = (path = '/p/project-x') =>
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={client()}
      createStream={createStream}
    />,
  );

// Project Y's shell: the same projects, Eli working with Claude Code, and a usage limit that resets on its own.
const projectY = (): Shell => ({
  ...shellFixture(),
  project: { id: 'project-y', name: 'Project Y' },
  workers: [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Ada', team: 'Engineering', provider: 'claude' },
  ],
  quota: { claude: true },
  quotaResets: { claude: '2026-10-30T18:00:00.000Z' },
});
const plan = (id = 'T-plan') =>
  taskFixture(id, { title: 'Plan the rail', status: 'backlog', approval: { status: 'pending' } });
const result = (): [Task, AttemptSummary] => [
  taskFixture('T-result', { title: 'Show the badge', status: 'review', lastAttemptId: 'attempt-result' }),
  {
    id: 'attempt-result',
    taskId: 'T-result',
    status: 'review',
    workerId: 'W-1',
    result: { outcome: 'completed', summary: 'The badge shows.' },
  },
];
// Work that never needs the director: running, held by a usage limit with a known reset, waiting on another story.
const waits = (): [Task[], AttemptSummary[]] => [
  [
    taskFixture('T-run', { title: 'Build the board', status: 'running', lastAttemptId: 'attempt-run' }),
    taskFixture('T-held', { title: 'Held work', status: 'ready', queued: true, workerId: 'W-2' }),
    taskFixture('T-wait', { title: 'Waiting on the board', status: 'blocked', queued: true, dependencies: ['T-run'] }),
  ],
  [{ id: 'attempt-run', taskId: 'T-run', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() }],
];
// Project Y's live set with the director's calls given and every kind of wait beside them.
const liveY = (calls: { tasks: Task[]; attempts: AttemptSummary[] }): Live => {
  const [tasks, attempts] = waits();
  return { tasks: [...calls.tasks, ...tasks], attempts: [...calls.attempts, ...attempts], runs: [] };
};
const twoCalls = () => {
  const [task, attempt] = result();
  return liveY({ tasks: [plan(), task], attempts: [attempt] });
};
const oneCall = () => liveY({ tasks: [plan()], attempts: [] });
const noCalls = () => liveY({ tasks: [], attempts: [] });

const rail = () => within(screen.getByRole('navigation', { name: 'Projects' }));
const tiles = () =>
  rail()
    .getAllByRole('link')
    .filter(link => link.classList.contains('sd-rail__tile'))
    .map(link => ({
      label: link.getAttribute('aria-label'),
      title: link.getAttribute('title'),
      badge: link.querySelector('.sd-rail__badge')?.textContent ?? null,
    }));
const readsOf = (url: string) => controller.reads().filter(read => read === url).length;
const liveReads = () => readsOf('/api/projects/project-y/live');
const shellReads = () => readsOf('/api/projects/project-y/shell');
// Fake time from here on: timers and the clock move only when the test passes time.
const fakeTime = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
// Time for a read's answer to reach the page: the query cache passes it on in timers of its own.
const settle = () => pass(20);
const named = (...projectIds: string[]) => latest().emit('projects', { projectIds });

test("another project's tile counts its calls by Today's rule, and leaves its waits out", async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  open();
  const tile = await screen.findByRole('link', { name: 'Project Y: 2 calls for you' });
  expect(tile.getAttribute('title')).toBe('Project Y: 2 calls for you');
  expect(tile.querySelector('.sd-rail__badge')?.textContent).toBe('2');
  expect(tile.querySelector('.sd-rail__badge')?.getAttribute('aria-hidden')).toBe('true');
  // The figure Today's Your calls shows for the same shell and live set, with the running work, the usage limit and
  // the work waiting on another story left out.
  expect(liveSummary({ ...projectY(), ...twoCalls() }).decisions).toBe(2);
  expect(liveSummary({ ...projectY(), ...noCalls() }).decisions).toBe(0);
  // The open project, with nothing for the director, keeps its plain name.
  expect(tiles()).toEqual([
    { label: 'Project X', title: 'Project X', badge: null },
    { label: 'Project Y: 2 calls for you', title: 'Project Y: 2 calls for you', badge: '2' },
  ]);
  expect(document.title).toBe('(2) Studio desk');
});

test('one call reads in the singular, and a project with only waits has no badge', async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = oneCall();
  open();
  expect(await screen.findByRole('link', { name: 'Project Y: 1 call for you' })).toBeTruthy();
  expect(tiles()[1]).toEqual({ label: 'Project Y: 1 call for you', title: 'Project Y: 1 call for you', badge: '1' });
  cleanup();
  controller.lives['project-y'] = noCalls();
  open();
  await waitFor(() => expect(liveReads()).toBe(2));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(tiles()).toEqual([
    { label: 'Project X', title: 'Project X', badge: null },
    { label: 'Project Y', title: 'Project Y', badge: null },
  ]);
  expect(document.title).toBe('Studio desk');
});

test("the open project's tile counts from its own live records, and the title counts every project", async () => {
  controller.tasks = [taskFixture('T-1', { title: 'Waiting to start' })];
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  open();
  expect(await screen.findByRole('link', { name: 'Project X: 1 call for you' })).toBeTruthy();
  await screen.findByRole('link', { name: 'Project Y: 2 calls for you' });
  expect(tiles().map(tile => tile.badge)).toEqual(['1', '2']);
  // The sidebar's Needs you count stays the open project's own.
  expect(screen.getAllByLabelText('1 call for you')).toHaveLength(2);
  expect(document.title).toBe('(3) Studio desk');
  // The open project's records change through its own stream, which the rail follows.
  controller.tasks = [];
  latest().emit('change', { version: 2, start: 'start-a', changes: [{ seq: 2, type: 'run', id: 'run-1' }] });
  await waitFor(() => expect(document.title).toBe('(2) Studio desk'));
  expect(tiles()[0]).toEqual({ label: 'Project X', title: 'Project X', badge: null });
  // Project Y's calls leave too, after the event naming it.
  controller.lives['project-y'] = noCalls();
  named('project-y');
  await waitFor(() => expect(document.title).toBe('Studio desk'));
  expect(tiles()[1]).toEqual({ label: 'Project Y', title: 'Project Y', badge: null });
});

test('each other project is read once, and again only a moment after an event names it', async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = oneCall();
  open();
  await screen.findByRole('link', { name: 'Project Y: 1 call for you' });
  expect([shellReads(), liveReads()]).toEqual([1, 1]);
  fakeTime();
  // No event, no read, however long the page stays open.
  await pass(10 * 60_000);
  expect([shellReads(), liveReads()]).toEqual([1, 1]);
  // The records change and the stream names the project: its shell and live set are read again a moment later.
  controller.lives['project-y'] = twoCalls();
  named('project-y');
  await pass(249);
  expect(liveReads()).toBe(1);
  await pass(1);
  expect([shellReads(), liveReads()]).toEqual([2, 2]);
  await settle();
  expect(tiles()[1]).toEqual({ label: 'Project Y: 2 calls for you', title: 'Project Y: 2 calls for you', badge: '2' });
  expect(document.title).toBe('(2) Studio desk');
});

test('events within a second make one read, and an event soon after a read waits until the second is up', async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = oneCall();
  open();
  await screen.findByRole('link', { name: 'Project Y: 1 call for you' });
  fakeTime();
  // Three events close together: one read, 250 ms after the first.
  named('project-y');
  await pass(100);
  named('project-y');
  await pass(100);
  named('project-y', 'project-y');
  await pass(49);
  expect(liveReads()).toBe(1);
  await pass(1);
  expect(liveReads()).toBe(2);
  // 50 ms after that read: this one waits until a second after it, 950 ms on.
  await pass(50);
  named('project-y');
  await pass(949);
  expect(liveReads()).toBe(2);
  // Another event while one waits joins it.
  named('project-y');
  await pass(1);
  expect(liveReads()).toBe(3);
  await pass(5_000);
  expect([shellReads(), liveReads()]).toEqual([3, 3]);
  // Long after the last read, an event waits only the moment.
  named('project-y');
  await pass(249);
  expect(liveReads()).toBe(3);
  await pass(1);
  expect(liveReads()).toBe(4);
});

test('an event naming the open project or one the rail does not list reads nothing', async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = oneCall();
  open();
  await screen.findByRole('link', { name: 'Project Y: 1 call for you' });
  const reads = controller.reads().length;
  fakeTime();
  named('project-x', 'project-z');
  await pass(5_000);
  expect(controller.reads().slice(reads)).toEqual([]);
});

test('a failed read of another project leaves its tile without a number and shows no error', async () => {
  // Project Y is unknown to the controller: its reads fail.
  controller.tasks = [taskFixture('T-1', { title: 'Waiting to start' })];
  open();
  await screen.findByRole('link', { name: 'Project X: 1 call for you' });
  await waitFor(() => expect(liveReads()).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(tiles()[1]).toEqual({ label: 'Project Y', title: 'Project Y', badge: null });
  expect(document.title).toBe('(1) Studio desk');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Unexpected request|refused/)).toBeNull();
});

test("the hook gives each project's calls with the totals, and leaving clears a read still waiting", async () => {
  controller.tasks = [taskFixture('T-1', { title: 'Waiting to start' })];
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = oneCall();
  const queryClient = client(),
    seen: ReturnType<typeof useRailCalls>[] = [];
  function Probe() {
    seen.push(useRailCalls('project-x', [{ id: 'project-x' }, { id: 'project-y' }]));
    return null;
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <StreamFactoryContext.Provider value={createStream}>
        <ProjectLive projectId="project-x">
          <Probe />
        </ProjectLive>
      </StreamFactoryContext.Provider>
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(seen.at(-1)?.calls['project-x']?.count).toBe(1);
    expect(seen.at(-1)?.calls['project-y']?.count).toBe(1);
  });
  // Each project's calls are only the items for the director: Project Y's held and waiting work is left out.
  const last = seen.at(-1)!,
    taskOf = (item: object) => ('taskId' in item ? item.taskId : null);
  expect(last.calls['project-x']!.items.map(taskOf)).toEqual(['T-1']);
  expect(last.calls['project-y']!.items.map(taskOf)).toEqual(['T-plan']);
  expect(last.calls['project-y']!.items.every(item => item.requiresDirector)).toBe(true);
  expect([last.total, last.others]).toEqual([2, 1]);
  fakeTime();
  named('project-y');
  await pass(100);
  view.unmount();
  await pass(5_000);
  expect(liveReads()).toBe(1);
  // Nothing read it on leaving, but the change named stays known: the next page to show it reads it.
  expect(queryClient.getQueryState(['project-y', 'live'])?.isInvalidated).toBe(true);
});
