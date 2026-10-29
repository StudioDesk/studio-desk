// Edit the team beside the flow: what it is for, who is on it and what it is told, saved as the project's whole
// organization with only that team changed, undone without sending, added and removed. Model-free, with the stand-in
// controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, toldFixture, type Controller } from './test-controller';

const change = 'studio-development:change';

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
  const worker = (id: string, displayName: string, jobTitle: string, team: string, teamId: string) => ({
    id,
    displayName,
    jobTitle,
    team,
    teamId,
    provider: 'codex',
    model: '',
    enabled: true,
  });
  controller.shell = {
    ...controller.shell,
    teams,
    workers: [
      worker('W-1', 'Eli', 'Engineer', 'Engineering', 'engineering'),
      worker('W-3', 'Mo', 'Engineer', 'Engineering', 'engineering'),
      worker('W-2', 'Ana', 'Reviewer', 'Review', 'review'),
    ],
    employeeDirectory: [
      { id: 'W-1', displayName: 'Eli', provider: 'codex', enabled: true },
      { id: 'W-2', displayName: 'Ana', provider: 'codex', enabled: true },
      { id: 'W-3', displayName: 'Mo', provider: 'codex', enabled: true },
      { id: 'W-4', displayName: 'Kit', provider: 'codex', enabled: true, projectId: 'project-x' },
      { id: 'W-gone', displayName: 'Old', provider: 'codex', enabled: false, projectId: 'project-x', deletedAt: 'x' },
    ],
    adapters: {
      codex: { id: 'codex', name: 'Codex CLI', available: true, workerSelectable: true, modes: ['workspace'] },
    },
    taskKinds: {
      general: { label: 'General task', available: true },
      [change]: { label: 'Code change', available: true },
    },
    organizationConfiguration: {
      revision: 3,
      teams,
      members: [
        { workerId: 'W-1', teamId: 'engineering', role: 'Engineer', responsibility: 'Writes the code.', roles: [] },
        {
          workerId: 'W-3',
          teamId: 'engineering',
          role: 'Engineer',
          responsibility: 'Writes the tests.',
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
      taskKinds: ['general', change],
      kindOwners: { general: 'W-1', [change]: 'W-3' },
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
const field = (editor: ReturnType<typeof within>, label: string) =>
  editor.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const retype = async (user: ReturnType<typeof userEvent.setup>, element: HTMLElement, text: string) => {
  await user.clear(element);
  await user.type(element, text);
};

test('Edit the team opens its editor beside the flow, and Save the team sends only that team and its members', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents/W-1');
  const flow = await screen.findByRole('list', { name: 'How the work flows' });
  await user.click(
    within(within(flow).getByRole('region', { name: 'Engineering' })).getByRole('link', { name: 'Edit the team' }),
  );
  await waitFor(() => expect(router.state.location.search).toEqual({ team: 'engineering' }));
  expect(router.state.location.pathname).toBe('/p/project-x/agents');
  const region = await screen.findByRole('region', { name: 'Edit Engineering' }),
    editor = within(region),
    steps = screen.getByRole('list', { name: 'How the work flows' });
  // Beside the flow, in the agent editor's place, and nothing opens over the page.
  expect(steps.contains(region)).toBe(false);
  expect(region.closest('.sd-agents')).toBe(steps.closest('.sd-agents'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Does' })).toBeNull();
  // What it's for, in full, read with every assignment.
  const purpose = within(editor.getByRole('region', { name: "What it's for" }));
  expect(purpose.getByText('Its agents read these with every assignment.')).toBeTruthy();
  expect(field(editor, 'Purpose').value).toBe('Build the product.');
  expect(field(editor, 'Goal').value).toBe('Ship the release.');
  expect(field(editor, 'Done when').value).toBe('A release.');
  expect(editor.getByText(/recorded attempts keep what they ran with/)).toBeTruthy();
  await retype(user, field(editor, 'Purpose'), 'Build and ship the product.');
  await retype(user, field(editor, 'Goal'), 'Ship 1.0.');
  await retype(user, field(editor, 'Done when'), 'The release is out.');
  // Who's on it: each agent with its role, who leads, Remove and Add an agent.
  const who = within(editor.getByRole('region', { name: "Who's on it" }));
  expect(
    within(who.getByRole('list', { name: "Engineering's agents" }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('b')?.textContent),
  ).toEqual(['Eli', 'Mo']);
  expect(field(who, "Mo's role").value).toBe('Engineer');
  await user.selectOptions(field(who, 'Who leads'), 'W-3');
  await user.click(who.getByRole('button', { name: 'Remove Eli from Engineering' }));
  await user.click(who.getByRole('button', { name: 'Add an agent' }));
  const studio = within(who.getByRole('list', { name: 'Agents the studio has' }));
  // A deleted agent is never offered; an agent on another team moves from it.
  expect(studio.queryByText('Old')).toBeNull();
  expect(studio.getByRole('button', { name: /Ana/ }).textContent).toContain('Moves from Review');
  expect(studio.getByRole('button', { name: /Kit/ }).textContent).toContain('Not on a team');
  await user.click(studio.getByRole('button', { name: /Kit/ }));
  expect(commands()).toEqual([]);
  await user.click(editor.getByRole('button', { name: 'Save the team' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const [command] = commands();
  expect(command).toEqual({
    url: '/api/projects/project-x/organization',
    method: 'PATCH',
    body: {
      projectId: 'project-x',
      expectedRevision: 3,
      teams: [
        {
          id: 'engineering',
          name: 'Engineering',
          mark: 'EN',
          purpose: 'Build and ship the product.',
          goal: 'Ship 1.0.',
          outcome: 'The release is out.',
          leadId: 'W-3',
        },
        { id: 'review', name: 'Review', mark: 'RV', purpose: 'Check the product.', leadId: 'W-2' },
      ],
      // Ana stays on Review; Eli leaves the project, and Kit joins as a project contributor.
      members: [
        {
          workerId: 'W-2',
          teamId: 'review',
          role: 'Reviewer',
          responsibility: 'Reviews the code.',
          roles: ['reviewer'],
        },
        {
          workerId: 'W-3',
          teamId: 'engineering',
          role: 'Engineer',
          responsibility: 'Writes the tests.',
          roles: ['engineer'],
        },
        {
          workerId: 'W-4',
          teamId: 'engineering',
          role: 'Project contributor',
          responsibility: 'Perform bounded project work and submit evidence for director review.',
          roles: [],
        },
      ],
      taskKinds: ['general', change],
      // Eli is out of the project, so General task goes back to being chosen each time.
      kindOwners: { [change]: 'W-3' },
    },
  });
  // Without tiers, the saved ones stay.
  expect(command!.body).not.toHaveProperty('tiers');
  expect(await screen.findByText('Engineering saved. Work that starts from now on follows it.')).toBeTruthy();
});

test('Undo puts back the saved team and sends nothing', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents?team=engineering');
  const editor = within(await screen.findByRole('region', { name: 'Edit Engineering' })),
    button = (name: string) => editor.getByRole('button', { name }) as HTMLButtonElement;
  // Nothing to save or undo until a field changes.
  expect(button('Save the team').disabled).toBe(true);
  expect(button('Undo').disabled).toBe(true);
  await user.selectOptions(field(editor, 'Who leads'), 'W-3');
  await user.click(editor.getByRole('button', { name: 'Remove Eli from Engineering' }));
  await retype(user, field(editor, 'Team name'), 'Platform');
  await retype(user, field(editor, 'Purpose'), 'Something else.');
  expect(editor.getByRole('button', { name: 'Remove Mo from Platform' })).toBeTruthy();
  expect(editor.queryByRole('button', { name: 'Remove Eli from Platform' })).toBeNull();
  await user.click(button('Undo'));
  expect(field(editor, 'Team name').value).toBe('Engineering');
  expect(field(editor, 'Purpose').value).toBe('Build the product.');
  expect(field(editor, 'Who leads').value).toBe('W-1');
  expect(editor.getByRole('button', { name: 'Remove Eli from Engineering' })).toBeTruthy();
  expect(button('Save the team').disabled).toBe(true);
  expect(commands()).toEqual([]);
});

test("Make a new one saves the agent at once and keeps it in the team's draft", async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url === '/api/projects/project-x/agents'
      ? {
          worker: {
            id: 'W-new',
            displayName: 'Iris',
            jobTitle: 'Tester',
            responsibility: 'Tests the product.',
            provider: 'codex',
            projectId: 'project-x',
            enabled: true,
          },
          revision: 4,
        }
      : {};
  open('/p/project-x/agents?team=engineering');
  const editor = within(await screen.findByRole('region', { name: 'Edit Engineering' }));
  await user.click(editor.getByRole('button', { name: 'Make a new one' }));
  const form = within(editor.getByRole('form', { name: 'A new agent for Engineering' }));
  await user.type(form.getByLabelText('Name'), 'Iris');
  await user.type(form.getByLabelText('Job title'), 'Tester');
  await user.type(form.getByLabelText('What it is responsible for'), 'Tests the product.');
  await user.type(form.getByLabelText('Staffing roles'), 'tester');
  await user.click(form.getByRole('button', { name: 'Make the agent' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]).toEqual({
    url: '/api/projects/project-x/agents',
    method: 'POST',
    body: {
      projectId: 'project-x',
      expectedRevision: 3,
      displayName: 'Iris',
      jobTitle: 'Tester',
      responsibility: 'Tests the product.',
      teamId: 'engineering',
      roles: ['tester'],
      provider: 'codex',
      model: '',
      effort: '',
      mode: '',
      instructions: '',
    },
  });
  // Iris is on the team in the draft before the state lists her, and the team saves at the new revision with her.
  expect(await editor.findByRole('button', { name: 'Remove Iris from Engineering' })).toBeTruthy();
  expect(field(editor, "Iris's role").value).toBe('Tester');
  await user.click(editor.getByRole('button', { name: 'Save the team' }));
  await waitFor(() => expect(commands()).toHaveLength(2));
  const saved = commands()[1]!.body as { expectedRevision: number; members: { workerId: string; roles: string[] }[] };
  expect(saved.expectedRevision).toBe(4);
  expect(saved.members.map(member => member.workerId)).toEqual(['W-2', 'W-1', 'W-3', 'W-new']);
  expect(saved.members[3]!.roles).toEqual(['tester']);
});

test('Add a team opens a new team, which takes an agent the studio has and is added when saved', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents/W-1');
  const page = within(await screen.findByRole('region', { name: 'Agents' }));
  await user.click(page.getByRole('link', { name: 'Add a team' }));
  await waitFor(() => expect(router.state.location.search).toEqual({ team: 'new' }));
  const editor = within(await screen.findByRole('region', { name: 'A new team' }));
  // A new agent joins a saved team, so a new team is saved first.
  expect((editor.getByRole('button', { name: 'Make a new one' }) as HTMLButtonElement).disabled).toBe(true);
  expect(editor.getByText('Save the team first, then make a new agent for it.')).toBeTruthy();
  expect(editor.queryByRole('button', { name: 'Remove the team' })).toBeNull();
  await user.type(field(editor, 'Team name'), 'Docs');
  await user.type(field(editor, 'Purpose'), 'Write the docs.');
  await user.click(editor.getByRole('button', { name: 'Add an agent' }));
  await user.click(
    within(editor.getByRole('list', { name: 'Agents the studio has' })).getByRole('button', { name: /Kit/ }),
  );
  await user.selectOptions(field(editor, 'Who leads'), 'W-4');
  await user.click(editor.getByRole('button', { name: 'Save the team' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const body = commands()[0]!.body as { teams: { id: string }[]; members: { workerId: string; teamId: string }[] };
  expect(body).toMatchObject({
    expectedRevision: 3,
    teams: [
      { id: 'engineering', leadId: 'W-1' },
      { id: 'review', leadId: 'W-2' },
      { name: 'Docs', mark: '', purpose: 'Write the docs.', goal: '', outcome: '', leadId: 'W-4' },
    ],
    taskKinds: ['general', change],
    kindOwners: { general: 'W-1', [change]: 'W-3' },
  });
  expect(body.teams[2]!.id).toMatch(/^team-[a-z0-9]+-[a-z0-9]+$/);
  expect(body.members.map(member => [member.workerId, member.teamId])).toEqual([
    ['W-1', 'engineering'],
    ['W-2', 'review'],
    ['W-3', 'engineering'],
    ['W-4', body.teams[2]!.id],
  ]);
  expect(body).not.toHaveProperty('tiers');
  expect(await screen.findByText('Docs added. Work that starts from now on follows it.')).toBeTruthy();
});

test('Remove the team asks in place, then sends the organization without the team or its agents', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents?team=review');
  const editor = within(await screen.findByRole('region', { name: 'Edit Review' }));
  await user.click(editor.getByRole('button', { name: 'Remove the team' }));
  // In place, not in a dialog, and nothing is sent until it is confirmed.
  expect(screen.queryByRole('dialog')).toBeNull();
  const confirm = within(editor.getByRole('group', { name: 'Remove Review?' }));
  expect(confirm.getByText(/Its agents leave Project X's flow: Ana\./)).toBeTruthy();
  await user.click(confirm.getByRole('button', { name: 'Keep it' }));
  expect(editor.queryByRole('group', { name: 'Remove Review?' })).toBeNull();
  expect(commands()).toEqual([]);
  await user.click(editor.getByRole('button', { name: 'Remove the team' }));
  await user.click(
    within(editor.getByRole('group', { name: 'Remove Review?' })).getByRole('button', { name: 'Remove Review' }),
  );
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]).toEqual({
    url: '/api/projects/project-x/organization',
    method: 'PATCH',
    body: {
      projectId: 'project-x',
      expectedRevision: 3,
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
      ],
      members: [
        { workerId: 'W-1', teamId: 'engineering', role: 'Engineer', responsibility: 'Writes the code.', roles: [] },
        {
          workerId: 'W-3',
          teamId: 'engineering',
          role: 'Engineer',
          responsibility: 'Writes the tests.',
          roles: ['engineer'],
        },
      ],
      taskKinds: ['general', change],
      kindOwners: { general: 'W-1', [change]: 'W-3' },
    },
  });
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(router.state.location.pathname).toBe('/p/project-x/agents');
});

test("Is told shows the team's rule count and revision and opens its rules", async () => {
  const told = toldFixture('W-1');
  told.layers = told.layers.map(layer =>
    layer.layer === 'team'
      ? {
          ...layer,
          revision: 2,
          rules: [...layer.rules, { title: 'Name what you ran', text: 'Say which checks ran.' }],
        }
      : layer,
  );
  controller.told['W-1'] = told;
  open('/p/project-x/agents?team=engineering');
  const editor = within(await screen.findByRole('region', { name: 'Edit Engineering' })),
    rules = within(editor.getByRole('region', { name: 'Is told' }));
  // Read as its lead reads them.
  expect(await rules.findByText("Engineering's rules: 2 rules")).toBeTruthy();
  expect(rules.getByText('revision 2')).toBeTruthy();
  expect(controller.reads()).toContain('/api/projects/project-x/agents/W-1/told');
  expect(rules.getByRole('link', { name: "Open the team's rules" }).getAttribute('href')).toBe(
    '/p/project-x/agents/W-1/told',
  );
  cleanup();
  // A team with no agents opens its instructions.
  controller.shell = {
    ...controller.shell,
    organizationConfiguration: {
      ...controller.shell.organizationConfiguration,
      members: controller.shell.organizationConfiguration!.members!.filter(member => member.workerId !== 'W-2'),
    },
  };
  open('/p/project-x/agents?team=review');
  const empty = within(
    within(await screen.findByRole('region', { name: 'Edit Review' })).getByRole('region', { name: 'Is told' }),
  );
  expect(empty.getByRole('link', { name: "Open the team's rules" }).getAttribute('href')).toBe(
    '/p/project-x/agents/instructions?open=team%3Areview',
  );
});

test("a refusal shows the controller's message and keeps the edits", async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw Object.assign(new Error('Project organization changed. Refresh before saving.'), { status: 409 });
  };
  open('/p/project-x/agents?team=engineering');
  const editor = within(await screen.findByRole('region', { name: 'Edit Engineering' }));
  await retype(user, field(editor, 'Purpose'), 'Build it well.');
  await user.click(editor.getByRole('button', { name: 'Save the team' }));
  expect(await editor.findByRole('alert')).toHaveProperty(
    'textContent',
    'Project organization changed. Refresh before saving.',
  );
  expect(field(editor, 'Purpose').value).toBe('Build it well.');
  expect((editor.getByRole('button', { name: 'Save the team' }) as HTMLButtonElement).disabled).toBe(false);
});

test("Edit the teams' old address and the flow's Add an agent open the team editor", async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents/teams?edit=true');
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents'));
  expect(router.state.location.search).toEqual({ team: 'engineering' });
  expect(await screen.findByRole('region', { name: 'Edit Engineering' })).toBeTruthy();
  // Add an agent opens the first team's Who's on it with the agents the studio has.
  const page = within(screen.getByRole('region', { name: 'Agents' }));
  await user.click(page.getByRole('link', { name: 'Add an agent' }));
  await waitFor(() => expect(router.state.location.search).toEqual({ team: 'engineering', add: true }));
  expect(await screen.findByRole('list', { name: 'Agents the studio has' })).toBeTruthy();
  expect(commands()).toEqual([]);
});
