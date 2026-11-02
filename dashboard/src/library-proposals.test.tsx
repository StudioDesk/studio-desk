// Agents' library proposals at the top of the Artifacts page (1.2 step 6): each waiting proposal with its name, what
// it is for, the agent who proposed it, its story and whether it is a new file or a newer revision; Add to the library
// and Not now, each sent with the project alone, after which the library is read again; Read it first, which opens
// the proposed file; and a proposal the library could not take, as a plain note saying why.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LibraryEntry, LibraryProposal, ProjectArtifact } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, taskFixture, type Controller } from './test-controller';

let controller: Controller;
const entry = (id: string, name: string, purpose: string): LibraryEntry => ({
  id,
  name,
  purpose,
  createdAt: '2026-10-28T12:00:00Z',
  by: { type: 'director' },
  revisions: [
    {
      revision: 1,
      file: `${id}-r1.md`,
      mediaType: 'text/markdown',
      byteLength: 512,
      sha256: `sha-${id}`,
      source: { type: 'upload' },
      at: '2026-10-28T12:00:00Z',
      by: { type: 'director' },
    },
  ],
});
const file = (taskId: string, title: string, path: string): ProjectArtifact => ({
  taskId,
  title,
  attemptId: `attempt-${taskId}`,
  workerId: 'W-1',
  runId: null,
  kind: 'work-file',
  path,
  hash: `hash-${taskId}`,
  acceptedAt: '2026-10-28T11:00:00Z',
});
const proposal = (
  id: string,
  name: string,
  purpose: string,
  taskId: string,
  path: string,
  extra: Partial<LibraryProposal> = {},
): LibraryProposal => ({
  id,
  name,
  purpose,
  path,
  from: { taskId, attemptId: `attempt-${taskId}`, path },
  proposedBy: 'W-1',
  at: '2026-10-28T11:30:00Z',
  state: 'waiting',
  ...extra,
});
const decided = { decidedAt: '2026-10-28T11:45:00Z', decidedBy: { type: 'director' } };
const problem = 'A library file is at most 5 MiB.';

