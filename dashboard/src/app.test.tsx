// The dashboard's addresses and frame (MP-026, and the redesign's frame, v1.0 item 23): path URLs, and a project's
// pages inside one frame with the project rail, Find a project, the pages and the Needs you count.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { setChatBox } from './chat-box';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

// The pages these tests open that load on demand (router.tsx), and Create a project, which the frame loads when it
// opens. Their code is loaded before the tests, so the router's load resolves at once and a test's one-second wait
// measures only the page's rendering. Each test that opens one also waits for something the page itself shows, so no
// page's code is still loading when the test ends: Vitest fails the run when a load outlives the file's simulated page.
beforeAll(async () => {
  await Promise.all([
    import('./settings-page'),
    import('./previews-page'),
    import('./platform-page'),
    import('./activity-log-page'),
    import('./agents-page'),
    import('./teams-page'),
    import('./instructions-page'),
    import('./runs-page'),
    import('./new-project'),
  ]);
});

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  localStorage.clear();
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

test('the new dashboard opens the project shown last, or the first one', async () => {
  const first = open('/');
  await waitFor(() => expect(first.history.location.pathname).toBe('/p/project-x'));
  cleanup();
  localStorage.setItem('studio-next-project', 'project-y');
  const second = open('/');
  await waitFor(() => expect(second.history.location.pathname).toBe('/p/project-y'));
});

test('an address from before path URLs, /?projectId=, opens that project', async () => {
  const router = open('/?projectId=project-y');
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-y'));
});

test("a project's pages share one frame: the project rail, its pages and the controller's connection", async () => {
  open('/p/project-x');
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  const links = within(nav).getAllByRole('link');
  expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Today', '/p/project-x'],
    ['Ideas', '/p/project-x/runs'],
    ['Board', '/p/project-x/board'],
    ['Artifacts', '/p/project-x/artifacts'],
    ['Releases', '/p/project-x/releases'],
    ['Agents', '/p/project-x/agents'],
    ['Project settings', '/p/project-x/settings'],
  ]);
  expect(links[0]!.getAttribute('aria-current')).toBe('page');
  expect(links.slice(1).every(link => link.getAttribute('aria-current') === null)).toBe(true);
  // A phone keeps four tabs; Artifacts, Releases and Settings stay in the sidebar's menu.
  expect(
    within(screen.getByRole('navigation', { name: 'Pages' }))
      .getAllByRole('link')
      .map(link => link.textContent),
  ).toEqual(['Today', 'Ideas', 'Board', 'Agents']);
  const rail = within(screen.getByRole('navigation', { name: 'Projects' }));
  await waitFor(() =>
    expect(rail.getAllByRole('link').map(link => [link.getAttribute('aria-label'), link.textContent])).toEqual([
      ['Project X', 'PX'],
      ['Project Y', 'PY'],
      ['Settings for every project', ''],
    ]),
  );
  expect(rail.getByRole('link', { name: 'Project X' }).getAttribute('aria-current')).toBe('true');
  expect(rail.getByRole('link', { name: 'Project Y' }).getAttribute('aria-current')).toBeNull();
  // With no calls anywhere, no tile has a badge and the tab's title has no count.
  expect(document.querySelector('.sd-rail__badge')).toBeNull();
  expect(document.title).toBe('Studio desk');
  expect(screen.getByText('Connecting to your studio…')).toBeTruthy();
  latest().emit('open');
  expect(screen.getByText('Controller connected')).toBeTruthy();
  latest().emit('error');
  expect(screen.getByText('Controller unavailable · reconnecting')).toBeTruthy();
  expect(localStorage.getItem('studio-next-project')).toBe('project-x');
});

test("a general-work project's pages leave out Releases, which only a code project has", async () => {
  controller.shell.organizationConfiguration = { taskKinds: ['general:plan'] };
  open('/p/project-x/board');
  // The project's kind shows once its records have loaded, and the pages follow its shell.
  expect(await screen.findByText('General work')).toBeTruthy();
  const nav = within(screen.getByRole('navigation', { name: 'Main' }));
  expect(nav.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Today', '/p/project-x'],
    ['Ideas', '/p/project-x/runs'],
    ['Board', '/p/project-x/board'],
    ['Artifacts', '/p/project-x/artifacts'],
    ['Agents', '/p/project-x/agents'],
    ['Project settings', '/p/project-x/settings'],
  ]);
  cleanup();
  // A project whose intake takes source changes is a code project too, with its label and Releases.
  controller.shell.organizationConfiguration = { taskKinds: ['studio-development:change'] };
  open('/p/project-x/board');
  expect(await screen.findByText('Code · git repository')).toBeTruthy();
  expect(
    within(screen.getByRole('navigation', { name: 'Main' }))
      .getByRole('link', { name: 'Releases' })
      .getAttribute('href'),
  ).toBe('/p/project-x/releases');
});

