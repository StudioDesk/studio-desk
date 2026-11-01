// Browser-local preview choices, exercised through the real page and a model-free controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = () => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/settings/previews'] }));
  render(
    <App
      router={router}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
  return router;
};
const commands = () => controller.requests.filter(request => request.method !== 'GET');
const chatBox = () => screen.findByRole('switch', { name: 'The chat box (preview)' });

test('Previews explains its browser-local unfinished features and lists only the chat box switch', async () => {
  open();
  const main = within(await screen.findByRole('main'));
  expect(await main.findByRole('heading', { level: 1, name: 'Previews' })).toBeTruthy();
  expect(
    main.getByText('These features work but are not finished, and your choices are kept in this browser.'),
  ).toBeTruthy();
  expect(
    main.getByText(
      'With it on, New idea opens a chat box beside the page; with it off, New idea works as it always has.',
    ),
  ).toBeTruthy();
  expect(main.getAllByRole('switch')).toHaveLength(1);
  expect(main.getByRole('switch', { name: 'The chat box (preview)' }).getAttribute('aria-checked')).toBe('false');
  expect(commands()).toEqual([]);
});

test('the chat box starts off, switches on and off immediately, and keeps the choice when Previews reopens', async () => {
  const user = userEvent.setup();
  open();
  const toggle = await chatBox();
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(localStorage.getItem('studio-chat-box')).toBeNull();
  await user.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(localStorage.getItem('studio-chat-box')).toBe('on');
  await user.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(localStorage.getItem('studio-chat-box')).toBeNull();
  await user.click(toggle);
  cleanup();
  open();
  expect((await chatBox()).getAttribute('aria-checked')).toBe('true');
  expect(localStorage.getItem('studio-chat-box')).toBe('on');
  expect(commands()).toEqual([]);
});

test('a choice saved before the move loads on without resetting or rewriting the existing preference', async () => {
  localStorage.setItem('studio-chat-box', 'on');
  const save = vi.spyOn(Storage.prototype, 'setItem'),
    remove = vi.spyOn(Storage.prototype, 'removeItem'),
    clear = vi.spyOn(Storage.prototype, 'clear');
  open();
  expect((await chatBox()).getAttribute('aria-checked')).toBe('true');
  expect(localStorage.getItem('studio-chat-box')).toBe('on');
  expect(save.mock.calls.filter(([key]) => key === 'studio-chat-box')).toEqual([]);
  expect(remove.mock.calls.filter(([key]) => key === 'studio-chat-box')).toEqual([]);
  expect(clear).not.toHaveBeenCalled();
  expect(commands()).toEqual([]);
});

test('Previews follows another tab changing the preference or clearing storage without a reload', async () => {
  open();
  const toggle = await chatBox();
  localStorage.setItem('studio-chat-box', 'on');
  fireEvent(window, new StorageEvent('storage', { key: 'studio-chat-box', newValue: 'on' }));
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  localStorage.removeItem('studio-chat-box');
  fireEvent(window, new StorageEvent('storage', { key: 'studio-chat-box', newValue: null }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  localStorage.setItem('studio-chat-box', 'on');
  fireEvent(window, new StorageEvent('storage', { key: 'studio-chat-box', newValue: 'on' }));
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  localStorage.clear();
  fireEvent(window, new StorageEvent('storage', { key: null }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(commands()).toEqual([]);
});

test('Tab reaches the named switch, and Space and Enter toggle its accessible state and saved choice', async () => {
  const user = userEvent.setup();
  open();
  const toggle = await chatBox();
  // The Settings trail is the preceding control on this page.
  within(screen.getByRole('navigation', { name: 'You are here' }))
    .getByRole('link', { name: 'Settings' })
    .focus();
  await user.tab();
  expect(document.activeElement).toBe(toggle);
  await user.keyboard(' ');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(localStorage.getItem('studio-chat-box')).toBe('on');
  await user.keyboard('{Enter}');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(localStorage.getItem('studio-chat-box')).toBeNull();
  expect(document.activeElement).toBe(toggle);
  expect(commands()).toEqual([]);
});
