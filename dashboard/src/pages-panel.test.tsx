// A code story names the pages its next visual check captures (1.2 step 8) on its Pages tab, read from its pages view
// and the project's visual check view as the stand-in controller serves them: each page's name, path and steps in
// words, whether they were planned with the story or changed by the director, and while they may still change, Add a
// page and Edit, which send the whole list to the controller. A story with no pages, no capture and the check off
// keeps its tabs. Below them, what the check of the story's candidate captured, from its recorded visual-check.json,
// with the review's note on each image, or why nothing was, and The pages tile, which opens the tab. Model-free.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StoryPage, StoryPagesView, VisualCheckRecord, VisualImage, VisualNote, VisualTheme } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
  story();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () =>
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/tasks/T-1'] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

// A code story in review whose candidate, Eli's build, passed its tests, so it may be tried too.
function story() {
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Show the received files',
      kind: 'studio-development:change',
      status: 'review',
      lastAttemptId: 'attempt-review',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'candidate-review',
        current: 'review',
        candidate: { taskId: 'T-1', attemptId: 'attempt-build', workerId: 'W-1', hash: 'manifest-hash' },
        review: { attemptId: 'attempt-review', workerId: 'W-2' },
        history: [],
      },
    }),
  ];
  controller.attempts = [
    {
      id: 'attempt-build',
      taskId: 'T-1',
      projectId: 'project-x',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: '2026-10-29T08:00:00.000Z',
      finishedAt: '2026-10-29T08:20:00.000Z',
      assignment: { kind: 'studio-development:change' },
      result: { outcome: 'completed', summary: 'Shows the received files.' },
      testEvidence: { totals: { tests: 752, pass: 752, fail: 0 } },
    },
    {
      id: 'attempt-review',
      taskId: 'T-1',
      projectId: 'project-x',
      status: 'running',
      workerId: 'W-2',
      startedAt: '2026-10-29T08:30:00.000Z',
      assignment: { kind: 'studio-development:change-review' },
    },
  ];
}

const board: StoryPage = { name: 'Board', path: '/', steps: [] },
  settings: StoryPage = {
    name: 'Settings',
    path: '/settings',
    steps: [{ click: 'Visual check' }, { type: 'Edge', into: 'Browser' }, { wait: 'Saved' }],
  };
const pages = (list: StoryPage[], fields: Partial<StoryPagesView> = {}) =>
  (controller.pages['T-1'] = { pages: list, changed: false, editable: true, reason: null, ...fields });
const checkOn = () => (controller.visualView.settings.enabled = true);
// The stand-in saves the pages it is sent as the director's own, as the controller does.
const savePages = (url: string, method: string, body: unknown) => {
  if (url === '/api/tasks/T-1/pages' && method === 'POST')
    pages((body as { pages: StoryPage[] }).pages, { changed: true });
  return {};
};
const posts = () => controller.requests.filter(request => request.method === 'POST');
const pageReads = () => controller.reads().filter(url => url === '/api/tasks/T-1/pages?projectId=project-x').length;

const tabNames = async () =>
  within(await screen.findByRole('tablist', { name: 'Story details' }, { timeout: 5000 }))
    .getAllByRole('tab')
    .map(tab => tab.firstChild?.textContent);
// The tabs once Pages shows, which is when the story's pages and the project's check are read.
const tabsWithPages = async () => {
  await screen.findByRole('tab', { name: 'Pages' }, { timeout: 5000 });
  return tabNames();
};
// Opens the Pages tab and gives its panel once the story's pages are read.
const pagesTab = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('tab', { name: 'Pages' }, { timeout: 5000 }));
  const panel = within(screen.getByRole('tabpanel'));
  await panel.findByRole('region', { name: "This story's pages" });
  return panel;
};
// A page's row in the list, by its name.
const pageRow = (panel: ReturnType<typeof within>, name: string) =>
  within(panel.getByText(name, { selector: 'b' }).closest('li')!);
const dialogOf = async (name: string) => within(await screen.findByRole('dialog', { name }));
const field = (dialog: ReturnType<typeof within>, label: string) => dialog.getByLabelText(label) as HTMLInputElement;

