// A library file's own view (1.2 step 6), opened by picking its card on the Artifacts page: its revisions newest first,
// each with when it was added, where it came from and how many attempts read it, Open in a new tab, the ideas that
// left it out among the runs the page holds, and Add a newer revision, Copy to another project and Remove from the
// library, each reading the library again afterwards with the controller's refusal shown in place.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  LibraryEntry,
  LibraryReader,
  LibraryRevision,
  LibrarySource,
  ProjectArtifact,
  RunRecord,
  Task,
} from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller, confirm: ReturnType<typeof vi.fn>;
const revision = (number: number, at: string, byteLength: number, source: LibrarySource): LibraryRevision => ({
  revision: number,
  file: `brand-r${number}.md`,
  mediaType: 'text/markdown',
  byteLength,
  sha256: `sha-${number}`,
  source,
  at,
  by: { type: 'director' },
});
const entry = (id: string, name: string, purpose: string, revisions: LibraryRevision[]): LibraryEntry => ({
  id,
  name,
  purpose,
  createdAt: '2026-01-05T12:00:00Z',
  by: { type: 'director' },
  revisions,
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
// A run as the live set and the finished pages send it (src/core/graph.mjs runView, with its archive and the
// director's inputs), with one node per task: libraryLeftOut is there only when the idea left entries out.
const run = (id: string, createdAt: string, brief: string, tasks: Task[], leftOut: string[] = []): RunRecord => ({
  id,
  projectId: 'project-x',
  workflow: { id: 'workflow-1', name: 'Fixture flow', version: 3 },
  brief,
  ...(leftOut.length ? { libraryLeftOut: leftOut } : {}),
  createdAt,
  revisions: [{ revision: 1, at: createdAt, reason: 'created' }],
  nodes: tasks.map(task => ({
    taskId: task.id,
    key: task.id,
    kind: task.kind,
    title: task.title,
    workerId: 'W-1',
    dependencies: [],
    revision: 1,
  })),
  archive: { archived: false },
  directorInputs: [],
});
const member = (id: string, runId: string, extra: Partial<Task> = {}) =>
  taskFixture(id, {
    title: `Story ${id}`,
    workflowReference: { runId, key: id, id: 'workflow-1', name: 'Fixture flow' },
    ...extra,
  });

beforeEach(() => {
  controller = fakeController();
  confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  controller.projectArtifacts = [file('T-1', 'copy/brand.md'), file('T-2', 'notes/plan.md')];
  // An entry at its third revision, each from somewhere else: an upload, an accepted file and a copy from Project Y.
  controller.library = {
    entries: [
      entry('lib-brand', 'Brand guide', 'The colours and type every page uses.', [
        revision(1, '2026-01-10T12:00:00Z', 2048, { type: 'upload' }),
        revision(2, '2026-02-11T12:00:00Z', 1536, {
          type: 'accepted',
          taskId: 'T-1',
          attemptId: 'attempt-T-1',
          path: 'copy/brand.md',
          hash: 'hash-T-1',
        }),
        revision(3, '2026-03-12T12:00:00Z', 512, {
          type: 'copy',
          projectId: 'project-y',
          entryId: 'lib-y',
          revision: 4,
          sha256: 'sha-y',
        }),
      ]),
      entry('lib-terms', 'Glossary', 'The words the product uses.', [
        revision(1, '2026-01-05T12:00:00Z', 300, { type: 'upload' }),
      ]),
    ],
    proposals: [],
  };
  // Two attempts read the newest revision, one the first, and none the second.
  controller.libraryReaders = { 'lib-brand': [reader('attempt-a', 3), reader('attempt-b', 3), reader('attempt-c', 1)] };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x/artifacts') => {
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
const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await screen.findByRole('button', { name }));
  return within(await screen.findByRole('dialog', { name }));
};
const posted = () => controller.requests.filter(request => request.method !== 'GET');
const entryUrl = '/api/projects/project-x/library/lib-brand';
const libraryReads = () => controller.reads().filter(url => url === '/api/projects/project-x/library').length;
const refused =
  (message: string, status = 409) =>
  () => {
    throw Object.assign(new Error(message), { status });
  };

test('picking a card shows its purpose and revisions newest first, each with when, where from and its readers', async () => {
  const user = userEvent.setup();
  open();
  const view = await pick(user, 'Brand guide');
  expect(view.getByText('The colours and type every page uses.')).toBeTruthy();
  const rows = within(view.getByRole('list', { name: 'Revisions' })).getAllByRole('listitem');
  expect(rows.map(row => within(row).getByText(/^Revision \d+$/).textContent)).toEqual([
    'Revision 3',
    'Revision 2',
    'Revision 1',
  ]);
  const [third, second, first] = rows.map(row => within(row));
  // When each was added.
  expect(third!.getByText(when('2026-03-12T12:00:00Z')).getAttribute('datetime')).toBe('2026-03-12T12:00:00Z');
  expect(second!.getByText(when('2026-02-11T12:00:00Z')).getAttribute('datetime')).toBe('2026-02-11T12:00:00Z');
  expect(first!.getByText(when('2026-01-10T12:00:00Z')).getAttribute('datetime')).toBe('2026-01-10T12:00:00Z');
  expect(third!.getByText('brand-r3.md')).toBeTruthy();
  expect(third!.getByText('512 B')).toBeTruthy();
  expect(first!.getByText('2.0 KiB')).toBeTruthy();
  // Where each came from: a copy names its project, and an accepted file links to its story.
  expect(third!.getByText('Copied from Project Y')).toBeTruthy();
  expect(second!.getByText('From accepted work:')).toBeTruthy();
  expect(second!.getByRole('link', { name: 'Story T-1' }).getAttribute('href')).toBe('/p/project-x/tasks/T-1');
  expect(first!.getByText('Uploaded')).toBeTruthy();
  // How many attempts read each revision: the entry's readers, counted by the revision each received.
  expect(await third!.findByText('Read by 2 attempts')).toBeTruthy();
  expect(second!.getByText('Not read yet')).toBeTruthy();
  expect(first!.getByText('Read by 1 attempt')).toBeTruthy();
  // No run the page holds left it out, and with no finished ideas read it says it looked through the open ones only.
  expect(view.getByText('None of them left it out.')).toBeTruthy();
  expect(view.getByText('Among the open ideas. Finished ones count once the Ideas page lists them.')).toBeTruthy();
  expect(view.queryByRole('list', { name: 'Ideas that left it out' })).toBeNull();
  // Closing it and picking another card shows that one's revisions.
  await user.click(view.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Brand guide' })).toBeNull());
  const glossary = await pick(user, 'Glossary');
  expect(within(glossary.getByRole('list', { name: 'Revisions' })).getAllByRole('listitem')).toHaveLength(1);
  expect(await glossary.findByText('Not read yet')).toBeTruthy();
  expect(posted()).toEqual([]);
});

test("Open links each revision's bytes in a new tab", async () => {
  const user = userEvent.setup();
  open();
  const view = await pick(user, 'Brand guide');
  for (const number of [3, 2, 1]) {
    const link = view.getByRole('link', { name: `Open revision ${number}` });
    expect(link.getAttribute('href')).toBe(`/api/projects/project-x/library/lib-brand/revisions/${number}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  }
});

test('the ideas that left it out come from the live set and the finished pages read so far, each linking to its idea', async () => {
  const user = userEvent.setup();
  const live = member('T-live', 'run-live'),
    other = member('T-other', 'run-other'),
    done = member('T-done', 'run-done', { status: 'done' }),
    kept = member('T-kept', 'run-kept', { status: 'done' }),
    older = member('T-older', 'run-older', { status: 'done' });
  controller.tasks = [live, other];
  // Open ideas: one leaves the brand guide out, and one leaves out only the glossary.
  controller.runs = [
    run('run-live', '2026-10-28T12:00:00Z', 'Write the launch page without the old brand.', [live], ['lib-brand']),
    run('run-other', '2026-10-27T12:00:00Z', 'Name things freely.', [other], ['lib-terms']),
  ];
  // Finished ideas: the first page has one that left it out and one that kept everything; the older page, not read
  // yet, has another that left it out.
  controller.finished = {
    runs: [
      {
        run: run(
          'run-done',
          '2026-10-20T12:00:00Z',
          'Draft the pitch deck from scratch.',
          [done],
          ['lib-terms', 'lib-brand'],
        ),
        tasks: [done],
        attempts: [],
      },
      { run: run('run-kept', '2026-10-19T12:00:00Z', 'Follow the guide.', [kept]), tasks: [kept], attempts: [] },
    ],
    next: 'run-kept',
  };
  controller.olderRuns['run-kept'] = {
    runs: [
      {
        run: run('run-older', '2026-10-01T12:00:00Z', 'An older idea without the guide.', [older], ['lib-brand']),
        tasks: [older],
        attempts: [],
      },
    ],
    next: null,
  };
  expect(controller.finished.runs[1]!.run).not.toHaveProperty('libraryLeftOut');
  // The Ideas page reads the first page of finished ideas; the Artifacts page then holds it.
  const router = open('/p/project-x/runs');
  expect(await screen.findByText(/Draft the pitch deck from scratch/)).toBeTruthy();
  await router.navigate({ to: '/p/$projectId/artifacts', params: { projectId: 'project-x' } });
  let view = await pick(user, 'Brand guide');
  const ideas = () =>
    within(view.getByRole('list', { name: 'Ideas that left it out' }))
      .getAllByRole('link')
      .map(link => [link.textContent, link.getAttribute('href')]);
  expect(ideas()).toEqual([
    ['“Write the launch page without the old brand.”', '/p/project-x/runs/run-live'],
    ['“Draft the pitch deck from scratch.”', '/p/project-x/runs/run-done'],
  ]);
  // It says which ideas it looked through: older finished ones are not read yet.
  expect(
    view.getByText(
      'Among the open ideas and the 2 newest finished ones. Older ones count once the Ideas page lists them.',
    ),
  ).toBeTruthy();
  // Nothing more was read for the view.
  expect(controller.reads().filter(url => url.includes('/runs?'))).toEqual(['/api/projects/project-x/runs?limit=5']);
  // An older page the Ideas page reads joins them.
  await user.click(view.getByRole('button', { name: 'Close' }));
  await router.navigate({ to: '/p/$projectId/runs', params: { projectId: 'project-x' } });
  await user.click(await screen.findByRole('button', { name: 'Show older ideas' }));
  expect(await screen.findByText(/An older idea without the guide/)).toBeTruthy();
  await router.navigate({ to: '/p/$projectId/artifacts', params: { projectId: 'project-x' } });
  view = await pick(user, 'Brand guide');
  expect(ideas().map(([, href]) => href)).toEqual([
    '/p/project-x/runs/run-live',
    '/p/project-x/runs/run-done',
    '/p/project-x/runs/run-older',
  ]);
  // The oldest page is read, so every idea was looked through.
  expect(view.getByText('Among every idea, open and finished.')).toBeTruthy();
  // Another entry lists only the ideas that left it out.
  await user.click(view.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Brand guide' })).toBeNull());
  view = await pick(user, 'Glossary');
  expect(ideas().map(([, href]) => href)).toEqual(['/p/project-x/runs/run-other', '/p/project-x/runs/run-done']);
  // Each opens its idea.
  await user.click(view.getByRole('link', { name: '“Name things freely.”' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-other'));
});

test('Add a newer revision posts an upload in base64 under its library kind, and the new revision shows', async () => {
  const user = userEvent.setup();
  controller.command = url => {
    if (url !== `${entryUrl}/revisions`) return {};
    const [brand, ...rest] = controller.library.entries;
    const revised = {
      ...brand!,
      revisions: [...brand!.revisions, revision(4, '2026-04-13T12:00:00Z', 8, { type: 'upload' })],
    };
    controller.library = { ...controller.library, entries: [revised, ...rest] };
    return revised;
  };
  open();
  const view = await pick(user, 'Brand guide');
  await user.click(view.getByRole('button', { name: 'Add a newer revision' }));
  const panel = within(view.getByRole('region', { name: 'Add a newer revision' })),
    add = panel.getByRole('button', { name: 'Add the revision' }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  await user.upload(panel.getByLabelText('File'), new File(['# Brand\n'], 'brand.md', { type: '' }));
  expect(panel.getByText('brand.md, 8 B')).toBeTruthy();
  await user.click(add);
  expect(await view.findByText('Revision 4')).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: `${entryUrl}/revisions`,
      method: 'POST',
      body: { projectId: 'project-x', file: { name: 'brand.md', mediaType: 'text/markdown', data: btoa('# Brand\n') } },
    },
  ]);
  expect(view.queryByRole('region', { name: 'Add a newer revision' })).toBeNull();
  expect(screen.getByText('Added a newer revision of Brand guide.')).toBeTruthy();
  expect(
    within(view.getByRole('list', { name: 'Revisions' }))
      .getAllByRole('listitem')
      .map(row => within(row).getByText(/^Revision \d+$/).textContent),
  ).toEqual(['Revision 4', 'Revision 3', 'Revision 2', 'Revision 1']);
});

test('Add a newer revision from an accepted file posts where it came from', async () => {
  const user = userEvent.setup();
  open();
  const view = await pick(user, 'Brand guide');
  await user.click(view.getByRole('button', { name: 'Add a newer revision' }));
  const panel = within(view.getByRole('region', { name: 'Add a newer revision' }));
  await user.click(panel.getByRole('button', { name: 'An accepted file' }));
  expect(panel.queryByLabelText('File')).toBeNull();
  const files = panel.getByLabelText('Accepted file');
  // Every accepted file is offered.
  expect(
    within(files)
      .getAllByRole('option')
      .map(option => option.textContent),
  ).toEqual(['Choose a file', 'copy/brand.md, from Story T-1', 'notes/plan.md, from Story T-2']);
  await user.selectOptions(files, 'notes/plan.md, from Story T-2');
  const before = libraryReads();
  await user.click(panel.getByRole('button', { name: 'Add the revision' }));
  expect(await screen.findByText('Added a newer revision of Brand guide.')).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: `${entryUrl}/revisions`,
      method: 'POST',
      body: { projectId: 'project-x', from: { taskId: 'T-2', attemptId: 'attempt-T-2', path: 'notes/plan.md' } },
    },
  ]);
  await waitFor(() => expect(libraryReads()).toBe(before + 1));
});

test("a refused revision shows the controller's reason in place, the library is read again, and a change clears it", async () => {
  const user = userEvent.setup();
  controller.command = refused('That file is the same as the newest revision.');
  open();
  const view = await pick(user, 'Brand guide');
  await user.click(view.getByRole('button', { name: 'Add a newer revision' }));
  const panel = within(view.getByRole('region', { name: 'Add a newer revision' }));
  await user.upload(panel.getByLabelText('File'), new File(['same'], 'brand.md', { type: 'text/markdown' }));
  const before = libraryReads();
  await user.click(panel.getByRole('button', { name: 'Add the revision' }));
  expect((await panel.findByRole('alert')).textContent).toBe('That file is the same as the newest revision.');
  // The panel stays open with the file, and the view is read again.
  expect(view.getByRole('region', { name: 'Add a newer revision' })).toBeTruthy();
  expect(panel.getByText('brand.md, 4 B')).toBeTruthy();
  await waitFor(() => expect(libraryReads()).toBe(before + 1));
  await user.click(panel.getByRole('button', { name: 'An accepted file' }));
  expect(panel.queryByRole('alert')).toBeNull();
  expect(posted()).toHaveLength(1);
});

test('Copy to another project offers the other projects and posts the chosen one', async () => {
  const user = userEvent.setup();
  controller.shell.projects = [...controller.shell.projects, { id: 'project-z', name: 'Project Z' }];
  open();
  const view = await pick(user, 'Brand guide');
  await user.click(view.getByRole('button', { name: 'Copy to another project' }));
  const panel = within(view.getByRole('region', { name: 'Copy to another project' })),
    projects = await panel.findByLabelText('Project'),
    copy = panel.getByRole('button', { name: 'Copy' }) as HTMLButtonElement;
  // This project is not offered.
  expect(
    within(projects)
      .getAllByRole('option')
      .map(option => option.textContent),
  ).toEqual(['Choose a project', 'Project Y', 'Project Z']);
  expect(copy.disabled).toBe(true);
  await user.selectOptions(projects, 'Project Z');
  await user.click(copy);
  expect(await screen.findByText('Copied Brand guide to Project Z.')).toBeTruthy();
  expect(posted()).toEqual([
    { url: `${entryUrl}/copy`, method: 'POST', body: { projectId: 'project-x', to: 'project-z' } },
  ]);
  expect(controller.reads()).toContain('/api/projects');
  expect(view.queryByRole('region', { name: 'Copy to another project' })).toBeNull();
  // The entry stays in this project's library.
  expect(screen.getByRole('dialog', { name: 'Brand guide' })).toBeTruthy();
});

test("a refused copy shows the controller's reason in the panel", async () => {
  const user = userEvent.setup();
  controller.command = refused("That project's library already has an entry named Brand guide.");
  open();
  const view = await pick(user, 'Brand guide');
  await user.click(view.getByRole('button', { name: 'Copy to another project' }));
  const panel = within(view.getByRole('region', { name: 'Copy to another project' }));
  await user.selectOptions(await panel.findByLabelText('Project'), 'Project Y');
  await user.click(panel.getByRole('button', { name: 'Copy' }));
  expect((await panel.findByRole('alert')).textContent).toBe(
    "That project's library already has an entry named Brand guide.",
  );
  expect(posted()).toEqual([
    { url: `${entryUrl}/copy`, method: 'POST', body: { projectId: 'project-x', to: 'project-y' } },
  ]);
});

test('Remove from the library posts only once confirmed, and the card goes once the entry is marked removed', async () => {
  const user = userEvent.setup();
  controller.command = url => {
    if (url !== `${entryUrl}/remove`) return {};
    const entries = controller.library.entries.map(item =>
      item.id === 'lib-brand' ? { ...item, removedAt: '2026-10-29T09:00:00Z' } : item,
    );
    controller.library = { ...controller.library, entries };
    return entries[0];
  };
  open();
  const view = await pick(user, 'Brand guide');
  // Declined, nothing is sent and the view stays.
  confirm.mockReturnValueOnce(false);
  await user.click(view.getByRole('button', { name: 'Remove from the library' }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(confirm.mock.calls[0]![0]).toBe(
    'Remove Brand guide from the library? Later work no longer receives it; its record stays.',
  );
  expect(posted()).toEqual([]);
  expect(screen.getByRole('dialog', { name: 'Brand guide' })).toBeTruthy();
  // Confirmed, it is sent, the view closes and the library read again no longer shows the card.
  await user.click(view.getByRole('button', { name: 'Remove from the library' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Brand guide' })).toBeNull());
  expect(posted()).toEqual([{ url: `${entryUrl}/remove`, method: 'POST', body: { projectId: 'project-x' } }]);
  expect(screen.queryByRole('dialog', { name: 'Brand guide' })).toBeNull();
  expect(screen.getByText('Removed Brand guide from the library.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Glossary' })).toBeTruthy();
});

test("a refused removal shows the controller's reason and keeps the view and its card", async () => {
  const user = userEvent.setup();
  controller.command = refused('Library entry not found.', 404);
  open();
  const view = await pick(user, 'Brand guide');
  await user.click(view.getByRole('button', { name: 'Remove from the library' }));
  expect((await view.findByRole('alert')).textContent).toBe('Library entry not found.');
  expect(screen.getByRole('dialog', { name: 'Brand guide' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Brand guide' })).toBeTruthy();
  expect(posted()).toHaveLength(1);
});
