// What the director can decide on a story's page: the buttons the current dashboard offers in the same states,
// under "Where it stands", each asking the controller for one recorded step; a note or a reason is asked for in a
// dialog.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Task } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  vi.stubGlobal('confirm', () => true);
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
const decisions = async () => within(await screen.findByRole('region', { name: 'Where it stands' }));
const details = () => within(screen.getByRole('region', { name: 'Details' }));
const posted = () => controller.requests.filter(request => request.method !== 'GET');
const names = (region: ReturnType<typeof within>) =>
  region.getAllByRole('button').map((button: HTMLElement) => button.textContent);

test('ready work starts, and the controller says when it queued it instead', async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url.endsWith('/start') ? { queued: true, reason: 'Waiting for T-0 to be accepted.' } : {};
  open(taskFixture('T-1'));
  const region = await decisions();
  // An unstarted step outside any approval can also be closed, as in the current dashboard; previewing its
  // instructions is a detail of the next attempt, behind Change.
  expect(names(region)).toEqual(['Start assignment', 'Close this step']);
  await user.click(details().getByRole('button', { name: 'Change' }));
  expect(details().getByRole('button', { name: 'Preview next instructions' })).toBeTruthy();
  await user.click(region.getByRole('button', { name: 'Start assignment' }));
  await waitFor(() =>
    expect(posted()).toEqual([{ url: '/api/tasks/T-1/start', method: 'POST', body: { projectId: 'project-x' } }]),
  );
  expect((await screen.findByRole('status', { hidden: true })).textContent).toMatch(
    /Queued\. Waiting for T-0 to be accepted\./,
  );
});

test('a result in review is accepted, or sent for revision with the direction written on the page', async () => {
  const user = userEvent.setup();
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'review',
      workerId: 'W-1',
      result: { outcome: 'completed', summary: 'Ready.' },
    },
  ];
  open(taskFixture('T-1', { status: 'review', lastAttemptId: 'attempt-1' }));
  const region = await decisions();
  expect(names(region)).toEqual(
    expect.arrayContaining(['Accept result', 'Request revision', 'Close without accepting']),
  );
  await user.click(screen.getByRole('tab', { name: 'Overview' }));
  const box = screen.getByLabelText('Direction for the next attempt');
  await user.type(box, 'Name the failing test.');
  await user.click(region.getByRole('button', { name: 'Request revision' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/revise',
      method: 'POST',
      body: { projectId: 'project-x', direction: 'Name the failing test.' },
    }),
  );
  await user.click(region.getByRole('button', { name: 'Accept result' }));
  await waitFor(() => expect(posted().at(-1)?.url).toBe('/api/tasks/T-1/accept'));
});

