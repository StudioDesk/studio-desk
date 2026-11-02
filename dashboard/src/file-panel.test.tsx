// Model-free reads through the stand-in controller: the picked file stays on the page, unsupported kinds read
// nothing, and each comparison reads its own two versions only when opened.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { libraryRevisionUrl, type WorkFile, type WorkVersion } from './api';
import { workRows, type WorkRow } from './artifacts';
import { FilePanel } from './file-panel';
import { artifactUrl, FileBody } from './files';
import { fakeController, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller;
const projectId = 'project-x';
const version = (n: number, extra: Partial<WorkVersion> = {}): WorkVersion => ({
  n,
  attemptId: `attempt-${n}`,
  workerId: 'W-1',
  hash: `hash-${n}`,
  at: `2026-10-2${n}T12:00:00Z`,
  current: n === 3,
  why: null,
  ...extra,
});
const rowFor = (path: string, extra: Partial<WorkFile> = {}): WorkRow =>
  workRows(
    [
      {
        taskId: 'T-menu',
        title: 'Write the menu',
        runId: 'run-menu',
        path,
        kind: 'work-file',
        hash: 'accepted-hash',
        attemptId: 'accepted-attempt',
        workerId: 'W-1',
        acceptedAt: '2026-10-23T12:00:00Z',
        libraryEntryId: null,
        versions: [version(3)],
        ...extra,
      },
    ],
    { ...controller.shell, runs: [{ id: 'run-menu', brief: 'A menu card with six drinks' }] },
  )[0]!;

beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(row: WorkRow, onAdd = vi.fn(), onClose?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const panel = (picked: WorkRow, close = onClose) => (
    <QueryClientProvider client={client}>
      <FilePanel projectId={projectId} row={picked} onAdd={onAdd} {...(close ? { onClose: close } : {})} />
    </QueryClientProvider>
  );
  const view = render(panel(row));
  return { onAdd, rerender: (picked: WorkRow, close?: () => void) => view.rerender(panel(picked, close)) };
}
const reads = () => controller.reads().filter(url => url.startsWith('/api/attempts/'));

test('Markdown reads as a page under the file name, kind, agent, idea and date without opening or downloading it', async () => {
  const row = rowFor('copy/menu-card.md');
  controller.artifacts['attempt-3/copy/menu-card.md'] = '# The menu\n\n## Coffee\n\nSix drinks, made here.\n';
  open(row);
  const panel = within(screen.getByRole('complementary', { name: 'Menu card' }));
  expect(panel.getByRole('heading', { name: 'Menu card', level: 2 })).toBeTruthy();
  expect(panel.getByText('Document')).toBeTruthy();
  const line = panel.getByText(/A menu card with six drinks/);
  expect(line.textContent).toContain('Eli');
  expect(line.textContent).toContain('A menu card with six drinks');
  expect(line.textContent).toContain(when('2026-10-23T12:00:00Z'));
  expect(panel.getByText('MD').closest('[aria-hidden="true"]')).toBeTruthy();
  const heading = await panel.findByRole('heading', { name: 'The menu', level: 1 });
  expect(heading.closest('.sd-reader__text')).toBeTruthy();
  expect(panel.getByRole('heading', { name: 'Coffee', level: 2 })).toBeTruthy();
  expect(panel.getByText('Six drinks, made here.')).toBeTruthy();
  expect(panel.queryByRole('link', { name: /^Open/ })).toBeNull();
  // Download remains an explicit action; rendering the page only reads its newest version once.
  const download = panel.getByRole('link', { name: 'Download' });
  expect(download.hasAttribute('download')).toBe(true);
  expect(download.getAttribute('href')).toBe(artifactUrl(projectId, 'attempt-3', row.file.path));
  expect(reads()).toEqual([artifactUrl(projectId, 'attempt-3', row.file.path)]);
  expect(controller.requests.every(request => request.method === 'GET')).toBe(true);
});

test('when an idea is unavailable, the panel names the recorded step instead', async () => {
  const row = rowFor('notes.txt', { runId: null });
  controller.artifacts['attempt-3/notes.txt'] = 'The notes';
  open(row);
  expect(screen.getByText(/Write the menu/).textContent).toContain('Eli');
  expect(await screen.findByText('The notes')).toBeTruthy();
});

test.each([
  ['notes.txt', '# These are plain notes\n<em>Kept as text</em>'],
  ['menu.json', '{"drinks":6,"text":"<b>Kept as text</b>"}'],
  ['menu.ts', 'export const drinks = 6;\n// <b>Kept as text</b>'],
])('%s reads as inert text', async (path, text) => {
  controller.artifacts[`attempt-3/${path}`] = text;
  open(rowFor(path));
  const plain = await screen.findByText(content => content.includes('Kept as text'), { selector: 'pre' });
  expect(plain.textContent).toContain('Kept as text');
  expect(plain.querySelector('em, b')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'These are plain notes' })).toBeNull();
  expect(reads()).toEqual([artifactUrl(projectId, 'attempt-3', path)]);
});

