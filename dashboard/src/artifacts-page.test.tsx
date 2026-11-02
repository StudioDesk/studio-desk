// The Artifacts page of a project that is not code (1.2 step 6), as the director's frames draw it: Upload a file in
// its header, the library at the top, then The work in one card, one row per file the work made with its kind tile,
// readable name, agent, idea or step and latest date, In the library or Add to the library, its versions and Open (or
// Download), the All, Documents N and Images N choice with the idea and agent choices, and at the card's foot the line
// counting the records of how the work was done with Open the ideas. Beside them the panel: picking a library card, a
// row or Open reads that file there, and on a phone the panel opens under what was picked. A code project's page: the
// card saying its code is in the repository with Open Releases, the library, and what the work made that isn't code
// with each story's visual check opening the story on its Pages tab and its records line with Open the board, and no
// snapshots.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LibraryEntry, LibraryReader, ProjectWork, WorkFile, WorkPictures, WorkVersion } from './api';
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
  // The window's own, which jsdom does not have.
  delete (Element.prototype as Partial<Element>).scrollIntoView;
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
const lead =
  "What this project's work made and you accepted, one row per file, and your own uploads. At the top, the library: " +
  'the files every agent follows.';
const theWork = () => screen.getByRole('region', { name: 'The work' });
const rows = () => within(screen.getByRole('list', { name: 'The work' })).getAllByRole('listitem');
const names = () => rows().map(row => row.querySelector('[title]')?.textContent);
const row = (path: string) => within(rows().find(item => item.querySelector(`[title="${path}"]`))!);
const header = () => screen.getByRole('heading', { level: 1, name: 'Artifacts' }).closest('header')!;
const workReads = () => controller.reads().filter(url => url === '/api/projects/project-x/work').length;