test('a story whose pages view lists a page shows Pages after Checks, with its name, path and steps in words', async () => {
  const user = userEvent.setup();
  pages([settings]);
  open();
  expect(await tabsWithPages()).toEqual(['Changes', 'Checks', 'Pages', 'Try it', 'Activity']);
  // The story still opens on its change.
  expect(screen.getByRole('tab', { name: /^Changes/ }).getAttribute('aria-selected')).toBe('true');
  const panel = await pagesTab(user),
    row = pageRow(panel, 'Settings');
  expect(row.getByText('/settings').className).toBe('sd-file sd-file--path');
  expect(
    within(row.getByRole('list', { name: 'Steps on Settings' }))
      .getAllByRole('listitem')
      .map(step => step.textContent),
  ).toEqual(['Click “Visual check”', 'Type “Edge” into “Browser”', 'Wait for “Saved”']);
  expect(panel.getByText(/^Planned with the story\./)).toBeTruthy();
  expect(panel.queryByText(/^Changed by you/)).toBeNull();
  // It says who describes the images.
  expect(panel.getByText(/Morgan describes every image before the story can pass review\./)).toBeTruthy();
  expect(row.getByRole('button', { name: 'Edit Settings' })).toBeTruthy();
  expect(panel.getByRole('button', { name: 'Add a page' })).toBeTruthy();
});

test('on a phone Pages follows Checks, before Try it and Details', async () => {
  width(true);
  pages([board]);
  open();
  expect(await tabsWithPages()).toEqual(['Activity', 'Changes', 'Checks', 'Pages', 'Try it', 'Details']);
});

test('a story with no pages, no capture record and the check off keeps the tabs it has, with no Pages tab', async () => {
  open();
  expect(await tabNames()).toEqual(['Changes', 'Checks', 'Try it', 'Activity']);
  // It read its pages and the project's check to decide.
  await waitFor(() => expect(pageReads()).toBe(1));
  await waitFor(() => expect(controller.reads()).toContain('/api/projects/project-x/visual-check'));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await tabNames()).toEqual(['Changes', 'Checks', 'Try it', 'Activity']);
  cleanup();
  // Work that is not a code story reads neither view, and keeps its tabs.
  controller.requests = [];
  controller.tasks = [taskFixture('T-1', { title: 'Write the notes', status: 'ready' })];
  controller.attempts = [];
  pages([board]);
  checkOn();
  open();
  expect(await tabNames()).toEqual(['Overview', 'Activity']);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(controller.reads().filter(url => url.includes('/pages') || url.includes('/visual-check'))).toEqual([]);
});

test('with the check on and no pages the tab shows, says nothing is captured, and offers Add a page', async () => {
  const user = userEvent.setup();
  checkOn();
  open();
  expect(await tabsWithPages()).toEqual(['Changes', 'Checks', 'Pages', 'Try it', 'Activity']);
  const panel = await pagesTab(user);
  expect(panel.getByText('This story names no pages, so its next candidate is not captured.')).toBeTruthy();
  expect(panel.getByRole('button', { name: 'Add a page' })).toBeTruthy();
  // The check is on, so no line says it is off.
  expect(panel.queryByRole('link', { name: 'Settings → Visual check' })).toBeNull();
});

test('Add a page posts the whole list with the new page and its Type into a field step, and the list reads again', async () => {
  const user = userEvent.setup();
  pages([board]);
  controller.command = savePages;
  open();
  const panel = await pagesTab(user);
  await user.click(panel.getByRole('button', { name: 'Add a page' }));
  const dialog = await dialogOf('Add a page');
  await user.type(field(dialog, 'Name'), 'Settings');
  await user.type(field(dialog, 'Path'), '/settings');
  await user.click(dialog.getByRole('button', { name: 'Add a step' }));
  await user.selectOptions(dialog.getByRole('combobox', { name: 'Step 1' }), 'Type into a field');
  await user.type(field(dialog, 'Step 1: the text to type'), 'Edge');
  await user.type(field(dialog, "Step 1: the field's label"), 'Browser');
  const reads = pageReads();
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Saved. The next check captures these pages.')).toBeTruthy();
  expect(posts()).toEqual([
    {
      url: '/api/tasks/T-1/pages',
      method: 'POST',
      body: {
        projectId: 'project-x',
        pages: [board, { name: 'Settings', path: '/settings', steps: [{ type: 'Edge', into: 'Browser' }] }],
      },
    },
  ]);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a page' })).toBeNull());
  // The list read again shows the new page, now the director's own.
  expect(pageReads()).toBeGreaterThan(reads);
  expect(await within(screen.getByRole('tabpanel')).findByText('Type “Edge” into “Browser”')).toBeTruthy();
  expect(within(screen.getByRole('tabpanel')).getByText(/^Changed by you\./)).toBeTruthy();
});

