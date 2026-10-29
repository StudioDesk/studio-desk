// A code story whose tests passed has a fourth summary tile, Tried by you, and a Try it tab, both read from the
// project's try view as the stand-in controller serves it: what the try copy holds, its folder with Open folder, the
// start command and where Run runs, and while this story's Run runs, its address and output. Try it, Run and Stop
// are not the tab's; a story without a passed candidate keeps its tabs and tiles. Model-free.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, TryCopy, TryRun, TryView } from './api';
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

// A code story in review whose candidate, Eli's build, passed its 752 tests; with `fields`, a candidate that did not.
const story = (fields: Partial<AttemptSummary> = {}) => {
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Show the received files',
      kind: 'studio-development:change',
      status: 'review',
      lastAttemptId: 'attempt-review',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'candidate-review',
        current: 'review',
        candidate: { taskId: 'T-1', attemptId: 'attempt-build', workerId: 'W-1', hash: 'manifest-hash' },
        review: { attemptId: 'attempt-review', workerId: 'W-2' },
        history: [],
      },
    }),
    taskFixture('T-2', { title: 'Name the sender', kind: 'studio-development:change', status: 'review' }),
  ];
  controller.attempts = [
    {
      id: 'attempt-build',
      taskId: 'T-1',
      projectId: 'project-x',
      status: 'accepted',
      workerId: 'W-1',
      startedAt: '2026-10-29T08:00:00.000Z',
      finishedAt: '2026-10-29T08:20:00.000Z',
      assignment: { kind: 'studio-development:change' },
      result: { outcome: 'completed', summary: 'Shows the received files.' },
      testEvidence: { totals: { tests: 752, pass: 752, fail: 0 } },
      ...fields,
    },
    {
      id: 'attempt-review',
      taskId: 'T-1',
      projectId: 'project-x',
      status: 'running',
      workerId: 'W-2',
      startedAt: '2026-10-29T08:30:00.000Z',
      assignment: { kind: 'studio-development:change-review' },
    },
  ];
};
// The copy holding T-1's candidate merged onto main, and a Run of it.
const copy = (fields: Partial<TryCopy> = {}): TryCopy => ({
  folder: 'C:\\work\\app-try',
  taskId: 'T-1',
  title: 'Show the received files',
  candidateAttemptId: 'attempt-build',
  branch: 'main',
  tip: 'a1b2c3d4e5f60718',
  commit: 'f6e5d4c3b2a10987',
  merged: true,
  conflicts: [],
  at: '2026-10-29T09:00:00Z',
  run: null,
  ...fields,
});
const run = (fields: Partial<TryRun> = {}): TryRun => ({
  id: 'try-run-1',
  state: 'running',
  place: 'built-in',
  start: ['npm', 'run', 'dev'],
  address: null,
  taskId: 'T-1',
  commit: 'f6e5d4c3b2a10987',
  startedAt: '2026-10-29T09:01:00Z',
  ...fields,
});
const view = (held: TryCopy | null, fields: Partial<TryView> = {}): TryView => ({
  settings: {
    start: ['npm', 'run', 'dev'],
    address: null,
    folder: 'C:\\work\\app-try',
    runIn: 'built-in',
    outsideConfirmedAt: null,
  },
  runsIn: 'built-in',
  copy: held,
  ...fields,
});

const tabNames = async () =>
  within(await screen.findByRole('tablist', { name: 'Story details' }, { timeout: 5000 }))
    .getAllByRole('tab')
    .map(tab => tab.firstChild?.textContent);
const tiles = () => [...document.querySelectorAll<HTMLElement>('.sd-tiles .sd-tile')];
const tryReads = () => controller.reads().filter(url => url === '/api/projects/project-x/try').length;
// The fourth tile once the try view is read: its value and the line under it, if any.
const tileReads = async (value: string, line: string | null) => {
  await waitFor(() => expect(tryReads()).toBe(1), { timeout: 5000 });
  await waitFor(() =>
    expect([
      tiles()[3]?.querySelector('.sd-tile__value')?.textContent,
      tiles()[3]?.querySelector('.sd-meta')?.textContent ?? null,
    ]).toEqual([value, line]),
  );
  return tiles()[3]!;
};
// Opens the Try it tab and gives its panel.
const tryTab = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('tab', { name: 'Try it' }, { timeout: 5000 }));
  return within(screen.getByRole('tabpanel'));
};
// What a row of the tab's list holds, by its label (such as Folder or Start command), once the try view is read.
const row = async (panel: ReturnType<typeof within>, label: string) =>
  (await panel.findByText(label, { selector: 'dt' })).nextElementSibling as HTMLElement;

test('the fourth tile reads Not tried yet with nothing in the copy, and with another story in it', async () => {
  story();
  open();
  const tile = await tileReads('Not tried yet', null);
  expect(tiles()).toHaveLength(4);
  expect(tile.querySelector('.sd-eyebrow')?.textContent).toBe('Tried by youTried');
  cleanup();
  controller.tryView = view(copy({ taskId: 'T-2', title: 'Name the sender', run: run({ taskId: 'T-2' }) }));
  controller.requests = [];
  open();
  await tileReads('Not tried yet', 'The copy holds “Name the sender”');
});

