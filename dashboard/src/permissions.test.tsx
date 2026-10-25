// Claude permissions in the new dashboard (v1.0 item 22): the approved commands and the default in Settings, a
// task's own auto mode, and approving the commands an employee stopped for.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller, confirm: ReturnType<typeof vi.fn>;
beforeEach(() => {
  controller = fakeController();
  controller.shell = {
    ...controller.shell,
    workers: [
      { id: 'W-1', displayName: 'Eli', team: 'Engineering', provider: 'claude', enabled: true },
      { id: 'W-2', displayName: 'Ana', team: 'Engineering', provider: 'codex', enabled: true },
    ],
    agentPermissions: { auto: false, commands: ['node --test'] },
    adapters: { claude: { id: 'claude', name: 'Claude Code CLI', available: true, subscription: true } },
  };
  confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
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
const commands = () => controller.requests.filter(request => request.method !== 'GET');

test('Settings approves commands as plain prefixes and asks before auto mode becomes the default', async () => {
  const user = userEvent.setup();
  open('/p/project-x/settings');
  const list = within(await screen.findByRole('list', { name: 'Approved commands' }));
  expect(list.getByText('node --test')).toBeTruthy();
  const input = screen.getByLabelText('Approve a command');
  await user.type(input, 'npm test && rm');
  expect(screen.getByText(/Use 1 to 200 characters/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(input);
  await user.type(input, 'npx  vitest run');
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.click(list.getByRole('button', { name: 'Remove node --test' }));
  confirm.mockReturnValueOnce(false);
  const mode = within(screen.getByRole('group', { name: 'Auto mode by default' }));
  await user.click(mode.getByRole('button', { name: 'Auto mode' }));
  expect(confirm.mock.calls[0]![0]).toMatch(/Claude Code's own classifier, not the controller/);
  await user.click(mode.getByRole('button', { name: 'Auto mode' }));
  await waitFor(() => expect(commands()).toHaveLength(3));
  expect(commands().map(command => command.body)).toEqual([
    { projectId: 'project-x', agentPermissions: { commands: ['node --test', 'npx vitest run'] } },
    { projectId: 'project-x', agentPermissions: { commands: [] } },
    { projectId: 'project-x', agentPermissions: { auto: true } },
  ]);
  expect(commands().every(command => command.url === '/api/control')).toBe(true);
});

test("a Claude task chooses its own auto mode for future attempts; other employees' tasks have no choice", async () => {
  const user = userEvent.setup();
  controller.tasks = [
    taskFixture('T-claude', { title: 'Claude work', status: 'ready' }),
    taskFixture('T-codex', { title: 'Codex work', status: 'ready', workerId: 'W-2' }),
  ];
  open('/p/project-x/tasks/T-claude');
  // How the next attempt runs, its auto mode among it, opens from Change beside it.
  await user.click(await screen.findByRole('button', { name: 'Change' }));
  const mode = (await screen.findByRole('combobox', { name: 'Auto mode' })) as HTMLSelectElement;
  expect(mode.selectedOptions[0]!.textContent).toBe('As in Settings (approved commands)');
  await user.selectOptions(mode, 'Auto');
  expect(confirm).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(commands()).toEqual([
      { url: '/api/tasks/T-claude', method: 'PATCH', body: { projectId: 'project-x', autoMode: true } },
    ]),
  );
  cleanup();
  open('/p/project-x/tasks/T-codex');
  expect(await screen.findByRole('heading', { name: 'Codex work' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Change' }));
  expect(screen.queryByRole('combobox', { name: 'Auto mode' })).toBeNull();
});

test('a command request offers each refused command as a rule to approve or shorten', async () => {
  const user = userEvent.setup();
  controller.tasks = [
    taskFixture('T-blocked', { title: 'Blocked work', status: 'blocked', lastAttemptId: 'attempt-1' }),
  ];
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-blocked',
      status: 'blocked',
      workerId: 'W-1',
      provider: 'claude',
      result: { summary: 'I need to run the tests.' },
      commandDenials: [
        { tool: 'Bash', command: 'node --test test/a.test.mjs', reason: 'not approved' },
        { tool: 'Bash', command: 'cd test && ls', reason: 'not approved' },
      ],
    },
  ];
  open('/p/project-x/tasks/T-blocked');
  expect(
    await screen.findByText('The employee stopped after Claude Code refused commands it tried to run.'),
  ).toBeTruthy();
  const rules = screen.getAllByLabelText('Rule to approve') as HTMLInputElement[];
  // Each starts as the longest start that can be a rule.
  expect(rules.map(rule => rule.value)).toEqual(['node --test test/a.test.mjs', 'cd test']);
  await user.clear(rules[0]!);
  await user.type(rules[0]!, 'node --test');
  await user.click(screen.getByRole('checkbox', { name: /cd test && ls/ }));
  await user.click(screen.getByRole('button', { name: 'Allow commands' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      {
        url: '/api/tasks/T-blocked/allow-commands',
        method: 'POST',
        body: { projectId: 'project-x', attemptId: 'attempt-1', commands: ['node --test'] },
      },
    ]),
  );
});
