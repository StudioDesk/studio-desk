// Bringing an idea back to an older line from its page (1.1, October 27): once every one of its source stories landed
// or was closed, and one landed, the page offers each older line the controller answers with, confirmed first; before
// then it never asks the controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, RunRecord, Task } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

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
