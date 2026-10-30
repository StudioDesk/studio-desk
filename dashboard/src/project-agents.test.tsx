// A project's own agents in the dashboard (1.0.1): a new agent made from a team's editor joins the team's draft and is
// saved with it, and an agent's page renames any agent and deletes one made in this project.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell = {
    ...controller.shell,
    teams: [
      { id: 'writing', name: 'Writing', mark: 'WR', purpose: 'Write the launch.', leadId: 'W-1', goalTaskIds: [] },
    ],
    workers: [
      {
        id: 'W-1',
        displayName: 'Eli',
        jobTitle: 'Copywriter',
        team: 'Writing',
        teamId: 'writing',
        responsibility: 'Writes the long pieces.',
        provider: 'codex',
        model: '',
        enabled: true,
        configVersion: 4,
      },
      {
        id: 'W-own',
        displayName: 'Nova',
        jobTitle: 'Reviewer',
        team: 'Writing',
        teamId: 'writing',
        responsibility: 'Checks every claim.',
        provider: 'claude',
        model: '',
        enabled: true,
        configVersion: 1,
        projectId: 'project-x',
      },
    ],
    employeeDirectory: [
      { id: 'W-1', displayName: 'Eli', provider: 'codex', enabled: true },
      { id: 'W-own', displayName: 'Nova', provider: 'claude', enabled: true, projectId: 'project-x' },
      { id: 'W-gone', displayName: 'Old', provider: 'claude', enabled: false, projectId: 'project-x', deletedAt: 'x' },
    ],
    adapters: {
      codex: {
        id: 'codex',
        name: 'Codex CLI',
        available: true,
        subscription: true,
        workerSelectable: true,
        models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'] }],
        efforts: ['low', 'medium', 'high'],
        modes: ['workspace'],
      },
      claude: { id: 'claude', name: 'Claude Code CLI', available: true, workerSelectable: true, modes: ['workspace'] },
    },
    taskKinds: { general: { label: 'General task', available: true } },
    organizationConfiguration: {
      revision: 2,
      teams: [
        { id: 'writing', name: 'Writing', mark: 'WR', purpose: 'Write the launch.', leadId: 'W-1', goalTaskIds: [] },
      ],
      members: [
        { workerId: 'W-1', teamId: 'writing', role: 'Copywriter', responsibility: 'Writes the long pieces.' },
        { workerId: 'W-own', teamId: 'writing', role: 'Reviewer', responsibility: 'Checks every claim.' },
      ],
      taskKinds: ['general'],
      kindOwners: {},
      tiers: {},
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

test("a new agent made in the team's editor is saved at once and kept in the draft the team saves", async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url === '/api/projects/project-x/agents'
      ? {
          worker: {
            id: 'W-new',
            displayName: 'Iris',
            jobTitle: 'Social writer',
            responsibility: 'Writes the threads.',
            provider: 'codex',
            projectId: 'project-x',
            enabled: true,
          },
          revision: 3,
        }
      : {};
  open('/p/project-x/agents/W-1');
  const flow = within(await screen.findByRole('list', { name: 'How the work flows' }));
  await user.click(within(flow.getByRole('region', { name: 'Writing' })).getByRole('link', { name: 'Edit the team' }));
  const editor = within(await screen.findByRole('region', { name: 'Edit Writing' }));
  // Add an agent opens both choices for the team, with no separate Make a new one button.
  expect(editor.queryByRole('button', { name: 'Make a new one' })).toBeNull();
  await user.click(editor.getByRole('button', { name: 'Add an agent' }));
  // A deleted agent is never offered.
  const has = within(editor.getByRole('region', { name: 'An agent the studio has' }));
  expect(has.getByText('Every agent the studio has is already on this team.')).toBeTruthy();
  expect(editor.queryByText('Old')).toBeNull();
  const form = within(
    within(editor.getByRole('region', { name: 'Make a new one' })).getByRole('form', {
      name: 'A new agent for Writing',
    }),
  );
  await user.type(form.getByLabelText('Name'), 'Iris');
  await user.type(form.getByLabelText('Job title'), 'Social writer');
  await user.type(form.getByLabelText('What it is responsible for'), 'Writes the threads.');
  // It starts on the CLI most of the project's agents use; here Eli's and Nova's are one each, so the first.
  expect((form.getByLabelText('CLI') as HTMLSelectElement).value).toBe('codex');
  await user.type(form.getByLabelText('Staffing roles'), 'social-writer');
  await user.type(form.getByLabelText('What it is told'), 'Write short posts.');
  await user.click(form.getByRole('button', { name: 'Make the agent' }));
  await waitFor(() =>
    expect(commands()[0]).toEqual({
      url: '/api/projects/project-x/agents',
      method: 'POST',
      body: {
        projectId: 'project-x',
        expectedRevision: 2,
        displayName: 'Iris',
        jobTitle: 'Social writer',
        responsibility: 'Writes the threads.',
        teamId: 'writing',
        roles: ['social-writer'],
        provider: 'codex',
        model: '',
        effort: '',
        mode: '',
        instructions: 'Write short posts.',
      },
    }),
  );
  // Iris is on the team in the draft before the state lists her, and the teams save at the new revision with her.
  expect(await editor.findByRole('button', { name: 'Remove Iris from Writing' })).toBeTruthy();
  await user.click(editor.getByRole('button', { name: 'Save the team' }));
  await waitFor(() => expect(commands()).toHaveLength(2));
  const saved = commands()[1]!.body as { expectedRevision: number; members: { workerId: string; roles: string[] }[] };
  expect(saved.expectedRevision).toBe(3);
  expect(saved.members.map(member => member.workerId)).toEqual(['W-1', 'W-own', 'W-new']);
  expect(saved.members[2]!.roles).toEqual(['social-writer']);
});

