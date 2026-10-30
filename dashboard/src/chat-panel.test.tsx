// The chat box (a preview behind its switch, chat-box.ts): New idea and Ctrl J open it docked beside any page of the
// project; it stays open with its words as the director moves between pages, holds Today's New idea box and sends what
// Today's box sends, and on a phone it covers the page with a back arrow. Model-free, with the stand-in controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { chatBoxKey } from './chat-box';
import { drafts } from './idea-composer';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  localStorage.clear();
  localStorage.setItem(chatBoxKey, 'on');
  // Drafts stay in memory for the page's life, so each test starts with empty boxes.
  drafts.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path: string) => {
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
const panel = () => screen.findByRole('complementary', { name: 'The chat box' });
const shut = () => screen.queryByRole('complementary', { name: 'The chat box' });
const box = (region: HTMLElement) => within(region).findByRole('textbox', { name: 'New idea for Project X' });
const sidebarNewIdea = async () => (await screen.findAllByRole('button', { name: 'New idea' }))[0]!;
const posted = () => controller.requests.filter(request => request.method === 'POST');

test('New idea opens the chat box beside the board, which stays where it is', async () => {
  const router = open('/p/project-x/board');
  fireEvent.click(await sidebarNewIdea());
  const region = await panel();
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  const text = await box(region);
  await waitFor(() => expect(document.activeElement).toBe(text));
  // The page is still there beside it.
  expect(screen.getByRole('main')).toBeTruthy();
});

test('Ctrl J opens the chat box on another page with the cursor in its box, and puts it back there when open', async () => {
  const router = open('/p/project-x/agents');
  await screen.findByRole('navigation', { name: 'Main' });
  expect(shut()).toBeNull();
  // The key is the chat box's, not the browser's.
  expect(fireEvent.keyDown(window, { key: 'j', ctrlKey: true })).toBe(false);
  const text = await box(await panel());
  await waitFor(() => expect(document.activeElement).toBe(text));
  expect(router.history.location.pathname).toBe('/p/project-x/agents');
  // Already open, with the cursor elsewhere, Cmd J brings it back to the box.
  const search = screen.getByRole('button', { name: 'Find a project (Ctrl K)' });
  search.focus();
  expect(fireEvent.keyDown(search, { key: 'j', metaKey: true })).toBe(false);
  await waitFor(() => expect(document.activeElement).toBe(text));
  expect(screen.getAllByRole('complementary', { name: 'The chat box' })).toHaveLength(1);
});

test("Ctrl J works while typing in Today's box, and the two boxes keep their own words", async () => {
  const user = userEvent.setup();
  open('/p/project-x');
  const today = await screen.findByRole('textbox', { name: 'New idea for Project X' });
  await user.type(today, 'On Today.');
  expect(fireEvent.keyDown(today, { key: 'j', ctrlKey: true })).toBe(false);
  const text = await box(await panel());
  await waitFor(() => expect(document.activeElement).toBe(text));
  expect((text as HTMLTextAreaElement).value).toBe('');
  await user.type(text, 'In the chat box.');
  expect((today as HTMLTextAreaElement).value).toBe('On Today.');
  expect((text as HTMLTextAreaElement).value).toBe('In the chat box.');
});

test('what was typed stays in the open chat box as the director follows the sidebar to another page', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  await user.type(await box(await panel()), 'Show the runs page.');
  await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Ideas' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs'));
  expect(await screen.findByRole('heading', { level: 1, name: 'Ideas' })).toBeTruthy();
  const text = (await box(await panel())) as HTMLTextAreaElement;
  expect(text.value).toBe('Show the runs page.');
});

test('Hide closes the chat box, and N opens it again with its words', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  const region = await panel();
  await user.type(await box(region), 'Kept for later.');
  await user.click(within(region).getByRole('button', { name: 'Hide' }));
  expect(shut()).toBeNull();
  fireEvent.keyDown(window, { key: 'n' });
  const text = (await box(await panel())) as HTMLTextAreaElement;
  expect(text.value).toBe('Kept for later.');
  expect(router.history.location.pathname).toBe('/p/project-x/board');
});

test("the empty chat box holds the New idea box's controls and says where earlier talks are", async () => {
  open('/p/project-x/board');
  fireEvent.click(await sidebarNewIdea());
  const element = await panel(),
    region = within(element),
    form = within((await box(element)).closest('form')!);
  expect(form.getByRole('button', { name: 'Files' })).toBeTruthy();
  expect(form.getByRole('switch', { name: 'Auto mode' })).toBeTruthy();
  expect((form.getByRole('button', { name: 'Send to Project X' }) as HTMLButtonElement).disabled).toBe(true);
  expect(
    region.getByText('Earlier talks sit under Ideas, each with its conversation, until you make them official.'),
  ).toBeTruthy();
});

test("sending from the chat box posts what Today's box posts, then shows the queued toast and the idea's page", async () => {
  const user = userEvent.setup();
  controller.command = url => (url === '/api/intake' ? { runId: 'run-9' } : {});
  const router = open('/p/project-x/board');
  await user.click(await sidebarNewIdea());
  const region = await panel(),
    text = await box(region),
    form = within(text.closest('form')!);
  await user.type(text, 'Show the runs page.');
  await user.upload(
    text.closest('form')!.querySelector<HTMLInputElement>('input[type=file]')!,
    new File(['# Notes'], 'notes.md', { type: 'text/markdown' }),
  );
  expect(await form.findByText('notes.md')).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Send to Project X' }));
  await waitFor(() => expect(router.history.location.pathname).toBe('/p/project-x/runs/run-9'));
  // The same request as today-page.test.tsx's 'an idea and its files go to the intake as one request'.
  expect(posted()).toEqual([
    {
      url: '/api/intake',
      method: 'POST',
      body: {
        projectId: 'project-x',
        idea: 'Show the runs page.',
        files: [{ name: 'notes.md', mediaType: 'text/markdown', data: btoa('# Notes') }],
      },
    },
  ]);
  expect(
    screen.getByText(
      "Idea queued: fresh checks, then the product owner's breakdown. Proposed stories will appear in Planned for your approval.",
    ),
  ).toBeTruthy();
  // The chat box stays open, its box empty for the next idea.
  const after = (await box(await panel())) as HTMLTextAreaElement;
  expect(after.value).toBe('');
  expect(within(after.closest('form')!).queryByText('notes.md')).toBeNull();
});

test('a project whose work takes no ideas shows no box in the chat box', async () => {
  controller.shell.organizationConfiguration = { taskKinds: ['studio-development:checks'] };
  open('/p/project-x/board');
  fireEvent.click(await sidebarNewIdea());
  const region = within(await panel());
  expect(await region.findByText(/Project X takes no ideas/)).toBeTruthy();
  expect(region.queryByRole('textbox')).toBeNull();
});

test('on a phone the chat box covers the page from the middle tab, with a back arrow that closes it', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const user = userEvent.setup();
  const router = open('/p/project-x/board');
  const tabs = within(await screen.findByRole('navigation', { name: 'Pages' }));
  await user.click(tabs.getByRole('button', { name: 'New idea' }));
  const region = await panel();
  expect(router.history.location.pathname).toBe('/p/project-x/board');
  // No sheet rises over it: the chat box itself holds the box.
  expect(region.querySelector('dialog')).toBeNull();
  expect(await box(region)).toBeTruthy();
  expect(within(region).queryByRole('button', { name: 'Hide' })).toBeNull();
  await user.click(within(region).getByRole('button', { name: 'Back' }));
  expect(shut()).toBeNull();
});
