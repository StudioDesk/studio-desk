// Browsing folders for Create a project (1.0 step 4): the browser starts at the folder it is given (or the nearest
// existing one above it), else at the controller's home folder, and opens folders by their drive, the trail, Up one
// level and the list, as the controller lists them (POST /api/folders). Each folder shown takes the keyboard focus,
// and a click while a folder opens is ignored without dimming the buttons. Focus is checked in the test DOM only,
// not in a browser. The stand-in answers for the controller from a few listings laid out here; no real controller
// or filesystem is involved.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FolderListing } from './api';
import { FolderBrowser } from './folder-browser';
import { fakeController, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A folder as the controller lists it on Windows: its trail from the drive's root down, the folder one level up
// (none at a root), the drives, and the folders inside, given by name and whether each is a repository.
const listing = (
  path: string,
  inside: [name: string, repository?: boolean][] = [],
  extra: Partial<FolderListing> = {},
): FolderListing => {
  const [drive, ...names] = path.split('\\').filter(Boolean),
    root = `${drive}\\`,
    join = (folder: string, name: string) => (folder.endsWith('\\') ? folder + name : `${folder}\\${name}`),
    trail = [{ name: root, path: root }];
  for (const name of names) trail.push({ name, path: join(trail.at(-1)!.path, name) });
  const shown = trail.at(-1)!.path;
  return {
    path: shown,
    parent: trail.at(-2)?.path ?? null,
    trail,
    drives: ['C:\\', 'D:\\'],
    folders: inside.map(([name, repository = false]) => ({ name, path: join(shown, name), repository })),
    limited: false,
    ...extra,
  };
};
// The home folder is C:\Users\eli; the stand-in refuses a folder it has no listing for, as the controller does.
const home = 'C:\\Users\\eli';
let folders: Record<string, FolderListing>;
beforeEach(() => {
  folders = Object.fromEntries(
    [
      listing('C:\\', [['code'], ['Users']]),
      listing('C:\\Users', [['eli']]),
      listing(home, [['Documents'], ['site', true]]),
      listing('C:\\Users\\eli\\site', [['src'], ['tests']]),
      listing('C:\\Users\\eli\\Documents'),
      listing('D:\\', [['archive', true]]),
    ].map(item => [item.path, item]),
  );
  controller.command = (url, _method, body) => {
    if (url !== '/api/folders') return {};
    const answer = folders[(body as { path?: string }).path ?? home];
    if (!answer) throw new Error('The folder does not exist.');
    return answer;
  };
});

const commands = () => controller.requests.filter(request => request.method !== 'GET');
const opened = (path?: string) => ({ url: '/api/folders', method: 'POST', body: path === undefined ? {} : { path } });
// The first request for a start folder, which the controller answers with the nearest existing folder.
const started = (path: string) => ({ url: '/api/folders', method: 'POST', body: { path, nearest: true } });

function browse(start?: string) {
  const onChoose = vi.fn(),
    onCancel = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FolderBrowser start={start} onChoose={onChoose} onCancel={onCancel} />
    </QueryClientProvider>,
  );
  return { browser: within(screen.getByRole('region', { name: 'Browse folders' })), onChoose, onCancel };
}
type Browser = ReturnType<typeof browse>['browser'];

// The trail's entries, the folders inside and the buttons of the folder shown, by their text.
const entries = (browser: Browser) =>
  within(browser.getByRole('navigation', { name: 'Folder path' })).getAllByRole('button') as HTMLButtonElement[];
const trail = (browser: Browser) => entries(browser).map(entry => entry.textContent);
const inside = (browser: Browser) =>
  within(browser.getByRole('list', { name: 'Folders inside' }))
    .getAllByRole('button')
    .map(item => item.textContent);
const button = (browser: Browser, name: string) => browser.getByRole('button', { name }) as HTMLButtonElement;
// Waits until the folder named is shown, as the trail's current entry, and nothing else is opening.
const showing = (browser: Browser, name: string) =>
  waitFor(() => {
    expect(entries(browser).find(entry => entry.getAttribute('aria-current') === 'location')?.textContent).toBe(name);
    expect(browser.queryByRole('status')).toBeNull();
  });
