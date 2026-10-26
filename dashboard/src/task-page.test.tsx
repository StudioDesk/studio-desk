// A task's page, the story page of the redesign (MP-026, v1.0 item 23): it loads its task with the project's
// shared records, refreshes the task only when the stream names it, keeps what the director is doing through every
// refresh, and streams the activity only while its tab is shown.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
    story('attempt-1', '2026-10-21T20:00:00Z', 'First try.'),
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
  await user.click(screen.getByRole('tab', { name: 'Attempts' }));
  expect(screen.getByText('No attempt has been launched.')).toBeTruthy();
});

test('a reconnecting stream asks for what it missed, and reloads after a restart or when the controller cannot say', async () => {
  FakeSource.hello = null;
  const received: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      controller.requests.push({ url, method: 'GET' });
      return url.includes('after=3')
        ? {
            ok: true,
            status: 200,
            json: async () => ({ version: 8, start: 'start-a', changes: [{ seq: 4, type: 'task', id: 'T-1' }] }),
          }
        : { ok: false, status: 400, json: async () => ({ error: 'unavailable' }) };
    }),
  );
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
  expect(controller.requests.map(request => request.url)).toEqual([
    '/api/changes?projectId=project-x&after=3&start=start-a',
  ]);
  source.emit('change', { version: 2, start: 'start-b' }); // The controller restarted.
  source.emit('change', { version: 9, start: 'start-b' }); // The controller cannot say.
  await waitFor(() => expect(received).toHaveLength(3));
  expect(received).toEqual([
    { version: 8, start: 'start-a', changes: [{ seq: 4, type: 'task', id: 'T-1' }] },
    { version: 2, start: 'start-b', reload: true },
    { version: 9, start: 'start-b', reload: true },
  ]);
  stream.close();
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
