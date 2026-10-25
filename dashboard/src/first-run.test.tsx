// No projects yet (v1.0 item 24): with no project, the home address shows the first run. The bundled templates
// make a real project on the signed-in CLI the director picks, with or without a first idea; only signed-in CLIs
// are listed; Something else opens Create a project; the new project's Today carries the first-run guide; and
// deleting the last project in Settings brings the page back. The stand-in answers for the controller; no real
// controller, folder or CLI is involved.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FirstRunTemplates, ProjectTemplate } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

const house = 'You approve the plan before any work starts. Work that passes its review goes in on its own.';
const code: ProjectTemplate = {
  id: 'code',
  kind: 'code',
  name: 'To-do list sample',
  description: 'A small to-do list library with tests.',
  files: [
    { path: 'README.md', bytes: 800 },
    { path: 'package.json', bytes: 200 },
    { path: 'src/todo.js', bytes: 1900 },
    { path: 'test/todo.test.js', bytes: 1600 },
  ],
  team: [
    { agentId: 'W-01', name: 'Mara', role: 'Planner', does: 'plans', line: 'Turns your idea into stories', look: null },
    {
      agentId: 'W-02',
      name: 'Eli',
      role: 'Engineer',
      does: 'builds',
      line: 'Makes the change in its own copy',
      look: null,
    },
    {
      agentId: 'W-07',
      name: 'Morgan',
      role: 'Reviewer',
      does: 'reviews',
      line: 'Checks the work and can send it back',
      look: null,
    },
  ],
  needsGit: true,
  suggestions: ['Add a way to mark every item done at once.', 'Let items have a due date.'],
  houseRules: house,
};
const writing: ProjectTemplate = {
  ...code,
  id: 'writing',
  kind: 'writing',
  name: 'Volunteer guide sample',
  description: 'A short brief, notes and a style sheet.',
  files: [
    { path: 'brief.md', bytes: 600 },
    { path: 'notes.md', bytes: 2200 },
    { path: 'style.md', bytes: 400 },
  ],
  team: [
    code.team[0]!,
    {
      agentId: 'W-09',
      name: 'Juno',
      role: 'Writer',
      does: 'writes',
      line: 'Drafts the piece and hands it on',
      look: null,
    },
    code.team[2]!,
  ],
  needsGit: false,
  suggestions: ['Turn the brief into a one-page welcome guide.', 'Write a short email inviting volunteers back.'],
};
const claude = { id: 'claude', label: 'Claude Code' },
  codex = { id: 'codex', label: 'Codex CLI' };
