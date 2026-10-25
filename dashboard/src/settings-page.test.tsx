// Settings in the new dashboard (v1.0 item 19c): the hub and the pages it opens, each reading only what it
// shows, with the current dashboard's settings and actions.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell = {
    ...controller.shell,
    teams: [
      {
        id: 'engineering',
        name: 'Engineering',
        mark: 'EN',
        purpose: 'Build the product.',
        goal: 'Ship the release.',
        outcome: 'A release.',
        leadId: 'W-1',
        goalTaskIds: ['T-goal', 'T-open'],
      },
    ],
    workers: [
      {
        id: 'W-1',
        displayName: 'Eli',
        jobTitle: 'Engineer',
        team: 'Engineering',
        teamId: 'engineering',
        responsibility: 'Writes the code.',
        provider: 'codex',
        model: '',
        enabled: true,
        configVersion: 4,
      },
    ],
    employeeDirectory: [
      { id: 'W-1', displayName: 'Eli', provider: 'codex', enabled: true },
      { id: 'W-2', displayName: 'Ana', provider: 'claude', enabled: true },
    ],
    adapters: {
      codex: {
        id: 'codex',
        name: 'Codex CLI',
        available: true,
        subscription: true,
        quotaLabel: 'Codex',
        workerSelectable: true,
        models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'] }],
        efforts: ['low', 'medium', 'high'],
        modes: ['workspace', 'text'],
      },
      claude: { id: 'claude', name: 'Claude Code CLI', available: true, workerSelectable: true, modes: ['workspace'] },
    },
    taskKinds: {
      general: { label: 'General task', available: true },
      'studio-development:change': {
        label: 'Code change',
        available: true,
        scopeRequestLabel: 'Apply file requests',
        integrationLabel: 'Integrate after a passing review',
      },
      layout: { label: 'Layout', available: false },
    },
    autonomy: {
      policy: { enabled: false, revision: 6, retries: 0, kinds: {}, cycle: { enabled: false } },
      recommended: { general: { approve: 'auto', accept: 'auto' } },
    },
    organizationConfiguration: {
      revision: 2,
      teams: [{ id: 'engineering', name: 'Engineering', mark: 'EN', purpose: 'Build the product.', goalTaskIds: [] }],
      members: [{ workerId: 'W-1', teamId: 'engineering', role: 'Engineer', responsibility: 'Writes the code.' }],
      taskKinds: ['general'],
      kindOwners: {},
      tiers: {},
    },
    runtime: { version: 'test', dataDirectory: 'C:/studio/data' },
  };
  controller.tasks = [
    taskFixture('T-open', { title: 'Open work', status: 'ready' }),
    taskFixture('T-review', { title: 'Work to review', status: 'review' }),
  ];
  controller.people = {
    tasks: 5,
    accepted: { total: 3, workers: { 'W-1': 3 }, teams: { Engineering: 3 } },
    goals: { 'T-goal': taskFixture('T-goal', { title: 'Goal work', status: 'done' }) },
  };
  controller.settled.accepted = [
    { tasks: [taskFixture('T-done', { title: 'Accepted work', status: 'done' })], attempts: [], next: null },
  ];
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
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
const commands = () => controller.requests.filter(request => request.method !== 'GET');