test('the page names what it holds, keeps the library above the work and lists each file the work made', async () => {
  open();
  expect(await screen.findByRole('heading', { level: 1, name: 'Artifacts' })).toBeTruthy();
  expect(screen.getByText(lead)).toBeTruthy();
  await screen.findByRole('list', { name: 'The work' });
  const library = screen.getByRole('region', { name: 'Library' });
  expect(within(library).getByRole('heading', { level: 2, name: 'The library' })).toBeTruthy();
  expect(library.compareDocumentPosition(theWork()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(theWork()).getByRole('heading', { level: 2, name: 'The work' })).toBeTruthy();
  expect(within(theWork()).getByText('4 files · 6 versions')).toBeTruthy();
  // In the controller's order, each by its readable name.
  expect(names()).toEqual(['Launch page', 'Hero banner', 'Pricing table', 'Release notes']);

  const copy = row('copy/launch-page.md');
  // Its kind's tile, which a screen reader skips for the name and path.
  expect(copy.getByText('MD').getAttribute('aria-hidden')).toBe('true');
  expect(copy.getByText(`Ada · “Make the launch page” · ${when('2026-10-23T12:00:00Z')}`)).toBeTruthy();
  // The library holds it, and it was made three times, which opens its versions (work-versions.test.tsx).
  expect(copy.getByText('In the library')).toBeTruthy();
  expect(copy.queryByRole('button', { name: /to the library/ })).toBeNull();
  const versions = copy.getByRole('button', { name: '3 versions of copy/launch-page.md' });
  expect(versions.textContent).toBe('3 versions');
  expect(versions.getAttribute('aria-expanded')).toBe('false');
  // Open is a link to the newest version, which a click with a key held opens in a new tab.
  const link = copy.getByRole('link', { name: 'Open copy/launch-page.md' });
  expect(link.textContent).toBe('Open');
  expect(link.getAttribute('href')).toBe(
    '/api/attempts/attempt-T-copy-3/artifact?projectId=project-x&path=copy%2Flaunch-page.md',
  );
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');

  const hero = row('art/hero_banner.png');
  expect(hero.getByText('PNG')).toBeTruthy();
  expect(hero.getByText(`Ada · “Make the launch page” · ${when('2026-10-22T12:00:00Z')}`)).toBeTruthy();
  // The library does not hold it, and a file made once says nothing of versions.
  expect(hero.getByRole('button', { name: 'Add art/hero_banner.png to the library' }).textContent).toBe(
    'Add to the library',
  );
  expect(hero.queryByText('In the library')).toBeNull();
  expect(hero.queryByText(/versions?$/)).toBeNull();
  expect(hero.queryByRole('button', { name: /versions? of/ })).toBeNull();
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

test('All, Documents N and Images N, an idea and an agent narrow the rows, and filters matching nothing say so', async () => {
  const user = userEvent.setup();
  open();
  await screen.findByRole('list', { name: 'The work' });
  const show = within(screen.getByRole('group', { name: 'Show' })),
    pressed = () =>
      show
        .getAllByRole('button')
        .filter(button => button.getAttribute('aria-pressed') === 'true')
        .map(button => button.textContent);
  // Each kind with how many of the work's files it holds, in the work's card beside its heading.
  expect(show.getAllByRole('button').map(button => button.textContent)).toEqual(['All', 'Documents 3', 'Images 1']);
  expect(theWork().contains(screen.getByRole('group', { name: 'Show' }))).toBe(true);
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

  await user.click(show.getByRole('button', { name: 'Images 1' }));
  expect(pressed()).toEqual(['Images 1']);
  expect(names()).toEqual(['Hero banner']);
  await user.click(show.getByRole('button', { name: 'Documents 3' }));
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

test("the records line at the foot of the work's card counts the records of how the work was done, and Open the ideas goes to the ideas", async () => {
  const user = userEvent.setup();
  const router = open();
  const line = (await screen.findByText('17 records of how the work was done')).closest('div')!;
  expect(
    within(line).getByText(
      'The plans, reviews and check results stay on each idea and story, where they explain the work. They are ' +
        'never listed here.',
    ),
  ).toBeTruthy();
  // It sits inside the work's card, after its rows.
  expect(theWork().contains(line)).toBe(true);
  expect(
    screen.getByRole('list', { name: 'The work' }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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

// A code project: its code stories' files are records, so the work is what its other steps handed back, and one
// story's visual check took four pictures.
const pictures = (taskId: string, title: string, at: string, count: number): WorkPictures => ({
  taskId,
  title,
  runId: 'run-launch',
  attemptId: `attempt-${taskId}-candidate`,
  at,
  images: Array.from({ length: count }, (_, index) => ({ path: `pages/page-${index + 1}.png`, hash: `hash-${index}` })),
});
const codeProject = () => {
  controller.shell.organizationConfiguration = {
    taskKinds: ['studio-development:breakdown', 'studio-development:change'],
  };
  controller.projectWork = {
    work: [
      work('T-plan', 'docs/launch-plan.md', {
        runId: 'run-launch',
        workerId: 'W-2',
        hash: 'hash-T-plan-2',
        attemptId: 'attempt-T-plan-2',
        acceptedAt: '2026-10-23T12:00:00Z',
        libraryEntryId: 'lib-plan',
        versions: [
          version('T-plan', 2, { workerId: 'W-2', at: '2026-10-23T12:00:00Z', current: true, why: 'Shorter.' }),
          version('T-plan', 1, { workerId: 'W-2', at: '2026-10-21T12:00:00Z' }),
        ],
      }),
      work('T-notes', 'notes/release_notes.md', { title: 'Write the release notes' }),
    ],
    pictures: [pictures('T-cards', 'Board cards show their stage', '2026-10-22T12:00:00Z', 4)],
    records: records(653),
  };
};
const codeLead =
  "The files that go with this project's code: the library every agent follows, and what the work made that isn't " +
  'code. The code itself lives in the repository.';
const notCode = () => screen.getByRole('region', { name: "What the work made that isn't code" });

test("a code project's page says its code is in the repository, with Open Releases, above the library and no snapshots", async () => {
  const user = userEvent.setup();
  codeProject();
  const router = open();
  expect(await screen.findByText(codeLead)).toBeTruthy();
  expect(screen.queryByText(lead)).toBeNull();
  const card = screen.getByRole('region', { name: 'The code is in the repository' });
  expect(
    within(card).getByText("Each story's changes are on its Changes tab, and what each line shipped is on Releases."),
  ).toBeTruthy();
  // The library follows, and Upload a file is in the page's header, as on any project.
  const library = screen.getByRole('region', { name: 'Library' });
  expect(within(header()).getByRole('button', { name: 'Upload a file' })).toBeTruthy();
  expect(card.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await screen.findByRole('list', { name: 'The work' });
  expect(library.compareDocumentPosition(notCode()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // A code project has Releases, not snapshots.
  expect(screen.queryByRole('region', { name: 'Snapshots' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New snapshot' })).toBeNull();
  expect(controller.reads()).not.toContain('/api/projects/project-x/snapshots');

  const releases = within(card).getByRole('link', { name: 'Open Releases' });
  expect(releases.getAttribute('href')).toBe('/p/project-x/releases');
  await user.click(releases);
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/releases'));
});

test("what the work made that isn't code lists a step's documents and each story's visual check, which opens its Pages tab", async () => {
  const user = userEvent.setup();
  codeProject();
  const router = open();
  await screen.findByRole('list', { name: 'The work' });
  expect(within(notCode()).getByRole('heading', { level: 2, name: "What the work made that isn't code" })).toBeTruthy();
  // The documents first, then the visual check, without the work's own heading or filter.
  expect(rows()).toHaveLength(3);
  expect(names()).toEqual(['Launch plan', 'Release notes', undefined]);
  expect(screen.queryByRole('region', { name: 'The work' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();

  // A step's document reads as on any project: its kind, line, versions, In the library and Open.
  const plan = row('docs/launch-plan.md');
  expect(plan.getByText('MD')).toBeTruthy();
  expect(plan.getByText(`Ada · “Make the launch page” · ${when('2026-10-23T12:00:00Z')}`)).toBeTruthy();
  expect(plan.getByText('In the library')).toBeTruthy();
  expect(plan.getByRole('button', { name: '2 versions of docs/launch-plan.md' }).textContent).toBe('2 versions');
  expect(plan.getByRole('link', { name: 'Open docs/launch-plan.md' }).getAttribute('href')).toBe(
    '/api/attempts/attempt-T-plan-2/artifact?projectId=project-x&path=docs%2Flaunch-plan.md',
  );
  // One the library does not hold offers Add to the library, which opens it.
  const notes = row('notes/release_notes.md');
  expect(notes.getByText(`Eli · “Write the release notes” · ${when('2026-10-20T12:00:00Z')}`)).toBeTruthy();
  await user.click(notes.getByRole('button', { name: 'Add notes/release_notes.md to the library' }));
  const adding = await screen.findByRole('dialog', { name: 'Add to the library' });
  await user.click(within(adding).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to the library' })).toBeNull());

  // The visual check reads as its story's row and opens the story on its Pages tab.
  const check = within(rows()[2]!).getByRole('link');
  expect(check.textContent).toBe(
    `The visual check · “Board cards show their stage” · ${when('2026-10-22T12:00:00Z')} · 4 pictures`,
  );
  expect(check.getAttribute('href')).toBe('/p/project-x/tasks/T-cards?tab=pages');
  await user.click(check);
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/tasks/T-cards'));
  expect(router.state.location.search).toEqual({ tab: 'pages' });
});

test("a code project's records line counts how the stories were built, and Open the board goes to the board", async () => {
  const user = userEvent.setup();
  codeProject();
  const router = open();
  const line = (await screen.findByText('653 records of how the stories were built')).closest('div')!;
  expect(
    within(line).getByText(
      "Reviews, test results, plans and the copies of changed files stay on each story's Changes, Checks and " +
        'Activity. They are never listed here.',
    ),
  ).toBeTruthy();
  // Inside the card of what the work made that isn't code, after its rows and visual checks.
  expect(notCode().contains(line)).toBe(true);
  expect(
    screen.getByRole('list', { name: 'The work' }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Open the ideas' })).toBeNull();
  const board = within(line).getByRole('link', { name: 'Open the board' });
  expect(board.getAttribute('href')).toBe('/p/project-x/board');
  await user.click(board);
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/board'));
});

test('a code project whose work has made nothing that is not code says so plainly, and a visual check alone is listed', async () => {
  codeProject();
  controller.projectWork = { work: [], pictures: [], records: records(0) };
  open();
  const section = within(await screen.findByRole('region', { name: "What the work made that isn't code" }));
  expect(await section.findByText('Nothing has been made yet.')).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'The work' })).toBeNull();
  // With no records the line is left out.
  expect(screen.queryByText(/records? of how/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open the board' })).toBeNull();
  cleanup();

  controller.projectWork = {
    work: [],
    pictures: [pictures('T-cards', 'Board cards show their stage', '2026-10-22T12:00:00Z', 1)],
    records: records(0),
  };
  open();
  await screen.findByRole('list', { name: 'The work' });
  expect(rows()).toHaveLength(1);
  expect(within(rows()[0]!).getByRole('link').textContent).toBe(
    `The visual check · “Board cards show their stage” · ${when('2026-10-22T12:00:00Z')} · 1 picture`,
  );
  expect(screen.queryByText('Nothing has been made yet.')).toBeNull();
});

// The library a project's agents follow: brand guidelines at their second revision, which six attempts read, and a
// photo nobody has read yet.
const libraryFile = (id: string, name: string, purpose: string, file: string, revisions: number, byteLength: number) =>
  ({
    id,
    name,
    purpose,
    createdAt: '2026-10-28T12:00:00Z',
    by: { type: 'director' },
    revisions: Array.from({ length: revisions }, (_, index) => ({
      revision: index + 1,
      file,
      mediaType: file.endsWith('.md') ? 'text/markdown' : 'image/jpeg',
      byteLength,
      sha256: `sha-${id}-${index + 1}`,
      source: { type: 'upload' },
      at: '2026-10-28T12:00:00Z',
      by: { type: 'director' },
    })),
  }) as LibraryEntry;
const reader = (attemptId: string): LibraryReader => ({
  attemptId,
  taskId: 'T-9',
  status: 'accepted',
  startedAt: '2026-10-28T13:00:00Z',
  revision: 2,
  delivered: true,
});
const withLibrary = () => {
  controller.library = {
    entries: [
      libraryFile('lib-brand', 'Brand guidelines', 'How everything looks and sounds.', 'brand.md', 2, 9 * 1024),
      libraryFile('lib-photo', 'Shop front photo', 'What the shop looks like.', 'shop-front.jpg', 1, 2.4 * 1024 * 1024),
    ],
    proposals: [],
  };
  controller.libraryReaders = { 'lib-brand': ['a', 'b', 'c', 'd', 'e', 'f'].map(reader), 'lib-photo': [] };
  controller.libraryTexts = { 'lib-brand/2': '# Brand\n\nWarm and plain.\n' };
};
const libraryCard = (name: string) =>
  within(screen.getByRole('list', { name: 'Library files' })).getByRole('button', { name });
const pickNote = 'Pick a file to read it here.';
// The window's width as useNarrow reads it: a phone matches the design's break. afterEach puts the window's own back.
const phone = () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  return scrolled;
};
const rowItem = (path: string) => document.querySelector(`b[title="${path}"]`)!.closest('[role="listitem"]')!;

test("Upload a file is in the page's header and opens the upload dialog", async () => {
  const user = userEvent.setup();
  open();
  await screen.findByRole('list', { name: 'The work' });
  expect(
    within(screen.getByRole('region', { name: 'Library' })).queryByRole('button', { name: 'Upload a file' }),
  ).toBeNull();
  await user.click(within(header()).getByRole('button', { name: 'Upload a file' }));
  const upload = within(await screen.findByRole('dialog', { name: 'Upload a file' }));
  expect(upload.getByLabelText('File')).toBeTruthy();
  await user.click(upload.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upload a file' })).toBeNull());
});

test("the library's cards show their kind, a revision chip and who read them, under the library's total", async () => {
  withLibrary();
  open();
  const list = await screen.findByRole('list', { name: 'Library files' }),
    library = within(screen.getByRole('region', { name: 'Library' }));
  expect(library.getByText('every agent in the project follows these')).toBeTruthy();
  const total = library.getByText('2 files · 2.4 MiB');
  expect(library.getByText('of the 20 MiB every attempt receives in full')).toBeTruthy();
  expect(total.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const brand = within(libraryCard('Brand guidelines'));
  expect(brand.getByText('MD')).toBeTruthy();
  expect(brand.getByText('How everything looks and sounds.')).toBeTruthy();
  expect(brand.getByText('revision 2')).toBeTruthy();
  expect(await brand.findByText('9.0 KiB · read by 6 attempts')).toBeTruthy();
  const photo = within(libraryCard('Shop front photo'));
  expect(photo.getByText('JPG')).toBeTruthy();
  expect(photo.getByText('revision 1')).toBeTruthy();
  expect(await photo.findByText('2.4 MiB · not read yet')).toBeTruthy();
  // Nothing is picked yet, and the panel says so.
  expect(libraryCard('Brand guidelines').getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByText(pickNote)).toBeTruthy();
});

test('picking a library card presses it and reads it in the panel beside the files, and picking a file of the work moves the panel to it', async () => {
  const user = userEvent.setup();
  withLibrary();
  controller.artifacts['attempt-T-copy-3/copy/launch-page.md'] = '# Launch\n\nWelcome to the studio.\n';
  open();
  await screen.findByRole('list', { name: 'The work' });
  await user.click(await screen.findByRole('button', { name: 'Brand guidelines' }));
  expect(libraryCard('Brand guidelines').getAttribute('aria-pressed')).toBe('true');
  expect(libraryCard('Shop front photo').getAttribute('aria-pressed')).toBe('false');
  const panel = await screen.findByRole('complementary', { name: 'Brand guidelines' });
  expect(await within(panel).findByText('Warm and plain.')).toBeTruthy();
  expect(screen.queryByText(pickNote)).toBeNull();
  // The panel stands in its own column, after every card, row and snapshot of the files' column.
  expect(screen.getByRole('list', { name: 'Library files' }).contains(panel)).toBe(false);
  expect(theWork().compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Open on a file of the work reads it there instead, and no card stays pressed.
  await user.click(row('copy/launch-page.md').getByRole('link', { name: 'Open copy/launch-page.md' }));
  expect(await screen.findByRole('complementary', { name: 'Launch page' })).toBeTruthy();
  expect(screen.queryByRole('complementary', { name: 'Brand guidelines' })).toBeNull();
  expect(libraryCard('Brand guidelines').getAttribute('aria-pressed')).toBe('false');
  // Close leaves nothing picked.
  await user.click(
    within(screen.getByRole('complementary', { name: 'Launch page' })).getByRole('button', { name: 'Close' }),
  );
  expect(screen.queryByRole('complementary', { name: 'Launch page' })).toBeNull();
  expect(screen.getByText(pickNote)).toBeTruthy();
});

test('Open on a Markdown row reads it in the panel, with no new page and nothing downloaded', async () => {
  const user = userEvent.setup();
  controller.artifacts['attempt-T-copy-3/copy/launch-page.md'] = '# Launch\n\nWelcome to the studio.\n';
  const router = open();
  await screen.findByRole('list', { name: 'The work' });
  const link = row('copy/launch-page.md').getByRole('link', { name: 'Open copy/launch-page.md' });
  expect(link.hasAttribute('download')).toBe(false);
  let prevented = false;
  const seen = (event: Event) => (prevented = event.defaultPrevented);
  document.addEventListener('click', seen);
  try {
    await user.click(link);
  } finally {
    document.removeEventListener('click', seen);
  }
  // The link's own navigation is held back, and the page stays where it was.
  expect(prevented).toBe(true);
  expect(router.state.location.pathname).toBe('/p/project-x/artifacts');
  const panel = within(await screen.findByRole('complementary', { name: 'Launch page' }));
  expect(await panel.findByRole('heading', { level: 1, name: 'Launch' })).toBeTruthy();
  expect(panel.getByText('Welcome to the studio.')).toBeTruthy();
  // The newest version alone was read, for the panel.
  expect(controller.reads().filter(url => url.startsWith('/api/attempts/'))).toEqual([
    '/api/attempts/attempt-T-copy-3/artifact?projectId=project-x&path=copy%2Flaunch-page.md',
  ]);
  // The row stands picked.
  expect(rowItem('copy/launch-page.md').getAttribute('aria-current')).toBe('true');
});

test("a file the page can't show offers Download, a plain download link, and picking its row says so in the panel", async () => {
  const user = userEvent.setup();
  controller.projectWork = {
    ...controller.projectWork,
    work: [work('T-deck', 'decks/pitch.pdf', { title: 'Make the pitch deck' }), ...controller.projectWork.work],
  };
  open();
  await screen.findByRole('list', { name: 'The work' });
  const deck = row('decks/pitch.pdf'),
    download = deck.getByRole('link', { name: 'Download decks/pitch.pdf' });
  expect(download.textContent).toBe('Download');
  expect(download.hasAttribute('download')).toBe(true);
  expect(download.getAttribute('href')).toBe(
    '/api/attempts/attempt-T-deck-1/artifact?projectId=project-x&path=decks%2Fpitch.pdf',
  );
  expect(download.hasAttribute('target')).toBe(false);
  expect(deck.queryByRole('link', { name: 'Open decks/pitch.pdf' })).toBeNull();
  expect(deck.getByText('PDF')).toBeTruthy();
  // Its row, picked away from its buttons, reads in the panel as a file to download, reading nothing.
  await user.click(deck.getByText('Pitch'));
  const panel = within(await screen.findByRole('complementary', { name: 'Pitch' }));
  expect(panel.getByText("This file can't be shown here. Download it to look at the recorded file.")).toBeTruthy();
  expect(controller.reads().filter(url => url.startsWith('/api/attempts/'))).toEqual([]);
});

test('on a phone the panel opens under the picked row or card, comes into view, and Close puts it away', async () => {
  const user = userEvent.setup();
  const scrolled = phone();
  withLibrary();
  controller.artifacts['attempt-T-copy-3/copy/launch-page.md'] = '# Launch\n\nWelcome to the studio.\n';
  open();
  await screen.findByRole('list', { name: 'The work' });
  // No column beside the files, so nothing says to pick one there.
  expect(screen.queryByText(pickNote)).toBeNull();
  await user.click(row('copy/launch-page.md').getByRole('link', { name: 'Open copy/launch-page.md' }));
  const panel = await screen.findByRole('complementary', { name: 'Launch page' }),
    picked = rowItem('copy/launch-page.md');
  // Right after the row's own line and buttons, inside its item, and before the next row.
  expect(picked.lastElementChild!.contains(panel)).toBe(true);
  expect(
    within(picked as HTMLElement)
      .getByRole('link', { name: 'Open copy/launch-page.md' })
      .compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(panel.compareDocumentPosition(rowItem('art/hero_banner.png')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(scrolled).toHaveBeenCalledOnce();
  expect(await within(panel).findByText('Welcome to the studio.')).toBeTruthy();
  await user.click(within(panel).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('complementary', { name: 'Launch page' })).toBeNull();

  // A library card's panel takes a whole row of the grid right after the card.
  await user.click(libraryCard('Brand guidelines'));
  const card = libraryCard('Brand guidelines').closest('li')!,
    brand = await screen.findByRole('complementary', { name: 'Brand guidelines' });
  expect(card.nextElementSibling!.contains(brand)).toBe(true);
  expect(scrolled).toHaveBeenCalledTimes(2);
  await user.click(within(brand).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('complementary', { name: 'Brand guidelines' })).toBeNull();
});

test('where both columns do not fit the page, the panel opens under the picked row as on a phone', async () => {
  const user = userEvent.setup();
  // The browser measures the columns' row narrower than both columns need.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      changed: ResizeObserverCallback;
      constructor(changed: ResizeObserverCallback) {
        this.changed = changed;
      }
      observe() {
        this.changed([{ contentRect: { width: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  open();
  await screen.findByRole('list', { name: 'The work' });
  expect(screen.queryByText(pickNote)).toBeNull();
  await user.click(row('art/hero_banner.png').getByRole('link', { name: 'Open art/hero_banner.png' }));
  const panel = await screen.findByRole('complementary', { name: 'Hero banner' });
  expect(rowItem('art/hero_banner.png').contains(panel)).toBe(true);
});

test('the page remembers no pick: leaving it and coming back shows nothing picked', async () => {
  const user = userEvent.setup();
  withLibrary();
  const router = open();
  await user.click(await screen.findByRole('button', { name: 'Brand guidelines' }));
  expect(await screen.findByRole('complementary', { name: 'Brand guidelines' })).toBeTruthy();
  // Nothing of the pick is in the address.
  expect(router.state.location.search).toEqual({});
  await router.navigate({ to: '/p/$projectId/board', params: { projectId: 'project-x' } });
  await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'Artifacts' })).toBeNull());
  await router.navigate({ to: '/p/$projectId/artifacts', params: { projectId: 'project-x' } });
  expect(await screen.findByText(pickNote)).toBeTruthy();
  expect(screen.queryByRole('complementary', { name: 'Brand guidelines' })).toBeNull();
  expect(libraryCard('Brand guidelines').getAttribute('aria-pressed')).toBe('false');
});
