// How each change reaches the records a project's pages hold (records.ts): one task's change fetches that task
// alone and patches it in; the live set reloads only when work joins or settles; finished runs reload when a run
// leaves the live set; nothing is fetched for a task no page holds. A command's answer puts the tasks it supplies in
// at once, without reading them, and starts the confirming reads right away. The live set is read a page at a time and
// held as one.
import { InfiniteQueryObserver, QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  finishedUrl,
  getJSON,
  liveUrl,
  releasesUrl,
  send,
  taskUrl,
  type Change,
  type ChangeMessage,
  type CommandRecords,
  type FinishedPage,
  type Live,
  type ReleaseOverview,
  type Task,
  type TaskPage,
} from './api';
import { ProjectLive } from './live-context';
import { RecordSync, queryKeys, readLive } from './records';
import { StreamFactoryContext } from './stream-context';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

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

// A page holding one task's own record.
async function holdTask(id: string) {
  const page = new QueryObserver(client, {
    queryKey: queryKeys.task('project-x', id),
    queryFn: () => getJSON<TaskPage>(taskUrl('project-x', id)),
  });
  unsubscribe.push(page.subscribe(() => {}));
  await vi.waitFor(() => expect(client.getQueryData(queryKeys.task('project-x', id))).toBeDefined());
  controller.requests.length = 0;
}
const shown = (id: string) => client.getQueryData<TaskPage>(queryKeys.task('project-x', id));
// A command's answer: the changes it recorded (a change to each given task unless named) and each given task's page.
const answered = (
  tasks: Task[],
  changes: Change[] = tasks.map((task, i) => ({ seq: 10 + i, type: 'task', id: task.id })),
) =>
  ({
    projectId: 'project-x',
    version: 20,
    start: 's',
    changes,
    tasks: tasks.map(task => ({ task, attempts: controller.attempts.filter(attempt => attempt.taskId === task.id) })),
  }) satisfies CommandRecords;

test("an answer's task goes into its page and the live set at once, without reading it", async () => {
  await holdLive();
  await holdTask('T-1');
  const approved = { ...controller.tasks[0]!, title: 'Approved' };
  controller.attempts.push({ id: 'attempt-2', taskId: 'T-1', status: 'running' });
  const records = answered([approved]),
    done = sync.answer(records);
  expect(shown('T-1')).toEqual(records.tasks[0]);
  expect(live().tasks.map(task => task.title)).toEqual(['Approved']);
  expect(live().attempts.map(attempt => attempt.id)).toEqual(['attempt-1', 'attempt-2']);
  await done;
  expect(controller.reads()).toEqual([]);
  expect(live().tasks.map(task => task.title)).toEqual(['Approved']);
});

test('work an answer settles shows its new record in the live set at once, and one reload drops it', async () => {
  await holdLive();
  await holdTask('T-1');
  controller.tasks[0] = { ...controller.tasks[0]!, status: 'denied' };
  const done = sync.answer(answered([controller.tasks[0]]));
  expect(live().tasks.map(task => [task.id, task.status])).toEqual([['T-1', 'denied']]);
  expect(shown('T-1')?.task.status).toBe('denied');
  await done;
  expect(controller.reads()).toEqual(['/api/projects/project-x/live']);
  expect(live().tasks).toEqual([]);
});

test('work an answer starts joins the live set at once with its attempts, and a reload follows', async () => {
  await holdLive();
  controller.tasks.push(taskFixture('T-new', { status: 'running', lastAttemptId: 'attempt-n' }));
  controller.attempts.push({ id: 'attempt-n', taskId: 'T-new', status: 'running' });
  const done = sync.answer(answered([controller.tasks[2]!]));
  expect(live().tasks.map(task => task.id)).toEqual(['T-1', 'T-new']);
  expect(live().attempts.map(attempt => attempt.id)).toEqual(['attempt-1', 'attempt-n']);
  await done;
  expect(controller.reads()).toEqual(['/api/projects/project-x/live']);
  expect(live().tasks.map(task => task.id)).toEqual(['T-1', 'T-new']);
});