test('the tile reads In the copy for this story, merged onto its line, or as built when its merge conflicted', async () => {
  story();
  controller.tryView = view(copy());
  open();
  await tileReads('In the copy', 'Merged onto main');
  cleanup();
  controller.tryView = view(copy({ merged: false, conflicts: ['lib/greeting.js'], commit: 'c4nd1da7e' }));
  controller.requests = [];
  open();
  await tileReads('In the copy', 'As built, conflicting with main');
});

test('the tile reads Running with the address the Run printed, and starting until it prints one', async () => {
  story();
  controller.tryView = view(copy({ run: run({ address: 'http://localhost:5173/' }) }));
  open();
  await tileReads('Running', 'http://localhost:5173/');
  cleanup();
  controller.tryView = view(copy({ run: run() }));
  controller.requests = [];
  open();
  await tileReads('Running', 'Starting…');
});

test('the story still opens on its change, and clicking the tile selects the Try it tab', async () => {
  const user = userEvent.setup();
  story();
  open();
  expect(await tabNames()).toEqual(['Changes', 'Checks', 'Try it', 'Activity']);
  expect(screen.getByRole('tab', { name: /^Changes/ }).getAttribute('aria-selected')).toBe('true');
  await user.click(await tileReads('Not tried yet', null));
  expect(screen.getByRole('tab', { name: 'Try it' }).getAttribute('aria-selected')).toBe('true');
  expect(await row(within(screen.getByRole('tabpanel')), 'The copy holds')).toBeTruthy();
});

test('on a phone Try it follows Checks, before Details', async () => {
  width(true);
  story();
  open();
  expect(await tabNames()).toEqual(['Activity', 'Changes', 'Checks', 'Try it', 'Details']);
});

test("the tab shows the copy's folder, and Open folder asks the controller to open it", async () => {
  const user = userEvent.setup();
  story();
  controller.tryView = view(copy());
  open();
  const folder = within(await row(await tryTab(user), 'Folder'));
  expect(folder.getByText('C:\\work\\app-try').className).toBe('sd-file sd-file--path');
  await user.click(folder.getByRole('button', { name: 'Open folder' }));
  await waitFor(() =>
    expect(controller.requests.filter(request => request.method === 'POST')).toEqual([
      { url: '/api/projects/project-x/try/open', method: 'POST', body: { projectId: 'project-x' } },
    ]),
  );
  // The view is read again after the answer.
  await waitFor(() => {
    const sent = controller.requests.map(request => `${request.method} ${request.url}`);
    expect(sent.lastIndexOf('GET /api/projects/project-x/try')).toBeGreaterThan(
      sent.indexOf('POST /api/projects/project-x/try/open'),
    );
  });
});

test('a refused Open folder shows what the controller said', async () => {
  const user = userEvent.setup(),
    message = 'Try a story first: there is no copy to open.';
  story();
  controller.tryView = view(copy());
  controller.command = () => {
    throw Object.assign(new Error(message), { status: 409 });
  };
  open();
  const folder = within(await row(await tryTab(user), 'Folder'));
  await user.click(folder.getByRole('button', { name: 'Open folder' }));
  expect(await screen.findByText(message)).toBeTruthy();
});

