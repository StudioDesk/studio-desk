// The release chip across the pages (1.1 step 6, the canvas's ReleaseChip): a story moves to another release from its
// chip until it starts, and only within its line while it is linked to another story; once it starts the chip locks and
// says why. The idea page shows the release its idea was sent for, the New idea box follows a version the words name
// and sends only the director's pick, and the Board filters and lanes its cards by release.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Milestone, ReleaseOverview, RunRecord, Task } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
const change = 'studio-development:change';
const milestone = (version: string, line: string | null): Milestone => ({
  id: `milestone-${version}`,
  version,
  line,
  goal: '',
  state: 'open',
  waiting: [],
  ideas: [],
  movedIn: [],
  counts: { ideas: 0, waiting: 0, stories: 0, integrated: 0, started: 0 },
});
const overview = (): ReleaseOverview => ({
  available: true,
  copy: { branch: 'main', clean: true },
  remote: null,
  lines: [
    {
      branch: 'release/1.0',
      state: 'maintained',
      newest: false,
      from: 'v1.0.0',
      head: 'a1',
      lastRelease: { name: 'v1.0.0', version: '1.0.0' },
      landed: null,
      onRemote: null,
    },
    {
      branch: 'main',
      state: 'maintained',
      newest: true,
      head: 'b1',
      lastRelease: { name: 'v1.0.0', version: '1.0.0' },
      landed: null,
      onRemote: null,
    },
  ],
  milestones: [milestone('1.0.1', 'release/1.0'), milestone('1.1.0', null), milestone('1.2.0', null)],
  tags: ['v1.0.0'],
});
const story = (id: string, title: string, runId: string, extra: Partial<Task> = {}) =>
  taskFixture(id, { title, kind: change, workflowReference: { runId, key: id }, ...extra });
// An idea as the controller's run view sends it, with its release and line.
const idea = (id: string, tasks: Task[]): RunRecord => ({
  id,
  createdAt: '2026-10-26T10:00:00Z',
  brief: `Brief of ${id}.`,
  workflow: { id: 'workflow-1', name: 'Source checks and review', version: 3 },
  revisions: [{ revision: 1, at: '2026-10-26T10:00:00Z', reason: 'created' }],
  nodes: tasks.map(task => ({
    taskId: task.id,
    key: task.id,
    kind: task.kind,
    title: task.title,
    workerId: 'W-1',
    dependencies: task.dependencies ?? [],
    revision: 1,
  })),
  archive: { archived: false },
  release: { milestoneId: 'milestone-1.1.0', version: '1.1.0', by: { type: 'default' } },
  line: 'main',
});

beforeEach(() => {
  controller = fakeController();
  controller.releases = overview();
  const built = story('T-built', 'Show the exact summaries', 'run-1', { status: 'review', lastAttemptId: 'attempt-1' }),
    next = story('T-next', 'Resume from staged work', 'run-1', { dependencies: ['T-built'] }),
    alone = story('T-alone', 'Keep the board quick', 'run-2', {
      release: { milestoneId: 'milestone-1.0.1', version: '1.0.1', line: 'release/1.0', by: { type: 'director' } },
    });
  controller.tasks = [built, next, alone];
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-built',
      status: 'succeeded',
      workerId: 'W-1',
      startedAt: '2026-10-26T10:01:00Z',
      assignment: { kind: change },
    },
  ];
  controller.runs = [idea('run-1', [built, next]), idea('run-2', [alone])];
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

test('a story that has not started moves from its chip, within its line while it is linked to another story', async () => {
  const user = userEvent.setup();
  open('/p/project-x/tasks/T-next');
  const [chip] = await screen.findAllByRole('button', { name: 'Release: 1.1.0, next release. Change' });
  await user.click(chip!);
  const picker = within(screen.getByRole('dialog', { name: 'Release for this story' }));
  const patch = picker.getByRole('button', { name: /^1\.0\.1/ });
  expect(patch.hasAttribute('disabled')).toBe(true);
  expect(picker.getByText("It is linked to T-built on main, so it can't move to release/1.0 by itself.")).toBeTruthy();
  await user.click(picker.getByRole('button', { name: /^1\.2\.0/ }));
  expect(commands()).toEqual([
    { url: '/api/tasks/T-next', method: 'PATCH', body: { projectId: 'project-x', release: 'milestone-1.2.0' } },
  ]);
  expect(await screen.findByText('Resume from staged work moves to 1.2.0.')).toBeTruthy();
});

