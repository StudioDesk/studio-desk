// Releases in a code project's Settings (release-settings.tsx): the offer to give each version its own line, what it
// needs first and the confirmation before switching, read from the releases overview on the stand-in controller, and
// the section once the project is switched.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { Milestone, ReleaseOverview } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

// Settings loads on demand (router.tsx); its code is loaded first, so a test's wait measures only its rendering.
beforeAll(async () => {
  await import('./settings-page');
});

const releasesRead = '/api/projects/project-x/releases',
  switchUrl = '/api/projects/project-x/version-lines',
  words =
    'Each version gets a line of its own, made from the one before, and new work lands on the lowest open version. The branch releases ship to moves only when a release ships, so it always holds the newest release.';

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
// A project not on version lines yet, with 1.1.0 released and 1.2.0 and 1.3.0 open, all on main.
const unswitched = (versionLines: ReleaseOverview['versionLines']): ReleaseOverview => ({
  available: true,
  copy: { branch: 'main', clean: true },
  remote: null,
  versionLines,
  lines: [
    {
      branch: 'main',
      state: 'maintained',
      newest: true,
      head: 'c3',
      lastRelease: { name: 'v1.1.0', version: '1.1.0' },
      landed: null,
      onRemote: null,
    },
  ],
  milestones: [
    milestone('1.1.0', 'main', { state: 'released' }),
    milestone('1.2.0', 'main'),
    milestone('1.3.0', 'main'),
  ],
  tags: ['v1.1.0'],
});
const switched = (): ReleaseOverview => ({
  available: true,
  copy: { branch: 'main', clean: true },
  remote: null,
  shipsTo: { branch: 'main', head: 'c3', lastRelease: { name: 'v1.1.0', version: '1.1.0' }, onRemote: null },
  lines: [],
  milestones: [milestone('1.2.0', 'release/1.2')],
  tags: ['v1.1.0'],
});

