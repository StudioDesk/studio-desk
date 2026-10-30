// The library at the top of the Artifacts page (1.2 step 6): a card for each current entry with what it is for, its
// newest revision and size, how many attempts read it and where it came from, the total against what every attempt
// receives in full, Upload a file, and Add to the library on each file of the work the library does not hold, with the
// controller's refusals shown in the dialog.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LibraryEntry, LibraryReader, LibraryRevision, LibrarySource, ProjectArtifact, WorkFile } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

let controller: Controller;
const MiB = 1024 * 1024;
const revision = (number: number, byteLength: number, source: LibrarySource): LibraryRevision => ({
  revision: number,
  file: `file-r${number}.md`,
  mediaType: 'text/markdown',
  byteLength,
  sha256: `sha-${number}`,
  source,
  at: '2026-10-28T12:00:00Z',
  by: { type: 'director' },
});
const entry = (id: string, name: string, purpose: string, revisions: LibraryRevision[], extra = {}): LibraryEntry => ({
  id,
  name,
  purpose,
  createdAt: '2026-10-28T12:00:00Z',
  by: { type: 'director' },
  revisions,
  ...extra,
});
const reader = (attemptId: string, revision: number): LibraryReader => ({
  attemptId,
  taskId: 'T-9',
  status: 'accepted',
  startedAt: '2026-10-28T13:00:00Z',
  revision,
  delivered: true,
});
const file = (taskId: string, path: string): ProjectArtifact => ({
  taskId,
  title: `Story ${taskId}`,
  attemptId: `attempt-${taskId}`,
  workerId: 'W-1',
  runId: null,
  kind: 'work-file',
  path,
  hash: `hash-${taskId}`,
  acceptedAt: '2026-10-20T12:00:00Z',
});
// The same file as the work lists it, made once.
const made = (taskId: string, path: string, libraryEntryId: string | null = null): WorkFile => ({
  ...file(taskId, path),
  workerId: 'W-1',
  libraryEntryId,
  versions: [
    {
      n: 1,
      attemptId: `attempt-${taskId}`,
      workerId: 'W-1',
      hash: `hash-${taskId}`,
      at: '2026-10-20T12:00:00Z',
      current: true,
      why: null,
    },
  ],
});
const accepted: LibrarySource = {
  type: 'accepted',
  taskId: 'T-1',
  attemptId: 'attempt-T-1',
  path: 'copy/launch.md',
  hash: 'hash-T-1',
};

