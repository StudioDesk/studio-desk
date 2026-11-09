// Releases in the dashboard (1.1 step 6): each line with its last release and what landed since, its milestones with
// their ideas, stories and waiting ideas in order; New milestone, ordering and moving a waiting idea, Release with the
// open work moved on, and Push asked for every time.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Milestone, ReleaseOverview } from './api';
import { App } from './app';
import { queryKeys } from './records';
import { createAppRouter } from './router';
import { createStream, fakeController, FakeSource, latest, taskFixture, type Controller } from './test-controller';

let controller: Controller;
const milestone = (version: string, line: string, extra: Partial<Milestone> = {}): Milestone => ({
  id: `milestone-${version}`,
  version,
  line,
  goal: '',
  state: 'open',
  waiting: [],
  ideas: [],
  movedIn: [],
  counts: { ideas: 0, waiting: 0, stories: 0, integrated: 0, started: 0 },
  ...extra,
});
const overview = (): ReleaseOverview => ({
  available: true,
  copy: { branch: 'main', clean: true },
  remote: { name: 'origin', url: 'https://example.invalid/studio.git' },
  lines: [
    {
      branch: 'release/1.0',
      state: 'maintained',
      newest: false,
      head: 'a1',
      lastRelease: { name: 'v1.0.0', version: '1.0.0' },
      landed: {
        studio: 1,
        hand: 0,
        more: false,
        commits: [{ commit: 'a1', subject: 'Add an agent to its project', at: '', studio: true }],
      },
      onRemote: { known: false },
    },
    {
      branch: 'main',
      state: 'maintained',
      newest: true,
      head: 'b1',
      lastRelease: { name: 'v1.0.0', version: '1.0.0' },
      landed: { studio: 0, hand: 2, more: false, commits: [] },
      onRemote: { known: true, ahead: 2, behind: 0 },
    },
  ],
  milestones: [
    milestone('1.0.1', 'release/1.0', {
      goal: 'Fixes for 1.0.',
      ideas: [
        {
          runId: 'run-agents',
          idea: 'Make an agent in a project',
          at: null,
          by: 'director',
          stories: [
            {
              id: 'T-agents',
              title: 'Add, edit and delete an agent',
              status: 'done',
              started: true,
              integration: 'integrated',
              carries: [{ line: 'main', state: 'carried' }],
            },
            {
              id: 'T-settings',
              title: 'Choose the sandbox in Settings',
              status: 'ready',
              started: false,
              integration: null,
              carries: [],
            },
          ],
          movedOut: [],
        },
      ],
      waiting: [
        { id: 'waiting-a', idea: 'Keep the folder browser quick', at: '' },
        { id: 'waiting-b', idea: 'Hash snapshots without holding up the controller', at: '' },
      ],
      counts: { ideas: 1, waiting: 2, stories: 2, integrated: 1, started: 0 },
    }),
    milestone('1.1.0', 'main', { goal: 'Releases and branches.' }),
  ],
  tags: ['v1.0.0'],
});

beforeEach(() => {
  controller = fakeController();
  controller.releases = overview();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const open = (path: string, client = newClient()) => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<App router={router} queryClient={client} createStream={createStream} />);
  return router;
};
const commands = () => controller.requests.filter(request => request.method !== 'GET');
const releasesRead = '/api/projects/project-x/releases';
// A change the controller reports on the project's stream, after the hello's version 1.
const change = (version: number, ...changes: object[]) =>
  latest().emit('change', {
    version,
    start: 'start-a',
    changes: changes.map((item, index) => ({ seq: version + index, ...item })),
  });