test('CSV reads as a table with its quoted cells', async () => {
  const path = 'menu.csv';
  controller.artifacts[`attempt-3/${path}`] = 'Drink,Description\nEspresso,"Small, strong"\nLatte,Milky\n';
  open(rowFor(path));
  const table = within(await screen.findByRole('table'));
  expect(table.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Drink', 'Description']);
  expect(table.getAllByRole('cell').map(cell => cell.textContent)).toEqual([
    'Espresso',
    'Small, strong',
    'Latte',
    'Milky',
  ]);
  expect(reads()).toEqual([artifactUrl(projectId, 'attempt-3', path)]);
});

test('PNG reads as a picture, with no text comparison or reads of older pictures', async () => {
  const path = 'art/hero.png',
    url = artifactUrl(projectId, 'attempt-3', path);
  controller.artifacts[`attempt-3/${path}`] = 'PNG bytes';
  // The stand-in's ordinary routes serve text. Model binary bytes at the response boundary as pages-panel does.
  const served = globalThis.fetch;
  vi.stubGlobal('fetch', async (address: string, options?: RequestInit) => {
    const response = await served(address, options);
    return address === url
      ? { ...response, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer }
      : response;
  });
  open(rowFor(path, { versions: [version(3), version(1)] }));
  const image = await screen.findByRole('img', { name: path });
  expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(screen.getByText('Image')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /What changed/ })).toBeNull();
  expect(reads()).toEqual([url]);
});