test('a team added in the flow is saved before it can have a new agent', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1');
  await user.click(
    within(await screen.findByRole('region', { name: 'Agents' })).getByRole('link', { name: 'Add a team' }),
  );
  const editor = within(await screen.findByRole('region', { name: 'A new team' }));
  await user.type(editor.getByLabelText('Team name'), 'Social');
  await user.click(editor.getByRole('button', { name: 'Add an agent' }));
  const make = within(editor.getByRole('region', { name: 'Make a new one' }));
  expect(make.getByText('Save the team first, then make a new agent for it.')).toBeTruthy();
  expect(make.queryByRole('form')).toBeNull();
  // An agent the studio has can still join it before it is saved.
  expect(
    within(editor.getByRole('list', { name: 'Agents the studio has' })).getByRole('button', { name: /Nova/ }),
  ).toBeTruthy();
  expect(commands()).toEqual([]);
});

test('an agent made in this project can be renamed and deleted from its page; a shared agent only renamed', async () => {
  const user = userEvent.setup();
  let refuse = true;
  controller.command = url => {
    if (url.endsWith('/delete') && refuse)
      throw new Error('Nova still has a task open: Check the thread. Close it or let it finish first.');
    return {};
  };
  open('/p/project-x/agents/W-1');
  expect(await screen.findByRole('heading', { level: 2, name: 'Eli' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete Eli' })).toBeNull();
  expect(screen.getByText(/Eli is shared by every project/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Rename' }));
  const rename = within(await screen.findByRole('dialog', { name: 'Rename Eli' }));
  expect(rename.getByText('Eli is shared, so the new name shows in every project.')).toBeTruthy();
  const field = rename.getByLabelText('Name');
  await user.clear(field);
  await user.type(field, 'Eli Lead');
  await user.click(rename.getByRole('button', { name: 'Rename' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      {
        url: '/api/workers/W-1',
        method: 'PATCH',
        body: { projectId: 'project-x', displayName: 'Eli Lead', expectedVersion: 4 },
      },
    ]),
  );
  cleanup();

  const router = open('/p/project-x/agents/W-own');
  expect(await screen.findByText(/Nova belongs to this project/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Delete Nova' }));
  const confirm = within(await screen.findByRole('dialog', { name: 'Delete Nova?' }));
  await user.click(confirm.getByRole('button', { name: 'Delete Nova' }));
  // The controller's reason shows in the dialog, and nothing moves.
  expect(await confirm.findByRole('alert')).toHaveProperty(
    'textContent',
    'Nova still has a task open: Check the thread. Close it or let it finish first.',
  );
  refuse = false;
  await user.click(confirm.getByRole('button', { name: 'Delete Nova' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents'));
  expect(commands().filter(request => request.url.endsWith('/delete'))).toEqual([
    {
      url: '/api/projects/project-x/agents/W-own/delete',
      method: 'POST',
      body: { projectId: 'project-x', expectedRevision: 2 },
    },
    {
      url: '/api/projects/project-x/agents/W-own/delete',
      method: 'POST',
      body: { projectId: 'project-x', expectedRevision: 2 },
    },
  ]);
});