test('an answer naming a run reloads the live set and finished runs right away, once with the work it starts', async () => {
  await holdLive({ finished: true });
  await sync.answer(answered([], [{ seq: 4, type: 'run', id: 'run-1' }]));
  expect([...controller.reads()].sort()).toEqual([
    '/api/projects/project-x/live',
    '/api/projects/project-x/runs?limit=10',
  ]);
  controller.requests.length = 0;
  controller.tasks.push(taskFixture('T-new'));
  const done = sync.answer(
    answered(
      [controller.tasks[2]!],
      [
        { seq: 5, type: 'run', id: 'run-1' },
        { seq: 6, type: 'task', id: 'T-new' },
      ],
    ),
  );
  expect(live().tasks.map(task => task.id)).toEqual(['T-1', 'T-new']);
  await done;
  expect([...controller.reads()].sort()).toEqual([
    '/api/projects/project-x/live',
    '/api/projects/project-x/runs?limit=10',
  ]);
});

test('an answer that says reload refreshes every held record, as the stream reload does', async () => {
  await holdLive({ finished: true });
  await holdTask('T-1');
  await sync.answer({ projectId: 'project-x', version: 21, start: 's', reload: true });
  expect([...controller.reads()].sort()).toEqual([
    '/api/projects/project-x/live',
    '/api/projects/project-x/runs?limit=10',
    '/api/tasks/T-1?projectId=project-x',
  ]);
});

test("another project's answer changes nothing", async () => {
  await holdLive({ finished: true });
  await holdTask('T-1');
  const before = live(),
    page = shown('T-1'),
    other = { ...answered([{ ...controller.tasks[0]!, title: 'Elsewhere' }]), projectId: 'project-y' };
  await sync.answer({ ...other, changes: [...other.changes, { seq: 11, type: 'run', id: 'run-1' }] });
  await sync.answer({ projectId: 'project-y', version: 21, start: 's', reload: true });
  expect(controller.requests).toEqual([]);
  expect(live()).toBe(before);
  expect(shown('T-1')).toBe(page);
});

test('a stream change after an answer reads and patches the task as before; a read the answer overtook is dropped', async () => {
  await holdLive();
  await holdTask('T-1');
  controller.tasks[0] = { ...controller.tasks[0]!, title: 'Read before the answer' };
  const overtaken = sync.apply(changeTo('T-1'));
  await sync.answer(answered([{ ...controller.tasks[0], title: 'Approved' }]));
  await overtaken;
  expect(live().tasks.map(task => task.title)).toEqual(['Approved']);
  expect(shown('T-1')?.task.title).toBe('Approved');
  controller.requests.length = 0;
  controller.tasks[0] = { ...controller.tasks[0], title: 'Running now' };
  await sync.apply(changeTo('T-1', 30));
  expect(controller.reads()).toEqual(['/api/tasks/T-1?projectId=project-x']);
  expect(live().tasks.map(task => task.title)).toEqual(['Running now']);
  expect(shown('T-1')?.task.title).toBe('Running now');
});

test('an answer during a reload goes in at once and the set is read once more after it', async () => {
  await holdLive();
  // A run's change starts a reload, which reads the set before the command changes T-1.
  const reload = sync.apply({ version: 2, start: 's', changes: [{ seq: 2, type: 'run', id: 'run-1' }] });
  controller.tasks[0] = { ...controller.tasks[0]!, title: 'Approved during the reload' };
  const done = sync.answer(answered([controller.tasks[0]]));
  expect(live().tasks.find(task => task.id === 'T-1')?.title).toBe('Approved during the reload');
  await Promise.all([reload, done]);
  expect(live().tasks.find(task => task.id === 'T-1')?.title).toBe('Approved during the reload');
  expect(controller.reads().filter(url => url.endsWith('/live'))).toHaveLength(2);
});

test("a project's pages take its commands' answers before send() resolves, until they close", async () => {
  const view = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        StreamFactoryContext.Provider,
        { value: createStream },
        createElement(ProjectLive, { projectId: 'project-x', children: null }),
      ),
    ),
  );
  unsubscribe.push(() => view.unmount());
  await holdLive();
  const titled = (title: string) => answered([{ ...controller.tasks[0]!, title }]);
  controller.command = () => ({ ok: true, records: titled('Approved') });
  await send('/api/tasks/T-1/approve-work', { projectId: 'project-x' });
  expect(live().tasks.map(task => task.title)).toEqual(['Approved']);
  controller.command = () => ({ ok: true, records: { ...titled('Elsewhere'), projectId: 'project-y' } });
  await send('/api/tasks/T-1/approve-work', { projectId: 'project-y' });
  view.unmount();
  controller.command = () => ({ ok: true, records: titled('After closing') });
  await send('/api/tasks/T-1/approve-work', { projectId: 'project-x' });
  expect(live().tasks.map(task => task.title)).toEqual(['Approved']);
  expect(controller.reads()).toEqual([]);
});

