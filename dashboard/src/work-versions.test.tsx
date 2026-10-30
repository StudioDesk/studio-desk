// A file's versions on the Artifacts page (1.2 step 6): "3 versions" on a row of The work opens each version newest
// first with its number, date and why, Open on that version's file, and What changed against the version before, read
// through the artifact route and compared line by line. A picture's versions have Open and no comparison, and a file
// made once has no versions to open.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WorkFile, WorkVersion } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller;
const version = (taskId: string, n: number, extra: Partial<WorkVersion> = {}): WorkVersion => ({
  n,
  attemptId: `attempt-${taskId}-${n}`,
  workerId: 'W-1',
  hash: `hash-${taskId}-${n}`,
  at: '2026-10-20T12:00:00Z',
  current: false,
  why: null,
  ...extra,
});
const work = (taskId: string, path: string, versions: WorkVersion[], extra: Partial<WorkFile> = {}): WorkFile => ({
  taskId,
  title: `Story ${taskId}`,
  runId: null,
  path,
  kind: 'work-file',
  hash: versions[0]!.hash!,
  attemptId: versions[0]!.attemptId,
  workerId: 'W-1',
  acceptedAt: versions[0]!.at,
  libraryEntryId: null,
  versions,
  ...extra,
});
const versionUrl = (attemptId: string, path: string) =>
  `/api/attempts/${attemptId}/artifact?projectId=project-x&path=${encodeURIComponent(path)}`;

beforeEach(() => {
  controller = fakeController();
  // A project of general work, not code.
  controller.shell.organizationConfiguration = { taskKinds: ['general:plan'] };
  // Newest first, as the controller answers. The launch copy was made three times, the banner twice and the table once.
  controller.projectWork = {
    work: [
      work('T-copy', 'copy/launch-page.md', [
        version('T-copy', 3, { at: '2026-10-23T12:00:00Z', current: true, why: 'Make it shorter.' }),
        version('T-copy', 2, { at: '2026-10-21T12:00:00Z' }),
        version('T-copy', 1, { at: '2026-10-19T12:00:00Z' }),
      ]),
      work(
        'T-hero',
        'art/hero.png',
        [
          version('T-hero', 2, { at: '2026-10-22T12:00:00Z', current: true, why: 'Brighter.' }),
          version('T-hero', 1, { at: '2026-10-18T12:00:00Z' }),
        ],
        { kind: 'artwork' },
      ),
      work('T-price', 'pricing-table.csv', [version('T-price', 1, { current: true })]),
    ],
    pictures: [],
    records: { count: 0, kinds: {} },
  };
  // Each version's text, served by its attempt and path.
  controller.artifacts['attempt-T-copy-1/copy/launch-page.md'] = '# Launch\nWelcome to the studio.\nSign up today.\n';
  controller.artifacts['attempt-T-copy-2/copy/launch-page.md'] =
    '# Launch\nWelcome to Studio desk.\nSign up today.\nIt runs on your computer.\n';
  controller.artifacts['attempt-T-copy-3/copy/launch-page.md'] = '# Launch\nWelcome to Studio desk.\n';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/artifacts'] }));
  render(
    <App
      router={router}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
};
const row = async (path: string) => {
  const list = await screen.findByRole('list', { name: 'The work' });
  return within(
    within(list)
      .getAllByRole('listitem')
      .find(item => item.querySelector(`[title="${path}"]`))!,
  );
};
// Each version of a file as its list reads: its number, date and why.
const versionsOf = (path: string) =>
  within(screen.getByRole('list', { name: `Versions of ${path}` }))
    .getAllByRole('listitem')
    .filter(item => item.hasAttribute('aria-labelledby'));
const artifactReads = () => controller.reads().filter(url => url.startsWith('/api/attempts/'));

test('opening a file made three times lists Version 3, 2 and 1 with when and why, each opening its own attempt', async () => {
  const user = userEvent.setup();
  open();
  const copy = await row('copy/launch-page.md');
  const opener = copy.getByRole('button', { name: '3 versions of copy/launch-page.md' });
  expect(opener.textContent).toBe('3 versions');
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('list', { name: 'Versions of copy/launch-page.md' })).toBeNull();

  await user.click(opener);
  expect(opener.getAttribute('aria-expanded')).toBe('true');
  const versions = versionsOf('copy/launch-page.md');
  expect(versions.map(item => within(item).getByText(/^Version \d$/).textContent)).toEqual([
    'Version 3',
    'Version 2',
    'Version 1',
  ]);
  const [third, second, first] = versions.map(item => within(item));
  expect(third!.getByText(when('2026-10-23T12:00:00Z')).getAttribute('dateTime')).toBe('2026-10-23T12:00:00Z');
  expect(third!.getByText('Make it shorter.')).toBeTruthy();
  expect(second!.getByText(when('2026-10-21T12:00:00Z'))).toBeTruthy();
  // A later version with nothing recorded about it says so, and the first is the first.
  expect(second!.getByText('Nothing was recorded about why it was made.')).toBeTruthy();
  expect(first!.getByText(when('2026-10-19T12:00:00Z'))).toBeTruthy();
  expect(first!.getByText('The first version')).toBeTruthy();

  // Open opens that version's own file in a new tab.
  for (const [item, n] of [
    [third!, 3],
    [second!, 2],
    [first!, 1],
  ] as const) {
    const link = item.getByRole('link', { name: `Open version ${n} of copy/launch-page.md` });
    expect(link.textContent).toBe('Open');
    expect(link.getAttribute('href')).toBe(versionUrl(`attempt-T-copy-${n}`, 'copy/launch-page.md'));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  }
  // The row's own Open still opens the newest version, and nothing was read to list the versions.
  expect(copy.getByRole('link', { name: 'Open copy/launch-page.md' }).getAttribute('href')).toBe(
    versionUrl('attempt-T-copy-3', 'copy/launch-page.md'),
  );
  expect(artifactReads()).toEqual([]);

  await user.click(opener);
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('list', { name: 'Versions of copy/launch-page.md' })).toBeNull();
});

