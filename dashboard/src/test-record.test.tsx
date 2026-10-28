// A measured test run's whole record, read-only (src/connectors/test-records.mjs): from the attempt's record for the
// checks before a breakdown and a story's candidate tests, and from the story's merge. It is closed and reads nothing
// until opened; then the failed tests and totals come before the whole output, and nothing in it changes a record.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, Task, TestRecordRun, TestRecordSummary } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';
import { WholeTestRecord } from './test-record';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const open = (task: Task) => {
  controller.tasks = [task];
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [`/p/project-x/tasks/${task.id}`] }))}
      queryClient={client()}
      createStream={createStream}
    />,
  );
};
const recordReads = () => controller.reads().filter(url => url.includes('/test-record'));
const changes = () => controller.requests.filter(request => request.method !== 'GET');
const testLog = { path: 'test-output.txt', hash: 'h-tests', kind: 'test-log' };
const output = 'TAP version 13\nnot ok 1 - the door opens\n# tests 12\n# pass 11\n# fail 1\n';
const measured = (
  run: TestRecordRun,
  extra: Partial<Extract<TestRecordSummary, { recorded: true }>> = {},
): TestRecordSummary => ({
  recorded: true,
  run,
  bytes: 2048,
  limited: false,
  totals: { tests: 12, pass: 11, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
  failedTests: [
    {
      name: 'the door opens',
      file: 'door.test.mjs',
      error: 'Expected values to be strictly equal: false !== true',
    },
  ],
  ...extra,
});
// The disclosure titled `title`, once its holder has shown it, still closed.
const disclosure = async (title: string) => {
  const details = (await screen.findByText(title)).closest('details')!;
  expect(details.open).toBe(false);
  return details;
};
// Opens it and waits for the whole output; the failed tests, then the totals, come before it.
const opened = async (user: ReturnType<typeof userEvent.setup>, details: HTMLElement, title: string) => {
  await user.click(within(details).getByText(title));
  const viewer = within(details),
    whole = await viewer.findByLabelText('The whole output'),
    failed = viewer.getByRole('list', { name: 'Failed tests' }),
    totals = viewer.getByText(/passed, \d+ failed/);
  expect(failed.compareDocumentPosition(totals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(totals.compareDocumentPosition(whole) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  return { viewer, whole, failed: within(failed), totals };
};

// A source story whose candidate tests ran, at its review; with a review attempt, at its integration.
const pin = {
  taskId: 'T-story',
  attemptId: 'attempt-edit',
  workerId: 'W-1',
  path: 'source-change.json',
  hash: 'change-hash',
  candidateHash: 'candidate-hash',
};
const candidate = (): AttemptSummary => ({
  id: 'attempt-edit',
  taskId: 'T-story',
  status: 'review',
  workerId: 'W-1',
  assignment: { kind: 'studio-development:change' },
  result: { outcome: 'completed', summary: 'Opens the door.' },
  sourceCandidate: { sourceHash: 'candidate-hash' },
  artifacts: [{ path: 'source-change.json', hash: 'change-hash', kind: 'source-change' }, testLog],
});
const story = (extra: Partial<Task> = {}) =>
  taskFixture('T-story', {
    title: 'Open the door',
    kind: 'studio-development:change',
    status: 'review',
    lastAttemptId: 'attempt-edit',
    sourceStage: {
      version: 'source-story-stages-v1',
      phase: 'candidate-review',
      current: 'candidate-review',
      history: [],
      candidate: pin,
    },
    ...extra,
  });

test("a candidate's record opens its tests' whole record only when asked, failed tests and totals first", async () => {
  const user = userEvent.setup();
  controller.attempts = [candidate()];
  controller.testRecords['attempt-edit/attempt'] = { summary: measured('attempt'), text: output };
  open(story());
  await user.click(await screen.findByRole('tab', { name: 'Record' }));
  const record = within(screen.getByRole('tabpanel'));
  await user.click(record.getByText("The attempt's whole record"));
  const details = await disclosure("The tests' whole record");
  // Closed, it has read nothing.
  expect(recordReads()).toEqual([]);
  const { viewer, whole, failed, totals } = await opened(user, details, "The tests' whole record");
  expect(failed.getByText('the door opens')).toBeTruthy();
  expect(failed.getByText(/door\.test\.mjs/)).toBeTruthy();
  expect(failed.getByText(/Expected values to be strictly equal: false !== true/)).toBeTruthy();
  expect(totals.textContent).toBe('11/12 passed, 1 failed');
  // The whole output reads in place, read-only, and downloads from the same route.
  expect(whole.tagName).toBe('PRE');
  expect(whole.className).toBe('sd-code sd-code--block');
  expect(whole.getAttribute('contenteditable')).toBeNull();
  expect(whole.textContent).toBe(output);
  expect(viewer.getByRole('link', { name: 'Download the whole output' }).getAttribute('href')).toBe(
    '/api/attempts/attempt-edit/test-record/text?projectId=project-x&run=attempt',
  );
  expect(viewer.queryByText(/64 MB/)).toBeNull();
  expect(recordReads()).toEqual([
    '/api/attempts/attempt-edit/test-record?projectId=project-x&run=attempt',
    '/api/attempts/attempt-edit/test-record/text?projectId=project-x&run=attempt',
  ]);
});

test('the checks before a breakdown open their own run, and an attempt without a test log shows no viewer', async () => {
  const user = userEvent.setup();
  controller.attempts = [
    {
      id: 'attempt-checks',
      taskId: 'T-checks',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:checks' },
      result: { outcome: 'completed', summary: 'Measured source checks: 11/12 tests passed.' },
      artifacts: [
        { path: 'check-report.json', hash: 'h-report', kind: 'source-check-report' },
        testLog,
        { path: 'test-errors.txt', hash: 'h-errors', kind: 'test-log' },
      ],
    },
  ];
  controller.testRecords['attempt-checks/attempt'] = { summary: measured('attempt'), text: output };
  open(
    taskFixture('T-checks', {
      kind: 'studio-development:checks',
      status: 'done',
      lastAttemptId: 'attempt-checks',
      acceptedAttemptId: 'attempt-checks',
    }),
  );
  await user.click(await screen.findByRole('tab', { name: 'Record' }));
  await user.click(within(screen.getByRole('tabpanel')).getByText("The attempt's whole record"));
  const details = await disclosure("The tests' whole record");
  expect(recordReads()).toEqual([]);
  const { failed } = await opened(user, details, "The tests' whole record");
  expect(failed.getByText('the door opens')).toBeTruthy();
  expect(recordReads()).toEqual([
    '/api/attempts/attempt-checks/test-record?projectId=project-x&run=attempt',
    '/api/attempts/attempt-checks/test-record/text?projectId=project-x&run=attempt',
  ]);
  cleanup();
  // A breakdown registered no test log of its own, so its record offers none.
  controller.attempts = [
    {
      id: 'attempt-breakdown',
      taskId: 'T-breakdown',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:breakdown' },
      result: { outcome: 'completed', summary: 'Two stories.' },
      artifacts: [{ path: 'source-breakdown.json', hash: 'h-breakdown', kind: 'source-breakdown' }],
    },
  ];
  open(
    taskFixture('T-breakdown', {
      kind: 'studio-development:breakdown',
      status: 'done',
      lastAttemptId: 'attempt-breakdown',
      acceptedAttemptId: 'attempt-breakdown',
    }),
  );
  await user.click(await screen.findByRole('tab', { name: 'Record' }));
  // Its full record has loaded, and offers no whole test record.
  expect(await screen.findByText('How its time went')).toBeTruthy();
  expect(screen.queryByText("The tests' whole record")).toBeNull();
  expect(controller.reads().some(url => url.startsWith('/api/attempts/attempt-breakdown?'))).toBe(true);
  expect(recordReads().filter(url => url.includes('attempt-breakdown'))).toEqual([]);
});

test("the story's integration journal opens the merge's whole test record for its review attempt", async () => {
  const user = userEvent.setup();
  controller.attempts = [
    { ...candidate(), status: 'accepted' },
    {
      id: 'attempt-review',
      taskId: 'T-story',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change-review' },
      result: { outcome: 'completed' },
      candidateReviewVerdict: 'pass',
      sourceIntegration: {
        state: 'rejected',
        method: 'merge',
        verification: { totals: { pass: 40, tests: 41 } },
      } as AttemptSummary['sourceIntegration'],
      artifacts: [{ path: 'source-change-review.json', hash: 'review-hash', kind: 'source-change-review' }],
    },
  ];
  controller.testRecords['attempt-review/merge'] = {
    summary: measured('merge', {
      totals: { tests: 41, pass: 40, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
      failedTests: [{ name: 'the hinge holds', file: 'hinge.test.mjs', error: 'Expected 1 to be 2' }],
    }),
    text: 'not ok 7 - the hinge holds\n# tests 41\n',
  };
  open(
    story({
      status: 'done',
      lastAttemptId: 'attempt-review',
      acceptedAttemptId: 'attempt-review',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'integration',
        current: 'failed',
        candidate: pin,
        review: {
          taskId: 'T-story',
          attemptId: 'attempt-review',
          workerId: 'W-1',
          hash: 'review-hash',
          verdict: 'pass',
        },
      },
    }),
  );
  await user.click(await screen.findByRole('tab', { name: 'Record' }));
  const details = await disclosure("The merge's whole test record");
  // It sits beside the recorded integration, and has read nothing.
  expect(details.previousElementSibling?.querySelector('summary')?.textContent).toBe('Recorded source integration');
  expect(recordReads()).toEqual([]);
  const { whole, failed, totals } = await opened(user, details, "The merge's whole test record");
  expect(failed.getByText('the hinge holds')).toBeTruthy();
  expect(failed.getByText(/hinge\.test\.mjs/)).toBeTruthy();
  expect(failed.getByText(/Expected 1 to be 2/)).toBeTruthy();
  expect(totals.textContent).toBe('40/41 passed, 1 failed');
  expect(whole.textContent).toBe('not ok 7 - the hinge holds\n# tests 41\n');
  expect(recordReads()).toEqual([
    '/api/attempts/attempt-review/test-record?projectId=project-x&run=merge',
    '/api/attempts/attempt-review/test-record/text?projectId=project-x&run=merge',
  ]);
});

// The viewer on its own, as an editor's saved test runs could open it.
const alone = (attemptId = 'attempt-1', run: TestRecordRun = 'attempt') => {
  render(
    <QueryClientProvider client={client()}>
      <WholeTestRecord projectId="project-x" attemptId={attemptId} run={run} />
    </QueryClientProvider>,
  );
  return screen.getByText(run === 'merge' ? "The merge's whole test record" : "The tests' whole record");
};

test('a run with no whole record says so and reads no text', async () => {
  const user = userEvent.setup();
  controller.testRecords['attempt-1/merge'] = { summary: { recorded: false, run: 'merge' } };
  await user.click(alone('attempt-1', 'merge'));
  expect(
    await screen.findByText(
      'This run has no whole record: it ran before Studio desk kept them, or stopped before its tests started.',
    ),
  ).toBeTruthy();
  expect(screen.queryByLabelText('The whole output')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(recordReads()).toEqual(['/api/attempts/attempt-1/test-record?projectId=project-x&run=merge']);
});

test('a run that stopped before its totals says so, and a record at its limit says where it stops', async () => {
  const user = userEvent.setup();
  controller.testRecords['attempt-1/attempt'] = {
    summary: measured('attempt', { totals: null, failedTests: [], limited: true, bytes: 64 * 1024 * 1024 + 47 }),
    text: 'TAP version 13\n# The record stops here, at its 64 MB limit.\n',
  };
  await user.click(alone());
  expect(await screen.findByText('Stopped before reporting totals')).toBeTruthy();
  expect(
    screen.getByText('This record stops at its 64 MB limit: the run printed more than Studio desk keeps.'),
  ).toBeTruthy();
  expect(screen.getByText('The whole output · 64.0 MB')).toBeTruthy();
  // No test failed before it stopped, so there is no list of them.
  expect(screen.queryByRole('list', { name: 'Failed tests' })).toBeNull();
  expect((await screen.findByLabelText('The whole output')).textContent).toMatch(/at its 64 MB limit/);
});

test("a record the controller refuses is shown in words, and the viewer's text failing still offers the download", async () => {
  const user = userEvent.setup();
  await user.click(alone('attempt-2'));
  expect(
    await screen.findByText('The whole record could not be loaded: This attempt ran no measured tests.'),
  ).toBeTruthy();
  cleanup();
  controller.testRecords['attempt-3/attempt'] = { summary: measured('attempt') };
  await user.click(alone('attempt-3'));
  expect(
    await screen.findByText(
      'The whole output could not be loaded: This run has no whole record. Download it to read the record.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Download the whole output' })).toBeTruthy();
});

test('the viewer offers no control that changes a record', async () => {
  const user = userEvent.setup();
  controller.testRecords['attempt-1/attempt'] = { summary: measured('attempt'), text: output };
  const title = alone();
  await user.click(title);
  const details = title.closest('details')!;
  await within(details).findByLabelText('The whole output');
  // Only the summary line opens and closes it; the one link reads the same text.
  expect(details.querySelectorAll('button, input, textarea, select, form')).toHaveLength(0);
  expect(Array.from(details.querySelectorAll('a')).map(link => link.getAttribute('href'))).toEqual([
    '/api/attempts/attempt-1/test-record/text?projectId=project-x&run=attempt',
  ]);
  await user.click(title);
  expect(details.open).toBe(false);
  await user.click(title);
  expect(changes()).toEqual([]);
  // Opened again, it reads nothing more.
  expect(recordReads()).toEqual([
    '/api/attempts/attempt-1/test-record?projectId=project-x&run=attempt',
    '/api/attempts/attempt-1/test-record/text?projectId=project-x&run=attempt',
  ]);
});
