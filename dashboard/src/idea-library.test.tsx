// The library on Today's New idea box (1.2 step 6): how many of the project's current library files go with a new
// idea's work, Leave some out with a checkbox for each of them, and the entries the director left out sent with the
// idea, so its first step already does without them.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { LibraryEntry } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, type Controller } from './test-controller';

let controller: Controller;
const entry = (id: string, name: string, purpose: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  name,
  purpose,
  createdAt: '2026-10-28T09:00:00Z',
  by: { type: 'director' },
  revisions: [
    {
      revision: 1,
      file: `${id}.md`,
      mediaType: 'text/markdown',
      byteLength: 2048,
      sha256: 'a'.repeat(64),
      source: { type: 'upload' },
      at: '2026-10-28T09:00:00Z',
      by: { type: 'director' },
    },
  ],
  ...extra,
});

beforeEach(() => {
  controller = fakeController();
  // Two current entries and one removed, which later work no longer follows.
  controller.library = {
    entries: [
      entry('entry-brand', 'Brand guide', 'Colours and type every page follows'),
      entry('entry-old', 'Old palette', 'The colours before the redesign', { removedAt: '2026-10-28T10:00:00Z' }),
      entry('entry-terms', 'Glossary', 'The words the product uses'),
    ],
    proposals: [],
  };
  controller.command = url => (url === '/api/intake' ? { runId: 'run-1' } : {});
});
afterEach(() => cleanup());

const open = (path = '/p/project-x') => {
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
const box = async () =>
  within((await screen.findByRole('textbox', { name: 'New idea for Project X' })).closest('form')!);
const intake = () => controller.requests.filter(request => request.url === '/api/intake').map(request => request.body);
const leaveSomeOut = (form: Awaited<ReturnType<typeof box>>) => form.getByRole('button', { name: 'Leave some out' });
const today = (router: ReturnType<typeof open>) =>
  router.navigate({ to: '/p/$projectId', params: { projectId: 'project-x' } });

test('with two current entries and one removed, the box says two library files go with the work and lists them', async () => {
  const user = userEvent.setup();
  open();
  const form = await box();
  expect(await form.findByText('2 library files go with this work')).toBeTruthy();
  expect(leaveSomeOut(form).getAttribute('aria-expanded')).toBe('false');
  expect(form.queryByRole('checkbox')).toBeNull();
  await user.click(leaveSomeOut(form));
  expect(leaveSomeOut(form).getAttribute('aria-expanded')).toBe('true');
  // Each current entry by name, with its purpose beside it; the removed one is not offered.
  const boxes = form.getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes.map(item => item.labels?.[0]?.textContent)).toEqual(['Brand guide', 'Glossary']);
  expect(boxes.every(item => item.checked)).toBe(true);
  expect(boxes.map(item => document.getElementById(item.getAttribute('aria-describedby')!)?.textContent)).toEqual([
    'Colours and type every page follows',
    'The words the product uses',
  ]);
  expect(form.queryByText('Old palette')).toBeNull();
  expect(controller.reads()).toContain('/api/projects/project-x/library');
});