beforeEach(() => {
  controller = fakeController();
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-3', displayName: 'Sage', team: 'Writing' },
  ];
  // One story's file is in the accepted listing; the other story, still in the live set, is named from the project's
  // records.
  controller.projectArtifacts = [file('T-1', 'Write the launch copy', 'copy/launch.md')];
  controller.tasks = [taskFixture('T-2', { title: 'Draft the brand guide', status: 'review' })];
  controller.library = {
    entries: [entry('lib-copy', 'Launch copy', 'The words the launch page says.')],
    proposals: [
      proposal('libprop-voice', 'Voice notes', 'How the copy should sound.', 'T-1', 'copy/voice notes.md', {
        proposedBy: 'W-3',
      }),
      proposal('libprop-copy', 'Launch copy, second draft', 'The words after review.', 'T-2', 'copy/launch.md', {
        entryId: 'lib-copy',
      }),
      proposal('libprop-added', 'Brand guide', 'The colours every page uses.', 'T-2', 'brand.md', {
        state: 'approved',
        entryId: 'lib-brand',
        ...decided,
      }),
      proposal('libprop-left', 'Scratch notes', 'Notes from the draft.', 'T-2', 'scratch.md', {
        state: 'rejected',
        ...decided,
      }),
      proposal('libprop-video', 'Launch video', 'The video on the launch page.', 'T-1', 'launch.mp4', {
        state: 'refused',
        problem,
        ...decided,
      }),
    ],
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
const libraryRead = '/api/projects/project-x/library';
const libraryReads = () => controller.reads().filter(url => url === libraryRead).length;
const card = async (name: string) => within(await screen.findByRole('article', { name }));
const decisionUrl = (id: string, choice: string) => `/api/projects/project-x/library/proposals/${id}/${choice}`;
// What the controller answers a decision with, after recording it in the library it serves.
const records =
  (id: string, outcome: Partial<LibraryProposal>, entries: LibraryEntry[] = controller.library.entries) =>
  () => {
    const proposals = controller.library.proposals!.map(item =>
      item.id === id ? { ...item, ...decided, ...outcome } : item,
    );
    controller.library = { entries, proposals };
    return proposals.find(item => item.id === id);
  };

test('a waiting proposal shows its name, purpose, agent and story, and whether it is a new file or a revision', async () => {
  open();
  const region = within(await screen.findByRole('region', { name: 'Proposed for the library' }));
  expect(region.getByText('2 waiting on you')).toBeTruthy();
  const voice = await card('Voice notes');
  expect(voice.getByText('How the copy should sound.')).toBeTruthy();
  expect(voice.getByText('Proposed by Sage')).toBeTruthy();
  expect(voice.getByText('A new library file')).toBeTruthy();
  // The story's title from the accepted files, linking to the story.
  expect(voice.getByRole('link', { name: 'Write the launch copy' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-1',
  );
  const copy = await card('Launch copy, second draft');
  expect(copy.getByText('The words after review.')).toBeTruthy();
  expect(copy.getByText('Proposed by Eli')).toBeTruthy();
  // A revision names the entry it revises, and a story with no accepted file listed is named from the records.
  expect(copy.getByText('A newer revision of Launch copy')).toBeTruthy();
  expect(await copy.findByRole('link', { name: 'Draft the brand guide' })).toBeTruthy();
  // Each has the director's three choices, and the proposals sit above the library.
  for (const proposed of [voice, copy]) {
    expect(proposed.getByRole('button', { name: 'Add to the library' })).toBeTruthy();
    expect(proposed.getByRole('link', { name: 'Read it first' })).toBeTruthy();
    expect(proposed.getByRole('button', { name: 'Not now' })).toBeTruthy();
  }
  const library = await screen.findByRole('region', { name: 'Library' });
  expect(
    screen.getByRole('region', { name: 'Proposed for the library' }).compareDocumentPosition(library) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test('Read it first opens the proposed file in a new tab', async () => {
  open();
  const link = (await card('Voice notes')).getByRole('link', { name: 'Read it first' });
  expect(link.getAttribute('href')).toBe(
    '/api/attempts/attempt-T-1/artifact?projectId=project-x&path=copy%2Fvoice%20notes.md',
  );
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');
});

test('Add to the library sends the approval with the project alone, and the proposal leaves for its new card', async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url === decisionUrl('libprop-voice', 'approve')
      ? records('libprop-voice', { state: 'approved', entryId: 'lib-voice' }, [
          ...controller.library.entries,
          entry('lib-voice', 'Voice notes', 'How the copy should sound.'),
        ])()
      : {};
  open();
  const voice = await card('Voice notes');
  await user.click(voice.getByRole('button', { name: 'Add to the library' }));
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Voice notes' })).toBeNull());
  expect(posted()).toEqual([
    { url: decisionUrl('libprop-voice', 'approve'), method: 'POST', body: { projectId: 'project-x' } },
  ]);
  expect(screen.getByText('Added Voice notes to the library.')).toBeTruthy();
  // The library read again shows the entry the approval made, and the other proposal still waits.
  expect(await screen.findByRole('button', { name: 'Voice notes' })).toBeTruthy();
  expect(screen.getByRole('article', { name: 'Launch copy, second draft' })).toBeTruthy();
  expect(screen.getByText('1 waiting on you')).toBeTruthy();
});

test('Not now sends the rejection with the project alone, and the proposal leaves with nothing added', async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url === decisionUrl('libprop-copy', 'reject') ? records('libprop-copy', { state: 'rejected' })() : {};
  open();
  const copy = await card('Launch copy, second draft');
  const reads = libraryReads();
  await user.click(copy.getByRole('button', { name: 'Not now' }));
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Launch copy, second draft' })).toBeNull());
  expect(posted()).toEqual([
    { url: decisionUrl('libprop-copy', 'reject'), method: 'POST', body: { projectId: 'project-x' } },
  ]);
  expect(libraryReads()).toBe(reads + 1);
  expect(screen.getByText('Not now: Launch copy, second draft stays out of the library.')).toBeTruthy();
  expect(
    within(screen.getByRole('list', { name: 'Library files' }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('button > span')?.textContent),
  ).toEqual(['Launch copy']);
  expect(screen.getByRole('article', { name: 'Voice notes' })).toBeTruthy();
});

// A proposal the library could not take reads as a plain note: no alert and nothing in the error color.
const plainNote = (list: HTMLElement) => {
  expect(within(list).queryByRole('alert')).toBeNull();
  expect(list.closest('[role="alert"]')).toBeNull();
  expect(list.outerHTML).not.toContain('--bad');
};

test('approved and rejected proposals are not waiting, and one the library could not take reads as a plain note saying why, once', async () => {
  open();
  await card('Voice notes');
  expect(screen.queryByRole('article', { name: 'Brand guide' })).toBeNull();
  expect(screen.queryByRole('article', { name: 'Scratch notes' })).toBeNull();
  expect(screen.queryByText('Scratch notes')).toBeNull();
  expect(screen.queryByRole('article', { name: 'Launch video' })).toBeNull();
  const list = screen.getByRole('list', { name: 'Proposals the library could not take' }),
    refused = within(list);
  expect(refused.getAllByRole('listitem')).toHaveLength(1);
  // Its name and that the library could not take it, then its problem in the controller's words.
  expect(refused.getAllByRole('listitem')[0]!.textContent).toBe(`The library could not take Launch video. ${problem}`);
  expect(refused.getByText(problem).closest('.sd-meta')).toBeTruthy();
  plainNote(list);
  // Nothing is left to decide for it, and the note is said once on the page.
  expect(refused.queryByRole('button')).toBeNull();
  expect(screen.getAllByText('The library could not take Launch video.')).toHaveLength(1);
  expect(screen.getAllByText(problem)).toHaveLength(1);
});

test('a proposal the library could not take with no problem recorded says the library gave no reason', async () => {
  controller.library = {
    entries: [],
    proposals: [
      proposal('libprop-video', 'Launch video', 'The video on the launch page.', 'T-1', 'launch.mp4', {
        state: 'refused',
        ...decided,
      }),
    ],
  };
  open();
  const list = await screen.findByRole('list', { name: 'Proposals the library could not take' });
  expect(list.textContent).toBe('The library could not take Launch video. The library gave no reason.');
  plainNote(list);
  // Nothing waits, so the section says nothing of waiting.
  expect(screen.queryByText(/waiting on you/)).toBeNull();
});

test('an approval the library cannot take moves the proposal to a plain note saying why, said once', async () => {
  const user = userEvent.setup();
  const tooBig = 'The library holds at most 20 files.';
  controller.command = url =>
    url === decisionUrl('libprop-voice', 'approve')
      ? records('libprop-voice', { state: 'refused', problem: tooBig })()
      : {};
  open();
  await user.click((await card('Voice notes')).getByRole('button', { name: 'Add to the library' }));
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Voice notes' })).toBeNull());
  const list = screen.getByRole('list', { name: 'Proposals the library could not take' }),
    refused = within(list);
  expect(refused.getAllByRole('listitem').map(item => item.textContent)).toEqual([
    `The library could not take Voice notes. ${tooBig}`,
    `The library could not take Launch video. ${problem}`,
  ]);
  plainNote(list);
  expect(screen.getAllByText(tooBig)).toHaveLength(1);
  // The toast says the same, and the note stays once it goes.
  expect(screen.getByText('The library could not take Voice notes.', { selector: '.sd-toast' })).toBeTruthy();
  expect(refused.getAllByText('The library could not take Voice notes.')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Voice notes' })).toBeNull();
});

test('a decision the controller refuses shows its reason, and the library is read again', async () => {
  const user = userEvent.setup();
  controller.command = url => {
    if (url !== decisionUrl('libprop-voice', 'reject')) return {};
    // Decided elsewhere first, as the library now says.
    records('libprop-voice', { state: 'approved', entryId: 'lib-voice' })();
    throw Object.assign(new Error('This proposal was already approved.'), { status: 409 });
  };
  open();
  const voice = await card('Voice notes');
  const reads = libraryReads();
  await user.click(voice.getByRole('button', { name: 'Not now' }));
  expect(await screen.findByText('This proposal was already approved.')).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Voice notes' })).toBeNull());
  expect(libraryReads()).toBe(reads + 1);
});

test('a proposal recorded while the page is open joins the waiting ones when the controller records it', async () => {
  controller.library = { entries: [], proposals: [] };
  open();
  await screen.findByText('The library is empty.');
  expect(screen.queryByRole('region', { name: 'Proposed for the library' })).toBeNull();
  controller.library = {
    entries: [],
    proposals: [proposal('libprop-new', 'Style sheet', 'The rules for every page.', 'T-1', 'style.md')],
  };
  latest().emit('change', {
    version: 2,
    start: 'start-a',
    changes: [{ seq: 2, type: 'event', id: 9, kind: 'library_proposed', projectId: 'project-x' }],
  });
  const style = await card('Style sheet');
  expect(style.getByText('The rules for every page.')).toBeTruthy();
  expect(screen.getByText('1 waiting on you')).toBeTruthy();
});
