// Everything recorded about an attempt is a page of its own, where the story's Record tab was: the Details card links
// to it for the attempt shown (the latest, or the one chosen in the strip), and it shows what the tab showed. No story
// has a Record tab, on a wide screen or on a phone.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x/tasks/T-1') => {
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
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
const linkName = 'Everything recorded about this attempt';
const detailsCard = () => screen.findByRole('region', { name: 'Details' }, { timeout: 5000 });
const recordLink = async () => within(await detailsCard()).getByRole('link', { name: linkName });
const recordOf = () => screen.findByRole('region', { name: 'The record' }, { timeout: 5000 });
const tabNames = async () =>
  within(await screen.findByRole('tablist', { name: 'Story details' }, { timeout: 5000 }))
    .getAllByRole('tab')
    .map(tab => tab.firstChild?.textContent);

const build = (id: string, at: string, extra: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id,
  taskId: 'T-1',
  projectId: 'project-x',
  status: 'accepted',
  workerId: 'W-1',
  provider: 'claude',
  startedAt: `2026-10-28T${at}:00.000Z`,
  finishedAt: `2026-10-28T${at}:20.000Z`,
  assignment: { kind: 'studio-development:change' },
  result: { outcome: 'completed', summary: `Build ${id}.` },
  artifacts: [
    { path: 'result.json', kind: 'result', hash: `${id}-result` },
    { path: 'source-change.json', kind: 'source-change', hash: `${id}-manifest` },
    { path: 'change.diff', kind: 'source-change-diff', hash: `${id}-diff` },
    { path: 'changes/src/door.mjs', kind: 'source-file', hash: `${id}-door` },
  ],
  ...extra,
});
// A code story with two builds, the second its candidate, and Morgan's review of it, which passed; its change
// landed when `landed`.
const story = (landed = false) => {
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Open the door',
      kind: 'studio-development:change',
      status: landed ? 'done' : 'review',
      maxAttempts: 3,
      resources: ['repository:studio-desk'],
      lastAttemptId: 'attempt-review',
      ...(landed ? { acceptedAttemptId: 'attempt-review' } : {}),
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: landed ? 'integration' : 'candidate-review',
        current: landed ? 'integrated' : 'review',
        candidate: {
          taskId: 'T-1',
          attemptId: 'attempt-2',
          workerId: 'W-1',
          path: 'source-change.json',
          hash: 'attempt-2-manifest',
          candidateHash: 'candidate-hash-2',
        },
        review: { attemptId: 'attempt-review', workerId: 'W-2', verdict: 'pass' },
        history: [],
      },
    }),
    taskFixture('T-0', { title: 'Plan the stories', status: 'done', workerId: 'W-1' }),
  ];
  controller.attempts = [
    build('attempt-1', '10:00'),
    build('attempt-2', '11:00', {
      inputReferences: [{ taskId: 'T-0', attemptId: 'attempt-0' }],
      sourceCandidate: { sourceHash: 'candidate-hash-2' },
    }),
    {
      id: 'attempt-review',
      taskId: 'T-1',
      projectId: 'project-x',
      status: 'accepted',
      workerId: 'W-2',
      startedAt: '2026-10-28T12:00:00.000Z',
      finishedAt: '2026-10-28T12:10:00.000Z',
      assignment: { kind: 'studio-development:change-review' },
      candidateReviewVerdict: 'pass',
      result: { outcome: 'completed', summary: 'The change holds up.' },
      artifacts: [{ path: 'source-change-review.json', kind: 'source-change-review', hash: 'review-hash' }],
      ...(landed
        ? {
            sourceIntegration: {
              state: 'integrated',
              method: 'merge',
              repository: { commit: 'abc1234def', branch: 'main' },
            } as AttemptSummary['sourceIntegration'],
          }
        : {}),
    },
  ];
  controller.details['attempt-2'] = {
    sessionId: 'session-2',
    instructions: { hash: 'instructions-hash-2', text: 'You are Eli, the engineer.' },
    inputReferences: [
      {
        taskId: 'T-0',
        attemptId: 'attempt-0',
        summary: 'Two stories, the door first.',
        artifacts: [{ path: '../inputs/T-0/0-plan.json', hash: 'h-plan', kind: 'source-breakdown' }],
      },
    ],
  };
  controller.details['attempt-review'] = {
    sessionId: 'session-review',
    instructions: { hash: 'instructions-hash-review', text: 'You are Morgan, the reviewer.' },
  };
};

