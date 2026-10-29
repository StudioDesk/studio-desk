// A code story names the pages its next visual check captures (1.2 step 8) on its Pages tab, read from its pages view
// and the project's visual check view as the stand-in controller serves them: each page's name, path and steps in
// words, whether they were planned with the story or changed by the director, and while they may still change, Add a
// page and Edit, which send the whole list to the controller. A story with no pages, no capture and the check off
// keeps its tabs. Model-free.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StoryPage, StoryPagesView } from './api';
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
