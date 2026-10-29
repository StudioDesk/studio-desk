// The visual check as the dashboard reads it (visual-check.ts): matching each image to the review's note, the images
// by page, and the words for widths, browsers and steps, from the records alone; and the settings view, a story's
// pages, the director's saves and the recorded files as they reach the stand-in controller. Model-free; no page shows
// any of it yet.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  Refusal,
  type AttemptSummary,
  type StoryPage,
  type StoryPagesView,
  type VisualCheckRecord,
  type VisualImage,
  type VisualNote,
  type VisualTheme,
  type VisualView,
} from './api';
import { fakeController, type Controller } from './test-controller';
import {
  browserName,
  imageKey,
  imagesByPage,
  noBrowser,
  notesByImage,
  pagesTabShown,
  stepText,
  useSavePages,
  useSaveVisual,
  useStoryPages,
  useVisualNotes,
  useVisualRecord,
  useVisualView,
  widthLabel,
} from './visual-check';

const board: StoryPage = { name: 'Board', path: '/', steps: [] },
  settings: StoryPage = {
    name: 'Settings',
    path: '/settings',
    steps: [{ click: 'Visual check' }, { type: 'Edge', into: 'Browser' }, { wait: 'Saved' }],
  };
const image = (number: number, page: StoryPage, width: number, theme: VisualTheme): VisualImage => ({
  path: `visual/${String(number).padStart(2, '0')}-${page.name.toLowerCase()}-${width}-${theme}.png`,
  page: page.name,
  pagePath: page.path,
  width,
  theme,
  height: 900,
});
const record = (fields: Partial<VisualCheckRecord> = {}): VisualCheckRecord => ({
  schemaVersion: 'visual-check-v1',
  state: 'captured',
  browser: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  widths: [1440, 390],
  themes: ['light', 'dark'],
  pages: [board, settings],
  address: 'http://localhost:5173/',
  images: [],
  ...fields,
});

test("an image's own name is the same in the candidate and among the review's inputs", () => {
  expect(imageKey('visual/01-board-1440-light.png')).toBe('01-board-1440-light.png');
  expect(imageKey('../inputs/T-1/12-01-board-1440-light.png')).toBe('01-board-1440-light.png');
  expect(imageKey('..\\inputs\\T-1\\3-01-board-1440-light.png')).toBe('01-board-1440-light.png');
  // Only an input copy's number goes: an image's own number stays.
  expect(imageKey('visual/02-settings-390-dark.png')).toBe('02-settings-390-dark.png');
});

test("each image gets the review's note, given by either name, and an image the review did not describe has none", () => {
  const images = [image(1, board, 1440, 'light'), image(2, board, 390, 'light'), image(3, settings, 1440, 'dark')],
    notes: VisualNote[] = [
      { image: 'visual/01-board-1440-light.png', note: 'The board shows three columns.', verdict: 'match' },
      {
        image: '../inputs/T-1/7-03-settings-1440-dark.png',
        note: 'The dialog text is unreadable.',
        verdict: 'problem',
      },
      // A note for an image this record does not hold matches nothing.
      { image: 'visual/09-help-1440-light.png', note: 'Help.', verdict: 'match' },
    ];
  const matched = notesByImage(images, notes);
  expect(matched.get('visual/01-board-1440-light.png')).toBe(notes[0]);
  expect(matched.get('visual/03-settings-1440-dark.png')).toBe(notes[1]);
  expect(matched.has('visual/02-board-390-light.png')).toBe(false);
  expect([...matched.keys()]).toEqual(['visual/01-board-1440-light.png', 'visual/03-settings-1440-dark.png']);
  expect(notesByImage(images, []).size).toBe(0);
});