// A page holding the project's releases, as the Releases page and the release chips do: one milestone, whose idea's
// story is T-old and whose release notes are T-notes's.
async function holdReleases() {
  const story = (id: string) => ({ id, title: id, status: 'done', started: true, integration: null, carries: [] });
  controller.releases = {
    available: true,
    lines: [],
    milestones: [
      {
        id: 'milestone-1.0.1',
        version: '1.0.1',
        line: null,
        goal: '',
        state: 'open',
        waiting: [],
        release: { state: 'drafting', notesTaskId: 'T-notes' },
        ideas: [{ runId: 'run-1', idea: 'An idea', at: null, by: 'director', stories: [story('T-old')], movedOut: [] }],
        movedIn: [],
        counts: { ideas: 1, waiting: 0, stories: 1, integrated: 0, started: 1 },
      },
    ],
  };
  const releases = new QueryObserver(client, {
    queryKey: queryKeys.releases('project-x'),
    queryFn: () => getJSON<ReleaseOverview>(releasesUrl('project-x')),
  });
  unsubscribe.push(releases.subscribe(() => {}));
  await vi.waitFor(() => expect(client.getQueryData(queryKeys.releases('project-x'))).toBeDefined());
  controller.requests.length = 0;
}
// What one message reads, from no reads.
const readsFor = async (message: ChangeMessage) => {
  controller.requests.length = 0;
  await sync.apply(message);
  return controller.reads();
};
const releasesRead = '/api/projects/project-x/releases';
const changes = (...list: Omit<Change, 'seq'>[]) => ({
  version: 2,
  start: 's',
  changes: list.map((change, i) => ({ seq: 2 + i, ...change })),
});

test('the releases are named under their project, so a reload reads them again with its other records', async () => {
  expect(queryKeys.releases('project-x')).toEqual(['project-x', 'releases']);
  await holdReleases();
  expect(await readsFor({ version: 2, start: 's', reload: true })).toEqual([releasesRead]);
  controller.requests.length = 0;
  await sync.answer({ projectId: 'project-x', version: 3, start: 's', reload: true });
  expect(controller.reads()).toEqual([releasesRead]);
  // Another project's reload leaves them.
  controller.requests.length = 0;
  await sync.answer({ projectId: 'project-y', version: 4, start: 's', reload: true });
  expect(controller.requests).toEqual([]);
});

test('a milestone, a line, a run or a story they name changing reads the releases again; an event or an attempt alone does not', async () => {
  await holdReleases();
  // Milestones are a project setting; retiring or adding a line changes the project's record.
  expect(await readsFor(changes({ type: 'setting', id: 'milestones:project-x', projectId: 'project-x' }))).toEqual([
    releasesRead,
  ]);
  expect(await readsFor(changes({ type: 'projects' }))).toEqual([releasesRead]);
  expect(await readsFor(changes({ type: 'run', id: 'run-1' }))).toEqual([releasesRead]);
  expect(await readsFor(changes({ type: 'task', id: 'T-old' }))).toEqual([releasesRead]);
  expect(await readsFor(changes({ type: 'task', id: 'T-notes' }))).toEqual([releasesRead]);
  // A task they do not name leaves them, as nothing is fetched for a task no page holds.
  expect(await readsFor(changes({ type: 'task', id: 'T-1' }))).toEqual([]);
  // Each phase an attempt logs, and the attempt's own record, leave them, as do both together.
  expect(
    await readsFor(
      changes(
        { type: 'event', kind: 'phase', taskId: 'T-old', attemptId: 'attempt-1' },
        { type: 'event', kind: 'log', taskId: 'T-old' },
        { type: 'attempt', id: 'attempt-1', taskId: 'T-old' },
      ),
    ),
  ).toEqual([]);
  // A command's answer that supplies the page of a story they name reads them again too, and one that does not leaves
  // them.
  controller.requests.length = 0;
  await sync.answer(answered([controller.tasks[1]!]));
  expect(controller.reads()).toEqual([releasesRead]);
  controller.requests.length = 0;
  await sync.answer(answered([controller.tasks[0]!]));
  expect(controller.reads()).toEqual([]);
});