test('leaving one out changes the count and sends exactly that entry with the idea, and a send clears the choice', async () => {
  const user = userEvent.setup();
  const router = open();
  let form = await box();
  await user.type(form.getByRole('textbox'), 'Use the brand on the launch page.');
  await form.findByText('2 library files go with this work');
  await user.click(leaveSomeOut(form));
  await user.click(form.getByRole('checkbox', { name: 'Glossary' }));
  expect(form.getByText('1 library file goes with this work')).toBeTruthy();
  expect((form.getByRole('checkbox', { name: 'Glossary' }) as HTMLInputElement).checked).toBe(false);
  // The choice is part of the draft: leaving Today and coming back keeps it with the words.
  await router.navigate({ to: '/p/$projectId/board', params: { projectId: 'project-x' } });
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'New idea for Project X' })).toBeNull());
  await today(router);
  form = await box();
  expect(await form.findByText('1 library file goes with this work')).toBeTruthy();
  expect((form.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Use the brand on the launch page.');
  await user.click(form.getByRole('button', { name: 'Send to Project X' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-1'));
  expect(intake()).toEqual([
    { projectId: 'project-x', idea: 'Use the brand on the launch page.', libraryLeftOut: ['entry-terms'] },
  ]);
  // After the send every current entry goes with the next idea again.
  await today(router);
  form = await box();
  expect(await form.findByText('2 library files go with this work')).toBeTruthy();
  await user.click(leaveSomeOut(form));
  expect((form.getAllByRole('checkbox') as HTMLInputElement[]).every(item => item.checked)).toBe(true);
  expect((form.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
});

test('sending without leaving any out posts no libraryLeftOut, even after one was left out and put back', async () => {
  const user = userEvent.setup();
  const router = open();
  const form = await box();
  await user.type(form.getByRole('textbox'), 'Tighten the glossary.');
  await form.findByText('2 library files go with this work');
  await user.click(leaveSomeOut(form));
  await user.click(form.getByRole('checkbox', { name: 'Brand guide' }));
  expect(form.getByText('1 library file goes with this work')).toBeTruthy();
  await user.click(form.getByRole('checkbox', { name: 'Brand guide' }));
  expect(form.getByText('2 library files go with this work')).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Send to Project X' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-1'));
  expect(intake()).toEqual([{ projectId: 'project-x', idea: 'Tighten the glossary.' }]);
  expect(intake()[0]).not.toHaveProperty('libraryLeftOut');
});

test('leaving every entry out says none go, and sends them all', async () => {
  const user = userEvent.setup();
  const router = open();
  const form = await box();
  await user.type(form.getByRole('textbox'), 'Start the copy from scratch.');
  await form.findByText('2 library files go with this work');
  await user.click(leaveSomeOut(form));
  await user.click(form.getByRole('checkbox', { name: 'Brand guide' }));
  await user.click(form.getByRole('checkbox', { name: 'Glossary' }));
  expect(form.getByText('No library files go with this work')).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Send to Project X' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-1'));
  expect(intake()).toEqual([
    { projectId: 'project-x', idea: 'Start the copy from scratch.', libraryLeftOut: ['entry-brand', 'entry-terms'] },
  ]);
});

test.each([
  { name: 'an empty library', entries: [] },
  {
    name: 'a library whose entries were all removed',
    entries: [entry('entry-old', 'Old palette', 'Replaced', { removedAt: '2026-10-28T10:00:00Z' })],
  },
])('$name shows no line, and the idea is sent as before', async ({ entries }) => {
  const user = userEvent.setup();
  controller.library = { entries, proposals: [] };
  const router = open();
  const form = await box();
  await waitFor(() => expect(controller.reads()).toContain('/api/projects/project-x/library'));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(form.queryByText(/library files? go/)).toBeNull();
  expect(form.queryByRole('button', { name: 'Leave some out' })).toBeNull();
  await user.type(form.getByRole('textbox'), 'Plan the launch.');
  await user.click(form.getByRole('button', { name: 'Send to Project X' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-1'));
  expect(intake()).toEqual([{ projectId: 'project-x', idea: 'Plan the launch.' }]);
});

test('a library change recorded while Today is open changes the count', async () => {
  open();
  const form = await box();
  await form.findByText('2 library files go with this work');
  controller.library = {
    entries: [...controller.library.entries, entry('entry-voice', 'Voice notes', 'How the copy should sound')],
  };
  latest().emit('change', {
    version: 2,
    start: 'start-a',
    changes: [{ seq: 2, type: 'event', id: 7, kind: 'library_added', projectId: 'project-x' }],
  });
  expect(await form.findByText('3 library files go with this work')).toBeTruthy();
});
