// Snapshots, a card below the work on the Artifacts page of a project that is not code (1.2 step 6): each named set,
// newest first, with when it was made, how many files it holds and how many changed since against the files listed
// now, What changed with the controller's own changes, Download to its zip, and New snapshot of every accepted file or
// the chosen ones, with the controller's refusals shown in its dialog. A code project shows none.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectArtifact, Snapshot, SnapshotFile, WorkFile } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller;
const file = (taskId: string, path: string, hash = `hash-${taskId}`): ProjectArtifact => ({
  taskId,
  title: `Story ${taskId}`,
  attemptId: `attempt-${taskId}`,
  workerId: 'W-1',
  runId: null,
  kind: 'work-file',
  path,
  hash,
  acceptedAt: '2026-10-20T12:00:00Z',
});
// An accepted file as the work lists it, made once.
const asWork = (accepted: ProjectArtifact): WorkFile => ({
  ...accepted,
  workerId: accepted.workerId ?? null,
  libraryEntryId: null,
  versions: [
    {
      n: 1,
      attemptId: accepted.attemptId,
      workerId: accepted.workerId ?? null,
      hash: accepted.hash,
      at: accepted.acceptedAt,
      current: true,
      why: null,
    },
  ],
});
const held = (taskId: string, path: string, hash = `hash-${taskId}`): SnapshotFile => ({
  taskId,
  title: `Story ${taskId}`,
  attemptId: `attempt-${taskId}`,
  kind: 'work-file',
  path,
  hash,
});
const none = { added: [], changed: [], removed: [] };
const snapshot = (
  id: string,
  name: string,
  at: string,
  files: SnapshotFile[],
  changes: Snapshot['changes'],
): Snapshot => ({
  id,
  name,
  at,
  by: { type: 'director' },
  files,
  changes,
});

