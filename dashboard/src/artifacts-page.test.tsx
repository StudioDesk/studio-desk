// The Artifacts page of a project that is not code (1.2 step 6): the library at the top, then The work, one row per
// file the work made with its kind, readable name, agent, idea or step and latest date, In the library or Add to the
// library, Open and its versions, the All, Documents and Images filter with the idea and agent choices, then the line
// counting the records of how the work was done with Open the ideas.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectWork, WorkFile, WorkVersion } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller;
const version = (taskId: string, n: number, extra: Partial<WorkVersion> = {}): WorkVersion => ({
  n,
  attemptId: `attempt-${taskId}-${n}`,
  workerId: 'W-1',
  hash: `hash-${taskId}-${n}`,
  at: '2026-10-20T12:00:00Z',
  current: false,
  why: null,
  ...extra,
});
const work = (taskId: string, path: string, extra: Partial<WorkFile> = {}): WorkFile => ({
  taskId,
  title: `Story ${taskId}`,
  runId: null,
  path,
  kind: 'work-file',
  hash: `hash-${taskId}-1`,
  attemptId: `attempt-${taskId}-1`,
  workerId: 'W-1',
  acceptedAt: '2026-10-20T12:00:00Z',
  libraryEntryId: null,
  versions: [version(taskId, 1, { current: true })],
  ...extra,
});
const records = (count: number): ProjectWork['records'] => ({
  count,
  kinds: count ? { plan: count - 8, review: 8 } : {},
});