const templates = (extra: Partial<FirstRunTemplates> = {}): FirstRunTemplates => ({
  firstRun: true,
  clis: [claude],
  git: { found: true, version: '2.47.0' },
  samples: 'C:\\data\\samples',
  templates: [code, writing],
  ...extra,
});

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell.projects = [];
  controller.templates = templates();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const open = (path = '/') => {
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
// Creating a sample answers as the controller does and makes the project exist.
const creates = () => {
  controller.command = url => {
    if (url !== '/api/projects/from-template') return {};
    controller.shell.projects = [{ id: 'project-x', name: 'To-do list sample' }];
    return { projectId: 'project-x', runId: null, folder: 'C:\\data\\samples\\to-do-list-sample' };
  };
};

test('with no project, the home page offers the templates on the signed-in CLI and never lists the others', async () => {
  open('/');
  expect(await screen.findByRole('heading', { level: 1, name: 'Let’s start your first project.' })).toBeTruthy();
  expect(screen.getByText('Welcome to Studio desk')).toBeTruthy();
  const cli = screen.getByRole('radio', { name: /Claude Code/ });
  expect(cli.getAttribute('aria-checked')).toBe('true');
  expect(screen.getAllByRole('radio')).toHaveLength(1);
  expect(screen.queryByText(/missing|not signed in/i)).toBeNull();
  // Someone signed in to one CLI never reads about the other (v1.0 item 25).
  expect(screen.queryByText(/codex/i)).toBeNull();
  expect((screen.getByRole('button', { name: 'Try the code example' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Try the writing example' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('Mara plans · Eli builds · Morgan reviews')).toBeTruthy();
  expect(screen.getByText('Needs Git, found on this computer')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'Main' }).textContent).toBe('Start a project');
});

test('the CLI card says when a code project’s tests will run without a sandbox, and only then (v1.0 item 25)', async () => {
  const notice = /A code project’s tests run on this computer, without a sandbox/;
  controller.templates = templates({ testSandbox: 'none' });
  open('/');
  await screen.findByRole('heading', { level: 1, name: 'Let’s start your first project.' });
  expect(screen.getByText(notice)).toBeTruthy();
  cleanup();
  controller.templates = templates({ testSandbox: 'codex' });
  open('/');
  await screen.findByRole('heading', { level: 1, name: 'Let’s start your first project.' });
  expect(screen.queryByText(notice)).toBeNull();
});

test('with no CLI signed in, the examples wait for one, and Check again asks the controller again', async () => {
  controller.templates = templates({ clis: [], firstRun: false });
  const user = userEvent.setup();
  open('/');
  expect(await screen.findByRole('heading', { level: 1, name: 'There are no projects right now.' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Connect an AI CLI' })).toBeTruthy();
  expect(screen.getByText('You need one, not both.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Try the code example' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Try the writing example' }) as HTMLButtonElement).disabled).toBe(true);
  const asked = () => controller.reads().filter(url => url === '/api/templates').length;
  expect(asked()).toBe(1);
  controller.templates = templates({ firstRun: false });
  await user.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(asked()).toBe(2));
  expect(await screen.findByRole('radio', { name: /Claude Code/ })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Try the code example' }) as HTMLButtonElement).disabled).toBe(false);
});

test('without git, the code example waits and says so; writing needs none', async () => {
  controller.templates = templates({ git: { found: false, version: null } });
  open('/');
  expect(await screen.findByText('Needs Git, which isn’t on this computer yet')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Try the code example' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Try the writing example' }) as HTMLButtonElement).disabled).toBe(false);
});

test('Create the project only makes the sample under its chosen name without an idea, then opens it with the guide', async () => {
  creates();
  const user = userEvent.setup();
  const router = open('/');
  await user.click(await screen.findByRole('button', { name: 'Try the code example' }));
  await waitFor(() => expect(router.state.location.search).toEqual({ template: 'code' }));
  expect(screen.getByRole('heading', { level: 1, name: 'Here’s your sample project.' })).toBeTruthy();
  const name = screen.getByLabelText('Name') as HTMLInputElement;
  expect(name.value).toBe('To-do list sample');
  // Nothing is sent without an idea: the box starts empty, so only creating the project alone is offered.
  expect(
    (screen.getByRole('button', { name: /Create the project and send this idea/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.clear(name);
  expect((screen.getByRole('button', { name: 'Create the project only' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Give the project a name first.')).toBeTruthy();
  await user.type(name, 'My list');
  await user.click(screen.getByRole('button', { name: 'Create the project only' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x'));
  expect(commands()).toEqual([
    { url: '/api/projects/from-template', method: 'POST', body: { template: 'code', name: 'My list', cli: 'claude' } },
  ]);
  expect(await screen.findByRole('heading', { name: 'Good to know' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Hide this guide' }));
  expect(screen.queryByRole('heading', { name: 'Good to know' })).toBeNull();
  expect(localStorage.getItem('studio-first-run:project-x')).toBeNull();
});

test('a suggestion becomes the first idea, sent with the project on the CLI chosen', async () => {
  creates();
  controller.templates = templates({ clis: [claude, codex] });
  const user = userEvent.setup();
  const router = open('/?template=writing');
  const box = within(await screen.findByRole('form', { name: 'Your first idea' }));
  expect(screen.getByText('Juno')).toBeTruthy();
  expect(screen.getByText('Drafts the piece and hands it on')).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('They run on'), 'codex');
  expect(screen.getByText(/It runs on your Codex CLI sign-in/)).toBeTruthy();
  await user.click(box.getByRole('button', { name: /Write a short email inviting volunteers back/ }));
  await user.click(box.getByRole('button', { name: /Create the project and send this idea/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x'));
  expect(commands()).toEqual([
    {
      url: '/api/projects/from-template',
      method: 'POST',
      body: {
        template: 'writing',
        name: 'Volunteer guide sample',
        cli: 'codex',
        idea: 'Write a short email inviting volunteers back.',
      },
    },
  ]);
});

test('the sample’s folder is shown, and another folder can be chosen for it or given back', async () => {
  creates();
  const user = userEvent.setup(),
    listing = (path: string, folders: string[]) => ({
      path,
      parent: null,
      trail: [{ name: path, path }],
      drives: [],
      folders: folders.map(name => ({ name, path: `${path}\\${name}`, repository: false })),
      limited: false,
    });
  controller.command = (url, _method, body) => {
    if (url === '/api/folders')
      return (body as { path?: string }).path === 'C:\\Users\\eli\\Documents'
        ? listing('C:\\Users\\eli\\Documents', ['Guide'])
        : listing('C:\\Users\\eli', ['Documents']);
    controller.shell.projects = [{ id: 'project-x', name: 'Guide' }];
    return { projectId: 'project-x', runId: null, folder: 'C:\\Users\\eli\\Documents\\guide' };
  };
  const router = open('/?template=writing');
  const folder = await screen.findByLabelText('Folder');
  // In the data folder's samples, named after the project as the controller names it.
  expect(folder.textContent).toBe('C:\\data\\samples\\volunteer-guide-sample');
  expect(screen.getByText('Deleting the project deletes this folder too.')).toBeTruthy();
  expect(screen.getByText(/kept in your Studio desk data folder\./)).toBeTruthy();
  await user.clear(screen.getByLabelText('Name'));
  await user.type(screen.getByLabelText('Name'), 'Guide');
  expect(folder.textContent).toBe('C:\\data\\samples\\guide');
  await user.click(screen.getByRole('button', { name: 'Choose a folder' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Where the sample goes' }));
  await user.click(await dialog.findByRole('button', { name: 'Documents' }));
  await dialog.findByRole('button', { name: 'Guide' });
  await user.click(dialog.getByRole('button', { name: 'Choose folder' }));
  expect(screen.queryByRole('dialog', { name: 'Where the sample goes' })).toBeNull();
  // A folder of that name is there already, so the sample's gets a number, as the controller numbers it.
  expect(screen.getByLabelText('Folder').textContent).toBe('C:\\Users\\eli\\Documents\\guide-2');
  expect(screen.getByText('Deleting the project leaves this folder and its files where they are.')).toBeTruthy();
  expect(screen.getByText(/in a new folder inside the one you chose\./)).toBeTruthy();
  // Given back, the data folder is shown again; chosen again, the sample goes there.
  await user.click(screen.getByRole('button', { name: 'Use the data folder' }));
  expect(screen.getByLabelText('Folder').textContent).toBe('C:\\data\\samples\\guide');
  await user.click(screen.getByRole('button', { name: 'Choose a folder' }));
  await user.click(await screen.findByRole('button', { name: 'Documents' }));
  await screen.findByRole('button', { name: 'Guide' });
  await user.click(screen.getByRole('button', { name: 'Choose folder' }));
  await user.click(screen.getByRole('button', { name: 'Create the project only' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x'));
  expect(commands().filter(request => request.url === '/api/projects/from-template')).toEqual([
    {
      url: '/api/projects/from-template',
      method: 'POST',
      body: { template: 'writing', name: 'Guide', cli: 'claude', location: 'C:\\Users\\eli\\Documents' },
    },
  ]);
});

test('a refused sample keeps the page and says why', async () => {
  controller.command = () => {
    throw new Error('Choose a distinct project name.');
  };
  const user = userEvent.setup();
  open('/?template=code');
  await user.click(await screen.findByRole('button', { name: 'Create the project only' }));
  expect(await screen.findByText('Choose a distinct project name.')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Here’s your sample project.' })).toBeTruthy();
});

test('Something else opens Create a project, as the rail’s Add a project does', async () => {
  const user = userEvent.setup();
  open('/');
  const own = await screen.findByRole('article', { name: 'Something else' });
  await user.click(within(own).getByRole('button', { name: 'Add a project' }));
  expect(await screen.findByRole('dialog', { name: 'Create a project' })).toBeTruthy();
});

test('deleting the last project asks for its name, then No projects yet opens', async () => {
  controller.shell.projects = [{ id: 'project-x', name: 'Project X' }];
  controller.command = url => {
    if (url !== '/api/projects/project-x/delete') return {};
    controller.shell.projects = [];
    controller.templates = templates({ firstRun: false });
    return { deleted: 'project-x', folderRemoved: true };
  };
  const user = userEvent.setup();
  // From the home page, which keeps the project list it read: after the delete it must not open the project again.
  const router = open('/');
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x'));
  await router.navigate({ to: '/p/$projectId/settings', params: { projectId: 'project-x' } });
  await user.click(await screen.findByRole('button', { name: 'Delete project' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Delete Project X?' }));
  const remove = dialog.getByRole('button', { name: 'Delete project' }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  await user.type(dialog.getByLabelText(/to confirm/), 'Project');
  expect(remove.disabled).toBe(true);
  await user.type(dialog.getByLabelText(/to confirm/), ' X');
  expect(remove.disabled).toBe(false);
  await user.click(remove);
  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  expect(commands()).toEqual([
    {
      url: '/api/projects/project-x/delete',
      method: 'POST',
      body: { projectId: 'project-x', name: 'Project X' },
    },
  ]);
  expect(await screen.findByRole('heading', { level: 1, name: 'There are no projects right now.' })).toBeTruthy();
});

test('a refused delete stays open and says why', async () => {
  controller.command = () => {
    throw new Error('Pause the project and wait: story 2 is still running.');
  };
  const user = userEvent.setup();
  open('/p/project-x/settings');
  await user.click(await screen.findByRole('button', { name: 'Delete project' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Delete Project X?' }));
  await user.type(dialog.getByLabelText(/to confirm/), 'Project X');
  await user.click(dialog.getByRole('button', { name: 'Delete project' }));
  expect((await dialog.findByRole('alert')).textContent).toBe('Pause the project and wait: story 2 is still running.');
});
