// Trying a story yourself as the dashboard reads it (try-it.ts): when a story offers Try it and what the try copy
// means for it, from the records alone; and the try view, its Run's output and the director's requests as they reach
// the stand-in controller. Model-free; no page shows any of it yet.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Refusal, type AttemptSummary, type Task, type TryCopy, type TryRun, type TryView } from './api';
import type { StudioState } from './studio-runs';
import { fakeController, shellFixture, taskFixture, type Controller } from './test-controller';
import { triedState, tryOffered, useTryAction, useTryOutput, useTryView } from './try-it';

// A code story whose current candidate, pinned on its stage, is attempt-build.
const pin = { taskId: 'T-1', attemptId: 'attempt-build', workerId: 'W-1', hash: 'manifest-hash' };
const candidate = (fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id: 'attempt-build',
  taskId: 'T-1',
  projectId: 'project-x',
  workerId: 'W-1',
  status: 'accepted',
  assignment: { kind: 'studio-development:change' },
  result: { outcome: 'completed', summary: 'Shows the received files.' },
  testEvidence: { totals: { tests: 534, pass: 534, fail: 0 } },
  sourceCandidate: { commit: 'c4nd1da7e' },
  ...fields,
});
const story = (stage: object, fields: Partial<Task> = {}) =>
  taskFixture('T-1', {
    title: 'Show the received files',
    kind: 'studio-development:change',
    status: 'running',
    sourceStage: { version: 'source-story-stages-v1', ...stage },
    ...fields,
  });
const reviewing = { phase: 'candidate-review', current: 'candidate-review', candidate: pin };
const studio = (task: Task, attempts: AttemptSummary[], extra: Partial<StudioState> = {}): StudioState => ({
  ...shellFixture(),
  tasks: [task],
  attempts,
  runs: [],
  ...extra,
});

test('Try it is offered on a code story whose candidate attempt is accepted and completed', () => {
  const task = story(reviewing);
  expect(tryOffered(task, studio(task, [candidate()]))).toBe(true);
  // Still so once its review passed and it waits to be integrated.
  const waiting = story({ ...reviewing, current: 'waiting-for-integration' }, { status: 'done' });
  expect(tryOffered(waiting, studio(waiting, [candidate()]))).toBe(true);
});

test('Try it is not offered on a story still implementing, whether building its first candidate or a new one', () => {
  const first = story({ phase: 'implementing', current: 'implementing' }, { lastAttemptId: 'attempt-build' }),
    building = candidate({ status: 'running', finishedAt: null, result: undefined });
  expect(tryOffered(first, studio(first, [building]))).toBe(false);
  // Sent back: the candidate it had is not the one it is building.
  const again = story({ phase: 'implementing', current: 'implementing', candidate: pin });
  expect(tryOffered(again, studio(again, [candidate()]))).toBe(false);
});

test('Try it is not offered on a candidate that failed its tests, or one that did not complete', () => {
  const task = story(reviewing),
    failed = candidate({
      status: 'failed',
      error: 'The candidate did not pass its tests.',
      testEvidence: { totals: { tests: 534, pass: 533, fail: 1 } },
    });
  expect(tryOffered(task, studio(task, [failed]))).toBe(false);
  expect(tryOffered(task, studio(task, [candidate({ result: { outcome: 'blocked' } })]))).toBe(false);
  // A candidate the records do not hold offers nothing.
  expect(tryOffered(task, studio(task, []))).toBe(false);
});

test('Try it is not offered on work that is not code, or on a project without a repository', () => {
  // Even with an accepted attempt pinned the way a code story pins its candidate.
  const work = story(reviewing, { kind: 'general', status: 'done', acceptedAttemptId: 'attempt-build' }),
    files = candidate({ assignment: { kind: 'general' } });
  expect(tryOffered(work, studio(work, [files]))).toBe(false);
  const task = story(reviewing),
    general = studio(task, [candidate()], { organizationConfiguration: { taskKinds: ['general:plan'] } });
  expect(tryOffered(task, general)).toBe(false);
});

