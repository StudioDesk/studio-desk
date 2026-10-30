// Trying a story yourself from its "Where it stands" banner (try-actions.tsx): Try it in its own strip under the
// decision row once the story's tests passed, what the try copy then holds, Run and Open folder, Open and Stop while
// its app runs, and the two asks, the director's own edits in the copy and a Run outside the sandbox, as they reach the
// stand-in controller. Model-free; nothing here runs an app.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, Task, TryCopy, TryRun, TryView } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (task: Task) => {
  controller.tasks = [task, ...controller.tasks.filter(item => item.id !== task.id)];
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [`/p/project-x/tasks/${task.id}`] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
};
const banner = async () => within(await screen.findByRole('region', { name: 'Where it stands' }));
const posted = () => controller.requests.filter(request => request.method !== 'GET');
// Each button by its name: its label, or else its words.
const names = (region: ReturnType<typeof within>) =>
  region.getAllByRole('button').map((button: HTMLElement) => button.getAttribute('aria-label') ?? button.textContent);
// The banner's decision row, and Try it's strip under it.
const row = (region: ReturnType<typeof within>) => within(region.getByRole('group', { name: 'Decisions' }));
const strip = (region: ReturnType<typeof within>) => within(region.getByRole('region', { name: 'Try it yourself' }));
const decided = ['Integrate', 'Send back to Eli', 'More actions'];
const tryReads = () => controller.reads().filter(url => url === '/api/projects/project-x/try');
const toast = () => document.querySelector('.sd-toast')?.textContent;
// Try it, once the try view is read and it can be sent.
const tryIt = async (region: ReturnType<typeof within>) => {
  const button = (await region.findByRole('button', { name: 'Try it' })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};

// A code story whose candidate, attempt-edit, passed its tests and whose independent review passed, waiting to be
// integrated. The candidate's fields change the story.
const pin = {
  taskId: 'T-1',
  attemptId: 'attempt-edit',
  workerId: 'W-1',
  path: 'source-change.json',
  hash: 'change-hash',
  candidateHash: 'candidate-hash',
};
const story = (candidate: Partial<AttemptSummary> = {}) => {
  controller.attempts = [
    {
      id: 'attempt-edit',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change' },
      result: { outcome: 'completed' },
      testEvidence: { totals: { tests: 534, pass: 534, fail: 0 } },
      sourceCandidate: { sourceHash: 'candidate-hash', commit: 'c4nd1da7e' },
      artifacts: [{ path: 'source-change.json', hash: 'change-hash', kind: 'source-change' }],
      ...candidate,
    },
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-2',
      assignment: { kind: 'studio-development:change-review' },
      result: { outcome: 'completed' },
      candidateReviewVerdict: 'pass',
      candidateReviewNotes: ['A name that could be plainer.'],
      candidateReview: { ...pin, passed: true },
      inputReferences: [
        { taskId: 'T-1', attemptId: 'attempt-edit', artifacts: [{ kind: 'source-change', hash: 'change-hash' }] },
      ],
      artifacts: [{ path: 'source-change-review.json', hash: 'review-hash', kind: 'source-change-review' }],
    },
  ];
  return taskFixture('T-1', {
    title: 'Show the received files',
    kind: 'studio-development:change',
    status: 'done',
    acceptedAttemptId: 'attempt-review',
    lastAttemptId: 'attempt-review',
    sourceStage: {
      version: 'source-story-stages-v1',
      phase: 'candidate-review',
      current: 'waiting-for-integration',
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
  });
};

// The copy holding T-1's candidate merged onto main, and a Run in it.
const copy = (fields: Partial<TryCopy> = {}): TryCopy => ({
  folder: 'C:\\work\\app-try',
  taskId: 'T-1',
  title: 'Show the received files',
  candidateAttemptId: 'attempt-edit',
  branch: 'main',
  tip: 'a1b2c3d4e5f60718',
  commit: 'f6e5d4c3b2a10987',
  merged: true,
  conflicts: [],
  at: '2026-10-29T09:00:00Z',
  run: null,
  ...fields,
});
const run = (fields: Partial<TryRun> = {}): TryRun => ({
  id: 'try-run-1',
  state: 'running',
  place: 'built-in',
  start: ['npm', 'run', 'dev'],
  address: null,
  taskId: 'T-1',
  commit: 'f6e5d4c3b2a10987',
  startedAt: '2026-10-29T09:01:00Z',
  ...fields,
});
const view = (held: TryCopy | null): TryView => ({
  settings: {
    start: ['npm', 'run', 'dev'],
    address: null,
    folder: 'C:\\work\\app-try',
    runIn: 'built-in',
    outsideConfirmedAt: null,
  },
  runsIn: 'built-in',
  copy: held,
});
// The controller refusing a command with its message, status and the fields beside it.
const refusal = (message: string, fields: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status: 409, fields });

