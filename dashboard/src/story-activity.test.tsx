// A story's Activity as one folding chapter per attempt: the latest open, the earlier ones folded to a line naming
// the attempt, who ran it and how it ended. An open chapter ends with what its attempt handed back, a review's with its
// verdict, and a folded one reads nothing. The review tile opens the review's chapter; there is no Review tab.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

const open = () =>
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/tasks/T-1'] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
const detailOf = (id: string) => `/api/attempts/${id}?projectId=project-x`;
const build = (id: string, startedAt: string, finishedAt: string, extra: Partial<AttemptSummary> = {}) => ({
  id,
  taskId: 'T-1',
  status: 'failed',
  workerId: 'W-1',
  provider: 'claude',
  requestedModel: 'opus',
  startedAt,
  finishedAt,
  assignment: { kind: 'studio-development:change' },
  artifacts: [],
  ...extra,
});

// A code story with two builds, the second its candidate, and Morgan's review of it, which passed with notes.
const reviewed = () => {
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Fold the chapters',
      kind: 'studio-development:change',
      status: 'review',
      lastAttemptId: 'attempt-review',
      proposedTaskIds: ['T-2'],
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'candidate-review',
        current: 'review',
        candidate: { attemptId: 'attempt-2' },
        review: { attemptId: 'attempt-review', workerId: 'W-2' },
        history: [],
      },
    }),
    taskFixture('T-2', { title: 'Make the attempt strip', status: 'backlog' }),
  ];
  controller.attempts = [
    build('attempt-1', '2026-10-28T10:00:00.000Z', '2026-10-28T10:20:00.000Z', {
      error: 'The candidate did not pass its tests.',
      result: { outcome: 'failed', summary: 'First try.' },
    }),
    build('attempt-2', '2026-10-28T10:30:00.000Z', '2026-10-28T10:50:00.000Z', {
      status: 'accepted',
      requestedEffort: 'high',
      configuration: { mode: 'workspace' },
      continueFrom: { attemptId: 'attempt-1', files: [{ path: 'src/a.mjs' }] },
      setAside: [{ path: 'src/b.mjs', reason: 'The current source deleted src/b.mjs since.' }],
      artifacts: [{ path: 'notes.md', hash: 'h-notes', kind: 'work-file' }],
      // The checks it reported, which the compact record's type leaves out.
      result: {
        outcome: 'completed',
        summary: 'Second try, folded.',
        issues: ['I could not check the layout in a browser.'],
        checks: [{ name: 'Focused tests', status: 'pass', evidence: '12 of 12 passed.' }],
      } as AttemptSummary['result'],
    }),
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-2',
      startedAt: '2026-10-28T11:00:00.000Z',
      finishedAt: '2026-10-28T11:10:00.000Z',
      assignment: { kind: 'studio-development:change-review' },
      candidateReviewVerdict: 'pass',
      candidateReviewFindings: [],
      candidateReviewNotes: ['src/a.mjs (around line 12): One comment runs long.'],
      result: { outcome: 'completed', summary: 'The change holds up.' },
    },
  ];
  controller.artifacts['attempt-2/notes.md'] = '# Notes\n\nFolded.';
  controller.details['attempt-2'] = {
    result: {
      outcome: 'completed',
      summary: 'Second try, folded.',
      issues: ['I could not check the layout in a browser.'],
      checks: [{ name: 'Focused tests', status: 'pass', evidence: '12 of 12 passed.' }],
      handoff: 'Strip the attempts next.',
    },
    employeeTestRuns: [
      { startedAt: '2026-10-28T10:40:00Z', files: [], exitCode: 0, totals: { pass: 8, fail: 0, tests: 8 } },
    ],
    phaseEvents: [
      {
        attempt_id: 'attempt-2',
        task_id: 'T-1',
        payload: {
          schemaVersion: 'source-phase-v1',
          attemptId: 'attempt-2',
          taskId: 'T-1',
          occurrenceId: 'o-1',
          phaseId: 'test',
          boundary: 'start',
          timestamp: '2026-10-28T10:41:00Z',
        },
      },
      {
        attempt_id: 'attempt-2',
        task_id: 'T-1',
        payload: {
          schemaVersion: 'source-phase-v1',
          attemptId: 'attempt-2',
          taskId: 'T-1',
          occurrenceId: 'o-1',
          phaseId: 'test',
          boundary: 'finish',
          durationMs: 4200,
          outcome: 'succeeded',
          totals: { pass: 12, fail: 0, cancelled: 0, tests: 12 },
        },
      },
    ],
  };
};
// The story's Activity tab, opened, and its chapters in the order they show.
const activity = async () => {
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }, { timeout: 5000 }));
  const panel = await screen.findByRole('tabpanel');
  await within(panel).findByRole('region', { name: 'Review' }, { timeout: 5000 });
  return { user, panel };
};
const chapters = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLElement>('section.sd-attemptfold')];
const lineOf = (chapter: HTMLElement) => within(chapter).getAllByRole('button')[0]!;
const expanded = (panel: HTMLElement) => chapters(panel).map(item => lineOf(item).getAttribute('aria-expanded'));