test('a refusal to move a story shows in the controller’s words', async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw new Error('Milestone 1.0.1 is released, so no story moves to it.');
  };
  open('/p/project-x/tasks/T-alone');
  const [chip] = await screen.findAllByRole('button', { name: 'Release: 1.0.1 on release/1.0, your pick. Change' });
  await user.click(chip!);
  await user.click(
    within(screen.getByRole('dialog', { name: 'Release for this story' })).getByRole('button', { name: /^1\.1\.0/ }),
  );
  expect(await screen.findByText('Milestone 1.0.1 is released, so no story moves to it.')).toBeTruthy();
});

test('a started story’s chip is locked and says why', async () => {
  open('/p/project-x/tasks/T-built');
  const [chip] = await screen.findAllByLabelText(
    'Release: 1.1.0. It has started on main, so its work ships in 1.1.0. Only a story that has not started can move.',
  );
  expect(chip!.tagName).toBe('SPAN');
  expect(screen.queryByRole('button', { name: /^Release: .* Change$/ })).toBeNull();
});

test("the idea page shows the idea's release, and each story's chip moves it without opening the story", async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/runs/run-1');
  expect(await screen.findByLabelText('Release: 1.1.0, next release')).toBeTruthy();
  expect(screen.getAllByRole('link', { name: /Show the exact summaries/ })[0]!.getAttribute('href')).toBe(
    '/p/project-x/tasks/T-built',
  );
  // The started story's chip is locked; the next one's opens its picker, and the page stays where it is.
  expect(screen.getAllByLabelText(/^Release: 1\.1\.0\. It has started on main/).length).toBeGreaterThan(0);
  await user.click(screen.getByRole('button', { name: 'Release: 1.1.0, next release. Change' }));
  expect(screen.getByRole('dialog', { name: 'Release for this story' })).toBeTruthy();
  expect(router.state.location.pathname).toBe('/p/project-x/runs/run-1');
});

test('the New idea box keeps the next release whatever the words say, and sends only the director’s pick', async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/intake' ? { runId: 'run-1' } : {});
  open('/p/project-x');
  const [box] = await screen.findAllByRole('form', { name: 'New idea for Project X' });
  const form = within(box!);
  expect(await form.findByRole('button', { name: 'Release: 1.1.0, next release. Change' })).toBeTruthy();
  // The words name 1.0.1, an open milestone, and the chip stays: only the director picks a release (MP-032).
  await user.type(form.getByRole('textbox'), 'Fix the crash for 1.0.1 users');
  await user.click(form.getByRole('button', { name: 'Release: 1.1.0, next release. Change' }));
  const picker = within(form.getByRole('dialog', { name: 'Release for this idea' }));
  expect(picker.getByRole('button', { name: /^The next release/ })).toBeTruthy();
  expect(
    picker.getByText(
      'Only you pick a release. Without your pick, the idea goes to the next release; the planner can only suggest another.',
    ),
  ).toBeTruthy();
  await user.click(picker.getByRole('button', { name: /^1\.2\.0/ }));
  expect(form.getByRole('button', { name: 'Release: 1.2.0, your pick. Change' })).toBeTruthy();
  await user.click(form.getByRole('button', { name: /Send to Project X/ }));
  await waitFor(() =>
    expect(commands().find(request => request.url === '/api/intake')?.body).toEqual({
      projectId: 'project-x',
      idea: 'Fix the crash for 1.0.1 users',
      milestone: 'milestone-1.2.0',
    }),
  );
});

test('the Board shows each story’s release, filters by it and lanes by it', async () => {
  const user = userEvent.setup();
  open('/p/project-x/board');
  const filter = await screen.findByRole('combobox', { name: 'Release' });
  expect(
    within(filter)
      .getAllByRole('option')
      .map(option => option.textContent),
  ).toEqual(['Every release', '1.0.1', '1.1.0', 'In no release']);
  expect(screen.getAllByLabelText('Release: 1.0.1 on release/1.0').length).toBe(1);
  await user.selectOptions(filter, '1.0.1');
  expect(screen.queryByText('Resume from staged work')).toBeNull();
  expect(screen.getByText('Keep the board quick')).toBeTruthy();
  await user.selectOptions(filter, '');
  await user.click(screen.getByRole('button', { name: 'Lanes by release' }));
  const lanes = screen.getByRole('region', { name: 'Board lanes' });
  expect([...lanes.querySelectorAll('.sd-lanehead')].map(head => head.textContent)).toEqual([
    '1.0.1release/1.0',
    '1.1.0',
  ]);
});
