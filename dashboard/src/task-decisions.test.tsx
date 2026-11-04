// What the director can decide on a story's page: the buttons the current dashboard offers in the same states,
// under "Where it stands" on their own row with the closing actions behind More actions, each asking the controller
// for one recorded step; a note or a reason is asked for in a dialog, and closing is confirmed first.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, Task, TaskAction, TaskActionField } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import {
  createStream,
  decisionStates,
  fakeController,
  outdatedReason,
  outsideMeasured,
  taskFixture,
  type Controller,
} from './test-controller';

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
// The brief beside the tabs, whose last part is the direction for the next attempt.
const brief = () => within(screen.getByRole('region', { name: 'The brief' }));
const posted = () => controller.requests.filter(request => request.method !== 'GET');
// Each button by its name: its label, or else its words.
const names = (region: ReturnType<typeof within>) =>
  region.getAllByRole('button').map((button: HTMLElement) => button.getAttribute('aria-label') ?? button.textContent);
// The banner's decision row, and Try it's strip under it.
const row = (region: ReturnType<typeof within>) => within(region.getByRole('group', { name: 'Decisions' }));
const strip = (region: ReturnType<typeof within>) => within(region.getByRole('region', { name: 'Try it yourself' }));
// The closing actions behind More actions, each with its line of what it does. A closed popover is hidden.
const closing = () =>
  screen
    .queryAllByRole('menuitem', { hidden: true })
    .map(
      item =>
        `${document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent}: ${
          document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent
        }`,
    );
const isPrimary = (button: HTMLElement) => button.className.includes('sd-btn--primary');

test('ready work starts, and the controller says when it queued it instead', async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url.endsWith('/start') ? { queued: true, reason: 'Waiting for T-0 to be accepted.' } : {};
  open(taskFixture('T-1'));
  const region = await decisions();
  // An unstarted step outside any approval can also be closed, as in the current dashboard, behind More actions;
  // previewing its instructions is a detail of the next attempt, behind Change.
  expect(names(region)).toEqual(['Start assignment', 'More actions']);
  expect(closing()).toEqual(['Close this step: It will not run; a note you add is kept with the decision.']);
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

// The page's Answer box sends the answer to an agent's question (1.2 step 2); Start runs the work again without one.
test('while a question waits, Start assignment stays but is not the primary action', async () => {
  const stopped = (fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
    id: 'attempt-1',
    taskId: 'T-1',
    status: 'blocked',
    workerId: 'W-1',
    result: { outcome: 'blocked', summary: 'I need a call on the old route.' },
    ...fields,
  });
  controller.attempts = [
    stopped({
      question: {
        ask: 'Keep the old route for one release?',
        why: 'Two pages still call it.',
        options: [{ label: 'Keep it' }, { label: 'Remove it' }],
        recommended: 0,
        choice: 'director',
        topics: [],
      },
    }),
  ];
  open(taskFixture('T-1', { status: 'blocked', lastAttemptId: 'attempt-1' }));
  let region = await decisions();
  expect(region.getByRole('button', { name: 'Start assignment' }).className).not.toMatch(/sd-btn--primary/);
  expect(region.getAllByRole('button').filter(button => button.className.includes('sd-btn--primary'))).toEqual([]);
  cleanup();
  // The same stop without a question has Start as its primary action.
  controller.attempts = [stopped()];
  open(taskFixture('T-1', { status: 'blocked', lastAttemptId: 'attempt-1' }));
  region = await decisions();
  expect(region.getByRole('button', { name: 'Start assignment' }).className).toMatch(/sd-btn--primary/);
});

// A story whose attempt the controller's stop cut off, as the controller leaves it after a restart: the banner says to
// reconcile it first, and the controller refuses to start another attempt until then.
const cutOff = (status: string, fields: Partial<AttemptSummary> = {}) => {
  controller.attempts = [
    { id: 'attempt-1', taskId: 'T-1', status, workerId: 'W-1', error: 'Controller restarted.', ...fields },
  ];
  open(taskFixture('T-1', { status: 'blocked', lastAttemptId: 'attempt-1' }));
};

test.each(['interrupted', 'quarantined'])(
  'a story whose attempt is %s offers Reconcile first as its primary action, and no Start',
  async status => {
    const user = userEvent.setup();
    cutOff(status);
    const region = await decisions();
    const reconcile = region.getByRole('button', { name: 'Reconcile interrupted attempt' });
    expect(isPrimary(reconcile)).toBe(true);
    expect(row(region).getAllByRole('button')[0]).toBe(reconcile);
    expect(region.queryByRole('button', { name: 'Start assignment' })).toBeNull();
    expect(region.getAllByRole('button').filter(isPrimary)).toEqual([reconcile]);
    await user.click(reconcile);
    await waitFor(() =>
      expect(posted()).toEqual([{ url: '/api/tasks/T-1/reconcile', method: 'POST', body: { projectId: 'project-x' } }]),
    );
  },
);

test('once the attempt is reconciled, Reconcile is gone and Start assignment is the primary action again', async () => {
  cutOff('interrupted', { reconciledAt: '2026-10-21T21:00:00Z' });
  const region = await decisions();
  expect(region.queryByRole('button', { name: 'Reconcile interrupted attempt' })).toBeNull();
  expect(isPrimary(region.getByRole('button', { name: 'Start assignment' }))).toBe(true);
});

