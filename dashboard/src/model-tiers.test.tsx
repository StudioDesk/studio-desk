// The project's model tiers in Settings → Command-line tools (model-tiers.tsx): each CLI listed there with the fields
// it offers and the saved values, saved as the whole organization with only the tiers changed; and the team editor,
// which does not show them and leaves them out of its save so the saved ones stay. Model-free, against the stand-in
// controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

const change = 'studio-development:change';
let controller: Controller;
// Codex offers efforts and one way of working; Claude Code offers no efforts and two ways of working. The saved tiers
// set Codex for Standard work and Claude Code for Deep work.
beforeEach(() => {
  controller = fakeController();
  controller.shell = {
    ...controller.shell,
    teams: [{ id: 'engineering', name: 'Engineering', mark: 'EN', leadId: 'W-1', goalTaskIds: ['T-goal'] }],
    workers: [
      { id: 'W-1', displayName: 'Eli', team: 'Engineering', teamId: 'engineering', provider: 'codex', enabled: true },
      { id: 'W-2', displayName: 'Ana', team: 'Engineering', teamId: 'engineering', provider: 'claude', enabled: true },
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
        workerSelectable: true,
        models: [{ id: 'gpt-5', label: 'GPT-5' }],
        efforts: ['low', 'medium', 'high'],
        modes: ['workspace', 'text'],
      },
      claude: {
        id: 'claude',
        name: 'Claude Code CLI',
        available: true,
        subscription: true,
        workerSelectable: true,
        models: [{ id: 'opus', label: 'Opus' }],
        modes: ['workspace', 'review'],
      },
    },
    taskKinds: { general: { label: 'General task' }, [change]: { label: 'Code change' } },
    organizationConfiguration: {
      revision: 3,
      teams: [
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
      ],
      members: [
        { workerId: 'W-1', teamId: 'engineering', role: 'Engineer', responsibility: 'Writes it.', roles: ['engineer'] },
        { workerId: 'W-2', teamId: 'engineering', role: 'Reviewer', responsibility: 'Checks it.', roles: [] },
      ],
      taskKinds: ['general', change],
      kindOwners: { general: 'W-1', [change]: 'W-2' },
      tiers: {
        standard: { codex: { model: 'gpt-5', effort: 'high' } },
        deep: { claude: { model: 'opus', mode: 'review' } },
      },
    },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path: string) =>
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
const commands = () => controller.requests.filter(request => request.method !== 'GET');
// The saved organization as every save sends it: the teams' own fields without their goal work, each member with its
// part, the kinds of work and their default agents.
const saved = {
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
    { workerId: 'W-1', teamId: 'engineering', role: 'Engineer', responsibility: 'Writes it.', roles: ['engineer'] },
    { workerId: 'W-2', teamId: 'engineering', role: 'Reviewer', responsibility: 'Checks it.', roles: [] },
  ],
  taskKinds: ['general', change],
  kindOwners: { general: 'W-1', [change]: 'W-2' },
};
const tiersIn = async () => {
  open('/p/project-x/settings');
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  const tools = within(screen.getByRole('region', { name: 'Command-line tools' }));
  return within(tools.getByRole('group', { name: 'Model tiers' }));
};
const cli = (tiers: ReturnType<typeof within>, name: string) => tiers.getByRole('group', { name });
const field = (group: HTMLElement, label: string) => within(group).getByLabelText(label) as HTMLInputElement;
const options = (group: HTMLElement, label: string) =>
  [...(within(group).getByLabelText(label) as HTMLSelectElement).options].map(option => option.value);
const labels = (group: HTMLElement) => [...group.querySelectorAll('label')].map(label => label.textContent);

