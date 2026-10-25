// How an agent worked on one attempt (v1.0 items 21 and 23): the trace's totals, a note when the CLI blocked
// commands, every step in chapters with filters, and the story's other attempts beside it.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

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