test("the images are grouped by page in the record's page order, each page's by width and then theme", () => {
  const shuffled = [
    image(8, settings, 390, 'dark'),
    image(2, board, 1440, 'dark'),
    image(3, board, 390, 'light'),
    image(5, settings, 1440, 'light'),
    image(1, board, 1440, 'light'),
    image(4, board, 390, 'dark'),
    image(7, settings, 390, 'light'),
    image(6, settings, 1440, 'dark'),
  ];
  const groups = imagesByPage(record({ images: shuffled }));
  expect(groups.map(group => [group.name, group.path])).toEqual([
    ['Board', '/'],
    ['Settings', '/settings'],
  ]);
  const shown = (index: number) => groups[index]!.images.map(item => `${item.width} ${item.theme}`);
  expect(shown(0)).toEqual(['1440 light', '1440 dark', '390 light', '390 dark']);
  expect(shown(1)).toEqual(['1440 light', '1440 dark', '390 light', '390 dark']);
  // The record's own order decides, here phone first and dark first.
  const phoneFirst = imagesByPage(record({ widths: [390, 1440], themes: ['dark', 'light'], images: shuffled }));
  expect(phoneFirst[0]!.images.map(item => `${item.width} ${item.theme}`)).toEqual([
    '390 dark',
    '390 light',
    '1440 dark',
    '1440 light',
  ]);
  // A record with no images still lists its pages, each with none.
  expect(imagesByPage(record({ state: 'not-run', reason: 'no browser found' }))).toEqual([
    { name: 'Board', path: '/', images: [] },
    { name: 'Settings', path: '/settings', images: [] },
  ]);
});

test('a width is a desktop from 600 px and a phone under it, with its pixels', () => {
  expect(widthLabel(1440)).toBe('Desktop · 1440 px');
  expect(widthLabel(390)).toBe('Phone · 390 px');
  expect(widthLabel(600)).toBe('Desktop · 600 px');
  expect(widthLabel(599)).toBe('Phone · 599 px');
});

