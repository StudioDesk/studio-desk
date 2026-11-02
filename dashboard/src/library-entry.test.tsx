// A library file's own view (1.2 step 6), opened by picking its card on the Artifacts page, in the panel beside the
// page (found as the complementary region named by the file): its newest revision read in place, or Download for a
// kind the page cannot show, its revisions newest first, each with when it was added, where it came from, how many
// attempts read it, What changed against the revision before and Open in a new tab, the ideas that left it out among
// the runs the page holds, and Add a newer revision, Edit on a text file (its newest revision's text in place, a
// preview beside Markdown, What changed before saving it as the next revision), Copy to another project, Remove from
// the library and Download, each command reading the library again afterwards with the controller's refusal shown in
// place.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import { libraryEditable } from './library';
import { LibraryFile } from './library-entry';
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
  return within(await screen.findByRole('complementary', { name }));
};
const posted = () => controller.requests.filter(request => request.method !== 'GET');
const entryUrl = '/api/projects/project-x/library/lib-brand';
const libraryReads = () => controller.reads().filter(url => url === '/api/projects/project-x/library').length;
const refused =
  (message: string, status = 409) =>
  () => {
    throw Object.assign(new Error(message), { status });
  };
const revisionRows = (view: ReturnType<typeof within>) =>
  within(view.getByRole('list', { name: 'Revisions' }))
    .getAllByRole('listitem')
    .map(row => within(row).getByText(/^Revision \d+$/).textContent);
// A text's UTF-8 bytes in base64, as the dashboard sends an upload.
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
// The brand guide's newest revision, and an edit of its third line.
const brandText = '# Brand\n\n- Use blue.\n- Set type in Inter.\n';
const brandEdited = '# Brand\n\n- Use deep blue — #1d4ed8.\n- Set type in Inter.\n';
// The view's Edit panel once the newest revision's text is in its editor.
const editPanel = async (user: ReturnType<typeof userEvent.setup>, view: ReturnType<typeof within>, name: string) => {
  await user.click(view.getByRole('button', { name: 'Edit' }));
  const panel = within(view.getByRole('region', { name: `Edit ${name}` }));
  return { panel, editor: (await panel.findByLabelText('Text')) as HTMLTextAreaElement };
};
const whatChanged = (panel: ReturnType<typeof within>) => within(panel.getByRole('region', { name: 'What changed' }));
const changedLines = (panel: ReturnType<typeof within>) =>
  within(whatChanged(panel).getByRole('list', { name: 'Lines added and removed' }))
    .getAllByRole('listitem')
    .map(item => item.getAttribute('aria-label'));