test.each(['brief.pdf', 'brief.docx', 'archive.zip'])(
  '%s reads nothing and offers Download on the newest version',
  path => {
    const row = rowFor(path, { versions: [version(1), version(3), version(2)] });
    open(row);
    expect(screen.getByText(/This file can't be shown here/)).toBeTruthy();
    const download = screen.getByRole('link', { name: 'Download' });
    expect(download.hasAttribute('download')).toBe(true);
    expect(download.getAttribute('href')).toBe(artifactUrl(projectId, 'attempt-3', path));
    expect(download.getAttribute('target')).toBeNull();
    expect(screen.queryByRole('button', { name: /What changed/ })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(reads()).toEqual([]);
  },
);

test('three versions list newest first with when and why, and What changed compares version 2 against version 1', async () => {
  const user = userEvent.setup(),
    path = 'copy/menu-card.md',
    row = rowFor(path, { versions: [version(2), version(1), version(3, { why: 'Make it shorter.' })] });
  controller.artifacts[`attempt-1/${path}`] = '# Menu\nOld description\nKeep this\n';
  controller.artifacts[`attempt-2/${path}`] = '# Menu\nNew description\nKeep this\nOne more drink\n';
  controller.artifacts[`attempt-3/${path}`] = '# Menu\nNew description\n';
  open(row);
  await screen.findByRole('heading', { name: 'Menu', level: 1 });
  const versions = within(screen.getByRole('list', { name: `Versions of ${path}` })).getAllByRole('listitem');
  expect(versions.map(item => within(item).getByText(/^Version \d$/).textContent)).toEqual([
    'Version 3',
    'Version 2',
    'Version 1',
  ]);
  const [third, second, first] = versions.map(item => within(item));
  expect(third!.getByText('Make it shorter.')).toBeTruthy();
  expect(second!.getByText('Nothing was recorded about why it was made.')).toBeTruthy();
  expect(first!.getByText('The first version')).toBeTruthy();
  for (const [index, n] of [3, 2, 1].entries()) {
    expect(
      within(versions[index]!)
        .getByText(when(version(n).at))
        .getAttribute('datetime'),
    ).toBe(version(n).at);
  }
  expect(first!.queryByRole('button', { name: /What changed/ })).toBeNull();
  expect(reads()).toEqual([artifactUrl(projectId, 'attempt-3', path)]);

  const changed = second!.getByRole('button', { name: 'What changed in version 2' });
  expect(changed.getAttribute('aria-expanded')).toBe('false');
  await user.click(changed);
  expect(changed.getAttribute('aria-expanded')).toBe('true');
  const lines = await second!.findByRole('list', { name: 'Lines added and removed in version 2' });
  expect(second!.getByText('Against version 1: 2 lines added, 1 line removed')).toBeTruthy();
  expect(
    within(lines)
      .getAllByRole('listitem')
      .map(line => line.getAttribute('aria-label')),
  ).toEqual(['Line 2 removed: Old description', 'Line 2 added: New description', 'Line 4 added: One more drink']);
  expect(lines.closest('.sd-code--wrap')).toBeTruthy();
  await user.click(third!.getByRole('button', { name: 'What changed in version 3' }));
  expect(await third!.findByText('Against version 2: 0 lines added, 2 lines removed')).toBeTruthy();
  // The body and comparisons share each immutable text source's cache identity.
  expect(reads().sort()).toEqual([1, 2, 3].map(n => artifactUrl(projectId, `attempt-${n}`, path)).sort());
  await user.click(changed);
  expect(second!.queryByRole('list')).toBeNull();
  expect(row.file.versions.map(item => item.n)).toEqual([2, 1, 3]);
});

test('Add to the library calls the page callback, and a library file shows its chip instead', async () => {
  const user = userEvent.setup(),
    row = rowFor('brief.pdf'),
    view = open(row);
  await user.click(screen.getByRole('button', { name: 'Add to the library' }));
  expect(view.onAdd).toHaveBeenCalledExactlyOnceWith(row);
  expect(controller.requests).toEqual([]);
  view.rerender({ ...row, file: { ...row.file, libraryEntryId: 'lib-brief' } });
  expect(screen.getByText('In the library').classList.contains('sd-chip')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Add to the library' })).toBeNull();
});

test('a logical layout keeps its existing preview without mixing picture data into the JSON comparison', async () => {
  const user = userEvent.setup(),
    path = 'rooms/layout.json';
  controller.artifacts[`attempt-1/${path}`] = '{"rooms":[{"id":"entry","position":[0,0,0]}],"links":[]}\n';
  controller.artifacts[`attempt-2/${path}`] = '{"rooms":[{"id":"entry","position":[1,0,0]}],"links":[]}\n';
  open(rowFor(path, { versions: [version(2), version(1)] }));
  expect(await screen.findByRole('img', { name: 'Logical room layout' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'What changed in version 2' }));
  expect(await screen.findByText('Against version 1: 1 line added, 1 line removed')).toBeTruthy();
});

test('Close appears only when supplied and calls the page callback', async () => {
  const user = userEvent.setup(),
    row = rowFor('brief.pdf'),
    onClose = vi.fn(),
    view = open(row);
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  view.rerender(row, onClose);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a file without version records reads and downloads the accepted file', async () => {
  const row = rowFor('notes.txt', { versions: [] });
  controller.artifacts['accepted-attempt/notes.txt'] = 'Accepted notes';
  open(row);
  expect(await screen.findByText('Accepted notes')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(
    artifactUrl(projectId, 'accepted-attempt', 'notes.txt'),
  );
  expect(screen.queryByRole('list', { name: /Versions of/ })).toBeNull();
});

test('FileBody reads another URL and reuses only the supplied immutable cache key', async () => {
  const url = libraryRevisionUrl(projectId, 'lib-menu', 1),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  controller.libraryTexts['lib-menu/1'] = '# Original menu\n';
  const body = (hash: string) => (
    <QueryClientProvider client={client}>
      <FileBody url={url} queryKey={['library', 'lib-menu', 1, hash]} item={{ path: 'menu.md', hash }} />
    </QueryClientProvider>
  );
  const view = render(body('first'));
  await screen.findByRole('heading', { name: 'Original menu' });
  view.unmount();
  controller.libraryTexts['lib-menu/1'] = '# Changed menu\n';
  const again = render(body('first'));
  expect(screen.getByRole('heading', { name: 'Original menu' })).toBeTruthy();
  expect(controller.reads()).toEqual([url]);
  again.rerender(body('second'));
  expect(await screen.findByRole('heading', { name: 'Changed menu' })).toBeTruthy();
  expect(controller.reads()).toEqual([url, url]);
});