test('a story whose candidate passed offers Try it in its own strip; one still implementing or whose tests failed offers none', async () => {
  open(story());
  let region = await banner();
  expect(names(row(region))).toEqual(decided);
  expect(names(strip(region))).toEqual(['Try it']);
  // Try it waits for the try view, which holds nothing yet, and says nothing more.
  await tryIt(region);
  expect(tryReads()).toEqual(['/api/projects/project-x/try']);
  expect(region.queryByText(/try copy/)).toBeNull();
  expect(posted()).toEqual([]);
  cleanup();
  controller.requests = [];
  // Building its first candidate.
  controller.attempts = [
    { id: 'attempt-edit', taskId: 'T-1', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
  ];
  open(
    taskFixture('T-1', {
      kind: 'studio-development:change',
      status: 'running',
      lastAttemptId: 'attempt-edit',
      sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'implementing' },
    }),
  );
  region = await banner();
  expect(await region.findByRole('button', { name: 'Request cancellation' })).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(region.queryByRole('button', { name: 'Try it' })).toBeNull();
  expect(region.queryByRole('region', { name: 'Try it yourself' })).toBeNull();
  cleanup();
  // A candidate that failed its tests.
  open(
    story({
      status: 'failed',
      result: { outcome: 'failed', summary: 'A test failed.' },
      error: 'The candidate did not pass its tests.',
      testEvidence: { totals: { tests: 534, pass: 533, fail: 1 } },
    }),
  );
  region = await banner();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(region.queryByRole('button', { name: 'Try it' })).toBeNull();
  expect(region.queryByRole('button', { name: 'Run' })).toBeNull();
  expect(region.queryByRole('region', { name: 'Try it yourself' })).toBeNull();
  // Neither story reads the try view.
  expect(tryReads()).toEqual([]);
});

