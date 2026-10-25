// Today (v1.0 item 23): the calls only the director can make, with the task page's own actions; what moves on its
// own; who is on the floor; the New idea box sent to the project's intake; from the live set and the first page of
// finished runs.
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x') => {
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
const calls = () => screen.findByRole('region', { name: 'Your calls' });
const posted = () => controller.requests.filter(request => request.method === 'POST');
const box = () => screen.findByRole('textbox', { name: 'New idea for Project X' });

test('a call shows what happened and the way to act on it, and the title counts the calls', async () => {
  const user = userEvent.setup();
  controller.tasks = [taskFixture('T-1', { title: 'Waiting to start' })];
  open();
  const heading = await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(heading.textContent).toContain('One call is yours to make.'));
  const region = await calls();
  expect(within(region).getByText('1 waiting on you')).toBeTruthy();
  expect(within(region).getByRole('heading', { level: 3, name: 'Waiting to start' })).toBeTruthy();
  expect(within(region).getByText(/This assignment is ready to be queued\./)).toBeTruthy();
  // Starting it is the call's own button (the recovery drill: every step waiting for the director offered only a
  // way to the story); the story stays a click away.
  expect(within(region).getByRole('link', { name: 'Open the story' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-1',
  );
  await user.click(within(region).getByRole('button', { name: 'Start assignment' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/start',
      method: 'POST',
      body: { projectId: 'project-x' },
    }),
  );
});

test('a story whose review asked for changes is sent back, or integrated over the review with a reason', async () => {
  const user = userEvent.setup();
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
  controller.attempts = [
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-2',
      finishedAt: '2026-10-14T19:02:00.000Z',
      candidateReviewVerdict: 'needs-work',
      candidateReviewFindings: ['public/app.js:353: Switching projects deletes the unsent draft.'],
    },
  ];
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Add the New idea intake',
      kind: 'studio-development:change',
      status: 'done',
      acceptedAttemptId: 'attempt-review',
      lastAttemptId: 'attempt-review',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'candidate-review',
        current: 'failed',
        review: { attemptId: 'attempt-review', verdict: 'needs-work', hash: 'review-hash' },
      },
    }),
  ];
  open();
  const card = within(
    (await within(await calls()).findByRole('heading', { name: 'Add the New idea intake' })).closest('article')!,
  );
  expect(card.getByText('Changes requested')).toBeTruthy();
  expect(card.getByText('public/app.js:353')).toBeTruthy();
  expect(card.getByText('Switching projects deletes the unsent draft.')).toBeTruthy();
  expect(card.getByText("Eli gets Morgan's findings.")).toBeTruthy();
  await user.click(card.getByRole('button', { name: 'Send back to Eli' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/send-back',
      method: 'POST',
      body: { projectId: 'project-x', note: '' },
    }),
  );
  await user.click(card.getByRole('button', { name: /^Integrate over the review/ }));
  const dialog = within(await screen.findByRole('dialog', { name: "Integrate over Morgan's review?" }));
  const submit = dialog.getByRole('button', { name: 'Integrate over the review' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await user.type(dialog.getByLabelText('Why integrate it anyway'), 'The draft is kept by the next story.');
  await user.click(submit);
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/integrate-source',
      method: 'POST',
      body: {
        projectId: 'project-x',
        attemptId: 'attempt-review',
        reviewHash: 'review-hash',
        overrideReason: 'The draft is kept by the next story.',
      },
    }),
  );
});