test('the tab says what the copy holds: nothing yet, another story by its title, or this one merged or as built', async () => {
  const user = userEvent.setup(),
    holds = async () => row(await tryTab(user), 'The copy holds');
  story();
  // A project whose folder the controller does not know yet has no folder for the copy either.
  open();
  expect((await holds()).textContent).toBe('Nothing yet');
  expect((await row(within(screen.getByRole('tabpanel')), 'Folder')).textContent).toBe('None yet');
  cleanup();
  controller.tryView = view(null);
  open();
  expect((await holds()).textContent).toBe('Nothing yet');
  // With no copy there is nothing to open, though the folder it will be made in shows.
  expect((await row(within(screen.getByRole('tabpanel')), 'Folder')).textContent).toBe('C:\\work\\app-try');
  expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull();
  cleanup();
  controller.tryView = view(copy({ taskId: 'T-2', title: 'Name the sender' }));
  open();
  const other = await holds();
  expect(other.textContent).toBe('Another story, Name the sender');
  expect(within(other).getByRole('link', { name: 'Name the sender' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-2',
  );
  cleanup();
  controller.tryView = view(copy());
  open();
  expect((await holds()).textContent).toBe('This story, merged onto main at a1b2c3d');
  cleanup();
  controller.tryView = view(copy({ merged: false, conflicts: ['lib/greeting.js', 'README.md'] }));
  open();
  const built = await holds();
  expect(within(built).getByText('This story as built: merging it onto main conflicts in')).toBeTruthy();
  expect([...built.querySelectorAll('.sd-file')].map(file => file.textContent)).toEqual([
    'lib/greeting.js',
    'README.md',
  ]);
});

test('the tab shows the start command as its program and arguments, and where Run runs', async () => {
  const user = userEvent.setup();
  story();
  controller.tryView = view(copy());
  open();
  let panel = await tryTab(user);
  const start = await row(panel, 'Start command');
  expect([...start.querySelectorAll('.sd-file')].map(part => part.textContent)).toEqual(['npm', 'run', 'dev']);
  expect(within(start).getByText('with')).toBeTruthy();
  expect((await row(panel, 'Run runs')).textContent).toBe('In the built-in sandbox');
  // Nothing on the tab starts or stops a Run.
  expect(panel.queryByRole('button', { name: /^(Run|Stop|Open|Try it)$/ })).toBeNull();
  cleanup();
  // The settings ask for the sandbox, but it cannot let the app's address through here.
  controller.tryView = view(copy(), { runsIn: 'computer' });
  open();
  panel = await tryTab(user);
  const runs = within(await row(panel, 'Run runs'));
  expect(runs.getByText('On this computer, outside the sandbox')).toBeTruthy();
  expect(runs.getByText("The built-in sandbox here cannot let the app's address through.")).toBeTruthy();
});

test('with no start command set the tab says so, with a link to the project’s Settings', async () => {
  const user = userEvent.setup();
  story();
  controller.tryView = view(copy());
  controller.tryView.settings.start = null;
  open();
  const start = within(await row(await tryTab(user), 'Start command'));
  expect(start.getByText('No start command is set.')).toBeTruthy();
  expect(start.getByRole('link', { name: 'Set one in Settings' }).getAttribute('href')).toBe('/p/project-x/settings');
});

test("while this story's Run runs the tab links its address and shows the output the controller serves", async () => {
  const user = userEvent.setup();
  story();
  controller.tryView = view(copy({ run: run({ address: 'http://localhost:5173/' }) }));
  controller.tryOutput = '> app@1.0.0 dev\n> vite\n\n  Local:   http://localhost:5173/\n';
  open();
  const panel = await tryTab(user),
    address = within(await row(panel, 'Address')).getByRole('link', { name: 'http://localhost:5173/' });
  expect(address.getAttribute('href')).toBe('http://localhost:5173/');
  expect(address.getAttribute('target')).toBe('_blank');
  const printed = panel.getByRole('region', { name: 'What the start command printed' });
  await waitFor(() => expect(printed.querySelector('pre')?.textContent).toBe(controller.tryOutput));
  expect(controller.reads()).toContain('/api/projects/project-x/try/output');
});

test('a Run still starting has no address yet, and a Run of another story or one that ended shows no output', async () => {
  const user = userEvent.setup();
  story();
  controller.tryView = view(copy({ run: run({ installing: true }) }));
  open();
  let panel = await tryTab(user);
  expect((await row(panel, 'Address')).textContent).toBe('Installing its packages first…');
  cleanup();
  controller.requests = [];
  controller.tryView = view(copy({ taskId: 'T-2', title: 'Name the sender', run: run({ taskId: 'T-2' }) }));
  controller.tryOutput = 'Another story’s output.';
  open();
  panel = await tryTab(user);
  expect((await row(panel, 'The copy holds')).textContent).toBe('Another story, Name the sender');
  expect(panel.queryByText('Address')).toBeNull();
  expect(panel.queryByRole('region', { name: 'What the start command printed' })).toBeNull();
  cleanup();
  controller.tryView = view(copy({ run: run({ state: 'ended', exitCode: 0, endedAt: '2026-10-29T09:05:00Z' }) }));
  open();
  panel = await tryTab(user);
  expect((await row(panel, 'The copy holds')).textContent).toBe('This story, merged onto main at a1b2c3d');
  expect(panel.queryByText('Address')).toBeNull();
  expect(panel.queryByRole('region', { name: 'What the start command printed' })).toBeNull();
  expect(controller.reads()).not.toContain('/api/projects/project-x/try/output');
});

test("the tab ends by pointing to Send back's note, with no reply box of its own", async () => {
  const user = userEvent.setup();
  story();
  open();
  const panel = await tryTab(user);
  expect(
    await panel.findByText(
      'What you find when you try it goes in the note of Send back to Eli, which sends the story back with it.',
    ),
  ).toBeTruthy();
  expect(panel.queryByRole('textbox')).toBeNull();
});

test('a story whose candidate failed its tests keeps its three tiles and its tabs, and reads no try view', async () => {
  story({
    status: 'failed',
    error: 'The candidate did not pass its tests.',
    testEvidence: { totals: { tests: 752, pass: 751, fail: 1 } },
  });
  open();
  expect(await tabNames()).toEqual(['Changes', 'Checks', 'Activity']);
  expect(tiles()).toHaveLength(3);
  expect(screen.queryByText('Tried by you')).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(tryReads()).toBe(0);
});