test('What changed on version 2 reads both versions and shows the lines added and removed against version 1', async () => {
  const user = userEvent.setup();
  open();
  await user.click((await row('copy/launch-page.md')).getByRole('button', { name: /^3 versions/ }));
  const [, second, first] = versionsOf('copy/launch-page.md').map(item => within(item));
  // The first version has nothing before it to compare.
  expect(first!.queryByRole('button', { name: /What changed/ })).toBeNull();

  const changed = second!.getByRole('button', { name: 'What changed in version 2' });
  expect(changed.textContent).toBe('What changed');
  expect(changed.getAttribute('aria-expanded')).toBe('false');
  await user.click(changed);
  expect(changed.getAttribute('aria-expanded')).toBe('true');
  const lines = await second!.findByRole('list', { name: 'Lines added and removed in version 2' });
  expect(second!.getByText('Against version 1: 2 lines added, 1 line removed')).toBeTruthy();
  expect(
    within(lines)
      .getAllByRole('listitem')
      .map(line => line.getAttribute('aria-label')),
  ).toEqual([
    'Line 2 removed: Welcome to the studio.',
    'Line 2 added: Welcome to Studio desk.',
    'Line 4 added: It runs on your computer.',
  ]);
  // Both versions were read through the artifact route, each by its own attempt.
  expect(artifactReads().sort()).toEqual([
    versionUrl('attempt-T-copy-1', 'copy/launch-page.md'),
    versionUrl('attempt-T-copy-2', 'copy/launch-page.md'),
  ]);

  // Version 3 compares against version 2, reading only what is not read yet.
  const [third] = versionsOf('copy/launch-page.md').map(item => within(item));
  await user.click(third!.getByRole('button', { name: 'What changed in version 3' }));
  expect(await third!.findByText('Against version 2: 0 lines added, 2 lines removed')).toBeTruthy();
  expect(
    within(third!.getByRole('list', { name: 'Lines added and removed in version 3' }))
      .getAllByRole('listitem')
      .map(line => line.getAttribute('aria-label')),
  ).toEqual(['Line 3 removed: Sign up today.', 'Line 4 removed: It runs on your computer.']);
  expect(artifactReads().filter(url => url.includes('attempt-T-copy-2'))).toHaveLength(1);
  expect(artifactReads().filter(url => url.includes('attempt-T-copy-3'))).toHaveLength(1);
});

test('a version the controller will not serve says which one could not be read, in its words', async () => {
  const user = userEvent.setup();
  delete controller.artifacts['attempt-T-copy-1/copy/launch-page.md'];
  open();
  await user.click((await row('copy/launch-page.md')).getByRole('button', { name: /^3 versions/ }));
  const [, second] = versionsOf('copy/launch-page.md').map(item => within(item));
  await user.click(second!.getByRole('button', { name: 'What changed in version 2' }));
  expect((await second!.findByRole('alert')).textContent).toBe('Version 1 could not be read: Artifact not found.');
  expect(second!.queryByRole('list', { name: /Lines added and removed/ })).toBeNull();
});

test('a picture made twice offers Open on each version and no line comparison', async () => {
  const user = userEvent.setup();
  open();
  const hero = await row('art/hero.png');
  await user.click(hero.getByRole('button', { name: '2 versions of art/hero.png' }));
  const versions = versionsOf('art/hero.png').map(item => within(item));
  expect(versions).toHaveLength(2);
  expect(versions[0]!.getByText('Version 2')).toBeTruthy();
  expect(versions[0]!.getByText('Brighter.')).toBeTruthy();
  expect(versions[1]!.getByText('Version 1')).toBeTruthy();
  expect(versions[1]!.getByText('The first version')).toBeTruthy();
  expect(versions[0]!.getByRole('link', { name: 'Open version 2 of art/hero.png' }).getAttribute('href')).toBe(
    versionUrl('attempt-T-hero-2', 'art/hero.png'),
  );
  expect(versions[1]!.getByRole('link', { name: 'Open version 1 of art/hero.png' }).getAttribute('href')).toBe(
    versionUrl('attempt-T-hero-1', 'art/hero.png'),
  );
  expect(within(screen.getByRole('list', { name: 'Versions of art/hero.png' })).queryByText('What changed')).toBeNull();
  expect(artifactReads()).toEqual([]);
});

test('a file made once has no versions to open', async () => {
  open();
  const price = await row('pricing-table.csv');
  expect(price.queryByRole('button', { name: /versions?/ })).toBeNull();
  expect(price.queryByText(/versions?$/)).toBeNull();
  expect(price.getByRole('link', { name: 'Open pricing-table.csv' })).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Versions of pricing-table.csv' })).toBeNull();
});
