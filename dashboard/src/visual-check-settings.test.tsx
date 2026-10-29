// The visual check in Settings (1.2 step 8; visual-check-settings.tsx): on or off, the browser found, the widths and
// themes captured and the reviewer's duty, read from the project's visual view on the stand-in controller, and the
// director's saves.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { VisualSettings } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

const viewUrl = '/api/projects/project-x/visual-check',
  edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  browserNote =
    'Installing Microsoft Edge or Google Chrome lets the reviewer see the pages; nothing is downloaded for you.',
  reviewLine = 'The reviewer must describe each image before a story can pass review.';

let controller: Controller;
beforeEach(() => {
  // The stand-in's project is a code project, on the controller's own source; its check is off, at 1440 and 390 px
  // in both themes, with Edge found.
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () => {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/settings'] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
};
const section = async () => within(await screen.findByRole('region', { name: 'Visual check' }));
// What a term of the section's list shows, chip by chip.
const chips = (scope: ReturnType<typeof within>, term: string) =>
  [...scope.getByText(term).nextElementSibling!.querySelectorAll('.sd-file')].map(chip => chip.textContent);
const posts = () => controller.requests.filter(request => request.method !== 'GET');
const viewReads = () => controller.reads().filter(url => url === viewUrl);
// The controller's save: what it was sent becomes the view's settings.
const saveSettings = (url: string, method: string, body: unknown) => {
  if (url !== viewUrl || method !== 'POST') return {};
  const { enabled, widths, themes, browser } = body as VisualSettings;
  controller.visualView = { ...controller.visualView, settings: { enabled, widths, themes, browser } };
  return controller.visualView;
};

test("on a code project the section shows the check off, the browser found, what is captured and the reviewer's duty", async () => {
  open();
  const visual = await section();
  const toggle = await visual.findByRole('switch', { name: 'Visual check' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(visual.getByText('Off. Stories are reviewed without images of their pages.')).toBeTruthy();
  // The browser by its name and its program.
  const browser = visual.getByText('Browser').nextElementSibling!;
  expect(within(browser as HTMLElement).getByText('Microsoft Edge')).toBeTruthy();
  expect(within(browser as HTMLElement).getByText(edge)).toBeTruthy();
  expect(visual.queryByText('No Chromium-based browser found')).toBeNull();
  expect(chips(visual, 'Widths')).toEqual(['Desktop · 1440 px', 'Phone · 390 px']);
  expect(chips(visual, 'Themes')).toEqual(['Light', 'Dark']);
  expect(visual.getByText(reviewLine)).toBeTruthy();
  expect(visual.getByText('Each story names its own pages on its Pages tab, never here.')).toBeTruthy();
  // Nothing keeps it from running here.
  expect(visual.queryByRole('link', { name: 'Trying a story yourself' })).toBeNull();
  expect(viewReads()).toEqual([viewUrl]);
  expect(posts()).toEqual([]);
});

test('switching the check on saves the current settings with only enabled changed, and reads the view again', async () => {
  const user = userEvent.setup();
  controller.command = saveSettings;
  open();
  const visual = await section();
  await user.click(await visual.findByRole('switch', { name: 'Visual check' }));
  await waitFor(() =>
    expect(posts()).toEqual([
      {
        url: viewUrl,
        method: 'POST',
        body: { projectId: 'project-x', enabled: true, widths: [1440, 390], themes: ['light', 'dark'], browser: null },
      },
    ]),
  );
  await waitFor(() =>
    expect(visual.getByRole('switch', { name: 'Visual check' }).getAttribute('aria-checked')).toBe('true'),
  );
  expect(visual.getByText('On. A story that names pages has them captured for its review.')).toBeTruthy();
  expect(viewReads()).toEqual([viewUrl, viewUrl]);
});

test("a refused switch says the controller's message and leaves the check as it was", async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw new Error('The visual check needs a project on a git repository.');
  };
  open();
  const visual = await section();
  await user.click(await visual.findByRole('switch', { name: 'Visual check' }));
  expect(await screen.findByText('The visual check needs a project on a git repository.')).toBeTruthy();
  expect(visual.getByRole('switch', { name: 'Visual check' }).getAttribute('aria-checked')).toBe('false');
  expect(posts()).toHaveLength(1);
});

test('with no browser found the section says so with the note about installing Edge or Chrome', async () => {
  controller.visualView = { ...controller.visualView, browser: null, note: browserNote };
  open();
  const visual = await section();
  const browser = within((await visual.findByText('Browser')).nextElementSibling as HTMLElement);
  expect(browser.getByText('No Chromium-based browser found')).toBeTruthy();
  expect(browser.getByText(browserNote)).toBeTruthy();
  expect(browser.queryByText('Microsoft Edge')).toBeNull();
  expect(browser.queryByText(edge)).toBeNull();
  // A program the settings name that is not there is named beside it.
  cleanup();
  controller.visualView = {
    ...controller.visualView,
    settings: { ...controller.visualView.settings, browser: 'D:/Browsers/chromium.exe' },
  };
  open();
  const chosen = within((await (await section()).findByText('Browser')).nextElementSibling as HTMLElement);
  expect(chosen.getByText('No Chromium-based browser found')).toBeTruthy();
  expect(chosen.getByText('D:/Browsers/chromium.exe')).toBeTruthy();
  expect(chosen.getByText(browserNote)).toBeTruthy();
});

test('when the check would not run here the section says why, pointing at Trying a story yourself', async () => {
  const reason = 'Name a start command under Trying a story yourself: the check starts the candidate with it.';
  controller.visualView = { ...controller.visualView, blocked: reason };
  open();
  const visual = await section();
  expect(await visual.findByText(reason)).toBeTruthy();
  expect(visual.getByRole('link', { name: 'Trying a story yourself' }).getAttribute('href')).toBe('#repository');
  // The rest still shows: it says only why the check would not run.
  expect(visual.getByText(reviewLine)).toBeTruthy();
});

test('Edit what is captured saves changed widths, a theme taken away and a browser program in one post', async () => {
  const user = userEvent.setup();
  controller.command = saveSettings;
  open();
  const visual = await section();
  await user.click(await visual.findByRole('button', { name: 'Edit what is captured' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Edit what is captured' }));
  // The form starts from what is saved.
  const widths = () => dialog.getAllByLabelText(/^Width \d+$/).map(field => (field as HTMLInputElement).value);
  expect(widths()).toEqual(['1440', '390']);
  expect((dialog.getByRole('checkbox', { name: 'Light' }) as HTMLInputElement).checked).toBe(true);
  expect((dialog.getByRole('checkbox', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true);
  expect((dialog.getByLabelText('Browser program') as HTMLInputElement).value).toBe('');
  // One to three widths.
  await user.clear(dialog.getByLabelText('Width 1'));
  await user.type(dialog.getByLabelText('Width 1'), '1280');
  await user.click(dialog.getByRole('button', { name: 'Add a width' }));
  await user.type(dialog.getByLabelText('Width 3'), '768');
  expect((dialog.getByRole('button', { name: 'Add a width' }) as HTMLButtonElement).disabled).toBe(true);
  expect(widths()).toEqual(['1280', '390', '768']);
  await user.click(dialog.getByRole('checkbox', { name: 'Dark' }));
  await user.type(dialog.getByLabelText('Browser program'), 'D:/Browsers/chromium.exe');
  expect(posts()).toEqual([]);
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit what is captured' })).toBeNull());
  expect(posts()).toEqual([
    {
      url: viewUrl,
      method: 'POST',
      body: {
        projectId: 'project-x',
        enabled: false,
        widths: [1280, 390, 768],
        themes: ['light'],
        browser: 'D:/Browsers/chromium.exe',
      },
    },
  ]);
  expect(await screen.findByText('Saved. The next check uses them.')).toBeTruthy();
  // Saved, the section reads the view again and shows what the next check captures.
  await waitFor(() =>
    expect(chips(visual, 'Widths')).toEqual(['Desktop · 1280 px', 'Phone · 390 px', 'Desktop · 768 px']),
  );
  expect(chips(visual, 'Themes')).toEqual(['Light']);
  expect(viewReads()).toEqual([viewUrl, viewUrl]);
});

test("a refused save shows the controller's message in the dialog, which stays open with the edits", async () => {
  const user = userEvent.setup(),
    message = 'The visual check settings are not valid: themes must name light, dark or both.';
  controller.visualView = {
    ...controller.visualView,
    settings: { ...controller.visualView.settings, browser: 'D:/Browsers/chromium.exe' },
    browser: 'D:/Browsers/chromium.exe',
  };
  controller.command = () => {
    throw new Error(message);
  };
  open();
  const visual = await section();
  await user.click(await visual.findByRole('button', { name: 'Edit what is captured' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Edit what is captured' }));
  expect((dialog.getByLabelText('Browser program') as HTMLInputElement).value).toBe('D:/Browsers/chromium.exe');
  await user.click(dialog.getByRole('button', { name: 'Remove width 1' }));
  // The last width cannot be taken away.
  expect(dialog.queryByRole('button', { name: 'Remove width 1' })).toBeNull();
  await user.click(dialog.getByRole('checkbox', { name: 'Light' }));
  await user.click(dialog.getByRole('checkbox', { name: 'Dark' }));
  // An emptied program is sent as none, which uses Edge or Chrome where they install.
  await user.clear(dialog.getByLabelText('Browser program'));
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  expect((await dialog.findByRole('alert')).textContent).toBe(message);
  expect(screen.getByRole('dialog', { name: 'Edit what is captured' })).toBeTruthy();
  expect(dialog.getAllByLabelText(/^Width \d+$/).map(field => (field as HTMLInputElement).value)).toEqual(['390']);
  expect((dialog.getByRole('checkbox', { name: 'Light' }) as HTMLInputElement).checked).toBe(false);
  expect((dialog.getByRole('checkbox', { name: 'Dark' }) as HTMLInputElement).checked).toBe(false);
  expect((dialog.getByLabelText('Browser program') as HTMLInputElement).value).toBe('');
  expect(posts()).toEqual([
    {
      url: viewUrl,
      method: 'POST',
      body: { projectId: 'project-x', enabled: false, widths: [390], themes: [], browser: null },
    },
  ]);
  // Cancel leaves the settings as they were.
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit what is captured' })).toBeNull());
  expect(visual.getByText('Desktop · 1440 px')).toBeTruthy();
  expect(visual.getByText('Dark')).toBeTruthy();
  expect(screen.queryByText('Saved. The next check uses them.')).toBeNull();
  expect(posts()).toHaveLength(1);
});

test('while the view is read the section says so, and a reading error shows the message', async () => {
  const answer = globalThis.fetch;
  let refuse = () => {};
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) =>
    url === viewUrl
      ? new Promise(resolve => {
          refuse = () =>
            resolve({ ok: false, status: 500, json: async () => ({ error: 'The project could not be read.' }) });
        })
      : answer(url, options),
  );
  open();
  const visual = await section();
  expect((await visual.findByRole('status')).textContent).toBe('Reading the visual check settings…');
  expect(visual.queryByRole('switch', { name: 'Visual check' })).toBeNull();
  refuse();
  expect((await visual.findByRole('alert')).textContent).toBe(
    'The visual check settings could not be read: The project could not be read.',
  );
  expect(visual.queryByRole('button', { name: 'Edit what is captured' })).toBeNull();
});

test('a project without a repository says the visual check is for one and reads nothing of it', async () => {
  controller.shell = {
    ...controller.shell,
    organizationConfiguration: { ...controller.shell.organizationConfiguration, taskKinds: ['general'] },
  };
  open();
  const visual = await section();
  expect(
    visual.getByText(
      "The visual check is for a project on a git repository: it shows the reviewer a code story's pages.",
    ),
  ).toBeTruthy();
  expect(visual.queryByRole('switch', { name: 'Visual check' })).toBeNull();
  expect(visual.queryByRole('button', { name: 'Edit what is captured' })).toBeNull();
  expect(visual.queryByText(reviewLine)).toBeNull();
  expect(controller.reads().filter(url => url.includes('/visual-check'))).toEqual([]);
});