// A result in review, with the direction its task recorded and any checks its own report recorded.
const inReview = (checks?: NonNullable<AttemptSummary['result']>['checks']) => {
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'review',
      workerId: 'W-1',
      result: { outcome: 'completed', summary: 'Ready.', ...(checks ? { checks } : {}) },
    },
  ];
  open(taskFixture('T-1', { status: 'review', lastAttemptId: 'attempt-1', direction: 'Recorded direction.' }));
};
const revision = async () => within(await screen.findByRole('dialog', { name: 'Request a revision?' }));
// A result whose own checks failed twice over, one named twice, beside a check that passed and one not run.
const failedChecks = [
  { name: 'Unit tests', status: 'fail', evidence: '2 of 40 failed.' },
  { name: 'Lint', status: 'fail' },
  { name: 'Unit tests', status: 'fail', evidence: 'Run again: 2 of 40 failed.' },
  { name: 'Build', status: 'pass' },
  { name: 'Visual check', status: 'not-run', evidence: 'No browser.' },
];
const acceptOver = async () => within(await screen.findByRole('dialog', { name: 'Accept over a failed check?' }));

test('a result whose own checks failed is accepted over them with a reason, with Request revision beside it', async () => {
  const user = userEvent.setup();
  inReview(failedChecks);
  const region = await decisions(),
    decided = row(region);
  expect(names(decided)).toEqual(['Accept over a failed check…', 'Request revision', 'More actions']);
  const accept = decided.getByRole('button', { name: 'Accept over a failed check…' });
  expect(isPrimary(accept)).toBe(true);
  expect(isPrimary(decided.getByRole('button', { name: 'Request revision' }))).toBe(false);
  expect(region.queryByRole('button', { name: 'Accept result' })).toBeNull();
  await user.click(accept);
  // The acceptance waits for the director's reason, and the box names each failed check once.
  const dialog = await acceptOver();
  expect(posted()).toEqual([]);
  expect(
    dialog.getByText('Its own checks failed: Unit tests, Lint. Your reason is recorded with the acceptance.'),
  ).toBeTruthy();
  const reason = dialog.getByLabelText('Why accept it anyway') as HTMLTextAreaElement;
  expect(reason.value).toBe('');
  expect(reason.maxLength).toBe(2000);
  // The controller needs a reason: an empty one, or only spaces, sends nothing.
  const submit = dialog.getByRole('button', { name: 'Accept over a failed check' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await user.click(submit);
  await user.type(reason, '   ');
  expect(submit.disabled).toBe(true);
  await user.click(submit);
  expect(posted()).toEqual([]);
  await user.clear(reason);
  await user.type(reason, 'The two failures are a known flaky test.');
  await user.click(submit);
  // The accept route takes only the project and the reason.
  await waitFor(() =>
    expect(posted()).toEqual([
      {
        url: '/api/tasks/T-1/accept',
        method: 'POST',
        body: { projectId: 'project-x', overReason: 'The two failures are a known flaky test.' },
      },
    ]),
  );
  expect(screen.queryByRole('dialog', { name: 'Accept over a failed check?' })).toBeNull();
  await waitFor(() => expect(toast().textContent).toBe('Accepted over a failed check.'));
});

test('one failed check is named on its own, and Cancel sends nothing', async () => {
  const user = userEvent.setup();
  inReview([{ name: 'Lint', status: 'fail' }]);
  const region = await decisions();
  await user.click(region.getByRole('button', { name: 'Accept over a failed check…' }));
  const dialog = await acceptOver();
  expect(dialog.getByText('Its own check failed: Lint. Your reason is recorded with the acceptance.')).toBeTruthy();
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Accept over a failed check?' })).toBeNull();
  expect(posted()).toEqual([]);
});

test('a result whose own checks all passed keeps Accept result, which sends no reason', async () => {
  const user = userEvent.setup();
  inReview(failedChecks.filter(check => check.status !== 'fail'));
  const region = await decisions();
  expect(names(row(region))).toEqual(['Accept result', 'Request revision', 'More actions']);
  await user.click(region.getByRole('button', { name: 'Accept result' }));
  await waitFor(() =>
    expect(posted()).toEqual([{ url: '/api/tasks/T-1/accept', method: 'POST', body: { projectId: 'project-x' } }]),
  );
  expect(screen.queryByRole('dialog', { name: 'Accept over a failed check?' })).toBeNull();
  await waitFor(() => expect(toast().textContent).toBe('Result accepted.'));
});

test.each([
  ['accepts failed checks plainly', { acceptsFailedChecks: true, acceptOver: true }],
  ['takes no acceptance over a failed check', { acceptsFailedChecks: false, acceptOver: false }],
])('a task type that %s keeps Accept result over a failed check, which sends no reason', async (_, facts) => {
  const user = userEvent.setup();
  controller.shell.taskKinds = { general: { label: 'General task', cardLabel: 'Task', ...facts } };
  inReview(failedChecks);
  const region = await decisions();
  expect(names(row(region))).toEqual(['Accept result', 'Request revision', 'More actions']);
  await user.click(region.getByRole('button', { name: 'Accept result' }));
  await waitFor(() =>
    expect(posted()).toEqual([{ url: '/api/tasks/T-1/accept', method: 'POST', body: { projectId: 'project-x' } }]),
  );
});

test('the type the attempt ran as decides, as the controller reads it for a stage', async () => {
  // The story's own type would take an acceptance over the failed check; the step it ran as accepts it plainly.
  controller.shell.taskKinds = {
    general: { label: 'General task', acceptsFailedChecks: false, acceptOver: true },
    'general:stage': { label: 'A stage', acceptsFailedChecks: true, acceptOver: true },
  };
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'review',
      workerId: 'W-1',
      assignment: { kind: 'general:stage' },
      result: { outcome: 'completed', summary: 'Ready.', checks: failedChecks },
    },
  ];
  open(taskFixture('T-1', { status: 'review', lastAttemptId: 'attempt-1' }));
  expect(names(row(await decisions()))).toEqual(['Accept result', 'Request revision', 'More actions']);
});