beforeEach(() => {
  controller = fakeController();
  controller.projectArtifacts = [file('T-1', 'copy/launch.md'), file('T-2', 'notes/plan.md')];
  // The work lists both; the library holds the launch copy.
  controller.projectWork = {
    work: [made('T-1', 'copy/launch.md', 'lib-copy'), made('T-2', 'notes/plan.md')],
    pictures: [],
    records: { count: 0, kinds: {} },
  };
  // One uploaded entry at its second revision, one from accepted work, and one removed, which later work no longer
  // follows.
  controller.library = {
    entries: [
      entry('lib-brand', 'Brand guide', 'The colours and type every page uses.', [
        revision(1, 2048, { type: 'upload' }),
        revision(2, 1536, { type: 'upload' }),
      ]),
      entry('lib-copy', 'Launch copy', 'The words the launch page says.', [revision(1, 512, accepted)]),
      entry('lib-old', 'Old notes', 'Notes nobody follows any more.', [revision(1, 4096, { type: 'upload' })], {
        removedAt: '2026-10-28T14:00:00Z',
      }),
    ],
    proposals: [],
  };
  controller.libraryReaders = {
    'lib-brand': [reader('attempt-a', 2), reader('attempt-b', 2), reader('attempt-c', 1)],
    'lib-copy': [reader('attempt-d', 1)],
    'lib-old': [reader('attempt-e', 1)],
  };
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
const posted = () => controller.requests.filter(request => request.method !== 'GET');
const card = (name: string) => within(screen.getByRole('button', { name }));
const dialog = async (name: string) => within(await screen.findByRole('dialog', { name }));
const library = () => within(screen.getByRole('region', { name: 'Library' }));
const libraryUrl = '/api/projects/project-x/library';
// What the controller answers an added entry with, after adding it to the library it serves.
const adds = (made: LibraryEntry) => (url: string) => {
  if (url !== libraryUrl) return {};
  controller.library = { ...controller.library, entries: [...controller.library.entries, made] };
  return made;
};

test('each current entry shows as a card with its purpose, revision, size, readers and source, under the total', async () => {
  open();
  const list = await screen.findByRole('list', { name: 'Library files' });
  // In the library's order, each card a button named by its entry, for picking it.
  expect(
    within(list)
      .getAllByRole('listitem')
      .map(item => item.querySelector('button > span')?.textContent),
  ).toEqual(['Brand guide', 'Launch copy']);
  const brand = card('Brand guide');
  expect(brand.getByText('The colours and type every page uses.')).toBeTruthy();
  expect(brand.getByText('Revision 2')).toBeTruthy();
  expect(brand.getByText('1.5 KiB')).toBeTruthy();
  expect(await brand.findByText('Read by 3 attempts')).toBeTruthy();
  expect(brand.getByText('Uploaded')).toBeTruthy();
  const copy = card('Launch copy');
  expect(copy.getByText('The words the launch page says.')).toBeTruthy();
  expect(copy.getByText('Revision 1')).toBeTruthy();
  expect(copy.getByText('512 B')).toBeTruthy();
  expect(await copy.findByText('Read by 1 attempt')).toBeTruthy();
  // An accepted file names its story.
  expect(copy.getByText('From accepted work: Story T-1')).toBeTruthy();
  // The total is each current entry's newest revision, against what every attempt receives in full.
  expect(library().getByText('2 files')).toBeTruthy();
  expect(screen.getByText('2.0 KiB in all, of the 20 MiB every attempt receives in full')).toBeTruthy();
  expect(screen.queryByText(/index only/)).toBeNull();
  // A removed entry shows no card, and its readers are not read.
  expect(screen.queryByText('Old notes')).toBeNull();
  const reads = controller.reads();
  expect(reads).toContain('/api/projects/project-x/library/lib-brand/readers');
  expect(reads).toContain('/api/projects/project-x/library/lib-copy/readers');
  expect(reads).not.toContain('/api/projects/project-x/library/lib-old/readers');
  // The library sits above the work.
  const files = screen.getByRole('list', { name: 'The work' });
  expect(list.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('a library past what every attempt receives says the rest go in the index only, and a copy names its project', async () => {
  controller.library = {
    entries: [
      ...[1, 2, 3, 4].map(number =>
        entry(`lib-${number}`, `Data set ${number}`, 'Rows to check against.', [
          revision(1, 5 * MiB, { type: 'upload' }),
        ]),
      ),
      entry('lib-5', 'Shared palette', 'The colours both projects use.', [
        revision(1, 2 * MiB, { type: 'copy', projectId: 'project-y', entryId: 'lib-y', revision: 3, sha256: 'sha-y' }),
      ]),
    ],
  };
  controller.libraryReaders = {};
  open();
  await screen.findByRole('list', { name: 'Library files' });
  expect(screen.getByText('22.0 MiB in all, of the 20 MiB every attempt receives in full')).toBeTruthy();
  expect(screen.getByText(/the files past it go in each attempt's index only/)).toBeTruthy();
  const palette = card('Shared palette');
  expect(palette.getByText('Copied from Project Y')).toBeTruthy();
  expect(await palette.findByText('Not read yet')).toBeTruthy();
});

test('an empty library says what it is for', async () => {
  controller.library = {
    entries: [
      entry('lib-old', 'Old notes', 'Gone.', [revision(1, 10, { type: 'upload' })], {
        removedAt: '2026-10-28T14:00:00Z',
      }),
    ],
  };
  open();
  expect(await screen.findByText('The library is empty.')).toBeTruthy();
  expect(screen.getByText(/Keep here the files later work should follow/)).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Library files' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Upload a file' })).toBeTruthy();
});

test('Upload a file posts the file in base64 with its name and purpose, and the new card appears', async () => {
  const user = userEvent.setup();
  controller.command = adds(
    entry('lib-tokens', 'Tokens', 'The design tokens every page reads.', [revision(1, 13, { type: 'upload' })]),
  );
  open();
  await screen.findByRole('list', { name: 'Library files' });
  await user.click(screen.getByRole('button', { name: 'Upload a file' }));
  const upload = await dialog('Upload a file'),
    add = upload.getByRole('button', { name: 'Add to the library' }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  // The library's own kind for the file's name is sent, whatever the browser calls it.
  await user.upload(
    upload.getByLabelText('File'),
    new File(['colour: teal\n'], 'tokens.yaml', { type: 'application/x-yaml' }),
  );
  expect(upload.getByText('tokens.yaml, 13 B')).toBeTruthy();
  await user.type(upload.getByLabelText('Name'), ' Tokens ');
  expect(add.disabled).toBe(true);
  await user.type(upload.getByLabelText('What it is for'), 'The design tokens every page reads.');
  await user.click(add);
  expect(await screen.findByRole('button', { name: 'Tokens' })).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: libraryUrl,
      method: 'POST',
      body: {
        projectId: 'project-x',
        name: 'Tokens',
        purpose: 'The design tokens every page reads.',
        file: { name: 'tokens.yaml', mediaType: 'text/yaml', data: btoa('colour: teal\n') },
      },
    },
  ]);
  expect(screen.queryByRole('dialog', { name: 'Upload a file' })).toBeNull();
  expect(screen.getByText('Added Tokens to the library.')).toBeTruthy();
  expect(library().getByText('3 files')).toBeTruthy();
  expect(await card('Tokens').findByText('Not read yet')).toBeTruthy();
});

test('Add to the library on a file of the work posts where it came from, and the new card names its story', async () => {
  const user = userEvent.setup();
  controller.command = adds(
    entry('lib-plan', 'Plan', 'The plan every story follows.', [
      revision(1, 40, {
        type: 'accepted',
        taskId: 'T-2',
        attemptId: 'attempt-T-2',
        path: 'notes/plan.md',
        hash: 'hash-T-2',
      }),
    ]),
  );
  open();
  const files = await screen.findByRole('list', { name: 'The work' });
  // Every file the library does not hold offers it; the one it holds says so.
  expect(within(files).getAllByRole('button', { name: /^Add .+ to the library$/ })).toHaveLength(1);
  expect(within(files).getAllByText('In the library')).toHaveLength(1);
  await user.click(within(files).getByRole('button', { name: 'Add notes/plan.md to the library' }));
  const add = await dialog('Add to the library');
  expect(add.getByText('notes/plan.md')).toBeTruthy();
  expect(add.queryByLabelText('File')).toBeNull();
  await user.type(add.getByLabelText('Name'), 'Plan');
  await user.type(add.getByLabelText('What it is for'), 'The plan every story follows.');
  await user.click(add.getByRole('button', { name: 'Add to the library' }));
  expect(await card('Plan').findByText('From accepted work: Story T-2')).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: libraryUrl,
      method: 'POST',
      body: {
        projectId: 'project-x',
        name: 'Plan',
        purpose: 'The plan every story follows.',
        from: { taskId: 'T-2', attemptId: 'attempt-T-2', path: 'notes/plan.md' },
      },
    },
  ]);
  expect(screen.queryByRole('dialog', { name: 'Add to the library' })).toBeNull();
});

