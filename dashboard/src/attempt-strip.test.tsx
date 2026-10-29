// A story's attempts as a strip of chips above its tabs, where its Attempts tab was: each build or work attempt and
// then each review, named and with how it ended, after how many of the allowed attempts are used. Choosing one shows
// it in every view (its change, its checks, its chapter in Activity and the Details link to its record) and a line
// under the strip names it; Back to the latest returns every view to the latest. On a phone the chips scroll sideways
// in their own row.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

// Hashes as the controller records them (SHA-256, hexadecimal).
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
// A build's recorded change to one file: its manifest, its unified diff and the file it staged, each with its hash.
const changeOf = async (path: string, word: string) => {
  const after = `export const word = "${word}";\n`,
    diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-export const word = "old";\n+export const word = "${word}";\n`;
  const [base, candidate, beforeHash, afterHash, diffHash] = await Promise.all(
    [`base ${path}`, `candidate ${path}`, 'export const word = "old";\n', after, diff].map(sha256),
  );
  const manifest = JSON.stringify({
    schemaVersion: 'source-change-v1',
    proposal: { taskId: 'planning' },
    baseHash: base,
    candidateHash: candidate,
    changes: [{ path, beforeHash, afterHash, bytes: after.length, artifact: `changes/${path}` }],
    diffFormat: 'unified-full-deletions-v1',
  });
  return {
    path,
    after,
    diff,
    manifest,
    hashes: { manifest: await sha256(manifest), diff: diffHash!, after: afterHash!, candidate: candidate! },
  };
};
type Change = Awaited<ReturnType<typeof changeOf>>;
let first: Change, second: Change;
beforeAll(async () => {
  [first, second] = await Promise.all([changeOf('src/first.mjs', 'first'), changeOf('src/second.mjs', 'second')]);
});

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell.workers = [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = () =>
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/p/project-x/tasks/T-1'] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
// The line that opens and folds an attempt's chapter in Activity.
const lineOf = (chapter: HTMLElement) => within(chapter).getAllByRole('button')[0]!;
const pressed = (chips: HTMLElement[]) => chips.map(chip => chip.getAttribute('aria-pressed'));

// One build with its recorded change and its measured tests.
const build = (id: string, change: Change, at: string, extra: Partial<AttemptSummary>) => {
  controller.artifacts[`${id}/source-change.json`] = change.manifest;
  controller.artifacts[`${id}/change.diff`] = change.diff;
  controller.artifacts[`${id}/changes/${change.path}`] = change.after;
  return {
    id,
    taskId: 'T-1',
    projectId: 'project-x',
    status: 'accepted',
    workerId: 'W-1',
    provider: 'claude',
    requestedModel: 'opus',
    startedAt: `2026-10-28T${at}:00.000Z`,
    finishedAt: `2026-10-28T${at.replace(/:\d\d$/, ':20')}:00.000Z`,
    assignment: { kind: 'studio-development:change' },
    sourceCandidate: { sourceHash: change.hashes.candidate },
    artifacts: [
      { path: 'source-change.json', kind: 'source-change', hash: change.hashes.manifest },
      { path: 'change.diff', kind: 'source-change-diff', hash: change.hashes.diff },
      { path: `changes/${change.path}`, kind: 'source-file', hash: change.hashes.after },
    ],
    ...extra,
  };
};
// A code story with two builds, the house rules accepting the first before the director sent it back, the second its
// candidate, and Morgan's review of it, which passed.
const story = () => {
  controller.tasks = [
    taskFixture('T-1', {
      title: 'Choose an attempt',
      kind: 'studio-development:change',
      status: 'review',
      maxAttempts: 3,
      lastAttemptId: 'attempt-review',
      sourceStage: {
        version: 'source-story-stages-v1',
        phase: 'candidate-review',
        current: 'review',
        candidate: {
          taskId: 'T-1',
          attemptId: 'attempt-2',
          workerId: 'W-1',
          path: 'source-change.json',
          hash: second.hashes.manifest,
          candidateHash: second.hashes.candidate,
        },
        review: { attemptId: 'attempt-review', workerId: 'W-2' },
        history: [],
      },
    }),
  ];
  controller.attempts = [
    build('attempt-1', first, '10:00', {
      acceptedBy: { type: 'policy' },
      testEvidence: { totals: { tests: 740, pass: 740, fail: 0 } },
      result: { outcome: 'completed', summary: 'First try.' },
    }),
    build('attempt-2', second, '11:00', {
      testEvidence: { totals: { tests: 752, pass: 752, fail: 0 } },
      result: { outcome: 'completed', summary: 'Second try.' },
    }),
    {
      id: 'attempt-review',
      taskId: 'T-1',
      projectId: 'project-x',
      status: 'accepted',
      workerId: 'W-2',
      startedAt: '2026-10-28T12:00:00.000Z',
      finishedAt: '2026-10-28T12:10:00.000Z',
      assignment: { kind: 'studio-development:change-review' },
      candidateReviewVerdict: 'pass',
      candidateReviewFindings: [],
      candidateReviewNotes: [],
      result: { outcome: 'completed', summary: 'The change holds up.' },
    },
  ];
};
const stripOf = () => screen.findByRole('region', { name: 'Attempts' }, { timeout: 5000 });
// The Details card's link to everything recorded about the attempt shown.
const recordLink = () =>
  within(screen.getByRole('region', { name: 'Details' })).getByRole('link', {
    name: 'Everything recorded about this attempt',
  });

test('a code story with two builds and a review has three chips, the builds then the review, each named with how it ended, after the build attempts used of those allowed', async () => {
  story();
  open();
  const strip = await stripOf(),
    chips = within(strip).getAllByRole('button');
  expect(
    chips.map(chip => [chip.querySelector('b')?.textContent, chip.querySelector('.sd-chip')?.textContent]),
  ).toEqual([
    ['Attempt 1 of 3', 'Accepted by house rules'],
    ['Attempt 2 of 3', 'Accepted'],
    ['Review', 'Passed'],
  ]);
  expect(strip.querySelector('.sd-eyebrow')?.textContent).toBe('Build · 2 of 3 attempts used');
  expect(within(strip).getByText('1 build attempt is left.')).toBeTruthy();
  // Who ran each on what, when and for how long, as the Attempts tab's rows said, is its title.
  expect(chips[0]!.title).toMatch(/^Eli · claude, opus · .+ to .+ · 20 min$/);
  expect(chips[2]!.title).toMatch(/^Morgan · .+ · 10 min$/);
  // The latest is the one shown, and no line says another is.
  expect(pressed(chips)).toEqual(['false', 'false', 'true']);
  expect(screen.queryByRole('region', { name: 'The attempt shown' })).toBeNull();
  // Above the tabs, none of which is Attempts; its tests passed, so it may be tried.
  const tablist = screen.getByRole('tablist', { name: 'Story details' });
  expect(
    within(tablist)
      .getAllByRole('tab')
      .map(tab => tab.firstChild?.textContent),
  ).toEqual(['Changes', 'Checks', 'Try it', 'Activity']);
  expect(strip.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('choosing the first build shows its change, its tests, its chapter and its record, and Back to the latest returns every view to the latest', async () => {
  const user = userEvent.setup(),
    scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  try {
    story();
    open();
    const strip = within(await stripOf());
    // The story opens on the candidate's change.
    expect(await screen.findByRole('region', { name: 'Diff of src/second.mjs' }, { timeout: 5000 })).toBeTruthy();
    const [one] = strip.getAllByRole('button');
    await user.click(one!);
    expect(pressed(strip.getAllByRole('button'))).toEqual(['true', 'false', 'false']);
    // The line under the strip names it, how it ended and who ran it on what.
    const line = within(screen.getByRole('region', { name: 'The attempt shown' }));
    expect(line.getByText('Build, attempt 1 of 3')).toBeTruthy();
    expect(line.getByText('Accepted by house rules')).toBeTruthy();
    expect(line.getByText(/^Eli · claude, opus · .+ · 20 min$/)).toBeTruthy();
    // Changes: its change, on the tab the director was on.
    expect(screen.getByRole('tab', { name: /^Changes/ }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('region', { name: 'Diff of src/first.mjs' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Diff of src/second.mjs' })).toBeNull();
    // Checks: its tests.
    await user.click(screen.getByRole('tab', { name: 'Checks' }));
    expect(within(screen.getByRole('tabpanel')).getByRole('img', { name: '740 of 740 tests passed' })).toBeTruthy();
    // Activity: its chapter, open and brought into view.
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    const chapter = await screen.findByRole('region', { name: 'Build, attempt 1 of 3' });
    expect(lineOf(chapter).getAttribute('aria-expanded')).toBe('true');
    expect(await within(chapter).findByText('First try.')).toBeTruthy();
    await waitFor(() => expect(scrolled.mock.contexts).toContain(chapter));
    // The record: Details links to the attempt shown's.
    expect(recordLink().getAttribute('href')).toBe('/p/project-x/tasks/T-1/attempts/attempt-1/record');
    // Back to the latest: the line goes, and every view shows the latest again.
    await user.click(line.getByRole('button', { name: 'Back to the latest' }));
    expect(screen.queryByRole('region', { name: 'The attempt shown' })).toBeNull();
    expect(pressed(strip.getAllByRole('button'))).toEqual(['false', 'false', 'true']);
    expect(recordLink().getAttribute('href')).toBe('/p/project-x/tasks/T-1/attempts/attempt-review/record');
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    const review = screen.getByRole('region', { name: 'Review' });
    expect(lineOf(review).getAttribute('aria-expanded')).toBe('true');
    expect(lineOf(screen.getByRole('region', { name: 'Build, attempt 1 of 3' })).getAttribute('aria-expanded')).toBe(
      'false',
    );
    await waitFor(() => expect(scrolled.mock.contexts).toContain(review));
    await user.click(screen.getByRole('tab', { name: 'Checks' }));
    expect(within(screen.getByRole('tabpanel')).getByRole('img', { name: '752 of 752 tests passed' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /^Changes/ }));
    expect(await screen.findByRole('region', { name: 'Diff of src/second.mjs' }, { timeout: 5000 })).toBeTruthy();
    // Choosing the latest's chip is the same as Back to the latest.
    await user.click(strip.getAllByRole('button')[1]!);
    expect(screen.getByRole('region', { name: 'The attempt shown' })).toBeTruthy();
    await user.click(strip.getAllByRole('button')[2]!);
    expect(screen.queryByRole('region', { name: 'The attempt shown' })).toBeNull();
  } finally {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test('on a phone the strip is a row of its own that scrolls sideways to keep the chosen chip in view, and there is no Attempts tab', async () => {
  const user = userEvent.setup(),
    // jsdom lays nothing out: the chips' row shows 300 pixels of the 600 its three chips take, 200 each.
    row = (element: Element | null) => !!element?.classList.contains('sd-attemptstrip__chips');
  width(true);
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
    return row(this) ? 600 : 0;
  });
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return row(this) ? 300 : 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const parent = this.parentElement,
      left = row(parent) ? [...parent!.children].indexOf(this) * 200 - parent!.scrollLeft : 0,
      wide = row(this) ? 300 : row(parent) ? 200 : 0;
    return { left, right: left + wide, top: 0, bottom: 40, width: wide, height: 40, x: left, y: 0 } as DOMRect;
  });
  story();
  open();
  const strip = await stripOf(),
    chips = within(strip).getAllByRole('button'),
    chipRow = strip.querySelector<HTMLElement>('.sd-attemptstrip__chips')!;
  // Every chip is in the one row, which scrolls the latest, shown, into view.
  expect(chips.every(chip => chip.parentElement === chipRow)).toBe(true);
  await waitFor(() => expect(chipRow.scrollLeft).toBe(384));
  // Choosing another brings it into view in the row.
  await user.click(chips[0]!);
  expect(chipRow.scrollLeft).toBe(0);
  await user.click(chips[1]!);
  expect(chipRow.scrollLeft).toBe(184);
  const tablist = screen.getByRole('tablist', { name: 'Story details' });
  expect(
    within(tablist)
      .getAllByRole('tab')
      .map(tab => tab.firstChild?.textContent),
  ).toEqual(['Activity', 'Changes', 'Checks', 'Try it', 'Details']);
  expect(strip.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("other work's strip counts its work attempts as the Details limit does, and names the ones a usage limit or a restart stopped as not counted", async () => {
  controller.tasks = [taskFixture('T-1', { title: 'Write the guide', status: 'review', lastAttemptId: 'a-4' })];
  const work = (id: string, minute: string, status: string, extra: Partial<AttemptSummary> = {}) => ({
    id,
    taskId: 'T-1',
    status,
    workerId: 'W-1',
    startedAt: `2026-10-28T10:${minute}:00.000Z`,
    finishedAt: `2026-10-28T10:${minute}:30.000Z`,
    result: { summary: `${id} handed back.` },
    ...extra,
  });
  controller.attempts = [
    work('a-1', '00', 'failed'),
    work('a-2', '10', 'blocked', { subscriptionHold: 'claude' }),
    work('a-3', '20', 'interrupted', { reconciledAt: '2026-10-28T10:25:00.000Z' }),
    work('a-4', '30', 'review'),
  ];
  open();
  const strip = await stripOf();
  expect(strip.querySelector('.sd-eyebrow')?.textContent).toBe('2 of 3 attempts used');
  expect(within(screen.getByRole('region', { name: 'Details' })).getByText('2 of 3 used')).toBeTruthy();
  expect(
    within(strip)
      .getAllByRole('button')
      .map(chip => chip.querySelector('b')?.textContent),
  ).toEqual(['Attempt 1 of 3', 'Stopped by a usage limit, not counted', 'Interrupted, not counted', 'Attempt 2 of 3']);
  // What is left is counted for a code story's builds only.
  expect(within(strip).queryByText(/left\.$/)).toBeNull();
});
