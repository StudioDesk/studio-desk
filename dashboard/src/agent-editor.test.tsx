// The picked agent's editor beside the flow: Does, with another kind of work given through the project's whole
// organization; Runs on, saved on the agent or undone; Can use, the approved commands and the visual check; and Is
// told, with its link to the agent's told page. Model-free, with the stand-in controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, toldFixture, type Controller } from './test-controller';

const change = 'studio-development:change',
  review = 'studio-development:change-review';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  const teams = [
    {
      id: 'engineering',
      name: 'Engineering',
      mark: 'EN',
      purpose: 'Build the product.',
      goal: 'Ship the release.',
      outcome: 'A release.',
      leadId: 'W-1',
      goalTaskIds: ['T-goal'],
    },
    { id: 'review', name: 'Review', mark: 'RV', purpose: 'Check the product.', leadId: 'W-2', goalTaskIds: [] },
  ];
  controller.shell = {
    ...controller.shell,
    teams,
    workers: [
      {
        id: 'W-1',
        displayName: 'Eli',
        jobTitle: 'Engineer',
        team: 'Engineering',
        teamId: 'engineering',
        provider: 'codex',
        model: '',
        enabled: true,
        configVersion: 4,
      },
      {
        id: 'W-2',
        displayName: 'Ana',
        jobTitle: 'Reviewer',
        team: 'Review',
        teamId: 'review',
        provider: 'claude',
        model: 'opus',
        enabled: true,
        configVersion: 2,
      },
    ],
    employeeDirectory: [],
    adapters: {
      codex: {
        id: 'codex',
        name: 'Codex CLI',
        available: true,
        workerSelectable: true,
        models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'] }],
        efforts: ['low', 'medium', 'high'],
        modes: ['workspace'],
      },
      claude: { id: 'claude', name: 'Claude Code CLI', available: true, workerSelectable: true, modes: ['workspace'] },
    },
    taskKinds: {
      general: { label: 'General task', available: true },
      [change]: { label: 'Code change', available: true },
      [review]: { label: 'Code review', available: true },
      layout: { label: 'Layout', available: false },
    },
    agentPermissions: { auto: false, commands: ['node --test', 'npm run format'] },
    organizationConfiguration: {
      revision: 3,
      teams,
      members: [
        {
          workerId: 'W-1',
          teamId: 'engineering',
          role: 'Engineer',
          responsibility: 'Writes the code.',
          roles: ['engineer'],
        },
        {
          workerId: 'W-2',
          teamId: 'review',
          role: 'Reviewer',
          responsibility: 'Reviews the code.',
          roles: ['reviewer'],
        },
      ],
      taskKinds: ['general', change, review],
      kindOwners: { [change]: 'W-1', general: 'W-1', [review]: 'W-2' },
      tiers: { deep: { codex: { model: 'gpt-5' } } },
    },
  };
});
afterEach(() => cleanup());

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
const items = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map(item => item.textContent);