test('each line shows its last release, what landed since and its milestones, which open to their stories', async () => {
  open('/p/project-x/releases?milestone=1.0.1');
  const patchLine = await screen.findByRole('region', { name: 'release/1.0' });
  expect(within(patchLine).getByText('v1.0.0')).toBeTruthy();
  expect(within(patchLine).getByText('1 through the studio · 0 by hand')).toBeTruthy();
  expect(within(patchLine).getByText('Each fix here is carried up to main.')).toBeTruthy();
  // Each line says what it is for, in words.
  expect(
    within(patchLine).getByText('Fixes only, for anyone still on 1.0. Each ships as a patch: 1.0.1 next.'),
  ).toBeTruthy();
  expect(within(patchLine).getByText('Add, edit and delete an agent')).toBeTruthy();
  expect(within(patchLine).getByText('carried to main')).toBeTruthy();
  expect(within(patchLine).getByRole('link', { name: 'Choose the sandbox in Settings' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-settings',
  );
  expect(
    screen.getByText('release/1.0 is not on it yet; main has 2 commits it does not, as of the last fetch or push.'),
  ).toBeTruthy();
  const mainLine = screen.getByRole('region', { name: 'main' });
  expect(within(mainLine).getByText('1.1.0')).toBeTruthy();
  expect(within(mainLine).getByText('Newest line')).toBeTruthy();
  expect(
    within(mainLine).getByText('New features. Each minor or major release is made here: 1.1.0 next.'),
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Releases', current: 'page' })).toBeTruthy();
});

test("a story's carries read carried forward or brought back, and one waiting for another story's turn names it", async () => {
  // Two fixes of one idea landed on release/1.1, were carried up to main and are being brought back to release/1.0,
  // the second after the first.
  const releases = overview();
  releases.lines!.splice(1, 0, {
    branch: 'release/1.1',
    state: 'maintained',
    newest: false,
    head: 'c1',
    lastRelease: { name: 'v1.1.0', version: '1.1.0' },
    landed: { studio: 2, hand: 0, more: false, commits: [] },
    onRemote: { known: false },
  });
  releases.milestones!.splice(
    1,
    0,
    milestone('1.1.1', 'release/1.1', {
      ideas: [
        {
          runId: 'run-browser',
          idea: 'Keep the folder browser quick',
          at: null,
          by: 'director',
          stories: [
            {
              id: 'T-cache',
              title: 'Cache folder listings',
              status: 'done',
              started: true,
              integration: 'integrated',
              carries: [
                { line: 'main', state: 'carried' },
                { line: 'release/1.0', state: 'carried', back: true },
              ],
            },
            {
              id: 'T-lazy',
              title: 'List folders lazily',
              status: 'done',
              started: true,
              integration: 'integrated',
              carries: [
                { line: 'main', state: 'carried' },
                { line: 'release/1.0', state: 'waiting', back: true, after: ['T-cache'] },
              ],
            },
          ],
          movedOut: [],
        },
      ],
      counts: { ideas: 1, waiting: 0, stories: 2, integrated: 2, started: 0 },
    }),
  );
  controller.releases = releases;
  // The idea is still open, so the page's records hold its stories and their titles. Its run is whole, as the
  // controller keeps one: the sidebar builds the idea from its nodes once the records load, and they load before the
  // releases show, since the page asks for those only once the project's shell names a code project.
  controller.runs = [
    {
      id: 'run-browser',
      createdAt: '2026-10-27T05:00:00Z',
      brief: 'Keep the folder browser quick',
      workflow: { id: 'workflow-1', name: 'Source checks and review', version: 3 },
      revisions: [{ revision: 1, at: '2026-10-27T05:00:00Z', reason: 'created' }],
      nodes: [
        {
          taskId: 'T-cache',
          key: 'T-cache',
          kind: 'studio-development:change',
          title: 'Cache folder listings',
          workerId: 'W-1',
          dependencies: [],
          revision: 1,
        },
      ],
      archive: { archived: false },
    },
  ];
  controller.tasks = [
    taskFixture('T-cache', {
      title: 'Cache folder listings',
      kind: 'studio-development:change',
      status: 'done',
      workflowReference: { runId: 'run-browser' },
    }),
  ];
  open('/p/project-x/releases?milestone=1.1.1');
  const line = await screen.findByRole('region', { name: 'release/1.1' });
  expect(await within(line).findByText('carried to main · brought back to release/1.0')).toBeTruthy();
  expect(
    await within(line).findByText(
      "carried to main · waits for T-cache (“Cache folder listings”)'s turn on release/1.0",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/carried to release\/1\.0/)).toBeNull();
});

test('waiting ideas move in their milestone and to another, and New milestone asks the controller', async () => {
  const user = userEvent.setup();
  open('/p/project-x/releases?milestone=1.0.1');
  const patchLine = await screen.findByRole('region', { name: 'release/1.0' });
  await user.click(within(patchLine).getAllByRole('button', { name: 'Move up' })[1]!);
  await user.selectOptions(
    within(patchLine).getAllByRole('combobox', { name: 'Move to another milestone' })[0]!,
    '1.1.0',
  );
  await user.click(screen.getByRole('button', { name: 'New milestone' }));
  await user.type(screen.getByLabelText('Version'), '1.0.2');
  await user.click(screen.getByRole('button', { name: 'Make it' }));
  expect(commands()).toEqual([
    {
      url: '/api/projects/project-x/milestones/milestone-1.0.1/ideas/waiting-b/order',
      method: 'POST',
      body: { projectId: 'project-x', index: 0 },
    },
    {
      url: '/api/projects/project-x/milestones/milestone-1.0.1/ideas/waiting-a/move',
      method: 'POST',
      body: { projectId: 'project-x', milestone: 'milestone-1.1.0' },
    },
    {
      url: '/api/projects/project-x/milestones',
      method: 'POST',
      body: { projectId: 'project-x', version: '1.0.2', goal: '' },
    },
  ]);
});

test('Release offers to move the open work on, and Push asks before it sends anything', async () => {
  const user = userEvent.setup();
  controller.releases!.milestones![1] = milestone('1.1.0', 'main', {
    state: 'released',
    release: { state: 'released', tag: 'v1.1.0' },
  });
  open('/p/project-x/releases');
  const patchLine = await screen.findByRole('region', { name: 'release/1.0' });
  await user.click(within(patchLine).getByRole('button', { name: 'Release 1.0.1…' }));
  const moving = screen.getByRole('checkbox');
  expect(moving.closest('label')?.textContent).toContain('to the next release.');
  expect(moving.closest('label')?.textContent).not.toContain('on this line');
  expect((moving as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Draft the notes' }));
  await user.click(screen.getByRole('button', { name: 'Push…' }));
  expect(commands()).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Push' }));
  expect(commands()).toEqual([
    {
      url: '/api/projects/project-x/milestones/milestone-1.0.1/release',
      method: 'POST',
      body: { projectId: 'project-x', moveOpen: true },
    },
    {
      url: '/api/projects/project-x/milestones/milestone-1.1.0/push',
      method: 'POST',
      body: { projectId: 'project-x', confirm: true },
    },
  ]);
});

test('Release on an unshipped version line offers the next release and preserves the unchecked request', async () => {
  const user = userEvent.setup();
  controller.releases!.shipsTo = { branch: 'main', head: 'a1', lastRelease: null, onRemote: null };
  controller.releases!.lines = [
    { ...controller.releases!.lines![0]!, branch: 'release/1.1', version: '1.1', released: false, lastRelease: null },
  ];
  controller.releases!.milestones = [
    milestone('1.1.0', 'release/1.1', {
      counts: { ideas: 2, waiting: 1, stories: 0, integrated: 0, started: 0 },
    }),
  ];
  open('/p/project-x/releases');
  await user.click(await screen.findByRole('button', { name: 'Release 1.1.0…' }));
  const moving = screen.getByRole('checkbox');
  expect((moving as HTMLInputElement).checked).toBe(true);
  expect(moving.closest('label')?.textContent).toContain('to the next release.');
  expect(moving.closest('label')?.textContent).not.toContain('on this line');
  await user.click(moving);
  await user.click(screen.getByRole('button', { name: 'Draft the notes' }));
  expect(commands()).toEqual([
    {
      url: '/api/projects/project-x/milestones/milestone-1.1.0/release',
      method: 'POST',
      body: { projectId: 'project-x', moveOpen: false },
    },
  ]);
});

test('the map shows how the lines fit together: each in time order, made from a release, its fixes carried up', async () => {
  controller.releases!.lines![0]!.from = 'v1.0.0';
  controller.releases!.milestones!.push(milestone('1.2.0', 'main'));
  open('/p/project-x/releases');
  const map = within(await screen.findByRole('region', { name: 'How your lines fit together' }));
  // Newest first, as the rows below it are.
  expect(map.getAllByRole('group').map(row => row.getAttribute('aria-label'))).toEqual([
    'main, New features: v1.0.0 released, 1.1.0 open, 1.2.0 planned',
    'release/1.0, Fixes for 1.0: 1.0.1 open; made from v1.0.0; fixes are carried up to main',
  ]);
  expect(
    screen
      .getAllByRole('region')
      .map(region => region.getAttribute('aria-label'))
      .filter(name => /^(main|release)/.test(name ?? '')),
  ).toEqual(['main', 'release/1.0']);
});

// The window's width as useNarrow reads it: a phone matches the design's break. afterEach puts the window's own back.
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
// jsdom lays nothing out, so this reads the minimum width the map's rows are given, not what a screen shows.
const mapRows = async () =>
  (await screen.findByRole('region', { name: 'How your lines fit together' })).querySelector<HTMLElement>(
    '.sd-linemap__rows',
  )!;

test('on a phone the map is only as wide as its columns at their narrowest, 84px more for each release', async () => {
  width(true);
  open('/p/project-x/releases');
  // The line's name 150px, a slot each for 1.0.0, 1.0.1 and 1.1.0 at 84px, and where its fixes go 120px.
  expect((await mapRows()).style.minWidth).toBe('522px');
  cleanup();
  controller.releases!.milestones!.push(milestone('1.2.0', 'main'));
  open('/p/project-x/releases');
  expect((await mapRows()).style.minWidth).toBe('606px');
});

test('above the phone break the map keeps its 760px minimum, set on its rows, however many releases it holds', async () => {
  // Where matchMedia is absent, as in the other tests.
  open('/p/project-x/releases');
  expect((await mapRows()).style.minWidth).toBe('760px');
  cleanup();
  // And where the window is wider than the break.
  width(false);
  controller.releases!.milestones!.push(milestone('1.2.0', 'main'));
  open('/p/project-x/releases');
  expect((await mapRows()).style.minWidth).toBe('760px');
});

test('a line is retired after asking, and a retired line is maintained again from the bottom of the page', async () => {
  const user = userEvent.setup();
  open('/p/project-x/releases');
  const patchLine = await screen.findByRole('region', { name: 'release/1.0' });
  expect(
    within(screen.getByRole('region', { name: 'main' })).queryByRole('button', { name: 'Retire this line…' }),
  ).toBeNull();
  await user.click(within(patchLine).getByRole('button', { name: 'Retire this line…' }));
  expect(commands()).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Retire it' }));
  expect(commands()).toEqual([
    {
      url: '/api/projects/project-x/lines',
      method: 'PATCH',
      body: { projectId: 'project-x', branch: 'release/1.0', retired: true },
    },
  ]);
  cleanup();
  controller.requests = [];
  controller.releases!.lines![0]!.state = 'retired';
  open('/p/project-x/releases');
  const retired = within(await screen.findByRole('region', { name: 'Retired lines' }));
  expect(screen.queryByRole('region', { name: 'release/1.0' })).toBeNull();
  expect(
    retired.getByText(
      'Its last release, v1.0.0, and its tags stay. No new ideas land here, and fixes skip it; work already on it finishes.',
    ),
  ).toBeTruthy();
  await user.click(retired.getByRole('button', { name: 'Maintain it again' }));
  expect(commands()).toEqual([
    {
      url: '/api/projects/project-x/lines',
      method: 'PATCH',
      body: { projectId: 'project-x', branch: 'release/1.0', retired: false },
    },
  ]);
});

test('a project without the source workflow says releases are for code projects, and points back to Today', async () => {
  controller.releases = undefined;
  controller.shell.organizationConfiguration = { taskKinds: ['general:plan'] };
  open('/p/project-x/releases');
  expect(await screen.findByText(/Releases are for code projects\./)).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Releases');
  expect(screen.getByRole('link', { name: 'Back to Today' }).getAttribute('href')).toBe('/p/project-x');
  expect(screen.queryByText('Only a project on the source workflow has releases.')).toBeNull();
  // It never asks the controller for releases it cannot have.
  expect(controller.reads()).not.toContain('/api/projects/project-x/releases');
});

test("a code project the controller has no releases for shows the controller's reason", async () => {
  controller.releases = { available: false, reason: 'This project has no repository.' };
  open('/p/project-x/releases');
  expect(await screen.findByText('This project has no repository.')).toBeTruthy();
  expect(screen.queryByText(/Releases are for code projects/)).toBeNull();
  expect(controller.reads()).toContain('/api/projects/project-x/releases');
});

test('a project whose shell cannot be read still shows its releases, as the controller answers them', async () => {
  const answer = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) =>
    url.split('?')[0] === '/api/projects/project-x/shell'
      ? Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'The shell could not be read.' }) })
      : answer(url, options),
  );
  open('/p/project-x/releases');
  expect(await screen.findByRole('region', { name: 'release/1.0' })).toBeTruthy();
  expect(screen.queryByText(/Releases are for code projects/)).toBeNull();
});

