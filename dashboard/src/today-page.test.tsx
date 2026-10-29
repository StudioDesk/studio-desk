// Today (v1.0 item 23): the calls only the director can make, with the task page's own actions; what moves on its
// own; who is on the floor; the New idea box sent to the project's intake; from the live set and the first page of
// finished runs.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, CommandRecords, Task } from './api';
import { App } from './app';
import type { Answer, Question } from './questions';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, whenShown, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Faked time and intervals, the page's own waits still running as time passes, and a record of each interval set.
const fakeClock = (at: number) => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
  vi.setSystemTime(at);
  return vi.spyOn(globalThis, 'setInterval');
};
const minute = 60000;

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

// A staged story whose passing review's integration stopped, with what its verification recorded.
const stoppedStory = (verification: NonNullable<AttemptSummary['sourceIntegration']>['verification']) => {
  const pin = {
    taskId: 'T-1',
    attemptId: 'attempt-edit',
    workerId: 'W-1',
    path: 'source-change.json',
    hash: 'change-hash',
    candidateHash: 'candidate-hash',
  };
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
  controller.attempts = [
    {
      id: 'attempt-edit',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change' },
      result: { outcome: 'completed' },
      sourceCandidate: { sourceHash: 'candidate-hash' },
      artifacts: [{ path: 'source-change.json', hash: 'change-hash', kind: 'source-change' }],
    },
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-2',
      finishedAt: '2026-10-27T19:02:00.000Z',
      assignment: { kind: 'studio-development:change-review' },
      result: { outcome: 'completed' },
      candidateReviewVerdict: 'pass',
      candidateReview: { ...pin, passed: true },
      inputReferences: [
        { taskId: 'T-1', attemptId: 'attempt-edit', artifacts: [{ kind: 'source-change', hash: 'change-hash' }] },
      ],
      artifacts: [{ path: 'source-change-review.json', hash: 'review-hash', kind: 'source-change-review' }],
      sourceIntegration: { state: 'rejected', verification },
    },
  ];
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Explain a change that fails with what landed',
      kind: 'studio-development:change',
      status: 'done',
      acceptedAttemptId: 'attempt-review',
      lastAttemptId: 'attempt-review',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'integration',
        current: 'failed',
        candidate: pin,
        review: {
          taskId: 'T-1',
          attemptId: 'attempt-review',
          workerId: 'W-2',
          path: 'source-change-review.json',
          hash: 'review-hash',
          verdict: 'pass',
        },
      },
    }),
  ];
};
const storyCall = async () =>
  within(
    (
      await within(await calls()).findByRole('heading', { name: 'Explain a change that fails with what landed' })
    ).closest('article')!,
  );
// The call's buttons in order, with the primary one marked.
const buttons = (card: Awaited<ReturnType<typeof storyCall>>) =>
  card
    .getAllByRole('button')
    .filter(button => button.getAttribute('aria-label') !== 'More choices' && !button.closest('[popover]'))
    .map(button => `${button.textContent}${button.className.includes('sd-btn--primary') ? ' (primary)' : ''}`);

// October 27: a change that passed on its own and fails only with what landed after it was tested goes back to its
// editor merged onto the current source, as the story page offers.
test('a story that fails only with what landed since offers Merge onto the current source first', async () => {
  const user = userEvent.setup();
  stoppedStory({ landedSince: { commits: 2, stories: ['T-2'] } });
  open();
  const card = await storyCall();
  expect(within(await calls()).getAllByRole('heading', { level: 3 })).toHaveLength(1);
  expect(card.getByText('Fails with what landed since')).toBeTruthy();
  expect(card.queryByText('Ready to integrate again')).toBeNull();
  expect(buttons(card)).toEqual([
    'Merge onto the current source (primary)',
    'Integrate again',
    'Close without integrating',
  ]);
  expect(card.getByRole('link', { name: 'See the change' }).getAttribute('href')).toBe('/p/project-x/tasks/T-1');
  expect(card.getByText(/It passed on its own/).textContent).toBe(
    'It passed on its own but fails together with what landed after it was tested: 1 story and 1 commit made by hand.',
  );
  await user.click(card.getByRole('button', { name: 'Merge onto the current source' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/merge-source',
      method: 'POST',
      body: { projectId: 'project-x' },
    }),
  );
  expect(
    await screen.findByText('Eli merges the change onto the current source; then it is tested and reviewed again.'),
  ).toBeTruthy();
});

