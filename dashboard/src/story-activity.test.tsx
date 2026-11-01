// A story's Activity as one folding chapter per attempt: the latest open, the earlier ones folded to a line naming
// the attempt, who ran it and how it ended. An open chapter ends with what its attempt handed back, a review's with its
// verdict, and a folded one reads nothing. The review tile opens the review's chapter; there is no Review tab.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, whenShown, type Controller } from './test-controller';

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

const open = (path = '/p/project-x/tasks/T-1') =>
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
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
  await within(panel).findByText(/Morgan (passed it|asked for changes)/);
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
  expect(await chapter.findByText(/opus, high effort · workspace · .+ to .+ · 20 min$/)).toBeTruthy();
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

// The story with attempt 1 failed and attempt 3 running, whose trace so far is these steps.
const say = (seq: number, text = `Step ${seq + 1}.`) => ({
  seq,
  at: `2026-10-28T12:${String(seq + 1).padStart(2, '0')}:00.000Z`,
  kind: 'say',
  text,
});
const runningStory = (steps: object[]) => {
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
    lines: steps.length,
    counts: { say: steps.length },
    steps,
    phases: [],
    handoff: null,
  };
};

test("a running attempt's chapter is open and shows its live activity", async () => {
  runningStory([say(0, 'Folding the chapters now.')]);
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }, { timeout: 5000 }));
  const panel = await screen.findByRole('tabpanel'),
    live = await within(panel).findByRole('region', { name: 'Build, attempt 2 of 3' }, { timeout: 5000 });
  expect(lineOf(live).getAttribute('aria-expanded')).toBe('true');
  expect(lineOf(live).textContent).toContain('Running');
  const chapter = within(live);
  await chapter.findByText('Folding the chapters now.');
  expect(chapter.getByText(/^Eli is working on it now\./)).toBeTruthy();
  expect(chapter.getByText('Continued from attempt-1: src/a.mjs')).toBeTruthy();
  expect(await chapter.findByText('Folding the chapters now.')).toBeTruthy();
  expect(chapter.getByLabelText('Working')).toBeTruthy();
  expect(chapter.queryByText('What it handed back')).toBeNull();
});

// The page's scroll geometry, a stand-in where nothing lays out or scrolls: each part of an open chapter is 40px
// tall, the first 200px down the page, in a window 600px tall. Only the conversation's end, its typing dots, which
// the follower watches, takes it. window.scrollTo moves the page at once; the reader's scrolls fire a scroll event.
const part = 40,
  bodyTop = 200,
  windowHeight = 600;
let y = 0;
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
const place = (to: number) => {
  y = to;
  vi.stubGlobal('scrollY', to);
};
const dotsBottom = (dots: Element) => {
  let index = 0;
  for (let item = dots.previousElementSibling; item; item = item.previousElementSibling) index++;
  return bodyTop + (index + 1) * part;
};
// Where the page shows the newest moments at the window's bottom.
const newest = () => Math.max(0, dotsBottom(screen.getByLabelText('Working')) - windowHeight);
function stubPage() {
  place(0);
  vi.stubGlobal('innerHeight', windowHeight);
  const scrollTo = vi.fn((options: ScrollToOptions) => place(options.top ?? y));
  vi.stubGlobal('scrollTo', scrollTo);
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.getAttribute('aria-label') !== 'Working') return rect.call(this);
    const bottom = dotsBottom(this) - y;
    return { x: 0, y: bottom - part, top: bottom - part, bottom, left: 0, right: 0, width: 0, height: part } as DOMRect;
  };
  restores.push(() => (Element.prototype.getBoundingClientRect = rect));
  return scrollTo;
}
const readerScrolls = (to: number) => {
  place(to);
  fireEvent.scroll(window);
};
const newUpdates = () => screen.queryByRole('button', { name: /^New updates/ });
// The running story with twelve moments, taller than the window, its Activity open and its trace following the log.
const followRunning = async () => {
  const scrollTo = stubPage();
  runningStory(Array.from({ length: 12 }, (_, seq) => say(seq)));
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }, { timeout: 5000 }));
  const chapter = within(await screen.findByRole('region', { name: 'Build, attempt 2 of 3' }, { timeout: 5000 }));
  expect(await chapter.findByText('Step 12.', {}, { timeout: 5000 })).toBeTruthy();
  await waitFor(() => expect(latest().url).toContain('log=attempt-3'));
  let version = 10;
  // New steps from the stream: the attempt's record changed, and the trace reads the steps after the last one shown.
  const arrive = async (...seqs: number[]) => {
    controller.traces['attempt-3'] = {
      ...(controller.traces['attempt-3'] as object),
      steps: seqs.map(seq => say(seq)),
    };
    version++;
    latest().emit('change', {
      version,
      start: 'start-a',
      changes: [{ seq: version, type: 'attempt', id: 'attempt-3', taskId: 'T-1', projectId: 'project-x' }],
    });
    expect(await chapter.findByText(`Step ${seqs.at(-1)! + 1}.`, {}, { timeout: 5000 })).toBeTruthy();
  };
  return { user, scrollTo, arrive };
};