// The page reads its releases again whenever the studio reports a change to them, and stays where it is.
test('a milestone change the studio reports shows on the open page: a waiting idea moved on, then a milestone released', async () => {
  const router = open('/p/project-x/releases?milestone=1.0.1');
  const patchLine = await screen.findByRole('region', { name: 'release/1.0' });
  expect(within(patchLine).getByText('Keep the folder browser quick')).toBeTruthy();
  // Elsewhere, the first waiting idea moves to 1.1.0; the controller reports the milestones' setting.
  const moved = overview(),
    [patch, next] = moved.milestones!;
  next!.waiting = [patch!.waiting[0]!];
  patch!.waiting = [patch!.waiting[1]!];
  controller.releases = moved;
  change(2, { type: 'setting', id: 'milestones:project-x', projectId: 'project-x' });
  const mainLine = screen.getByRole('region', { name: 'main' });
  expect(await within(mainLine).findByText('Keep the folder browser quick')).toBeTruthy();
  expect(within(patchLine).queryByText('Keep the folder browser quick')).toBeNull();
  expect(within(patchLine).getByText('Hash snapshots without holding up the controller')).toBeTruthy();
  // Then 1.0.1 is released, its open work moved on.
  const released = structuredClone(moved),
    [shipped, after] = released.milestones!;
  after!.waiting = [...after!.waiting, ...shipped!.waiting];
  released.milestones![0] = {
    ...shipped!,
    state: 'released',
    waiting: [],
    release: { state: 'released', tag: 'v1.0.1' },
  };
  released.lines![0]!.lastRelease = { name: 'v1.0.1', version: '1.0.1' };
  controller.releases = released;
  change(3, { type: 'setting', id: 'milestones:project-x', projectId: 'project-x' });
  const shippedCard = within(await screen.findByRole('region', { name: 'Released' }));
  expect(shippedCard.getByText('1.0.1')).toBeTruthy();
  expect(shippedCard.getByText('Tagged v1.0.1')).toBeTruthy();
  expect(within(patchLine).getByText('No open milestone on this line.')).toBeTruthy();
  expect(within(mainLine).getByText('Hash snapshots without holding up the controller')).toBeTruthy();
  expect(router.state.location.pathname).toBe('/p/project-x/releases');
  expect(router.state.location.search).toEqual({ milestone: '1.0.1' });
});