test("Settings → Command-line tools shows the project's model tiers for each CLI, with its fields and the saved values", async () => {
  const tiers = await tiersIn();
  expect(tiers.getByText(/^Project X's own:/).textContent).toMatch(/Tiers apply to work that starts after you save/);
  const codex = cli(tiers, "Codex CLI's tiers"),
    claude = cli(tiers, "Claude Code CLI's tiers");
  // A model for each tier, an effort only where the CLI offers efforts, and a way of working only where it offers more
  // than one.
  expect(labels(codex)).toEqual([
    'Light work model',
    'Light work effort',
    'Standard work model',
    'Standard work effort',
    'Deep work model',
    'Deep work effort',
  ]);
  expect(labels(claude)).toEqual([
    'Light work model',
    'Light work way of working',
    'Standard work model',
    'Standard work way of working',
    'Deep work model',
    'Deep work way of working',
  ]);
  expect(options(codex, 'Standard work effort')).toEqual(['', 'low', 'medium', 'high']);
  expect(options(claude, 'Deep work way of working')).toEqual(['', 'workspace', 'review']);
  // The saved values, and blanks for the agent's own setting.
  expect(field(codex, 'Standard work model').value).toBe('gpt-5');
  expect(field(codex, 'Standard work effort').value).toBe('high');
  expect(field(codex, 'Deep work model').value).toBe('');
  expect(field(claude, 'Deep work model').value).toBe('opus');
  expect(field(claude, 'Deep work way of working').value).toBe('review');
  expect(field(claude, 'Light work model').value).toBe('');
  // Nothing to save until a value changes.
  expect((tiers.getByRole('button', { name: 'Save the tiers' }) as HTMLButtonElement).disabled).toBe(true);
  expect(commands()).toEqual([]);
});

test('setting the Deep work model for one CLI saves the whole organization once, with only the tiers changed', async () => {
  const user = userEvent.setup(),
    tiers = await tiersIn(),
    codex = cli(tiers, "Codex CLI's tiers");
  await user.type(field(codex, 'Deep work model'), ' gpt-5 ');
  // An effort chosen and given back to the agent's own is not sent as an empty field.
  await user.selectOptions(field(codex, 'Deep work effort'), 'low');
  await user.selectOptions(field(codex, 'Deep work effort'), '');
  await user.click(tiers.getByRole('button', { name: 'Save the tiers' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const [command] = commands();
  expect(command!.url).toBe('/api/projects/project-x/organization');
  expect(command!.method).toBe('PATCH');
  expect(command!.body).toStrictEqual({
    ...saved,
    tiers: {
      standard: { codex: { model: 'gpt-5', effort: 'high' } },
      deep: { claude: { model: 'opus', mode: 'review' }, codex: { model: 'gpt-5' } },
    },
  });
  expect(await screen.findByText('Model tiers saved. Work that starts from now on uses them.')).toBeTruthy();
});

test('clearing a value removes it, and a CLI or tier left with none is not sent', async () => {
  const user = userEvent.setup(),
    tiers = await tiersIn(),
    codex = cli(tiers, "Codex CLI's tiers"),
    claude = cli(tiers, "Claude Code CLI's tiers");
  await user.clear(field(codex, 'Standard work model'));
  await user.clear(field(claude, 'Deep work model'));
  await user.selectOptions(field(claude, 'Deep work way of working'), '');
  await user.click(tiers.getByRole('button', { name: 'Save the tiers' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]!.body).toStrictEqual({ ...saved, tiers: { standard: { codex: { effort: 'high' } } } });
});

test("a CLI that is not listed keeps its saved tiers, and a refusal shows the controller's message and keeps the edits", async () => {
  const user = userEvent.setup(),
    message = 'Enter a CLI model ID or leave it blank for its default.';
  // Codex is not found, so Settings lists only Claude Code and never mentions Codex.
  controller.shell = {
    ...controller.shell,
    adapters: { ...controller.shell.adapters, codex: { ...controller.shell.adapters!.codex!, available: false } },
  };
  controller.command = () => {
    throw new Error(message);
  };
  const tiers = await tiersIn();
  expect(tiers.queryByRole('group', { name: "Codex CLI's tiers" })).toBeNull();
  expect(screen.getByRole('region', { name: 'Command-line tools' }).textContent).not.toMatch(/codex/i);
  const claude = cli(tiers, "Claude Code CLI's tiers");
  await user.type(field(claude, 'Light work model'), 'not a model');
  await user.click(tiers.getByRole('button', { name: 'Save the tiers' }));
  expect((await tiers.findByRole('alert')).textContent).toBe(message);
  expect(field(claude, 'Light work model').value).toBe('not a model');
  expect(commands()).toHaveLength(1);
  expect(commands()[0]!.body).toStrictEqual({
    ...saved,
    tiers: {
      light: { claude: { model: 'not a model' } },
      standard: { codex: { model: 'gpt-5', effort: 'high' } },
      deep: { claude: { model: 'opus', mode: 'review' } },
    },
  });
});

test('the team editor does not show the model tiers, and Save the team leaves them out so the saved ones stay', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents?team=engineering');
  const editor = within(await screen.findByRole('region', { name: 'Edit Engineering' }));
  expect(editor.queryByText('Model tiers')).toBeNull();
  expect(editor.queryAllByLabelText(/model|effort|way of working/i)).toEqual([]);
  const purpose = editor.getByLabelText('Purpose');
  await user.clear(purpose);
  await user.type(purpose, 'Build it well.');
  await user.click(editor.getByRole('button', { name: 'Save the team' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const [command] = commands();
  expect(command!.url).toBe('/api/projects/project-x/organization');
  expect(command!.method).toBe('PATCH');
  expect(command!.body).toStrictEqual({ ...saved, teams: [{ ...saved.teams[0]!, purpose: 'Build it well.' }] });
  expect(command!.body).not.toHaveProperty('tiers');
});
