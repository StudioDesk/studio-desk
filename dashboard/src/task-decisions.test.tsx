// What the director can decide on a story's page: the buttons the current dashboard offers in the same states,
// under "Where it stands", each asking the controller for one recorded step; a note or a reason is asked for in a
// dialog.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, Task } from './api';
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
  expect(names(region)).toEqual([
    'Merge onto the current source',
    'Integrate again',
    'Send back to Eli',
    'Close without integrating',
  ]);
  await user.click(region.getByRole('button', { name: 'Merge onto the current source' }));
  await merged();
});

// October 27: a change that passed its own tests and fails only merged onto what landed since it was tested.
test('a story that fails only with what landed since says so, links what landed and offers Merge first', async () => {
  const user = userEvent.setup();
  controller.tasks = [taskFixture('T-2', { title: 'Name the stage in plain words' })];
  open(stoppedStory({ landedSince: { commits: 2, stories: ['T-2'] } }));
  const region = await decisions();
  expect(names(region)).toEqual([
    'Merge onto the current source',
    'Integrate again',
    'Send back to Eli',
    'Close without integrating',
  ]);
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
  expect(names(region)).toEqual(['Integrate again', 'Send back to Eli', 'Close without integrating']);
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
const backReads = () => controller.reads().filter(url => url.includes('/bring-back')),
  toast = () => screen.getByRole('status', { hidden: true });

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
  expect(names(await decisions())).toEqual(['Integrate', 'Send back to Eli', 'Close without integrating']);
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