test('proposed work is approved, or denied with a note', async () => {
  const user = userEvent.setup();
  open(taskFixture('T-1', { status: 'backlog', approval: { status: 'pending' } }));
  const region = await decisions();
  expect(names(region).slice(0, 2)).toEqual(['Approve work', 'Deny work']);
  await user.click(region.getByRole('button', { name: 'Deny work' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Deny this work?' }));
  await user.type(dialog.getByLabelText('Decision note (optional)'), 'Not now.');
  await user.click(dialog.getByRole('button', { name: 'Deny work' }));
  await waitFor(() =>
    expect(posted()).toEqual([
      { url: '/api/tasks/T-1/deny-work', method: 'POST', body: { projectId: 'project-x', reason: 'Not now.' } },
    ]),
  );
});

test('running work can only be cancelled, and the next instructions can be previewed', async () => {
  const user = userEvent.setup();
  controller.attempts = [
    { id: 'attempt-1', taskId: 'T-1', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
  ];
  controller.command = url => (url === '/api/preview' ? { text: 'Composed instructions for the next attempt.' } : {});
  open(taskFixture('T-1', { status: 'running', lastAttemptId: 'attempt-1' }));
  const region = await decisions();
  expect(names(region)).toEqual(['Request cancellation']);
  await user.click(details().getByRole('button', { name: 'Change' }));
  await user.click(details().getByRole('button', { name: 'Preview next instructions' }));
  expect(await screen.findByText('Composed instructions for the next attempt.')).toBeTruthy();
  expect(posted().at(-1)).toEqual({
    url: '/api/preview',
    method: 'POST',
    body: { projectId: 'project-x', taskId: 'T-1', workerId: 'W-1' },
  });
});

// A story ready to integrate: its edit accepted, and its independent review accepted and passing, with any notes.
const passedStory = (notes: string[] = []) => {
  const pin = {
    taskId: 'T-1',
    attemptId: 'attempt-edit',
    workerId: 'W-1',
    path: 'source-change.json',
    hash: 'change-hash',
    candidateHash: 'candidate-hash',
  };
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
      assignment: { kind: 'studio-development:change-review' },
      result: { outcome: 'completed' },
      candidateReviewVerdict: 'pass',
      candidateReviewNotes: notes,
      candidateReview: { ...pin, passed: true },
      inputReferences: [
        { taskId: 'T-1', attemptId: 'attempt-edit', artifacts: [{ kind: 'source-change', hash: 'change-hash' }] },
      ],
      artifacts: [{ path: 'source-change-review.json', hash: 'review-hash', kind: 'source-change-review' }],
    },
  ];
  return taskFixture('T-1', {
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

test('a story whose review passed may still be sent back; with nothing noted, the director says what to change', async () => {
  const user = userEvent.setup();
  open(passedStory());
  const region = await decisions();
  // As the canvas's Story board draws it: Integrate, then Send back, then Close without integrating.
  expect(names(region)).toEqual(['Integrate', 'Send back to Eli', 'Close without integrating']);
  await user.click(region.getByRole('button', { name: 'Send back to Eli' }));
  const back = within(await screen.findByRole('dialog', { name: 'Send it back to Eli?' }));
  // A pass has no blocking findings, and this one noted nothing, so the note is required.
  expect((back.getByRole('button', { name: 'Send back to Eli' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(back.getByLabelText('What Eli should change'), 'Say it in plain words.');
  await user.click(back.getByRole('button', { name: 'Send back to Eli' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/send-back',
      method: 'POST',
      body: { projectId: 'project-x', note: 'Say it in plain words.' },
    }),
  );
});

test("a passing review's notes go back with the story, so the director's note is optional", async () => {
  const user = userEvent.setup();
  open(passedStory(['A case nothing uses yet.', 'A name that could be plainer.']));
  await user.click((await decisions()).getByRole('button', { name: 'Send back to Eli' }));
  const back = within(await screen.findByRole('dialog', { name: 'Send it back to Eli?' }));
  expect(back.getByText(/passing review and its 2 notes, everything the story did so far and your note/)).toBeTruthy();
  await user.click(back.getByRole('button', { name: 'Send back to Eli' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/send-back',
      method: 'POST',
      body: { projectId: 'project-x', note: '' },
    }),
  );
});

test('a story whose review asked for changes is sent back, or integrated over the review with a reason', async () => {
  const user = userEvent.setup();
  controller.attempts = [
    { id: 'attempt-review', taskId: 'T-1', status: 'accepted', workerId: 'W-1', candidateReviewVerdict: 'needs-work' },
  ];
  open(
    taskFixture('T-1', {
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
  );
  const region = await decisions();
  expect(names(region)).toEqual(['Send back to Eli', 'Integrate over the review', 'Close without integrating']);
  await user.click(region.getByRole('button', { name: 'Send back to Eli' }));
  const back = within(await screen.findByRole('dialog', { name: 'Send it back to Eli?' }));
  await user.type(back.getByLabelText('Your note (optional)'), 'Fix the test name.');
  await user.click(back.getByRole('button', { name: 'Send back to Eli' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/send-back',
      method: 'POST',
      body: { projectId: 'project-x', note: 'Fix the test name.' },
    }),
  );
  await user.click(region.getByRole('button', { name: 'Integrate over the review' }));
  const over = within(await screen.findByRole('dialog', { name: "Integrate over Eli's review?" }));
  expect((over.getByRole('button', { name: 'Integrate over the review' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(over.getByLabelText('Why integrate it anyway'), 'The finding is a style preference.');
  await user.click(over.getByRole('button', { name: 'Integrate over the review' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/integrate-source',
      method: 'POST',
      body: {
        projectId: 'project-x',
        attemptId: 'attempt-review',
        reviewHash: 'review-hash',
        overrideReason: 'The finding is a style preference.',
      },
    }),
  );
});