test("the controller's refusal shows in the dialog, which stays open with what was typed", async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw Object.assign(
      new Error('The library already has an entry named Brand guide; add a new revision to it instead.'),
      { status: 409 },
    );
  };
  open();
  const files = await screen.findByRole('list', { name: 'The work' });
  await user.click(within(files).getByRole('button', { name: 'Add notes/plan.md to the library' }));
  const add = await dialog('Add to the library');
  await user.type(add.getByLabelText('Name'), 'Brand guide');
  await user.type(add.getByLabelText('What it is for'), 'The plan every story follows.');
  await user.click(add.getByRole('button', { name: 'Add to the library' }));
  expect((await add.findByRole('alert')).textContent).toBe(
    'The library already has an entry named Brand guide; add a new revision to it instead.',
  );
  expect(screen.getByRole('dialog', { name: 'Add to the library' })).toBeTruthy();
  expect((add.getByLabelText('Name') as HTMLInputElement).value).toBe('Brand guide');
  expect(posted()).toHaveLength(1);
  // Changing the name clears the refusal, and the renamed entry is added.
  controller.command = adds(
    entry('lib-plan', 'Plan', 'The plan every story follows.', [
      revision(1, 40, {
        type: 'accepted',
        taskId: 'T-2',
        attemptId: 'attempt-T-2',
        path: 'notes/plan.md',
        hash: 'hash-T-2',
      }),
    ]),
  );
  await user.clear(add.getByLabelText('Name'));
  expect(add.queryByRole('alert')).toBeNull();
  await user.type(add.getByLabelText('Name'), 'Plan');
  await user.click(add.getByRole('button', { name: 'Add to the library' }));
  expect(await screen.findByRole('button', { name: 'Plan' })).toBeTruthy();
  expect(posted()).toHaveLength(2);
});

test('a refused upload shows the reason and keeps the dialog open until Cancel', async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw Object.assign(new Error('A library file is at most 5 MiB.'), { status: 413 });
  };
  open();
  await screen.findByRole('list', { name: 'Library files' });
  await user.click(screen.getByRole('button', { name: 'Upload a file' }));
  const upload = await dialog('Upload a file');
  await user.upload(upload.getByLabelText('File'), new File(['big'], 'photo.png', { type: 'image/png' }));
  await user.type(upload.getByLabelText('Name'), 'Photo');
  await user.type(upload.getByLabelText('What it is for'), 'The hero picture.');
  await user.click(upload.getByRole('button', { name: 'Add to the library' }));
  expect((await upload.findByRole('alert')).textContent).toBe('A library file is at most 5 MiB.');
  expect(screen.getByRole('dialog', { name: 'Upload a file' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /^(Brand guide|Launch copy)$/ })).toHaveLength(2);
  await user.click(upload.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upload a file' })).toBeNull());
  // Opened again, it starts empty.
  await user.click(screen.getByRole('button', { name: 'Upload a file' }));
  const again = await dialog('Upload a file');
  expect((again.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  expect(again.queryByRole('alert')).toBeNull();
});