test('Settings links the records it keeps elsewhere and changes where candidate tests run only after a confirmation', async () => {
  const user = userEvent.setup(),
    confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  open('/p/project-x/settings');
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  // Its sections, This project then Every project, each in the section nav.
  expect(
    within(screen.getByRole('navigation', { name: 'Settings sections' }))
      .getAllByRole('link')
      .map(link => link.textContent),
  ).toEqual([
    'General',
    'Repository',
    'House rules',
    'Workflows',
    'Records',
    'Running work',
    'Command-line tools',
    'Projects',
    'Appearance',
  ]);
  const links = Object.fromEntries(
    ['Open the log', 'Teams', 'Platform map'].map(name => [
      name,
      within(screen.getByRole('region', { name: 'Records' }))
        .getByRole('link', { name })
        .getAttribute('href'),
    ]),
  );
  expect(links).toEqual({
    'Open the log': '/p/project-x/settings/activity',
    Teams: '/p/project-x/agents/teams',
    'Platform map': '/p/project-x/settings/platform',
  });
  const tests = within(screen.getByRole('group', { name: 'Where candidate tests run' }));
  await user.click(tests.getByRole('button', { name: 'No sandbox' }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(commands()).toEqual([]);
  confirm.mockReturnValue(true);
  await user.click(tests.getByRole('button', { name: 'No sandbox' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      { url: '/api/control', method: 'POST', body: { projectId: 'project-x', testSandbox: 'none' } },
    ]),
  );
  // Settings reads the shell and the live set: no instructions or history.
  expect([...new Set(controller.reads())].sort()).toEqual([
    '/api/projects/project-x/live',
    '/api/projects/project-x/shell',
  ]);
});

test('with only Claude Code, Settings never mentions Codex and says the candidate tests run on this computer (v1.0 item 25)', async () => {
  controller.shell = {
    ...controller.shell,
    testSandbox: 'none',
    adapters: {
      codex: { ...controller.shell.adapters!.codex!, available: false },
      claude: { id: 'claude', name: 'Claude Code CLI', available: true, subscription: true, modes: ['workspace'] },
    },
  };
  open('/p/project-x/settings');
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  const tools = screen.getByRole('region', { name: 'Command-line tools' });
  expect(within(tools).getByText('Claude Code CLI')).toBeTruthy();
  expect(tools.textContent).not.toMatch(/codex/i);
  expect(within(tools).queryByRole('group', { name: 'Where candidate tests run' })).toBeNull();
  expect(within(tools).getByText(/^On this computer, without a sandbox: code an agent wrote runs/)).toBeTruthy();
});

test("the project's name, goal and direction save against the revision they were read at", async () => {
  const user = userEvent.setup();
  controller.shell = {
    ...controller.shell,
    project: { ...controller.shell.project, goal: 'Ship it.', direction: 'Small steps.', revision: 3 },
  };
  open('/p/project-x/settings');
  const goal = await screen.findByLabelText('Goal');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(goal);
  await user.type(goal, 'Ship it well.');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]).toEqual({
    url: '/api/projects/project-x',
    method: 'PATCH',
    body: {
      projectId: 'project-x',
      expectedRevision: 3,
      name: controller.shell.project.name,
      goal: 'Ship it well.',
      direction: 'Small steps.',
      color: null,
    },
  });
});

test("the project's color is chosen from the palette and saved with the section", async () => {
  const user = userEvent.setup();
  open('/p/project-x/settings');
  const colors = within(await screen.findByRole('group', { name: 'Color' }));
  // Without a choice, the project shows the color its place gives it: the first project's violet.
  expect(colors.getByRole('button', { name: 'Violet' }).getAttribute('aria-pressed')).toBe('true');
  await user.click(colors.getByRole('button', { name: 'Sky' }));
  expect(colors.getByRole('button', { name: 'Sky' }).getAttribute('aria-pressed')).toBe('true');
  expect(colors.getByRole('button', { name: 'Violet' }).getAttribute('aria-pressed')).toBe('false');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]).toMatchObject({ url: '/api/projects/project-x', method: 'PATCH', body: { color: 'sky' } });
});