test("a result in review is accepted, or sent for revision with a note that starts from the page's direction draft", async () => {
  const user = userEvent.setup();
  inReview();
  const region = await decisions();
  expect(names(row(region))).toEqual(['Accept result', 'Request revision', 'More actions']);
  expect(closing()).toEqual([
    'Close without accepting: Keeps its attempts without accepting a result; it cannot run again.',
  ]);
  const box = brief().getByLabelText('Direction for the next attempt') as HTMLTextAreaElement;
  await user.clear(box);
  await user.type(box, 'Say which test fails.');
  await user.click(region.getByRole('button', { name: 'Request revision' }));
  // The request waits for the director's note, which starts from the draft written on the page.
  const dialog = await revision();
  expect(posted()).toEqual([]);
  expect(dialog.getByText(/gets this note as its direction, along with everything the work did so far/)).toBeTruthy();
  const note = dialog.getByLabelText('What to change') as HTMLTextAreaElement;
  expect(note.value).toBe('Say which test fails.');
  await user.clear(note);
  await user.type(note, 'Name the failing test.');
  await user.click(dialog.getByRole('button', { name: 'Request revision' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/revise',
      method: 'POST',
      body: { projectId: 'project-x', direction: 'Name the failing test.' },
    }),
  );
  expect(screen.queryByRole('dialog', { name: 'Request a revision?' })).toBeNull();
  // Once the request is recorded, the page's draft gives way to the direction the controller holds.
  await waitFor(() => expect(box.value).toBe('Recorded direction.'));
  await user.click(region.getByRole('button', { name: 'Accept result' }));
  await waitFor(() => expect(posted().at(-1)?.url).toBe('/api/tasks/T-1/accept'));
});

test('a revision note starts from the recorded direction, needs some text, and Cancel sends nothing', async () => {
  const user = userEvent.setup();
  inReview();
  const region = await decisions();
  await user.click(region.getByRole('button', { name: 'Request revision' }));
  let dialog = await revision();
  const note = dialog.getByLabelText('What to change') as HTMLTextAreaElement;
  expect(note.value).toBe('Recorded direction.');
  // The controller's revise step needs a direction.
  await user.clear(note);
  const submit = dialog.getByRole('button', { name: 'Request revision' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await user.click(submit);
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Request a revision?' })).toBeNull();
  expect(posted()).toEqual([]);
  // A cleared note does not carry into the next time the dialog opens.
  await user.click(region.getByRole('button', { name: 'Request revision' }));
  dialog = await revision();
  expect((dialog.getByLabelText('What to change') as HTMLTextAreaElement).value).toBe('Recorded direction.');
});

// A change story whose one counted attempt failed, with the direction its task recorded.
const pastLimit = () => {
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'failed',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change' },
      result: { outcome: 'failed', summary: 'A test failed.' },
    },
  ];
  open(
    taskFixture('T-1', {
      kind: 'studio-development:change',
      status: 'failed',
      maxAttempts: 1,
      lastAttemptId: 'attempt-1',
      direction: 'Recorded direction.',
    }),
  );
};
const again = async () => within(await screen.findByRole('dialog', { name: 'Start it again?' }));

test('past its attempt limit, Start asks for a note for the next attempt and starts it with that direction', async () => {
  const user = userEvent.setup();
  pastLimit();
  const region = await decisions();
  await user.click(region.getByRole('button', { name: 'Start assignment' }));
  // The start waits for the director's note, which starts from the recorded direction.
  const dialog = await again();
  expect(posted()).toEqual([]);
  expect(dialog.getByText(/runs past its attempt limit\. The next attempt gets this note/)).toBeTruthy();
  const note = dialog.getByLabelText('Note for the next attempt (optional)') as HTMLTextAreaElement;
  expect(note.value).toBe('Recorded direction.');
  await user.clear(note);
  await user.type(note, 'Fix the failing test first.');
  await user.click(dialog.getByRole('button', { name: 'Start assignment' }));
  await waitFor(() =>
    expect(posted()).toEqual([
      {
        url: '/api/tasks/T-1/start',
        method: 'POST',
        body: { projectId: 'project-x', direction: 'Fix the failing test first.' },
      },
    ]),
  );
  expect(screen.queryByRole('dialog', { name: 'Start it again?' })).toBeNull();
});