test("Edit changes a page's path and removes one of its steps in one post", async () => {
  const user = userEvent.setup();
  pages([board, settings]);
  controller.command = savePages;
  open();
  const panel = await pagesTab(user);
  await user.click(pageRow(panel, 'Settings').getByRole('button', { name: 'Edit Settings' }));
  const dialog = await dialogOf('Edit Settings');
  // The form starts from the page as the list holds it.
  expect(field(dialog, 'Name').value).toBe('Settings');
  expect(field(dialog, 'Path').value).toBe('/settings');
  expect(dialog.getAllByRole('combobox').map(step => (step as HTMLSelectElement).value)).toEqual([
    'click',
    'type',
    'wait',
  ]);
  expect(field(dialog, 'Step 1: the text to click').value).toBe('Visual check');
  expect(field(dialog, "Step 2: the field's label").value).toBe('Browser');
  await user.clear(field(dialog, 'Path'));
  await user.type(field(dialog, 'Path'), '/settings/visual');
  await user.click(dialog.getByRole('button', { name: 'Remove step 1' }));
  // The steps after it move up.
  expect(field(dialog, 'Step 1: the text to type').value).toBe('Edge');
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Saved. The next check captures these pages.')).toBeTruthy();
  expect(posts()).toEqual([
    {
      url: '/api/tasks/T-1/pages',
      method: 'POST',
      body: {
        projectId: 'project-x',
        pages: [
          board,
          { name: 'Settings', path: '/settings/visual', steps: [{ type: 'Edge', into: 'Browser' }, { wait: 'Saved' }] },
        ],
      },
    },
  ]);
  expect(await within(screen.getByRole('tabpanel')).findByText('/settings/visual')).toBeTruthy();
});

test('Remove this page in Edit posts the list without it', async () => {
  const user = userEvent.setup();
  pages([board, settings]);
  controller.command = savePages;
  open();
  const panel = await pagesTab(user);
  await user.click(pageRow(panel, 'Board').getByRole('button', { name: 'Edit Board' }));
  const dialog = await dialogOf('Edit Board');
  await user.click(dialog.getByRole('button', { name: 'Remove this page' }));
  expect(await screen.findByText('Saved. The next check captures these pages.')).toBeTruthy();
  expect(posts().map(request => request.body)).toEqual([{ projectId: 'project-x', pages: [settings] }]);
  await waitFor(() => expect(within(screen.getByRole('tabpanel')).queryByText('Board', { selector: 'b' })).toBeNull());
  // Add a page has no Remove this page.
  await user.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Add a page' }));
  expect((await dialogOf('Add a page')).queryByRole('button', { name: 'Remove this page' })).toBeNull();
});

test("a refusal keeps the dialog open with the controller's message and what was typed", async () => {
  const user = userEvent.setup(),
    message = "The pages: page 2 needs a path on the app's own address, starting with / (such as /settings).";
  pages([board]);
  controller.command = () => {
    throw new Error(message);
  };
  open();
  const panel = await pagesTab(user);
  await user.click(panel.getByRole('button', { name: 'Add a page' }));
  const dialog = await dialogOf('Add a page');
  await user.type(field(dialog, 'Name'), 'Settings');
  await user.type(field(dialog, 'Path'), 'settings');
  await user.click(dialog.getByRole('button', { name: 'Add a step' }));
  await user.type(field(dialog, 'Step 1: the text to click'), 'Visual check');
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  expect((await dialog.findByRole('alert')).textContent).toBe(message);
  expect(screen.getByRole('dialog', { name: 'Add a page' })).toBeTruthy();
  expect(field(dialog, 'Name').value).toBe('Settings');
  expect(field(dialog, 'Path').value).toBe('settings');
  expect(field(dialog, 'Step 1: the text to click').value).toBe('Visual check');
  expect(screen.queryByText('Saved. The next check captures these pages.')).toBeNull();
  expect(posts()).toHaveLength(1);
});