test('picking an agent opens its editor beside the flow, its four sections above its work, and no dialog', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents/W-1');
  const flow = await screen.findByRole('list', { name: 'How the work flows' });
  await user.click(within(flow).getByRole('link', { name: /^Ana/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents/W-2'));
  expect(await screen.findByRole('heading', { level: 2, name: 'Ana' })).toBeTruthy();
  const editor = ['Does', 'Runs on', 'Can use', 'Is told', "Ana's work", 'Running now', 'Recent runs'];
  expect(
    screen
      .getAllByRole('heading', { level: 2 })
      .map(heading => heading.textContent)
      .filter(name => editor.includes(name!)),
  ).toEqual(editor);
  // Beside the flow, not in it, and nothing opens over the page.
  const does = screen.getByRole('region', { name: 'Does' });
  expect(flow.contains(does)).toBe(false);
  expect(does.closest('.sd-agents')).toBe(flow.closest('.sd-agents'));
  expect(screen.queryByRole('dialog')).toBeNull();
  // The editor's sections take the place of the old cards and their links.
  expect(screen.queryByRole('button', { name: /^Change how/ })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Read and edit' })).toBeNull();
  expect(commands()).toEqual([]);
});

test('Does lists its kinds, and a kind the project does not take is given with the whole organization', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1');
  const does = within(await screen.findByRole('region', { name: 'Does' }));
  expect(items(does.getByRole('list', { name: 'What Eli does' }))).toEqual(['Code change', 'General task']);
  // Every registered kind Eli does not do is offered, the one Ana does and the one the project does not take yet.
  const picker = does.getByLabelText('Give it another kind of work') as HTMLSelectElement;
  expect([...picker.options].map(option => option.textContent)).toEqual([
    'Choose a kind of work',
    'Code review · Ana does it now',
    'Layout · not taken yet',
  ]);
  expect(
    does.getByText('A kind another agent does moves to Eli. Work that starts after you save goes to Eli.'),
  ).toBeTruthy();
  await user.selectOptions(picker, review);
  expect(does.getByText('Ana does Code review now; it moves to Eli.')).toBeTruthy();
  await user.selectOptions(picker, 'layout');
  expect(
    does.getByText('Project X does not take Layout yet; it takes it from now on, with Eli doing it.'),
  ).toBeTruthy();
  expect(commands()).toEqual([]);
  await user.click(does.getByRole('button', { name: 'Give it to Eli' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const [command] = commands();
  expect(command).toEqual({
    url: '/api/projects/project-x/organization',
    method: 'PATCH',
    body: {
      projectId: 'project-x',
      expectedRevision: 3,
      // The teams' own fields, without the goal work the controller keeps.
      teams: [
        {
          id: 'engineering',
          name: 'Engineering',
          mark: 'EN',
          purpose: 'Build the product.',
          goal: 'Ship the release.',
          outcome: 'A release.',
          leadId: 'W-1',
        },
        { id: 'review', name: 'Review', mark: 'RV', purpose: 'Check the product.', leadId: 'W-2' },
      ],
      members: [
        {
          workerId: 'W-1',
          teamId: 'engineering',
          role: 'Engineer',
          responsibility: 'Writes the code.',
          roles: ['engineer'],
        },
        {
          workerId: 'W-2',
          teamId: 'review',
          role: 'Reviewer',
          responsibility: 'Reviews the code.',
          roles: ['reviewer'],
        },
      ],
      taskKinds: ['general', change, review, 'layout'],
      kindOwners: { general: 'W-1', [change]: 'W-1', [review]: 'W-2', layout: 'W-1' },
    },
  });
  // Without tiers, the saved ones stay.
  expect(command!.body).not.toHaveProperty('tiers');
  expect(await screen.findByText('Eli does Layout from now on.')).toBeTruthy();
});

test("Does shows the controller's refusal, and an agent on no team is given no kind", async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw Object.assign(new Error('The organization changed since this page read it.'), { status: 409 });
  };
  open('/p/project-x/agents/W-1');
  const does = within(await screen.findByRole('region', { name: 'Does' }));
  await user.selectOptions(does.getByLabelText('Give it another kind of work'), review);
  await user.click(does.getByRole('button', { name: 'Give it to Eli' }));
  expect(await does.findByRole('alert')).toHaveProperty(
    'textContent',
    'The organization changed since this page read it.',
  );
  cleanup();
  controller.requests = [];
  controller.shell = {
    ...controller.shell,
    organizationConfiguration: {
      ...controller.shell.organizationConfiguration,
      members: controller.shell.organizationConfiguration!.members!.filter(member => member.workerId !== 'W-2'),
    },
  };
  open('/p/project-x/agents/W-2');
  const ana = within(await screen.findByRole('region', { name: 'Does' }));
  expect(ana.getByText("Ana is on none of Project X's teams, so it is given no kind of work of its own.")).toBeTruthy();
  expect(ana.queryByLabelText('Give it another kind of work')).toBeNull();
});

test('Runs on saves for the runs after the save, Undo puts back the saved values without sending, and a refusal shows', async () => {
  const user = userEvent.setup();
  let refuse = true;
  controller.command = () => {
    if (refuse) throw Object.assign(new Error('Eli changed since this page read it.'), { status: 409 });
    return {};
  };
  open('/p/project-x/agents/W-1');
  const runs = within(await screen.findByRole('region', { name: 'Runs on' })),
    model = () => runs.getByLabelText('Model') as HTMLInputElement,
    effort = () => runs.getByLabelText('Effort') as HTMLSelectElement,
    pause = () => runs.getByRole('switch', { name: 'Pause new work for Eli' }),
    button = (name: string) => runs.getByRole('button', { name }) as HTMLButtonElement;
  expect((runs.getByLabelText('CLI') as HTMLSelectElement).value).toBe('codex');
  expect(runs.getByText('Paused, Eli starts no new work; what is running finishes first.')).toBeTruthy();
  expect(runs.getByText(/Save applies to runs that start after it, in every project Eli works in/)).toBeTruthy();
  // Nothing to save or undo until a field changes.
  expect(button('Save').disabled).toBe(true);
  expect(button('Undo').disabled).toBe(true);
  await user.type(model(), 'gpt-5');
  await user.selectOptions(effort(), 'high');
  await user.click(pause());
  expect(pause().getAttribute('aria-checked')).toBe('true');
  await user.click(button('Undo'));
  expect(model().value).toBe('');
  expect(effort().value).toBe('');
  expect(pause().getAttribute('aria-checked')).toBe('false');
  expect(button('Save').disabled).toBe(true);
  expect(commands()).toEqual([]);
  // Refused, the message shows and the edits stay.
  await user.type(model(), 'gpt-5');
  await user.selectOptions(effort(), 'high');
  await user.click(pause());
  await user.click(button('Save'));
  expect(await runs.findByRole('alert')).toHaveProperty('textContent', 'Eli changed since this page read it.');
  expect(model().value).toBe('gpt-5');
  expect(effort().value).toBe('high');
  refuse = false;
  await user.click(button('Save'));
  const sent = {
    url: '/api/workers/W-1',
    method: 'PATCH',
    body: {
      projectId: 'project-x',
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      mode: '',
      paused: true,
      expectedVersion: 4,
    },
  };
  await waitFor(() => expect(commands()).toEqual([sent, sent]));
  expect(await screen.findByText('Saved for runs that start from now.')).toBeTruthy();
  expect(runs.queryByRole('alert')).toBeNull();
});

test('Can use lists the approved commands or auto mode for a Claude Code agent, and the visual check', async () => {
  controller.visualView = {
    ...controller.visualView,
    settings: { ...controller.visualView.settings, enabled: true },
  };
  open('/p/project-x/agents/W-2');
  let can = within(await screen.findByRole('region', { name: 'Can use' }));
  expect(items(can.getByRole('list', { name: 'Approved commands' }))).toEqual(['node --test', 'npm run format']);
  expect(
    await can.findByText(
      "The visual check is on: before a story's review, the pages it names are captured for the reviewer.",
    ),
  ).toBeTruthy();
  expect(controller.reads()).toContain('/api/projects/project-x/visual-check');
  expect(can.getByText(/^Tools come later/)).toBeTruthy();
  cleanup();

  // In auto mode, Claude Code's classifier decides, and a Codex agent has no approved commands to list.
  controller.shell = { ...controller.shell, agentPermissions: { auto: true, commands: ['node --test'] } };
  controller.visualView = {
    ...controller.visualView,
    settings: { ...controller.visualView.settings, enabled: false },
  };
  open('/p/project-x/agents/W-2');
  can = within(await screen.findByRole('region', { name: 'Can use' }));
  expect(can.getByText("Auto mode: Claude Code's own classifier decides which commands Ana runs.")).toBeTruthy();
  expect(can.queryByRole('list', { name: 'Approved commands' })).toBeNull();
  expect(await can.findByText('The visual check is off.')).toBeTruthy();
  cleanup();
  open('/p/project-x/agents/W-1');
  can = within(await screen.findByRole('region', { name: 'Can use' }));
  expect(can.queryByText(/Approved commands|Auto mode/)).toBeNull();
  expect(can.getByText(/^Tools come later/)).toBeTruthy();
  cleanup();

  // A project that is not on a git repository has no visual check to read.
  controller.requests = [];
  controller.shell = {
    ...controller.shell,
    organizationConfiguration: { ...controller.shell.organizationConfiguration, taskKinds: ['general'] },
  };
  open('/p/project-x/agents/W-2');
  can = within(await screen.findByRole('region', { name: 'Can use' }));
  expect(can.queryByText(/visual check/)).toBeNull();
  expect(controller.reads()).not.toContain('/api/projects/project-x/visual-check');
});

test("Is told shows its own revision, the three sets' counts and its own rules' names, and opens what it is told", async () => {
  const user = userEvent.setup();
  const eli = toldFixture('W-1');
  eli.layers = eli.layers.map(layer => (layer.layer === 'own' ? { ...layer, revision: 3 } : layer));
  controller.told['W-1'] = eli;
  const router = open('/p/project-x/agents/W-1');
  const told = within(await screen.findByRole('region', { name: 'Is told' }));
  expect(await told.findByText('revision 3')).toBeTruthy();
  expect(
    within(told.getByRole('list', { name: 'How many rules Eli reads' }))
      .getAllByRole('listitem')
      .map(item => [item.firstChild?.textContent, item.lastChild?.textContent]),
  ).toEqual([
    ["The project's rules", '1 rule'],
    ["Engineering's rules", '1 rule'],
    ["Eli's own rules", '2 rules'],
  ]);
  // A rule without a name reads as its first words.
  expect(items(told.getByRole('list', { name: "Eli's own rules" }))).toEqual([
    'Stay inside the story',
    'Ask the director when a choice is not…',
  ]);
  const link = told.getByRole('link', { name: 'Open what it is told' });
  expect(link.getAttribute('href')).toBe('/p/project-x/agents/W-1/told');
  await user.click(link);
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents/W-1/told'));
  expect(await screen.findByRole('heading', { level: 1, name: 'What Eli is told' })).toBeTruthy();
  expect(commands()).toEqual([]);
});