beforeEach(() => {
  controller = fakeController();
  // A project of general work, not code.
  controller.shell.organizationConfiguration = { taskKinds: ['general:plan'] };
  // Now: the launch copy was accepted again with another hash, the plan is as it was, the hero picture was added and
  // the old notes are gone.
  controller.projectArtifacts = [
    file('T-3', 'art/hero.svg'),
    file('T-2', 'notes/plan.md'),
    file('T-1', 'copy/launch.md', 'hash-T-1-new'),
  ];
  controller.projectWork = {
    work: controller.projectArtifacts.map(asWork),
    pictures: [],
    records: { count: 0, kinds: {} },
  };
  // Oldest first, as the controller answers, each with what changed since the one before it.
  controller.snapshots = [
    snapshot(
      'snap-1',
      'First draft',
      '2026-10-20T15:00:00Z',
      [held('T-1', 'copy/launch.md', 'hash-T-1-old'), held('T-5', 'draft.md')],
      {
        added: [
          { taskId: 'T-1', path: 'copy/launch.md' },
          { taskId: 'T-5', path: 'draft.md' },
        ],
        changed: [],
        removed: [],
      },
    ),
    snapshot(
      'snap-2',
      'Sent to the client',
      '2026-10-24T15:00:00Z',
      [held('T-1', 'copy/launch.md'), held('T-2', 'notes/plan.md'), held('T-4', 'notes/old.md')],
      {
        added: [
          { taskId: 'T-2', path: 'notes/plan.md' },
          { taskId: 'T-4', path: 'notes/old.md' },
        ],
        changed: [{ taskId: 'T-1', path: 'copy/launch.md' }],
        removed: [{ taskId: 'T-5', path: 'draft.md' }],
      },
    ),
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () => {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/artifacts'] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
};
const snapshotsUrl = '/api/projects/project-x/snapshots';
const posted = () => controller.requests.filter(request => request.method !== 'GET');
const listed = async () => {
  const list = await screen.findByRole('list', { name: 'Snapshots' });
  return [...list.children] as HTMLElement[];
};
// The snapshots' names as listed, each row named by its own.
const order = async () =>
  (await listed()).map(row => document.getElementById(row.getAttribute('aria-labelledby') ?? '')?.textContent);
const item = async (name: string) => within(await screen.findByRole('listitem', { name }));
const dialog = async () => within(await screen.findByRole('dialog', { name: 'New snapshot' }));
const snapshotReads = () => controller.reads().filter(url => url === snapshotsUrl).length;
// What the controller answers a new snapshot with, after adding it to the snapshots it serves.
const names = (made: Snapshot) => (url: string) => {
  if (url !== snapshotsUrl) return {};
  controller.snapshots = [...controller.snapshots, made];
  return made;
};

test('the snapshots list newest first, each with its name, time, file count and how many changed since', async () => {
  open();
  expect(await order()).toEqual(['Sent to the client', 'First draft']);
  expect(screen.getByText('2 snapshots')).toBeTruthy();
  const sent = await item('Sent to the client');
  expect(sent.getByText(when('2026-10-24T15:00:00Z')).getAttribute('datetime')).toBe('2026-10-24T15:00:00Z');
  expect(sent.getByText('3 files')).toBeTruthy();
  // Against the files listed now: the hero picture added since, the launch copy with another hash and the old notes
  // gone, by task and path; the plan is as it was.
  expect(sent.getByText('3 changed since (1 added, 1 changed, 1 gone)')).toBeTruthy();
  const first = await item('First draft');
  expect(first.getByText(when('2026-10-20T15:00:00Z')).getAttribute('datetime')).toBe('2026-10-20T15:00:00Z');
  expect(first.getByText('2 files')).toBeTruthy();
  expect(first.getByText('4 changed since (2 added, 1 changed, 1 gone)')).toBeTruthy();
  // The section sits below the work.
  const files = screen.getByRole('list', { name: 'The work' }),
    section = screen.getByRole('region', { name: 'Snapshots' });
  expect(files.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // A card of its own after the work's card, with New snapshot in its heading row.
  expect(screen.getByRole('region', { name: 'The work' }).contains(section)).toBe(false);
  expect(within(section).getByRole('button', { name: 'New snapshot' })).toBeTruthy();
  expect(within(section).getByText('a set of these files at one moment, such as what you sent out')).toBeTruthy();
});

test('a snapshot whose files are all as listed says nothing changed since', async () => {
  controller.snapshots = [
    snapshot(
      'snap-3',
      'Today',
      '2026-10-25T15:00:00Z',
      controller.projectArtifacts.map(({ taskId, path, hash }) => held(taskId, path, hash)),
      none,
    ),
  ];
  open();
  expect((await item('Today')).getByText('Nothing changed since')).toBeTruthy();
  expect(screen.getByText('1 snapshot')).toBeTruthy();
});

test("What changed shows the controller's added, changed and removed files against the snapshot before", async () => {
  const user = userEvent.setup();
  open();
  const sent = await item('Sent to the client'),
    toggle = sent.getByRole('button', { name: 'What changed' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(sent.queryByRole('list', { name: 'Added' })).toBeNull();
  await user.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(sent.getByText(`Since First draft, ${when('2026-10-20T15:00:00Z')}`)).toBeTruthy();
  const entries = (name: string) =>
    within(sent.getByRole('list', { name }))
      .getAllByRole('listitem')
      .map(entry => entry.textContent);
  expect(entries('Added')).toEqual(['notes/plan.mdStory T-2', 'notes/old.mdStory T-4']);
  expect(entries('Changed')).toEqual(['copy/launch.mdStory T-1']);
  // A removed file is named with its story from the snapshot before.
  expect(entries('Removed')).toEqual(['draft.mdStory T-5']);
  expect(sent.getByText('Added (2)')).toBeTruthy();
  expect(sent.getByText('Removed (1)')).toBeTruthy();
  // The first snapshot has none before it, so every file it holds is added.
  const first = await item('First draft');
  await user.click(first.getByRole('button', { name: 'What changed' }));
  expect(first.getByText('The first snapshot, so every file it holds is added.')).toBeTruthy();
  expect(within(first.getByRole('list', { name: 'Added' })).getAllByRole('listitem')).toHaveLength(2);
  expect(first.queryByRole('list', { name: 'Changed' })).toBeNull();
  // Opened again, it closes.
  await user.click(toggle);
  expect(sent.queryByRole('list', { name: 'Added' })).toBeNull();
});

test('Download is a plain link to the snapshot’s zip', async () => {
  open();
  const link = (await item('Sent to the client')).getByRole('link', { name: 'Download Sent to the client' });
  expect(link.textContent).toBe('Download');
  expect(link.getAttribute('href')).toBe('/api/projects/project-x/snapshots/snap-2/download');
  expect((await item('First draft')).getByRole('link', { name: 'Download First draft' }).getAttribute('href')).toBe(
    '/api/projects/project-x/snapshots/snap-1/download',
  );
});

test('New snapshot of every accepted file posts its name alone, and the new snapshot appears first', async () => {
  const user = userEvent.setup();
  controller.command = names(
    snapshot(
      'snap-new',
      'Sent to the client, October 29',
      '2026-10-29T09:00:00Z',
      controller.projectArtifacts.map(({ taskId, path, hash }) => held(taskId, path, hash)),
      none,
    ),
  );
  open();
  await listed();
  const reads = snapshotReads();
  await user.click(screen.getByRole('button', { name: 'New snapshot' }));
  const make = await dialog(),
    button = make.getByRole('button', { name: 'Name the snapshot' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  // Every accepted file is the default; the name is at most what the controller takes.
  expect((make.getByRole('radio', { name: 'Every accepted file (3 files)' }) as HTMLInputElement).checked).toBe(true);
  expect(make.getByLabelText('Name').getAttribute('maxLength')).toBe('120');
  expect(make.getByLabelText('Name').getAttribute('placeholder')).toBe('Sent to the client');
  await user.type(make.getByLabelText('Name'), ' Sent to the client, October 29 ');
  await user.click(button);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New snapshot' })).toBeNull());
  expect(posted()).toEqual([
    { url: snapshotsUrl, method: 'POST', body: { projectId: 'project-x', name: 'Sent to the client, October 29' } },
  ]);
  expect(screen.getByText('Named the snapshot Sent to the client, October 29.')).toBeTruthy();
  // The list is read again, and the new snapshot shows first.
  expect(await screen.findByText('3 snapshots')).toBeTruthy();
  expect(snapshotReads()).toBeGreaterThan(reads);
  const made = await item('Sent to the client, October 29');
  expect(made.getByText('Nothing changed since')).toBeTruthy();
  expect(await order()).toEqual(['Sent to the client, October 29', 'Sent to the client', 'First draft']);
});

test('New snapshot of chosen files posts each by task, attempt and path, in the listing’s order', async () => {
  const user = userEvent.setup();
  controller.command = names(
    snapshot(
      'snap-chosen',
      'Copy for review',
      '2026-10-29T09:00:00Z',
      [held('T-1', 'copy/launch.md', 'hash-T-1-new'), held('T-3', 'art/hero.svg')],
      none,
    ),
  );
  open();
  await listed();
  await user.click(screen.getByRole('button', { name: 'New snapshot' }));
  const make = await dialog();
  expect(make.queryByRole('checkbox')).toBeNull();
  await user.type(make.getByLabelText('Name'), 'Copy for review');
  await user.click(make.getByRole('radio', { name: 'The files I choose' }));
  // Each accepted file can be chosen; none is until the director checks it.
  expect(make.getAllByRole('checkbox')).toHaveLength(3);
  const button = make.getByRole('button', { name: 'Name the snapshot' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(make.getByText('0 files chosen')).toBeTruthy();
  await user.click(make.getByRole('checkbox', { name: /copy\/launch\.md/ }));
  await user.click(make.getByRole('checkbox', { name: /art\/hero\.svg/ }));
  await user.click(make.getByRole('checkbox', { name: /notes\/plan\.md/ }));
  await user.click(make.getByRole('checkbox', { name: /notes\/plan\.md/ }));
  expect(make.getByText('2 files chosen')).toBeTruthy();
  await user.click(button);
  expect(await screen.findByRole('listitem', { name: 'Copy for review' })).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: snapshotsUrl,
      method: 'POST',
      body: {
        projectId: 'project-x',
        name: 'Copy for review',
        files: [
          { taskId: 'T-3', attemptId: 'attempt-T-3', path: 'art/hero.svg' },
          { taskId: 'T-1', attemptId: 'attempt-T-1', path: 'copy/launch.md' },
        ],
      },
    },
  ]);
  // Two files, against the three listed now: the plan is the one added since.
  const chosen = await item('Copy for review');
  expect(chosen.getByText('2 files')).toBeTruthy();
  expect(chosen.getByText('1 changed since (1 added)')).toBeTruthy();
});

test("the controller's refusal shows in the dialog, which stays open until a change clears it", async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw Object.assign(new Error('A project keeps at most 100 snapshots.'), { status: 409 });
  };
  open();
  await listed();
  await user.click(screen.getByRole('button', { name: 'New snapshot' }));
  const make = await dialog();
  await user.type(make.getByLabelText('Name'), 'One more');
  await user.click(make.getByRole('button', { name: 'Name the snapshot' }));
  expect((await make.findByRole('alert')).textContent).toBe('A project keeps at most 100 snapshots.');
  expect(screen.getByRole('dialog', { name: 'New snapshot' })).toBeTruthy();
  expect((make.getByLabelText('Name') as HTMLInputElement).value).toBe('One more');
  expect(await listed()).toHaveLength(2);
  await user.type(make.getByLabelText('Name'), '!');
  expect(make.queryByRole('alert')).toBeNull();
  // Cancel closes it, and opened again it starts empty.
  await user.click(make.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New snapshot' })).toBeNull());
  await user.click(screen.getByRole('button', { name: 'New snapshot' }));
  expect(((await dialog()).getByLabelText('Name') as HTMLInputElement).value).toBe('');
  expect(posted()).toHaveLength(1);
});

test('more accepted files than a snapshot holds must be chosen, up to 200', async () => {
  const user = userEvent.setup();
  controller.projectArtifacts = Array.from({ length: 201 }, (_, index) => file(`T-${index}`, `page-${index}.md`));
  open();
  await listed();
  await user.click(screen.getByRole('button', { name: 'New snapshot' }));
  const make = await dialog(),
    button = make.getByRole('button', { name: 'Name the snapshot' }) as HTMLButtonElement;
  await user.type(make.getByLabelText('Name'), 'All');
  expect(make.getByText('A snapshot holds at most 200 files; choose the ones it holds.')).toBeTruthy();
  expect(button.disabled).toBe(true);
  await user.click(make.getByRole('radio', { name: 'The files I choose' }));
  await user.click(make.getAllByRole('checkbox')[7]!);
  expect(make.queryByText(/at most 200 files/)).toBeNull();
  expect(button.disabled).toBe(false);
});

test('a project with no snapshots says what they are for, and without accepted files New snapshot waits', async () => {
  controller.snapshots = [];
  controller.projectArtifacts = [];
  open();
  const section = within(await screen.findByRole('region', { name: 'Snapshots' }));
  expect(await section.findByText('No snapshots yet.')).toBeTruthy();
  expect((section.getByRole('button', { name: 'New snapshot' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a code project keeps Releases and shows no snapshots', async () => {
  controller.shell.organizationConfiguration = { taskKinds: ['studio-development:breakdown'] };
  open();
  await screen.findByRole('list', { name: 'The work' });
  expect(screen.queryByRole('region', { name: 'Snapshots' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New snapshot' })).toBeNull();
  expect(controller.reads()).not.toContain(snapshotsUrl);
});