test('attempts at the same time step between one and the agents on this computer', async () => {
  const user = userEvent.setup();
  controller.shell = { ...controller.shell, maxParallel: 2 };
  open('/p/project-x/settings');
  const stepper = within(await screen.findByRole('group', { name: 'Attempts at the same time' }));
  // Two agents on this computer, each one attempt at a time: two is the most.
  expect((stepper.getByRole('button', { name: 'More' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(stepper.getByRole('button', { name: 'Fewer' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      { url: '/api/control', method: 'POST', body: { projectId: 'project-x', maxParallel: 1 } },
    ]),
  );
});

test("a repository's settings are checked again and edited, and saving runs its tests", async () => {
  const user = userEvent.setup(),
    profile = {
      id: 'site',
      directories: ['lib', 'tests'],
      files: ['README.md'],
      extensions: ['mjs', 'svg'],
      protectedNames: ['AGENTS.md'],
      contextFiles: ['README.md'],
      tests: { directory: 'tests', suffix: '.test.mjs' },
      formatter: null,
      install: null,
      limits: { files: 500, fileBytes: 1048576, totalBytes: 16777216 },
    };
  controller.shell = {
    ...controller.shell,
    project: { ...controller.shell.project, source: { root: 'C:/work/site', profile, revision: 2 } },
  };
  controller.command = url => {
    if (url.endsWith('/source/inspect'))
      return {
        root: 'C:/work/site',
        branch: 'main',
        head: 'abc1234',
        profile,
        clean: true,
        problems: [],
        testFiles: 3,
      };
    if (url.endsWith('/source'))
      throw new Error("The repository's tests must pass before these settings are saved: 2 of 3 passed.");
    return {};
  };
  open('/p/project-x/settings');
  expect(await screen.findByText('settings revision 2')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('Clean · 3 test files')).toBeTruthy();
  expect(screen.getByText('main')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Edit the repository settings' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Edit the repository settings' }));
  await user.type(dialog.getByLabelText('Read by the planner and reviews'), 'docs/notes.md{Enter}');
  // A file type typed with its dot is the type alone.
  await user.type(dialog.getByLabelText('File types'), '.css,');
  await user.click(dialog.getByRole('button', { name: 'Remove .svg' }));
  await user.click(dialog.getByRole('switch', { name: 'Install packages with npm ci before tests' }));
  await user.click(dialog.getByRole('button', { name: 'Run the tests and save' }));
  // A refusal stays in the dialog, so the edits are not lost.
  expect((await dialog.findByRole('alert')).textContent).toMatch(/tests must pass before these settings are saved/);
  expect(commands().at(-1)).toEqual({
    url: '/api/projects/project-x/source',
    method: 'POST',
    body: {
      projectId: 'project-x',
      expectedRevision: 2,
      profile: {
        ...profile,
        contextFiles: ['README.md', 'docs/notes.md'],
        extensions: ['mjs', 'css'],
        install: 'npm-ci',
      },
    },
  });
});

test('the appearance is kept in this browser and applied at once', async () => {
  const user = userEvent.setup();
  open('/p/project-x/settings');
  const theme = within(await screen.findByRole('group', { name: 'Theme' }));
  await user.click(theme.getByRole('button', { name: 'Dark' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem('studio-theme')).toBe('dark');
  await user.click(theme.getByRole('button', { name: 'System' }));
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(localStorage.getItem('studio-theme')).toBeNull();
});

test('the house rules switch a gate between you and the studio, and save against the revision they read', async () => {
  const user = userEvent.setup();
  open('/p/project-x/settings');
  const table = within(await screen.findByRole('table'));
  // Each available task type is a row; a step a type does not have is not a cell to switch.
  expect(table.getAllByRole('rowheader').map(row => row.textContent)).toEqual(['Build a story', 'General work']);
  expect(table.getByLabelText('General work, extra files: does not apply')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save house rules' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Use recommended' }));
  expect(
    screen.getByRole('switch', { name: 'The studio takes the steps marked Studio' }).getAttribute('aria-checked'),
  ).toBe('true');
  await user.click(table.getByRole('button', { name: 'Build a story, integrate: you' }));
  expect(table.getByRole('button', { name: 'Build a story, integrate: the studio' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save house rules' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]).toEqual({
    url: '/api/projects/project-x/autonomy',
    method: 'POST',
    body: {
      projectId: 'project-x',
      expectedRevision: 6,
      enabled: true,
      retries: 1,
      kinds: {
        'studio-development:change': { approve: 'director', accept: 'director', scope: 'director', integrate: 'auto' },
        general: { approve: 'auto', accept: 'auto' },
      },
      cycle: { enabled: false },
    },
  });
});

test('instructions load only on their page, a draft keeps its text through a refresh, and Publish saves it first', async () => {
  const user = userEvent.setup();
  controller.instructions.teams.engineering = {
    scope: 'team',
    id: 'engineering',
    revision: 3,
    text: 'Team direction.',
    draft: null,
    history: [{ revision: 2, note: 'Earlier', text: 'Older team direction.' }],
  };
  open('/p/project-x/agents/instructions');
  // The list names each set of instructions; the project's opens first.
  const list = within(await screen.findByRole('navigation', { name: 'Instructions' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'What every agent in Project X is told' })).toBeTruthy();
  await user.click(list.getByRole('link', { name: /Engineering/ }));
  expect(await screen.findByRole('heading', { level: 2, name: 'What the Engineering team is told' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  const draft = screen.getByLabelText('The draft');
  await user.clear(draft);
  await user.type(draft, 'New team direction.');
  // Someone else's change refreshes the records; what the director typed stays.
  latest().emit('change', { version: 1, start: 'start-a', changes: [{ seq: 1, type: 'organization' }] });
  await waitFor(() => expect(controller.reads().filter(url => url.endsWith('/instructions'))).toHaveLength(2));
  expect((screen.getByLabelText('The draft') as HTMLTextAreaElement).value).toBe('New team direction.');
  await user.type(screen.getByLabelText('What changed, for the history'), 'Clearer');
  // Publishing saves the text as the draft first, then publishes that draft.
  await user.click(screen.getByRole('button', { name: 'Publish revision 4' }));
  await waitFor(() => expect(commands()).toHaveLength(2));
  expect(commands()).toEqual([
    {
      url: '/api/instructions/team/engineering/draft',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 3, text: 'New team direction.' },
    },
    {
      url: '/api/instructions/team/engineering/publish',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 3, text: 'New team direction.', note: 'Clearer' },
    },
  ]);
});

test('a saved draft waits beside what is published, and an earlier revision can start a new one', async () => {
  const user = userEvent.setup();
  controller.instructions.employees['W-1'] = {
    scope: 'employee',
    id: 'W-1',
    revision: 2,
    text: 'Build carefully.',
    draft: { text: 'Build carefully, and name blocked commands.' },
    history: [
      { revision: 1, note: 'First', text: 'Build.' },
      { revision: 2, note: 'Second', text: 'Build carefully.' },
    ],
  };
  open('/p/project-x/agents/instructions?open=agent:W-1');
  expect(await screen.findByRole('heading', { level: 2, name: 'What Eli is told' })).toBeTruthy();
  expect(screen.getByText('Build carefully, and name blocked commands.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Discard the draft' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      {
        url: '/api/instructions/employee/W-1/discard',
        method: 'POST',
        body: { projectId: 'project-x', baseRevision: 2 },
      },
    ]),
  );
  await user.click(screen.getByText('1 earlier revision'));
  await user.click(screen.getByRole('button', { name: 'Start a draft from it' }));
  expect((screen.getByLabelText('The draft') as HTMLTextAreaElement).value).toBe('Build.');
});

test('a team links straight to its instructions, and the link opens them', async () => {
  controller.instructions.teams.engineering = {
    scope: 'team',
    id: 'engineering',
    revision: 1,
    text: 'Team direction.',
    draft: null,
    history: [],
  };
  open('/p/project-x/agents/teams');
  const card = within((await screen.findByRole('link', { name: 'Engineering' })).closest('article')!);
  expect(card.getByRole('link', { name: 'What the team is told' }).getAttribute('href')).toBe(
    '/p/project-x/agents/instructions?open=team%3Aengineering',
  );
  cleanup();
  open('/p/project-x/agents/instructions?open=team:engineering');
  expect(await screen.findByRole('heading', { level: 2, name: 'What the Engineering team is told' })).toBeTruthy();
});

test('teams show their goal from the whole history, their agents and their open work', async () => {
  open('/p/project-x/agents/teams');
  const card = within((await screen.findByRole('link', { name: 'Engineering' })).closest('article')!);
  expect(card.getByText('Ship the release.')).toBeTruthy();
  expect(card.getByText("1 of 2 of its goal's work accepted")).toBeTruthy();
  expect(card.getByRole('link', { name: /Eli/ }).getAttribute('href')).toBe('/p/project-x/agents/W-1');
  expect(card.getByText('Led by Eli')).toBeTruthy();
  // A team's page lists its open work and reads only its own accepted work.
  cleanup();
  open('/p/project-x/agents/teams/engineering');
  expect(await screen.findByRole('heading', { level: 1, name: /Engineering/ })).toBeTruthy();
  await waitFor(() => expect(screen.getByText('Accepted work')).toBeTruthy());
  expect(controller.reads()).toContain('/api/projects/project-x/settled?kind=accepted&limit=12&team=Engineering');
});

test('Edit the teams turns the cards into fields and sends only the members placed in a team, with their staffing roles', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/teams');
  await user.click(await screen.findByRole('button', { name: 'Edit the teams' }));
  // The same page, editing in place: the team's card is its fields, and an agent's part opens from its face.
  const card = within(await screen.findByRole('region', { name: 'Engineering' }));
  expect((card.getByLabelText('Team name') as HTMLInputElement).value).toBe('Engineering');
  expect((card.getByLabelText('Purpose') as HTMLTextAreaElement).value).toBe('Build the product.');
  await user.click(card.getByRole('button', { name: /^Eli/ }));
  const part = within(await screen.findByRole('dialog', { name: 'Eli in Engineering' }));
  await user.type(part.getByLabelText('Staffing roles'), 'reviewer, engineer, reviewer');
  await user.click(part.getByRole('button', { name: 'Done' }));
  await user.click(screen.getByRole('button', { name: 'Save the teams' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const [command] = commands();
  expect(command!.url).toBe('/api/projects/project-x/organization');
  expect(command!.method).toBe('PATCH');
  expect(command!.body).toMatchObject({
    projectId: 'project-x',
    expectedRevision: 2,
    members: [
      {
        workerId: 'W-1',
        teamId: 'engineering',
        role: 'Engineer',
        responsibility: 'Writes the code.',
        roles: ['reviewer', 'engineer'],
      },
    ],
    taskKinds: ['general'],
    tiers: {},
  });
  // Saved, the page shows the teams again.
  expect(await screen.findByRole('button', { name: 'Edit the teams' })).toBeTruthy();
});

test('a new team takes an agent the studio already has, and an agent taken out of the project stops owning work', async () => {
  const user = userEvent.setup();
  controller.shell = {
    ...controller.shell,
    organizationConfiguration: {
      ...controller.shell.organizationConfiguration,
      kindOwners: { general: 'W-1' },
    },
  };
  open('/p/project-x/agents/teams');
  await user.click(await screen.findByRole('button', { name: 'Edit the teams' }));
  expect(((await screen.findByLabelText('Who does General task')) as HTMLSelectElement).value).toBe('W-1');
  await user.click(screen.getByRole('button', { name: 'Add a team' }));
  const fresh = within(screen.getByRole('region', { name: 'New team' }));
  // The new team's name takes the cursor.
  expect(document.activeElement).toBe(fresh.getByLabelText('Team name'));
  await user.type(fresh.getByLabelText('Team name'), 'Docs');
  await user.click(screen.getByRole('button', { name: 'Add an agent to Docs' }));
  const picker = within(await screen.findByRole('dialog', { name: 'Add an agent to Docs' }));
  expect(picker.getByRole('button', { name: /Eli/ }).textContent).toContain('Moves from Engineering');
  await user.click(picker.getByRole('button', { name: /Ana/ }));
  const docs = within(screen.getByRole('region', { name: 'Docs' }));
  await user.selectOptions(docs.getByLabelText('Lead'), 'W-2');
  // Eli leaves the project, so General task goes back to being chosen each time.
  await user.click(screen.getByRole('button', { name: 'Take Eli off Engineering' }));
  expect((screen.getByLabelText('Who does General task') as HTMLSelectElement).value).toBe('');
  await user.click(screen.getByRole('button', { name: 'Save the teams' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const [command] = commands(),
    body = command!.body as { teams: { id: string }[] };
  expect(body).toMatchObject({
    expectedRevision: 2,
    teams: [
      { id: 'engineering', name: 'Engineering', leadId: null },
      { name: 'Docs', mark: '', purpose: '', leadId: 'W-2' },
    ],
    members: [
      {
        workerId: 'W-2',
        teamId: body.teams[1]!.id,
        role: 'Project contributor',
        responsibility: 'Perform bounded project work and submit evidence for director review.',
        roles: [],
      },
    ],
    taskKinds: ['general'],
    kindOwners: {},
  });
});

test('Add an agent opens the teams to edit, Cancel leaves them as they were, and a team page opens them too', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents/W-1');
  await user.click(await screen.findByRole('link', { name: 'Add an agent' }));
  expect(await screen.findByRole('form', { name: 'Edit the teams' })).toBeTruthy();
  expect(router.state.location.search).toEqual({ edit: true });
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('button', { name: 'Edit the teams' })).toBeTruthy();
  expect(router.state.location.search).toEqual({});
  expect(commands()).toEqual([]);
  cleanup();
  open('/p/project-x/agents/teams/engineering');
  expect((await screen.findByRole('link', { name: 'Edit the teams' })).getAttribute('href')).toBe(
    '/p/project-x/agents/teams?edit=true',
  );
});

test("an agent's page saves how it runs for future runs and reads only that agent's accepted work", async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1');
  expect(await screen.findByRole('heading', { level: 2, name: 'Eli' })).toBeTruthy();
  // The agents are listed beside the one chosen.
  const list = within(screen.getByRole('navigation', { name: 'Agents' }));
  expect(list.getByRole('link', { name: /Eli/ }).getAttribute('aria-current')).toBe('page');
  await waitFor(() => expect(screen.getByText('Delivered lately')).toBeTruthy());
  expect(controller.reads()).toContain('/api/projects/project-x/settled?kind=accepted&limit=12&workerId=W-1');
  await user.click(screen.getByRole('button', { name: 'Change how Eli runs' }));
  // Text mode does not ship in 1.0.0, so a CLI that also has it offers no choice of mode (the director, October 25).
  expect(screen.queryByLabelText('Mode')).toBeNull();
  await user.type(screen.getByLabelText('Model'), 'gpt-5');
  await user.selectOptions(screen.getByLabelText('Effort'), 'high');
  await user.click(screen.getByRole('button', { name: 'Save for future runs' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      {
        url: '/api/workers/W-1',
        method: 'PATCH',
        body: {
          projectId: 'project-x',
          provider: 'codex',
          model: 'gpt-5',
          effort: 'high',
          mode: '',
          paused: false,
          expectedVersion: 4,
        },
      },
    ]),
  );
});

test("an agent's face is chosen part by part and stored on the agent", async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1');
  await user.click(await screen.findByRole('button', { name: "Change Eli's face" }));
  const dialog = within(await screen.findByRole('dialog', { name: "Eli's face" }));
  // Eli has no face of its own yet, so there is no picked face to go back to, and nothing to save until a part changes.
  expect(dialog.queryByRole('button', { name: 'Use the picked face' })).toBeNull();
  expect((dialog.getByRole('button', { name: 'Save the face' }) as HTMLButtonElement).disabled).toBe(true);
  const colors = within(dialog.getByRole('radiogroup', { name: 'Color · 10' }));
  expect(colors.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true');
  await user.click(colors.getByRole('radio', { name: 'Sky' }));
  await user.click(
    within(dialog.getByRole('radiogroup', { name: 'Topper · 10' })).getByRole('radio', { name: 'None' }),
  );
  await user.click(dialog.getByRole('button', { name: 'Show: Working' }));
  expect(dialog.getByRole('button', { name: 'Show: Talking' })).toBeTruthy();
  await user.click(dialog.getByRole('button', { name: 'Save the face' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      {
        url: '/api/workers/W-1/look',
        method: 'POST',
        body: { projectId: 'project-x', look: { body: 1, color: 5, eyes: 1, mouth: 1, top: 0, detail: 0 } },
      },
    ]),
  );
});

test("an agent with a face of its own can have the studio's pick back", async () => {
  const user = userEvent.setup();
  controller.shell = {
    ...controller.shell,
    workers: controller.shell.workers.map(worker => ({
      ...worker,
      look: { body: 4, color: 7, eyes: 2, mouth: 3, top: 5, detail: 6 },
    })),
  };
  open('/p/project-x/agents/W-1');
  await user.click(await screen.findByRole('button', { name: "Change Eli's face" }));
  const dialog = within(await screen.findByRole('dialog', { name: "Eli's face" }));
  expect(
    within(dialog.getByRole('radiogroup', { name: 'Color · 10' }))
      .getByRole('radio', { name: 'Lime' })
      .getAttribute('aria-checked'),
  ).toBe('true');
  await user.click(dialog.getByRole('button', { name: 'Use the picked face' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      { url: '/api/workers/W-1/look', method: 'POST', body: { projectId: 'project-x', look: null } },
    ]),
  );
});

test('the old overview and setup addresses lead to Today and Settings', async () => {
  let router = open('/p/project-x/settings/overview');
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x'));
  cleanup();
  router = open('/p/project-x/settings/setup');
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/settings'));
});

test('the activity log reads recorded events a page at a time', async () => {
  const user = userEvent.setup();
  const event = (seq: number) => ({
    seq,
    time: '2026-10-22T12:00:00Z',
    kind: 'task_created',
    message: `Event ${seq}`,
    task_id: seq === 9 ? 'T-open' : null,
    attempt_id: null,
  });
  // An attempt's phases are structured records for its trace, never a sentence in the log.
  const phase = { ...event(7), kind: 'phase', message: '{"schemaVersion":"source-phase-v1","phaseId":"tests"}' };
  controller.activity = [
    { events: [event(9), phase, event(8)], next: 8 },
    { events: [event(3)], next: null },
  ];
  open('/p/project-x/settings/activity');
  expect(await screen.findByText('Event 9')).toBeTruthy();
  expect(screen.queryByText(/schemaVersion/)).toBeNull();
  expect(screen.getByRole('link', { name: 'T-open' }).getAttribute('href')).toBe('/p/project-x/tasks/T-open');
  await user.click(screen.getByRole('button', { name: 'Show older events' }));
  expect(await screen.findByText('Event 3')).toBeTruthy();
  expect(controller.reads().filter(url => url.includes('/activity'))).toEqual([
    '/api/projects/project-x/activity',
    '/api/projects/project-x/activity?before=8',
  ]);
  expect(screen.queryByRole('button', { name: 'Show older events' })).toBeNull();
});

test("Studio desk's own development is offered only where the controller develops a separate copy", async () => {
  // An installed copy develops itself, so it is not offered there, nor when the controller does not say.
  for (const selfHosted of [true, undefined]) {
    controller.shell.autonomy = { ...controller.shell.autonomy!, selfHosted };
    open('/p/project-x/settings');
    expect(await screen.findByText('Add a project')).toBeTruthy();
    expect(screen.queryByText("Studio desk's own development")).toBeNull();
    cleanup();
  }
  // A stable copy set up by npm run setup-stable develops the development copy.
  controller.shell.autonomy = { ...controller.shell.autonomy!, selfHosted: false };
  open('/p/project-x/settings');
  expect(await screen.findByText("Studio desk's own development")).toBeTruthy();
});

test('Settings pauses all new work and clears a usage hold for the whole controller', async () => {
  const user = userEvent.setup();
  controller.shell.quota = { codex: true };
  open('/p/project-x/settings');
  await user.click(await screen.findByRole('switch', { name: 'Pause all new work' }));
  await user.click(screen.getByRole('button', { name: 'Clear the hold' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      { url: '/api/control', method: 'POST', body: { projectId: 'project-x', paused: true } },
      { url: '/api/control', method: 'POST', body: { projectId: 'project-x', clearQuota: 'codex' } },
    ]),
  );
});
