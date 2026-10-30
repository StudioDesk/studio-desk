// How an agent worked on one attempt (v1.0 items 21 and 23): the trace's totals, a note when the CLI blocked
// commands, every step in chapters with filters, and the story's other attempts beside it. A running attempt's page
// follows its newest steps, with New updates for a reader who scrolled up; a finished one holds still.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock, type MockInstance } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

let controller: Controller;
const step = (seq: number, kind: string, facts: object) => ({ seq, at: `2026-10-21T20:0${seq}:00Z`, kind, ...facts });

beforeEach(() => {
  controller = fakeController();
  controller.tasks = [
    taskFixture('T-1', { title: 'Show finished results', status: 'review', lastAttemptId: 'attempt-2' }),
  ];
  controller.attempts = [
    { id: 'attempt-1', taskId: 'T-1', status: 'failed', workerId: 'W-1', startedAt: '2026-10-21T19:00:00Z' },
    { id: 'attempt-2', taskId: 'T-1', status: 'accepted', workerId: 'W-1', startedAt: '2026-10-21T20:00:00Z' },
  ];
  controller.traces['attempt-2'] = {
    schemaVersion: 'attempt-trace-v1',
    attemptId: 'attempt-2',
    taskId: 'T-1',
    provider: 'claude',
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    status: 'accepted',
    source: 'activity-file',
    lines: 120,
    setup: { tools: 24, mcpServers: [] },
    usage: { windows: { five_hour: { before: 2, after: 6, resetsAt: null } } },
    counts: { say: 1, think: 1, thinkTokens: 400, shell: 1, edit: 1, blocked: 1 },
    steps: [
      step(0, 'think', { durationMs: 2000, tokens: 400 }),
      step(1, 'shell', { command: 'ls src', description: 'Look around the source', exitCode: 0 }),
      step(2, 'edit', { path: 'src/results.mjs', change: 'edit', added: 4, removed: 1 }),
      step(3, 'blocked', {
        tool: 'Bash',
        description: 'Run the tests in a scratch copy',
        detail: 'cp -r src $TEMP && node --test',
        reason: "A variable in this command can't be checked before it runs.",
      }),
      step(4, 'say', { text: 'Handing off untested.' }),
    ],
    phases: [],
    handoff: { at: '2026-10-21T20:05:00Z', outcome: 'completed', summary: 'Results read in place.' },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path: string) =>
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );

test("an attempt's trace shows its totals, says what was blocked, and filters its steps", async () => {
  const user = userEvent.setup();
  open('/p/project-x/tasks/T-1/attempts/attempt-2');
  expect(await screen.findByRole('heading', { level: 1, name: 'How Eli worked on attempt 2' })).toBeTruthy();
  expect(screen.getByText('2% → 6%')).toBeTruthy();
  expect(screen.getByText("Claude Code blocked 1 of Eli's command.", { exact: false })).toBeTruthy();
  const steps = within(screen.getByRole('region', { name: 'Every step' }));
  expect(steps.getByText('Thought for 2 s · about 400 tokens')).toBeTruthy();
  expect(steps.getByText('Look around the source')).toBeTruthy();
  expect(
    steps.getByText("Claude Code refused it: a variable in this command can't be checked before it runs.", {
      exact: false,
    }),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Show the 1 blocked command' }));
  expect(steps.queryByText('Look around the source')).toBeNull();
  expect(steps.getByText('Tried to run the tests in a scratch copy')).toBeTruthy();
  await user.click(steps.getByRole('switch', { name: 'Show thinking' }));
  await user.click(steps.getByRole('button', { name: /^All/ }));
  expect(steps.queryByText('Thought for 2 s · about 400 tokens')).toBeNull();
  // The story's attempts, this one current, each opening its own trace.
  const attempts = within(screen.getByRole('region', { name: "This task's attempts" })).getAllByRole('link');
  expect(attempts.map(link => [link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
    ['/p/project-x/tasks/T-1/attempts/attempt-1', null],
    ['/p/project-x/tasks/T-1/attempts/attempt-2', 'page'],
  ]);
});

test('an attempt without a trace says so and points to the raw log', async () => {
  open('/p/project-x/tasks/T-1/attempts/attempt-1');
  expect(await screen.findByText('The trace could not be read.')).toBeTruthy();
});

// The page follows the steps with the shared follower (follow.tsx). The scroll geometry is a stand-in: each step is
// 100px tall, the steps start 300px down a 600px window, and a scroll moves the page at once, as it does where
// matchMedia is missing. No browser lays out or scrolls anything.
describe("a running attempt's page", () => {
  const stepHeight = 100,
    stepsTop = 300,
    windowHeight = 600;
  let y = 0,
    version = 1,
    scrollTo: Mock<(options: ScrollToOptions) => void>,
    rect: MockInstance<() => DOMRect>;
  const place = (to: number) => {
    y = to;
    vi.stubGlobal('scrollY', to);
  };
  // The steps under the bar in Every step, which the follower watches, and how tall they are as shown.
  const isSteps = (element: Element) =>
      !!element.parentElement?.classList.contains('sd-tracemain') &&
      !!element.previousElementSibling?.classList.contains('sd-tracebar'),
    steps = () => screen.getByRole('region', { name: 'Every step' }).querySelector('.sd-tracebar')!.nextElementSibling!,
    height = (element: Element) => element.querySelectorAll('.sd-step').length * stepHeight,
    // The page's scroll with the newest step at the window's bottom.
    end = () => Math.max(0, stepsTop + height(steps()) - windowHeight),
    scroll = (to: number) => {
      place(to);
      fireEvent.scroll(window);
    },
    // The page's own scrolls. The router puts each page it opens at the top and left, as a browser does; the
    // follower only ever scrolls down.
    scrolls = () =>
      scrollTo.mock.calls.map(([options]) => options).filter(options => !(options.top === 0 && options.left === 0)),
    button = () => screen.queryByRole('button', { name: /New updates/ }),
    say = (seq: number) => step(seq, 'say', { text: `Step ${seq}` }),
    running = (list: object[]) => ({
      schemaVersion: 'attempt-trace-v1',
      attemptId: 'attempt-3',
      taskId: 'T-1',
      provider: 'claude',
      status: 'running',
      source: 'activity-file',
      lines: 40,
      counts: {},
      steps: list,
      phases: [],
      handoff: null,
    });

  beforeEach(() => {
    controller.tasks = [
      taskFixture('T-1', { title: 'Show finished results', status: 'running', lastAttemptId: 'attempt-3' }),
    ];
    controller.attempts.push({
      id: 'attempt-3',
      taskId: 'T-1',
      status: 'running',
      workerId: 'W-1',
      startedAt: '2026-10-21T20:00:00Z',
    });
    controller.traces['attempt-3'] = running([
      step(0, 'think', { durationMs: 2000 }),
      say(1),
      step(2, 'shell', { command: 'ls src', description: 'Look around the source', exitCode: 0 }),
      say(3),
      step(4, 'shell', {
        command: 'npm test',
        description: 'Run the tests',
        exitCode: 0,
        output: { head: 'all 12 tests pass', tail: '', cut: false },
      }),
      say(5),
    ]);
    place(0);
    vi.stubGlobal('innerHeight', windowHeight);
    scrollTo = vi.fn((options: ScrollToOptions) => place(options.top ?? y));
    vi.stubGlobal('scrollTo', scrollTo);
    const original = Element.prototype.getBoundingClientRect;
    rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (!isSteps(this)) return original.call(this);
      const top = stepsTop - y,
        bottom = top + height(this);
      return { x: 0, y: top, top, bottom, left: 0, right: 0, width: 0, height: bottom - top, toJSON: () => ({}) };
    });
  });
  afterEach(() => rect.mockRestore());

  // Opens the running attempt's page once its newest step shows and the page follows the attempt's log.
  async function opened() {
    open('/p/project-x/tasks/T-1/attempts/attempt-3');
    await screen.findByText('Step 5');
    await waitFor(() => expect(latest().url).toContain('log=attempt-3'));
  }
  // The attempt writes steps: its record changes, and the page reads the steps after the last one it shows.
  async function more(...seqs: number[]) {
    controller.traces['attempt-3'] = running(seqs.map(say));
    version += 1;
    latest().emit('change', {
      version,
      start: 'start-a',
      changes: [{ seq: version, type: 'attempt', id: 'attempt-3', taskId: 'T-1', projectId: 'project-x' }],
    });
    await screen.findByText(`Step ${seqs.at(-1)}`, {}, { timeout: 3000 });
  }

  test('it opens at its newest steps and, with the end in view, keeps the newest in view as steps arrive', async () => {
    await opened();
    expect(end()).toBeGreaterThan(0);
    expect(y).toBe(end());
    expect(scrolls()).toEqual([{ top: end(), behavior: 'auto' }]);
    await more(6);
    expect(y).toBe(end());
    await more(7, 8);
    expect(y).toBe(end());
    expect(button()).toBeNull();
  });

  test('scrolled up, new steps hold still and New updates counts them; pressing it goes to the newest and follows again', async () => {
    const user = userEvent.setup();
    await opened();
    const reading = end() - 200;
    scroll(reading);
    scrollTo.mockClear();
    await more(6);
    expect(y).toBe(reading);
    expect(screen.getByRole('button', { name: 'New updates: 1' })).toBeTruthy();
    await more(7, 8);
    expect(y).toBe(reading);
    expect(scrolls()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'New updates: 3' }));
    expect(y).toBe(end());
    expect(button()).toBeNull();
    await more(9);
    expect(y).toBe(end());
    expect(button()).toBeNull();
  });

  test('scrolling back to the bottom clears New updates and follows again', async () => {
    await opened();
    scroll(end() - 200);
    await more(6, 7);
    expect(screen.getByRole('button', { name: 'New updates: 2' })).toBeTruthy();
    scroll(end());
    expect(button()).toBeNull();
    await more(8);
    expect(y).toBe(end());
    expect(button()).toBeNull();
  });

  test('its filters and toggles keep working, and a change to them is not an update', async () => {
    const user = userEvent.setup();
    await opened();
    const shown = within(screen.getByRole('region', { name: 'Every step' }));
    scrollTo.mockClear();
    // At the newest, they change what shows and leave the page where it is.
    await user.click(shown.getByRole('switch', { name: 'Show tool output' }));
    expect(shown.getByText('all 12 tests pass')).toBeTruthy();
    await user.click(shown.getByRole('button', { name: /^Commands/ }));
    expect(shown.queryByText('Step 5')).toBeNull();
    expect(shown.getByText('Run the tests')).toBeTruthy();
    await user.click(shown.getByRole('button', { name: /^All/ }));
    expect(scrolls()).toEqual([]);
    expect(button()).toBeNull();
    // Scrolled up, they leave the count of new steps as it was.
    scroll(end() - 200);
    await more(6);
    expect(screen.getByRole('button', { name: 'New updates: 1' })).toBeTruthy();
    await user.click(shown.getByRole('switch', { name: 'Show thinking' }));
    expect(shown.queryByText('Thought for 2 s')).toBeNull();
    await user.click(shown.getByRole('button', { name: /^Talk/ }));
    expect(shown.queryByText('Run the tests')).toBeNull();
    await user.click(shown.getByRole('switch', { name: 'Show tool output' }));
    expect(screen.getByRole('button', { name: 'New updates: 1' })).toBeTruthy();
    expect(scrolls()).toEqual([]);
  });

  test("a finished attempt's page opens at the top, never scrolls on its own and shows no New updates", async () => {
    const user = userEvent.setup();
    open('/p/project-x/tasks/T-1/attempts/attempt-2');
    const shown = within(await screen.findByRole('region', { name: 'Every step' }));
    expect(shown.getByText('Look around the source')).toBeTruthy();
    expect(end()).toBeGreaterThan(0);
    expect(y).toBe(0);
    scroll(200);
    scroll(100);
    await user.click(shown.getByRole('switch', { name: 'Show thinking' }));
    expect(y).toBe(100);
    expect(scrolls()).toEqual([]);
    expect(button()).toBeNull();
  });
});
