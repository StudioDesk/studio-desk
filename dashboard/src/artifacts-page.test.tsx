// The Artifacts page (1.2 step 6): every file the project's accepted work handed back, newest first, with its kind, its
// agent, its idea and when it was accepted, Open in a new tab, and filters for idea, agent and kind.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectArtifact } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller;
const file = (taskId: string, extra: Partial<ProjectArtifact>): ProjectArtifact => ({
  taskId,
  title: `Story ${taskId}`,
  attemptId: `attempt-${taskId}`,
  workerId: 'W-1',
  runId: null,
  kind: 'work-file',
  path: `${taskId}.md`,
  hash: `hash-${taskId}`,
  acceptedAt: '2026-10-20T12:00:00Z',
  ...extra,
});

beforeEach(() => {
  controller = fakeController();
  controller.shell.workers.push({ id: 'W-2', displayName: 'Ada' });
  // An agent no longer in the project is named from the company's directory.
  controller.shell.employeeDirectory = [{ id: 'W-9', displayName: 'Sam' }];
  // One idea is open, so the live set holds its run; another finished, and the live set only names it.
  controller.runs = [
    {
      id: 'run-launch',
      createdAt: '2026-10-19T09:00:00Z',
      brief: 'Make the launch page',
      workflow: { id: 'workflow-1', name: 'Fixture flow', version: 3 },
      revisions: [{ revision: 1, at: '2026-10-19T09:00:00Z', reason: 'created' }],
      nodes: [],
      archive: { archived: false },
    },
  ];
  controller.ideas = [{ id: 'run-check', brief: 'Check the copy reads well', taskIds: ['T-3'] }];
  // The listing out of order, so the page's own order shows.
  controller.projectArtifacts = [
    file('T-1', { path: 'copy/launch.md', runId: 'run-launch', acceptedAt: '2026-10-20T12:00:00Z' }),
    file('T-2', {
      path: 'art/hero.svg',
      kind: 'artwork',
      workerId: 'W-2',
      runId: 'run-launch',
      acceptedAt: '2026-10-22T12:00:00Z',
    }),
    file('T-3', { path: 'review.json', kind: 'review', runId: 'run-check', acceptedAt: '2026-10-21T12:00:00Z' }),
    // An idea the records do not hold reads as its story's title.
    file('T-4', {
      title: 'Tidy the press kit',
      path: 'press/kit notes.txt',
      kind: 'press-kit',
      workerId: 'W-9',
      runId: 'run-elsewhere',
      acceptedAt: '2026-10-19T12:00:00Z',
    }),
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path: string) => {
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
const rows = () => within(screen.getByRole('list', { name: 'Accepted files' })).getAllByRole('listitem');
const paths = () => rows().map(row => row.querySelector('.sd-mono')?.textContent);
const row = (path: string) => within(rows().find(item => item.querySelector('.sd-mono')?.textContent === path)!);

test("the page lists the project's accepted files newest first, each with its kind, agent, idea and time", async () => {
  open('/p/project-x/artifacts');
  expect(await screen.findByRole('heading', { level: 1, name: 'Artifacts' })).toBeTruthy();
  await screen.findByRole('list', { name: 'Accepted files' });
  expect(paths()).toEqual(['art/hero.svg', 'review.json', 'copy/launch.md', 'press/kit notes.txt']);
  expect(screen.getByText('4 files')).toBeTruthy();
  const hero = row('art/hero.svg');
  expect(hero.getByText('Drawing')).toBeTruthy();
  expect(hero.getByText('Ada')).toBeTruthy();
  expect(hero.getByText('“Make the launch page”')).toBeTruthy();
  expect(hero.getByText(when('2026-10-22T12:00:00Z')).getAttribute('datetime')).toBe('2026-10-22T12:00:00Z');
  const review = row('review.json');
  expect(review.getByText('Review')).toBeTruthy();
  expect(review.getByText('Eli')).toBeTruthy();
  expect(review.getByText('“Check the copy reads well”')).toBeTruthy();
  expect(review.getByText(when('2026-10-21T12:00:00Z'))).toBeTruthy();
  const kit = row('press/kit notes.txt');
  expect(kit.getByText('Press kit')).toBeTruthy();
  expect(kit.getByText('Sam')).toBeTruthy();
  expect(kit.getByText('Tidy the press kit')).toBeTruthy();
  expect(kit.getByText(when('2026-10-19T12:00:00Z'))).toBeTruthy();
  // Open opens the accepted attempt's file in a new tab.
  const link = kit.getByRole('link', { name: 'Open press/kit notes.txt' });
  expect(link.textContent).toBe('Open');
  expect(link.getAttribute('href')).toBe(
    '/api/attempts/attempt-T-4/artifact?projectId=project-x&path=press%2Fkit%20notes.txt',
  );
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');
  // The sidebar marks Artifacts as the page shown.
  expect(
    within(screen.getByRole('navigation', { name: 'Main' }))
      .getByRole('link', { name: 'Artifacts' })
      .getAttribute('aria-current'),
  ).toBe('page');
});

test('choosing an idea, an agent or a kind shows only the matching files, and clearing them shows all', async () => {
  const user = userEvent.setup();
  open('/p/project-x/artifacts');
  const idea = await screen.findByRole('combobox', { name: 'Idea' }),
    agent = screen.getByRole('combobox', { name: 'Agent' }),
    kind = screen.getByRole('combobox', { name: 'Kind' });
  const options = (select: HTMLElement) =>
    within(select)
      .getAllByRole('option')
      .map(option => option.textContent);
  // Each filter offers the listing's own values: ideas newest first, agents and kinds by name.
  expect(options(idea)).toEqual([
    'Every idea',
    '“Make the launch page”',
    '“Check the copy reads well”',
    'Tidy the press kit',
  ]);
  expect(options(agent)).toEqual(['Every agent', 'Ada', 'Eli', 'Sam']);
  expect(options(kind)).toEqual(['Every kind', 'Drawing', 'Press kit', 'Review', 'Written']);
  expect(screen.queryByRole('button', { name: 'Show every file' })).toBeNull();

  await user.selectOptions(idea, '“Make the launch page”');
  expect(paths()).toEqual(['art/hero.svg', 'copy/launch.md']);
  expect(screen.getByText('2 of 4 files')).toBeTruthy();
  await user.selectOptions(agent, 'Eli');
  expect(paths()).toEqual(['copy/launch.md']);
  await user.click(screen.getByRole('button', { name: 'Show every file' }));
  expect(paths()).toEqual(['art/hero.svg', 'review.json', 'copy/launch.md', 'press/kit notes.txt']);
  expect((idea as HTMLSelectElement).value).toBe('');
  expect((agent as HTMLSelectElement).value).toBe('');

  await user.selectOptions(kind, 'Review');
  expect(paths()).toEqual(['review.json']);
  // Filters that match nothing together say so.
  await user.selectOptions(agent, 'Ada');
  expect(screen.queryByRole('list', { name: 'Accepted files' })).toBeNull();
  expect(screen.getByText('No file matches these filters.')).toBeTruthy();
  await user.selectOptions(agent, 'Every agent');
  await user.selectOptions(kind, 'Every kind');
  expect(paths()).toEqual(['art/hero.svg', 'review.json', 'copy/launch.md', 'press/kit notes.txt']);
  expect(screen.getByText('4 files')).toBeTruthy();
});

test('a project whose accepted work has handed back no files says so', async () => {
  controller.projectArtifacts = [];
  open('/p/project-x/artifacts');
  expect(await screen.findByText('No accepted work has handed back files yet.')).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Accepted files' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Idea' })).toBeNull();
});

test('work accepted while the page is open joins the listing', async () => {
  open('/p/project-x/artifacts');
  await screen.findByRole('list', { name: 'Accepted files' });
  controller.projectArtifacts = [
    ...controller.projectArtifacts,
    file('T-5', { path: 'notes/new.md', acceptedAt: '2026-10-23T12:00:00Z' }),
  ];
  latest().emit('change', { version: 2, start: 'start-a', changes: [{ seq: 2, type: 'task', id: 'T-5' }] });
  await waitFor(() => expect(paths()[0]).toBe('notes/new.md'));
  expect(screen.getByText('5 files')).toBeTruthy();
});
