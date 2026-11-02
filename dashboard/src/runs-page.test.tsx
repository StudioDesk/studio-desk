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

// The open idea as a code idea starts (planning.ts): its graph holds its checks, which passed, then its plan by Mara,
// before any story. The plan is planning, asks the director a question, stops, or is accepted with the two stories it
// proposed added to the graph. Times count back from now, so the minutes read as written.
const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const planned = (next: 'planning' | 'asking' | 'failed' | 'accepted') => {
  controller.shell.workers = [...controller.shell.workers, { id: 'W-2', displayName: 'Mara', team: 'Engineering' }];
  const checks = member('T-checks', 'run-open', {
      title: 'Check the source',
      kind: 'studio-development:checks',
      status: 'done',
      lastAttemptId: 'attempt-checks',
      acceptedAttemptId: 'attempt-checks',
    }),
    plan = member('T-plan', 'run-open', {
      title: 'Plan the idea',
      kind: 'studio-development:breakdown',
      workerId: 'W-2',
      dependencies: ['T-checks'],
      status: { planning: 'running', asking: 'blocked', failed: 'failed', accepted: 'done' }[next] as Task['status'],
      lastAttemptId: next === 'asking' ? 'attempt-ask' : 'attempt-plan',
      ...(next === 'accepted' ? { acceptedAttemptId: 'attempt-plan' } : {}),
    }),
    stories =
      next === 'accepted'
        ? ['T-s1', 'T-s2'].map(id =>
            taskFixture(id, {
              title: `Story ${id}`,
              status: 'backlog',
              approval: { status: 'pending' },
              proposalReference: { taskId: 'T-plan' },
            }),
          )
        : [];
  controller.tasks = [checks, plan, ...stories];
  controller.attempts = [
    {
      id: 'attempt-checks',
      taskId: 'T-checks',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: ago(9),
      finishedAt: ago(8),
      acceptedAt: ago(8),
    },
    next === 'asking'
      ? {
          id: 'attempt-ask',
          taskId: 'T-plan',
          status: 'blocked',
          workerId: 'W-2',
          startedAt: ago(7),
          finishedAt: ago(5),
          error: 'Needs a call from the director.',
          question: {
            ask: 'Split the page part into two stories?\nTwo pages share it, so either way works.',
            why: 'Two pages share it.',
            options: [{ label: 'One story' }, { label: 'Two stories', detail: 'one a page' }],
            recommended: 1,
            choice: 'inside-story',
            topics: [],
          },
        }
      : {
          id: 'attempt-plan',
          taskId: 'T-plan',
          status: { planning: 'running', failed: 'failed', accepted: 'accepted' }[next],
          workerId: 'W-2',
          startedAt: ago(7),
          ...(next === 'failed' ? { finishedAt: ago(5), error: 'The plan was not valid.' } : {}),
          ...(next === 'accepted'
            ? { finishedAt: ago(5), acceptedAt: ago(4), result: { outcome: 'completed', summary: 'Two stories.' } }
            : {}),
        },
  ];
  controller.runs = [run('run-open', '2026-10-21T12:00:00Z', [checks, plan, ...stories])];
};
// The idea's row on the Ideas list: its chip, and its meta line.
const ideaRow = async (id: string) => {
  await screen.findByRole('heading', { level: 1, name: 'Ideas' });
  const row = await waitFor(() => {
    const link = screen.getAllByRole('link').find(item => item.getAttribute('href') === `/p/project-x/runs/${id}`);
    expect(link).toBeTruthy();
    return link!;
  });
  return { row, chip: row.querySelector('.sd-chip')!, meta: row.querySelector('.sd-meta')!.textContent ?? '' };
};
const filterCount = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) }).textContent;

test("an open idea planning shows one row reading Planning with the planner's face, name and minutes", async () => {
  planned('planning');
  open();
  const { row, chip, meta } = await ideaRow('run-open');
  expect(chip.textContent).toBe('Planning');
  expect(chip.className).toBe('sd-chip sd-chip--live');
  expect(row.className).toContain('sd-idearow--live');
  expect(meta).toMatch(/^Sent .+ · Mara · 9 min$/);
  expect(row.querySelector('.sd-meta .sd-avatar')).toBeTruthy();
  expect(row.querySelector('.sd-rundots')).toBeNull();
  // One row for the idea, opening its page, and none for its checks or plan.
  expect(ideaLinks()).toEqual(['/p/project-x/runs/run-open', '/p/project-x/runs/run-done']);
  const hrefs = screen.getAllByRole('link').map(link => link.getAttribute('href') ?? '');
  expect(hrefs.filter(href => href.includes('T-plan') || href.includes('T-checks'))).toEqual([]);
  expect(screen.queryByText('Plan the idea')).toBeNull();
  expect(screen.queryByText('Check the source')).toBeNull();
  expect(filterCount('Open')).toBe('Open 1');
  expect(filterCount('Your calls')).toBe('Your calls 0');
});

test("an idea whose planner asks reads Waiting for you with the question's first line, and Your calls counts it", async () => {
  const user = userEvent.setup();
  planned('asking');
  open();
  const { row, chip, meta } = await ideaRow('run-open');
  expect(chip.textContent).toBe('Waiting for you');
  expect(chip.className).toBe('sd-chip sd-chip--you');
  expect(row.className).toContain('sd-idearow--you');
  expect(meta).toMatch(/^Sent .+ · Split the page part into two stories\?$/);
  expect(meta).not.toContain('Two pages share it');
  expect(filterCount('Your calls')).toBe('Your calls 1');
  await user.click(screen.getByRole('button', { name: /^Your calls/ }));
  expect(ideaLinks()).toEqual(['/p/project-x/runs/run-open']);
  // Find still narrows it by the idea's words.
  await user.type(screen.getByRole('searchbox', { name: 'Find an idea' }), 'run-done');
  expect(ideaLinks()).toEqual([]);
});

test('an idea whose plan step failed reads Stopped with the reason and what to do', async () => {
  planned('failed');
  open();
  const { row, chip, meta } = await ideaRow('run-open');
  expect(chip.textContent).toBe('Stopped');
  expect(chip.className).toBe('sd-chip sd-chip--bad');
  expect(row.className).not.toMatch(/sd-idearow--(you|live)/);
  expect(meta).toMatch(/^Sent .+ · \S/);
  expect(meta).toContain('The attempt stopped without a validated completed result.');
  expect(meta).toContain('then use Start assignment.');
  expect(meta).not.toMatch(/(Mara|Eli) stopped/);
});

test('once the plan is accepted and its stories proposed, the row shows its stories and dots as before', async () => {
  planned('accepted');
  open();
  const { row, chip, meta } = await ideaRow('run-open');
  expect(meta).toMatch(/^Sent .+ · 2 stories · 0 of 2 accepted$/);
  expect(chip.textContent).toBe('Your call · 0 of 2 accepted');
  expect(chip.className).toBe('sd-chip sd-chip--you');
  expect(row.querySelector('.sd-rundots')?.getAttribute('aria-label')).toMatch(/^Story 1: .+, Story 2: .+$/);
  expect(row.querySelectorAll('.sd-rundots i')).toHaveLength(2);
  expect(row.textContent).not.toMatch(/Planning|Waiting for you|Stopped/);
  expect(row.querySelector('.sd-meta .sd-avatar')).toBeNull();
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