beforeEach(() => {
  controller = fakeController();
  // A project of general work, not code.
  controller.shell.organizationConfiguration = { taskKinds: ['general:plan'] };
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
  controller.ideas = [{ id: 'run-pricing', brief: 'Plan the pricing table', taskIds: ['T-price'] }];
  // Newest first, as the controller answers. The launch copy was made three times and the library holds it.
  controller.projectWork = {
    work: [
      work('T-copy', 'copy/launch-page.md', {
        runId: 'run-launch',
        workerId: 'W-2',
        hash: 'hash-T-copy-3',
        attemptId: 'attempt-T-copy-3',
        acceptedAt: '2026-10-23T12:00:00Z',
        libraryEntryId: 'lib-copy',
        versions: [
          version('T-copy', 3, { workerId: 'W-2', at: '2026-10-23T12:00:00Z', current: true, why: 'Shorter.' }),
          version('T-copy', 2, { workerId: 'W-2', at: '2026-10-21T12:00:00Z' }),
          version('T-copy', 1, { workerId: 'W-2', at: '2026-10-19T12:00:00Z' }),
        ],
      }),
      work('T-hero', 'art/hero_banner.png', {
        runId: 'run-launch',
        workerId: 'W-2',
        kind: 'artwork',
        acceptedAt: '2026-10-22T12:00:00Z',
      }),
      work('T-price', 'pricing-table.csv', {
        runId: 'run-pricing',
        workerId: 'W-9',
        acceptedAt: '2026-10-21T12:00:00Z',
      }),
      // An idea the records do not hold reads as its step's title.
      work('T-notes', 'notes/release_notes.md', { runId: 'run-elsewhere', title: 'Write the release notes' }),
    ],
    pictures: [],
    records: records(17),
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x/artifacts') => {
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
const theWork = () => screen.getByRole('region', { name: 'The work' });
const rows = () => within(screen.getByRole('list', { name: 'The work' })).getAllByRole('listitem');
const names = () => rows().map(row => row.querySelector('[title]')?.textContent);
const row = (path: string) => within(rows().find(item => item.querySelector(`[title="${path}"]`))!);
const workReads = () => controller.reads().filter(url => url === '/api/projects/project-x/work').length;

test('the page names what it holds, keeps the library above the work and lists each file the work made', async () => {
  open();
  expect(await screen.findByRole('heading', { level: 1, name: 'Artifacts' })).toBeTruthy();
  expect(
    screen.getByText("What this project's work made and you accepted, one row per file, and your own uploads."),
  ).toBeTruthy();
  await screen.findByRole('list', { name: 'The work' });
  const library = screen.getByRole('region', { name: 'Library' });
  expect(within(library).getByRole('button', { name: 'Upload a file' })).toBeTruthy();
  expect(library.compareDocumentPosition(theWork()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(theWork()).getByRole('heading', { level: 2, name: 'The work' })).toBeTruthy();
  expect(within(theWork()).getByText('4 files · 6 versions')).toBeTruthy();
  // In the controller's order, each by its readable name.
  expect(names()).toEqual(['Launch page', 'Hero banner', 'Pricing table', 'Release notes']);

  const copy = row('copy/launch-page.md');
  expect(copy.getByText('Document')).toBeTruthy();
  expect(copy.getByText(`Ada · “Make the launch page” · ${when('2026-10-23T12:00:00Z')}`)).toBeTruthy();
  // The library holds it, and it was made three times.
  expect(copy.getByText('In the library')).toBeTruthy();
  expect(copy.queryByRole('button', { name: /to the library/ })).toBeNull();
  expect(copy.getByText('3 versions')).toBeTruthy();
  // Open opens the newest version in a new tab.
  const link = copy.getByRole('link', { name: 'Open copy/launch-page.md' });
  expect(link.textContent).toBe('Open');
  expect(link.getAttribute('href')).toBe(
    '/api/attempts/attempt-T-copy-3/artifact?projectId=project-x&path=copy%2Flaunch-page.md',
  );
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');

  const hero = row('art/hero_banner.png');
  expect(hero.getByText('Image')).toBeTruthy();
  expect(hero.getByText(`Ada · “Make the launch page” · ${when('2026-10-22T12:00:00Z')}`)).toBeTruthy();
  // The library does not hold it, and a file made once says nothing of versions.
  expect(hero.getByRole('button', { name: 'Add art/hero_banner.png to the library' }).textContent).toBe(
    'Add to the library',
  );
  expect(hero.queryByText('In the library')).toBeNull();
  expect(hero.queryByText(/versions?$/)).toBeNull();
  // A finished idea the records name, by an agent only the company's directory holds.
  expect(
    row('pricing-table.csv').getByText(`Sam · “Plan the pricing table” · ${when('2026-10-21T12:00:00Z')}`),
  ).toBeTruthy();
  expect(
    row('notes/release_notes.md').getByText(`Eli · “Write the release notes” · ${when('2026-10-20T12:00:00Z')}`),
  ).toBeTruthy();
  // The sidebar marks Artifacts as the page shown.
  expect(
    within(screen.getByRole('navigation', { name: 'Main' }))
      .getByRole('link', { name: 'Artifacts' })
      .getAttribute('aria-current'),
  ).toBe('page');
});

test('All, Documents and Images, an idea and an agent narrow the rows, and filters matching nothing say so', async () => {
  const user = userEvent.setup();
  open();
  await screen.findByRole('list', { name: 'The work' });
  const show = within(screen.getByRole('group', { name: 'Show' })),
    pressed = () =>
      show
        .getAllByRole('button')
        .filter(button => button.getAttribute('aria-pressed') === 'true')
        .map(button => button.textContent);
  expect(show.getAllByRole('button').map(button => button.textContent)).toEqual(['All', 'Documents', 'Images']);
  expect(pressed()).toEqual(['All']);
  const idea = screen.getByRole('combobox', { name: 'Idea' }),
    agent = screen.getByRole('combobox', { name: 'Agent' });
  const options = (select: HTMLElement) =>
    within(select)
      .getAllByRole('option')
      .map(option => option.textContent);
  // Ideas newest first, as the work lists them, and agents by name, each after its any choice.
  expect(options(idea)).toEqual([
    'Any idea',
    '“Make the launch page”',
    '“Plan the pricing table”',
    '“Write the release notes”',
  ]);
  expect(options(agent)).toEqual(['Any agent', 'Ada', 'Eli', 'Sam']);
  expect(screen.queryByRole('button', { name: 'Show every file' })).toBeNull();

  await user.click(show.getByRole('button', { name: 'Images' }));
  expect(pressed()).toEqual(['Images']);
  expect(names()).toEqual(['Hero banner']);
  await user.click(show.getByRole('button', { name: 'Documents' }));
  expect(names()).toEqual(['Launch page', 'Pricing table', 'Release notes']);
  await user.selectOptions(idea, '“Make the launch page”');
  expect(names()).toEqual(['Launch page']);
  await user.click(show.getByRole('button', { name: 'All' }));
  expect(names()).toEqual(['Launch page', 'Hero banner']);
  // The count stays the work's own.
  expect(within(theWork()).getByText('4 files · 6 versions')).toBeTruthy();
  // Filters that match nothing together say so.
  await user.selectOptions(agent, 'Sam');
  expect(screen.queryByRole('list', { name: 'The work' })).toBeNull();
  expect(screen.getByText('No file matches these filters.')).toBeTruthy();
  await user.selectOptions(idea, 'Any idea');
  expect(names()).toEqual(['Pricing table']);
  await user.selectOptions(agent, 'Any agent');
  expect(names()).toEqual(['Launch page', 'Hero banner', 'Pricing table', 'Release notes']);

  await user.selectOptions(agent, 'Eli');
  expect(names()).toEqual(['Release notes']);
  await user.click(screen.getByRole('button', { name: 'Show every file' }));
  expect(names()).toEqual(['Launch page', 'Hero banner', 'Pricing table', 'Release notes']);
  expect((idea as HTMLSelectElement).value).toBe('');
  expect((agent as HTMLSelectElement).value).toBe('');
  expect(pressed()).toEqual(['All']);
});

test('the records line counts the records of how the work was done, and Open the ideas goes to the ideas', async () => {
  const user = userEvent.setup();
  const router = open();
  const line = (await screen.findByText(/^17 records of how the work was done\. /)).closest('p')!;
  expect(line.textContent).toBe(
    '17 records of how the work was done. The plans, reviews and check results stay on each idea and story, where ' +
      'they explain the work. They are never listed here. Open the ideas',
  );
  // It follows the work.
  expect(theWork().compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const ideas = within(line).getByRole('link', { name: 'Open the ideas' });
  expect(ideas.getAttribute('href')).toBe('/p/project-x/runs');
  await user.click(ideas);
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/runs'));
});

test('a project with no records has no records line', async () => {
  controller.projectWork = { ...controller.projectWork, records: records(0) };
  open();
  await screen.findByRole('list', { name: 'The work' });
  expect(screen.queryByText(/records? of how/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open the ideas' })).toBeNull();
});

test('a project whose work has made nothing yet says so plainly', async () => {
  controller.projectWork = { work: [], pictures: [], records: records(0) };
  open();
  expect(
    await within(await screen.findByRole('region', { name: 'The work' })).findByText('Nothing has been made yet.'),
  ).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'The work' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Idea' })).toBeNull();
  expect(screen.queryByText(/files? · \d+ versions?/)).toBeNull();
});

test('work accepted while the page is open reads the work again, and joins it', async () => {
  open();
  await screen.findByRole('list', { name: 'The work' });
  const reads = workReads();
  controller.projectWork = {
    ...controller.projectWork,
    work: [work('T-5', 'notes/new-plan.md', { acceptedAt: '2026-10-24T12:00:00Z' }), ...controller.projectWork.work],
  };
  latest().emit('change', { version: 2, start: 'start-a', changes: [{ seq: 2, type: 'task', id: 'T-5' }] });
  await waitFor(() => expect(names()[0]).toBe('New plan'));
  expect(workReads()).toBeGreaterThan(reads);
  expect(within(theWork()).getByText('5 files · 7 versions')).toBeTruthy();
});

test('a library change while the page is open reads the work again, so the file it added shows In the library', async () => {
  open();
  await screen.findByRole('list', { name: 'The work' });
  expect(
    row('art/hero_banner.png').getByRole('button', { name: 'Add art/hero_banner.png to the library' }),
  ).toBeTruthy();
  controller.projectWork = {
    ...controller.projectWork,
    work: controller.projectWork.work.map(file =>
      file.taskId === 'T-hero' ? { ...file, libraryEntryId: 'lib-hero' } : file,
    ),
  };
  latest().emit('change', {
    version: 2,
    start: 'start-a',
    changes: [{ seq: 2, type: 'event', id: 9, kind: 'library_added', projectId: 'project-x' }],
  });
  expect(await row('art/hero_banner.png').findByText('In the library')).toBeTruthy();
  expect(row('art/hero_banner.png').queryByRole('button', { name: /to the library/ })).toBeNull();
});