test('opening Activity on a running chapter scrolls to its newest lines, and new steps keep the newest in view with no New updates', async () => {
  const { scrollTo, arrive } = await followRunning();
  expect(newest()).toBeGreaterThan(0);
  expect(y).toBe(newest());
  expect(scrollTo.mock.calls).toContainEqual([{ top: newest(), behavior: 'auto' }]);
  await arrive(12, 13);
  expect(y).toBe(newest());
  expect(newUpdates()).toBeNull();
});

test('a reader scrolled up a running chapter keeps their place, and New updates counts the new moments and goes to the newest', async () => {
  const { user, scrollTo, arrive } = await followRunning();
  const reading = newest() - 200;
  readerScrolls(reading);
  const calls = scrollTo.mock.calls.length;
  await arrive(12, 13);
  expect(y).toBe(reading);
  expect(scrollTo.mock.calls.length).toBe(calls);
  await user.click(screen.getByRole('button', { name: 'New updates: 2' }));
  expect(y).toBe(newest());
  expect(newUpdates()).toBeNull();
  // Following again: the next step keeps the newest in view.
  await arrive(14);
  expect(y).toBe(newest());
  expect(newUpdates()).toBeNull();
});

test('scrolling a running chapter back to its newest clears New updates, and the next step follows', async () => {
  const { arrive } = await followRunning();
  readerScrolls(newest() - 200);
  await arrive(12);
  screen.getByRole('button', { name: 'New updates: 1' });
  readerScrolls(newest());
  expect(newUpdates()).toBeNull();
  await arrive(13);
  expect(y).toBe(newest());
  expect(newUpdates()).toBeNull();
});

test("a finished attempt's chapter never scrolls the page on its own and shows no New updates", async () => {
  const scrollTo = stubPage(),
    scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  restores.push(() => delete (Element.prototype as Partial<Element>).scrollIntoView);
  runningStory(Array.from({ length: 12 }, (_, seq) => say(seq)));
  controller.tasks[0] = { ...controller.tasks[0]!, status: 'failed' };
  controller.attempts[1] = { ...controller.attempts[1]!, status: 'failed', finishedAt: '2026-10-28T12:30:00.000Z' };
  controller.traces['attempt-3'] = { ...(controller.traces['attempt-3'] as object), status: 'failed' };
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }, { timeout: 5000 }));
  const chapter = within(await screen.findByRole('region', { name: 'Build, attempt 2 of 3' }, { timeout: 5000 }));
  expect(await chapter.findByText('Step 12.', {}, { timeout: 5000 })).toBeTruthy();
  // The page opening may set its own scroll; the chapter, once shown, moves nothing.
  expect(y).toBe(0);
  const before = [scrollTo.mock.calls.length, scrolled.mock.calls.length];
  readerScrolls(120);
  readerScrolls(60);
  latest().emit('change', {
    version: 20,
    start: 'start-a',
    changes: [{ seq: 20, type: 'attempt', id: 'attempt-3', taskId: 'T-1', projectId: 'project-x' }],
  });
  await new Promise(resolve => setTimeout(resolve, 700));
  expect(y).toBe(60);
  expect([scrollTo.mock.calls.length, scrolled.mock.calls.length]).toEqual(before);
  expect((scrolled.mock.contexts as Element[]).some(element => element.closest('section.sd-attemptfold'))).toBe(false);
  expect(newUpdates()).toBeNull();
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
      expect(await within(review).findByText('Morgan passed it')).toBeTruthy();
      await waitFor(() => expect(scrolled.mock.contexts).toContain(review));
      // A finished chapter comes into view at its start.
      expect(scrolled.mock.calls[scrolled.mock.contexts.indexOf(review)]).toEqual([{ block: 'start' }]);
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