test('pages that can no longer change show the reason, with no Add a page or Edit', async () => {
  const user = userEvent.setup(),
    reason = 'This story is closed or integrated; its pages can no longer change.';
  pages([board, settings], { editable: false, reason, changed: true });
  open();
  const panel = await pagesTab(user);
  expect(panel.getByText(reason)).toBeTruthy();
  expect(panel.getByText(/^Changed by you\./)).toBeTruthy();
  expect(panel.queryByRole('button', { name: 'Add a page' })).toBeNull();
  expect(panel.queryByRole('button', { name: /^Edit/ })).toBeNull();
});

test('a story at ten pages has no Add a page, though each page may still be edited', async () => {
  const user = userEvent.setup();
  pages(Array.from({ length: 10 }, (_, index) => ({ name: `Page ${index + 1}`, path: `/${index + 1}`, steps: [] })));
  open();
  const panel = await pagesTab(user);
  expect(panel.getAllByRole('button', { name: /^Edit Page \d+$/ })).toHaveLength(10);
  expect(panel.queryByRole('button', { name: 'Add a page' })).toBeNull();
});

test('with the check off the tab says so and links to Settings → Visual check', async () => {
  const user = userEvent.setup();
  pages([board]);
  open();
  const panel = await pagesTab(user),
    link = await panel.findByRole('link', { name: 'Settings → Visual check' });
  expect(link.getAttribute('href')).toBe('/p/project-x/settings#visual-check');
  expect(link.closest('p')?.textContent).toBe(
    "The project's visual check is off, so nothing is captured until it is on in Settings → Visual check.",
  );
  expect(pageRow(panel, 'Board').getByText('No steps: captured as it opens.')).toBeTruthy();
});

// The candidate's check: its record and each image among its artifacts, as the controller lists them, and the review,
// finished, describing images by their copies among its inputs.
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const shot = (
  number: number,
  page: StoryPage,
  width: number,
  theme: VisualTheme,
  fields: Partial<VisualImage> = {},
): VisualImage => ({
  path: `visual/${String(number).padStart(2, '0')}-${page.name.toLowerCase()}-${width}-${theme}.png`,
  page: page.name,
  pagePath: page.path,
  width,
  theme,
  height: 900,
  ...fields,
});
const shots: VisualImage[] = [
  shot(1, board, 1440, 'light'),
  shot(2, board, 390, 'dark'),
  shot(3, settings, 1440, 'dark', { problem: 'nothing to click shows "Visual check"' }),
  shot(4, settings, 390, 'light', { trimmed: true }),
];
function recorded(fields: Partial<VisualCheckRecord> = {}) {
  const record: VisualCheckRecord = {
    schemaVersion: 'visual-check-v1',
    state: 'captured',
    browser: edge,
    widths: [1440, 390],
    themes: ['light', 'dark'],
    pages: [board, settings],
    address: 'http://localhost:5173/',
    images: shots,
    ...fields,
  };
  controller.artifacts['attempt-build/visual-check.json'] = JSON.stringify(record);
  for (const image of record.images) controller.artifacts[`attempt-build/${image.path}`] = 'png';
  controller.attempts[0]!.artifacts = [
    { path: 'visual-check.json', hash: 'record-hash', kind: 'visual-check' },
    ...record.images.map(image => ({ path: image.path, hash: `${image.path}-hash`, kind: 'visual-capture' })),
  ];
}
function reviewed(visual: VisualNote[]) {
  controller.attempts[1] = {
    ...controller.attempts[1]!,
    status: 'accepted',
    finishedAt: '2026-10-29T08:40:00.000Z',
    artifacts: [{ path: 'source-change-review.json', hash: 'review-hash', kind: 'source-change-review' }],
  };
  controller.artifacts['attempt-review/source-change-review.json'] = JSON.stringify({ verdict: 'pass', visual });
}
const tiles = () => [...document.querySelectorAll<HTMLElement>('.sd-tiles .sd-tile')];
const eyebrow = (tile: HTMLElement | undefined) => tile?.querySelector('.sd-eyebrow')?.textContent;
// The pages tile once it reads its value and the line under it, if any.
const pagesTile = async (value: string, line: string | null) => {
  const tile = () => tiles().find(item => eyebrow(item) === 'The pagesPages');
  await waitFor(
    () =>
      expect([
        tile()?.querySelector('.sd-tile__value')?.textContent,
        tile()?.querySelector('.sd-meta')?.textContent ?? null,
      ]).toEqual([value, line]),
    { timeout: 5000 },
  );
  return tile()!;
};
// Opens the Pages tab and gives what the check captured, under the story's pages.
const capturedIn = async (user: ReturnType<typeof userEvent.setup>) =>
  within((await pagesTab(user)).getByRole('region', { name: 'What the check captured' }));
