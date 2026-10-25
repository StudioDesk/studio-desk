// Runs in the new dashboard: open runs from the live set, finished runs a page at a time, a run beyond the
// loaded pages read on its own, and each run told as the current dashboard tells it.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RunRecord, Task } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
// A run as the controller's run view sends it (src/core/graph.mjs runView), with one node per task.
const run = (id: string, createdAt: string, tasks: Task[], extra = {}): RunRecord => ({
  id,
  createdAt,
  brief: `Brief of ${id}.`,
  workflow: { id: 'workflow-1', name: 'Fixture flow', version: 3 },
  revisions: [{ revision: 1, at: createdAt, reason: 'created' }],
  nodes: tasks.map(task => ({
    taskId: task.id,
    key: task.id,
    kind: task.kind,
    title: task.title,
    workerId: 'W-1',
    dependencies: [],
    revision: 1,
  })),
  archive: { archived: false },
  ...extra,
});
const member = (id: string, runId: string, extra: Partial<Task> = {}) =>
  taskFixture(id, {
    title: `Story ${id}`,
    workflowReference: { runId, key: id, id: 'workflow-1', name: 'Fixture flow' },
    ...extra,
  });

beforeEach(() => {
  controller = fakeController();
  const open = member('T-open', 'run-open', { status: 'running', lastAttemptId: 'attempt-open' }),
    done = member('T-done', 'run-done', {
      status: 'done',
      acceptedAttemptId: 'attempt-done',
      lastAttemptId: 'attempt-done',
    }),
    shelved = member('T-shelved', 'run-shelved', { status: 'done' });
  controller.tasks = [open];
  controller.attempts = [
    { id: 'attempt-open', taskId: 'T-open', status: 'running', workerId: 'W-1', startedAt: '2026-10-21T12:01:00Z' },
  ];
  controller.runs = [run('run-open', '2026-10-21T12:00:00Z', [open])];
  controller.finished = {
    runs: [
      {
        run: run('run-done', '2026-10-21T10:00:00Z', [done]),
        tasks: [done],
        attempts: [
          {
            id: 'attempt-done',
            taskId: 'T-done',
            status: 'accepted',
            workerId: 'W-1',
            startedAt: '2026-10-21T10:01:00Z',
            finishedAt: '2026-10-21T10:05:00Z',
            acceptedAt: '2026-10-21T10:06:00Z',
            result: { outcome: 'completed', summary: 'Done well.' },
          },
        ],
      },
      {
        run: run('run-shelved', '2026-10-21T09:00:00Z', [shelved], { archive: { archived: true } }),
        tasks: [shelved],
        attempts: [],
      },
    ],
    next: 'run-shelved',
  };
  const old = member('T-old', 'run-old', { status: 'done' });
  controller.olderRuns['run-shelved'] = {
    runs: [{ run: run('run-old', '2026-10-20T09:00:00Z', [old]), tasks: [old], attempts: [] }],
    next: null,
  };
  const far = member('T-far', 'run-far', { status: 'done' });
  controller.runItems['run-far'] = { run: run('run-far', '2026-09-01T09:00:00Z', [far]), tasks: [far], attempts: [] };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x/runs') => {
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
const ideaLinks = () =>
  screen
    .getAllByRole('link')
    .map(link => link.getAttribute('href'))
    .filter(href => href?.startsWith('/p/project-x/runs/'));

test('Ideas lists the ideas newest first, each opening its page; filters, Find and the archived ones narrow it', async () => {
  const user = userEvent.setup();
  open();
  expect(await screen.findByRole('heading', { level: 1, name: 'Ideas' })).toBeTruthy();
  expect(ideaLinks()).toEqual(['/p/project-x/runs/run-open', '/p/project-x/runs/run-done']);
  // The filters count what is open and what finished.
  await user.click(screen.getByRole('button', { name: /^Finished/ }));
  expect(ideaLinks()).toEqual(['/p/project-x/runs/run-done']);
  await user.click(screen.getByRole('button', { name: /^All/ }));
  await user.type(screen.getByRole('searchbox', { name: 'Find an idea' }), 'run-open');
  expect(ideaLinks()).toEqual(['/p/project-x/runs/run-open']);
  await user.clear(screen.getByRole('searchbox', { name: 'Find an idea' }));
  await user.click(screen.getByRole('button', { name: 'Show 1 archived idea' }));
  expect(ideaLinks().at(-1)).toBe('/p/project-x/runs/run-shelved');
  // Older finished ideas come a page at a time.
  await user.click(screen.getByRole('button', { name: 'Show older ideas' }));
  await waitFor(() => expect(ideaLinks()).toContain('/p/project-x/runs/run-old'));
  expect(controller.reads().filter(url => url.includes('/runs?'))).toEqual([
    '/api/projects/project-x/runs?limit=5',
    '/api/projects/project-x/runs?limit=5&before=run-shelved',
  ]);
  expect(screen.queryByRole('button', { name: 'Show older ideas' })).toBeNull();
});

test("an idea's page tells how it ended, its journey, its stories and what happened, each story opening its task", async () => {
  const user = userEvent.setup();
  open('/p/project-x/runs/run-done');
  // The title is the idea in the director's own words.
  expect(await screen.findByRole('heading', { level: 1, name: '“Brief of run-done.”' })).toBeTruthy();
  expect(screen.getAllByText('Finished').length).toBeGreaterThan(0);
  const journey = within(screen.getByRole('region', { name: 'Journey' }));
  expect(journey.getByText('Sent')).toBeTruthy();
  expect(journey.getByText('1 of 1 accepted')).toBeTruthy();
  // Every step of a workflow is one of its stories, and opens its task.
  const stories = within(screen.getByRole('region', { name: 'One story' }));
  expect(stories.getByRole('link', { name: /Story T-done/ }).getAttribute('href')).toBe('/p/project-x/tasks/T-done');
  const happened = within(screen.getByRole('region', { name: 'What happened' }));
  expect(happened.getByText('You sent the idea.')).toBeTruthy();
  expect(happened.getByText('Eli finished it')).toBeTruthy();
  await user.click(happened.getByRole('button', { name: 'Only stops and decisions' }));
  expect(happened.queryByText('Eli finished it')).toBeNull();
  expect(happened.getByText('Nothing stopped, and nothing waited for a decision.')).toBeTruthy();
  const who = within(screen.getByRole('region', { name: 'Who worked on it' }));
  expect(who.getByText('Eli')).toBeTruthy();
  expect(who.getByText('4 min')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'You are here' }).textContent).toBe('Ideas/Project X');
});

test('a run beyond the loaded pages is read on its own', async () => {
  open('/p/project-x/runs/run-far');
  expect(await screen.findByRole('heading', { level: 1, name: '“Brief of run-far.”' })).toBeTruthy();
  expect(controller.reads()).toContain('/api/projects/project-x/runs/run-far');
});

test('a finished idea can be archived from its page', async () => {
  const user = userEvent.setup();
  open('/p/project-x/runs/run-done');
  // The menu opens as a popover, which the test's document does not lay out, so it is read as hidden.
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Archive this idea', hidden: true }));
  await waitFor(() =>
    expect(controller.requests.find(request => request.method === 'POST')).toEqual({
      url: '/api/projects/project-x/runs/run-done/archive',
      method: 'POST',
      body: { projectId: 'project-x' },
    }),
  );
});