// The copy holding T-1's candidate merged onto main, and a Run in it.
const copy = (fields: Partial<TryCopy> = {}): TryCopy => ({
  folder: 'C:\\work\\app-try',
  taskId: 'T-1',
  title: 'Show the received files',
  candidateAttemptId: 'attempt-build',
  branch: 'main',
  tip: 'a1b2c3d4e5f60718',
  commit: 'f6e5d4c3b2a10987',
  merged: true,
  conflicts: [],
  at: '2026-10-29T09:00:00Z',
  run: null,
  ...fields,
});
const run = (fields: Partial<TryRun> = {}): TryRun => ({
  id: 'try-run-1',
  state: 'running',
  place: 'built-in',
  start: ['npm', 'run', 'dev'],
  address: null,
  taskId: 'T-1',
  commit: 'f6e5d4c3b2a10987',
  startedAt: '2026-10-29T09:01:00Z',
  ...fields,
});
const view = (held: TryCopy | null): TryView => ({
  settings: {
    start: ['npm', 'run', 'dev'],
    address: null,
    folder: 'C:\\work\\app-try',
    runIn: 'built-in',
    outsideConfirmedAt: null,
  },
  runsIn: 'built-in',
  copy: held,
});

test('a story is not tried while the copy holds nothing, or holds another story, running or not', () => {
  expect(triedState(view(null), 'T-1')).toEqual({ state: 'not-tried' });
  // Before the view is read.
  expect(triedState(undefined, 'T-1')).toEqual({ state: 'not-tried' });
  const other = copy({ taskId: 'T-2', title: 'Another story' });
  expect(triedState(view(other), 'T-1')).toEqual({ state: 'not-tried' });
  expect(triedState(view({ ...other, run: run({ taskId: 'T-2', address: 'http://localhost:5173/' }) }), 'T-1')).toEqual(
    { state: 'not-tried' },
  );
});

test('a story in the copy says whether it is merged onto its line, or held as built with the files that conflicted', () => {
  expect(triedState(view(copy()), 'T-1')).toEqual({ state: 'in-copy', merged: true, branch: 'main', conflicts: [] });
  const built = copy({ merged: false, conflicts: ['lib/greeting.js', 'README.md'], commit: 'c4nd1da7e' });
  expect(triedState(view(built), 'T-1')).toEqual({
    state: 'in-copy',
    merged: false,
    branch: 'main',
    conflicts: ['lib/greeting.js', 'README.md'],
  });
  // A Run that ended leaves the story in the copy, with nothing running.
  const ended = run({
    state: 'ended',
    address: 'http://localhost:5173/',
    endedAt: '2026-10-29T09:05:00Z',
    exitCode: 0,
  });
  expect(triedState(view(copy({ run: ended })), 'T-1')).toEqual({
    state: 'in-copy',
    merged: true,
    branch: 'main',
    conflicts: [],
  });
});

test('a story whose Run runs gives the address the app printed, and none until it prints one', () => {
  expect(triedState(view(copy({ run: run({ address: 'http://localhost:5173/' }) })), 'T-1')).toEqual({
    state: 'running',
    address: 'http://localhost:5173/',
  });
  expect(triedState(view(copy({ run: run() })), 'T-1')).toEqual({ state: 'running', address: null });
  // Installing the packages first, before the app starts.
  expect(triedState(view(copy({ run: run({ installing: true }) })), 'T-1')).toEqual({
    state: 'running',
    address: null,
  });
});

let controller: Controller, client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
const tryReads = () => controller.reads().filter(url => url === '/api/projects/project-x/try').length,
  outputReads = () => controller.reads().filter(url => url === '/api/projects/project-x/try/output').length;

beforeEach(() => {
  controller = fakeController();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the try view is read under its project, and nothing is read while it is not wanted', async () => {
  const { rerender, result } = renderHook(({ on }: { on: boolean }) => useTryView('project-x', on), {
    wrapper,
    initialProps: { on: false },
  });
  expect(controller.requests).toEqual([]);
  rerender({ on: true });
  await waitFor(() => expect(result.current.data).toEqual(controller.tryView));
  expect(client.getQueryData(['project-x', 'try', 'view'])).toEqual(controller.tryView);
  expect(controller.reads()).toEqual(['/api/projects/project-x/try']);
});

