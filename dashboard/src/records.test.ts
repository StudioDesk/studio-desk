// How each change reaches the records a project's pages hold (records.ts): one task's change fetches that task
// alone and patches it in; the live set reloads only when work joins or settles; finished runs reload when a run
// leaves the live set; nothing is fetched for a task no page holds.
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { finishedUrl, getJSON, liveUrl, type FinishedPage, type Live } from './api';
import { RecordSync, queryKeys } from './records';
import { fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller, client: QueryClient, sync: RecordSync;
const unsubscribe: (() => void)[] = [];

beforeEach(() => {
  controller = fakeController();
  controller.tasks = [
    taskFixture('T-1', { status: 'running', lastAttemptId: 'attempt-1' }),
    taskFixture('T-old', { status: 'done' }),
  ];
  controller.attempts = [{ id: 'attempt-1', taskId: 'T-1', status: 'running' }];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  sync = new RecordSync(client, 'project-x');
});
afterEach(() => {
  unsubscribe.splice(0).forEach(stop => stop());
  vi.unstubAllGlobals();
});

// A page holding the live set (and, when asked, finished runs) keeps those queries active.
async function holdLive({ finished = false } = {}) {
  const live = new QueryObserver(client, {
    queryKey: queryKeys.live('project-x'),
    queryFn: () => getJSON<Live>(liveUrl('project-x')),
  });
  unsubscribe.push(live.subscribe(() => {}));
  if (finished) {
    const pages = new InfiniteQueryObserver(client, {
      queryKey: queryKeys.finished('project-x'),
      queryFn: ({ pageParam }) => getJSON<FinishedPage>(finishedUrl('project-x', pageParam as string | null)),
      initialPageParam: null as string | null,
      getNextPageParam: (page: FinishedPage) => page.next,
    });
    unsubscribe.push(pages.subscribe(() => {}));
  }
  await vi.waitFor(() => expect(client.getQueryData(queryKeys.live('project-x'))).toBeDefined());
  if (finished) await vi.waitFor(() => expect(client.getQueryData(queryKeys.finished('project-x'))).toBeDefined());
  controller.requests.length = 0;
}
const live = () => client.getQueryData<Live>(queryKeys.live('project-x'))!;
const changeTo = (id: string, seq = 2) => ({ version: seq, start: 's', changes: [{ seq, type: 'task', id }] });

test('a change to live work fetches that task alone and patches it into the live set', async () => {
  await holdLive();
  controller.tasks[0] = { ...controller.tasks[0]!, title: 'Renamed' };
  controller.attempts.push({ id: 'attempt-2', taskId: 'T-1', status: 'running' });
  await sync.apply(changeTo('T-1'));
  expect(controller.reads()).toEqual(['/api/tasks/T-1?projectId=project-x']);
  expect(live().tasks.map(task => task.title)).toEqual(['Renamed']);
  expect(live().attempts.map(attempt => attempt.id)).toEqual(['attempt-1', 'attempt-2']);
});

test('new work, and work that settles, reload the live set; a run leaving it reloads finished runs', async () => {
  controller.runs = [{ id: 'run-1', createdAt: '2026-10-21T12:00:00Z' }];
  controller.tasks[0] = { ...controller.tasks[0]!, workflowReference: { runId: 'run-1' } };
  await holdLive({ finished: true });
  controller.tasks.push(taskFixture('T-new'));
  await sync.apply(changeTo('T-new'));
  expect(controller.reads()).toEqual(['/api/tasks/T-new?projectId=project-x', '/api/projects/project-x/live']);
  expect(live().tasks.map(task => task.id)).toEqual(['T-1', 'T-new']);
  controller.requests.length = 0;
  controller.tasks[0] = { ...controller.tasks[0]!, status: 'done' };
  controller.runs = [];
  await sync.apply(changeTo('T-1', 3));
  expect(controller.reads()).toEqual([
    '/api/tasks/T-1?projectId=project-x',
    '/api/projects/project-x/live',
    '/api/projects/project-x/runs?limit=10',
  ]);
});

test('a settled task outside the live set is read once and changes nothing', async () => {
  await holdLive();
  await sync.apply(changeTo('T-old'));
  expect(controller.reads()).toEqual(['/api/tasks/T-old?projectId=project-x']);
});

test('nothing is fetched for a task when no page holds the project', async () => {
  await sync.apply(changeTo('T-1'));
  expect(controller.requests).toEqual([]);
});

test('organization and run changes reload the shell and the runs; a reload refreshes every held record', async () => {
  await holdLive({ finished: true });
  await sync.apply({ version: 4, start: 's', changes: [{ seq: 4, type: 'run', id: 'run-1' }] });
  expect([...controller.reads()].sort()).toEqual([
    '/api/projects/project-x/live',
    '/api/projects/project-x/runs?limit=10',
  ]);
  controller.requests.length = 0;
  await sync.apply({ version: 5, start: 's', reload: true });
  expect([...controller.reads()].sort()).toEqual([
    '/api/projects/project-x/live',
    '/api/projects/project-x/runs?limit=10',
  ]);
});

test('a task change during a reload reads the set once more rather than patching over it', async () => {
  await holdLive();
  controller.tasks.push(taskFixture('T-new'));
  const reload = sync.apply(changeTo('T-new'));
  controller.tasks[0] = { ...controller.tasks[0]!, title: 'Renamed during the reload' };
  await Promise.all([reload, sync.apply(changeTo('T-1', 3))]);
  expect(live().tasks.find(task => task.id === 'T-1')?.title).toBe('Renamed during the reload');
  expect(controller.reads().filter(url => url.endsWith('/live'))).toHaveLength(2);
});
