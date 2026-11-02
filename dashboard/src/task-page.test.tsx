// A task's page, the story page of the redesign (MP-026, v1.0 item 23): it loads its task with the project's
// shared records, refreshes the task only when the stream names it, keeps what the director is doing through every
// refresh, and streams the activity only while its tab is shown.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary } from './api';
import { App } from './app';
import { LiveStream } from './live';
import { createAppRouter } from './router';
import {
  FakeSource,
  createStream,
  fakeController,
  latest,
  taskFixture,
  whenShown,
  type Controller,
} from './test-controller';

let controller: Controller;
const taskUrl = '/api/tasks/T-1?projectId=project-x';
// What a test stubbed on the page's elements, put back after it.
const restores: (() => void)[] = [];

beforeEach(() => {
  controller = fakeController();
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Show finished results',
      status: 'review',
      brief: 'Read each result in place.',
      acceptance: 'Results are readable.',
      direction: 'Recorded direction.',
      lastAttemptId: 'attempt-1',
    }),
  ];
  controller.attempts = [
    { id: 'attempt-1', taskId: 'T-1', status: 'running', workerId: 'W-1', result: { summary: 'Working on it.' } },
  ];
  controller.logs['attempt-1'] = [1, 2, 3].map(seq => ({
    seq,
    time: `2026-10-21T20:00:0${seq}Z`,
    kind: 'log',
    message: `stdout: line ${seq}`,
    task_id: 'T-1',
    attempt_id: 'attempt-1',
  }));
  controller.command = (url, method) => (url === '/api/tasks/T-1' && method === 'PATCH' ? controller.tasks[0] : {});
});
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0).reverse()) restore();
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
const detailUrl = '/api/attempts/attempt-1?projectId=project-x';
const change = (version: number, changes: object[]) => latest().emit('change', { version, start: 'start-a', changes });
// The line that opens and folds an attempt's chapter in Activity.
const lineOf = (chapter: HTMLElement) => within(chapter).getAllByRole('button')[0]!;
const edit = (fields: object) => (controller.tasks = [{ ...controller.tasks[0]!, ...fields }]);

test("the page loads its task with the project's shared records, and a change fetches only the task it names", async () => {
  // A finished attempt, whose Overview is what it returned; a running one's says who is working on it.
  controller.attempts = [{ ...controller.attempts[0]!, status: 'succeeded' }];
  open();
  expect(await screen.findByRole('heading', { level: 1, name: 'Show finished results' })).toBeTruthy();
  expect(latest().url).toBe('/api/events?projectId=project-x');
  // Pages read once the stream has opened, so nothing is read twice; the attempt shown reads its full record, and the
  // rail reads Project Y's shell and live set once for its count.
  await waitFor(() =>
    expect([...controller.reads()].sort()).toEqual([
      detailUrl,
      '/api/projects/project-x/live',
      '/api/projects/project-x/shell',
      '/api/projects/project-y/live',
      '/api/projects/project-y/shell',
      taskUrl,
    ]),
  );
  // Another task and a run: the live set reloads, and nothing is read for the task no page holds.
  change(11, [
    { seq: 11, type: 'task', id: 'T-2', projectId: 'project-x' },
    { seq: 11, type: 'attempt', id: 'attempt-9', taskId: 'T-2', projectId: 'project-x' },
    { seq: 11, type: 'run', id: 'run-1', projectId: 'project-x' },
  ]);
  await waitFor(() => expect(controller.reads()).toHaveLength(7));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(controller.reads().at(-1)).toBe('/api/projects/project-x/live');
  expect(controller.reads()).toHaveLength(7);
  edit({ title: 'Show finished results inline' });
  change(12, [{ seq: 12, type: 'task', id: 'T-1', projectId: 'project-x' }]);
  expect(await screen.findByRole('heading', { name: 'Show finished results inline' })).toBeTruthy();
  controller.attempts = [{ ...controller.attempts[0]!, status: 'succeeded', result: { summary: 'Halfway.' } }];
  change(13, [{ seq: 13, type: 'attempt', id: 'attempt-1', taskId: 'T-1', projectId: 'project-x' }]);
  expect(await screen.findByText('Halfway.')).toBeTruthy();
  // A change to the shown attempt reads its full record again; one to the task alone does not.
  await waitFor(() => expect(controller.reads().slice(7).sort()).toEqual([detailUrl, taskUrl, taskUrl]));
});