test('while its Run runs the try view is read every two seconds, and no longer once the Run ended', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  controller.tryView = view(copy({ run: run() }));
  const { result } = renderHook(() => useTryView('project-x', true), { wrapper });
  await pass(0);
  expect(tryReads()).toBe(1);
  await pass(1900);
  expect(tryReads()).toBe(1);
  // The app printed its address, then ended.
  controller.tryView = view(copy({ run: run({ address: 'http://localhost:5173/' }) }));
  await pass(100);
  expect(tryReads()).toBe(2);
  // The page hears the answer a moment after it is read (a zero delay set while timers run waits 1 ms).
  await pass(1);
  expect(triedState(result.current.data, 'T-1')).toEqual({ state: 'running', address: 'http://localhost:5173/' });
  controller.tryView = view(copy({ run: run({ state: 'ended', exitCode: 1, endedAt: '2026-10-29T09:02:00Z' }) }));
  await pass(2000);
  expect(tryReads()).toBe(3);
  await pass(1);
  expect(triedState(result.current.data, 'T-1').state).toBe('in-copy');
  await pass(10000);
  expect(tryReads()).toBe(3);
});

test('a copy with nothing running is read once', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  controller.tryView = view(copy());
  renderHook(() => useTryView('project-x', true), { wrapper });
  await pass(10000);
  expect(tryReads()).toBe(1);
});

test("a Run's output is read as text while the copy has a Run, and not before it has one", async () => {
  controller.tryView = view(copy());
  controller.tryOutput = '> npm run dev\n  Local: http://localhost:5173/\n';
  const quiet = renderHook(() => useTryOutput('project-x', true), { wrapper });
  await waitFor(() => expect(tryReads()).toBe(1));
  expect(quiet.result.current.data).toBeUndefined();
  quiet.unmount();
  client.clear();
  controller.tryView = view(copy({ run: run({ state: 'ended', exitCode: 0, endedAt: '2026-10-29T09:05:00Z' }) }));
  const { result } = renderHook(() => useTryOutput('project-x', true), { wrapper });
  await waitFor(() => expect(result.current.data).toBe(controller.tryOutput));
  expect(outputReads()).toBe(1);
});

test('the output is not read while it is not wanted', async () => {
  controller.tryView = view(copy({ run: run() }));
  renderHook(() => useTryOutput('project-x', false), { wrapper });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(controller.requests).toEqual([]);
});

test('each request reaches its route with only the project, or the choice the director made, and the view is read again', async () => {
  const { result } = renderHook(() => ({ view: useTryView('project-x'), act: useTryAction('project-x') }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.view.data).toBeDefined());
  const posts = () => controller.requests.filter(request => request.method === 'POST');
  controller.tryView = view(copy());
  await act(() => result.current.act.mutateAsync({ action: 'try', taskId: 'T-1' }));
  // The view was read again before the answer came back.
  expect(client.getQueryData(['project-x', 'try', 'view'])).toEqual(view(copy()));
  await act(() => result.current.act.mutateAsync({ action: 'try', taskId: 'T-1', discard: true }));
  await act(() => result.current.act.mutateAsync({ action: 'run' }));
  await act(() => result.current.act.mutateAsync({ action: 'run', confirmOutside: true }));
  await act(() => result.current.act.mutateAsync({ action: 'stop' }));
  await act(() => result.current.act.mutateAsync({ action: 'open' }));
  expect(posts()).toEqual([
    { url: '/api/tasks/T-1/try', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/tasks/T-1/try', method: 'POST', body: { projectId: 'project-x', discard: true } },
    { url: '/api/projects/project-x/try/run', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/projects/project-x/try/run', method: 'POST', body: { projectId: 'project-x', confirmOutside: true } },
    { url: '/api/projects/project-x/try/stop', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/projects/project-x/try/open', method: 'POST', body: { projectId: 'project-x' } },
  ]);
  expect(controller.requests.map(request => `${request.method} ${request.url}`)).toEqual([
    'GET /api/projects/project-x/try',
    ...posts().flatMap(request => [`POST ${request.url}`, 'GET /api/projects/project-x/try']),
  ]);
});

test("a refused request rejects with the controller's message and the fields beside it, and the view is read again", async () => {
  const edits = ['notes.txt', 'lib/greeting.js'],
    message =
      'The try copy holds your own edits: notes.txt, lib/greeting.js. Keep them, or discard them and try this story.';
  controller.command = () => {
    throw Object.assign(new Error(message), { status: 409, fields: { edits } });
  };
  const { result } = renderHook(() => ({ view: useTryView('project-x'), act: useTryAction('project-x') }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.view.data).toBeDefined());
  let refused: unknown;
  await act(async () => {
    refused = await result.current.act.mutateAsync({ action: 'try', taskId: 'T-1' }).catch((error: unknown) => error);
  });
  expect(refused).toBeInstanceOf(Refusal);
  expect(refused).toMatchObject({ message, fields: { edits } });
  expect(tryReads()).toBe(2);
});