// Waits until the keyboard focus is inside the browser, on the element given.
const focusOn = (target: () => Element) =>
  waitFor(() => {
    expect(screen.getByRole('region', { name: 'Browse folders' }).contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(target());
  });

test("the browser opens at the controller's home folder, with the drives first, its trail and the folders inside", async () => {
  const held = Promise.withResolvers<FolderListing>();
  controller.command = () => held.promise;
  const { browser } = browse();
  expect((await browser.findByRole('status')).textContent).toBe('Opening the folder…');
  await waitFor(() => expect(commands()).toEqual([opened()]));
  expect(button(browser, 'Choose folder').disabled).toBe(true);
  expect(browser.queryByRole('navigation', { name: 'Folder path' })).toBeNull();
  held.resolve(folders[home]!);
  await showing(browser, 'eli');
  expect(trail(browser)).toEqual(['C:\\', 'Users', 'eli']);
  expect(inside(browser)).toEqual(['Documents', 'site git repository']);
  // The drives come first, then the trail, Up one level and the folders inside.
  expect(browser.getAllByRole('button').map(item => item.textContent)).toEqual([
    'C:\\',
    'D:\\',
    'C:\\',
    'Users',
    'eli',
    'Up one level',
    'Documents',
    'site git repository',
    'Choose folder',
    'Cancel',
  ]);
  expect(within(browser.getByRole('group', { name: 'Drives' })).getAllByRole('button')).toHaveLength(2);
  expect(button(browser, 'Up one level').disabled).toBe(false);
  expect(button(browser, 'Choose folder').disabled).toBe(false);
  expect(browser.queryByRole('alert')).toBeNull();
  expect(commands()).toEqual([opened()]);
});

test('given a start folder, the browser first asks for it or the nearest existing folder above it', async () => {
  const { browser } = browse('C:\\Users\\eli\\site');
  await showing(browser, 'site');
  expect(trail(browser)).toEqual(['C:\\', 'Users', 'eli', 'site']);
  expect(inside(browser)).toEqual(['src', 'tests']);
  expect(commands()).toEqual([started('C:\\Users\\eli\\site')]);
});

test('a start folder the controller refuses opens the home folder instead, with no message', async () => {
  const listed = controller.command;
  controller.command = (url, method, body) => {
    if ((body as { path?: string }).path === 'site') throw new Error('Choose an absolute folder path.');
    return listed(url, method, body);
  };
  const { browser } = browse('site');
  await showing(browser, 'eli');
  expect(inside(browser)).toEqual(['Documents', 'site git repository']);
  expect(browser.queryByRole('alert')).toBeNull();
  expect(commands()).toEqual([started('site'), opened()]);
});

test('the focus goes into each folder shown: to its first folder inside, or its trail entry when it has none', async () => {
  const user = userEvent.setup();
  const { browser } = browse();
  await showing(browser, 'eli');
  await focusOn(() => button(browser, 'Documents'));
  // A folder in the list.
  await user.click(button(browser, 'site git repository'));
  await showing(browser, 'site');
  await focusOn(() => button(browser, 'src'));
  await user.click(button(browser, 'Up one level'));
  await showing(browser, 'eli');
  await focusOn(() => button(browser, 'Documents'));
  // An empty folder: the trail's entry for it.
  await user.click(button(browser, 'Documents'));
  await showing(browser, 'Documents');
  await focusOn(() => entries(browser).at(-1)!);
  // An earlier trail entry.
  await user.click(entries(browser)[1]!);
  await showing(browser, 'Users');
  await focusOn(() => button(browser, 'eli'));
  await user.click(within(browser.getByRole('group', { name: 'Drives' })).getByRole('button', { name: 'D:\\' }));
  await showing(browser, 'D:\\');
  await focusOn(() => button(browser, 'archive git repository'));
});

test('while a folder opens nothing is dimmed, and another click sends nothing until the folder is shown', async () => {
  const user = userEvent.setup();
  const { browser, onChoose } = browse();
  await showing(browser, 'eli');
  const held = Promise.withResolvers<FolderListing>(),
    listed = controller.command;
  controller.command = (url, method, body) =>
    (body as { path?: string }).path === 'C:\\Users\\eli\\site' ? held.promise : listed(url, method, body);
  await user.click(button(browser, 'site git repository'));
  expect((await browser.findByRole('status')).textContent).toBe('Opening the folder…');
  // The drives, the trail, Up one level, the folders inside and Choose folder stay as they were.
  expect(browser.getAllByRole('button').filter(item => (item as HTMLButtonElement).disabled)).toEqual([]);
  await user.click(button(browser, 'Documents'));
  await user.click(within(browser.getByRole('group', { name: 'Drives' })).getByRole('button', { name: 'D:\\' }));
  await user.click(entries(browser)[1]!);
  await user.click(button(browser, 'Up one level'));
  await user.click(button(browser, 'Choose folder'));
  expect(commands()).toEqual([opened(), opened('C:\\Users\\eli\\site')]);
  expect(onChoose).not.toHaveBeenCalled();
  held.resolve(folders['C:\\Users\\eli\\site']!);
  await showing(browser, 'site');
  expect(inside(browser)).toEqual(['src', 'tests']);
  // Once it is shown, a click opens a folder again.
  await user.click(button(browser, 'eli'));
  await showing(browser, 'eli');
  expect(commands()).toEqual([opened(), opened('C:\\Users\\eli\\site'), opened(home)]);
});

test('a repository carries the git repository mark, and a plain folder does not', async () => {
  const { browser } = browse();
  await showing(browser, 'eli');
  const site = button(browser, 'site git repository'),
    documents = button(browser, 'Documents');
  expect(within(site).getByText('git repository')).toBeTruthy();
  expect(within(documents).queryByText('git repository')).toBeNull();
});

test('a folder in the list opens with its contents, and an empty folder says so', async () => {
  const user = userEvent.setup();
  const { browser } = browse();
  await showing(browser, 'eli');
  await user.click(button(browser, 'site git repository'));
  await showing(browser, 'site');
  expect(trail(browser)).toEqual(['C:\\', 'Users', 'eli', 'site']);
  expect(inside(browser)).toEqual(['src', 'tests']);
  expect(browser.queryByText('There are no folders inside this one.')).toBeNull();
  await user.click(button(browser, 'eli'));
  await showing(browser, 'eli');
  await user.click(button(browser, 'Documents'));
  await showing(browser, 'Documents');
  expect(browser.queryByRole('list', { name: 'Folders inside' })).toBeNull();
  expect(browser.getByText('There are no folders inside this one.')).toBeTruthy();
  expect(commands()).toEqual([
    opened(),
    opened('C:\\Users\\eli\\site'),
    opened(home),
    opened('C:\\Users\\eli\\Documents'),
  ]);
});

test("Up one level opens the reply's parent and is disabled at a root; an earlier trail entry opens its folder", async () => {
  const user = userEvent.setup();
  const { browser } = browse();
  await showing(browser, 'eli');
  await user.click(button(browser, 'Up one level'));
  await showing(browser, 'Users');
  expect(trail(browser)).toEqual(['C:\\', 'Users']);
  // The drive's root is the first entry of the trail, and the folder shown is the last.
  expect(entries(browser).map(entry => entry.getAttribute('aria-current'))).toEqual([null, 'location']);
  await user.click(entries(browser)[0]!);
  await showing(browser, 'C:\\');
  expect(trail(browser)).toEqual(['C:\\']);
  expect(inside(browser)).toEqual(['code', 'Users']);
  expect(button(browser, 'Up one level').disabled).toBe(true);
  await user.click(button(browser, 'Up one level'));
  expect(commands()).toEqual([opened(), opened('C:\\Users'), opened('C:\\')]);
});

test('a drive opens at its root', async () => {
  const user = userEvent.setup();
  const { browser } = browse();
  await showing(browser, 'eli');
  await user.click(within(browser.getByRole('group', { name: 'Drives' })).getByRole('button', { name: 'D:\\' }));
  await showing(browser, 'D:\\');
  expect(commands().at(-1)).toEqual({ url: '/api/folders', method: 'POST', body: { path: 'D:\\' } });
  expect(trail(browser)).toEqual(['D:\\']);
  expect(inside(browser)).toEqual(['archive git repository']);
  expect(button(browser, 'Up one level').disabled).toBe(true);
});

test('the drives show only when there are several: no drive buttons for one, both for two', async () => {
  const user = userEvent.setup();
  folders[home] = { ...folders[home]!, drives: ['C:\\'] };
  const { browser } = browse();
  await showing(browser, 'eli');
  expect(browser.queryByRole('group', { name: 'Drives' })).toBeNull();
  // The drive's root stays as the trail's first entry.
  expect(browser.getAllByRole('button').map(item => item.textContent)).toEqual([
    'C:\\',
    'Users',
    'eli',
    'Up one level',
    'Documents',
    'site git repository',
    'Choose folder',
    'Cancel',
  ]);
  await user.click(button(browser, 'site git repository'));
  await showing(browser, 'site');
  expect(
    within(browser.getByRole('group', { name: 'Drives' }))
      .getAllByRole('button')
      .map(item => item.textContent),
  ).toEqual(['C:\\', 'D:\\']);
});

test('a listing without drives shows none, and a limited listing says not every folder is listed', async () => {
  controller.command = () => ({
    path: '/home/eli',
    parent: '/home',
    trail: [
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'eli', path: '/home/eli' },
    ],
    drives: [],
    folders: [{ name: 'site', path: '/home/eli/site', repository: true }],
    limited: true,
  });
  const { browser } = browse();
  await showing(browser, 'eli');
  expect(browser.queryByRole('group', { name: 'Drives' })).toBeNull();
  expect(trail(browser)).toEqual(['/', 'home', 'eli']);
  expect(
    browser.getByText('Only some of the folders inside are listed. Type or paste the path of a folder that is not.'),
  ).toBeTruthy();
});