test("a blocked editor's file request is approved as asked, with the attempt that asked", async () => {
  const user = userEvent.setup();
  controller.attempts = [
    {
      id: 'attempt-blocked',
      taskId: 'T-story',
      workerId: 'W-1',
      status: 'blocked',
      startedAt: '2026-10-21T11:00:00.000Z',
      finishedAt: '2026-10-21T11:05:00.000Z',
      assignment: { kind: 'studio-development:change' },
      scopeRequest: {
        files: ['test/greeting.test.mjs'],
        newFiles: [],
        deleteFiles: [],
        reason: 'The test asserts the old text.',
      },
      artifacts: [],
    },
  ];
  controller.tasks = [
    taskFixture('T-story', {
      title: 'Greet the director',
      kind: 'studio-development:change',
      status: 'blocked',
      lastAttemptId: 'attempt-blocked',
      brief: 'Greet the director.\n\nFiles: src/greeting.mjs',
      approval: { status: 'approved' },
      proposalReference: { taskId: 'planning' },
      sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'blocked', history: [] },
    }),
  ];
  open();
  const card = within(
    (await within(await calls()).findByRole('heading', { name: 'Greet the director' })).closest('article')!,
  );
  expect(card.getByText('Needs one more file')).toBeTruthy();
  expect(card.getByText('The test asserts the old text.')).toBeTruthy();
  expect(card.getByText('+ test/greeting.test.mjs')).toBeTruthy();
  expect(card.getByText('Eli starts again with these files.')).toBeTruthy();
  expect(card.getByRole('link', { name: 'Edit the file list' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-story',
  );
  await user.click(card.getByRole('button', { name: 'Allow and continue' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-story/edit-scope',
      method: 'POST',
      body: {
        projectId: 'project-x',
        files: ['src/greeting.mjs', 'test/greeting.test.mjs'],
        newFiles: [],
        deleteFiles: [],
        reason: 'The test asserts the old text.',
        keepWork: false,
        request: 'attempt-blocked',
      },
    }),
  );
});

test("a story's review on the floor reads as its review, not another attempt at the build", async () => {
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
  controller.tasks = [
    taskFixture('T-3', {
      title: 'Accept brackets in paths',
      kind: 'studio-development:change',
      status: 'running',
      maxAttempts: 2,
      lastAttemptId: 'attempt-review',
      sourceStage: { version: 'source-story-stages-v1', phase: 'review', current: 'reviewing' },
    }),
  ];
  controller.attempts = [
    {
      id: 'attempt-build',
      taskId: 'T-3',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change' },
    },
    {
      id: 'attempt-review',
      taskId: 'T-3',
      status: 'running',
      workerId: 'W-2',
      startedAt: new Date().toISOString(),
      assignment: { kind: 'studio-development:change-review' },
    },
  ];
  open();
  const live = await screen.findByRole('region', { name: 'Morgan is working' });
  expect(within(live).getByText('Review · reviewing the change')).toBeTruthy();
});

test('running work shows on the floor with who is on it and a way to watch, and waits fold under the calls', async () => {
  controller.tasks = [
    taskFixture('T-2', { title: 'Build the board', status: 'running', lastAttemptId: 'attempt-2' }),
    taskFixture('T-wait', { title: 'Waiting on the board', status: 'blocked', queued: true, dependencies: ['T-2'] }),
  ];
  controller.attempts = [
    { id: 'attempt-2', taskId: 'T-2', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
  ];
  open();
  const live = await screen.findByRole('region', { name: 'Eli is working' });
  expect(within(live).getByRole('link', { name: 'Build the board' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-2',
  );
  expect(within(live).getByText('Attempt 1 of 3 · doing the work')).toBeTruthy();
  expect(within(live).getByRole('link', { name: 'Watch Eli work' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-2',
  );
  const region = await calls();
  expect(within(region).getByText(/Nothing is waiting on you\./)).toBeTruthy();
  expect(within(region).queryByRole('heading', { name: 'Waiting on the board' })).toBeNull();
  expect(within(region).getByRole('link', { name: 'Waiting on the board' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-wait',
  );
  expect(screen.queryByLabelText(/calls? for you$/)).toBeNull();
});

test('a change to running work fetches that task alone and updates Today in place', async () => {
  controller.tasks = [taskFixture('T-2', { title: 'Build the board', status: 'running', lastAttemptId: 'attempt-2' })];
  controller.attempts = [
    { id: 'attempt-2', taskId: 'T-2', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
  ];
  open();
  await screen.findByRole('link', { name: 'Build the board' });
  const before = controller.reads().length;
  controller.tasks = [{ ...controller.tasks[0]!, title: 'Build the work board' }];
  latest().emit('change', {
    version: 5,
    start: 'start-a',
    changes: [{ seq: 5, type: 'task', id: 'T-2', projectId: 'project-x' }],
  });
  expect(await screen.findByRole('link', { name: 'Build the work board' })).toBeTruthy();
  expect(controller.reads().slice(before)).toEqual(['/api/tasks/T-2?projectId=project-x']);
});

test('Today reads the first page of finished runs once, for what shipped today', async () => {
  open();
  expect(await screen.findByText('Nothing has shipped yet today.')).toBeTruthy();
  expect(controller.reads().filter(url => url.startsWith('/api/projects/project-x/runs'))).toEqual([
    '/api/projects/project-x/runs?limit=3',
  ]);
});

test('an idea and its files go to the intake as one request, and Today opens the run it started', async () => {
  // The picker's accept list stops most unsupported files; the box still refuses any that get through.
  const user = userEvent.setup({ applyAccept: false });
  controller.command = url => (url === '/api/intake' ? { runId: 'run-9' } : {});
  const router = open();
  const idea = await box(),
    form = within(idea.closest('form')!);
  const send = form.getByRole('button', { name: 'Send to Project X' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await user.type(idea, 'Show the runs page.');
  expect(send.disabled).toBe(false);
  const picker = idea.closest('form')!.querySelector<HTMLInputElement>('input[type=file]')!;
  await user.upload(picker, new File(['# Notes'], 'notes.md', { type: 'text/markdown' }));
  expect(await form.findByText('notes.md')).toBeTruthy();
  await user.upload(picker, new File(['x'], 'tool.exe', { type: 'application/octet-stream' }));
  expect(form.getByRole('alert').textContent).toContain('unsupported');
  await user.click(send);
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-9'));
  expect(posted()).toEqual([
    {
      url: '/api/intake',
      method: 'POST',
      body: {
        projectId: 'project-x',
        idea: 'Show the runs page.',
        files: [{ name: 'notes.md', mediaType: 'text/markdown', data: btoa('# Notes') }],
      },
    },
  ]);
  expect(
    screen.getByText(
      "Idea queued: fresh checks, then the product owner's breakdown. Proposed stories will appear in Planned for your approval.",
    ),
  ).toBeTruthy();
});

test('an idea sent with Auto mode changed from the Settings carries it, and Ctrl+Enter sends', async () => {
  const user = userEvent.setup();
  controller.shell.organizationConfiguration = { taskKinds: ['general:plan', 'general:work'] };
  controller.command = url => (url === '/api/intake' ? { runId: 'run-4' } : {});
  const router = open();
  const idea = await box();
  await user.click(within(idea.closest('form')!).getByRole('switch', { name: 'Auto mode' }));
  await user.type(idea, 'Plan the launch.');
  await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-4'));
  expect(posted()).toEqual([
    { url: '/api/intake', method: 'POST', body: { projectId: 'project-x', idea: 'Plan the launch.', autoMode: true } },
  ]);
  expect(
    screen.getByText(
      'Idea queued: the planner plans the work. Proposed tasks will appear in Planned for your approval.',
    ),
  ).toBeTruthy();
});

test.each([
  { name: 'a catalog with neither intake', configuration: { taskKinds: ['studio-development:checks'] } },
  { name: 'no recorded catalog', configuration: null },
])('Today shows no New idea box for $name', async ({ configuration }) => {
  controller.shell.organizationConfiguration = configuration;
  open();
  await calls();
  expect(screen.queryByRole('textbox', { name: 'New idea for Project X' })).toBeNull();
});

test("a refused idea shows the controller's reason in the box, keeps the idea and stays on Today", async () => {
  const user = userEvent.setup(),
    reason =
      'This project has no idea intake. Enable Plan the work and Do the work, or the Studio desk source workflow, in Edit the teams (Agents, then Teams).';
  controller.command = url => {
    if (url === '/api/intake') throw new Error(reason);
    return {};
  };
  const router = open();
  const idea = (await box()) as HTMLTextAreaElement,
    here = router.history.location.pathname;
  await user.type(idea, 'Plan the launch.');
  await user.click(within(idea.closest('form')!).getByRole('button', { name: 'Send to Project X' }));
  expect((await within(idea.closest('form')!).findByRole('alert')).textContent).toBe(reason);
  expect(idea.value).toBe('Plan the launch.');
  expect(router.history.location.pathname).toBe(here);
  expect(posted().map(request => request.url)).toEqual(['/api/intake']);
  // Drafts last as long as the page: empty this project's so the tests after it start from an empty box.
  await user.clear(idea);
});

test("a CLI's usage hold with no known reset is one call with its waiting work, and clears from Today", async () => {
  const user = userEvent.setup();
  controller.shell = {
    ...controller.shell,
    workers: [{ id: 'W-1', displayName: 'Eli', team: 'Engineering', provider: 'claude' }],
    quota: { claude: true },
    adapters: { claude: { id: 'claude', name: 'Claude Code CLI', quotaLabel: 'Claude Code' } },
  };
  controller.tasks = [
    taskFixture('T-1', { title: 'First held work', status: 'ready', queued: true }),
    taskFixture('T-2', { title: 'Second held work', status: 'ready', queued: true }),
  ];
  open();
  const region = await calls();
  expect(await within(region).findByRole('heading', { name: 'Claude Code usage hold' })).toBeTruthy();
  expect(within(region).getAllByRole('heading', { level: 3 })).toHaveLength(1);
  expect(within(region).getByRole('link', { name: 'Second held work' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-2',
  );
  await user.click(within(region).getByRole('button', { name: 'Clear Claude Code hold after the CLI is usable' }));
  await waitFor(() =>
    expect(posted()[0]).toEqual({
      url: '/api/control',
      method: 'POST',
      body: { projectId: 'project-x', clearQuota: 'claude' },
    }),
  );
});

test('a usage hold with a known reset clears itself and stays off the calls', async () => {
  controller.shell = {
    ...controller.shell,
    workers: [{ id: 'W-1', displayName: 'Eli', team: 'Engineering', provider: 'claude' }],
    quota: { claude: true },
    quotaResets: { claude: '2026-10-22T18:00:00.000Z' },
  };
  controller.tasks = [taskFixture('T-1', { title: 'Held work', status: 'ready', queued: true })];
  open();
  const region = await calls();
  await waitFor(() => expect(within(region).getByText(/Nothing is waiting on you\./)).toBeTruthy());
});