test('Try it moves the copy to the story, and the banner says its change is merged onto the line', async () => {
  const user = userEvent.setup();
  controller.command = url => {
    if (url !== '/api/tasks/T-1/try') return {};
    controller.tryView = view(copy());
    return copy();
  };
  open(story());
  const region = await banner();
  await user.click(await tryIt(region));
  // The tip's short commit is set apart in the line.
  expect((await region.findByText(/^The try copy holds this story's change merged onto main at/)).textContent).toBe(
    "The try copy holds this story's change merged onto main at a1b2c3d, as integrating it would merge it.",
  );
  expect(posted()).toEqual([{ url: '/api/tasks/T-1/try', method: 'POST', body: { projectId: 'project-x' } }]);
  // Run and Open folder take Try it's place in its strip; nothing has started.
  expect(names(row(region))).toEqual(decided);
  expect(names(strip(region))).toEqual(['Run', 'Open folder']);
  expect(region.queryByText(/The app/)).toBeNull();
});

test('a candidate that conflicts with its line is held as built, naming the conflicting files', async () => {
  controller.tryView = view(copy({ merged: false, conflicts: ['lib/greeting.js', 'README.md'], commit: 'c4nd1da7e' }));
  open(story());
  const region = await banner();
  expect((await region.findByText(/as built/)).textContent).toBe(
    'The try copy holds the candidate as built: its change conflicts with main in lib/greeting.js and README.md.',
  );
  expect(region.getByRole('button', { name: 'Run' })).toBeTruthy();
  expect(region.queryByRole('button', { name: 'Try it' })).toBeNull();
});

test('a copy holding an earlier candidate of the story, from before it was sent back, offers Try it again', async () => {
  controller.tryView = view(copy({ candidateAttemptId: 'attempt-old' }));
  open(story());
  const region = await banner();
  expect(
    await region.findByText('The try copy holds an earlier candidate of this story. Try it moves it to this one.'),
  ).toBeTruthy();
  await tryIt(region);
  expect(region.queryByRole('button', { name: 'Run' })).toBeNull();
  cleanup();
  // While its app runs, it is stopped first.
  controller.tryView = view(
    copy({ candidateAttemptId: 'attempt-old', run: run({ address: 'http://localhost:5173/' }) }),
  );
  open(story());
  const running = await banner();
  expect(await running.findByText('The try copy holds an earlier candidate of this story.')).toBeTruthy();
  expect(names(row(running))).toEqual(decided);
  expect(names(strip(running))).toEqual(['Stop']);
});

test('with the copy on the story it offers Run and Open folder; while the app starts, Stop and no Open yet', async () => {
  const user = userEvent.setup();
  controller.tryView = view(copy());
  controller.command = url => {
    if (url === '/api/projects/project-x/try/open') return { folder: 'C:\\work\\app-try' };
    if (url === '/api/projects/project-x/try/run') controller.tryView = view(copy({ run: run({ installing: true }) }));
    return {};
  };
  open(story());
  const region = await banner();
  await user.click(await region.findByRole('button', { name: 'Open folder' }));
  await waitFor(() => expect(toast()).toBe("Opened the try copy's folder."));
  await user.click(region.getByRole('button', { name: 'Run' }));
  expect((await region.findByText(/^The app is starting/)).textContent).toBe(
    'The app is starting in the built-in sandbox, its packages installed first.',
  );
  expect(posted()).toEqual([
    { url: '/api/projects/project-x/try/open', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/projects/project-x/try/run', method: 'POST', body: { projectId: 'project-x' } },
  ]);
  // Until the app prints its address there is nothing to open.
  expect(names(row(region))).toEqual(decided);
  expect(names(strip(region))).toEqual(['Stop']);
  expect(region.queryByRole('link', { name: 'Open' })).toBeNull();
});

test('a running app offers Open at the address it printed and Stop in the Try it strip, not the decisions, and says where it runs', async () => {
  const user = userEvent.setup();
  controller.tryView = view(copy({ run: run({ place: 'computer', address: 'http://localhost:5173/' }) }));
  controller.command = url => {
    if (url !== '/api/projects/project-x/try/stop') return {};
    const stopped = run({
      place: 'computer',
      address: 'http://localhost:5173/',
      state: 'ended',
      stopped: 'You stopped it.',
    });
    controller.tryView = view(copy({ run: stopped }));
    return { run: stopped };
  };
  open(story());
  const region = await banner(),
    link = await strip(region).findByRole('link', { name: 'Open' });
  expect(link.getAttribute('href')).toBe('http://localhost:5173/');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(region.getByText('The app runs on this computer at http://localhost:5173/.')).toBeTruthy();
  expect(region.queryByText(/starting/)).toBeNull();
  // Open and Stop are in the strip, not among the decisions.
  expect(names(row(region))).toEqual(decided);
  expect(names(strip(region))).toEqual(['Stop']);
  expect(row(region).queryByRole('link', { name: 'Open' })).toBeNull();
  expect(strip(region).getByText('The app runs on this computer at http://localhost:5173/.')).toBeTruthy();
  await user.click(strip(region).getByRole('button', { name: 'Stop' }));
  // The ended Run still says where it ran, and Run is offered again.
  expect(await region.findByText('The last Run, on this computer, was stopped: You stopped it.')).toBeTruthy();
  expect(posted()).toEqual([
    { url: '/api/projects/project-x/try/stop', method: 'POST', body: { projectId: 'project-x' } },
  ]);
  expect(region.queryByRole('link', { name: 'Open' })).toBeNull();
  expect(names(row(region))).toEqual(decided);
  expect(names(strip(region))).toEqual(['Run', 'Open folder']);
});

test('a copy holding your own edits names them; Keep them sends nothing, and Discard tries the story with discard', async () => {
  const user = userEvent.setup(),
    edits = ['notes.txt', 'lib/greeting.js'];
  controller.command = (url, _method, body) => {
    if (url !== '/api/tasks/T-1/try') return {};
    if (!(body as { discard?: boolean }).discard)
      throw refusal(
        'The try copy holds your own edits: notes.txt, lib/greeting.js. Keep them, or discard them and try this story.',
        { edits },
      );
    controller.tryView = view(copy());
    return copy();
  };
  open(story());
  const region = await banner();
  await user.click(await tryIt(region));
  const asked = within(await region.findByRole('group', { name: 'Your edits in the try copy' }));
  expect(asked.getByText('The try copy holds your own edits: notes.txt and lib/greeting.js.')).toBeTruthy();
  // The prompt is the answer: no other message shows, here or as a toast.
  expect(region.queryByRole('alert')).toBeNull();
  expect(toast()).toBeFalsy();
  await user.click(asked.getByRole('button', { name: 'Keep them' }));
  expect(region.queryByRole('group', { name: 'Your edits in the try copy' })).toBeNull();
  expect(posted()).toEqual([{ url: '/api/tasks/T-1/try', method: 'POST', body: { projectId: 'project-x' } }]);
  expect(region.getByRole('button', { name: 'Try it' })).toBeTruthy();
  await user.click(region.getByRole('button', { name: 'Try it' }));
  await user.click(
    within(await region.findByRole('group', { name: 'Your edits in the try copy' })).getByRole('button', {
      name: 'Discard them and try this story',
    }),
  );
  expect(await region.findByText(/merged onto main at/)).toBeTruthy();
  expect(posted()).toEqual([
    { url: '/api/tasks/T-1/try', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/tasks/T-1/try', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/tasks/T-1/try', method: 'POST', body: { projectId: 'project-x', discard: true } },
  ]);
  expect(region.queryByRole('group', { name: 'Your edits in the try copy' })).toBeNull();
});

test('a Run not confirmed outside the sandbox asks once; Cancel sends nothing and Confirm sends confirmOutside', async () => {
  const user = userEvent.setup(),
    dialog = () => screen.queryByRole('dialog', { name: 'Run outside the sandbox?' });
  controller.tryView = view(copy());
  controller.command = (url, _method, body) => {
    if (url !== '/api/projects/project-x/try/run') return {};
    if (!(body as { confirmOutside?: boolean }).confirmOutside)
      throw refusal(
        "Run runs the agents' code on this computer, outside the sandbox, with your own access. Confirm once for this project to run it.",
        { confirm: 'outside' },
      );
    controller.tryView = view(copy({ run: run({ place: 'computer' }) }));
    return {};
  };
  open(story());
  const region = await banner();
  await user.click(await region.findByRole('button', { name: 'Run' }));
  let ask = within(await screen.findByRole('dialog', { name: 'Run outside the sandbox?' }));
  expect(
    ask.getByText(/^Run runs the agents' code on this computer, outside the sandbox, with your access\./),
  ).toBeTruthy();
  expect(region.queryByRole('alert')).toBeNull();
  await user.click(ask.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(posted()).toEqual([
    { url: '/api/projects/project-x/try/run', method: 'POST', body: { projectId: 'project-x' } },
  ]);
  await user.click(region.getByRole('button', { name: 'Run' }));
  ask = within(await screen.findByRole('dialog', { name: 'Run outside the sandbox?' }));
  await user.click(ask.getByRole('button', { name: 'Confirm' }));
  expect(await region.findByText('The app is starting on this computer.')).toBeTruthy();
  expect(posted()).toEqual([
    { url: '/api/projects/project-x/try/run', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/projects/project-x/try/run', method: 'POST', body: { projectId: 'project-x' } },
    { url: '/api/projects/project-x/try/run', method: 'POST', body: { projectId: 'project-x', confirmOutside: true } },
  ]);
  // Confirmed, it asks no more.
  expect(dialog()).toBeNull();
});

test("another refusal shows the controller's message in the banner, as its other decisions do", async () => {
  const user = userEvent.setup(),
    message = "Name a start command in the project's settings first.";
  controller.tryView = view(copy());
  controller.command = url => {
    if (url === '/api/projects/project-x/try/run') throw refusal(message);
    return {};
  };
  open(story());
  const region = await banner();
  await user.click(await region.findByRole('button', { name: 'Run' }));
  expect((await region.findByRole('alert')).textContent).toBe(message);
  await waitFor(() => expect(toast()).toBe(message));
  expect(screen.queryByRole('dialog', { name: 'Run outside the sandbox?' })).toBeNull();
  expect(region.queryByRole('group', { name: 'Your edits in the try copy' })).toBeNull();
});