// Hold just one route's response, after the stand-in has recorded the request. Nothing reaches the query
// until released; multiple holds can be installed to exercise either completion order independently.
const holdRead = (url: string) => {
  const fetchBefore = globalThis.fetch,
    gate = Promise.withResolvers<void>(),
    requested = Promise.withResolvers<void>();
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await fetchBefore(...args);
    if (String(args[0]) === url) {
      requested.resolve();
      await gate.promise;
    }
    return response;
  });
  return {
    requested: requested.promise,
    release: () => act(async () => gate.resolve()),
    reject: () => act(async () => gate.reject(new Error('Record unavailable.'))),
  };
};
const traceOf = (id: string) => `/api/attempts/${id}/trace?projectId=project-x`;
const recordedSay = (id: string, text: string) => {
  const attempt = controller.attempts.find(item => item.id === id)!;
  controller.traces[id] = {
    schemaVersion: 'attempt-trace-v1',
    attemptId: id,
    taskId: 'T-1',
    provider: 'claude',
    status: attempt.status,
    source: 'activity-file',
    lines: 1,
    counts: { say: 1 },
    steps: [say(0, text)],
    phases: [],
    handoff: { summary: attempt.result?.summary },
  };
};
// Check the whole body, so metadata, notices, result sections and a raw panel cannot slip through unnoticed.
const onlyLoading = (chapter: HTMLElement, name: string) => {
  expect(lineOf(chapter).getAttribute('aria-expanded')).toBe('true');
  const body = chapter.querySelector('.sd-attemptfold__body')!;
  expect(body.children).toHaveLength(1);
  const status = within(body as HTMLElement).getByRole('status');
  expect(status.className).toBe('sd-meta');
  expect(status.textContent).toBe(`Reading what ${name} did…`);
  expect(body.textContent).toBe(status.textContent);
};
const chapterOrder = (chapter: HTMLElement, words: string[]) => {
  const positions = words.map(word => chapter.textContent!.indexOf(word));
  expect(positions.every(at => at >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(within(chapter).queryByText(/^Reading what /)).toBeNull();
};
const directActivity = async (name: string) => {
  open('/p/project-x/tasks/T-1?tab=activity');
  expect((await screen.findByRole('tab', { name: 'Activity' })).getAttribute('aria-selected')).toBe('true');
  return within(await screen.findByRole('tabpanel')).findByRole('region', { name });
};

test('a finished review reveals its conversation, verdict and long summary together after its initial trace', async () => {
  reviewed();
  const summary = 'The whole review summary. '.repeat(50).trim();
  controller.attempts[2] = { ...controller.attempts[2]!, result: { summary } };
  recordedSay('attempt-review', 'I inspected the chapter ordering.');
  const trace = holdRead(traceOf('attempt-review')),
    chapter = await directActivity('Review');
  await trace.requested;
  onlyLoading(chapter, 'Morgan');
  expect(lineOf(chapter).textContent).toContain('Passed');
  const first = whenShown('I inspected the chapter ordering.', () => chapter.textContent);
  await trace.release();
  await within(chapter).findByText('I inspected the chapter ordering.');
  expect(await first).toContain(summary);
  chapterOrder(chapter, ['I inspected the chapter ordering.', 'Its verdict', 'Morgan passed it', summary]);
  expect(within(chapter).getAllByText(summary)).toHaveLength(1);
  expect(controller.reads()).not.toContain(traceOf('attempt-1'));
  expect(controller.reads()).not.toContain(traceOf('attempt-2'));
  expect(controller.reads()).not.toContain(detailOf('attempt-1'));
});

test('a running chapter keeps only its heading and quiet status until its initial trace settles', async () => {
  runningStory([say(0, 'I am folding the chapters.')]);
  const trace = holdRead(traceOf('attempt-3')),
    chapter = await directActivity('Build, attempt 2 of 3');
  await trace.requested;
  onlyLoading(chapter, 'Eli');
  await trace.release();
  await within(chapter).findByText('I am folding the chapters.');
  expect(within(chapter).getByText(/^Eli is working on it now/)).toBeTruthy();
  expect(within(chapter).queryByText(/^Reading what /)).toBeNull();
});

test('opening an earlier folded chapter waits for its own trace without hiding the settled review', async () => {
  reviewed();
  recordedSay('attempt-review', 'Review conversation already drawn.');
  recordedSay('attempt-1', 'The first build conversation.');
  const trace = holdRead(traceOf('attempt-1')),
    chapter = await directActivity('Review');
  const conversation = await within(chapter).findByText('Review conversation already drawn.');
  expect(controller.reads()).not.toContain(traceOf('attempt-1'));
  expect(controller.reads()).not.toContain(detailOf('attempt-1'));
  const earlier = within(screen.getByRole('tabpanel')).getByRole('region', { name: 'Build, attempt 1 of 3' });
  await userEvent.setup().click(lineOf(earlier));
  await trace.requested;
  onlyLoading(earlier, 'Eli');
  expect(conversation.isConnected).toBe(true);
  await trace.release();
  await within(earlier).findByText('The first build conversation.');
  chapterOrder(earlier, ['The first build conversation.', 'What it handed back', 'First try.']);
  expect(within(chapter).getByText('Review conversation already drawn.')).toBe(conversation);
});

test.each(['trace', 'detail'] as const)(
  'a completed build waits for both reads when %s settles first',
  async firstRead => {
    reviewed();
    controller.attempts = controller.attempts.slice(0, 2);
    controller.tasks[0] = { ...controller.tasks[0]!, lastAttemptId: 'attempt-2' };
    recordedSay('attempt-2', 'The completed build conversation.');
    const trace = holdRead(traceOf('attempt-2')),
      detail = holdRead(detailOf('attempt-2')),
      chapter = await directActivity('Build, attempt 2 of 3');
    await Promise.all([trace.requested, detail.requested]);
    onlyLoading(chapter, 'Eli');
    await (firstRead === 'trace' ? trace : detail).release();
    onlyLoading(chapter, 'Eli');
    const first = whenShown('The completed build conversation.', () => chapter.textContent);
    await (firstRead === 'trace' ? detail : trace).release();
    await within(chapter).findByText('The completed build conversation.');
    const body = await first;
    expect(body).toContain('Strip the attempts next.');
    expect(body).toContain("Eli's own test runs");
    expect(body).toContain('How its time went');
    chapterOrder(chapter, [
      'The completed build conversation.',
      'What it handed back',
      'Second try, folded.',
      'Strip the attempts next.',
    ]);
    expect(within(chapter).getAllByText('Second try, folded.')).toHaveLength(1);
  },
);

test.each(['trace', 'report'] as const)(
  'a review prepares its optional report when %s settles first',
  async firstRead => {
    reviewed();
    controller.attempts[2] = {
      ...controller.attempts[2]!,
      artifacts: [{ path: 'source-change-review.json', hash: 'review-hash' }],
    };
    controller.artifacts['attempt-review/source-change-review.json'] = JSON.stringify({
      unperformedChecks: ['Check the browser layout'],
    });
    recordedSay('attempt-review', 'I checked the review report.');
    const trace = holdRead(traceOf('attempt-review')),
      report = holdRead('/api/attempts/attempt-review/artifact?projectId=project-x&path=source-change-review.json'),
      chapter = await directActivity('Review');
    await Promise.all([trace.requested, report.requested]);
    await (firstRead === 'trace' ? trace : report).release();
    onlyLoading(chapter, 'Morgan');
    const first = whenShown('I checked the review report.', () => chapter.textContent);
    await (firstRead === 'trace' ? report : trace).release();
    await within(chapter).findByText('I checked the review report.');
    expect(await first).toContain('Check the browser layout');
    chapterOrder(chapter, [
      'I checked the review report.',
      'Its verdict',
      'The change holds up.',
      'Check the browser layout',
    ]);
  },
);

test.each(['trace', 'detail', 'report'] as const)(
  'a failed %s read settles to available chapter content',
  async failedRead => {
    reviewed();
    const id = failedRead === 'detail' ? 'attempt-2' : 'attempt-review';
    if (failedRead === 'detail') {
      controller.attempts = controller.attempts.slice(0, 2);
      controller.tasks[0] = { ...controller.tasks[0]!, lastAttemptId: id };
    }
    if (failedRead === 'report')
      controller.attempts[2] = {
        ...controller.attempts[2]!,
        artifacts: [{ path: 'source-change-review.json', hash: 'missing' }],
      };
    recordedSay(id, 'Available conversation.');
    const url =
      failedRead === 'trace'
        ? traceOf(id)
        : failedRead === 'detail'
          ? detailOf(id)
          : `/api/attempts/${id}/artifact?projectId=project-x&path=source-change-review.json`;
    const read = holdRead(url),
      chapter = await directActivity(failedRead === 'detail' ? 'Build, attempt 2 of 3' : 'Review');
    await read.requested;
    onlyLoading(chapter, failedRead === 'detail' ? 'Eli' : 'Morgan');
    await read.reject();
    await within(chapter).findByText(failedRead === 'detail' ? 'Second try, folded.' : 'Morgan passed it');
    expect(within(chapter).queryByText(/^Reading what /)).toBeNull();
    expect(within(chapter).queryByText(/Loading what it handed on/)).toBeNull();
    if (failedRead === 'trace') {
      const explanation = within(chapter).getAllByText(/^The conversation could not be read\./);
      expect(explanation).toHaveLength(1);
      expect(explanation[0]!.getAttribute('role')).toBe('status');
      expect(explanation[0]!.className).toBe('sd-meta');
      expect(await within(chapter).findByLabelText('Raw log')).toBeTruthy();
    } else expect(within(chapter).getByText('Available conversation.')).toBeTruthy();
  },
);