test('a brief written in Markdown reads as formatted text, not as its marks', async () => {
  edit({
    brief: 'Files: `src/a.mjs`\n\nIn `outcome()`, add one branch:\n\n1. Keep the label.\n2. Change the text.',
  });
  open();
  // Other work's brief is the card beside its tabs, as a story's is.
  const brief = within(await screen.findByRole('region', { name: 'The brief' }));
  expect(brief.getByRole('heading', { name: 'The brief' })).toBeTruthy();
  expect(brief.getByText('What Eli was asked to do')).toBeTruthy();
  expect(brief.getByText('src/a.mjs').tagName).toBe('CODE');
  expect(brief.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Keep the label.', 'Change the text.']);
  expect(brief.queryByText(/`/)).toBeNull();
});

test('a draft direction keeps its text and cursor through a refresh, and saving sends it', async () => {
  const user = userEvent.setup();
  edit({ status: 'failed' });
  open();
  // The direction is the brief card's last part.
  const card = within(await screen.findByRole('region', { name: 'The brief' })),
    box = card.getByLabelText('Direction for the next attempt') as HTMLTextAreaElement;
  expect(box.value).toBe('Recorded direction.');
  await user.clear(box);
  await user.type(box, 'Name the failing test.');
  edit({ title: 'Refreshed while typing', direction: 'Someone else saved this.' });
  change(2, [{ seq: 2, type: 'task', id: 'T-1', projectId: 'project-x' }]);
  await screen.findByRole('heading', { name: 'Refreshed while typing' });
  expect(box.isConnected).toBe(true);
  expect(box.value).toBe('Name the failing test.');
  expect(document.activeElement).toBe(box);
  await user.click(card.getByRole('button', { name: 'Save future direction' }));
  await waitFor(() => expect(controller.requests.some(request => request.method === 'PATCH')).toBe(true));
  expect(controller.requests.find(request => request.method === 'PATCH')).toEqual({
    url: '/api/tasks/T-1',
    method: 'PATCH',
    body: { projectId: 'project-x', direction: 'Name the failing test.' },
  });
});

test("a running step's Overview names who is working on it now, and Open Activity opens its running chapter, which streams only that attempt's lines while open", async () => {
  const user = userEvent.setup(),
    scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  try {
    open();
    await screen.findByRole('heading', { name: 'Show finished results' });
    // A running step opens on its Overview, which says who is working on it until it hands back, and streams nothing.
    expect(screen.queryByRole('tab', { name: 'Result' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    const overview = within(screen.getByRole('tabpanel'));
    expect(await overview.findByText(/^Eli is working on it now\./)).toBeTruthy();
    expect(overview.queryByLabelText('Raw log')).toBeNull();
    await waitFor(() => expect(latest().url).toBe('/api/events?projectId=project-x'));
    // Open Activity: the running chapter, open and in view at its newest lines, with its live lines.
    await user.click(overview.getByRole('button', { name: 'Open Activity' }));
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
    const chapter = await screen.findByRole('region', { name: /^Attempt 1 of / });
    expect(lineOf(chapter).getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(scrolled.mock.contexts).toContain(chapter));
    expect(scrolled.mock.calls[scrolled.mock.contexts.indexOf(chapter)]).toEqual([{ block: 'end' }]);
    expect(await within(chapter).findByLabelText('Raw log')).toBeTruthy();
    expect(screen.getByLabelText('Raw log').textContent).toContain('stdout: line 3');
    await waitFor(() => expect(latest().url).toBe('/api/events?projectId=project-x&log=attempt-1&after=3'));
    const line = controller.logs['attempt-1']![2]!;
    latest().emit('log', { ...line, seq: 4, message: 'stdout: line 4' });
    latest().emit('log', { ...line, seq: 5, attempt_id: 'attempt-other', message: 'stdout: elsewhere' });
    latest().emit('log', { ...line, seq: 4, message: 'stdout: line 4' });
    const text = screen.getByLabelText('Raw log').textContent!;
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('stdout: line 4');
    expect(text).not.toContain('elsewhere');
    // A refresh of the task leaves the tab open.
    edit({ title: 'Refreshed with the activity open' });
    change(3, [{ seq: 3, type: 'task', id: 'T-1' }]);
    await screen.findByRole('heading', { name: 'Refreshed with the activity open' });
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
    // Leaving Activity stops its lines.
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(latest().url).toBe('/api/events?projectId=project-x'));
    // The running chapter the director folded opens again from the Overview.
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    const folded = await screen.findByRole('region', { name: /^Attempt 1 of / });
    await user.click(lineOf(folded));
    expect(lineOf(folded).getAttribute('aria-expanded')).toBe('false');
    expect(within(folded).queryByLabelText('Raw log')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Open Activity' }));
    const reopened = await screen.findByRole('region', { name: /^Attempt 1 of / });
    expect(lineOf(reopened).getAttribute('aria-expanded')).toBe('true');
    expect(await within(reopened).findByLabelText('Raw log')).toBeTruthy();
    await waitFor(() => expect(latest().url).toContain('log=attempt-1'));
  } finally {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test("with a trace, the activity is the attempt's conversation, follows its log for new steps and opens the full trace", async () => {
  const user = userEvent.setup(),
    step = (seq: number, kind: string, facts: object) => ({ seq, at: `2026-10-21T20:0${seq}:00Z`, kind, ...facts });
  controller.traces['attempt-1'] = {
    schemaVersion: 'attempt-trace-v1',
    attemptId: 'attempt-1',
    taskId: 'T-1',
    provider: 'claude',
    status: 'running',
    source: 'activity-file',
    lines: 40,
    counts: { say: 1, shell: 1, blocked: 1 },
    steps: [
      step(0, 'say', { text: 'Starting with the result reader.' }),
      step(1, 'shell', { command: 'ls src', exitCode: 0 }),
      step(2, 'blocked', { tool: 'Bash', detail: 'npm test && rm x', reason: 'several operations.' }),
    ],
    phases: [],
    handoff: null,
  };
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  await user.click(screen.getByRole('tab', { name: 'Activity' }));
  const panel = within(await screen.findByRole('tabpanel'));
  expect(await panel.findByText('Starting with the result reader.')).toBeTruthy();
  // Looking around is the full trace's; a refused command shows here.
  expect(panel.queryByText('ls src')).toBeNull();
  expect(panel.getByText('npm test && rm x')).toBeTruthy();
  expect(panel.getByRole('link', { name: 'Full trace' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-1/attempts/attempt-1',
  );
  // New lines in the log read only the steps after the last one shown.
  await waitFor(() => expect(latest().url).toContain('log=attempt-1'));
  controller.traces['attempt-1'] = {
    ...(controller.traces['attempt-1'] as object),
    steps: [step(3, 'say', { text: 'Now the tests.' })],
  };
  latest().emit('log', { seq: 9, time: '2026-10-21T20:04:00Z', kind: 'log', message: 'x', attempt_id: 'attempt-1' });
  expect(await panel.findByText('Now the tests.', {}, { timeout: 5000 })).toBeTruthy();
  expect(controller.reads()).toContain('/api/attempts/attempt-1/trace?projectId=project-x&after=2');
  expect(panel.getByText('Starting with the result reader.')).toBeTruthy();
  // The raw log is still a click away.
  await user.click(panel.getByRole('button', { name: 'Raw log' }));
  expect(await screen.findByLabelText('Raw log')).toBeTruthy();
});

// A running attempt's trace as the controller answers it, with the steps it has so far; none reads as no trace yet.
const runningTrace = (steps: object[]) => ({
  schemaVersion: 'attempt-trace-v1',
  attemptId: 'attempt-1',
  taskId: 'T-1',
  provider: 'claude',
  status: 'running',
  source: steps.length ? 'activity-file' : 'none',
  lines: steps.length,
  counts: {},
  steps,
  phases: [],
  handoff: null,
});
const wholeTrace = '/api/attempts/attempt-1/trace?projectId=project-x';
const traceReads = () => controller.reads().filter(url => url.startsWith('/api/attempts/attempt-1/trace'));
// Delay only the named read, keeping the shared controller and all other routes unchanged.
const holdActivityRead = (url: string) => {
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
    reject: () => act(async () => gate.reject(new Error('Activity unavailable.'))),
  };
};
const storyActivityUrl = '/api/tasks/T-1/activity?projectId=project-x';

test.each([
  ['running', 'story'],
  ['running', 'trace'],
  ['finished', 'story'],
  ['finished', 'trace'],
])(
  'opening %s Activity reveals the idea, approval and chapter together when %s settles first',
  async (state, firstRead) => {
    const live = state === 'running';
    edit({
      kind: 'studio-development:change',
      status: live ? 'running' : 'done',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'implementing',
        current: live ? 'implementing' : 'review',
        history: [],
      },
    });
    controller.attempts = [
      {
        ...controller.attempts[0]!,
        status: live ? 'running' : 'accepted',
        startedAt: '2026-10-28T10:00:00.000Z',
        finishedAt: live ? null : '2026-10-28T10:10:00.000Z',
        assignment: { kind: 'studio-development:change' },
        result: live ? undefined : { summary: 'The finished result.' },
      },
    ];
    controller.traces['attempt-1'] = {
      ...runningTrace([{ seq: 0, at: '2026-10-28T10:01:00.000Z', kind: 'say', text: 'The initial conversation.' }]),
      status: live ? 'running' : 'accepted',
    };
    controller.stories['T-1'] = {
      idea: { runId: 'run-1', brief: 'Keep the opening in order.', createdAt: '2026-10-28T09:00:00.000Z', files: [] },
      events: [
        {
          seq: 1,
          time: '2026-10-28T09:01:00.000Z',
          kind: 'work_approved',
          message: 'Director approved this work. Add it to a sprint or start it explicitly.',
          task_id: 'T-1',
          attempt_id: null,
        },
      ],
      instructions: [],
    };
    const story = holdActivityRead(storyActivityUrl),
      trace = holdActivityRead(wholeTrace);
    open('/p/project-x/tasks/T-1?tab=activity');
    const panel = await screen.findByRole('tabpanel'),
      chapter = await within(panel).findByRole('region', { name: /^Build, / });
    await Promise.all([story.requested, trace.requested]);
    const loading = () => {
      expect(lineOf(chapter).getAttribute('aria-expanded')).toBe('true');
      const body = chapter.querySelector('.sd-attemptfold__body') as HTMLElement;
      expect(body.children).toHaveLength(1);
      expect(within(body).getAllByRole('status')).toHaveLength(1);
      expect(body.textContent).toBe('Reading what Eli did…');
      expect(body.firstElementChild?.className).toBe('sd-meta');
      expect(within(panel).queryByText('Sent the idea')).toBeNull();
      expect(within(panel).queryByText('Approved this story')).toBeNull();
    };
    loading();
    await (firstRead === 'story' ? story : trace).release();
    loading();
    const first = whenShown('The initial conversation.', () => panel.textContent);
    await (firstRead === 'story' ? trace : story).release();
    const conversation = await within(chapter).findByText('The initial conversation.');
    const text = (await first)!;
    const positions = [
      'Sent the idea',
      'Keep the opening in order.',
      'Approved this story',
      'The initial conversation.',
    ].map(word => text.indexOf(word));
    expect(positions.every(at => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(within(chapter).queryByText(/^Reading what /)).toBeNull();
    if (!live) expect(text).toContain('The finished result.');
    // A later story refresh may wait on a new activity response, but cannot remove the drawn conversation.
    const refresh = holdActivityRead(storyActivityUrl);
    edit({ title: 'Refreshed after the opening' });
    change(15, [
      { seq: 15, type: 'event', id: 'event-15', taskId: 'T-1', kind: 'work_approved', projectId: 'project-x' },
    ]);
    await screen.findByRole('heading', { name: 'Refreshed after the opening' });
    await refresh.requested;
    expect(within(chapter).getByText('The initial conversation.')).toBe(conversation);
    expect(within(chapter).queryByText(/^Reading what /)).toBeNull();
    await refresh.release();
    expect(conversation.isConnected).toBe(true);
  },
);

test('an unavailable story activity read still reveals the available attempt', async () => {
  controller.traces['attempt-1'] = runningTrace([
    { seq: 0, at: '2026-10-28T10:01:00.000Z', kind: 'say', text: 'Work is still available.' },
  ]);
  const record = holdActivityRead(storyActivityUrl);
  open('/p/project-x/tasks/T-1?tab=activity');
  await record.requested;
  expect(screen.queryByText('Work is still available.')).toBeNull();
  await record.reject();
  const panel = await screen.findByRole('tabpanel');
  expect(await within(panel).findByText('Work is still available.')).toBeTruthy();
  expect(within(panel).queryByText(/^Reading what /)).toBeNull();
});

test('Activity preserves the no-attempt state without waiting for a chapter read', async () => {
  controller.attempts = [];
  edit({ status: 'ready', lastAttemptId: undefined });
  const record = holdActivityRead(storyActivityUrl);
  open('/p/project-x/tasks/T-1?tab=activity');
  expect(await screen.findByText('Nothing has run yet.')).toBeTruthy();
  await record.requested;
  expect(traceReads()).toEqual([]);
  await record.release();
  expect(screen.getByText('Nothing has run yet.')).toBeTruthy();
});
const logLine = (seq: number) =>
  latest().emit('log', { seq, time: '2026-10-21T20:04:00Z', kind: 'log', message: 'x', attempt_id: 'attempt-1' });

test("a running attempt's activity turns from the raw log to its conversation when its first steps arrive, and keeps following its log", async () => {
  const user = userEvent.setup();
  controller.traces['attempt-1'] = runningTrace([]);
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  await user.click(screen.getByRole('tab', { name: 'Activity' }));
  const panel = within(await screen.findByRole('tabpanel'));
  // Nothing in its trace yet: the chapter is the raw log.
  expect((await panel.findByLabelText('Raw log')).textContent).toContain('stdout: line 3');
  await waitFor(() => expect(latest().url).toContain('log=attempt-1'));
  const watching = latest();
  // Its first steps: the next line reads the trace whole, since there is no step to read after.
  controller.traces['attempt-1'] = runningTrace([
    { seq: 0, at: '2026-10-21T20:03:00Z', kind: 'say', text: 'Starting with the result reader.' },
  ]);
  logLine(4);
  expect(await panel.findByText('Starting with the result reader.', {}, { timeout: 5000 })).toBeTruthy();
  expect(panel.queryByLabelText('Raw log')).toBeNull();
  expect(traceReads()).toEqual([wholeTrace, wholeTrace]);
  // The raw log stopped its lines as it went, and the conversation watches the log again.
  await waitFor(() => expect(FakeSource.all.at(-1)).not.toBe(watching));
  expect(latest().url).toContain('log=attempt-1');
  // From then on it reads only the steps after the last one shown.
  controller.traces['attempt-1'] = runningTrace([
    { seq: 1, at: '2026-10-21T20:05:00Z', kind: 'say', text: 'Now the tests.' },
  ]);
  change(5, [{ seq: 5, type: 'attempt', id: 'attempt-1', taskId: 'T-1', projectId: 'project-x' }]);
  expect(await panel.findByText('Now the tests.')).toBeTruthy();
  expect(panel.getByText('Starting with the result reader.')).toBeTruthy();
  expect(traceReads()).toEqual([wholeTrace, wholeTrace, `${wholeTrace}&after=0`]);
  expect(controller.reads().filter(url => url.includes('after=-1'))).toEqual([]);
});

test('a running attempt whose first step is still pending reads its trace whole for the next line, and the step settles', async () => {
  const user = userEvent.setup();
  controller.traces['attempt-1'] = runningTrace([
    { seq: 0, at: '2026-10-21T20:03:00Z', kind: 'shell', command: 'npm test', pending: true },
  ]);
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  await user.click(screen.getByRole('tab', { name: 'Activity' }));
  const panel = within(await screen.findByRole('tabpanel'));
  expect(await panel.findByText('npm test')).toBeTruthy();
  expect(panel.getByText('running')).toBeTruthy();
  await waitFor(() => expect(latest().url).toContain('log=attempt-1'));
  controller.traces['attempt-1'] = runningTrace([
    { seq: 0, at: '2026-10-21T20:03:00Z', kind: 'shell', command: 'npm test', exitCode: 0 },
    { seq: 1, at: '2026-10-21T20:04:00Z', kind: 'say', text: 'The tests pass.' },
  ]);
  logLine(4);
  expect(await panel.findByText('The tests pass.', {}, { timeout: 5000 })).toBeTruthy();
  expect(panel.getByText(/^ran · /)).toBeTruthy();
  expect(panel.queryByText('running')).toBeNull();
  expect(traceReads()).toEqual([wholeTrace, wholeTrace]);
});

// The raw log's scroll geometry, a stand-in where nothing lays out or scrolls: each line is 20px tall and the log's
// box shows ten of them. Only the box labelled Raw log takes it; afterEach puts the elements' own back.
const isRawLog = (element: Element) => element.getAttribute('aria-label') === 'Raw log',
  logHeight = (log: Element) => (log.textContent ?? '').split('\n').length * 20,
  // Where the box shows the newest line at its bottom.
  logEnd = (log: Element) => Math.max(0, logHeight(log) - 200);
function stubRawLog() {
  const tops = new WeakMap<Element, number>();
  const stub = (name: string, get: (log: Element) => number, set?: (log: Element, value: number) => void) => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, name);
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      get(this: Element) {
        return isRawLog(this) ? get(this) : original?.get?.call(this);
      },
      ...(set && {
        set(this: Element, value: number) {
          if (isRawLog(this)) set(this, value);
          else original?.set?.call(this, value);
        },
      }),
    });
    restores.push(() =>
      original
        ? Object.defineProperty(Element.prototype, name, original)
        : Reflect.deleteProperty(Element.prototype, name),
    );
  };
  stub('scrollHeight', logHeight);
  stub('clientHeight', () => 200);
  stub(
    'scrollTop',
    log => tops.get(log) ?? 0,
    (log, value) => tops.set(log, Math.min(Math.max(0, value), logEnd(log))),
  );
}
// The reader scrolling the log, as the browser tells it.
const scrollLog = (log: HTMLElement, to: number) => {
  log.scrollTop = to;
  fireEvent.scroll(log);
};
const newUpdates = () => screen.queryByRole('button', { name: /^New updates/ });
const lineCount = (log: HTMLElement) => log.textContent!.split('\n').length;
// The attempt's chapter in Activity, showing its raw log of 30 lines, taller than the log's box. A running one
// watches the stream for its lines after them.
const openRawLog = async (status: string) => {
  stubRawLog();
  const user = userEvent.setup();
  controller.attempts = [{ ...controller.attempts[0]!, status }];
  controller.logs['attempt-1'] = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    time: '2026-10-21T20:00:00Z',
    kind: 'log',
    message: `stdout: line ${index + 1}`,
    task_id: 'T-1',
    attempt_id: 'attempt-1',
  }));
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  await user.click(screen.getByRole('tab', { name: 'Activity' }));
  const log = await screen.findByLabelText('Raw log');
  if (status === 'running') await waitFor(() => expect(latest().url).toContain('log=attempt-1&after=30'));
  return { user, log };
};

test("a running attempt's raw log opens at its newest lines and keeps them in view as lines arrive, with no New updates", async () => {
  const { log } = await openRawLog('running');
  expect(log.scrollTop).toBe(400);
  logLine(31);
  logLine(32);
  expect(lineCount(log)).toBe(32);
  expect(log.scrollTop).toBe(440);
  expect(log.scrollTop).toBe(logEnd(log));
  expect(newUpdates()).toBeNull();
});

test('a reader scrolled up the running raw log keeps their place, New updates counts the lines below, and pressing it goes to the newest and follows again', async () => {
  const { user, log } = await openRawLog('running');
  scrollLog(log, 200);
  expect(newUpdates()).toBeNull();
  // A line's seq numbers every event in the studio, so other attempts' lines leave gaps between this one's.
  logLine(31);
  expect(log.scrollTop).toBe(200);
  screen.getByRole('button', { name: 'New updates: 1' });
  logLine(36);
  expect(lineCount(log)).toBe(32);
  expect(log.scrollTop).toBe(200);
  await user.click(screen.getByRole('button', { name: 'New updates: 2' }));
  expect(log.scrollTop).toBe(logEnd(log));
  expect(newUpdates()).toBeNull();
  logLine(37);
  expect(lineCount(log)).toBe(33);
  expect(log.scrollTop).toBe(logEnd(log));
  expect(newUpdates()).toBeNull();
});

test('scrolling the running raw log back to its bottom clears New updates, and the next line follows', async () => {
  const { log } = await openRawLog('running');
  scrollLog(log, 200);
  logLine(31);
  logLine(32);
  screen.getByRole('button', { name: 'New updates: 2' });
  scrollLog(log, logEnd(log));
  expect(newUpdates()).toBeNull();
  logLine(33);
  expect(log.scrollTop).toBe(logEnd(log));
  expect(newUpdates()).toBeNull();
});

test("a finished attempt's raw log opens at its start, streams nothing, and never moves on its own", async () => {
  const { log } = await openRawLog('succeeded');
  expect(lineCount(log)).toBe(30);
  expect(log.scrollTop).toBe(0);
  expect(latest().url).not.toContain('log=');
  scrollLog(log, 120);
  scrollLog(log, 60);
  logLine(31);
  expect(lineCount(log)).toBe(30);
  expect(log.scrollTop).toBe(60);
  expect(newUpdates()).toBeNull();
});

test('an attempt says what earlier work it continued, or why it started fresh', async () => {
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      continueFrom: { attemptId: 'attempt-0', files: [{ path: 'src/a.mjs' }, { path: 'src/b.mjs' }], filesOmitted: 2 },
    },
  ];
  open();
  expect(await screen.findByText('Continued from attempt-0: src/a.mjs, src/b.mjs and 2 more')).toBeTruthy();
  cleanup();
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      continueFrom: { attemptId: 'attempt-0', fresh: { reason: 'Its staged files no longer match their hashes.' } },
    },
  ];
  open();
  expect(
    await screen.findByText(
      'Started fresh instead of the work of attempt-0: Its staged files no longer match their hashes. Its history still shows that work.',
    ),
  ).toBeTruthy();
});

test('an attempt says when git merged the work it continued onto the current source, and which files git set aside and why', async () => {
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      continueFrom: { attemptId: 'attempt-0', files: [{ path: 'src/a.mjs' }], merged: ['src/a.mjs'] },
    },
  ];
  open();
  // Each page waits five seconds for its first render, as a loaded machine needs.
  expect(
    await screen.findByText(
      "Continued from attempt-0's work, which git merged onto the current source because src/a.mjs changed since.",
      {},
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Continued from attempt-0: src/a.mjs')).toBeNull();
  cleanup();
  // A finished attempt's Overview names each file set aside with why, with or without a continuation.
  const reason =
    'The current source deleted src/b.mjs since; your change to it is under merge-set-aside/src/b.mjs for reference.';
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'succeeded',
      workerId: 'W-1',
      result: { summary: 'Done.' },
      setAside: [{ path: 'src/b.mjs', reason }],
    },
  ];
  open();
  const panel = await screen.findByRole('tabpanel', {}, { timeout: 5000 });
  expect(
    await within(panel).findByText(
      `Git set src/b.mjs aside for the editor, because one side deleted it and the other changed it. ${reason}`,
      {},
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  expect(within(panel).queryByText(/Continued from/)).toBeNull();
});

test("a code story's attempts say in their chapters what earlier work they continued, or why they started fresh, from their summaries, as the strip chooses them", async () => {
  const user = userEvent.setup(),
    story = (id: string, startedAt: string, summary: string, continueFrom?: object) => ({
      id,
      taskId: 'T-1',
      status: 'failed',
      workerId: 'W-1',
      startedAt,
      assignment: { kind: 'studio-development:change' },
      result: { summary },
      artifacts: [],
      ...(continueFrom ? { continueFrom } : {}),
    });
  edit({
    kind: 'studio-development:change',
    status: 'blocked',
    lastAttemptId: 'attempt-3',
    sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'blocked', history: [] },
  });
  // As the controller projects a code story's sourceChange.continueFrom: paths without hashes, and a fresh
  // start's reason naming the paths that changed.
  controller.attempts = [
    // A merge onto the current source records no continuation, but may set files aside for its editor.
    {
      ...story('attempt-1', '2026-10-21T20:00:00Z', 'First try.'),
      setAside: [{ path: 'src/gone.mjs', reason: 'The current source deleted src/gone.mjs since.' }],
    },
    story('attempt-2', '2026-10-21T20:10:00Z', 'Second try.', {
      attemptId: 'attempt-1',
      files: [],
      fresh: { reason: 'the source of files it changed was committed since that attempt (src/a.mjs)' },
    }),
    story('attempt-3', '2026-10-21T20:20:00Z', 'Third try.', {
      attemptId: 'attempt-2',
      files: [{ path: 'src/a.mjs' }, { path: 'test/a.test.mjs' }],
    }),
  ];
  open();
  // Without a candidate the story opens on Activity, its latest attempt chosen in the strip and its chapter open.
  const [first, second, third] = within(
    await screen.findByRole('region', { name: 'Attempts' }, { timeout: 5000 }),
  ).getAllByRole('button');
  expect(third!.getAttribute('aria-pressed')).toBe('true');
  expect(third!.textContent).toBe('3 · Failed');
  expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
  const chapter = (name: string) => within(screen.getByRole('region', { name }));
  expect(
    await chapter('Build, attempt 3 of 3').findByText('Continued from attempt-2: src/a.mjs, test/a.test.mjs'),
  ).toBeTruthy();
  expect(chapter('Build, attempt 3 of 3').queryByText(/Started fresh|^Git set /)).toBeNull();
  // Choosing an earlier attempt opens its chapter, which says how it started.
  await user.click(second!);
  expect(
    await chapter('Build, attempt 2 of 3').findByText(
      'Started fresh instead of the work of attempt-1: the source of files it changed was committed since that attempt (src/a.mjs). Its history still shows that work.',
    ),
  ).toBeTruthy();
  expect(chapter('Build, attempt 2 of 3').queryByText(/Continued from/)).toBeNull();
  await user.click(first!);
  expect(
    await chapter('Build, attempt 1 of 3').findByText(
      'Git set src/gone.mjs aside for the editor, because one side deleted it and the other changed it. The current source deleted src/gone.mjs since.',
    ),
  ).toBeTruthy();
  expect(chapter('Build, attempt 1 of 3').queryByText(/Continued from|Started fresh/)).toBeNull();
  // Its chapter ends with what it handed back.
  expect(await chapter('Build, attempt 1 of 3').findByText('First try.')).toBeTruthy();
});

test("a story's Activity has your part beside the agents': what you sent and decided, and what a house rule did for you", async () => {
  const user = userEvent.setup(),
    trace = (attemptId: string, at: string, text: string) => ({
      schemaVersion: 'attempt-trace-v1',
      attemptId,
      taskId: 'T-1',
      provider: 'codex',
      status: 'accepted',
      source: 'activity-file',
      lines: 1,
      counts: { say: 1 },
      steps: [{ seq: 0, at, kind: 'say', text }],
      phases: [],
      handoff: null,
    }),
    attempt = (id: string, startedAt: string, kind: string) => ({
      id,
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      startedAt,
      assignment: { kind },
      artifacts: [],
    }),
    event = (seq: number, time: string, kind: string, message: string, attemptId: string | null = null) => ({
      seq,
      time,
      kind,
      message,
      task_id: 'T-1',
      attempt_id: attemptId,
    });
  edit({
    kind: 'studio-development:change',
    status: 'done',
    lastAttemptId: 'attempt-2',
    sourceStage: { version: 'source-story-stages-v1', phase: 'integration', current: 'integrated', history: [] },
  });
  controller.attempts = [
    attempt('attempt-1', '2026-10-24T05:02:00.000Z', 'studio-development:change'),
    attempt('attempt-2', '2026-10-24T05:20:00.000Z', 'studio-development:change-review'),
  ];
  controller.traces['attempt-1'] = trace('attempt-1', '2026-10-24T05:03:00.000Z', 'I changed the path rule.');
  controller.traces['attempt-2'] = trace('attempt-2', '2026-10-24T05:21:00.000Z', 'The change holds up.');
  // As the controller records them; its own events (started) are the conversation's.
  controller.stories['T-1'] = {
    idea: {
      runId: 'run-1',
      brief: 'Let story paths hold parentheses.',
      createdAt: '2026-10-24T04:59:00.000Z',
      files: [],
    },
    events: [
      event(
        1,
        '2026-10-24T05:01:00.000Z',
        'work_approved',
        'Director approved this work. Add it to a sprint or start it explicitly.',
      ),
      event(2, '2026-10-24T05:02:00.000Z', 'started', 'Eli started Codex CLI.', 'attempt-1'),
      event(
        3,
        '2026-10-24T05:10:00.000Z',
        'accepted',
        'Accepted by autonomy policy revision 6: Candidate scope and measured tests passed.',
        'attempt-1',
      ),
      event(
        5,
        '2026-10-24T05:18:00.000Z',
        'sent_back',
        `Director sent this work back for another attempt. Note: ${'Keep the old route names. '.repeat(30)}`,
        'attempt-1',
      ),
      // Recorded just after the attempt it started.
      event(
        6,
        '2026-10-24T05:20:00.001Z',
        'attempt_limit_override',
        'Director started attempt 2, past the 1-attempt limit for automatic runs.',
        'attempt-2',
      ),
      event(
        4,
        '2026-10-24T05:30:00.000Z',
        'integration_requested',
        'Autonomy policy revision 6 approved integration (Integrate after a passing review: independent review attempt-2 passed). The controller integrates as soon as the source is free; other work continues.',
        'attempt-2',
      ),
    ],
    instructions: [
      { scope: 'company', id: 'company', revision: 2, note: 'Say less.', publishedAt: '2026-10-24T05:15:00.000Z' },
    ],
  };
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }));
  const panel = await screen.findByRole('tabpanel');
  expect(await within(panel).findByText('The change holds up.')).toBeTruthy();
  // The build's chapter is folded under the latest, the review's, until it is opened.
  expect(within(panel).queryByText('I changed the path rule.')).toBeNull();
  await user.click(lineOf(within(panel).getByRole('region', { name: 'Build, attempt 1 of 3' })));
  expect(await within(panel).findByText('I changed the path rule.')).toBeTruthy();
  expect(await within(panel).findByText('Let story paths hold parentheses.')).toBeTruthy();
  // In time order: your idea and approval, Eli's build, the house rule's acceptance and your instructions, the
  // review, then the integration the house rule approved.
  const text = panel.textContent ?? '',
    at = [
      'Sent the idea',
      'Approved this story',
      'I changed the path rule.',
      'House ruleAccepted the build: Candidate scope and measured tests passed',
      "Published the company's instructions, revision 2Say less.",
      'Sent it back for another attempt',
      'Started attempt 2, past its limit of 1',
      'The change holds up.',
      'Integration',
      'House ruleApproved the integration: Integrate after a passing review',
    ].map(words => text.indexOf(words));
  expect(at.every(index => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(within(panel).queryByText(/Eli started Codex CLI/)).toBeNull();
  // A long note shows its first lines until Show all.
  const note = 'Keep the old route names. '.repeat(30).trim();
  expect(within(panel).queryByText(note)).toBeNull();
  await user.click(within(panel).getByRole('button', { name: 'Show all' }));
  expect(within(panel).getByText(note)).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'Open the idea' }).getAttribute('href')).toBe(
    '/p/project-x/runs/run-1',
  );
  expect(controller.reads()).toContain('/api/tasks/T-1/activity?projectId=project-x');
});

// A story that landed, its build and its review, the review carrying the carries the controller planned (1.1).
const landed = (sourceCarries?: AttemptSummary['sourceCarries']) => {
  edit({
    kind: 'studio-development:change',
    status: 'done',
    lastAttemptId: 'attempt-2',
    sourceStage: {
      version: 'source-story-stages-v1',
      phase: 'integration',
      current: 'integrated',
      review: { attemptId: 'attempt-2' },
      history: [],
    },
  });
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: '2026-10-27T05:00:00.000Z',
      assignment: { kind: 'studio-development:change' },
    },
    {
      id: 'attempt-2',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: '2026-10-27T05:20:00.000Z',
      assignment: { kind: 'studio-development:change-review' },
      sourceIntegration: { state: 'integrated' },
      ...(sourceCarries ? { sourceCarries } : {}),
    },
  ];
};

test("a landed story's Activity lists where its fix went under Integration, a story a carry waits for linked", async () => {
  const user = userEvent.setup();
  landed([
    { line: 'release/1.0', state: 'carried', back: true },
    { line: 'release/0.9', state: 'waiting', back: true, after: ['T-2'] },
  ]);
  controller.tasks.push(taskFixture('T-2', { title: 'Keep the folder browser quick' }));
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }));
  const panel = await screen.findByRole('tabpanel'),
    carries = await within(panel).findByRole('list', { name: 'Carries' }),
    divider = within(panel).getByText('Integration', { selector: '.sd-divider' });
  expect(divider.compareDocumentPosition(carries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const items = within(carries).getAllByRole('listitem');
  expect(items.map(item => item.textContent)).toEqual([
    'brought back to release/1.0',
    "waits for T-2 (“Keep the folder browser quick”)'s turn on release/0.9",
  ]);
  expect(within(items[1]!).getByRole('link', { name: 'T-2' }).getAttribute('href')).toBe('/p/project-x/tasks/T-2');
  expect(panel.textContent).not.toMatch(/carried to release/);
});

test('a landed story without carries lists none under Integration', async () => {
  const user = userEvent.setup();
  landed();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }));
  const panel = await screen.findByRole('tabpanel');
  expect(await within(panel).findByText('Integration', { selector: '.sd-divider' })).toBeTruthy();
  expect(within(panel).queryByRole('list', { name: 'Carries' })).toBeNull();
});

test('a story stopped for want of a test sandbox points to Settings, not to the employee', async () => {
  edit({
    status: 'blocked',
    lastAttemptId: undefined,
    reason:
      "Candidate tests run in the built-in sandbox, and it isn't set up on this computer. Set it up under Settings → Candidate tests, or choose No sandbox there.",
  });
  controller.attempts = [];
  open();
  const link = await screen.findByRole('link', { name: 'Open Candidate tests in Settings' });
  expect(link.getAttribute('href')).toBe('/p/project-x/settings');
  expect(screen.getByText(/its tests run in the built-in sandbox, which isn’t set up on this computer/)).toBeTruthy();
});

test('the page sits in the frame with the way back to its ideas and where the task stands', async () => {
  const user = userEvent.setup();
  edit({ status: 'ready', lastAttemptId: undefined });
  controller.attempts = [];
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  // Work outside any idea is under Ideas, as the sidebar marks it.
  const trail = screen.getByRole('navigation', { name: 'You are here' });
  expect(trail.querySelector('a')?.getAttribute('href')).toBe('/p/project-x/runs');
  expect(trail.textContent).toBe('Ideas/T-1');
  const stands = within(screen.getByRole('region', { name: 'Where it stands' }));
  expect(await stands.findByText('This assignment is ready to be queued.')).toBeTruthy();
  // A short notice has nothing more to tell, so no link to it.
  expect(stands.queryByRole('button', { name: /^Read why/ })).toBeNull();
  // Nothing has run, so there is no attempt to choose.
  expect(screen.queryByRole('region', { name: 'Attempts' })).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'Activity' }));
  expect(within(screen.getByRole('tabpanel')).getByText('Nothing has run yet.')).toBeTruthy();
});

test('a reconnecting stream asks for what it missed, and reloads after a restart or when the controller cannot say', async () => {
  FakeSource.hello = null;
  const received: unknown[] = [];
  // The page the controller serves carries its start's request token; the test can make it unreachable.
  let served: string | null = '<!doctype html><meta name="studio-token" content="token-b"><title>Studio desk</title>';
  const meta = Object.assign(document.createElement('meta'), { name: 'studio-token', content: 'token-a' });
  document.head.append(meta);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      controller.requests.push({ url, method: options.method ?? 'GET' });
      if (url === '/') {
        const page = served;
        if (page === null) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, text: async () => page };
      }
      return url.includes('after=3')
        ? {
            ok: true,
            status: 200,
            json: async () => ({ version: 8, start: 'start-a', changes: [{ seq: 4, type: 'task', id: 'T-1' }] }),
          }
        : { ok: false, status: 400, json: async () => ({ error: 'unavailable' }) };
    }),
  );
  const pageReads = () => controller.requests.filter(request => request.url === '/');
  const stream = new LiveStream('project-x', createStream);
  stream.subscribe({ changes: message => received.push(message) });
  stream.open();
  const source = latest();
  expect(stream.started).toBe(false);
  source.emit('change', { version: 3, start: 'start-a' }); // Opened: where pages start reading.
  expect(stream.started).toBe(true);
  source.emit('change', { version: 3, start: 'start-a' }); // Reconnected with nothing missed.
  source.emit('change', { version: 8, start: 'start-a' }); // Reconnected after changes.
  await waitFor(() => expect(received).toHaveLength(1));
  // Neither the first hello nor a reconnect to the same start reads the page.
  expect(controller.requests.map(request => request.url)).toEqual([
    '/api/changes?projectId=project-x&after=3&start=start-a',
  ]);
  source.emit('change', { version: 2, start: 'start-b' }); // The controller restarted, with a new token.
  source.emit('change', { version: 9, start: 'start-b' }); // The controller cannot say.
  await waitFor(() => expect(received).toHaveLength(3));
  expect(received).toEqual([
    { version: 8, start: 'start-a', changes: [{ seq: 4, type: 'task', id: 'T-1' }] },
    { version: 2, start: 'start-b', reload: true },
    { version: 9, start: 'start-b', reload: true },
  ]);
  expect(pageReads()).toEqual([{ url: '/', method: 'GET' }]);
  await waitFor(() => expect(meta.content).toBe('token-b'));
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  await settle();
  // A restart whose page cannot be read still reloads what is shown, and keeps the token it has.
  served = null;
  source.emit('change', { version: 1, start: 'start-c' });
  await waitFor(() => expect(received).toHaveLength(4));
  expect(received[3]).toEqual({ version: 1, start: 'start-c', reload: true });
  expect(pageReads()).toHaveLength(2);
  await settle();
  expect(meta.content).toBe('token-b');
  stream.close();
  meta.remove();
});

test("a reviewed step's Overview shows its work first, then the review, unless another attempt is chosen", async () => {
  const user = userEvent.setup();
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
  controller.shell.taskKinds = {
    ...controller.shell.taskKinds,
    'general:review': { label: 'Independent work review', cardLabel: 'Review' },
  };
  edit({
    status: 'done',
    lastAttemptId: 'attempt-review',
    acceptedAttemptId: 'attempt-work',
    stageState: { version: 'stage-state-v1', current: 'review', complete: '2026-10-24T10:30:00Z' },
  });
  controller.attempts = [
    {
      id: 'attempt-work',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: '2026-10-24T10:00:00Z',
      finishedAt: '2026-10-24T10:20:00Z',
      assignment: { kind: 'general' },
      result: { summary: 'Wrote the welcome guide.' },
    },
    {
      id: 'attempt-review',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-2',
      startedAt: '2026-10-24T10:21:00Z',
      finishedAt: '2026-10-24T10:30:00Z',
      assignment: { kind: 'general:review' },
      result: { summary: 'The guide covers every station.' },
    },
  ];
  open();
  const panel = await screen.findByRole('tabpanel');
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(await within(panel).findByText('Wrote the welcome guide.')).toBeTruthy();
  const text = panel.textContent ?? '',
    at = ['Wrote the welcome guide.', 'Morgan · Independent work review', 'The guide covers every station.'].map(
      words => text.indexOf(words),
    );
  expect(at.every(index => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // An attempt the director chooses in the strip is shown alone, until Back to the latest.
  const [work] = within(screen.getByRole('region', { name: 'Attempts' })).getAllByRole('button');
  await user.click(work!);
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  const chosen = await screen.findByRole('tabpanel');
  expect(await within(chosen).findByText('Wrote the welcome guide.')).toBeTruthy();
  expect(within(chosen).queryByText('The guide covers every station.')).toBeNull();
  await user.click(
    within(screen.getByRole('region', { name: 'The attempt shown' })).getByRole('button', {
      name: 'Back to the latest',
    }),
  );
  expect(await within(screen.getByRole('tabpanel')).findByText('The guide covers every station.')).toBeTruthy();
  expect(within(screen.getByRole('tabpanel')).getByText('Wrote the welcome guide.')).toBeTruthy();
});

test("a reviewed step's attempt strip numbers its work, then its latest review naming the work it reviewed, and counts only the work against its limit, as Details does", async () => {
  const user = userEvent.setup(),
    step = (id: string, kind: string, startedAt: string, extra: object = {}) => ({
      id,
      taskId: 'T-1',
      status: 'accepted',
      workerId: kind === 'general:review' ? 'W-2' : 'W-1',
      startedAt,
      assignment: { kind },
      result: { summary: `${id} handed back.` },
      ...extra,
    });
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
  controller.shell.taskKinds = {
    ...controller.shell.taskKinds,
    'general:work': { label: 'Do the work', cardLabel: 'Work' },
    'general:review': { label: 'Independent work review', cardLabel: 'Review' },
  };
  edit({
    kind: 'general:work',
    status: 'review',
    maxAttempts: 2,
    lastAttemptId: 'attempt-r2',
    acceptedAttemptId: 'attempt-w2',
    stageState: { version: 'stage-state-v1', current: 'review' },
  });
  // The first review sent the work back; the second is waiting for the director. Each names the work it reviewed.
  const of = (attemptId: string) => ({ inputReferences: [{ taskId: 'T-1', attemptId }] });
  controller.attempts = [
    step('attempt-w1', 'general:work', '2026-10-24T10:00:00Z'),
    step('attempt-r1', 'general:review', '2026-10-24T10:20:00Z', {
      workReviewVerdict: 'needs-work',
      ...of('attempt-w1'),
    }),
    step('attempt-w2', 'general:work', '2026-10-24T10:40:00Z'),
    step('attempt-r2', 'general:review', '2026-10-24T11:00:00Z', { status: 'review', ...of('attempt-w2') }),
  ];
  open();
  const strip = await screen.findByRole('region', { name: 'Attempts' }, { timeout: 5000 }),
    chips = [...strip.querySelectorAll<HTMLElement>('.sd-attemptchip')];
  // The row numbers the work's own attempts, as the side panel counts them; the latest review is a step of its own,
  // after them, naming the attempt it reviewed; the latest is the one shown.
  expect(chips.map(chip => chip.textContent)).toEqual(['1 · Accepted', '2 · Accepted', 'Of 2 · waiting for you']);
  expect(chips.map(chip => chip.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
  expect(strip.querySelector('.sd-attemptstrip__limit')?.textContent).toBe(
    'The house rules allow 2 automatic attempts. Both are used.',
  );
  expect(within(screen.getByRole('region', { name: 'Details' })).getByText('2 of 2 used')).toBeTruthy();
  // The earlier review reads as its verdict, as a code story's does, once "1 earlier" opens it.
  const review = within(within(strip).getByRole('group', { name: 'Review' }));
  await user.click(review.getByRole('button', { name: '1 earlier' }));
  expect(review.getAllByRole('button').map(chip => chip.textContent)).toEqual([
    'Of 1 · asked for changes',
    'Of 2 · waiting for you',
  ]);
  await user.click(chips[0]!);
  expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
});

// The window's width as useNarrow reads it: a phone matches the design's break. afterEach puts the window's own back.
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
// A code story, or other work, whose attempt stopped with a failing check, a failed test, an error and an issue its
// editor raised.
const stopped = (source: boolean) => {
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Show finished results',
      status: 'failed',
      lastAttemptId: 'attempt-1',
      ...(source
        ? {
            kind: 'studio-development:change',
            sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'failed', history: [] },
          }
        : {}),
    }),
  ];
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'failed',
      workerId: 'W-1',
      startedAt: '2026-10-27T05:00:00.000Z',
      finishedAt: '2026-10-27T05:20:00.000Z',
      assignment: { kind: source ? 'studio-development:change' : 'general' },
      controllerChecks: [{ name: 'Candidate tests', status: 'fail', evidence: '751 of 752 tests passed.' }],
      testEvidence: {
        totals: { tests: 752, pass: 751, fail: 1 },
        failedTests: [{ file: 'test/a.test.mjs', name: 'keeps the label' }],
      },
      error: 'The candidate did not pass its tests.',
      result: { outcome: 'completed', summary: 'Shows them.', issues: ['I could not run the browser check.'] },
    },
  ];
};
const inFull = { name: 'Where it stands, in full' };

// One page to a test, each waiting five seconds for its first render as a loaded machine needs: four pages in one
// test outran its own time limit once the whole suite ran beside it.
for (const [source, tab] of [
  [true, 'Checks'],
  [false, 'Overview'],
] as const)
  for (const phone of [false, true])
    test(`a stopped ${source ? "story's Checks" : "work's Overview"} starts with where it stands in full${phone ? ', on a phone too' : ''}`, async () => {
      const user = userEvent.setup();
      width(phone);
      stopped(source);
      open();
      await user.click(await screen.findByRole('tab', { name: tab }, { timeout: 5000 }));
      const panel = await screen.findByRole('tabpanel'),
        region = await within(panel).findByRole('region', inFull),
        full = within(region);
      // It heads the tab with the reason the notice shortens, and has an id the notice links to.
      expect(panel.firstElementChild).toBe(region);
      expect(region.id).toBe('stands-in-full');
      expect(full.getByText('The attempt did not pass: Candidate tests.')).toBeTruthy();
      expect(full.getByText('Candidate tests: 751 of 752 tests passed.')).toBeTruthy();
      // A failed test shows its file as a chip.
      expect(full.getByText('keeps the label')).toBeTruthy();
      expect(full.getByText('test/a.test.mjs').className).toBe('sd-file');
      expect(full.getByText('The candidate did not pass its tests.')).toBeTruthy();
      expect(full.getByText('I could not run the browser check.')).toBeTruthy();
    });

// The notice at the top reads in a line or two, and links to its full account.
for (const [source, tab] of [
  [true, 'Checks'],
  [false, 'Overview'],
] as const)
  test(`a stopped ${source ? 'story' : 'work'}'s notice says its tests did not pass and what to do, and Read why opens ${tab} at the full account`, async () => {
    const user = userEvent.setup(),
      scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      stopped(source);
      open();
      const notice = await screen.findByRole('region', { name: 'Where it stands' }, { timeout: 5000 }),
        stands = within(notice);
      expect(await stands.findByText("The attempt's tests did not pass: 751 of 752.")).toBeTruthy();
      expect(
        stands.getByText(/^Inspect the failing checks and tests, then use Start assignment to repair the work\./),
      ).toBeTruthy();
      expect(notice.textContent).not.toMatch(
        /751 of 752 tests passed|keeps the label|did not pass its tests|browser check|The attempt did not pass/,
      );
      // Its decisions stay.
      expect(stands.getByRole('button', { name: 'Start assignment' })).toBeTruthy();
      await user.click(stands.getByRole('button', { name: `Read why in ${tab}` }));
      expect(screen.getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true');
      const region = await within(screen.getByRole('tabpanel')).findByRole('region', inFull),
        full = within(region);
      expect(full.getByText('Candidate tests: 751 of 752 tests passed.')).toBeTruthy();
      expect(full.getByText('keeps the label')).toBeTruthy();
      expect(full.getByText('The candidate did not pass its tests.')).toBeTruthy();
      expect(full.getByText('I could not run the browser check.')).toBeTruthy();
      // It brings the full account into view.
      await waitFor(() => expect(scrolled.mock.contexts).toContain(region));
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

for (const [source, tab, shows] of [
  [true, 'Checks', 'The candidate has not been tested yet.'],
  [false, 'Overview', /is working on it now/],
] as const)
  test(`while the work runs, its ${tab} does not tell where it stands in full`, async () => {
    const user = userEvent.setup();
    stopped(source);
    edit({ status: 'running' });
    controller.attempts = [
      { ...controller.attempts[0]!, status: 'running', finishedAt: null, testEvidence: undefined, error: undefined },
    ];
    open();
    await user.click(await screen.findByRole('tab', { name: tab }, { timeout: 5000 }));
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText(shows, {}, { timeout: 5000 })).toBeTruthy();
    expect(within(panel).queryByRole('region', inFull)).toBeNull();
    expect(document.getElementById('stands-in-full')).toBeNull();
  });

// Under the banner's headline, the facts it rests on from the story's records: its tests, its review and the attempts
// it used.
const facts = (notice: HTMLElement) => {
  const line = notice.querySelector('.sd-stands__facts');
  // The line follows the headline.
  expect(notice.querySelector('.sd-stands__head')?.nextElementSibling).toBe(line);
  return line?.textContent;
};

test("a stopped story's facts say its tests failed and its review is not yet, with the attempts it used", async () => {
  stopped(true);
  open();
  const notice = await screen.findByRole('region', { name: 'Where it stands' }, { timeout: 5000 });
  expect(await within(notice).findByText("The attempt's tests did not pass: 751 of 752.")).toBeTruthy();
  expect(facts(notice)).toBe('Tests failed · Review not yet · 1 of 3 attempts used');
});

test('a story whose review passed says so in one sentence, its facts its tests and review passed', async () => {
  const pin = {
    taskId: 'T-1',
    attemptId: 'attempt-edit',
    workerId: 'W-1',
    path: 'source-change.json',
    hash: 'change-hash',
    candidateHash: 'candidate-hash',
  };
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Show finished results',
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
    }),
  ];
  controller.attempts = [
    {
      id: 'attempt-edit',
      taskId: 'T-1',
      status: 'accepted',
      workerId: 'W-1',
      assignment: { kind: 'studio-development:change' },
      result: { outcome: 'completed' },
      testEvidence: { totals: { tests: 534, pass: 534, fail: 0 } },
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
      candidateReviewNotes: [],
      candidateReview: { ...pin, passed: true },
      inputReferences: [
        { taskId: 'T-1', attemptId: 'attempt-edit', artifacts: [{ kind: 'source-change', hash: 'change-hash' }] },
      ],
      artifacts: [{ path: 'source-change-review.json', hash: 'review-hash', kind: 'source-change-review' }],
    },
  ];
  open();
  const notice = await screen.findByRole('region', { name: 'Where it stands' }, { timeout: 5000 });
  // Its reviewer, independent of its editor, passed it.
  expect(await within(notice).findByText(/ passed it\. It's ready to integrate\.$/)).toBeTruthy();
  expect(facts(notice)).toBe('Tests passed · Review passed · 1 of 3 attempts used');
});

test('while the work runs, the banner keeps its elapsed bar, and its facts say the attempts used instead of left', async () => {
  edit({ status: 'running' });
  controller.attempts = [{ ...controller.attempts[0]!, startedAt: new Date(Date.now() - 90000).toISOString() }];
  open();
  const notice = await screen.findByRole('region', { name: 'Where it stands' }, { timeout: 5000 });
  expect(await within(notice).findByText(/^1 min \d+ s of 10 min$/)).toBeTruthy();
  expect(notice.querySelector('.sd-bar')).toBeTruthy();
  // Other work's facts are the attempts it used.
  expect(facts(notice)).toBe('1 of 3 attempts used');
  expect(notice.textContent).not.toMatch(/attempts? left/);
});

// A code story, or other work, whose attempt failed, with a brief in Markdown and the plan an earlier step handed it.
const handed = (source: boolean) => {
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Show finished results',
      status: 'failed',
      lastAttemptId: 'attempt-1',
      brief: 'Files: src/result.mjs, test/result.test.mjs\n\nIn `outcome()`, add one branch:\n\n- Keep the label.',
      acceptance: 'Results are readable.',
      ...(source
        ? {
            kind: 'studio-development:change',
            approval: { status: 'approved' },
            proposalReference: { taskId: 'T-plan' },
            sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'failed', history: [] },
          }
        : {}),
    }),
    taskFixture('T-plan', { title: 'Plan the stories', status: 'review' }),
  ];
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'failed',
      workerId: 'W-1',
      assignment: { kind: source ? 'studio-development:change' : 'general' },
      inputReferences: [{ taskId: 'T-plan', attemptId: 'attempt-plan', summary: 'Split the idea into two stories.' }],
      result: { outcome: 'failed', summary: 'A test failed.' },
    },
  ];
};
const handedTo = (brief: ReturnType<typeof within>) => {
  expect(brief.getByText('Handed to Eli by earlier steps')).toBeTruthy();
  expect(brief.getByText('Split the idea into two stories.')).toBeTruthy();
  expect(brief.getByRole('link', { name: 'Plan the stories' }).getAttribute('href')).toBe('/p/project-x/tasks/T-plan');
};

