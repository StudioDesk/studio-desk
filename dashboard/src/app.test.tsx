// The dashboard's addresses and frame (MP-026, and the redesign's frame, v1.0 item 23): path URLs, and a project's
// pages inside one frame with the project rail, Find a project, the pages and the Needs you count.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

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
    ['Agents', '/p/project-x/agents'],
    ['Project settings', '/p/project-x/settings'],
  ]);
  expect(links[0]!.getAttribute('aria-current')).toBe('page');
  expect(links.slice(1).every(link => link.getAttribute('aria-current') === null)).toBe(true);
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
  expect(screen.getByText('Connecting to your studio…')).toBeTruthy();
  latest().emit('open');
  expect(screen.getByText('Controller connected')).toBeTruthy();
  latest().emit('error');
  expect(screen.getByText('Controller unavailable · reconnecting')).toBeTruthy();
  expect(localStorage.getItem('studio-next-project')).toBe('project-x');
});

test('a story belongs to its idea, and the teams pages to the agents', async () => {
  open('/p/project-x/agents/teams');
  const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
  expect(nav.getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBe('page');
  expect(nav.getByRole('link', { name: 'Project settings' }).getAttribute('aria-current')).toBeNull();
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
  for (const [from, to] of [
    ['/p/project-x/settings/employees', '/p/project-x/agents'],
    ['/p/project-x/settings/employees/W-1', '/p/project-x/agents/W-1'],
    ['/p/project-x/settings/teams/engineering', '/p/project-x/agents/teams/engineering'],
    ['/p/project-x/settings/instructions?open=employee:W-1', '/p/project-x/agents/instructions?open=agent%3AW-1'],
  ] as const) {
    const router = open(from);
    await waitFor(() => expect(router.history.location.href).toBe(to));
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