test("a refused folder shows the controller's message, and the folder shown stays", async () => {
  const user = userEvent.setup();
  const { browser } = browse();
  await showing(browser, 'eli');
  await focusOn(() => button(browser, 'Documents'));
  // The folder was removed after it was listed.
  delete folders['C:\\Users\\eli\\site'];
  await user.click(button(browser, 'site git repository'));
  expect((await browser.findByRole('alert')).textContent).toBe('The folder does not exist.');
  expect(trail(browser)).toEqual(['C:\\', 'Users', 'eli']);
  expect(inside(browser)).toEqual(['Documents', 'site git repository']);
  // The focus stays on the folder clicked.
  expect(document.activeElement).toBe(button(browser, 'site git repository'));
  // Another folder still opens, and the message goes.
  await user.click(button(browser, 'Documents'));
  await showing(browser, 'Documents');
  expect(browser.queryByRole('alert')).toBeNull();
});

test('Choose folder chooses the folder shown, and Cancel chooses nothing', async () => {
  const user = userEvent.setup();
  const { browser, onChoose, onCancel } = browse();
  await showing(browser, 'eli');
  await user.click(button(browser, 'site git repository'));
  await showing(browser, 'site');
  await user.click(button(browser, 'Choose folder'));
  // With the folders listed in it, which a sample's folder is numbered by.
  expect(onChoose.mock.calls).toEqual([['C:\\Users\\eli\\site', folders['C:\\Users\\eli\\site']]]);
  expect(onCancel).not.toHaveBeenCalled();
  await user.click(button(browser, 'Cancel'));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onChoose).toHaveBeenCalledTimes(1);
});
