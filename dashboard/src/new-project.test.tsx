// Creating a project from Settings (v1.0 item 10): the dialog's first field is an optional folder, typed or chosen
// in the folder browser, which starts at the folder typed. Left empty, the project is for general work as before; a
// git repository's folder is inspected first by the controller, which runs the repository's tests once before
// recording the project, and the dialog stays open meanwhile. The director may edit the proposed settings, which
// are inspected again before the project is created with them. The stand-in answers for the controller; no real
// controller, folder or repository is involved.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FolderListing, RepositoryInspection, SourceProfile } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, shellFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  // The created project's Today reads its own shell: a repository project gets the New idea box.
  controller.shells['project-site'] = {
    ...shellFixture('project-site'),
    project: { id: 'project-site', name: 'Site' },
    projects: [
      { id: 'project-x', name: 'Project X' },
      { id: 'project-site', name: 'Site' },
    ],
    organizationConfiguration: { taskKinds: ['studio-development:breakdown', 'studio-development:change'] },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x/settings') => {
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
const commands = () => controller.requests.filter(request => request.method !== 'GET');
type User = ReturnType<typeof userEvent.setup>;
type Dialog = ReturnType<typeof within>;

const openDialog = async (user: User) => {
  await user.click(await screen.findByRole('button', { name: 'Create a project' }));
  return within(await screen.findByRole('dialog', { name: 'Create a project' }));
};
const input = (dialog: Dialog, label: string) => dialog.getByLabelText(label) as HTMLInputElement;
const fields = ['Folder', 'Name', 'Goal', 'Direction'];
const createButton = (dialog: Dialog) => dialog.getByRole('button', { name: 'Create project' }) as HTMLButtonElement;
const inspectButton = (dialog: Dialog) => dialog.getByRole('button', { name: 'Inspect' }) as HTMLButtonElement;
const browseButton = (dialog: Dialog) => dialog.getByRole('button', { name: 'Browse' }) as HTMLButtonElement;
const closeButton = (dialog: Dialog) => dialog.getByRole('button', { name: 'Close' }) as HTMLButtonElement;

// A profile as the controller proposes one (src/connectors/source-projects.mjs proposeSourceProfile).
const profile: SourceProfile = {
  id: 'site',
  directories: ['src', 'tests'],
  files: ['README.md', 'package.json'],
  extensions: ['js', 'json', 'md', 'mjs'],
  protectedNames: ['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json'],
  contextFiles: ['README.md'],
  tests: { directory: 'tests', suffix: '.test.mjs' },
  formatter: null,
  limits: { files: 500, fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 },
};
// The controller answers with the folder's real path, which creating the project sends back.
const inspection = (extra: Partial<RepositoryInspection> = {}): RepositoryInspection => ({
  root: 'C:\\code\\site',
  branch: 'main',
  head: '0123456789abcdef0123456789abcdef01234567',
  profile,
  files: 42,
  bytes: 2.5 * 1024 * 1024,
  testFiles: 3,
  problems: [],
  ...extra,
});

// The settings the dialog offers for editing, by label, as the stand-in's profile proposes them: lists one entry
// per line, and no formatter.
const proposed = {
  'Folders stories may work in': 'src\ntests',
  'Top-level files stories may work on': 'README.md\npackage.json',
  'Documents agents read for context': 'README.md',
  'Where the tests live': 'tests',
  'Test file names end with': '.test.mjs',
  'Names no story may change': 'AGENTS.md\nCLAUDE.md\npackage.json\npackage-lock.json\nnpm-shrinkwrap.json',
  Formatter: '',
  'Formatter arguments': '',
};
const settings = (dialog: Dialog) =>
  Object.fromEntries(Object.keys(proposed).map(label => [label, input(dialog, label).value]));
const checkAgain = (dialog: Dialog) => dialog.getByRole('button', { name: 'Check again' });
// The controller answers an inspection with the profile it was given, or proposes the stand-in's.
const given = (body: unknown) => (body as { profile?: SourceProfile }).profile ?? profile;

// Folders as the controller lists them (POST /api/folders), by path: the home folder C:\code holds a repository.
const code: FolderListing = {
  path: 'C:\\code',
  parent: 'C:\\',
  trail: [
    { name: 'C:\\', path: 'C:\\' },
    { name: 'code', path: 'C:\\code' },
  ],
  drives: ['C:\\'],
  folders: [
    { name: 'notes', path: 'C:\\code\\notes', repository: false },
    { name: 'site', path: 'C:\\code\\site', repository: true },
  ],
  limited: false,
};
const listings: Record<string, FolderListing> = {
  [code.path]: code,
  'C:\\code\\site': {
    ...code,
    path: 'C:\\code\\site',
    parent: 'C:\\code',
    trail: [...code.trail, { name: 'site', path: 'C:\\code\\site' }],
    folders: [{ name: 'src', path: 'C:\\code\\site\\src', repository: false }],
  },
  'C:\\code\\notes': {
    ...code,
    path: 'C:\\code\\notes',
    parent: 'C:\\code',
    trail: [...code.trail, { name: 'notes', path: 'C:\\code\\notes' }],
    folders: [],
  },
};
// The stand-in answers a folder by its path, typed with either slash. With nearest, a folder it does not list
// answers the nearest one above it that it does, as the controller answers for a missing folder.
const listed = (body: unknown) => {
  const { path = code.path, nearest = false } = body as { path?: string; nearest?: boolean };
  let at = path.replaceAll('/', '\\');
  while (nearest && !listings[at] && at.includes('\\')) at = at.slice(0, at.lastIndexOf('\\'));
  return listings[at];
};
// The first request of a browser that starts at the folder in the field.
const startedAt = (path: string) => ({ url: '/api/folders', method: 'POST', body: { path, nearest: true } });
const browserOf = (dialog: Dialog) => within(dialog.getByRole('region', { name: 'Browse folders' }));
// Waits until the browser shows a folder holding this one, with nothing else opening.
const shows = (browser: Dialog, inside: string) =>
  waitFor(() => {
    expect(browser.getByRole('button', { name: inside })).toBeTruthy();
    expect(browser.queryByRole('status')).toBeNull();
  });
const firstFinding = (dialog: Dialog) =>
  within(dialog.getByRole('list', { name: 'What the controller found' })).getAllByRole('listitem')[0]?.textContent;

// Fills the dialog for a repository project and inspects its folder, in the order the dialog shows them.
async function inspectSite(user: User, dialog: Dialog) {
  await user.type(input(dialog, 'Folder'), 'C:/code/site');
  await user.click(inspectButton(dialog));
  await dialog.findByRole('list', { name: 'What the controller found' });
  await user.type(input(dialog, 'Name'), 'Site');
  await user.type(input(dialog, 'Goal'), 'Publish the site.');
  await user.type(input(dialog, 'Direction'), 'Small changes.');
}

test('the empty folder field comes first, and left empty the dialog sends the name, goal and direction with the recommended house rules', async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/projects' ? { id: 'project-site', name: 'Notes' } : {});
  const router = open();
  const dialog = await openDialog(user);
  const folder = input(dialog, 'Folder');
  expect(folder.form?.elements[0]).toBe(folder);
  expect(folder.compareDocumentPosition(input(dialog, 'Name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(folder.value).toBe('');
  expect(folder.required).toBe(false);
  expect(dialog.getByText(/Leave it empty for work that isn't code\./)).toBeTruthy();
  expect(dialog.getByText(/It starts on the recommended house rules: you approve every plan/)).toBeTruthy();
  expect(dialog.queryByRole('button', { name: 'No repository' })).toBeNull();
  expect(dialog.queryByRole('button', { name: 'Git repository' })).toBeNull();
  // Nothing about a repository is shown, and there is no folder to inspect.
  expect(dialog.queryByText(/can take a few minutes/)).toBeNull();
  expect(dialog.queryByRole('list', { name: 'What the controller found' })).toBeNull();
  expect(dialog.queryByRole('group', { name: 'Proposed settings' })).toBeNull();
  expect(inspectButton(dialog).disabled).toBe(true);
  expect(browseButton(dialog).disabled).toBe(false);
  await user.type(input(dialog, 'Name'), 'Notes');
  await user.type(input(dialog, 'Goal'), 'Write the notes.');
  await user.type(input(dialog, 'Direction'), 'Keep them short.');
  await user.click(createButton(dialog));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-site'));
  expect(commands()).toEqual([
    {
      url: '/api/projects',
      method: 'POST',
      body: { name: 'Notes', goal: 'Write the notes.', direction: 'Keep them short.', houseRules: 'recommended' },
    },
  ]);
  expect(await screen.findByText('Project created.')).toBeTruthy();
});

test('a folder is inspected first, and the dialog says what the controller found, starting with the folder', async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/projects/inspect-repository' ? inspection() : {});
  open();
  const dialog = await openDialog(user);
  await user.type(input(dialog, 'Folder'), 'C:/code/site');
  expect(createButton(dialog).disabled).toBe(true);
  expect(dialog.getByText(/can take a few minutes/)).toBeTruthy();
  await user.type(input(dialog, 'Name'), 'Site');
  await user.click(inspectButton(dialog));
  const found = await dialog.findByRole('list', { name: 'What the controller found' });
  // The folder named is the real path the controller answered, not the folder as typed.
  expect(
    within(found)
      .getAllByRole('listitem')
      .map(item => item.textContent),
  ).toEqual([
    'Inspected C:\\code\\site.',
    'On branch main at commit 0123456.',
    'The project covers 42 files, 2.5 MB in all.',
    '3 test files found.',
  ]);
  expect(commands()).toEqual([
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/site' } },
  ]);
  expect(dialog.queryByRole('alert')).toBeNull();
  expect(createButton(dialog).disabled).toBe(false);
  // Changing the folder clears the findings, so creating waits for another inspection.
  await user.type(input(dialog, 'Folder'), '-2');
  expect(dialog.queryByRole('list', { name: 'What the controller found' })).toBeNull();
  expect(dialog.queryByRole('group', { name: 'Proposed settings' })).toBeNull();
  expect(createButton(dialog).disabled).toBe(true);
  // Emptying it makes the project one for work that is not code again.
  await user.clear(input(dialog, 'Folder'));
  expect(dialog.queryByText(/can take a few minutes/)).toBeNull();
  expect(createButton(dialog).disabled).toBe(false);
});

test('a folder pasted with the quotes Copy as path adds is inspected without them; quotes inside a path stay', async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/projects/inspect-repository' ? inspection() : {});
  open();
  const dialog = await openDialog(user);
  await user.type(input(dialog, 'Folder'), ' "C:\\code\\site" ');
  await user.click(inspectButton(dialog));
  await dialog.findByRole('list', { name: 'What the controller found' });
  await user.clear(input(dialog, 'Folder'));
  await user.type(input(dialog, 'Folder'), 'C:\\code\\"odd"\\site');
  await user.click(inspectButton(dialog));
  await dialog.findByRole('list', { name: 'What the controller found' });
  expect(commands()).toEqual([
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:\\code\\site' } },
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:\\code\\"odd"\\site' } },
  ]);
  // A pair of quotes alone names no folder to inspect.
  await user.clear(input(dialog, 'Folder'));
  await user.type(input(dialog, 'Folder'), '""');
  expect(inspectButton(dialog).disabled).toBe(true);
  expect(createButton(dialog).disabled).toBe(true);
});

test('Enter in the Folder field inspects it as Inspect does, and never creates the project', async () => {
  const user = userEvent.setup(),
    held = Promise.withResolvers<unknown>();
  let answer = (): unknown => held.promise;
  controller.command = url =>
    url === '/api/projects/inspect-repository'
      ? answer()
      : url === '/api/projects'
        ? { id: 'project-site', name: 'Site' }
        : {};
  const router = open();
  const dialog = await openDialog(user);
  await user.type(input(dialog, 'Name'), 'Site');
  await user.type(input(dialog, 'Folder'), 'C:/code/site{Enter}');
  expect((await dialog.findByRole('status')).textContent).toBe('Inspecting the repository…');
  // Another Enter while the inspection runs sends nothing, as Inspect is disabled meanwhile.
  await user.keyboard('{Enter}');
  expect(commands()).toEqual([
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/site' } },
  ]);
  held.resolve(inspection());
  await dialog.findByRole('list', { name: 'What the controller found' });
  expect(firstFinding(dialog)).toBe('Inspected C:\\code\\site.');
  expect(createButton(dialog).disabled).toBe(false);
  // With the project ready to create, Enter in the field inspects the folder again instead of creating it.
  answer = () => inspection();
  await user.keyboard('{Enter}');
  await waitFor(() =>
    expect(commands()).toEqual([
      { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/site' } },
      { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/site' } },
    ]),
  );
  await waitFor(() => expect(dialog.queryByRole('status')).toBeNull());
  expect(firstFinding(dialog)).toBe('Inspected C:\\code\\site.');
  expect(router.history.location.pathname).toBe('/p/project-x/settings');
});

test('Enter in the empty Folder field sends nothing, and Enter in Name still creates the project', async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/projects' ? { id: 'project-site', name: 'Notes' } : {});
  const router = open();
  const dialog = await openDialog(user);
  await user.type(input(dialog, 'Name'), 'Notes');
  await user.type(input(dialog, 'Folder'), '{Enter}');
  expect(commands()).toEqual([]);
  expect(router.history.location.pathname).toBe('/p/project-x/settings');
  await user.type(input(dialog, 'Name'), '{Enter}');
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-site'));
  expect(commands()).toEqual([
    {
      url: '/api/projects',
      method: 'POST',
      body: { name: 'Notes', goal: '', direction: '', houseRules: 'recommended' },
    },
  ]);
});

test("a folder that is not a git repository shows the controller's refusal, and Create stays disabled", async () => {
  const user = userEvent.setup(),
    refusal =
      'This folder is not a git repository. This version of Studio desk works on git repositories; leave the folder empty to make a project for work that is not code.';
  controller.command = url => {
    if (url === '/api/projects/inspect-repository') throw new Error(refusal);
    return {};
  };
  open();
  const dialog = await openDialog(user);
  await user.type(input(dialog, 'Folder'), 'C:\\notes');
  await user.type(input(dialog, 'Name'), 'Notes');
  await user.click(inspectButton(dialog));
  expect((await dialog.findByRole('alert')).textContent).toBe(refusal);
  expect(dialog.queryByRole('list', { name: 'What the controller found' })).toBeNull();
  expect(dialog.queryByRole('group', { name: 'Proposed settings' })).toBeNull();
  expect(createButton(dialog).disabled).toBe(true);
  await user.click(createButton(dialog));
  expect(commands()).toEqual([
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:\\notes' } },
  ]);
});

test('Browse opens the folder browser, and Choose folder fills in the folder and inspects it without Inspect', async () => {
  const user = userEvent.setup(),
    held = Promise.withResolvers<unknown>();
  controller.command = (url, _method, body) =>
    url === '/api/folders' ? listed(body) : url === '/api/projects/inspect-repository' ? held.promise : {};
  open();
  const dialog = await openDialog(user);
  expect(dialog.queryByRole('region', { name: 'Browse folders' })).toBeNull();
  await user.click(browseButton(dialog));
  const browser = browserOf(dialog);
  expect(browseButton(dialog).disabled).toBe(true);
  await shows(browser, 'site git repository');
  await user.click(browser.getByRole('button', { name: 'site git repository' }));
  await shows(browser, 'src');
  await user.click(browser.getByRole('button', { name: 'Choose folder' }));
  // The browser closes, the field holds the chosen folder, and its inspection starts straight away.
  expect(dialog.queryByRole('region', { name: 'Browse folders' })).toBeNull();
  expect(input(dialog, 'Folder').value).toBe('C:\\code\\site');
  expect((await dialog.findByRole('status')).textContent).toBe('Inspecting the repository…');
  expect(inspectButton(dialog).disabled).toBe(true);
  expect(browseButton(dialog).disabled).toBe(true);
  held.resolve(inspection());
  await dialog.findByRole('list', { name: 'What the controller found' });
  expect(firstFinding(dialog)).toBe('Inspected C:\\code\\site.');
  expect(dialog.getByRole('group', { name: 'Proposed settings' })).toBeTruthy();
  expect(browseButton(dialog).disabled).toBe(false);
  expect(createButton(dialog).disabled).toBe(false);
  expect(commands()).toEqual([
    { url: '/api/folders', method: 'POST', body: {} },
    { url: '/api/folders', method: 'POST', body: { path: 'C:\\code\\site' } },
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:\\code\\site' } },
  ]);
});

test('Browse starts at the folder in the field or the nearest one above it, and at the home folder with none', async () => {
  const user = userEvent.setup();
  controller.command = (url, _method, body) => (url === '/api/folders' ? listed(body) : {});
  open();
  const dialog = await openDialog(user);
  // The folder as inspecting it would send it, without the quotes Copy as path adds.
  await user.type(input(dialog, 'Folder'), ' "C:\\code\\site" ');
  await user.click(browseButton(dialog));
  let browser = browserOf(dialog);
  await shows(browser, 'src');
  expect(
    within(browser.getByRole('navigation', { name: 'Folder path' }))
      .getAllByRole('button')
      .map(entry => entry.textContent),
  ).toEqual(['C:\\', 'code', 'site']);
  // The focus goes into the browser, to its first folder inside, not to the dialog's ×.
  await waitFor(() => expect(document.activeElement).toBe(browser.getByRole('button', { name: 'src' })));
  await user.click(browser.getByRole('button', { name: 'Cancel' }));
  // A folder that does not exist yet opens the nearest one above it that does.
  await user.clear(input(dialog, 'Folder'));
  await user.type(input(dialog, 'Folder'), 'C:/code/site/drafts');
  await user.click(browseButton(dialog));
  browser = browserOf(dialog);
  await shows(browser, 'src');
  await user.click(browser.getByRole('button', { name: 'Cancel' }));
  await user.clear(input(dialog, 'Folder'));
  await user.click(browseButton(dialog));
  await shows(browserOf(dialog), 'site git repository');
  expect(commands()).toEqual([
    startedAt('C:\\code\\site'),
    startedAt('C:/code/site/drafts'),
    { url: '/api/folders', method: 'POST', body: {} },
  ]);
});

test('choosing a folder clears the findings of the folder before it', async () => {
  const user = userEvent.setup(),
    held = Promise.withResolvers<unknown>();
  let answer = (): unknown => inspection({ root: 'C:\\code\\old' });
  controller.command = (url, _method, body) =>
    url === '/api/folders' ? listed(body) : url === '/api/projects/inspect-repository' ? answer() : {};
  open();
  const dialog = await openDialog(user);
  await user.type(input(dialog, 'Folder'), 'C:/code/old');
  await user.click(inspectButton(dialog));
  await dialog.findByRole('list', { name: 'What the controller found' });
  expect(firstFinding(dialog)).toBe('Inspected C:\\code\\old.');
  await user.click(browseButton(dialog));
  // The findings of the folder in the field stay while the director browses.
  expect(firstFinding(dialog)).toBe('Inspected C:\\code\\old.');
  const browser = browserOf(dialog);
  // The folder in the field does not exist, so the browser starts at the nearest folder above it.
  await shows(browser, 'site git repository');
  expect(commands().filter(command => command.url === '/api/folders')).toEqual([startedAt('C:/code/old')]);
  await user.click(browser.getByRole('button', { name: 'site git repository' }));
  await shows(browser, 'src');
  answer = () => held.promise;
  await user.click(browser.getByRole('button', { name: 'Choose folder' }));
  expect(dialog.queryByRole('list', { name: 'What the controller found' })).toBeNull();
  expect(dialog.queryByRole('group', { name: 'Proposed settings' })).toBeNull();
  expect(createButton(dialog).disabled).toBe(true);
  held.resolve(inspection());
  await waitFor(() => expect(firstFinding(dialog)).toBe('Inspected C:\\code\\site.'));
  expect(commands().filter(command => command.url === '/api/projects/inspect-repository')).toEqual([
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/old' } },
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:\\code\\site' } },
  ]);
});

test('Cancel closes the folder browser, leaves the folder as it was and inspects nothing', async () => {
  const user = userEvent.setup();
  controller.command = (url, _method, body) => (url === '/api/folders' ? listed(body) : inspection());
  open();
  const dialog = await openDialog(user);
  await user.type(input(dialog, 'Folder'), 'C:/code/notes');
  await user.click(browseButton(dialog));
  const browser = browserOf(dialog);
  // The browser starts at the folder in the field, which holds no folders.
  await shows(browser, 'notes');
  expect(browser.getByText('There are no folders inside this one.')).toBeTruthy();
  await user.click(browser.getByRole('button', { name: 'Up one level' }));
  await shows(browser, 'site git repository');
  await user.click(browser.getByRole('button', { name: 'site git repository' }));
  await shows(browser, 'src');
  await user.click(browser.getByRole('button', { name: 'Cancel' }));
  expect(dialog.queryByRole('region', { name: 'Browse folders' })).toBeNull();
  expect(input(dialog, 'Folder').value).toBe('C:/code/notes');
  expect(browseButton(dialog).disabled).toBe(false);
  expect(dialog.queryByRole('status')).toBeNull();
  expect(commands()).toEqual([
    startedAt('C:/code/notes'),
    { url: '/api/folders', method: 'POST', body: { path: 'C:\\code' } },
    { url: '/api/folders', method: 'POST', body: { path: 'C:\\code\\site' } },
  ]);
  // Browsing again starts at the folder in the field again.
  await user.click(browseButton(dialog));
  await shows(browserOf(dialog), 'notes');
  expect(commands().at(-1)).toEqual(startedAt('C:/code/notes'));
});

test('after an inspection the dialog shows the proposed settings for editing, with no formatter', async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/projects/inspect-repository' ? inspection() : {});
  open();
  const dialog = await openDialog(user);
  await inspectSite(user, dialog);
  expect(dialog.getByRole('group', { name: 'Proposed settings' })).toBeTruthy();
  expect(settings(dialog)).toEqual(proposed);
  expect(input(dialog, 'Formatter').placeholder).toBe('None');
  expect(dialog.getByText(/Leave it empty for none\./)).toBeTruthy();
  expect(dialog.queryByText(/Check the changed settings again/)).toBeNull();
  expect(createButton(dialog).disabled).toBe(false);
});

test('edited settings are inspected again before Create, which then sends the last inspected profile', async () => {
  const user = userEvent.setup(),
    held = Promise.withResolvers<unknown>();
  let answer = (): unknown => inspection();
  controller.command = url =>
    url === '/api/projects/inspect-repository'
      ? answer()
      : url === '/api/projects'
        ? { id: 'project-site', name: 'Site' }
        : {};
  const router = open();
  const dialog = await openDialog(user);
  await inspectSite(user, dialog);
  const ending = input(dialog, 'Test file names end with');
  await user.clear(ending);
  await user.type(ending, '.spec.mjs');
  // A list takes entries separated by commas as well as one per line.
  await user.type(input(dialog, 'Folders stories may work in'), ', docs');
  // Editing asks the controller nothing, and Create waits for the edited settings to be inspected.
  expect(commands()).toHaveLength(1);
  expect(createButton(dialog).disabled).toBe(true);
  expect(dialog.getByText('Check the changed settings again before creating the project.')).toBeTruthy();
  answer = () => held.promise;
  await user.click(checkAgain(dialog));
  const edited: SourceProfile = {
    ...profile,
    directories: ['src', 'tests', 'docs'],
    tests: { directory: 'tests', suffix: '.spec.mjs' },
  };
  expect(commands().at(-1)).toEqual({
    url: '/api/projects/inspect-repository',
    method: 'POST',
    body: { root: 'C:/code/site', profile: edited },
  });
  expect((await dialog.findByRole('status')).textContent).toBe('Inspecting the repository…');
  expect(createButton(dialog).disabled).toBe(true);
  expect(browseButton(dialog).disabled).toBe(true);
  expect(input(dialog, 'Test file names end with').disabled).toBe(true);
  held.resolve(inspection({ profile: edited, files: 50, testFiles: 4 }));
  // The findings and settings are the new answer's.
  expect(await dialog.findByText('4 test files found.')).toBeTruthy();
  expect(dialog.getByText('The project covers 50 files, 2.5 MB in all.')).toBeTruthy();
  expect(settings(dialog)).toEqual({
    ...proposed,
    'Folders stories may work in': 'src\ntests\ndocs',
    'Test file names end with': '.spec.mjs',
  });
  expect(dialog.queryByText(/Check the changed settings again/)).toBeNull();
  expect(createButton(dialog).disabled).toBe(false);
  await user.click(createButton(dialog));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-site'));
  expect(commands().at(-1)).toEqual({
    url: '/api/projects',
    method: 'POST',
    body: {
      name: 'Site',
      goal: 'Publish the site.',
      direction: 'Small changes.',
      repository: { root: 'C:\\code\\site', profile: edited },
      houseRules: 'recommended',
    },
  });
});

test("a refused re-inspection shows the controller's message and keeps Create disabled until a check passes", async () => {
  const user = userEvent.setup(),
    invalid = 'The source profile is not valid: tests must name a snapshot directory and a file suffix.';
  let answer = (body: unknown): unknown => inspection({ profile: given(body) });
  controller.command = (url, _method, body) => (url === '/api/projects/inspect-repository' ? answer(body) : {});
  open();
  const dialog = await openDialog(user);
  await inspectSite(user, dialog);
  const folder = input(dialog, 'Where the tests live');
  await user.clear(folder);
  await user.type(folder, 'spec');
  answer = () => {
    throw new Error(invalid);
  };
  await user.click(checkAgain(dialog));
  expect((await dialog.findByRole('alert')).textContent).toBe(invalid);
  expect(createButton(dialog).disabled).toBe(true);
  expect(commands().at(-1)?.body).toEqual({
    root: 'C:/code/site',
    profile: { ...profile, tests: { directory: 'spec', suffix: '.test.mjs' } },
  });
  // The last answer's findings and the director's edit stay, so the edit can be corrected.
  expect(dialog.getByText('3 test files found.')).toBeTruthy();
  expect(input(dialog, 'Where the tests live').value).toBe('spec');
  answer = body => inspection({ profile: given(body) });
  await user.type(input(dialog, 'Folders stories may work in'), '{Enter}spec');
  await user.click(checkAgain(dialog));
  await waitFor(() => expect(createButton(dialog).disabled).toBe(false));
  expect(dialog.queryByRole('alert')).toBeNull();
  expect(commands().at(-1)?.body).toEqual({
    root: 'C:/code/site',
    profile: { ...profile, directories: ['src', 'tests', 'spec'], tests: { directory: 'spec', suffix: '.test.mjs' } },
  });
});

test('a formatter package is sent with its arguments, and clearing it sends none', async () => {
  const user = userEvent.setup();
  controller.command = (url, _method, body) =>
    url === '/api/projects/inspect-repository' ? inspection({ profile: given(body) }) : {};
  open();
  const dialog = await openDialog(user);
  await inspectSite(user, dialog);
  await user.type(input(dialog, 'Formatter'), 'prettier@3.3.3');
  await user.type(input(dialog, 'Formatter arguments'), '--write --log-level=warn');
  expect(createButton(dialog).disabled).toBe(true);
  await user.click(checkAgain(dialog));
  await waitFor(() => expect(createButton(dialog).disabled).toBe(false));
  expect(input(dialog, 'Formatter').value).toBe('prettier@3.3.3');
  await user.clear(input(dialog, 'Formatter'));
  expect(createButton(dialog).disabled).toBe(true);
  await user.click(checkAgain(dialog));
  await waitFor(() => expect(createButton(dialog).disabled).toBe(false));
  // With no package, the arguments are not sent either.
  expect(settings(dialog)).toEqual(proposed);
  expect(commands().slice(1)).toEqual([
    {
      url: '/api/projects/inspect-repository',
      method: 'POST',
      body: {
        root: 'C:/code/site',
        profile: { ...profile, formatter: { package: 'prettier@3.3.3', args: ['--write', '--log-level=warn'] } },
      },
    },
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/site', profile } },
  ]);
});

test("an inspection's problems keep Create disabled, and a refused inspection shows the controller's reason", async () => {
  const user = userEvent.setup(),
    dirty = 'Commit or stash the tracked changes first: stories start from a clean tree.';
  let answer = (): unknown => inspection({ files: 12, bytes: 500 * 1024, testFiles: 0, problems: [dirty] });
  controller.command = url => (url === '/api/projects/inspect-repository' ? answer() : {});
  open();
  const dialog = await openDialog(user);
  await inspectSite(user, dialog);
  expect(dialog.getAllByRole('alert').map(alert => alert.textContent)).toEqual([dirty]);
  expect(dialog.getByText('The project covers 12 files, 500 KB in all.')).toBeTruthy();
  expect(dialog.getByText('No test files found yet.')).toBeTruthy();
  expect(createButton(dialog).disabled).toBe(true);
  await user.click(createButton(dialog));
  answer = () => {
    throw new Error('The repository folder does not exist.');
  };
  const folder = input(dialog, 'Folder');
  await user.clear(folder);
  await user.type(folder, 'C:/code/missing');
  expect(dialog.queryByRole('alert')).toBeNull();
  await user.click(inspectButton(dialog));
  expect((await dialog.findByRole('alert')).textContent).toBe('The repository folder does not exist.');
  expect(dialog.queryByRole('list', { name: 'What the controller found' })).toBeNull();
  expect(createButton(dialog).disabled).toBe(true);
  expect(commands()).toEqual([
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/site' } },
    { url: '/api/projects/inspect-repository', method: 'POST', body: { root: 'C:/code/missing' } },
  ]);
});

test("creating on a repository waits for its tests, and a refusal shows the controller's message and keeps the fields", async () => {
  const user = userEvent.setup(),
    failed =
      "The repository's tests must pass before it is added: 3 of 4 passed (failing: renders the page). Fix the failing tests, commit, then create the project again.",
    held = Promise.withResolvers<unknown>();
  controller.command = url =>
    url === '/api/projects/inspect-repository' ? inspection() : url === '/api/projects' ? held.promise : {};
  const router = open();
  const dialog = await openDialog(user);
  await inspectSite(user, dialog);
  await user.click(createButton(dialog));
  expect((await dialog.findByRole('status')).textContent).toBe("Running the repository's tests on a copy…");
  expect(
    dialog.getByText(
      "Creating the project runs the repository's tests once on a copy of its commit, which can take a few minutes. The project is added only if they pass.",
    ),
  ).toBeTruthy();
  expect(createButton(dialog).disabled).toBe(true);
  expect(fields.map(label => input(dialog, label).disabled)).toEqual([true, true, true, true]);
  expect(inspectButton(dialog).disabled).toBe(true);
  expect(browseButton(dialog).disabled).toBe(true);
  // The inspected root and proposed profile, not the folder as typed.
  expect(commands().at(-1)).toEqual({
    url: '/api/projects',
    method: 'POST',
    body: {
      name: 'Site',
      goal: 'Publish the site.',
      direction: 'Small changes.',
      repository: { root: 'C:\\code\\site', profile },
      houseRules: 'recommended',
    },
  });
  held.reject(new Error(failed));
  expect((await dialog.findByRole('alert')).textContent).toBe(failed);
  expect(dialog.queryByRole('status')).toBeNull();
  expect(createButton(dialog).disabled).toBe(false);
  expect(fields.map(label => [input(dialog, label).value, input(dialog, label).disabled])).toEqual([
    ['C:/code/site', false],
    ['Site', false],
    ['Publish the site.', false],
    ['Small changes.', false],
  ]);
  expect(dialog.getByRole('list', { name: 'What the controller found' })).toBeTruthy();
  expect(router.history.location.pathname).toBe('/p/project-x/settings');
});

// Escape sends the dialog a keydown and then a cancel event, and a browser closes it unless they are prevented; the
// test DOM only reports whether they were. A browser lets a second Escape close a dialog whose cancel was
// prevented, with no cancel event to prevent; the test DOM cannot, so removing the dialog's open attribute and
// firing its close event stands for that close.
const dialogElement = () => screen.getByRole('dialog', { name: 'Create a project' }) as HTMLDialogElement;
const escape = (target: Element = dialogElement()) => fireEvent.keyDown(target, { key: 'Escape' });
const cancel = () => fireEvent(dialogElement(), new Event('cancel', { cancelable: true }));
const closedByBrowser = () => {
  const element = dialogElement();
  element.removeAttribute('open');
  fireEvent(element, new Event('close'));
};

// While the site's project is being created, Escapes and a close the browser makes leave the dialog open as it was:
// its fields disabled with what was typed, its × disabled and its status shown.
function escapesWhileCreating(dialog: Dialog) {
  expect(escape()).toBe(false);
  expect(escape()).toBe(false);
  // A disabled field leaves the focus on the page, where Escape is held back too.
  expect(escape(document.body)).toBe(false);
  expect(cancel()).toBe(false);
  closedByBrowser();
  expect(dialogElement().hasAttribute('open')).toBe(true);
  expect(fields.map(label => [input(dialog, label).value, input(dialog, label).disabled])).toEqual([
    ['C:/code/site', true],
    ['Site', true],
    ['Publish the site.', true],
    ['Small changes.', true],
  ]);
  expect(closeButton(dialog).disabled).toBe(true);
  expect(dialog.getByRole('status').textContent).toBe("Running the repository's tests on a copy…");
}

test('the dialog stays open through repeated Escapes while the project is being created, and closes after a refusal', async () => {
  const user = userEvent.setup(),
    failed = "The repository's tests must pass before it is added: 3 of 4 passed (failing: renders the page).",
    held = Promise.withResolvers<unknown>();
  controller.command = url =>
    url === '/api/projects/inspect-repository' ? inspection() : url === '/api/projects' ? held.promise : {};
  open();
  const dialog = await openDialog(user);
  expect(closeButton(dialog).disabled).toBe(false);
  expect(escape()).toBe(true);
  expect(cancel()).toBe(true);
  await inspectSite(user, dialog);
  await user.click(createButton(dialog));
  await dialog.findByRole('status');
  escapesWhileCreating(dialog);
  await user.click(closeButton(dialog));
  expect(screen.getByRole('dialog', { name: 'Create a project' })).toBeTruthy();
  held.reject(new Error(failed));
  expect((await dialog.findByRole('alert')).textContent).toBe(failed);
  expect(closeButton(dialog).disabled).toBe(false);
  // Escape closes it again, and the page hears of the close.
  expect(escape()).toBe(true);
  expect(escape(document.body)).toBe(true);
  expect(cancel()).toBe(true);
  closedByBrowser();
  expect(screen.queryByRole('dialog', { name: 'Create a project' })).toBeNull();
  // So does its ×.
  await user.click(closeButton(await openDialog(user)));
  expect(screen.queryByRole('dialog', { name: 'Create a project' })).toBeNull();
  expect(commands().map(command => command.url)).toEqual(['/api/projects/inspect-repository', '/api/projects']);
});

test('a created repository project opens on its own Today, with the New idea box', async () => {
  const user = userEvent.setup(),
    held = Promise.withResolvers<unknown>();
  controller.command = url =>
    url === '/api/projects/inspect-repository' ? inspection() : url === '/api/projects' ? held.promise : {};
  const router = open();
  const dialog = await openDialog(user);
  await inspectSite(user, dialog);
  await user.click(createButton(dialog));
  await dialog.findByRole('status');
  escapesWhileCreating(dialog);
  held.resolve({
    id: 'project-site',
    name: 'Site',
    tests: { tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  });
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-site'));
  expect(screen.queryByRole('dialog', { name: 'Create a project' })).toBeNull();
  expect(await screen.findByRole('textbox', { name: 'New idea for Site' })).toBeTruthy();
  expect(screen.getByText('Project created. Its tests passed: 4 of 4.')).toBeTruthy();
  const rail = within(screen.getByRole('navigation', { name: 'Projects' }));
  expect(rail.getByRole('link', { name: 'Site' }).getAttribute('aria-current')).toBe('true');
  expect(controller.reads()).toEqual(
    expect.arrayContaining(['/api/projects/project-site/shell', '/api/projects/project-site/live']),
  );
  expect(commands().map(command => command.url)).toEqual(['/api/projects/inspect-repository', '/api/projects']);
});