test('a line retired elsewhere shows on the open page once the studio reports the project changed', async () => {
  open('/p/project-x/releases?milestone=1.0.1');
  expect(await screen.findByRole('region', { name: 'release/1.0' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Retired lines' })).toBeNull();
  controller.releases!.lines![0]!.state = 'retired';
  change(2, { type: 'projects' });
  const retired = within(await screen.findByRole('region', { name: 'Retired lines' }));
  expect(retired.getByRole('button', { name: 'Maintain it again' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'release/1.0' })).toBeNull();
});

test('a reload the stream asks for brings the changed releases, and so does a change to one of their stories', async () => {
  open('/p/project-x/releases?milestone=1.0.1');
  const patchLine = await screen.findByRole('region', { name: 'release/1.0' });
  // A milestone made while the stream was away, which the controller can no longer say: the stream reloads.
  controller.releases!.milestones!.push(milestone('1.2.0', 'main'));
  latest().emit('change', { version: 5, start: 'start-a', reload: true });
  const mainLine = screen.getByRole('region', { name: 'main' });
  expect(
    await within(mainLine).findByText(
      'New features. Each minor or major release is made here: 1.1.0 next, then 1.2.0.',
    ),
  ).toBeTruthy();
  // One of the milestone's stories goes to review; the change names its task.
  const story = within(patchLine).getByRole('link', { name: 'Choose the sandbox in Settings' }).parentElement!;
  expect(within(story).getByText('Ready')).toBeTruthy();
  controller.releases!.milestones![0]!.ideas[0]!.stories[1]!.status = 'review';
  controller.tasks = [taskFixture('T-settings', { title: 'Choose the sandbox in Settings', status: 'review' })];
  change(6, { type: 'task', id: 'T-settings', projectId: 'project-x' });
  expect(await within(story).findByText('In review')).toBeTruthy();
});

// A project on version lines: releases ship to main, which is no longer a line; 1.2.0 is being built on release/1.2,
// made from main, and release/1.0 holds the patches of 1.0. 1.1.0 was released on main before the switch, and
// release/1.2's history holds it, so its last release reads v1.1.0.
const switched = (): ReleaseOverview => {
  const releases = overview();
  releases.shipsTo = {
    branch: 'main',
    head: 'b1',
    lastRelease: { name: 'v1.1.0', version: '1.1.0' },
    onRemote: { known: true, ahead: 0, behind: 0 },
  };
  releases.lines = [
    { ...releases.lines![0]!, from: 'v1.0.0', version: '1.0', released: true },
    {
      branch: 'release/1.2',
      state: 'maintained',
      newest: true,
      from: 'main',
      version: '1.2',
      released: false,
      head: 'c1',
      lastRelease: { name: 'v1.1.0', version: '1.1.0' },
      landed: { studio: 0, hand: 0, more: false, commits: [] },
      onRemote: { known: false },
    },
  ];
  releases.milestones = [
    releases.milestones![0]!,
    milestone('1.1.0', 'main', {
      state: 'released',
      release: { state: 'released', tag: 'v1.1.0', repository: { branch: 'main' } },
    }),
    milestone('1.2.0', 'release/1.2', { goal: 'Each version on its own line.' }),
  ];
  releases.tags = ['v1.1.0', 'v1.0.0'];
  return releases;
};
const lineRegions = () =>
  screen
    .getAllByRole('region')
    .map(region => region.getAttribute('aria-label'))
    .filter(name => /^(main|release)/.test(name ?? ''));

test('on version lines, where releases ship has a card of its own above the lines, with no milestones and no retiring', async () => {
  controller.releases = switched();
  open('/p/project-x/releases');
  const shipping = within(await screen.findByRole('region', { name: 'main, where releases ship' }));
  expect(shipping.getByText('Where releases ship')).toBeTruthy();
  expect(shipping.getByText('It moves only when a release ships, so it always holds the newest release.')).toBeTruthy();
  expect(shipping.getByText('v1.1.0')).toBeTruthy();
  expect(shipping.getByText('up to date, as of the last fetch or push')).toBeTruthy();
  expect(shipping.queryByRole('button')).toBeNull();
  expect(shipping.queryByText(/Landed since/)).toBeNull();
  expect(shipping.queryByText(/No open milestone/)).toBeNull();
  // It is not one of the lines: they follow it, newest first, and none of them is main.
  expect(screen.queryByRole('region', { name: 'main' })).toBeNull();
  expect(lineRegions()).toEqual(['main, where releases ship', 'release/1.2', 'release/1.0']);
  // What the remote has names main first, then the lines.
  expect(
    screen.getByText(
      'main is up to date; release/1.0 is not on it yet; release/1.2 is not on it yet, as of the last fetch or push.',
    ),
  ).toBeTruthy();
});

test('on version lines, each line says whether it builds its version or patches a released one', async () => {
  controller.releases = switched();
  open('/p/project-x/releases');
  const building = within(await screen.findByRole('region', { name: 'release/1.2' }));
  expect(building.getByText('Being built')).toBeTruthy();
  expect(building.getByText('Where 1.2.0 is being built. New work for 1.2 lands here.')).toBeTruthy();
  expect(building.getByText('Made from main')).toBeTruthy();
  expect(building.getByText('1.2.0')).toBeTruthy();
  expect(building.queryByText('Newest line')).toBeNull();
  expect(building.queryByText(/New features/)).toBeNull();
  const patches = within(screen.getByRole('region', { name: 'release/1.0' }));
  expect(patches.getByText('Patches')).toBeTruthy();
  expect(
    patches.getByText('Patches of 1.0, a released version. Each fix ships as 1.0.n and is carried up to newer lines.'),
  ).toBeTruthy();
  expect(patches.getByText('Made from v1.0.0')).toBeTruthy();
  cleanup();
  // Once 1.2.0 is released, its line holds the patches of 1.2.
  const released = switched();
  released.lines![1]!.released = true;
  controller.releases = released;
  open('/p/project-x/releases');
  const patched = within(await screen.findByRole('region', { name: 'release/1.2' }));
  expect(patched.getByText('Patches')).toBeTruthy();
  expect(
    patched.getByText('Patches of 1.2, a released version. Each fix ships as 1.2.n and is carried up to newer lines.'),
  ).toBeTruthy();
  expect(patched.queryByText('Being built')).toBeNull();
});

test('on version lines, the map draws where releases ship as its first row, and a line only the releases made on it', async () => {
  controller.releases = switched();
  open('/p/project-x/releases');
  const map = within(await screen.findByRole('region', { name: 'How your lines fit together' }));
  const rows = map.getAllByRole('group').map(row => row.getAttribute('aria-label'));
  expect(rows).toEqual([
    'main, Releases ship here: v1.0.0 released, v1.1.0 released',
    'release/1.2, Being built: 1.2.0 open; made from main',
    'release/1.0, Patches: 1.0.1 open; made from v1.0.0; fixes are carried up to release/1.2',
  ]);
  // release/1.2's history holds v1.1.0 from main, but it was not released there.
  expect(rows[1]).not.toContain('v1.1.0');
  expect(map.getByText('Releases ship here')).toBeTruthy();
  expect(map.getByText(/Each version has its own line/)).toBeTruthy();
  expect(map.getByText(/Releases ship to main, which moves only when a release ships/)).toBeTruthy();
  expect(map.queryByText(/The newest line gets new features/)).toBeNull();
  cleanup();
  // A release shipped to main after the switch is drawn on main as well as on the line it was made on; a patch that
  // was not shipped, since a newer release had been, only on its own line.
  const shipped = switched();
  shipped.milestones![0] = milestone('1.0.1', 'release/1.0', {
    state: 'released',
    release: {
      state: 'released',
      tag: 'v1.0.1',
      repository: { branch: 'release/1.0' },
      shipped: { branch: 'main', skipped: 'v1.2.0 is newer, and main holds the newest release.', at: '' },
    },
  });
  shipped.milestones![2] = milestone('1.2.0', 'release/1.2', {
    state: 'released',
    release: {
      state: 'released',
      tag: 'v1.2.0',
      repository: { branch: 'release/1.2' },
      shipped: { branch: 'main', commit: 'd1', at: '' },
    },
  });
  shipped.shipsTo!.lastRelease = { name: 'v1.2.0', version: '1.2.0' };
  shipped.lines![1]!.released = true;
  controller.releases = shipped;
  open('/p/project-x/releases');
  const after = within(await screen.findByRole('region', { name: 'How your lines fit together' }));
  expect(after.getAllByRole('group').map(row => row.getAttribute('aria-label'))).toEqual([
    'main, Releases ship here: v1.0.0 released, v1.1.0 released, v1.2.0 released',
    'release/1.2, Patches: v1.2.0 released; made from main',
    'release/1.0, Patches: v1.0.1 released; made from v1.0.0; fixes are carried up to release/1.2',
  ]);
});

test('on version lines, New milestone says each version gets a line of its own; otherwise its help reads as before', async () => {
  const user = userEvent.setup();
  controller.releases = switched();
  open('/p/project-x/releases');
  await user.click(await screen.findByRole('button', { name: 'New milestone' }));
  expect(
    screen.getByText(
      'On this project each minor or major version gets a line of its own, release/x.y, made when its milestone is. A patch (1.2.1) lands on its version’s line.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/A patch \(1\.0\.2\) lands on its release line/)).toBeNull();
  cleanup();
  controller.releases = overview();
  open('/p/project-x/releases');
  await user.click(await screen.findByRole('button', { name: 'New milestone' }));
  expect(
    screen.getByText(
      'A patch (1.0.2) lands on its release line, made from the newest tag of its series when it is first needed. A minor or major release lands on the newest line; the first of a new major moves the older one to a line of its own.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/gets a line of its own/)).toBeNull();
  // And a project that is not on version lines has no card for where releases ship.
  expect(screen.queryByText('Where releases ship')).toBeNull();
  expect(screen.queryByText('Releases ship here')).toBeNull();
});

test('the page asks for no releases until the stream says where the controller is, and reads them when it is offline', async () => {
  // The project's shell is already held, as after another of its pages, so only the stream holds the read back.
  FakeSource.hello = null;
  const client = newClient();
  client.setQueryData(queryKeys.shell('project-x'), controller.shell);
  open('/p/project-x/releases', client);
  expect(await screen.findByText('Loading the releases…')).toBeTruthy();
  await waitFor(() => expect(FakeSource.all.some(source => !source.closed)).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(controller.reads()).not.toContain(releasesRead);
  latest().emit('change', { version: 1, start: 'start-a' });
  expect(await screen.findByRole('region', { name: 'release/1.0' })).toBeTruthy();
  expect(controller.reads().filter(url => url === releasesRead)).toHaveLength(1);
  cleanup();
  // A stream that cannot open leaves the page to show what the controller answers.
  controller.requests = [];
  open('/p/project-x/releases');
  await waitFor(() => expect(FakeSource.all.some(source => !source.closed)).toBe(true));
  expect(controller.reads()).not.toContain(releasesRead);
  latest().emit('error');
  expect(await screen.findByRole('region', { name: 'release/1.0' })).toBeTruthy();
  expect(controller.reads()).toContain(releasesRead);
});

// On version lines, 1.2.0 released on release/1.2 and what became of shipping it to main.
const shippedRelease = (shipped: NonNullable<Milestone['release']>['shipped']) => {
  const releases = switched();
  releases.lines![1]!.released = true;
  releases.milestones![2] = milestone('1.2.0', 'release/1.2', {
    state: 'released',
    release: { state: 'released', tag: 'v1.2.0', repository: { branch: 'release/1.2' }, shipped },
  });
  return releases;
};
const releasedCard = async () => within(await screen.findByRole('region', { name: 'Released' }));

test('a released version shipped to main says so, names the merge and its commit, and offers no Ship again', async () => {
  controller.releases = shippedRelease({ branch: 'main', commit: 'd1e2f3a4b5c6', merged: true, at: '' });
  open('/p/project-x/releases');
  const released = await releasedCard();
  expect(released.getByText('Shipped to main as a merge whose content is the release · d1e2f3a')).toBeTruthy();
  expect(released.getByText('Tagged v1.2.0')).toBeTruthy();
  expect(released.queryByRole('button', { name: 'Ship again' })).toBeNull();
  expect(released.queryByRole('alert')).toBeNull();
  cleanup();
  // A fast-forward is not a merge.
  controller.releases = shippedRelease({ branch: 'main', commit: 'd1e2f3a4b5c6', at: '' });
  open('/p/project-x/releases');
  expect((await releasedCard()).getByText('Shipped to main · d1e2f3a')).toBeTruthy();
  expect(screen.queryByText(/as a merge/)).toBeNull();
});

test('a released version that was not shipped gives the recorded reason, and offers no Ship again', async () => {
  controller.releases = shippedRelease({
    branch: 'main',
    skipped: 'v1.3.0 is newer, and main holds the newest release.',
    at: '',
  });
  open('/p/project-x/releases');
  const released = await releasedCard();
  expect(released.getByText('Not shipped: v1.3.0 is newer, and main holds the newest release.')).toBeTruthy();
  expect(released.queryByText(/Shipped to/)).toBeNull();
  expect(released.queryByRole('button', { name: 'Ship again' })).toBeNull();
});

test('shipping that stopped shows its error as an alert, and Ship again asks the controller, then reads the releases', async () => {
  const user = userEvent.setup();
  controller.releases = shippedRelease({ branch: 'main', error: 'main moved while the release shipped.', at: '' });
  let finish: (answer: unknown) => void = () => {};
  controller.command = () => new Promise(resolve => (finish = resolve));
  open('/p/project-x/releases');
  const released = await releasedCard();
  expect(released.getByRole('alert').textContent).toBe(
    'Shipping to main stopped: main moved while the release shipped.',
  );
  const reads = controller.reads().filter(url => url === releasesRead).length;
  const again = released.getByRole('button', { name: 'Ship again' });
  await user.click(again);
  expect(commands()).toEqual([
    {
      url: '/api/projects/project-x/milestones/milestone-1.2.0/ship',
      method: 'POST',
      body: { projectId: 'project-x' },
    },
  ]);
  // It waits for the controller's answer before it can be asked again.
  await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(true));
  controller.releases = shippedRelease({ branch: 'main', commit: 'e1f2a3b4c5d6', merged: true, at: '' });
  finish({ shipped: { branch: 'main', commit: 'e1f2a3b4c5d6', merged: true, at: '' } });
  expect(await screen.findByText('Shipped again.')).toBeTruthy();
  expect(await released.findByText('Shipped to main as a merge whose content is the release · e1f2a3b')).toBeTruthy();
  expect(controller.reads().filter(url => url === releasesRead).length).toBeGreaterThan(reads);
  expect(released.queryByRole('button', { name: 'Ship again' })).toBeNull();
});

test("Ship again shows the controller's refusal in its words", async () => {
  const user = userEvent.setup();
  controller.releases = shippedRelease({ branch: 'main', error: 'main moved while the release shipped.', at: '' });
  controller.command = () => {
    throw new Error('1.2.0 has nothing to ship again.');
  };
  open('/p/project-x/releases');
  await user.click((await releasedCard()).getByRole('button', { name: 'Ship again' }));
  expect(await screen.findByText('1.2.0 has nothing to ship again.')).toBeTruthy();
  expect(screen.queryByText('Shipped again.')).toBeNull();
});

test('Push says it sends main as well for a release shipped there; otherwise its words are unchanged', async () => {
  const user = userEvent.setup();
  controller.releases = shippedRelease({ branch: 'main', commit: 'd1e2f3a4b5c6', merged: true, at: '' });
  open('/p/project-x/releases');
  await releasedCard();
  // 1.1.0 was released on main before the switch, and 1.2.0 shipped to it from release/1.2.
  await user.click(within(document.getElementById('milestone-1.2.0')!).getByRole('button', { name: 'Push…' }));
  expect(
    screen.getByText(/^This sends the line, main and the tag v1\.2\.0 with your own git sign-in\. It is the one thing/),
  ).toBeTruthy();
  cleanup();
  controller.releases = overview();
  controller.releases.milestones![1] = milestone('1.1.0', 'main', {
    state: 'released',
    release: { state: 'released', tag: 'v1.1.0' },
  });
  open('/p/project-x/releases');
  await user.click(await screen.findByRole('button', { name: 'Push…' }));
  expect(
    screen.getByText(
      'This sends the line and the tag v1.1.0 with your own git sign-in. It is the one thing in Studio desk that leaves this computer, so it asks every time. If git needs a password it stops rather than wait, and shows the command to run yourself.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/This sends the line, /)).toBeNull();
});