const recordRead = '/api/attempts/attempt-build/artifact?projectId=project-x&path=visual-check.json';
const imageRead = (image: VisualImage) =>
  `/api/attempts/attempt-build/artifact?projectId=project-x&path=${encodeURIComponent(image.path)}`;
const figureNames = (region: HTMLElement) =>
  within(region)
    .getAllByRole('figure')
    .map(figure => figure.getAttribute('aria-label'));

test("the tab shows the candidate's images by page, each with its width, theme, the review's note and its mark", async () => {
  const user = userEvent.setup();
  checkOn();
  pages([board, settings]);
  recorded();
  reviewed([
    { image: '../inputs/T-1/5-01-board-1440-light.png', note: 'The board shows three columns.', verdict: 'match' },
    { image: '../inputs/T-1/6-02-board-390-dark.png', note: 'The columns stack on a phone.', verdict: 'match' },
    {
      image: '../inputs/T-1/7-03-settings-1440-dark.png',
      note: 'The Visual check section is missing.',
      verdict: 'problem',
    },
  ]);
  open();
  const captured = await capturedIn(user),
    boardRegion = await captured.findByRole('region', { name: 'Board' }),
    settingsRegion = captured.getByRole('region', { name: 'Settings' });
  expect(captured.getByText('4 images with Microsoft Edge.')).toBeTruthy();
  // Each page under its name and path, in the record's order, its images by width and then theme.
  expect(captured.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
    'Board/',
    'Settings/settings',
  ]);
  expect(figureNames(boardRegion)).toEqual(['Desktop · 1440 px · Light', 'Phone · 390 px · Dark']);
  expect(figureNames(settingsRegion)).toEqual(['Desktop · 1440 px · Dark', 'Phone · 390 px · Light']);
  const figure = (region: HTMLElement, name: string) => within(within(region).getByRole('figure', { name }));
  // The review's note, matched by the image's own name among its inputs, with its mark.
  const wide = figure(boardRegion, 'Desktop · 1440 px · Light');
  expect(await wide.findByText('The board shows three columns.')).toBeTruthy();
  expect(wide.getByText('Match')).toBeTruthy();
  expect(figure(boardRegion, 'Phone · 390 px · Dark').getByText('The columns stack on a phone.')).toBeTruthy();
  const broken = figure(settingsRegion, 'Desktop · 1440 px · Dark');
  expect(broken.getByText('The Visual check section is missing.')).toBeTruthy();
  expect(broken.getByText('Problem')).toBeTruthy();
  expect(broken.queryByText('Match')).toBeNull();
  // The image's own problem as it was taken.
  expect(broken.getByText('Taken with a problem: nothing to click shows "Visual check".')).toBeTruthy();
  // An image the review did not describe says so and has no mark; a trimmed one says it was trimmed.
  const phone = figure(settingsRegion, 'Phone · 390 px · Light');
  expect(phone.getByText('The review has not described this image yet.')).toBeTruthy();
  expect(phone.queryByText('Match')).toBeNull();
  expect(phone.queryByText('Problem')).toBeNull();
  expect(phone.getByText(/^Trimmed: /)).toBeTruthy();
  expect(wide.queryByText(/^Trimmed: /)).toBeNull();
  expect(wide.queryByText(/^Taken with a problem/)).toBeNull();
  // Each image is read from the candidate through the recorded-file route, once its record is, and opens over the
  // page.
  await waitFor(() => expect(controller.reads()).toEqual(expect.arrayContaining(shots.map(imageRead))));
  expect(controller.reads().filter(url => url === recordRead)).toHaveLength(1);
  await user.click(within(boardRegion).getByRole('button', { name: 'View Board, Desktop · 1440 px · Light' }));
  expect(await screen.findByRole('dialog', { name: 'visual/01-board-1440-light.png' })).toBeTruthy();
});

