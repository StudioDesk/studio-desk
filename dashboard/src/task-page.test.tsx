// A task's page, the story page of the redesign (MP-026, v1.0 item 23): it loads its task with the project's
// shared records, refreshes the task only when the stream names it, keeps what the director is doing through every
// refresh, and streams the activity only while its tab is shown.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary } from './api';
import { App } from './app';
import { LiveStream } from './live';
import { createAppRouter } from './router';
import { FakeSource, createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

let controller: Controller;
const taskUrl = '/api/tasks/T-1?projectId=project-x';

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
const edit = (fields: object) => (controller.tasks = [{ ...controller.tasks[0]!, ...fields }]);

test("the page loads its task with the project's shared records, and a change fetches only the task it names", async () => {
  // A finished attempt, whose Result is what it returned; a running one's is its live activity.
  controller.attempts = [{ ...controller.attempts[0]!, status: 'succeeded' }];
  open();
  expect(await screen.findByRole('heading', { level: 1, name: 'Show finished results' })).toBeTruthy();
  expect(latest().url).toBe('/api/events?projectId=project-x');
  // Pages read once the stream has opened, so nothing is read twice; the attempt shown reads its full record.
  await waitFor(() =>
    expect([...controller.reads()].sort()).toEqual([
      detailUrl,
      '/api/projects/project-x/live',
      '/api/projects/project-x/shell',
      taskUrl,
    ]),
  );
  // Another task and a run: the live set reloads, and nothing is read for the task no page holds.
  change(11, [
    { seq: 11, type: 'task', id: 'T-2', projectId: 'project-x' },
    { seq: 11, type: 'attempt', id: 'attempt-9', taskId: 'T-2', projectId: 'project-x' },
    { seq: 11, type: 'run', id: 'run-1', projectId: 'project-x' },
  ]);
  await waitFor(() => expect(controller.reads()).toHaveLength(5));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(controller.reads().at(-1)).toBe('/api/projects/project-x/live');
  expect(controller.reads()).toHaveLength(5);
  edit({ title: 'Show finished results inline' });
  change(12, [{ seq: 12, type: 'task', id: 'T-1', projectId: 'project-x' }]);
  expect(await screen.findByRole('heading', { name: 'Show finished results inline' })).toBeTruthy();
  controller.attempts = [{ ...controller.attempts[0]!, status: 'succeeded', result: { summary: 'Halfway.' } }];
  change(13, [{ seq: 13, type: 'attempt', id: 'attempt-1', taskId: 'T-1', projectId: 'project-x' }]);
  expect(await screen.findByText('Halfway.')).toBeTruthy();
  // A change to the shown attempt reads its full record again; one to the task alone does not.
  await waitFor(() => expect(controller.reads().slice(5).sort()).toEqual([detailUrl, taskUrl, taskUrl]));
});

test('a brief written in Markdown reads as formatted text, not as its marks', async () => {
  edit({
    brief: 'Files: `src/a.mjs`\n\nIn `outcome()`, add one branch:\n\n1. Keep the label.\n2. Change the text.',
  });
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('tab', { name: 'Overview' }));
  const brief = within(screen.getByRole('tabpanel'));
  expect(brief.getByRole('heading', { name: 'What Eli was asked to do' })).toBeTruthy();
  expect(brief.getByText('src/a.mjs').tagName).toBe('CODE');
  expect(brief.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Keep the label.', 'Change the text.']);
  expect(brief.queryByText(/`/)).toBeNull();
});

test('a draft direction keeps its text and cursor through a refresh, and saving sends it', async () => {
  const user = userEvent.setup();
  edit({ status: 'failed' });
  open();
  await user.click(await screen.findByRole('tab', { name: 'Overview' }));
  const box = (await screen.findByLabelText('Direction for the next attempt')) as HTMLTextAreaElement;
  expect(box.value).toBe('Recorded direction.');
  await user.clear(box);
  await user.type(box, 'Name the failing test.');
  edit({ title: 'Refreshed while typing', direction: 'Someone else saved this.' });
  change(2, [{ seq: 2, type: 'task', id: 'T-1', projectId: 'project-x' }]);
  await screen.findByRole('heading', { name: 'Refreshed while typing' });
  expect(box.isConnected).toBe(true);
  expect(box.value).toBe('Name the failing test.');
  expect(document.activeElement).toBe(box);
  await user.click(screen.getByRole('button', { name: 'Save future direction' }));
  await waitFor(() => expect(controller.requests.some(request => request.method === 'PATCH')).toBe(true));
  expect(controller.requests.find(request => request.method === 'PATCH')).toEqual({
    url: '/api/tasks/T-1',
    method: 'PATCH',
    body: { projectId: 'project-x', direction: 'Name the failing test.' },
  });
});

test("a running step's Result is its activity; the Activity tab streams only that attempt's lines while open, and stops when closed", async () => {
  const user = userEvent.setup();
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  // A running step opens on its Result, which is what its agent is doing until it hands back.
  expect(await screen.findByText(/is working on it now/)).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'Overview' }));
  await waitFor(() => expect(latest().url).toBe('/api/events?projectId=project-x'));
  const tab = screen.getByRole('tab', { name: 'Activity' });
  await user.click(tab);
  expect(await screen.findByLabelText('Raw log')).toBeTruthy();
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
  await user.click(screen.getByRole('tab', { name: 'Overview' }));
  await waitFor(() => expect(latest().url).toBe('/api/events?projectId=project-x'));
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
  // A finished attempt's Result tab names each file set aside with why, with or without a continuation.
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

test("a code story's attempts say what earlier work they continued, or why they started fresh, from their summaries", async () => {
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
  await user.click(await screen.findByRole('tab', { name: /^Attempts/ }));
  expect(await screen.findByText('Continued from attempt-2: src/a.mjs, test/a.test.mjs')).toBeTruthy();
  expect(screen.queryByText(/Started fresh/)).toBeNull();
  expect(screen.queryByText(/^Git set /)).toBeNull();
  const [first, second, third] = within(screen.getByRole('tabpanel')).getAllByRole('button');
  expect(third!.getAttribute('aria-pressed')).toBe('true');
  expect(third!.textContent).toMatch(/^Attempt 3 of /);
  await user.click(second!);
  expect(
    await screen.findByText(
      'Started fresh instead of the work of attempt-1: the source of files it changed was committed since that attempt (src/a.mjs). Its history still shows that work.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Continued from/)).toBeNull();
  await user.click(first!);
  expect(screen.queryByText(/Continued from/)).toBeNull();
  expect(screen.queryByText(/Started fresh/)).toBeNull();
  expect(
    await screen.findByText(
      'Git set src/gone.mjs aside for the editor, because one side deleted it and the other changed it. The current source deleted src/gone.mjs since.',
    ),
  ).toBeTruthy();
  // The attempt chosen is the one the other tabs show: its activity ends with what it handed off.
  await user.click(screen.getByRole('tab', { name: 'Activity' }));
  expect(await screen.findByText('First try.')).toBeTruthy();
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
  await user.click(screen.getByRole('tab', { name: 'Attempts' }));
  expect(screen.getByText('No attempt has been launched.')).toBeTruthy();
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

test("a reviewed step's Result shows its work first, then the review, unless another attempt is chosen", async () => {
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
  expect(await within(panel).findByText('Wrote the welcome guide.')).toBeTruthy();
  const text = panel.textContent ?? '',
    at = ['Wrote the welcome guide.', 'Morgan · Independent work review', 'The guide covers every station.'].map(
      words => text.indexOf(words),
    );
  expect(at.every(index => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // An attempt the director chooses is shown alone.
  await user.click(screen.getByRole('tab', { name: /^Attempts/ }));
  const [work] = within(await screen.findByRole('tabpanel')).getAllByRole('button');
  await user.click(work!);
  await user.click(screen.getByRole('tab', { name: 'Result' }));
  const chosen = await screen.findByRole('tabpanel');
  expect(await within(chosen).findByText('Wrote the welcome guide.')).toBeTruthy();
  expect(within(chosen).queryByText('The guide covers every station.')).toBeNull();
});

test("a reviewed step's Attempts lists its work and its reviews apart, and counts only the work against its limit", async () => {
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
  // The first review sent the work back; the second is waiting for the director.
  controller.attempts = [
    step('attempt-w1', 'general:work', '2026-10-24T10:00:00Z'),
    step('attempt-r1', 'general:review', '2026-10-24T10:20:00Z', { workReviewVerdict: 'needs-work' }),
    step('attempt-w2', 'general:work', '2026-10-24T10:40:00Z'),
    step('attempt-r2', 'general:review', '2026-10-24T11:00:00Z', { status: 'review' }),
  ];
  open();
  await screen.findByRole('heading', { name: 'Show finished results' });
  const tab = screen.getByRole('tab', { name: /^Attempts/ });
  // The tab counts the work's own attempts, as the side panel does; the reviews are a step of their own.
  expect(tab.querySelector('.sd-tabs__count')?.textContent).toBe('2');
  expect(within(screen.getByRole('region', { name: 'Details' })).getByText('2 of 2 used')).toBeTruthy();
  await user.click(tab);
  const panel = await screen.findByRole('tabpanel'),
    rows = [...panel.querySelectorAll('.sd-eyebrow, button')].map(item =>
      item.tagName === 'BUTTON' ? item.querySelector('b')?.textContent : item.textContent,
    );
  expect(rows).toEqual([
    'Work · 2 of 2 attempts used',
    'Attempt 1 of 2',
    'Attempt 2 of 2',
    'Review',
    'Review 1',
    'Review 2',
  ]);
  // A review reads as its verdict, as a code story's does.
  expect(within(panel).getAllByRole('button')[2]!.textContent).toContain('Asked for changes');
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
  [false, 'Result'],
] as const)
  for (const phone of [false, true])
    test(`a stopped ${source ? "story's Checks" : "work's Result"} starts with where it stands in full${phone ? ', on a phone too' : ''}`, async () => {
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
  [false, 'Result'],
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
  [false, 'Result', /is working on it now/],
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

// A command's answer carries the records it changed (records.ts RecordSync.answer), so the page shows the task's new
// status and decisions without reading it again, before the stream's change event for it, which changes nothing more.
const decisions = () => {
  const stands = screen.getByRole('region', { name: 'Where it stands' });
  return {
    status: document.querySelector('.sd-storyhead__kind.sd-narrow-only .sd-chip')?.textContent,
    title: stands.querySelector('.sd-stands__title')?.textContent,
    buttons: [...stands.querySelectorAll('.sd-stands__actions button')].map(button => button.textContent),
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

test("the story's Attempts names the attempt that asked as not counted, and the next one is attempt 1", async () => {
  const user = userEvent.setup();
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
  const tab = await screen.findByRole('tab', { name: /^Attempts/ }, { timeout: 5000 });
  await user.click(tab);
  const panel = await screen.findByRole('tabpanel'),
    rows = [...panel.querySelectorAll('.sd-eyebrow, button')].map(item =>
      item.tagName === 'BUTTON' ? item.querySelector('b')?.textContent : item.textContent,
    );
  expect(rows).toEqual(['Build · 1 of 3 attempts used', 'Asked you a question, not counted', 'Attempt 1 of 3']);
});