test("the note past the limit starts from the page's draft, may be left empty, and Cancel sends nothing", async () => {
  const user = userEvent.setup();
  pastLimit();
  const region = await decisions();
  await user.click(region.getByRole('button', { name: 'Start assignment' }));
  let dialog = await again();
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Start it again?' })).toBeNull();
  expect(posted()).toEqual([]);
  const box = brief().getByLabelText('Direction for the next attempt') as HTMLTextAreaElement;
  await user.clear(box);
  await user.type(box, 'Say which test fails.');
  await user.click(region.getByRole('button', { name: 'Start assignment' }));
  dialog = await again();
  const note = dialog.getByLabelText('Note for the next attempt (optional)') as HTMLTextAreaElement;
  expect(note.value).toBe('Say which test fails.');
  // The note is optional: an emptied field still starts the work, with the direction the director left.
  await user.clear(note);
  const submit = dialog.getByRole('button', { name: 'Start assignment' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  await user.click(submit);
  await waitFor(() =>
    expect(posted()).toEqual([
      { url: '/api/tasks/T-1/start', method: 'POST', body: { projectId: 'project-x', direction: '' } },
    ]),
  );
  // Once the start is recorded, the page's draft gives way to the direction the controller holds.
  await waitFor(() => expect(box.value).toBe('Recorded direction.'));
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
  // Nothing can be closed while it runs, so there is no More actions.
  expect(names(region)).toEqual(['Request cancellation']);
  expect(screen.queryByRole('menu', { hidden: true })).toBeNull();
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
  // Integrate, then Send back beside it on their own row; Try it in its own strip, its tests having passed.
  expect(names(row(region))).toEqual(['Integrate', 'Send back to Eli', 'More actions']);
  expect(names(strip(region))).toEqual(['Try it']);
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

test('a story whose review passed offers Integrate first, and closing it is behind More actions, confirmed first', async () => {
  const user = userEvent.setup(),
    confirmed = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmed);
  open(passedStory());
  const region = await decisions(),
    decided = row(region);
  expect(names(decided)).toEqual(['Integrate', 'Send back to Eli', 'More actions']);
  expect(isPrimary(decided.getByRole('button', { name: 'Integrate' }))).toBe(true);
  expect(isPrimary(decided.getByRole('button', { name: 'Send back to Eli' }))).toBe(false);
  expect(region.queryByRole('button', { name: 'Close without integrating' })).toBeNull();
  // Under the headline, the facts it rests on.
  expect(region.getByText('Tests passed · Review passed · 1 of 3 attempts used')).toBeTruthy();
  await user.click(decided.getByRole('button', { name: 'More actions' }));
  const item = screen.getByRole('menuitem', { name: 'Close without integrating', hidden: true });
  expect(closing()).toEqual([
    'Close without integrating: Keeps its attempts and frees the source for the next story; it cannot run again.',
  ]);
  await user.click(item);
  // The same confirmation and close request as before it moved.
  expect(confirmed).toHaveBeenCalledWith(
    'Close T-1 without integrating it? Its recorded attempts are kept, and the source is free for the next story. It cannot run again.',
  );
  await waitFor(() =>
    expect(posted()).toEqual([
      {
        url: '/api/tasks/T-1/close',
        method: 'POST',
        body: { projectId: 'project-x', reason: 'Closed without integrating.' },
      },
    ]),
  );
});

test('closing sends nothing when the confirmation is declined', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('confirm', () => false);
  open(passedStory());
  await decisions();
  await user.click(screen.getByRole('menuitem', { name: 'Close without integrating', hidden: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(posted()).toEqual([]);
});

// The review of a candidate that passed its tests is running.
const reviewingStory = () => {
  const story = passedStory();
  controller.attempts = [
    controller.attempts[0]!,
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-2',
      startedAt: new Date().toISOString(),
      assignment: { kind: 'studio-development:change-review' },
    },
  ];
  return {
    ...story,
    status: 'running',
    acceptedAttemptId: 'attempt-edit',
    sourceStage: {
      ...story.sourceStage,
      current: 'candidate-review',
      review: { taskId: 'T-1', attemptId: 'attempt-review', workerId: 'W-2' },
    },
  };
};

test('while the review runs, the row says Integrate and Send back come when it is done, and Try it is offered already', async () => {
  open(reviewingStory());
  const region = await decisions(),
    decided = row(region);
  expect(decided.queryByRole('button', { name: /^Integrate/ })).toBeNull();
  expect(decided.queryByRole('button', { name: /^Send back/ })).toBeNull();
  expect(decided.getByText('Integrate and Send back come when the review is done.')).toBeTruthy();
  // The review may still be cancelled; nothing can be closed while it runs.
  expect(names(decided)).toEqual(['Request cancellation']);
  expect(screen.queryByRole('menu', { hidden: true })).toBeNull();
  expect(await strip(region).findByRole('button', { name: 'Try it' })).toBeTruthy();
  expect(region.getByText('Tests passed · Review running · 1 of 3 attempts used')).toBeTruthy();
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
  const region = await decisions(),
    decided = row(region);
  // Send back stays the main action, with Integrate over the review beside it; closing is only behind More actions.
  expect(names(decided)).toEqual(['Send back to Eli', 'Integrate over the review', 'More actions']);
  expect(isPrimary(decided.getByRole('button', { name: 'Send back to Eli' }))).toBe(true);
  expect(isPrimary(decided.getByRole('button', { name: 'Integrate over the review' }))).toBe(false);
  expect(region.queryByRole('button', { name: /^Close/ })).toBeNull();
  expect(closing()).toEqual([
    'Close without integrating: Keeps its attempts and frees the source for the next story; it cannot run again.',
  ]);
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

// A story whose passing review's integration stopped, with what its verification recorded.
const stoppedStory = (verification: NonNullable<AttemptSummary['sourceIntegration']>['verification']) => {
  const story = passedStory();
  controller.attempts[1]!.sourceIntegration = { state: 'rejected', verification };
  return { ...story, sourceStage: { ...story.sourceStage, phase: 'integration', current: 'failed' } };
};
const merged = () =>
  waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/merge-source',
      method: 'POST',
      body: { projectId: 'project-x' },
    }),
  );

// 1.1 step 3: a story whose integration stopped on a conflict goes back to its editor merged onto the current source.
test('a story stopped by a conflict offers to merge its change onto the current source', async () => {
  const user = userEvent.setup();
  open(stoppedStory({ conflicts: ['src/core/store.mjs'] }));
  const region = await decisions();
  // Integrating again as it is stops on the same conflict, so it is the second choice.
  expect(names(row(region))).toEqual([
    'Merge onto the current source',
    'Integrate again',
    'Send back to Eli',
    'More actions',
  ]);
  expect(names(strip(region))).toEqual(['Try it']);
  await user.click(region.getByRole('button', { name: 'Merge onto the current source' }));
  await merged();
});

// October 27: a change that passed its own tests and fails only merged onto what landed since it was tested.
test('a story that fails only with what landed since says so, links what landed and offers Merge first', async () => {
  const user = userEvent.setup();
  controller.tasks = [taskFixture('T-2', { title: 'Name the stage in plain words' })];
  open(stoppedStory({ landedSince: { commits: 2, stories: ['T-2'] } }));
  const region = await decisions();
  expect(names(row(region))).toEqual([
    'Merge onto the current source',
    'Integrate again',
    'Send back to Eli',
    'More actions',
  ]);
  expect(names(strip(region))).toEqual(['Try it']);
  expect(region.getByRole('button', { name: 'Merge onto the current source' }).className).toMatch(/sd-btn--primary/);
  expect(region.getByRole('button', { name: 'Integrate again' }).className).not.toMatch(/sd-btn--primary/);
  expect(
    region.getByText(/It passed on its own but fails together with what landed after it was tested/).textContent,
  ).toBe(
    'It passed on its own but fails together with what landed after it was tested: Name the stage in plain words and 1 commit made by hand.',
  );
  expect(region.getByRole('link', { name: 'Name the stage in plain words' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-2',
  );
  expect(region.getByText('1 commit made by hand')).toBeTruthy();
  await user.click(region.getByRole('button', { name: 'Merge onto the current source' }));
  await merged();
});

test('no commit by hand is counted when every commit that landed was a story', async () => {
  open(stoppedStory({ landedSince: { commits: 1, stories: ['T-2'] } }));
  const region = await decisions();
  // A story the page has not read is named by its ID.
  expect(region.getByRole('link', { name: 'T-2' }).getAttribute('href')).toBe('/p/project-x/tasks/T-2');
  expect(region.getByText(/landed after it was tested/).textContent).toBe(
    'It passed on its own but fails together with what landed after it was tested: T-2.',
  );
  expect(region.queryByText(/made by hand/)).toBeNull();
});

test('an integration that failed with nothing landed and no conflict offers Integrate again first', async () => {
  open(stoppedStory({ conflicts: [] }));
  const region = await decisions();
  // Nothing landed and nothing conflicted: Integrate again stays the main action, and nothing offers a merge.
  expect(names(row(region))).toEqual(['Integrate again', 'Send back to Eli', 'More actions']);
  expect(names(strip(region))).toEqual(['Try it']);
  expect(region.getByRole('button', { name: 'Integrate again' }).className).toMatch(/sd-btn--primary/);
  expect(region.queryByText(/landed after it was tested/)).toBeNull();
});

// 1.1 step 4: a fix integrated on an older line is carried to the next newer one, or marked not needed there.
test('a fix waiting to be carried forward offers Carry to its line and Not needed with a reason', async () => {
  const user = userEvent.setup();
  controller.attempts = [
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change-review' },
      candidateReviewVerdict: 'pass',
      sourceIntegration: { state: 'integrated' },
      sourceCarries: [{ line: 'main', state: 'waiting' }],
    },
  ];
  open(
    taskFixture('T-1', {
      kind: 'studio-development:change',
      status: 'done',
      acceptedAttemptId: 'attempt-review',
      lastAttemptId: 'attempt-review',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'integration',
        current: 'done',
        review: { attemptId: 'attempt-review', verdict: 'pass', hash: 'review-hash' },
      },
    }),
  );
  const region = await decisions();
  await user.click(region.getByRole('button', { name: 'Carry to main' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/carry',
      method: 'POST',
      body: { projectId: 'project-x', line: 'main' },
    }),
  );
  await user.click(region.getByRole('button', { name: 'Not needed on main…' }));
  const skip = within(await screen.findByRole('dialog', { name: 'Not needed on main?' }));
  await user.type(skip.getByLabelText('Why'), 'main replaced this code.');
  await user.click(skip.getByRole('button', { name: 'Skip it' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/carry-skip',
      method: 'POST',
      body: { projectId: 'project-x', line: 'main', reason: 'main replaced this code.' },
    }),
  );
});

// 1.1, October 27: a fix that landed on a newer line is brought back to an older one at the director's word.
const landedStory = (extra: Partial<Task> = {}, sourceCarries?: AttemptSummary['sourceCarries']) => {
  controller.attempts = [
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change-review' },
      candidateReviewVerdict: 'pass',
      sourceIntegration: { state: 'integrated' },
      ...(sourceCarries ? { sourceCarries } : {}),
    },
  ];
  return taskFixture('T-1', {
    kind: 'studio-development:change',
    status: 'done',
    acceptedAttemptId: 'attempt-review',
    lastAttemptId: 'attempt-review',
    sourceStage: {
      version: 'source-story-stages-v1',
      phase: 'integration',
      current: 'integrated',
      review: { attemptId: 'attempt-review', verdict: 'pass', hash: 'review-hash' },
    },
    ...extra,
  });
};
const targets = {
  lines: [
    { line: 'release/1.1', through: ['release/1.1'] },
    { line: 'release/1.0', through: ['release/1.1', 'release/1.0'] },
    { line: 'release/0.9', reason: 'release/0.9 already has it.' },
  ],
};
// The toast itself: a story without a candidate opens on its Activity, which says while it reads what happened.
const backReads = () => controller.reads().filter(url => url.includes('/bring-back')),
  toast = () => document.querySelector('.sd-toast')!;

test("a landed story offers Bring back to each older line it can go to, and the controller's reason where it can't", async () => {
  controller.bringBack['T-1'] = targets;
  open(landedStory());
  const offer = await (await decisions()).findByRole('list', { name: 'Bring back' }),
    items = within(offer).getAllByRole('listitem');
  expect(backReads()).toEqual(['/api/tasks/T-1/bring-back?projectId=project-x']);
  expect(names(within(offer))).toEqual(['Bring back to release/1.1', 'Bring back to release/1.0']);
  // Bringing it back to release/1.0 applies it to release/1.1 on the way, and says so.
  expect(items[0]!.textContent).toBe('Bring back to release/1.1');
  const older = within(items[1]!).getByRole('button', { name: 'Bring back to release/1.0' }),
    note = document.getElementById(older.getAttribute('aria-describedby') ?? '');
  expect(note?.textContent).toBe('Also reaches release/1.1, the line in between.');
  // A line it can't go to shows why, with no button.
  expect(items[2]!.textContent).toBe('release/0.9 already has it.');
  expect(within(items[2]!).queryByRole('button')).toBeNull();
});

test('Bring back asks first, naming every line it reaches, and sends nothing when cancelled', async () => {
  const user = userEvent.setup();
  controller.bringBack['T-1'] = targets;
  controller.command = url => {
    if (!url.endsWith('/bring-back')) return {};
    // Once planned, the controller offers no line until the carries finish.
    controller.bringBack['T-1'] = {
      lines: [
        { line: 'release/1.1', reason: 'Its bringing back to release/1.1 has not finished.' },
        { line: 'release/1.0', reason: 'Its bringing back to release/1.1 has not finished.' },
      ],
    };
    return { storyId: 'T-1', lines: ['release/1.1', 'release/1.0'], carries: [] };
  };
  open(landedStory());
  const region = await decisions();
  await user.click(await region.findByRole('button', { name: 'Bring back to release/1.0' }));
  let dialog = within(await screen.findByRole('dialog', { name: 'Bring back to release/1.0?' }));
  expect(dialog.getByText(/An older release gets this change/).textContent).toMatch(
    /release\/1\.1, then release\/1\.0/,
  );
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Bring back to release/1.0?' })).toBeNull());
  expect(posted()).toEqual([]);
  await user.click(region.getByRole('button', { name: 'Bring back to release/1.0' }));
  dialog = within(await screen.findByRole('dialog', { name: 'Bring back to release/1.0?' }));
  await user.click(dialog.getByRole('button', { name: 'Bring back to release/1.0' }));
  await waitFor(() =>
    expect(posted()).toEqual([
      { url: '/api/tasks/T-1/bring-back', method: 'POST', body: { projectId: 'project-x', line: 'release/1.0' } },
    ]),
  );
  await waitFor(() => expect(toast().textContent).toBe('Bringing the fix back to release/1.1, then release/1.0.'));
  // The offer is read again and shows the controller's new answer in place of the buttons.
  expect(await region.findAllByText('Its bringing back to release/1.1 has not finished.')).toHaveLength(2);
  expect(backReads()).toHaveLength(2);
  expect(region.queryByRole('button', { name: /^Bring back to/ })).toBeNull();
});

test('a project with one line offers no Bring back, and a story that has not landed, or a carry story, never asks', async () => {
  open(landedStory());
  await decisions();
  await waitFor(() => expect(backReads()).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.queryByRole('list', { name: 'Bring back' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Bring back/ })).toBeNull();
  cleanup();
  controller.requests = [];
  controller.bringBack['T-1'] = targets;
  open(passedStory());
  const passed = await decisions();
  expect(names(row(passed))).toEqual(['Integrate', 'Send back to Eli', 'More actions']);
  expect(names(strip(passed))).toEqual(['Try it']);
  cleanup();
  open(
    landedStory({ carryOf: { storyId: 'T-0', line: 'release/1.1', reviewAttemptId: 'attempt-0', carryId: 'carry-0' } }),
  );
  await decisions();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(controller.reads().length).toBeGreaterThan(0);
  expect(backReads()).toEqual([]);
  expect(screen.queryByRole('button', { name: /^Bring back/ })).toBeNull();
});

test('a stopped bring-back offers Bring back again, and Not needed speaks of bringing it back', async () => {
  const user = userEvent.setup();
  open(landedStory({}, [{ line: 'release/1.0', state: 'rejected', back: true, approved: true }]));
  const region = await decisions();
  expect(names(region)).toEqual(['Bring back to release/1.0 again', 'Not needed on release/1.0…']);
  await user.click(region.getByRole('button', { name: 'Bring back to release/1.0 again' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/carry',
      method: 'POST',
      body: { projectId: 'project-x', line: 'release/1.0' },
    }),
  );
  await waitFor(() => expect(toast().textContent).toBe('Bringing the fix back to release/1.0.'));
  await user.click(region.getByRole('button', { name: 'Not needed on release/1.0…' }));
  const skip = within(await screen.findByRole('dialog', { name: 'Not needed on release/1.0?' }));
  expect(skip.getByText(/^release\/1\.0 won't get the fix brought back\./)).toBeTruthy();
  await user.type(skip.getByLabelText('Why'), 'release/1.0 is past its last patch.');
  await user.click(skip.getByRole('button', { name: 'Skip it' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/carry-skip',
      method: 'POST',
      body: { projectId: 'project-x', line: 'release/1.0', reason: 'release/1.0 is past its last patch.' },
    }),
  );
  await waitFor(() => expect(toast().textContent).toBe('Not bringing the fix back to release/1.0.'));
});

// The code moved past the story's plan: the page reads the controller's plain reason and offers only the step that
// works, which sends the idea text the director edited.
test('a story the code moved past offers Close and send as a new idea with the idea to edit, and no Start', async () => {
  const user = userEvent.setup();
  controller.command = url => (url.endsWith('/send-as-idea') ? { ok: true, closed: 'T-1', runId: 'run-9' } : {});
  const task = decisionStates['a story the code moved past']!(controller);
  open(task);
  const region = await decisions();
  expect(region.getByText(outdatedReason)).toBeTruthy();
  const send = row(region).getByRole('button', { name: 'Close and send as a new idea' });
  expect(isPrimary(send)).toBe(true);
  expect(region.queryByRole('button', { name: 'Start assignment' })).toBeNull();
  expect(region.queryByRole('button', { name: 'Allow and continue' })).toBeNull();
  expect(region.queryByRole('button', { name: 'Edit the file list' })).toBeNull();
  // No file names or record names in what the director reads there.
  expect(screen.getByRole('region', { name: 'Where it stands' }).textContent).not.toMatch(/outdated|sourceStage|\.mjs/);
  await user.click(send);
  const dialog = within(await screen.findByRole('dialog', { name: 'Close and send as a new idea?' })),
    idea = dialog.getByLabelText('The new idea') as HTMLTextAreaElement;
  expect(idea.value).toBe(
    `${task.title}\n\nIt continues work an earlier story planned, which the code has since moved past.`,
  );
  await user.clear(idea);
  await user.type(idea, 'Show the route in plain words.');
  await user.click(dialog.getByRole('button', { name: 'Close and send as a new idea' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/send-as-idea',
      method: 'POST',
      body: { projectId: 'project-x', idea: 'Show the route in plain words.' },
    }),
  );
  expect(await screen.findByText(`Closed “${task.title}” and sent its work as a new idea.`)).toBeTruthy();
  expect((await screen.findByRole('link', { name: "Open the new idea's run" })).getAttribute('href')).toBe(
    '/p/project-x/runs/run-9',
  );
});

// Sent unchanged, the controller composes the idea itself, with the story's plain planned summary.
test('a story the code moved past sent with its idea unchanged leaves the idea to the controller', async () => {
  const user = userEvent.setup();
  open(decisionStates['a story the code moved past']!(controller));
  await user.click((await decisions()).getByRole('button', { name: 'Close and send as a new idea' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Close and send as a new idea?' }));
  await user.click(dialog.getByRole('button', { name: 'Close and send as a new idea' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/send-as-idea',
      method: 'POST',
      body: { projectId: 'project-x' },
    }),
  );
});

// A file request the controller would refuse as asked: its problem in plain words, and no Allow and continue.
test('a file request with a problem shows the problem and offers no Allow and continue', async () => {
  open(decisionStates['a file request outside the measured list']!(controller));
  const region = await decisions();
  expect(region.getByText(new RegExp(`cannot be allowed as asked: ${outsideMeasured}`))).toBeTruthy();
  expect(region.queryByRole('button', { name: 'Allow and continue' })).toBeNull();
  expect(region.queryByRole('button', { name: 'Edit the file list' })).toBeNull();
  expect(row(region).getByRole('button', { name: 'Start assignment' })).toBeTruthy();
});

// The stand-in's read of T-1 serves the actions given, in place of the ones the controller's rules list for its records.
const serve = (actions: TaskAction[]) => {
  const inner = fetch;
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    const answer = await inner(url, options);
    if ((options?.method ?? 'GET') !== 'GET' || url.split('?')[0] !== '/api/tasks/T-1') return answer;
    const page = (await answer.json()) as object;
    return { ...answer, json: async () => ({ ...page, actions }) };
  });
};
// One served action on T-1, with the project and any other fields it takes.
const served = (
  key: string,
  label: string,
  emphasis: TaskAction['emphasis'],
  path: string,
  { fields = [], closing = false, method = 'POST' }: Partial<Pick<TaskAction, 'fields' | 'closing' | 'method'>> = {},
): TaskAction => ({
  key,
  label,
  emphasis,
  closing,
  method,
  path,
  fields: [{ name: 'projectId', required: true, kind: 'id', value: 'project-x' }, ...fields],
});
const note = (name: string, required = false): TaskActionField => ({ name, required, kind: 'note' });

// The page draws what the controller serves, not what it would work out from its own records.
test('the page draws exactly the served actions, in their order, with closing ones behind More actions', async () => {
  // Ready work, which the page alone would offer Start for: served only its Close.
  serve([
    served('deny-Close this step', 'Close this step', 'quiet', '/api/tasks/T-1/deny-work', {
      fields: [note('reason')],
      closing: true,
    }),
  ]);
  open(taskFixture('T-1'));
  let region = await decisions();
  await waitFor(() => expect(names(region)).toEqual(['More actions']));
  expect(closing()).toEqual(['Close this step: It will not run; a note you add is kept with the decision.']);
  expect(region.queryByRole('button', { name: 'Start assignment' })).toBeNull();
  cleanup();
  // A result in review served with Request revision before Accept result, and no Close.
  serve([
    served('revise', 'Request revision', 'default', '/api/tasks/T-1/revise', { fields: [note('direction', true)] }),
    served('accept', 'Accept result', 'primary', '/api/tasks/T-1/accept'),
  ]);
  open(decisionStates['a result in review']!(controller));
  region = await decisions();
  await waitFor(() => expect(names(row(region))).toEqual(['Request revision', 'Accept result']));
  expect(isPrimary(region.getByRole('button', { name: 'Accept result' }))).toBe(true);
  expect(isPrimary(region.getByRole('button', { name: 'Request revision' }))).toBe(false);
  expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  expect(closing()).toEqual([]);
});

test('a served action that needs no words is sent exactly as served', async () => {
  const user = userEvent.setup();
  serve([
    served('hold', 'Release hold', 'default', '/api/tasks/T-1', {
      method: 'PATCH',
      fields: [{ name: 'hold', required: true, kind: 'boolean', value: false }],
    }),
    // An action the page has no dialog for is a plain button sending its served request.
    served('unknown-step', 'Reconcile source integration', 'default', '/api/tasks/T-1/restore-source', {
      fields: [
        { name: 'attemptId', required: true, kind: 'id', value: 'attempt-9' },
        { name: 'note', required: false, kind: 'note' },
      ],
    }),
  ]);
  open(taskFixture('T-1'));
  const region = await decisions();
  await user.click(await region.findByRole('button', { name: 'Release hold' }));
  await waitFor(() =>
    expect(posted()).toEqual([
      { url: '/api/tasks/T-1', method: 'PATCH', body: { projectId: 'project-x', hold: false } },
    ]),
  );
  await user.click(region.getByRole('button', { name: 'Reconcile source integration' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/restore-source',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'attempt-9' },
    }),
  );
});

test("a served action with a dialog opens it as before and sends the director's words to the served route", async () => {
  const user = userEvent.setup();
  // Past its limit as the controller counts it, which the page's own count of a fresh task would not be.
  serve([
    served('start-past-limit', 'Start assignment', 'primary', '/api/tasks/T-1/start', {
      fields: [note('direction')],
    }),
    served('revise', 'Request revision', 'default', '/api/tasks/T-1/revise', { fields: [note('direction', true)] }),
  ]);
  open(taskFixture('T-1'));
  const region = await decisions();
  await user.click(await region.findByRole('button', { name: 'Start assignment' }));
  let dialog = await again();
  expect(posted()).toEqual([]);
  await user.type(dialog.getByLabelText('Note for the next attempt (optional)'), 'Fix the failing test first.');
  await user.click(dialog.getByRole('button', { name: 'Start assignment' }));
  await waitFor(() =>
    expect(posted()).toEqual([
      {
        url: '/api/tasks/T-1/start',
        method: 'POST',
        body: { projectId: 'project-x', direction: 'Fix the failing test first.' },
      },
    ]),
  );
  await user.click(region.getByRole('button', { name: 'Request revision' }));
  dialog = await revision();
  await user.type(dialog.getByLabelText('What to change'), 'Name the route.');
  await user.click(dialog.getByRole('button', { name: 'Request revision' }));
  await waitFor(() =>
    expect(posted().at(-1)).toEqual({
      url: '/api/tasks/T-1/revise',
      method: 'POST',
      body: { projectId: 'project-x', direction: 'Name the route.' },
    }),
  );
});

// The question card's box that answers it shows only where the controller serves Answer.
test('a waiting question shows its answer box only where the served actions include it', async () => {
  const task = decisionStates['a waiting question']!(controller);
  serve([]);
  open(task);
  const card = await screen.findByRole('article', { name: /'s question$/ });
  await decisions();
  expect(
    within(card)
      .queryAllByRole('button')
      .filter(button => (button as HTMLButtonElement).type === 'submit'),
  ).toEqual([]);
  cleanup();
  controller = fakeController();
  open(decisionStates['a waiting question']!(controller));
  const asked = await screen.findByRole('article', { name: /'s question$/ });
  await waitFor(() =>
    expect(
      within(asked)
        .getAllByRole('button')
        .filter(button => (button as HTMLButtonElement).type === 'submit')
        .map(button => button.textContent?.trim()),
    ).toEqual(['Send to Eli']),
  );
});