test('a browser is named by its program, and an unknown one by its file name', () => {
  expect(browserName('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')).toBe('Microsoft Edge');
  expect(browserName('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')).toBe('Microsoft Edge');
  expect(browserName('/usr/bin/microsoft-edge')).toBe('Microsoft Edge');
  expect(browserName('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe('Google Chrome');
  expect(browserName('/usr/bin/google-chrome')).toBe('Google Chrome');
  expect(browserName('/usr/bin/chromium-browser')).toBe('Chromium');
  expect(browserName('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')).toBe('brave.exe');
});

test('each kind of step reads in words', () => {
  expect(stepText({ click: 'Save' })).toBe('Click “Save”');
  expect(stepText({ type: 'hello', into: 'Name' })).toBe('Type “hello” into “Name”');
  expect(stepText({ wait: 'Saved' })).toBe('Wait for “Saved”');
  expect(settings.steps.map(stepText)).toEqual([
    'Click “Visual check”',
    'Type “Edge” into “Browser”',
    'Wait for “Saved”',
  ]);
});

test('only a check not run because no browser was found says there is no browser', () => {
  expect(noBrowser(record({ state: 'not-run', reason: 'no browser found', browser: null }))).toBe(true);
  expect(
    noBrowser(
      record({
        state: 'not-run',
        reason: 'Name a start command under Trying a story yourself: the check starts the candidate with it.',
      }),
    ),
  ).toBe(false);
  expect(noBrowser(record({ state: 'failed', reason: 'no browser found' }))).toBe(false);
  expect(noBrowser(record())).toBe(false);
  expect(noBrowser(undefined)).toBe(false);
});

const pagesView = (fields: Partial<StoryPagesView> = {}): StoryPagesView => ({
  pages: [],
  changed: false,
  editable: true,
  reason: null,
  ...fields,
});
const visualView = (enabled: boolean): VisualView => ({
  settings: { enabled, widths: [1440, 390], themes: ['light', 'dark'], browser: null },
  browser: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  note: null,
  blocked: null,
});

test('the Pages tab shows for a story with pages, a recorded check, or pages that may change while the check is on', () => {
  expect(pagesTabShown({ pagesView: pagesView(), visualView: visualView(false), record: undefined })).toBe(false);
  // Before anything is read.
  expect(pagesTabShown({ pagesView: undefined, visualView: undefined, record: undefined })).toBe(false);
  expect(pagesTabShown({ pagesView: pagesView({ pages: [board] }), visualView: visualView(false), record: null })).toBe(
    true,
  );
  expect(pagesTabShown({ pagesView: pagesView(), visualView: visualView(false), record: record() })).toBe(true);
  expect(pagesTabShown({ pagesView: pagesView(), visualView: visualView(true), record: undefined })).toBe(true);
  // With the check on, a closed story with no pages and no record has nothing to show.
  const closed = pagesView({
    editable: false,
    reason: 'This story is closed or integrated; its pages can no longer change.',
  });
  expect(pagesTabShown({ pagesView: closed, visualView: visualView(true), record: undefined })).toBe(false);
});

let controller: Controller, client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
const pagesUrl = '/api/tasks/T-1/pages?projectId=project-x',
  viewUrl = '/api/projects/project-x/visual-check';

beforeEach(() => {
  controller = fakeController();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

test("a story's pages and the project's settings view are read from their routes, and nothing while not wanted", async () => {
  controller.pages['T-1'] = pagesView({ pages: [board, settings], changed: true });
  const { rerender, result } = renderHook(
    ({ on }: { on: boolean }) => ({
      pages: useStoryPages('project-x', 'T-1', on),
      other: useStoryPages('project-x', 'T-2', on),
      view: useVisualView('project-x', on),
    }),
    { wrapper, initialProps: { on: false } },
  );
  expect(controller.requests).toEqual([]);
  rerender({ on: true });
  await waitFor(() => expect(result.current.view.data).toEqual(controller.visualView));
  await waitFor(() => expect(result.current.pages.data).toEqual(controller.pages['T-1']));
  // A story the controller lists no pages for names none, and they may still change.
  await waitFor(() => expect(result.current.other.data).toEqual(pagesView()));
  expect(controller.reads().sort()).toEqual([pagesUrl, '/api/tasks/T-2/pages?projectId=project-x', viewUrl].sort());
  expect(client.getQueryData(['project-x', 'visual', 'view'])).toEqual(controller.visualView);
  expect(client.getQueryData(['project-x', 'visual', 'pages', 'T-1'])).toEqual(controller.pages['T-1']);
});

test("the director's pages are posted with only the project, and the story's pages are read again", async () => {
  const { result } = renderHook(
    () => ({ pages: useStoryPages('project-x', 'T-1'), save: useSavePages('project-x', 'T-1') }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.pages.data).toEqual(pagesView()));
  controller.command = (_url, _method, body) => {
    const { pages } = body as { pages: StoryPage[] };
    controller.pages['T-1'] = pagesView({ pages, changed: true });
    return { pages };
  };
  let answer: unknown;
  await act(async () => {
    answer = await result.current.save.mutateAsync([settings]);
  });
  expect(answer).toEqual({ pages: [settings] });
  // Read again before the answer came back.
  expect(client.getQueryData(['project-x', 'visual', 'pages', 'T-1'])).toEqual(
    pagesView({ pages: [settings], changed: true }),
  );
  expect(controller.requests).toEqual([
    { url: pagesUrl, method: 'GET' },
    { url: '/api/tasks/T-1/pages', method: 'POST', body: { projectId: 'project-x', pages: [settings] } },
    { url: pagesUrl, method: 'GET' },
  ]);
});

test("refused pages reject with the controller's message, and the story's pages are read again", async () => {
  const message = 'This story is closed or integrated; its pages can no longer change.';
  controller.command = () => {
    throw Object.assign(new Error(message), { status: 409 });
  };
  const { result } = renderHook(
    () => ({ pages: useStoryPages('project-x', 'T-1'), save: useSavePages('project-x', 'T-1') }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.pages.data).toBeDefined());
  let refused: unknown;
  await act(async () => {
    refused = await result.current.save.mutateAsync([]).catch((error: unknown) => error);
  });
  expect(refused).toBeInstanceOf(Refusal);
  expect(refused).toMatchObject({ message });
  expect(controller.reads()).toEqual([pagesUrl, pagesUrl]);
});

test('the settings are posted with only the fields the controller takes, and the view is read again', async () => {
  const { result } = renderHook(() => ({ view: useVisualView('project-x'), save: useSaveVisual('project-x') }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.view.data).toBeDefined());
  const chosen = { ...controller.visualView.settings, enabled: true, widths: [1280], themes: ['dark' as const] };
  controller.command = () => {
    controller.visualView = { ...controller.visualView, settings: chosen };
    return controller.visualView;
  };
  // A field beside the settings, such as one a page keeps for itself, is not sent.
  await act(() => result.current.save.mutateAsync({ ...chosen, extra: true } as typeof chosen));
  expect(controller.requests.filter(request => request.method === 'POST')).toEqual([
    {
      url: viewUrl,
      method: 'POST',
      body: { projectId: 'project-x', enabled: true, widths: [1280], themes: ['dark'], browser: null },
    },
  ]);
  expect(controller.reads()).toEqual([viewUrl, viewUrl]);
  expect(client.getQueryData(['project-x', 'visual', 'view'])).toMatchObject({ settings: chosen });
});

// The candidate with its recorded check and one image, and the review that read them.
const attempt = (id: string, artifacts: AttemptSummary['artifacts']): AttemptSummary => ({
  id,
  taskId: 'T-1',
  status: 'accepted',
  artifacts,
});
const captured = record({ images: [image(1, board, 1440, 'light')] });

test("the candidate's recorded check is read once, only when the attempt recorded one", async () => {
  controller.artifacts['attempt-build/visual-check.json'] = JSON.stringify(captured);
  const none = renderHook(() => useVisualRecord('project-x', attempt('attempt-old', [])), { wrapper });
  renderHook(() => useVisualRecord('project-x', undefined), { wrapper });
  const build = attempt('attempt-build', [
    { path: 'visual-check.json', hash: 'record-hash', kind: 'visual-check' },
    { path: 'visual/01-board-1440-light.png', hash: 'image-hash', kind: 'visual-capture' },
  ]);
  const { result } = renderHook(() => useVisualRecord('project-x', build), { wrapper });
  await waitFor(() => expect(result.current.data).toEqual(captured));
  expect(none.result.current.data).toBeUndefined();
  expect(controller.reads()).toEqual([
    '/api/attempts/attempt-build/artifact?projectId=project-x&path=visual-check.json',
  ]);
  expect(
    client.getQueryData(['project-x', 'visual', 'recorded', 'attempt-build', 'visual-check.json', 'record-hash']),
  ).toEqual(captured);
});

test("the review's notes are its report's visual entries, and none when it has none", async () => {
  const notes: VisualNote[] = [
    { image: '../inputs/T-1/4-01-board-1440-light.png', note: 'The board shows three columns.', verdict: 'match' },
  ];
  controller.artifacts['attempt-review/source-change-review.json'] = JSON.stringify({ verdict: 'pass', visual: notes });
  controller.artifacts['attempt-earlier/source-change-review.json'] = JSON.stringify({ verdict: 'pass' });
  const reviewed = (id: string) =>
    attempt(id, [{ path: 'source-change-review.json', hash: `${id}-hash`, kind: 'source-change-review' }]);
  const review = renderHook(() => useVisualNotes('project-x', reviewed('attempt-review')), { wrapper }),
    earlier = renderHook(() => useVisualNotes('project-x', reviewed('attempt-earlier')), { wrapper });
  await waitFor(() => expect(review.result.current.data).toEqual(notes));
  await waitFor(() => expect(earlier.result.current.data).toEqual([]));
  expect(notesByImage(captured.images, review.result.current.data!).get('visual/01-board-1440-light.png')).toEqual(
    notes[0],
  );
});