test('a code story lists a chapter for each attempt in start order, the latest open and the earlier ones one line each', async () => {
  reviewed();
  const { panel } = await activity();
  expect(chapters(panel).map(item => item.getAttribute('aria-label'))).toEqual([
    'Build, attempt 1 of 3',
    'Build, attempt 2 of 3',
    'Review',
  ]);
  expect(expanded(panel)).toEqual(['false', 'false', 'true']);
  // A folded chapter is its line alone: the attempt, who ran it and how it ended.
  const [first, second] = chapters(panel);
  expect(first!.children).toHaveLength(1);
  expect(lineOf(first!).textContent).toBe('Build, attempt 1 of 3 · EliFailed');
  expect(lineOf(second!).textContent).toBe('Build, attempt 2 of 3 · EliAccepted');
  expect(within(panel).queryByText('First try.')).toBeNull();
  expect(lineOf(chapters(panel)[2]!).textContent).toBe('Review · MorganPassed');
});

test('clicking a folded line opens its chapter, and clicking an open chapter’s line folds it', async () => {
  reviewed();
  const { user, panel } = await activity(),
    first = within(panel).getByRole('region', { name: 'Build, attempt 1 of 3' });
  await user.click(lineOf(first));
  expect(lineOf(first).getAttribute('aria-expanded')).toBe('true');
  expect(await within(first).findByText('First try.')).toBeTruthy();
  expect(within(first).getByText('The candidate did not pass its tests.')).toBeTruthy();
  await user.click(lineOf(first));
  expect(lineOf(first).getAttribute('aria-expanded')).toBe('false');
  expect(within(first).queryByText('First try.')).toBeNull();
  // The latest folds the same way.
  const review = within(panel).getByRole('region', { name: 'Review' });
  await user.click(lineOf(review));
  expect(expanded(panel)).toEqual(['false', 'false', 'false']);
});

test('an open build chapter says what it ran on and ends with everything it handed back', async () => {
  reviewed();
  const { user, panel } = await activity(),
    second = within(panel).getByRole('region', { name: 'Build, attempt 2 of 3' });
  await user.click(lineOf(second));
  const chapter = within(second);
  // Who ran it on what, when and for how long, as its Attempts row says.
  expect(chapter.getByText(/opus, high effort · workspace · .+ to .+ · 20 min$/)).toBeTruthy();
  expect(await chapter.findByText('Strip the attempts next.', {}, { timeout: 5000 })).toBeTruthy();
  const at = (words: string) => (second.textContent ?? '').indexOf(words);
  const parts = [
    'What it handed back',
    'Second try, folded.',
    'Files it returned',
    'The checks it reported',
    'Focused tests',
    'What it raised',
    'I could not check the layout in a browser.',
    'What it handed on to the next step',
    'Strip the attempts next.',
    'The work it proposed',
    'Make the attempt strip',
    "Eli's own test runs",
    'How its time went',
    'Continued from attempt-1: src/a.mjs',
    'Git set src/b.mjs aside for the editor',
  ];
  expect(parts.filter(words => at(words) < 0)).toEqual([]);
  expect(parts.map(at)).toEqual(parts.map(at).sort((a, b) => a - b));
  // The files it returned are in the file viewer, the first one open.
  expect(chapter.getByRole('list', { name: 'Files' })).toBeTruthy();
  expect(await chapter.findByRole('heading', { name: 'Notes' })).toBeTruthy();
  expect(chapter.getByRole('region', { name: "Eli's test runs" })).toBeTruthy();
  expect(chapter.getByText('4.2s')).toBeTruthy();
  // Its summary shows once, at its end, not again as the hand-off of its log.
  expect(chapter.getAllByText('Second try, folded.')).toHaveLength(1);
  // The work the story proposed is the accepted build's, not the first build's.
  const first = within(panel).getByRole('region', { name: 'Build, attempt 1 of 3' });
  await user.click(lineOf(first));
  expect(await within(first).findByText('First try.')).toBeTruthy();
  expect(within(first).queryByText('The work it proposed')).toBeNull();
});