test("a page's images sit in one row per width, desktop then phone, light then dark, each a thumbnail with its own note", async () => {
  const user = userEvent.setup();
  checkOn();
  pages([board]);
  const four = [
    shot(1, board, 390, 'light', { trimmed: true }),
    shot(2, board, 390, 'dark'),
    shot(3, board, 1440, 'light'),
    shot(4, board, 1440, 'dark', { problem: 'nothing to click shows "Menu"' }),
  ];
  // The record lists the phone width first; the desktop row still comes first.
  recorded({ pages: [board], widths: [390, 1440], images: four });
  // The phone's dark image was not saved among the candidate's files.
  controller.attempts[0]!.artifacts = controller.attempts[0]!.artifacts!.filter(file => file.path !== four[1]!.path);
  reviewed([
    { image: '../inputs/T-1/5-03-board-1440-light.png', note: 'The board shows three columns.', verdict: 'match' },
    { image: '../inputs/T-1/6-04-board-1440-dark.png', note: 'The menu is missing.', verdict: 'problem' },
    { image: '../inputs/T-1/7-01-board-390-light.png', note: 'The columns stack on a phone.', verdict: 'match' },
  ]);
  open();
  const captured = await capturedIn(user),
    region = await captured.findByRole('region', { name: 'Board' }),
    rows = within(region).getAllByRole('list');
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Desktop · 1440 px', 'Phone · 390 px']);
  const desktop = within(region).getByRole('list', { name: 'Desktop · 1440 px' }),
    phone = within(region).getByRole('list', { name: 'Phone · 390 px' });
  expect(figureNames(desktop)).toEqual(['Desktop · 1440 px · Light', 'Desktop · 1440 px · Dark']);
  expect(figureNames(phone)).toEqual(['Phone · 390 px · Light', 'Phone · 390 px · Dark']);
  // Every picture's frame is a thumbnail, the one with no image saved too.
  const frames = [...region.querySelectorAll('.sd-picture__frame')];
  expect(frames).toHaveLength(4);
  expect(frames.every(frame => frame.classList.contains('sd-picture__frame--thumb'))).toBe(true);
  // Each picture keeps its own caption: the review's note and mark, and what went wrong as it was taken.
  const figure = (row: HTMLElement, name: string) => within(within(row).getByRole('figure', { name }));
  const wideLight = figure(desktop, 'Desktop · 1440 px · Light'),
    wideDark = figure(desktop, 'Desktop · 1440 px · Dark'),
    phoneLight = figure(phone, 'Phone · 390 px · Light'),
    phoneDark = figure(phone, 'Phone · 390 px · Dark');
  expect(await wideLight.findByText('The board shows three columns.')).toBeTruthy();
  expect(wideLight.getByText('Match')).toBeTruthy();
  expect(wideLight.queryByText(/^Taken with a problem/)).toBeNull();
  expect(wideDark.getByText('The menu is missing.')).toBeTruthy();
  expect(wideDark.getByText('Problem')).toBeTruthy();
  expect(wideDark.getByText('Taken with a problem: nothing to click shows "Menu".')).toBeTruthy();
  expect(phoneLight.getByText('The columns stack on a phone.')).toBeTruthy();
  expect(phoneLight.getByText(/^Trimmed: /)).toBeTruthy();
  expect(wideLight.queryByText(/^Trimmed: /)).toBeNull();
  expect(phoneDark.getByText('The review has not described this image yet.')).toBeTruthy();
  expect(phoneDark.getByText('No image was saved.')).toBeTruthy();
  expect(phoneDark.queryByRole('button')).toBeNull();
  // A thumbnail still opens its picture over the page.
  await user.click(phoneLight.getByRole('button', { name: 'View Board, Phone · 390 px · Light' }));
  expect(await screen.findByRole('dialog', { name: 'visual/01-board-390-light.png' })).toBeTruthy();
});