let controller: Controller;
beforeEach(() => {
  // The stand-in's project is a code project.
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () => {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/settings'] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
};
const section = async () => within(await screen.findByRole('region', { name: 'Releases' }));
// What a term of the section's list says.
const term = (scope: ReturnType<typeof within>, name: string) =>
  scope.getByText(name).nextElementSibling as HTMLElement;
const commands = () => controller.requests.filter(request => request.method !== 'GET');
const releaseReads = () => controller.reads().filter(url => url === releasesRead);
const offer = (scope: ReturnType<typeof within>) =>
  scope.getByRole('button', { name: 'Give each version its own line…' }) as HTMLButtonElement;

test('ready: it says what switching does, where releases will ship and that both needs are met, and asks before switching', async () => {
  const user = userEvent.setup();
  controller.releases = unswitched({ shipsTo: 'main', ready: true, needs: [] });
  controller.command = (url, method) => {
    if (url === switchUrl && method === 'POST') controller.releases = switched();
    return {};
  };
  open();
  const releases = await section();
  expect(await releases.findByText(words)).toBeTruthy();
  expect(term(releases, 'Releases will ship to').textContent).toBe('main');
  expect(within(term(releases, 'An open next version')).getByText('Done')).toBeTruthy();
  expect(within(term(releases, 'No open work on main')).getByText('Done')).toBeTruthy();
  expect(releases.queryByText('Still needed')).toBeNull();
  const button = offer(releases);
  expect(button.disabled).toBe(false);

  // Not now closes the question without asking the controller for anything.
  await user.click(button);
  let dialog = within(await screen.findByRole('dialog', { name: 'Give each version its own line' }));
  await user.click(dialog.getByRole('button', { name: 'Not now' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Give each version its own line' })).toBeNull());
  expect(commands()).toEqual([]);

  // The question names the branch and the lines it makes, each from the one before.
  await user.click(offer(releases));
  const question = await screen.findByRole('dialog', { name: 'Give each version its own line' });
  dialog = within(question);
  expect(dialog.getByText(/Releases will ship to/).textContent).toBe(
    'Releases will ship to main, which then moves only when a release ships.',
  );
  expect(dialog.getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'release/1.2 from main',
    'release/1.3 from release/1.2',
  ]);
  expect(releaseReads()).toHaveLength(1);
  await user.click(dialog.getByRole('button', { name: 'Switch' }));
  await waitFor(() =>
    expect(commands()).toEqual([{ url: switchUrl, method: 'POST', body: { projectId: 'project-x', shipsTo: 'main' } }]),
  );
  expect(await screen.findByText('Each version now has its own line, and releases ship to main.')).toBeTruthy();
  // It reads the releases again, and the section then says where releases ship, with the way to the Releases page.
  await waitFor(() => expect(releaseReads()).toHaveLength(2));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Give each version its own line' })).toBeNull());
  expect(releases.queryByRole('button', { name: 'Give each version its own line…' })).toBeNull();
  expect(releases.getByRole('link', { name: 'Open the Releases page' }).getAttribute('href')).toBe(
    '/p/project-x/releases',
  );
});

test('without an open next version, that need is shown unmet with a way to the Releases page, and it cannot switch', async () => {
  controller.releases = unswitched({ shipsTo: 'main', ready: false, needs: [{ kind: 'next-version' }] });
  controller.releases.milestones = [milestone('1.1.0', 'main', { state: 'released' })];
  open();
  const releases = await section();
  await releases.findByText(words);
  const next = within(term(releases, 'An open next version'));
  expect(next.getByText('Still needed')).toBeTruthy();
  expect(next.getByRole('link', { name: 'Make one on the Releases page' }).getAttribute('href')).toBe(
    '/p/project-x/releases',
  );
  expect(within(term(releases, 'No open work on main')).getByText('Done')).toBeTruthy();
  expect(offer(releases).disabled).toBe(true);
});

test('with open work on the branch, it names the open stories with links to them and how many more, and it cannot switch', async () => {
  controller.releases = unswitched({
    shipsTo: 'main',
    ready: false,
    needs: [
      {
        kind: 'open-work',
        count: 3,
        tasks: [
          { id: 'T-a', title: 'Show the shipping branch' },
          { id: 'T-b', title: 'Say where a release shipped' },
        ],
      },
    ],
  });
  open();
  const releases = await section();
  await releases.findByText(words);
  expect(within(term(releases, 'An open next version')).getByText('Done')).toBeTruthy();
  const work = within(term(releases, 'No open work on main'));
  expect(work.getByText('Still needed')).toBeTruthy();
  expect(work.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Show the shipping branch', '/p/project-x/tasks/T-a'],
    ['Say where a release shipped', '/p/project-x/tasks/T-b'],
  ]);
  expect(work.getByText(/^3 open:/)).toBeTruthy();
  expect(work.getByText('and 1 more')).toBeTruthy();
  expect(offer(releases).disabled).toBe(true);
});

test('a refusal from the controller is shown in its words, and the question stays open', async () => {
  const user = userEvent.setup(),
    refusal = 'New releases are made on main, so that is the branch they ship to. Name main.';
  controller.releases = unswitched({ shipsTo: 'main', ready: true, needs: [] });
  controller.command = () => {
    throw new Error(refusal);
  };
  open();
  const releases = await section();
  await user.click(await releases.findByRole('button', { name: 'Give each version its own line…' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Give each version its own line' }));
  await user.click(dialog.getByRole('button', { name: 'Switch' }));
  expect((await dialog.findByRole('alert')).textContent).toBe(refusal);
  expect(commands()).toHaveLength(1);
  expect(releases.getByRole('button', { name: 'Give each version its own line…' })).toBeTruthy();
});

test('switched: the section says releases ship to main and each version has its own line, and offers no switch', async () => {
  controller.releases = switched();
  open();
  const releases = await section();
  expect((await releases.findByText(/Releases ship to/)).textContent).toBe(
    'Releases ship to main, and each version has its own line.',
  );
  expect(releases.queryByText(words)).toBeNull();
  expect(releases.queryByRole('button', { name: 'Give each version its own line…' })).toBeNull();
  expect(releases.getByRole('link', { name: 'Open the Releases page' }).getAttribute('href')).toBe(
    '/p/project-x/releases',
  );
  expect(commands()).toEqual([]);
});