test("a review's chapter ends with its verdict, findings and notes", async () => {
  reviewed();
  controller.attempts[2] = {
    ...controller.attempts[2]!,
    candidateReviewVerdict: 'needs-work',
    candidateReviewFindings: ['src/a.mjs:4: The fold forgets its state.'],
  };
  const { panel } = await activity(),
    review = within(within(panel).getByRole('region', { name: 'Review' }));
  expect(review.getByText('Its verdict')).toBeTruthy();
  expect(review.getByText('Morgan asked for changes')).toBeTruthy();
  expect(review.getByText('1 blocking finding')).toBeTruthy();
  expect(review.getByText('The change holds up.')).toBeTruthy();
  expect(review.getByText('Blocking findings')).toBeTruthy();
  expect(review.getByText('The fold forgets its state.')).toBeTruthy();
  expect(review.getByText('Notes, not blocking')).toBeTruthy();
  expect(review.getByText('(around line 12) One comment runs long.')).toBeTruthy();
  expect(review.queryByText('What it handed back')).toBeNull();
});

test("a running attempt's chapter is open and shows its live activity", async () => {
  reviewed();
  controller.tasks[0] = {
    ...controller.tasks[0]!,
    status: 'running',
    lastAttemptId: 'attempt-3',
    sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'implementing', history: [] },
  };
  controller.attempts = [
    controller.attempts[0]!,
    build('attempt-3', '2026-10-28T12:00:00.000Z', '', {
      status: 'running',
      finishedAt: null,
      continueFrom: { attemptId: 'attempt-1', files: [{ path: 'src/a.mjs' }] },
    }),
  ];
  controller.traces['attempt-3'] = {
    schemaVersion: 'attempt-trace-v1',
    attemptId: 'attempt-3',
    taskId: 'T-1',
    provider: 'claude',
    status: 'running',
    source: 'activity-file',
    lines: 1,
    counts: { say: 1 },
    steps: [{ seq: 0, at: '2026-10-28T12:01:00.000Z', kind: 'say', text: 'Folding the chapters now.' }],
    phases: [],
    handoff: null,
  };
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }, { timeout: 5000 }));
  const panel = await screen.findByRole('tabpanel'),
    live = await within(panel).findByRole('region', { name: 'Build, attempt 2 of 3' }, { timeout: 5000 });
  expect(lineOf(live).getAttribute('aria-expanded')).toBe('true');
  expect(lineOf(live).textContent).toContain('Running');
  const chapter = within(live);
  expect(chapter.getByText(/^Eli is working on it now\./)).toBeTruthy();
  expect(chapter.getByText('Continued from attempt-1: src/a.mjs')).toBeTruthy();
  expect(await chapter.findByText('Folding the chapters now.')).toBeTruthy();
  expect(chapter.getByLabelText('Working')).toBeTruthy();
  expect(chapter.queryByText('What it handed back')).toBeNull();
});

for (const phone of [false, true])
  test(`a code story has no Review tab, and the review tile opens Activity at the review's chapter${phone ? ', on a phone too' : ''}`, async () => {
    const user = userEvent.setup(),
      scrolled = vi.fn();
    width(phone);
    Element.prototype.scrollIntoView = scrolled;
    try {
      reviewed();
      open();
      const tablist = await screen.findByRole('tablist', { name: 'Story details' }, { timeout: 5000 });
      expect(within(tablist).queryByRole('tab', { name: 'Review' })).toBeNull();
      // On a phone Checks no longer repeats the review.
      await user.click(within(tablist).getByRole('tab', { name: 'Checks' }));
      expect(within(screen.getByRole('tabpanel')).queryByText('Morgan passed it')).toBeNull();
      // The review folded, as the director left it, opens again from the tile.
      await user.click(within(tablist).getByRole('tab', { name: 'Activity' }));
      const folded = await within(screen.getByRole('tabpanel')).findByRole('region', { name: 'Review' });
      await user.click(lineOf(folded));
      await user.click(within(tablist).getByRole('tab', { name: 'Changes' }));
      await user.click(document.querySelectorAll<HTMLElement>('.sd-tiles .sd-tile')[2]!);
      expect(within(tablist).getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
      const review = await within(screen.getByRole('tabpanel')).findByRole('region', { name: 'Review' });
      expect(lineOf(review).getAttribute('aria-expanded')).toBe('true');
      expect(within(review).getByText('Morgan passed it')).toBeTruthy();
      await waitFor(() => expect(scrolled.mock.contexts).toContain(review));
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

test("a folded chapter does not read its attempt's full record; opening it does", async () => {
  reviewed();
  const { user, panel } = await activity();
  await waitFor(() => expect(controller.reads()).toContain(detailOf('attempt-2')));
  expect(controller.reads()).not.toContain(detailOf('attempt-1'));
  await user.click(lineOf(within(panel).getByRole('region', { name: 'Build, attempt 1 of 3' })));
  await waitFor(() => expect(controller.reads()).toContain(detailOf('attempt-1')));
});