test('The pages tile reads the images taken with the browser, beside Tried by you, and opens the Pages tab', async () => {
  const user = userEvent.setup();
  checkOn();
  pages([board, settings]);
  recorded();
  open();
  const tile = await pagesTile('4 images', 'with Microsoft Edge');
  expect(eyebrow(tiles()[3])).toBe('Tried by youTried');
  expect(tiles()[4]).toBe(tile);
  expect(screen.getByRole('tab', { name: /^Changes/ }).getAttribute('aria-selected')).toBe('true');
  await user.click(tile);
  expect(screen.getByRole('tab', { name: 'Pages' }).getAttribute('aria-selected')).toBe('true');
  expect(await within(screen.getByRole('tabpanel')).findByRole('region', { name: 'Board' })).toBeTruthy();
});

test('with no browser found the tile reads Not run and the tab says why, with a link to Settings → Visual check', async () => {
  const user = userEvent.setup();
  checkOn();
  controller.visualView.browser = null;
  pages([board, settings]);
  recorded({
    state: 'not-run',
    reason: 'no browser found',
    note: 'Installing Microsoft Edge or Google Chrome lets the reviewer see the pages; nothing is downloaded for you.',
    browser: null,
    images: [],
  });
  reviewed([]);
  open();
  await pagesTile('Not run', 'No browser found');
  const captured = await capturedIn(user),
    link = await captured.findByRole('link', { name: 'Settings → Visual check' });
  expect(link.getAttribute('href')).toBe('/p/project-x/settings#visual-check');
  expect(link.closest('p')?.textContent).toBe(
    'The check did not run because no Chromium-based browser was found on this computer. Morgan reviewed it without ' +
      'images. Installing Microsoft Edge or Google Chrome lets Morgan see the pages; Settings → Visual check shows the ' +
      'browser it finds.',
  );
  expect(captured.queryAllByRole('figure')).toEqual([]);
  expect(captured.queryByRole('region')).toBeNull();
});

test('a failed check, or one that did not run for another reason, gives its reason on the tile and the tab', async () => {
  const user = userEvent.setup(),
    failure = 'The browser refused its DevTools connection.';
  checkOn();
  pages([board, settings]);
  recorded({ state: 'failed', reason: failure, images: [] });
  open();
  await pagesTile('Failed', failure);
  let captured = await capturedIn(user);
  // The review has not finished, so it reviews without images.
  expect(await captured.findByText(`The check failed: ${failure} Morgan reviews it without images.`)).toBeTruthy();
  expect(captured.queryByRole('link')).toBeNull();
  expect(captured.queryByRole('region')).toBeNull();
  cleanup();
  const blocked = "The built-in sandbox here keeps an app's port inside it, so the check cannot reach the candidate.";
  recorded({ state: 'not-run', reason: blocked, images: [] });
  open();
  await pagesTile('Not run', blocked);
  captured = await capturedIn(user);
  expect(await captured.findByText(`The check did not run: ${blocked} Morgan reviews it without images.`)).toBeTruthy();
  cleanup();
  // A check that failed part way shows the images it took, which the review received.
  recorded({ state: 'failed', reason: failure, images: [shots[0]!] });
  open();
  captured = await capturedIn(user);
  expect(await captured.findByText(`The check failed: ${failure}`)).toBeTruthy();
  expect(figureNames(captured.getByRole('region', { name: 'Board' }))).toEqual(['Desktop · 1440 px · Light']);
  expect(
    within(captured.getByRole('region', { name: 'Settings' })).getByText('No image of this page was taken.'),
  ).toBeTruthy();
});

test('a story whose candidate recorded no check reads Not yet and says when its pages are captured', async () => {
  const user = userEvent.setup();
  checkOn();
  pages([board]);
  open();
  await pagesTile('Not yet', null);
  const captured = await capturedIn(user);
  expect(
    captured.getByText("The pages are captured after the candidate's tests pass, when the project's check is on."),
  ).toBeTruthy();
  // Its attempt lists no record, so none is read.
  expect(controller.reads()).not.toContain(recordRead);
});

test('a story without the Pages tab has no The pages tile', async () => {
  open();
  expect(await tabNames()).toEqual(['Changes', 'Checks', 'Try it', 'Activity']);
  await waitFor(() => expect(pageReads()).toBe(1));
  await waitFor(() => expect(controller.reads()).toContain('/api/projects/project-x/visual-check'));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(tiles()).toHaveLength(4);
  expect(tiles().map(eyebrow)).not.toContain('The pagesPages');
  expect(screen.queryByText('The pages')).toBeNull();
});