test("the Details card links to the latest attempt's record, and to the chosen attempt's once a chip is picked", async () => {
  const user = userEvent.setup();
  story();
  open();
  expect((await recordLink()).getAttribute('href')).toBe('/p/project-x/tasks/T-1/attempts/attempt-review/record');
  const strip = within(await screen.findByRole('region', { name: 'Attempts' }));
  await user.click(strip.getAllByRole('button')[0]!);
  expect((await recordLink()).getAttribute('href')).toBe('/p/project-x/tasks/T-1/attempts/attempt-1/record');
  // Back to the latest links to the latest again.
  await user.click(
    within(screen.getByRole('region', { name: 'The attempt shown' })).getByRole('button', {
      name: 'Back to the latest',
    }),
  );
  expect((await recordLink()).getAttribute('href')).toBe('/p/project-x/tasks/T-1/attempts/attempt-review/record');
});

test('the record page shows the task, what it reserves, the attempt ids and hashes, the instructions it ran with, what it received, its files and log, and its whole record', async () => {
  const user = userEvent.setup();
  story();
  const router = open();
  await user.click(await recordLink());
  const card = await recordOf(),
    record = within(card);
  expect(router.state.location.pathname).toBe('/p/project-x/tasks/T-1/attempts/attempt-review/record');
  expect(screen.getByRole('heading', { name: linkName })).toBeTruthy();
  // Crumbs and a way back to the story.
  const crumbs = within(screen.getByRole('navigation', { name: 'You are here' }));
  expect(crumbs.getByRole('link', { name: 'T-1' }).getAttribute('href')).toBe('/p/project-x/tasks/T-1');
  expect(crumbs.getByText('Record of review')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Story' }).getAttribute('href')).toBe('/p/project-x/tasks/T-1');
  // The task and what it reserves; the build, review and candidate's ids and hashes.
  const value = (term: string) => record.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent;
  expect(value('Task')).toMatch(/^T-1 · /);
  expect(value('Reserves')).toBe('repository:studio-desk');
  expect(value('Build attempt')).toBe('attempt-2');
  expect(value('Review attempt')).toBe('attempt-review');
  expect(value('Candidate')).toBe('sha-256 candidate-hash-2');
  expect(value('Diff')).toBe('sha-256 attempt-2-diff');
  expect(record.queryByText('Attempt shown', { selector: 'dt' })).toBeNull();
  // The instructions it ran with, from its full record.
  expect(await record.findByText('instructions-hash-review')).toBeTruthy();
  await user.click(record.getByText('The instructions it ran with'));
  expect(record.getByText('You are Morgan, the reviewer.')).toBeTruthy();
  // The candidate's and the review's files, and the log.
  expect(record.getByRole('link', { name: 'source-change.json' }).getAttribute('href')).toBe(
    '/api/attempts/attempt-2/artifact?projectId=project-x&path=source-change.json',
  );
  expect(record.getByRole('link', { name: 'source-change-review.json' })).toBeTruthy();
  expect(record.queryByRole('link', { name: 'result.json' })).toBeNull();
  expect(record.getByRole('link', { name: 'Download log' }).getAttribute('href')).toBe(
    '/api/attempts/attempt-review/logs/download?projectId=project-x',
  );
  // Its whole record.
  await user.click(record.getByText("The attempt's whole record"));
  expect(await record.findByText('session-review')).toBeTruthy();
  // No integration journal before the change lands.
  expect(record.queryByText(/^Source integration/)).toBeNull();
});

test('the record page of a chosen build shows it and what it received, and a landed story its integration journal', async () => {
  const user = userEvent.setup();
  story(true);
  open('/p/project-x/tasks/T-1/attempts/attempt-2/record');
  const record = within(await recordOf());
  expect(screen.getByRole('navigation', { name: 'You are here' }).textContent).toContain(
    'Record of build, attempt 2 of 3',
  );
  expect(await record.findByText('instructions-hash-2')).toBeTruthy();
  const received = record.getByText('Received', { selector: 'dt' }).nextElementSibling!;
  expect(received.textContent).toMatch(/^.*T-0.*, each pinned by hash$/);
  await user.click(record.getByText("The attempt's whole record"));
  const from = within((await record.findByText('Received from previous steps')).closest('section')!);
  expect(from.getByText('Two stories, the door first.')).toBeTruthy();
  // The landed change's journal, from the review that holds it.
  expect(record.getByText(/^Source integration:/).textContent).toContain('integrated');
  expect(record.getByText('Recorded source integration')).toBeTruthy();
});

// The review's integration stopped, with the verification it recorded.
const rejected = (verification: NonNullable<AttemptSummary['sourceIntegration']>['verification']) => {
  story(true);
  controller.attempts[2]!.sourceIntegration = {
    state: 'rejected',
    error: 'The test run did not report complete totals.',
    verification,
  };
};
const printedLabels = [
  'What the install printed',
  'What the formatter printed',
  'What the build printed',
  'What the test run printed as errors',
];

test("a rejected integration's record shows what its steps printed, its test run's errors open", async () => {
  rejected({
    outputs: {
      format: 'Checking formatting...\nAll matched files use Prettier code style!',
      errors: 'Error: Cannot find module fixture-missing',
    },
  });
  open('/p/project-x/tasks/T-1/attempts/attempt-review/record');
  const record = within(await recordOf());
  const sentence = await record.findByText(/^Source integration:/, {}, { timeout: 5000 });
  expect(sentence.textContent).toContain('rejected');
  const errors = record.getByText('What the test run printed as errors').closest('details')!;
  expect(errors.open).toBe(true);
  expect(errors.className).toBe('sd-disclosure');
  const text = within(errors).getByText('Error: Cannot find module fixture-missing');
  expect(text.tagName).toBe('PRE');
  expect(text.className).toBe('sd-code sd-code--block sd-code--wrap');
  const format = record.getByText('What the formatter printed').closest('details')!;
  expect(format.open).toBe(false);
  expect(format.textContent).toContain('All matched files use Prettier code style!');
  // Only the steps that printed something; below the integration sentence, above the full recorded integration.
  expect(record.queryByText('What the install printed')).toBeNull();
  expect(record.queryByText('What the build printed')).toBeNull();
  const full = record.getByText(/^Recorded source integration/).closest('details')!;
  for (const shown of [format, errors]) {
    expect(sentence.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shown.compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

test('an integration that recorded no outputs shows none of them', async () => {
  rejected({ conflicts: [] });
  open('/p/project-x/tasks/T-1/attempts/attempt-review/record');
  const record = within(await recordOf());
  const sentence = await record.findByText(/^Source integration:/, {}, { timeout: 5000 });
  expect(sentence.textContent).toContain('rejected');
  expect(record.getByText(/^Recorded source integration/)).toBeTruthy();
  for (const label of printedLabels) expect(record.queryByText(label)).toBeNull();
});

test('an attempt the story does not have says so, with a way back to the story', async () => {
  story();
  open('/p/project-x/tasks/T-1/attempts/attempt-elsewhere/record');
  const alert = await screen.findByText(/This attempt is not one of the story.s\./, {}, { timeout: 5000 });
  expect(within(alert).getByRole('link', { name: 'Back to the story' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-1',
  );
  expect(screen.queryByText('Download log')).toBeNull();
  expect(controller.reads().some(url => url.startsWith('/api/attempts/attempt-elsewhere?'))).toBe(false);
});

test('a story with no attempt has no link to a record', async () => {
  controller.tasks = [taskFixture('T-1', { title: 'Not started', status: 'ready' })];
  open();
  expect(await detailsCard()).toBeTruthy();
  expect(screen.queryByRole('link', { name: linkName })).toBeNull();
});

// No story has a Record tab: a code story's wide tabs are Changes, Checks, Try it (its tests passed) and Activity,
// other work's Overview and Activity, and a phone adds Details, whose card links to the record instead of showing it.
for (const [source, phone, labels] of [
  [true, false, ['Changes', 'Checks', 'Try it', 'Activity']],
  [false, false, ['Overview', 'Activity']],
  [true, true, ['Activity', 'Changes', 'Checks', 'Try it', 'Details']],
  [false, true, ['Activity', 'Overview', 'Details']],
] as const)
  test(`${source ? "a code story's" : "other work's"} tabs${phone ? ' on a phone' : ''} are ${labels.join(', ')}`, async () => {
    const user = userEvent.setup();
    width(phone);
    if (source) story();
    else {
      controller.tasks = [
        taskFixture('T-1', { title: 'Write the guide', status: 'review', lastAttemptId: 'attempt-w' }),
      ];
      controller.attempts = [
        {
          id: 'attempt-w',
          taskId: 'T-1',
          projectId: 'project-x',
          status: 'succeeded',
          workerId: 'W-1',
          result: { outcome: 'completed', summary: 'Wrote it.' },
        },
      ];
    }
    open();
    expect(await tabNames()).toEqual(labels);
    if (!phone) return;
    await user.click(screen.getByRole('tab', { name: 'Details' }));
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByRole('link', { name: linkName }).getAttribute('href')).toBe(
      `/p/project-x/tasks/T-1/attempts/${source ? 'attempt-review' : 'attempt-w'}/record`,
    );
    expect(panel.queryByText("The attempt's whole record")).toBeNull();
    expect(panel.queryByText('Download log')).toBeNull();
  });
