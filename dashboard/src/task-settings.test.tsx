// A task's own settings on its page: its owner and its execution settings, each asking the controller for one
// recorded step. New work comes in through the idea box; sprints and milestones are after 1.0.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell = {
    ...controller.shell,
    workers: [
      { id: 'W-1', displayName: 'Eli', team: 'Engineering', jobTitle: 'Engineer', provider: 'codex', enabled: true },
      { id: 'W-2', displayName: 'Ana', team: 'Production', jobTitle: 'Producer', provider: 'mock', enabled: true },
    ],
    adapters: {
      codex: { id: 'codex', name: 'Codex CLI', workerSelectable: true, efforts: ['low', 'high'], modes: ['workspace'] },
      mock: { id: 'mock', name: 'Simulator', workerSelectable: true },
    },
    taskKinds: {
      general: { label: 'General task', available: true, creatable: true },
      plan: { label: 'Plan', available: true },
    },
    sprints: [{ id: 'sprint-1', name: 'Sprint 1' }],
  };
  controller.tasks = [
    taskFixture('T-planned', { title: 'Planned work', status: 'backlog', approval: { status: 'pending' } }),
    taskFixture('T-ready', { title: 'Ready work', status: 'ready' }),
  ];
  controller.settled.accepted = [
    { tasks: [taskFixture('T-done', { title: 'Accepted work', status: 'done' })], attempts: [], next: null },
  ];
  controller.command = url => (url === '/api/plans' || url === '/api/tasks' ? { id: 'T-new' } : {});
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

test('proposed work names its owner from its own page, and offers no sprint', async () => {
  const user = userEvent.setup();
  open('/p/project-x/tasks/T-planned');
  const owner = await screen.findByLabelText('Project owner');
  await user.selectOptions(owner, 'W-2');
  await user.click(screen.getByRole('button', { name: 'Save owner' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      { url: '/api/tasks/T-planned/project-owner', method: 'POST', body: { projectId: 'project-x', workerId: 'W-2' } },
    ]),
  );
  expect(screen.getByRole('button', { name: 'Approve work' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add to sprint' })).toBeNull();
});

test("a task's own execution settings override its agent's for future attempts", async () => {
  const user = userEvent.setup();
  open('/p/project-x/tasks/T-ready');
  const details = within(await screen.findByRole('region', { name: 'Details' }));
  expect(details.getByText('Codex · default model')).toBeTruthy();
  await user.click(details.getByRole('button', { name: 'Change' }));
  await user.type(screen.getByLabelText('Model'), 'gpt-5');
  await user.click(screen.getByRole('button', { name: 'Save execution settings' }));
  await waitFor(() =>
    expect(commands()).toEqual([
      {
        url: '/api/tasks/T-ready',
        method: 'PATCH',
        body: { projectId: 'project-x', execution: { provider: '', model: 'gpt-5', effort: '', mode: '' } },
      },
    ]),
  );
});
