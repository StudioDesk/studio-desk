// Releases in the dashboard (1.1 step 6): each line with its last release and what landed since, its milestones with
// their ideas, stories and waiting ideas in order; New milestone, ordering and moving a waiting idea, Release with the
// open work moved on, and Push asked for every time.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Milestone, ReleaseOverview } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

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

const open = (path: string) => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <App
      router={router}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
  return router;
};
const commands = () => controller.requests.filter(request => request.method !== 'GET');

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