test('a story belongs to its idea, and the teams pages to the agents', async () => {
  open('/p/project-x/agents/teams');
  const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
  expect(nav.getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBe('page');
  expect(nav.getByRole('link', { name: 'Project settings' }).getAttribute('aria-current')).toBeNull();
  await screen.findByRole('heading', { level: 1, name: 'Teams' });
});

test('Previews opens directly under Settings and keeps the project settings frame selected', async () => {
  // Its link and trail use the project in the address, including a project other than the first.
  const router = open('/p/project-y/settings/previews');
  await screen.findByRole('heading', { level: 1, name: 'Previews' });
  expect(router.history.location.pathname).toBe('/p/project-y/settings/previews');
  const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
  expect(nav.getByRole('link', { name: 'Project settings' }).getAttribute('aria-current')).toBe('page');
  expect(nav.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBeNull();
  const trail = within(screen.getByRole('navigation', { name: 'You are here' }));
  const settings = trail.getByRole('link', { name: 'Settings' });
  expect(settings.getAttribute('href')).toBe('/p/project-y/settings');
  expect(settings.getAttribute('aria-current')).toBeNull();
  expect(trail.getByText('Previews').getAttribute('aria-current')).toBe('page');
});

test('Settings opens Previews, its trail returns, and Back and Forward keep both pages in the settings frame', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/settings');
  const shown = async (title: string, path: string) => {
    await screen.findByRole('heading', { level: 1, name: title });
    expect(router.history.location.pathname).toBe(path);
    expect(
      within(screen.getByRole('navigation', { name: 'Main' }))
        .getByRole('link', { name: 'Project settings' })
        .getAttribute('aria-current'),
    ).toBe('page');
  };
  await user.click(await screen.findByRole('link', { name: 'Previews' }));
  await shown('Previews', '/p/project-x/settings/previews');
  await user.click(
    within(screen.getByRole('navigation', { name: 'You are here' })).getByRole('link', { name: 'Settings' }),
  );
  await shown('Settings', '/p/project-x/settings');
  act(() => router.history.back());
  await shown('Previews', '/p/project-x/settings/previews');
  act(() => router.history.back());
  await shown('Settings', '/p/project-x/settings');
  act(() => router.history.forward());
  await shown('Previews', '/p/project-x/settings/previews');
  act(() => router.history.forward());
  await shown('Settings', '/p/project-x/settings');
});

test('Add a project opens Create a project over the page, from the rail or Find a project', async () => {
  open('/p/project-x/board');
  const rail = within(await screen.findByRole('navigation', { name: 'Projects' }));
  fireEvent.click(rail.getByRole('button', { name: 'Add a project' }));
  const dialog = await screen.findByRole('dialog', { name: 'Create a project' });
  expect(within(dialog).getByLabelText('Folder')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a project' })).toBeNull());
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const list = within(await screen.findByRole('listbox', { name: 'Projects' }));
  fireEvent.click(list.getByRole('option', { name: /Add a project/ }));
  expect(await screen.findByRole('dialog', { name: 'Create a project' })).toBeTruthy();
});

test("the agents' addresses from under Settings lead to the same pages under Agents", async () => {
  // Each with the heading of the page it leads to, which shows once that page's code has loaded.
  for (const [from, to, page] of [
    ['/p/project-x/settings/employees', '/p/project-x/agents', 'Agents'],
    ['/p/project-x/settings/employees/W-1', '/p/project-x/agents/W-1', 'Agents'],
    ['/p/project-x/settings/teams/engineering', '/p/project-x/agents/teams/engineering', 'Team'],
    [
      '/p/project-x/settings/instructions?open=employee:W-1',
      '/p/project-x/agents/instructions?open=agent%3AW-1',
      'Instructions',
    ],
  ] as const) {
    const router = open(from);
    await waitFor(() => expect(router.history.location.href).toBe(to));
    await screen.findByRole('heading', { level: 1, name: page });
    cleanup();
  }
  // Settings' own pages stay where they are.
  const router = open('/p/project-x/settings/platform');
  await screen.findByRole('heading', { level: 1 });
  expect(router.history.location.pathname).toBe('/p/project-x/settings/platform');
});

test('the Needs you count follows the live set, and a tile on the rail opens its project', async () => {
  controller.tasks = [taskFixture('T-1', { title: 'Waiting to start' })];
  const router = open('/p/project-x/runs');
  expect(await screen.findAllByLabelText('1 call for you')).toHaveLength(2);
  // The count is the frame's; the ideas' page itself shows too.
  await screen.findByRole('heading', { level: 1, name: 'Ideas' });
  // The open project's tile counts the same call; Project Y, whose records the stand-in does not know, shows none.
  const rail = within(screen.getByRole('navigation', { name: 'Projects' })),
    tile = await rail.findByRole('link', { name: 'Project X: 1 call for you' });
  expect(tile.getAttribute('title')).toBe('Project X: 1 call for you');
  expect(tile.querySelector('.sd-rail__badge')?.textContent).toBe('1');
  expect(rail.getByRole('link', { name: 'Project Y' }).querySelector('.sd-rail__badge')).toBeNull();
  expect(document.title).toBe('(1) Studio desk');
  fireEvent.click(await screen.findByRole('link', { name: 'Project Y' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-y'));
});

test('Find a project opens with Ctrl K, filters by name and opens the project chosen with Enter', async () => {
  const router = open('/p/project-x/board');
  await screen.findByRole('link', { name: 'Project Y' });
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const search = await screen.findByRole('combobox', { name: 'Find a project' });
  const list = within(screen.getByRole('listbox', { name: 'Projects' }));
  expect(list.getAllByRole('option').map(option => option.textContent)).toEqual([
    'Project XYou are here',
    'Project Y',
    'Add a project',
    'Project settings',
  ]);
  fireEvent.change(search, { target: { value: 'y' } });
  expect(list.getAllByRole('option')[0]!.textContent).toBe('Project Y');
  expect(list.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(search, { key: 'Enter' });
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-y'));
});

test('New idea opens Today from any page', async () => {
  const router = open('/p/project-x/board');
  // The sidebar's button, and the middle tab on a phone.
  const buttons = await screen.findAllByRole('button', { name: 'New idea' });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]!);
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x'));
});

test('with the chat box switched off, modified J is left to the browser and N still opens Today', async () => {
  // Today scrolls its box into view, which the simulated page cannot do.
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  try {
    const router = open('/p/project-x/board');
    await screen.findAllByRole('button', { name: 'New idea' });
    // The key is left to the browser.
    expect(fireEvent.keyDown(window, { key: 'j', ctrlKey: true })).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'The chat box' })).toBeNull();
    expect(fireEvent.keyDown(window, { key: 'j', metaKey: true })).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'The chat box' })).toBeNull();
    expect(router.history.location.pathname).toBe('/p/project-x/board');
    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x'));
    const box = await screen.findByRole('textbox', { name: 'New idea for Project X' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(fireEvent.keyDown(box, { key: 'j', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'j', metaKey: true })).toBe(true);
    expect(scrolled).toHaveBeenCalled();
    expect(screen.queryByRole('complementary', { name: 'The chat box' })).toBeNull();
  } finally {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test('with the chat box switched off, the sidebar lists no talks, even with an idea in planning', async () => {
  // An idea whose plan step waits in review, as the controller's run view sends it.
  const plan = taskFixture('T-plan', {
    title: 'Plan the idea',
    kind: 'studio-development:breakdown',
    status: 'review',
    workflowReference: { runId: 'run-1', key: 'plan' },
  });
  controller.tasks = [plan];
  controller.runs = [
    {
      id: 'run-1',
      createdAt: '2026-10-29T19:00:00Z',
      brief: 'Talk it through first.',
      directorInputs: [],
      workflow: { id: 'workflow-1', name: 'Source checks and review', version: 3 },
      revisions: [{ revision: 1, at: '2026-10-29T19:00:00Z', reason: 'created' }],
      nodes: [{ taskId: 'T-plan', key: 'plan', kind: plan.kind, title: plan.title, workerId: 'W-1', dependencies: [] }],
      archive: { archived: false },
    },
  ];
  open('/p/project-x/runs/run-1');
  // The idea is in the project's live records, among the ideas the sidebar lists on its page.
  const ideas = within(await screen.findByRole('navigation', { name: 'Ideas in this project' }));
  expect(ideas.getByRole('link', { name: 'Talk it through first.' })).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Talking it through' })).toBeNull();
  // That list is the frame's; the idea's own page shows too.
  await screen.findByRole('heading', { level: 1, name: /Talk it through first/ });
  // Switched on, the same records list it (chat-panel.test.tsx follows it into the chat box).
  act(() => setChatBox(true));
  const talks = within(await screen.findByRole('navigation', { name: 'Talking it through' }));
  expect(talks.getAllByRole('link').map(link => link.textContent)).toEqual(['Talk it through first']);
});

test("a page's trail marks only the page itself as current, never a step back", async () => {
  open('/p/project-x/settings/activity');
  const trail = within(await screen.findByRole('navigation', { name: 'You are here' }));
  expect(trail.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
  expect(trail.getByText('Activity log').getAttribute('aria-current')).toBe('page');
});

test('an unknown address says so, inside the frame when it is under a project', async () => {
  open('/nowhere');
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Page not found');
  expect(screen.getByRole('link', { name: 'Back to the dashboard' }).getAttribute('href')).toBe('/');
  cleanup();
  open('/p/project-x/nowhere');
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Page not found');
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
});