test("a code story's brief is a card beside its tabs, which have no Overview, and without a candidate it opens on Activity", async () => {
  handed(true);
  open();
  const card = await screen.findByRole('region', { name: 'The brief' }, { timeout: 5000 }),
    brief = within(card);
  const tabs = within(screen.getByRole('tablist', { name: 'Story details' })).getAllByRole('tab');
  expect(tabs.map(tab => tab.firstChild?.textContent)).toEqual(['Changes', 'Checks', 'Activity']);
  expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
  // Beside the tabs, not in them, above who works on it and the details.
  expect(screen.getByRole('tabpanel').contains(card)).toBe(false);
  expect([...card.parentElement!.children].map(item => item.getAttribute('aria-label'))).toEqual([
    'The brief',
    'People',
    'Details',
  ]);
  expect(card.parentElement!.className).toBe('sd-story__side');
  // The files it may change, then what was asked, folded under a quiet disclosure, as formatted text without its path
  // lines, with what done means (November 1, 2026: shown in full, the agent's text filled the card).
  const asked = brief.getByText('What Eli was asked to do');
  expect(asked.tagName).toBe('SUMMARY');
  expect(asked.parentElement!.className).toBe('sd-more');
  expect((asked.parentElement as HTMLDetailsElement).open).toBe(false);
  expect(brief.getByText('outcome()').tagName).toBe('CODE');
  expect(brief.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Keep the label.']);
  expect(brief.queryByText(/Files:|`/)).toBeNull();
  expect(brief.getByText('Done means')).toBeTruthy();
  expect(brief.getByText('Results are readable.')).toBeTruthy();
  expect(brief.getByText('May change')).toBeTruthy();
  expect(brief.getByText('src/result.mjs').className).toBe('sd-file');
  expect(brief.getByText('test/result.test.mjs').className).toBe('sd-file');
  // The story may still change its files, so the form that edits them is here too.
  expect(brief.getByText("Edit this story's files")).toBeTruthy();
  handedTo(brief);
  expect(brief.getByLabelText('Direction for the next attempt')).toBeTruthy();
});

test('other work has the brief card too, with its brief and what it was handed; it opens on Overview, or Activity before any attempt', async () => {
  handed(false);
  open();
  const brief = within(await screen.findByRole('region', { name: 'The brief' }, { timeout: 5000 }));
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('tab', { name: 'Result' })).toBeNull();
  // Other work's brief keeps every line it was written with; it has no files to change.
  expect(brief.getByText('outcome()').tagName).toBe('CODE');
  expect(brief.getByText(/^Files: src\/result\.mjs/)).toBeTruthy();
  expect(brief.queryByText('May change')).toBeNull();
  expect(brief.queryByText("Edit this story's files")).toBeNull();
  expect(brief.getByText('Results are readable.')).toBeTruthy();
  await waitFor(() => handedTo(brief));
  cleanup();
  controller.tasks = [{ ...controller.tasks[0]!, status: 'ready', lastAttemptId: undefined }];
  controller.attempts = [];
  open();
  expect(await screen.findByRole('region', { name: 'The brief' }, { timeout: 5000 })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
});

// Other work's Overview is where its Result tab was, on a wide screen and on a phone, and no story has an Attempts or a
// Record tab: its attempts are the strip above the tabs and each one's record a page that Details links to (a code
// story's wide tabs are above).
for (const [source, phone, labels, opens] of [
  [false, false, ['Overview', 'Activity'], 'Overview'],
  [false, true, ['Activity', 'Overview', 'Details'], 'Overview'],
  [true, true, ['Activity', 'Changes', 'Checks', 'Details'], 'Activity'],
] as const)
  test(`${source ? "a code story's" : "other work's"} tabs${phone ? ' on a phone' : ''} are ${labels.join(', ')}, and it opens on ${opens}`, async () => {
    width(phone);
    handed(source);
    open();
    const tablist = await screen.findByRole('tablist', { name: 'Story details' }, { timeout: 5000 });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map(tab => tab.firstChild?.textContent),
    ).toEqual(labels);
    expect(within(tablist).getByRole('tab', { name: opens }).getAttribute('aria-selected')).toBe('true');
    // The strip comes before the tabs.
    const strip = screen.getByRole('region', { name: 'Attempts' });
    expect(strip.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

test("other work's Overview leads with what its latest attempt returned, its files and what it raised, then the rest it handed back", async () => {
  const result = {
    outcome: 'completed',
    summary: 'Wrote the welcome guide.',
    issues: ['I could not check the screenshots.'],
    checks: [{ name: 'Read it through', status: 'pass', evidence: 'Every step works.' }],
  };
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Write the welcome guide',
      status: 'review',
      lastAttemptId: 'attempt-2',
      proposedTaskIds: ['T-2'],
    }),
    taskFixture('T-2', { title: 'Translate the guide', status: 'backlog' }),
  ];
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'failed',
      workerId: 'W-1',
      startedAt: '2026-10-28T09:00:00Z',
      finishedAt: '2026-10-28T09:20:00Z',
      result: { outcome: 'failed', summary: 'A first draft.' },
    },
    {
      id: 'attempt-2',
      taskId: 'T-1',
      status: 'review',
      workerId: 'W-1',
      startedAt: '2026-10-28T10:00:00Z',
      finishedAt: '2026-10-28T10:20:00Z',
      artifacts: [{ path: 'guide.md', hash: 'h-guide', kind: 'work-file' }],
      // The checks it reported, which the compact record's type leaves out.
      result: result as AttemptSummary['result'],
    },
  ];
  controller.artifacts['attempt-2/guide.md'] = '# Welcome\n\nStart here.';
  controller.details['attempt-2'] = {
    result: { ...result, handoff: 'Translate it next.' },
    employeeTestRuns: [
      { startedAt: '2026-10-28T10:10:00Z', files: [], exitCode: 0, totals: { pass: 3, fail: 0, tests: 3 } },
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
          timestamp: '2026-10-28T10:11:00Z',
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
          totals: { pass: 3, fail: 0, cancelled: 0, tests: 3 },
        },
      },
    ],
  };
  open();
  const panel = await screen.findByRole('tabpanel', {}, { timeout: 5000 });
  expect(screen.queryByRole('tab', { name: 'Result' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(await within(panel).findByText('Translate it next.', {}, { timeout: 5000 })).toBeTruthy();
  // The latest attempt's summary, the files it returned and what it raised, then the checks it reported, its
  // hand-off, the work it proposed, its own test runs and how its time went.
  const text = (panel.textContent ?? '').slice((panel.textContent ?? '').indexOf('What Eli returned')),
    parts = [
      'What Eli returned',
      'Wrote the welcome guide.',
      'Files it returned',
      'What it raised',
      'I could not check the screenshots.',
      'The checks it reported',
      'Read it through',
      'What it handed on to the next step',
      'Translate it next.',
      'The work it proposed',
      'Translate the guide',
      "Eli's own test runs",
      'How its time went',
    ],
    at = parts.map(words => text.indexOf(words));
  expect(parts.filter((_, index) => at[index]! < 0)).toEqual([]);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // The files it returned are in the file viewer, the first one open.
  expect(within(panel).getByRole('list', { name: 'Files' })).toBeTruthy();
  expect(await within(panel).findByRole('heading', { name: 'Welcome' })).toBeTruthy();
  // The attempt before it is not shown.
  expect(within(panel).queryByText('A first draft.')).toBeNull();
});

test('on a phone the brief card is under Details with the other side cards, shown once', async () => {
  const user = userEvent.setup();
  width(true);
  handed(true);
  open();
  const tab = await screen.findByRole('tab', { name: 'Details' }, { timeout: 5000 });
  expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('region', { name: 'The brief' })).toBeNull();
  await user.click(tab);
  const panel = screen.getByRole('tabpanel'),
    cards = [...panel.querySelectorAll('section.sd-sidecard')];
  expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['The brief', 'People', 'Details']);
  expect(screen.getAllByRole('region', { name: 'The brief' })).toEqual([cards[0]]);
  expect(screen.getAllByText('What Eli was asked to do')).toHaveLength(1);
  expect(document.querySelector('.sd-story__side')).toBeNull();
  handedTo(within(cards[0] as HTMLElement));
});

// A command's answer carries the records it changed (records.ts RecordSync.answer), so the page shows the task's new
// status and decisions without reading it again, before the stream's change event for it, which changes nothing more.
const decisions = () => {
  const stands = screen.getByRole('region', { name: 'Where it stands' });
  return {
    status: document.querySelector('.sd-storyhead__kind.sd-narrow-only .sd-chip')?.textContent,
    title: stands.querySelector('.sd-stands__title')?.textContent,
    // The decision row's buttons by name; More actions, when there is something to close, is last.
    buttons: [...stands.querySelectorAll('.sd-stands__actions button')].map(
      button => button.getAttribute('aria-label') ?? button.textContent,
    ),
  };
};
const proposedWork = {
  status: 'Planned',
  title: 'This proposed work needs approval before it can run.',
  buttons: ['Approve work', 'Deny work'],
};
const proposedStory = () => {
  edit({ status: 'backlog', approval: { status: 'pending' }, lastAttemptId: undefined });
  controller.attempts = [];
};

// The controller's decision on proposed work (src/core/proposals.mjs approveWork and denyWork).
test.each([
  {
    name: 'Approve work',
    step: 'approve-work',
    fields: { status: 'ready', approval: { status: 'approved', by: { type: 'director' } }, queued: true },
    shown: { status: 'Ready', title: 'This assignment is queued.' },
  },
  {
    name: 'Deny work',
    step: 'deny-work',
    fields: { status: 'denied', approval: { status: 'denied', reason: '' }, reason: 'Director denied this work.' },
    shown: { status: 'Denied', title: 'This work was denied.' },
  },
])(
  "$name shows the task's new status and decisions at once, before any live update",
  async ({ name, step, fields, shown }) => {
    const user = userEvent.setup();
    proposedStory();
    let answer: ReturnType<Controller['records']> | undefined;
    controller.command = url => {
      if (url !== `/api/tasks/T-1/${step}`) return {};
      edit({ ...fields, queued: fields.status === 'ready' });
      answer = controller.records(['T-1']);
      return { ok: true, records: answer };
    };
    open();
    await screen.findByRole('heading', { name: 'Show finished results' });
    await waitFor(() => expect(decisions()).toEqual(proposedWork));
    const reads = controller.reads().length;
    await user.click(within(screen.getByRole('region', { name: 'Where it stands' })).getByRole('button', { name }));
    if (name === 'Deny work')
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Deny this work?' })).getByRole('button', { name }),
      );
    await waitFor(() => expect(decisions()).toMatchObject(shown));
    const after = decisions();
    expect(after.buttons).not.toContain('Approve work');
    expect(after.buttons).not.toContain('Deny work');
    if (name === 'Approve work') expect(after.buttons).toContain('Withdraw approval and deny');
    // The task was not read again: the answer's records changed the page (settled work's live set is confirmed).
    expect(controller.reads().slice(reads)).not.toContain(taskUrl);
    // The stream's change for the same command reads the task again and leaves the page as it is.
    latest().emit('change', { version: answer!.version, start: answer!.start, changes: answer!.changes });
    await waitFor(() => expect(controller.reads().slice(reads)).toContain(taskUrl));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(decisions()).toEqual(after);
  },
);

test("a refused Approve work leaves the page's status and decisions as they were and shows the controller's reason", async () => {
  const user = userEvent.setup(),
    reason = 'Only pending Planned work can be approved.';
  proposedStory();
  controller.command = () => {
    throw new Error(reason);
  };
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  await waitFor(() => expect(decisions()).toEqual(proposedWork));
  const toast = () => document.querySelector('.sd-toast')?.textContent;
  await user.click(
    within(screen.getByRole('region', { name: 'Where it stands' })).getByRole('button', { name: 'Approve work' }),
  );
  await waitFor(() => expect(toast()).toBe(reason));
  expect(decisions()).toEqual(proposedWork);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(decisions()).toEqual(proposedWork);
});

// An agent's question to the director (1.2 step 2), as the controller records it on the attempt that stopped to ask.
const question = {
  ask: 'Keep the old route for one release?',
  why: 'Two pages still call it.',
  options: [{ label: 'Keep it' }, { label: 'Remove it', detail: 'and update both pages' }],
  recommended: 1,
  choice: 'inside-story',
  topics: [],
};
const asked = (fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id: 'attempt-1',
  taskId: 'T-1',
  status: 'blocked',
  workerId: 'W-1',
  startedAt: '2026-10-28T10:00:00.000Z',
  finishedAt: '2026-10-28T10:12:00.000Z',
  assignment: { kind: 'studio-development:change' },
  result: { outcome: 'blocked', summary: 'I need a call on the old route.' },
  question,
  ...fields,
});
// A code story whose editor stopped to ask the director.
const askingStory = (fields: object = {}) =>
  edit({
    kind: 'studio-development:change',
    status: 'blocked',
    lastAttemptId: 'attempt-1',
    sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'blocked', history: [] },
    ...fields,
  });
const posts = () => controller.requests.filter(request => request.method === 'POST');
const toastText = () => document.querySelector('.sd-toast')?.textContent;

test('a waiting question shows its card and Answer box at the top, above where the story stands, and sends the answer', async () => {
  const user = userEvent.setup();
  askingStory();
  controller.attempts = [asked()];
  open();
  const card = await screen.findByRole('article', { name: "Eli's question" }, { timeout: 5000 }),
    stands = screen.getByRole('region', { name: 'Where it stands' });
  expect(card.compareDocumentPosition(stands) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).getByText(question.ask)).toBeTruthy();
  // The build step and the notice are the director's: the agent asked them.
  expect(
    within(screen.getByRole('list', { name: 'Where the story is' })).getByText('Build · asked you a question'),
  ).toBeTruthy();
  expect(within(stands).getByText('Eli asked you a question.')).toBeTruthy();
  expect(within(stands).getByText(question.ask)).toBeTruthy();
  // Start stays, but answering is the main action.
  expect(within(stands).getByRole('button', { name: 'Start assignment' }).className).not.toMatch(/sd-btn--primary/);
  const box = within(within(card).getByRole('form', { name: 'Answer Eli' }));
  await user.click(box.getByRole('button', { name: /^Remove it/ }));
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() =>
    expect(posts()).toEqual([
      {
        url: '/api/tasks/T-1/answer',
        method: 'POST',
        body: { projectId: 'project-x', attemptId: 'attempt-1', option: 1 },
      },
    ]),
  );
  await waitFor(() => expect(toastText()).toBe('Answered. Eli continues from its saved work.'));
});

// Auto mode answered the question with the agent's recommendation, and the work goes on with it.
for (const status of ['running', 'review'])
  test(`auto mode's answer on ${status} work shows what it chose, Change the answer sends the director's, and it goes once the work is accepted`, async () => {
    const user = userEvent.setup(),
      at = '2026-10-28T10:13:00.000Z';
    edit({
      status,
      lastAttemptId: 'attempt-2',
      answers: [{ attemptId: 'attempt-1', option: 1, label: 'Remove it', by: { type: 'auto-mode', at }, at }],
    });
    controller.attempts = [
      asked({ assignment: { kind: 'general' } }),
      {
        id: 'attempt-2',
        taskId: 'T-1',
        status,
        workerId: 'W-1',
        startedAt: '2026-10-28T10:14:00.000Z',
        result: { outcome: 'completed', summary: 'Removed the old route.' },
      },
    ];
    open();
    const answer = await screen.findByRole('region', { name: "Auto mode's answer" }, { timeout: 5000 }),
      shown = within(answer);
    expect(shown.getByText('Eli asked')).toBeTruthy();
    expect(shown.getByText(question.ask)).toBeTruthy();
    expect(shown.getByText('Auto mode chose')).toBeTruthy();
    expect(shown.getByText('Remove it')).toBeTruthy();
    // No question waits, so no card asks; the box opens only to change the answer.
    expect(screen.queryByRole('article', { name: "Eli's question" })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Answer Eli' })).toBeNull();
    await user.click(shown.getByRole('button', { name: 'Change the answer' }));
    const box = within(shown.getByRole('form', { name: 'Answer Eli' }));
    expect(box.getByText("Your answer replaces auto mode's, and Eli reworks from its saved work.")).toBeTruthy();
    await user.click(box.getByRole('button', { name: /^Keep it/ }));
    await user.click(box.getByRole('button', { name: 'Change the answer' }));
    await waitFor(() =>
      expect(posts()).toEqual([
        {
          url: '/api/tasks/T-1/change-answer',
          method: 'POST',
          body: { projectId: 'project-x', attemptId: 'attempt-1', option: 0 },
        },
      ]),
    );
    await waitFor(() => expect(toastText()).toBe('Changed the answer. Eli reworks from its saved work.'));
    // Accepted work keeps auto mode's answer for good.
    edit({ status: 'done', acceptedAttemptId: 'attempt-2' });
    controller.attempts = [controller.attempts[0]!, { ...controller.attempts[1]!, status: 'accepted' }];
    change(2, [{ seq: 2, type: 'task', id: 'T-1', projectId: 'project-x' }]);
    await waitFor(() => expect(screen.queryByRole('region', { name: "Auto mode's answer" })).toBeNull());
    expect(screen.getByRole('heading', { level: 1, name: 'Show finished results' })).toBeTruthy();
  });

test("a question that could not be read shows the agent's stop with why, and no Answer box", async () => {
  const problem = 'question.json must be readable JSON of at most 32 KiB.';
  askingStory();
  controller.attempts = [asked({ question: { problem } })];
  open();
  const stands = await screen.findByRole('region', { name: 'Where it stands' }, { timeout: 5000 });
  expect(
    await within(stands).findByText(
      'The employee could not complete the assignment with the available inputs or access.',
    ),
  ).toBeTruthy();
  expect(stands.textContent).toContain(`The agent's question could not be read: ${problem}`);
  expect(within(stands).getByRole('button', { name: 'Start assignment' }).className).toMatch(/sd-btn--primary/);
  expect(screen.queryByRole('article', { name: "Eli's question" })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Answer Eli' })).toBeNull();
  expect(screen.queryByText('Build · asked you a question')).toBeNull();
});

test("the story's attempt strip names the attempt that asked without a number, and the next one is 1", async () => {
  askingStory({
    status: 'running',
    lastAttemptId: 'attempt-2',
    sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'implementing', history: [] },
    answers: [{ attemptId: 'attempt-1', option: 1, label: 'Remove it', by: { type: 'director' } }],
  });
  controller.attempts = [
    asked(),
    {
      id: 'attempt-2',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      startedAt: '2026-10-28T10:20:00.000Z',
      assignment: { kind: 'studio-development:change' },
    },
  ];
  open();
  const strip = await screen.findByRole('region', { name: 'Attempts' }, { timeout: 5000 }),
    chips = [...strip.querySelectorAll('.sd-attemptchip')].map(chip => chip.textContent);
  expect(chips).toEqual(['Asked you a question', '1 · Running now']);
  // The limit counts the build that runs, not the one that asked; its review comes after it's built.
  expect(strip.querySelector('.sd-attemptstrip__limit')?.textContent).toBe(
    'The house rules allow 3 automatic attempts. 1 is used and 2 are left.',
  );
  expect(within(within(strip).getByRole('group', { name: 'Review' })).getByText("after it's built")).toBeTruthy();
  expect(strip.textContent).not.toMatch(/Attempt \d+ of \d+/);
});

// What an attempt said, as its trace records it, so its conversation shows in the story's Activity.
const said = (attemptId: string, status: string, at: string, text: string) =>
  (controller.traces[attemptId] = {
    schemaVersion: 'attempt-trace-v1',
    attemptId,
    taskId: 'T-1',
    provider: 'claude',
    status,
    source: 'activity-file',
    lines: 1,
    counts: { say: 1 },
    steps: [{ seq: 0, at, kind: 'say', text }],
    phases: [],
    handoff: null,
  });
// A code story whose first attempt asked and whose second works on the answers recorded for it.
const answeredStory = (answers: object[]) => {
  askingStory({
    status: 'running',
    lastAttemptId: 'attempt-2',
    sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'implementing', history: [] },
    answers,
  });
  controller.attempts = [
    asked(),
    {
      id: 'attempt-2',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      startedAt: '2026-10-28T10:20:00.000Z',
      assignment: { kind: 'studio-development:change' },
    },
  ];
  said('attempt-1', 'blocked', '2026-10-28T10:05:00.000Z', 'Asking first.');
  said('attempt-2', 'running', '2026-10-28T10:21:00.000Z', 'Removing the old route now.');
};
// The story's Activity once the asking attempt's conversation shows, its chapter opened when a later one folds it.
const storyActivity = async () => {
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Activity' }, { timeout: 5000 }));
  const panel = await screen.findByRole('tabpanel'),
    line = lineOf((await within(panel).findAllByRole('region', { name: /^Build, / }))[0]!);
  if (line.getAttribute('aria-expanded') === 'false') await user.click(line);
  await within(panel).findByText('Asking first.', {}, { timeout: 5000 });
  return panel;
};
const exchangeOf = (panel: HTMLElement) =>
  within(panel).getByRole('region', { name: "Eli's question and its answers" });
// Each of the words shows in the panel, in this order.
const inOrder = (panel: HTMLElement, words: string[]) => {
  const text = panel.textContent ?? '',
    at = words.map(item => text.indexOf(item));
  expect(words.filter((_, index) => at[index]! < 0)).toEqual([]);
  expect(at).toEqual([...at].sort((a, b) => a - b));
};

test("a story's Activity shows the question right after the attempt that asked, every option with the recommended one marked, then your answer", async () => {
  const at = '2026-10-28T10:15:00.000Z';
  answeredStory([
    {
      attemptId: 'attempt-1',
      option: 1,
      label: 'Remove it',
      text: 'Update both pages too.',
      autoMode: true,
      by: { type: 'director', at },
      at,
    },
  ]);
  const panel = await storyActivity(),
    shown = within(exchangeOf(panel));
  expect(shown.getByText(question.ask)).toBeTruthy();
  expect(shown.getByText(question.why)).toBeTruthy();
  expect(
    within(shown.getByRole('list', { name: "Eli's options" }))
      .getAllByRole('listitem')
      .map(item => item.textContent),
  ).toEqual(['Keep it', 'Remove it and update both pages Recommended']);
  // Your answer is your own message: the option you picked, your words, and the Auto mode it set.
  const yours = shown.getByText('Answered: Remove it').closest('.sd-bubble--mine')!;
  expect(yours.textContent).toContain('Update both pages too.');
  expect(yours.querySelector('.sd-meta')?.textContent).toMatch(/^You · .+ · Set Auto mode on$/);
  expect(shown.queryByText(/^Chose /)).toBeNull();
  expect(shown.queryByText('No answer yet.')).toBeNull();
  // After the attempt that asked, before the next; the attempt that asked nothing has no exchange.
  inOrder(panel, [
    'Asking first.',
    question.ask,
    question.why,
    'Keep it',
    'Remove it and update both pages',
    'Recommended',
    'Answered: Remove it',
    'Update both pages too.',
    'You ·',
    'Removing the old route now.',
  ]);
  expect(within(panel).getAllByRole('region', { name: /question and its answers$/ })).toHaveLength(1);
});

test("auto mode's answer shows as a quiet line after the attempt that asked, and your change of it follows as your own message", async () => {
  const at = '2026-10-28T10:13:00.000Z',
    later = '2026-10-28T10:25:00.000Z',
    auto = { attemptId: 'attempt-1', option: 1, label: 'Remove it', by: { type: 'auto-mode', at }, at };
  answeredStory([auto]);
  const panel = await storyActivity(),
    line = within(exchangeOf(panel)).getByText(/^Chose Remove it · /);
  expect(line.closest('.sd-event')?.textContent).toMatch(/^Auto modeChose Remove it · /);
  expect(within(exchangeOf(panel)).queryByText(/^You ·/)).toBeNull();
  inOrder(panel, ['Asking first.', question.ask, 'Chose Remove it', 'Removing the old route now.']);
  // The director changes auto mode's answer: both show, auto mode's first, then theirs, marked as changing it.
  edit({
    answers: [
      auto,
      {
        attemptId: 'attempt-1',
        option: 0,
        label: 'Keep it',
        text: 'One more release.',
        replaces: 'auto-mode',
        by: { type: 'director', at: later },
        at: later,
      },
    ],
  });
  change(2, [{ seq: 2, type: 'task', id: 'T-1', projectId: 'project-x' }]);
  const changed = await screen.findByText("Changed auto mode's answer: Keep it", {}, { timeout: 5000 }),
    shown = screen.getByRole('tabpanel');
  expect(changed.closest('.sd-bubble--mine')?.textContent).toMatch(/One more release\.You · /);
  inOrder(shown, [
    'Asking first.',
    question.ask,
    'Chose Remove it',
    "Changed auto mode's answer: Keep it",
    'One more release.',
    'Removing the old route now.',
  ]);
});

test('a question still waiting shows in Activity with no answer yet', async () => {
  askingStory();
  controller.attempts = [asked()];
  said('attempt-1', 'blocked', '2026-10-28T10:05:00.000Z', 'Asking first.');
  const panel = await storyActivity(),
    shown = within(exchangeOf(panel));
  expect(shown.getByText(question.ask)).toBeTruthy();
  expect(shown.getByText(question.why)).toBeTruthy();
  expect(shown.getByText('No answer yet.')).toBeTruthy();
  expect(shown.queryByText(/^You ·/)).toBeNull();
  expect(shown.queryByText(/^Chose /)).toBeNull();
  inOrder(panel, ['Asking first.', question.ask, 'No answer yet.']);
});

test('an attempt whose question could not be read shows no exchange in Activity', async () => {
  askingStory();
  controller.attempts = [asked({ question: { problem: 'question.json must be readable JSON of at most 32 KiB.' } })];
  said('attempt-1', 'blocked', '2026-10-28T10:05:00.000Z', 'Asking first.');
  const panel = await storyActivity();
  expect(within(panel).queryByRole('region', { name: /question and its answers$/ })).toBeNull();
  expect(within(panel).queryByText('No answer yet.')).toBeNull();
});

test("a code story's brief leads with the planner's plain summary, with the agent's text folded", async () => {
  handed(true);
  controller.tasks = [
    { ...controller.tasks[0]!, summary: 'Shows finished results in plain words.' },
    ...controller.tasks.slice(1),
  ];
  open();
  const brief = within(await screen.findByRole('region', { name: 'The brief' }, { timeout: 5000 }));
  const summary = brief.getByText('Shows finished results in plain words.');
  expect(summary.tagName).toBe('P');
  // The summary comes before what was asked, which stays folded.
  const asked = brief.getByText('What Eli was asked to do');
  expect(summary.compareDocumentPosition(asked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect((asked.parentElement as HTMLDetailsElement).open).toBe(false);
});