test('what landed counts its stories, and no commit by hand when every commit was a story', async () => {
  stoppedStory({ landedSince: { commits: 2, stories: ['T-2', 'T-3'] } });
  open();
  const card = await storyCall();
  expect(card.getByText(/It passed on its own/).textContent).toBe(
    'It passed on its own but fails together with what landed after it was tested: 2 stories.',
  );
});

// 1.1 step 3: a story whose integration stopped on a conflict, as the story page offers it.
test('a story stopped by a conflict offers Merge onto the current source first and Integrate again second', async () => {
  const user = userEvent.setup();
  stoppedStory({ conflicts: ['src/a.mjs'] });
  open();
  const card = await storyCall();
  expect(card.getByText('Conflicts with the current source')).toBeTruthy();
  expect(buttons(card)).toEqual([
    'Merge onto the current source (primary)',
    'Integrate again',
    'Close without integrating',
  ]);
  expect(card.getByText('It passed on its own but conflicts with the current source.')).toBeTruthy();
  expect(card.queryByText(/landed after it was tested/)).toBeNull();
  await user.click(card.getByRole('button', { name: 'Integrate again' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/integrate-source',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'attempt-review', reviewHash: 'review-hash' },
    }),
  );
});

test('an integration that failed with nothing landed and no conflict offers Integrate again as before', async () => {
  const user = userEvent.setup();
  stoppedStory({ conflicts: [] });
  open();
  const card = await storyCall();
  expect(card.getByText('Ready to integrate again')).toBeTruthy();
  expect(buttons(card)).toEqual(['Integrate again (primary)', 'Close without integrating']);
  expect(card.queryByRole('button', { name: 'Merge onto the current source' })).toBeNull();
  expect(card.queryByText(/It passed on its own/)).toBeNull();
  await user.click(card.getByRole('button', { name: 'Integrate again' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/integrate-source',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'attempt-review', reviewHash: 'review-hash' },
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

test("a working agent's minutes on the floor move on as the minute does, with no other change", async () => {
  const start = Date.parse('2026-10-26T12:00:00Z'),
    interval = fakeClock(start);
  controller.tasks = [
    taskFixture('T-2', { title: 'Build the board', status: 'running', lastAttemptId: 'attempt-2', maxSeconds: 1200 }),
  ];
  controller.attempts = [
    {
      id: 'attempt-2',
      taskId: 'T-2',
      status: 'running',
      workerId: 'W-1',
      startedAt: new Date(start - 6 * minute).toISOString(),
    },
  ];
  open();
  const live = await screen.findByRole('region', { name: 'Eli is working' });
  expect(within(live).getByText('6 of 20 min')).toBeTruthy();
  await waitFor(() => expect(interval.mock.calls.map(call => call[1])).toContain(1000));
  await act(async () => {
    vi.advanceTimersByTime(minute);
  });
  expect(within(live).getByText('7 of 20 min')).toBeTruthy();
  expect(within(live).queryByText('6 of 20 min')).toBeNull();
});

test('Today with nobody working sets no running-time clock', async () => {
  const interval = fakeClock(Date.parse('2026-10-26T12:00:00Z'));
  open();
  await screen.findByRole('region', { name: 'Free agents' });
  await act(async () => {
    vi.advanceTimersByTime(minute);
  });
  expect(screen.queryByRole('region', { name: 'Eli is working' })).toBeNull();
  expect(interval.mock.calls.map(call => call[1]).filter(period => period === 1000 || period === 30000)).toEqual([]);
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

// A command's answer carries the records it changed (records.ts RecordSync.answer), so Today shows the effect with
// the command's toast, before the stream's change event for it, which changes nothing more.
const proposed = () => [
  taskFixture('T-1', { title: 'Add the board', status: 'backlog', approval: { status: 'pending' } }),
  taskFixture('T-2', { title: 'Add the list', status: 'backlog', approval: { status: 'pending' } }),
];
// The calls' cards and their count, as the page shows them.
const callsShown = (region: HTMLElement) => ({
  cards: within(region)
    .queryAllByRole('heading', { level: 3 })
    .map(heading => heading.textContent),
  count: within(region).queryByText(/^\d+ waiting on you$/)?.textContent ?? null,
});

test("Approve takes the call off Today and lowers the calls' count with its toast, before any live update", async () => {
  const user = userEvent.setup();
  controller.tasks = proposed();
  let answer: CommandRecords | undefined;
  controller.command = url => {
    if (url !== '/api/tasks/T-1/approve-work') return {};
    // Approved, and queued by the house rules (src/core/proposals.mjs approveWork, autonomy approved).
    controller.tasks = controller.tasks.map(task =>
      task.id === 'T-1'
        ? { ...task, status: 'ready', approval: { status: 'approved', by: { type: 'director' } }, queued: true }
        : task,
    );
    answer = controller.records(['T-1']);
    return { ok: true, records: answer };
  };
  open();
  const region = await calls();
  await waitFor(() =>
    expect(callsShown(region)).toEqual({ cards: ['Add the board', 'Add the list'], count: '2 waiting on you' }),
  );
  const card = within(within(region).getByRole('heading', { name: 'Add the board' }).closest('article')!),
    seen = whenShown('Approved “Add the board”.', () => callsShown(region));
  await user.click(card.getByRole('button', { name: 'Approve work' }));
  expect(await seen).toEqual({ cards: ['Add the list'], count: '1 waiting on you' });
  expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('One call is yours to make.');
  // The stream's change for the same command reads the task again and leaves Today as it is.
  const before = controller.reads().length;
  latest().emit('change', { version: answer!.version, start: answer!.start, changes: answer!.changes });
  await waitFor(() => expect(controller.reads().slice(before)).toEqual(['/api/tasks/T-1?projectId=project-x']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(callsShown(region)).toEqual({ cards: ['Add the list'], count: '1 waiting on you' });
  expect(screen.getByText('Approved “Add the board”.')).toBeTruthy();
});

test("a refused Approve leaves Today's calls and their count as they were and shows the controller's reason", async () => {
  const user = userEvent.setup();
  controller.tasks = proposed();
  controller.command = () => {
    throw new Error('The proposed employee is no longer enabled.');
  };
  open();
  const region = await calls();
  await waitFor(() =>
    expect(callsShown(region)).toEqual({ cards: ['Add the board', 'Add the list'], count: '2 waiting on you' }),
  );
  const card = within(within(region).getByRole('heading', { name: 'Add the board' }).closest('article')!),
    seen = whenShown('The proposed employee is no longer enabled.', () => callsShown(region));
  await user.click(card.getByRole('button', { name: 'Approve work' }));
  expect(await seen).toEqual({ cards: ['Add the board', 'Add the list'], count: '2 waiting on you' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(callsShown(region)).toEqual({ cards: ['Add the board', 'Add the list'], count: '2 waiting on you' });
  expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Two calls are yours to make.');
  expect(posted().map(request => request.url)).toEqual(['/api/tasks/T-1/approve-work']);
});

// An agent's question (1.2 step 2) as the controller records it (src/core/questions.mjs readQuestion): the attempt
// stopped blocked with it, and its task waits blocked on that attempt.
const askedAt = '2026-10-28T12:00:00.000Z',
  question: Question = {
    ask: 'Keep the old route for one release?',
    why: 'Two pages still call it.',
    options: [{ label: 'Keep it' }, { label: 'Remove it', detail: 'and update both pages' }],
    recommended: 1,
    choice: 'inside-story',
    topics: [],
  };
const asking = (id: string, taskId: string, asked: Question = question): AttemptSummary => ({
  id,
  taskId,
  status: 'blocked',
  workerId: 'W-1',
  startedAt: '2026-10-28T11:40:00.000Z',
  finishedAt: askedAt,
  question: asked,
});
const askedStory = (asked: Question = question, extra: Partial<Task> = {}) => {
  controller.attempts = [asking('attempt-asked', 'T-1', asked)];
  controller.tasks = [
    taskFixture('T-1', { title: 'Retire the old route', status: 'blocked', lastAttemptId: 'attempt-asked', ...extra }),
  ];
};
const questionCard = async () => within(await within(await calls()).findByRole('article', { name: "Eli's question" }));
// The fold of work moving on its own, when Today shows one.
const fold = () => screen.queryByText('Moving on their own, nothing to do')?.closest('details') ?? null;

test('a waiting question is a call with the agent, the story, when it asked, the question and why, and counts', async () => {
  askedStory();
  controller.tasks.push(
    taskFixture('T-2', { title: 'Add the list', status: 'backlog', approval: { status: 'pending' } }),
  );
  open();
  const region = await calls();
  await waitFor(() =>
    expect(callsShown(region)).toEqual({ cards: ['Retire the old route', 'Add the list'], count: '2 waiting on you' }),
  );
  expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Two calls are yours to make.');
  const card = await questionCard();
  expect(card.getByText('Asked you a question')).toBeTruthy();
  expect(card.getByRole('heading', { level: 3, name: 'Retire the old route' })).toBeTruthy();
  expect(card.getByText('Eli asks')).toBeTruthy();
  expect(when(askedAt)).not.toBe('');
  expect(card.getByText(when(askedAt))).toBeTruthy();
  expect(card.getByText('Keep the old route for one release?')).toBeTruthy();
  expect(card.getByText('Two pages still call it.')).toBeTruthy();
  // The Answer box with the agent's options, in place of Start assignment and the way to the story.
  expect(card.getByRole('form', { name: 'Answer Eli' })).toBeTruthy();
  expect(card.queryByRole('button', { name: 'Start assignment' })).toBeNull();
  expect(card.queryByRole('link', { name: /Open/ })).toBeNull();
  expect(within(card.getByRole('button', { name: /^Remove it/ })).getByText('Recommended')).toBeTruthy();
  // A question waiting for the director is no work moving on its own.
  expect(fold()).toBeNull();
});

test('the recommended option sent answers the question, and its records take the card off Today with the toast', async () => {
  const user = userEvent.setup();
  askedStory();
  controller.tasks.push(
    taskFixture('T-2', { title: 'Add the list', status: 'backlog', approval: { status: 'pending' } }),
  );
  let answer: CommandRecords | undefined;
  controller.command = url => {
    if (url !== '/api/tasks/T-1/answer') return {};
    // Answered, and queued as by Start (src/core/questions.mjs answerQuestion, src/server.mjs).
    const given: Answer = { attemptId: 'attempt-asked', option: 1, label: 'Remove it', by: { type: 'director' } };
    controller.tasks = controller.tasks.map(task =>
      task.id === 'T-1' ? { ...task, status: 'ready', queued: true, answers: [given] } : task,
    );
    answer = controller.records(['T-1']);
    return { answer: given, start: { ok: true, queued: true }, records: answer };
  };
  open();
  const region = await calls();
  await waitFor(() =>
    expect(callsShown(region)).toEqual({ cards: ['Retire the old route', 'Add the list'], count: '2 waiting on you' }),
  );
  const card = await questionCard();
  await user.click(card.getByRole('button', { name: /^Remove it/ }));
  const seen = whenShown('Answer sent.', () => callsShown(region));
  await user.click(card.getByRole('button', { name: 'Send to Eli' }));
  expect(await seen).toEqual({ cards: ['Add the list'], count: '1 waiting on you' });
  expect(posted()).toEqual([
    {
      url: '/api/tasks/T-1/answer',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'attempt-asked', option: 1 },
    },
  ]);
  expect(screen.getByText('Answer sent. Eli continues from its saved work with it.')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('One call is yours to make.');
  // The stream's change for the same command leaves Today as the answer's records did.
  latest().emit('change', { version: answer!.version, start: answer!.start, changes: answer!.changes });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(callsShown(region)).toEqual({ cards: ['Add the list'], count: '1 waiting on you' });
});

test("words written without an option go as the answer's text, and Auto mode turned on goes with them", async () => {
  const user = userEvent.setup();
  askedStory();
  open();
  const card = await questionCard();
  await user.type(card.getByRole('textbox', { name: 'Answer Eli' }), 'Ask the pages team first.');
  const auto = card.getByRole('switch', { name: 'Auto mode' });
  expect(auto.getAttribute('aria-checked')).toBe('false');
  await user.click(auto);
  await user.click(card.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() =>
    expect(posted()).toEqual([
      {
        url: '/api/tasks/T-1/answer',
        method: 'POST',
        body: { projectId: 'project-x', attemptId: 'attempt-asked', text: 'Ask the pages team first.', autoMode: true },
      },
    ]),
  );
  expect(await screen.findByText('Answer sent. Eli continues from its saved work with it.')).toBeTruthy();
});

test('a question of a kind always kept for the director waits under Your calls and names it, even in auto mode', async () => {
  askedStory({ ...question, topics: ['package'] }, { autoMode: true });
  open();
  const region = await calls(),
    card = await questionCard();
  expect(within(region).getByText('1 waiting on you')).toBeTruthy();
  expect(card.getByText(/^Always your call: a new package\./)).toBeTruthy();
  expect(fold()).toBeNull();
});

test('a question auto mode answers is not a call: it moves on its own with the answer auto mode gives', async () => {
  askedStory(question, { autoMode: true });
  open();
  const region = await calls();
  await waitFor(() => expect(within(region).getByText(/Nothing is waiting on you\./)).toBeTruthy());
  expect(within(region).queryByRole('article', { name: "Eli's question" })).toBeNull();
  const moving = fold()!;
  expect(within(moving).getByRole('link', { name: 'Retire the old route' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-1',
  );
  expect(moving.textContent).toContain("Auto mode answers with the agent's recommendation, “Remove it”,");
  expect(within(moving).queryByRole('button', { name: 'Change the answer' })).toBeNull();
});

// Work auto mode answered the question of (src/core/questions.mjs answerQuestion by auto mode), in each state the
// answer can be in: still running, in review, accepted, and closed. The running work waits on the accepted and the
// closed work, so the live set holds them too.
const autoAnswer = (attemptId: string): Answer => ({
  attemptId,
  option: 1,
  label: 'Remove it',
  by: { type: 'auto-mode', at: askedAt },
});
const answeredWork = () => {
  controller.attempts = [
    asking('attempt-asked', 'T-run'),
    { id: 'attempt-run', taskId: 'T-run', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
    asking('attempt-asked-2', 'T-review', { ...question, ask: 'Name the setting after the page?' }),
    {
      id: 'attempt-reviewed',
      taskId: 'T-review',
      status: 'review',
      workerId: 'W-1',
      finishedAt: askedAt,
      result: { outcome: 'completed', summary: 'Renamed the setting.' },
    },
    asking('attempt-asked-3', 'T-done'),
    { id: 'attempt-done', taskId: 'T-done', status: 'accepted', workerId: 'W-1', finishedAt: askedAt },
    asking('attempt-asked-4', 'T-closed'),
  ];
  controller.tasks = [
    taskFixture('T-run', {
      title: 'Retire the old route',
      status: 'running',
      lastAttemptId: 'attempt-run',
      answers: [autoAnswer('attempt-asked')],
      dependencies: ['T-done', 'T-closed'],
    }),
    taskFixture('T-review', {
      title: 'Rename the setting',
      status: 'review',
      lastAttemptId: 'attempt-reviewed',
      answers: [autoAnswer('attempt-asked-2')],
    }),
    taskFixture('T-done', {
      title: 'Accepted work',
      status: 'done',
      lastAttemptId: 'attempt-done',
      acceptedAttemptId: 'attempt-done',
      answers: [autoAnswer('attempt-asked-3')],
    }),
    taskFixture('T-closed', {
      title: 'Closed work',
      status: 'blocked',
      closed: true,
      lastAttemptId: 'attempt-asked-4',
      answers: [autoAnswer('attempt-asked-4')],
    }),
  ];
};
const answerRow = (moving: HTMLElement, title: string) =>
  within(within(moving).getByRole('link', { name: title }).closest('li')!);

test("auto mode's answers on running and reviewed work show in the fold, with nothing else moving", async () => {
  answeredWork();
  open();
  await calls();
  await waitFor(() => expect(fold()).toBeTruthy());
  const moving = fold()!;
  expect(moving.querySelector('summary .sd-chip')?.textContent).toBe('2');
  const running = answerRow(moving, 'Retire the old route');
  expect(running.getByText('Eli asked: Keep the old route for one release?')).toBeTruthy();
  expect(running.getByText('Auto mode chose “Remove it”.')).toBeTruthy();
  expect(running.getByRole('button', { name: 'Change the answer' })).toBeTruthy();
  const reviewed = answerRow(moving, 'Rename the setting');
  expect(reviewed.getByText('Eli asked: Name the setting after the page?')).toBeTruthy();
  expect(reviewed.getByText('Auto mode chose “Remove it”.')).toBeTruthy();
  expect(
    within(moving)
      .getAllByRole('link')
      .map(link => link.getAttribute('href')),
  ).toEqual(['/p/project-x/tasks/T-run', '/p/project-x/tasks/T-review']);
  // Accepted and closed work keeps auto mode's answer as it is.
  expect(within(moving).queryByRole('link', { name: 'Accepted work' })).toBeNull();
  expect(within(moving).queryByRole('link', { name: 'Closed work' })).toBeNull();
  expect(within(moving).getAllByRole('button', { name: 'Change the answer' })).toHaveLength(2);
});

test("Change the answer opens the Answer box in the fold and sends the director's answer in auto mode's place", async () => {
  const user = userEvent.setup();
  answeredWork();
  controller.command = url => {
    if (url !== '/api/tasks/T-run/change-answer') return {};
    // The director's answer replaces auto mode's, and the running attempt stops first (changeAnswer).
    const given: Answer = {
      attemptId: 'attempt-asked',
      option: 0,
      label: 'Keep it',
      replaces: 'auto-mode',
      by: { type: 'director' },
    };
    controller.tasks = controller.tasks.map(task =>
      task.id === 'T-run'
        ? { ...task, answers: [...(task.answers as Answer[]), given], answerChange: { attemptId: 'attempt-run' } }
        : task,
    );
    return { answer: given, start: null, records: controller.records(['T-run']) };
  };
  open();
  await calls();
  await waitFor(() => expect(fold()).toBeTruthy());
  const moving = fold()!,
    running = answerRow(moving, 'Retire the old route');
  expect(running.queryByRole('form', { name: 'Answer Eli' })).toBeNull();
  await user.click(running.getByRole('button', { name: 'Change the answer' }));
  const form = within(running.getByRole('form', { name: 'Answer Eli' }));
  expect(form.getByText("Your answer replaces auto mode's, and Eli reworks from its saved work.")).toBeTruthy();
  // One box at a time: the other answer stays as it was.
  expect(within(moving).getAllByRole('form', { name: 'Answer Eli' })).toHaveLength(1);
  await user.click(form.getByRole('button', { name: /^Keep it/ }));
  const seen = whenShown('Answer changed.', () => ({
    count: moving.querySelector('summary .sd-chip')?.textContent,
    shown: within(moving).queryByRole('link', { name: 'Retire the old route' }) !== null,
  }));
  await user.click(form.getByRole('button', { name: 'Change the answer' }));
  expect(await seen).toEqual({ count: '1', shown: false });
  expect(posted()).toEqual([
    {
      url: '/api/tasks/T-run/change-answer',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'attempt-asked', option: 0 },
    },
  ]);
  expect(screen.getByText('Answer changed. Eli reworks from its saved work with yours.')).toBeTruthy();
});

test('Cancel closes the Answer box in the fold without sending anything', async () => {
  const user = userEvent.setup();
  answeredWork();
  open();
  await calls();
  await waitFor(() => expect(fold()).toBeTruthy());
  const running = answerRow(fold()!, 'Retire the old route');
  await user.click(running.getByRole('button', { name: 'Change the answer' }));
  expect(running.getByRole('form', { name: 'Answer Eli' })).toBeTruthy();
  await user.click(running.getByRole('button', { name: 'Cancel' }));
  expect(running.queryByRole('form', { name: 'Answer Eli' })).toBeNull();
  expect(posted()).toEqual([]);
});