// The controller answers the live set a page at a time (page-read-limits): the records read the next page while one
// says next, and hold every page's records as one set, as the board, Home and the rail read it.
function livePages(pages: Record<string, Live>, refuse: (url: string) => boolean = () => false) {
  const reads: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input);
    reads.push(url);
    const page = refuse(url) ? undefined : pages[url];
    return page
      ? { ok: true, status: 200, json: async () => page }
      : { ok: false, status: 404, json: async () => ({ error: 'That page of open work no longer exists.' }) };
  });
  return reads;
}
async function holdPagedLive() {
  const observer = new QueryObserver(client, {
    queryKey: queryKeys.live('project-x'),
    queryFn: ({ signal }) => readLive('project-x', signal),
  });
  unsubscribe.push(observer.subscribe(() => {}));
  await vi.waitFor(() => expect(client.getQueryData(queryKeys.live('project-x'))).toBeDefined());
}
const first: Live = {
    tasks: [taskFixture('T-1', { status: 'running' }), taskFixture('T-2', { status: 'done' })],
    attempts: [{ id: 'attempt-1', taskId: 'T-1', status: 'running' }],
    runs: [{ id: 'run-1', createdAt: '2026-10-21T12:00:00Z' }],
    ideas: [{ id: 'idea-1', brief: 'An idea.', createdAt: '2026-10-20T12:00:00Z', taskIds: ['T-2'] }],
    next: 'T-2',
    version: 7,
  },
  second: Live = {
    tasks: [taskFixture('T-3', { status: 'failed' })],
    attempts: [{ id: 'attempt-3', taskId: 'T-3', status: 'failed' }],
    runs: [
      { id: 'run-2', createdAt: '2026-10-22T12:00:00Z' },
      { id: 'run-1', createdAt: '2026-10-21T12:00:00Z' },
    ],
    ideas: [{ id: 'idea-1', brief: 'An idea.', createdAt: '2026-10-20T12:00:00Z', taskIds: ['T-3'] }],
    next: null,
    version: 8,
  };

test('a live answer that says next reads the following page, and the records hold every task of both pages', async () => {
  const reads = livePages({ [liveUrl('project-x')]: first, [liveUrl('project-x', 'T-2')]: second });
  await holdPagedLive();
  expect(reads).toEqual(['/api/projects/project-x/live', '/api/projects/project-x/live?before=T-2']);
  expect(live().tasks.map(task => task.id)).toEqual(['T-1', 'T-2', 'T-3']);
  expect(live().attempts.map(attempt => attempt.id)).toEqual(['attempt-1', 'attempt-3']);
  // Each open run once, newest first as the controller lists them; each idea once, with its tasks from both pages.
  expect(live().runs.map(run => run.id)).toEqual(['run-2', 'run-1']);
  expect(live().ideas).toEqual([{ ...first.ideas![0]!, taskIds: ['T-2', 'T-3'] }]);
  // The set read whole has no next page, and resumes from the earliest change sequence its pages reflect.
  expect(live().next).toBeNull();
  expect(live().version).toBe(7);
});

test('a single-page live answer reads once and is held as it came', async () => {
  const only: Live = { ...first, ideas: [], next: null, version: 3 },
    reads = livePages({ [liveUrl('project-x')]: only });
  await holdPagedLive();
  expect(reads).toEqual(['/api/projects/project-x/live']);
  expect(live()).toEqual(only);
});

test('a following page whose cursor settled out of the set reads the set again from its first page', async () => {
  const pages = { [liveUrl('project-x')]: first, [liveUrl('project-x', 'T-2')]: second },
    following = liveUrl('project-x', 'T-2');
  // The cursor's page is refused once, as when its task settled between the two reads.
  let refusals = 1;
  const reads = livePages(pages, url => url === following && refusals-- > 0);
  const whole = await readLive('project-x');
  expect(reads).toEqual([
    '/api/projects/project-x/live',
    '/api/projects/project-x/live?before=T-2',
    '/api/projects/project-x/live',
    '/api/projects/project-x/live?before=T-2',
  ]);
  expect(whole.tasks.map(task => task.id)).toEqual(['T-1', 'T-2', 'T-3']);
  // A set that keeps refusing its pages fails after its third try rather than reading forever.
  const always = livePages(pages, url => url === following);
  await expect(readLive('project-x')).rejects.toThrow('That page of open work no longer exists.');
  expect(always).toHaveLength(6);
});