// Adds the next revision to an entry, as the controller does when it accepts one.
const addsRevision = (entryId: string) => (url: string) => {
  if (url !== `/api/projects/project-x/library/${entryId}/revisions`) return {};
  const entries = controller.library.entries.map(item => {
    if (item.id !== entryId) return item;
    const last = item.revisions.at(-1)!;
    return {
      ...item,
      revisions: [...item.revisions, { ...last, revision: last.revision + 1, at: '2026-10-30T12:00:00Z' }],
    };
  });
  controller.library = { ...controller.library, entries };
  return entries.find(item => item.id === entryId);
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
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Brand guide' })).toBeNull());
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

test('picking a Markdown card reads its newest revision as a page in the panel below the cards, without a download', async () => {
  const user = userEvent.setup();
  controller.libraryTexts = { 'lib-brand/3': brandText, 'lib-brand/2': 'An older text.\n' };
  const router = open();
  const view = await pick(user, 'Brand guide');
  // The panel stands below the library's cards, where the dialog used to open, and is no dialog.
  const panel = screen.getByRole('complementary', { name: 'Brand guide' });
  expect(
    screen.getByRole('list', { name: 'Library files' }).compareDocumentPosition(panel) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Brand guide' })).toBeNull();
  // Its head: the kind's tile, the name, what it is for and where its newest revision came from.
  const name = view.getByRole('heading', { name: 'Brand guide', level: 2 }),
    head = within(name.parentElement!);
  expect(view.getByText('MD').getAttribute('aria-hidden')).toBe('true');
  expect(head.getByText('The colours and type every page uses.')).toBeTruthy();
  expect(head.getByText('Copied from Project Y')).toBeTruthy();
  // The newest revision drawn as a page.
  const page = await view.findByRole('heading', { name: 'Brand', level: 1 });
  expect(page.closest('.sd-reader__text')).toBeTruthy();
  expect(view.getByText('Use blue.')).toBeTruthy();
  expect(view.queryByText('An older text.')).toBeNull();
  // Read through the library's own route for that revision alone, with nothing sent and no page left.
  expect(controller.reads().filter(url => url.includes('/revisions/'))).toEqual([`${entryUrl}/revisions/3`]);
  expect(posted()).toEqual([]);
  expect(router.history.location.pathname).toBe('/p/project-x/artifacts');
  // Edit reads the same revision from what the panel already read.
  const { editor } = await editPanel(user, view, 'Brand guide');
  expect(editor.value).toBe(brandText);
  expect(controller.reads().filter(url => url.includes('/revisions/'))).toEqual([`${entryUrl}/revisions/3`]);
});

test("a PDF entry says it can't be shown here and offers Download of its newest revision, reading nothing", async () => {
  const user = userEvent.setup();
  const pdf = (number: number, at: string) => ({
    ...revision(number, at, 9000, { type: 'upload' }),
    file: 'brief.pdf',
    mediaType: 'application/pdf',
  });
  controller.library = {
    entries: [
      entry('lib-brief', 'Client brief', 'What the client asked for.', [
        pdf(1, '2026-01-10T12:00:00Z'),
        pdf(2, '2026-02-10T12:00:00Z'),
      ]),
    ],
    proposals: [],
  };
  open();
  const view = await pick(user, 'Client brief');
  expect(view.getByText('PDF').getAttribute('aria-hidden')).toBe('true');
  expect(view.getByText("This file can't be shown here. Download it to look at the recorded file.")).toBeTruthy();
  const download = view.getByRole('link', { name: 'Download' });
  expect(download.hasAttribute('download')).toBe(true);
  expect(download.getAttribute('href')).toBe('/api/projects/project-x/library/lib-brief/revisions/2');
  expect(download.getAttribute('target')).toBeNull();
  // Nothing to compare or edit as text, and nothing read.
  expect(revisionRows(view)).toEqual(['Revision 2', 'Revision 1']);
  expect(view.queryByRole('button', { name: /What changed/ })).toBeNull();
  expect(view.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(view.getByRole('button', { name: 'Add a newer revision' })).toBeTruthy();
  expect(controller.reads().filter(url => url.includes('/revisions/'))).toEqual([]);
});

test('What changed on revision 2 shows the lines added and removed against revision 1, read only when opened', async () => {
  const user = userEvent.setup();
  controller.libraryTexts = {
    'lib-brand/1': '# Brand\n\n- Use red.\n',
    'lib-brand/2': brandText,
    'lib-brand/3': brandEdited,
  };
  open();
  const view = await pick(user, 'Brand guide');
  await view.findByText('Use deep blue — #1d4ed8.');
  const [third, second, first] = within(view.getByRole('list', { name: 'Revisions' }))
    .getAllByRole('listitem')
    .map(row => within(row));
  // The first revision has none before it to compare.
  expect(first!.queryByRole('button', { name: /What changed/ })).toBeNull();
  expect(controller.reads().filter(url => url.includes('/revisions/'))).toEqual([`${entryUrl}/revisions/3`]);
  const changed = second!.getByRole('button', { name: 'What changed in revision 2' });
  expect(changed.getAttribute('aria-expanded')).toBe('false');
  await user.click(changed);
  expect(changed.getAttribute('aria-expanded')).toBe('true');
  const lines = await second!.findByRole('list', { name: 'Lines added and removed in revision 2' });
  expect(second!.getByText('Against revision 1: 2 lines added, 1 line removed')).toBeTruthy();
  expect(
    within(lines)
      .getAllByRole('listitem')
      .map(line => line.getAttribute('aria-label')),
  ).toEqual(['Line 3 removed: - Use red.', 'Line 3 added: - Use blue.', 'Line 4 added: - Set type in Inter.']);
  // The newest against the one before, from the revisions already read.
  await user.click(third!.getByRole('button', { name: 'What changed in revision 3' }));
  expect(await third!.findByText('Against revision 2: 1 line added, 1 line removed')).toBeTruthy();
  expect(
    controller
      .reads()
      .filter(url => url.includes('/revisions/'))
      .sort(),
  ).toEqual([1, 2, 3].map(number => `${entryUrl}/revisions/${number}`));
  // Closed again, it shows no lines.
  await user.click(changed);
  expect(second!.queryByRole('list')).toBeNull();
  expect(posted()).toEqual([]);
});

test("Download is a plain download of the newest revision's library file, and follows a newer revision", async () => {
  const user = userEvent.setup();
  controller.command = addsRevision('lib-brand');
  open();
  const view = await pick(user, 'Brand guide');
  const download = () => view.getByRole('link', { name: 'Download' });
  expect(download().hasAttribute('download')).toBe(true);
  expect(download().getAttribute('href')).toBe(`${entryUrl}/revisions/3`);
  expect(download().getAttribute('target')).toBeNull();
  // It sits with the panel's actions, after them.
  const actions = view.getByRole('button', { name: 'Add a newer revision' }).parentElement!;
  expect(download().parentElement).toBe(actions);
  expect(actions.lastElementChild).toBe(download());
  await user.click(view.getByRole('button', { name: 'Add a newer revision' }));
  const panel = within(view.getByRole('region', { name: 'Add a newer revision' }));
  await user.upload(panel.getByLabelText('File'), new File(['# Brand\n'], 'brand.md', { type: '' }));
  await user.click(panel.getByRole('button', { name: 'Add the revision' }));
  await waitFor(() => expect(download().getAttribute('href')).toBe(`${entryUrl}/revisions/4`));
});

test('LibraryFile shows Close only when the page supplies onClose, and no entry shows nothing', async () => {
  const user = userEvent.setup(),
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
    names = { records: null },
    glossary = controller.library.entries[1]!,
    onClose = vi.fn();
  const panel = (picked: LibraryEntry | null, close?: () => void) => (
    <QueryClientProvider client={client}>
      <LibraryFile projectId="project-x" entry={picked} names={names} onClose={close} />
    </QueryClientProvider>
  );
  const view = render(panel(glossary));
  const glossaryPanel = within(screen.getByRole('complementary', { name: 'Glossary' }));
  expect(glossaryPanel.queryByRole('button', { name: 'Close' })).toBeNull();
  view.rerender(panel(glossary, onClose));
  await user.click(glossaryPanel.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
  view.rerender(panel(null, onClose));
  expect(screen.queryByRole('complementary')).toBeNull();
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
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Brand guide' })).toBeNull());
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

test("Edit shows a Markdown file's newest text beside its preview and What changed, and saves the edit as its next revision", async () => {
  const user = userEvent.setup();
  controller.libraryTexts = { 'lib-brand/3': brandText, 'lib-brand/2': 'An older text.\n' };
  controller.command = addsRevision('lib-brand');
  open();
  const view = await pick(user, 'Brand guide');
  // Edit sits beside Add a newer revision.
  const toolbar = view.getByRole('button', { name: 'Add a newer revision' }).parentElement!;
  expect(
    within(toolbar)
      .getAllByRole('button')
      .map(button => button.textContent),
  ).toEqual(['Add a newer revision', 'Edit', 'Copy to another project', 'Remove from the library']);
  const { panel, editor } = await editPanel(user, view, 'Brand guide');
  expect(view.getByRole('button', { name: 'Edit' }).getAttribute('aria-expanded')).toBe('true');
  // The editor holds the newest revision's text, read from that revision alone.
  expect(editor.value).toBe(brandText);
  expect(controller.reads().filter(url => url.startsWith(`${entryUrl}/revisions/`))).toEqual([
    `${entryUrl}/revisions/3`,
  ]);
  const preview = within(panel.getByRole('region', { name: 'Preview' }));
  expect(preview.getByRole('heading', { name: 'Brand' })).toBeTruthy();
  expect(preview.getByText('Use blue.')).toBeTruthy();
  // Unchanged, it cannot be saved and nothing changed.
  const save = panel.getByRole('button', { name: 'Save as revision 4' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(whatChanged(panel).getByText('Nothing changed yet.')).toBeTruthy();
  // One line edited: What changed shows it removed and its replacement added before anything is sent, and the
  // preview follows the edit.
  await user.clear(editor);
  await user.paste(brandEdited);
  expect(editor.value).toBe(brandEdited);
  expect(whatChanged(panel).getByText('1 line added, 1 line removed')).toBeTruthy();
  expect(changedLines(panel)).toEqual(['Line 3 removed: - Use blue.', 'Line 3 added: - Use deep blue — #1d4ed8.']);
  expect(
    within(whatChanged(panel).getByRole('list', { name: 'Lines added and removed' }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('.sd-code__sign')?.textContent),
  ).toEqual(['−', '+']);
  expect(whatChanged(panel).queryByText('Nothing changed yet.')).toBeNull();
  expect(preview.getByText('Use deep blue — #1d4ed8.')).toBeTruthy();
  expect(preview.queryByText('Use blue.')).toBeNull();
  expect(posted()).toEqual([]);
  // Saved, the edit goes as a file under the newest revision's name, its UTF-8 bytes in base64.
  expect(save.disabled).toBe(false);
  const before = libraryReads();
  await user.click(save);
  expect(await screen.findByText('Saved revision 4 of Brand guide.')).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: `${entryUrl}/revisions`,
      method: 'POST',
      body: {
        projectId: 'project-x',
        file: { name: 'brand-r3.md', mediaType: 'text/markdown', data: base64(brandEdited) },
      },
    },
  ]);
  expect(view.queryByRole('region', { name: 'Edit Brand guide' })).toBeNull();
  // The library is read again, and the new revision shows first.
  await waitFor(() => expect(revisionRows(view)).toEqual(['Revision 4', 'Revision 3', 'Revision 2', 'Revision 1']));
  expect(libraryReads()).toBe(before + 1);
});

test.each([
  ['notes.txt', 'text/plain', 'First line.\nSecond line.\n', 'First line.\nThe second line.\n'],
  ['settings.json', 'application/json', '{\n  "size": 12\n}\n', '{\n  "size": 14\n}\n'],
  ['prices.csv', 'text/csv', 'item,price\ntea,3\n', 'item,price\ntea,4\n'],
  ['config.yaml', 'text/yaml', 'theme: light\nwidth: 1440\n', 'theme: dark\nwidth: 1440\n'],
  ['config.yml', 'text/yaml', 'theme: light\nwidth: 1440\n', 'theme: light\nwidth: 390\n'],
])('Edit on %s shows no preview and saves the edit as %s', async (fileName, mediaType, text, edited) => {
  const user = userEvent.setup();
  controller.library = {
    entries: [
      entry('lib-text', 'Settings', 'What the tests edit.', [
        { ...revision(1, '2026-01-10T12:00:00Z', text.length, { type: 'upload' }), file: fileName, mediaType },
      ]),
    ],
    proposals: [],
  };
  controller.libraryTexts = { 'lib-text/1': text };
  controller.command = addsRevision('lib-text');
  open();
  const view = await pick(user, 'Settings');
  expect(view.getByRole('button', { name: 'Add a newer revision' })).toBeTruthy();
  const { panel, editor } = await editPanel(user, view, 'Settings');
  expect(editor.value).toBe(text);
  expect(panel.queryByRole('region', { name: 'Preview' })).toBeNull();
  expect(whatChanged(panel).getByText('Nothing changed yet.')).toBeTruthy();
  await user.clear(editor);
  await user.paste(edited);
  expect(whatChanged(panel).getByText('1 line added, 1 line removed')).toBeTruthy();
  expect(changedLines(panel)).toHaveLength(2);
  await user.click(panel.getByRole('button', { name: 'Save as revision 2' }));
  expect(await screen.findByText('Saved revision 2 of Settings.')).toBeTruthy();
  expect(posted()).toEqual([
    {
      url: '/api/projects/project-x/library/lib-text/revisions',
      method: 'POST',
      body: { projectId: 'project-x', file: { name: fileName, mediaType, data: base64(edited) } },
    },
  ]);
  await waitFor(() => expect(revisionRows(view)).toEqual(['Revision 2', 'Revision 1']));
});

test('a file whose newest revision is not text offers Add a newer revision and no Edit', async () => {
  const user = userEvent.setup();
  // The logo was a Markdown sketch once; its newest revision is a picture.
  controller.library = {
    entries: [
      entry('lib-logo', 'Logo', 'The mark every page shows.', [
        revision(1, '2026-01-10T12:00:00Z', 40, { type: 'upload' }),
        { ...revision(2, '2026-02-10T12:00:00Z', 4096, { type: 'upload' }), file: 'logo.png', mediaType: 'image/png' },
      ]),
    ],
    proposals: [],
  };
  open();
  const view = await pick(user, 'Logo');
  expect(view.getByRole('button', { name: 'Add a newer revision' })).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Edit' })).toBeNull();
  // Only Markdown, plain text, JSON, CSV and YAML are edited as text, by the file name's extension in any case.
  expect(['a.md', 'a.MARKDOWN', 'a.txt', 'a.json', 'a.csv', 'a.yaml', 'a.Yml'].every(libraryEditable)).toBe(true);
  expect(
    ['a.png', 'a.html', 'a.svg', 'a.css', 'a.xml', 'a.js', 'a.ts', 'a.md.png', 'md', 'README'].some(libraryEditable),
  ).toBe(false);
  // Only the panel's picture of the newest revision is read; no text is read to edit.
  expect(controller.reads().filter(url => url.includes('/revisions/'))).toEqual([
    '/api/projects/project-x/library/lib-logo/revisions/2',
  ]);
});

test('an unchanged edit cannot be saved, even once typing is undone', async () => {
  const user = userEvent.setup();
  controller.libraryTexts = { 'lib-brand/3': brandText };
  open();
  const view = await pick(user, 'Brand guide');
  const { panel, editor } = await editPanel(user, view, 'Brand guide');
  const save = panel.getByRole('button', { name: 'Save as revision 4' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await user.click(save);
  await user.type(editor, 'More.');
  expect(editor.value).toBe(`${brandText}More.`);
  expect(save.disabled).toBe(false);
  expect(changedLines(panel)).toEqual(['Line 5 added: More.']);
  // Typing undone, the text is the revision's again.
  await user.type(editor, '{Backspace>5/}');
  expect(editor.value).toBe(brandText);
  expect(save.disabled).toBe(true);
  expect(whatChanged(panel).getByText('Nothing changed yet.')).toBeTruthy();
  await user.click(save);
  expect(posted()).toEqual([]);
});

test('Cancel sends nothing and drops the edit, and Edit again shows the newest text', async () => {
  const user = userEvent.setup();
  controller.libraryTexts = { 'lib-brand/3': brandText };
  open();
  const view = await pick(user, 'Brand guide');
  let { panel, editor } = await editPanel(user, view, 'Brand guide');
  await user.clear(editor);
  await user.paste(brandEdited);
  await user.click(panel.getByRole('button', { name: 'Cancel' }));
  expect(view.queryByRole('region', { name: 'Edit Brand guide' })).toBeNull();
  expect(posted()).toEqual([]);
  expect(revisionRows(view)).toEqual(['Revision 3', 'Revision 2', 'Revision 1']);
  ({ panel, editor } = await editPanel(user, view, 'Brand guide'));
  expect(editor.value).toBe(brandText);
  expect(whatChanged(panel).getByText('Nothing changed yet.')).toBeTruthy();
  expect((panel.getByRole('button', { name: 'Save as revision 4' }) as HTMLButtonElement).disabled).toBe(true);
  // Edit again closes it, as the other panels do.
  await user.click(view.getByRole('button', { name: 'Edit' }));
  expect(view.queryByRole('region', { name: 'Edit Brand guide' })).toBeNull();
  expect(posted()).toEqual([]);
});

test('the Edit panel says work already done keeps the revision it read and later work receives the new one', async () => {
  const user = userEvent.setup();
  controller.libraryTexts = { 'lib-brand/3': brandText };
  open();
  const view = await pick(user, 'Brand guide');
  const { panel } = await editPanel(user, view, 'Brand guide');
  expect(
    panel.getByText(
      'Saved, the edit becomes revision 4. Work already done keeps the revision it read, and work that starts afterwards receives the new one.',
    ),
  ).toBeTruthy();
});

test("a refused edit shows the controller's reason in the panel and keeps the edit, and a change clears it", async () => {
  const user = userEvent.setup();
  controller.libraryTexts = { 'lib-brand/3': brandText };
  controller.command = refused('That file is the same as the newest revision.');
  open();
  const view = await pick(user, 'Brand guide');
  const { panel, editor } = await editPanel(user, view, 'Brand guide');
  await user.clear(editor);
  await user.paste(brandEdited);
  const before = libraryReads();
  await user.click(panel.getByRole('button', { name: 'Save as revision 4' }));
  expect((await panel.findByRole('alert')).textContent).toBe('That file is the same as the newest revision.');
  // The panel stays open with the edit, and the library is read again.
  expect(view.getByRole('region', { name: 'Edit Brand guide' })).toBeTruthy();
  expect(editor.value).toBe(brandEdited);
  await waitFor(() => expect(libraryReads()).toBe(before + 1));
  expect(revisionRows(view)).toEqual(['Revision 3', 'Revision 2', 'Revision 1']);
  await user.type(editor, '!');
  expect(panel.queryByRole('alert')).toBeNull();
  expect(posted()).toHaveLength(1);
});

test('a revision that cannot be read shows why in the panel, and there is nothing to save', async () => {
  const user = userEvent.setup();
  open();
  const view = await pick(user, 'Brand guide');
  // The panel's reader says it first; Edit then asks for the revision again.
  expect(await view.findByText(/^It cannot be shown here:/)).toBeTruthy();
  await user.click(view.getByRole('button', { name: 'Edit' }));
  const panel = within(view.getByRole('region', { name: 'Edit Brand guide' }));
  expect((await panel.findByRole('alert')).textContent).toBe(
    'Revision 3 could not be read: Library revision not found.',
  );
  expect(panel.queryByLabelText('Text')).toBeNull();
  expect((panel.getByRole('button', { name: 'Save as revision 4' }) as HTMLButtonElement).disabled).toBe(true);
  expect(posted()).toEqual([]);
});

test('an edit of a file written with Windows line endings is saved with them', async () => {
  const user = userEvent.setup();
  controller.libraryTexts = { 'lib-brand/3': brandText.replace(/\n/g, '\r\n') };
  open();
  const view = await pick(user, 'Brand guide');
  const { panel, editor } = await editPanel(user, view, 'Brand guide');
  expect(whatChanged(panel).getByText('Nothing changed yet.')).toBeTruthy();
  // A textarea reads its line breaks as \n.
  await user.clear(editor);
  await user.paste(brandText);
  expect(whatChanged(panel).getByText('Nothing changed yet.')).toBeTruthy();
  expect((panel.getByRole('button', { name: 'Save as revision 4' }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(editor);
  await user.paste(brandEdited);
  expect(changedLines(panel)).toEqual(['Line 3 removed: - Use blue.', 'Line 3 added: - Use deep blue — #1d4ed8.']);
  await user.click(panel.getByRole('button', { name: 'Save as revision 4' }));
  expect(await screen.findByText('Saved revision 4 of Brand guide.')).toBeTruthy();
  expect((posted()[0]!.body as { file: { data: string } }).file.data).toBe(base64(brandEdited.replace(/\n/g, '\r\n')));
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
  expect(screen.getByRole('complementary', { name: 'Brand guide' })).toBeTruthy();
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
  expect(screen.getByRole('complementary', { name: 'Brand guide' })).toBeTruthy();
  // Confirmed, it is sent, the view closes and the library read again no longer shows the card.
  await user.click(view.getByRole('button', { name: 'Remove from the library' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Brand guide' })).toBeNull());
  expect(posted()).toEqual([{ url: `${entryUrl}/remove`, method: 'POST', body: { projectId: 'project-x' } }]);
  expect(screen.queryByRole('complementary', { name: 'Brand guide' })).toBeNull();
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
  expect(screen.getByRole('complementary', { name: 'Brand guide' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Brand guide' })).toBeTruthy();
  expect(posted()).toHaveLength(1);
});
