// The Activity log (v1.0 item 23) reads an agent's question and the answers to it as the director's, in their color:
// "Asked you:", "You answered:" and auto mode's answers marked as such, while every stop still reads as one.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { LogEvent } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  localStorage.clear();
});
afterEach(cleanup);

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

const event = (seq: number, kind: string, message: string, taskId: string): LogEvent => ({
  seq,
  time: `2026-10-22T12:${String(seq).padStart(2, '0')}:00Z`,
  kind,
  message,
  task_id: taskId,
  attempt_id: `attempt-${seq}`,
});
// A row of the log by its words, and the classes of its icon.
const row = (text: string) => screen.getByText(text).closest('li')!;
const tone = (li: HTMLElement) => li.querySelector('.sd-timeline__icon')!.className;
// The note icon's outline, as design/icons.tsx draws it.
const drawn = (li: HTMLElement) => li.querySelector('.sd-timeline__icon path')?.getAttribute('d');

test("the Activity log reads questions and answers as the director's, and stops still as stops", async () => {
  controller.activity = [
    {
      events: [
        event(7, 'question_asked', 'Asks: Keep the old name?', 'T-name'),
        event(6, 'question_answered', 'The director answered: Keep it — and say why', 'T-name'),
        event(5, 'question_answered', 'Auto mode answered for the director: Rename it', 'T-rename'),
        event(4, 'answer_changed', "The director changed auto mode's answer: Keep it", 'T-rename'),
        // Recorded before the controller named a question one: a blocked attempt that asks.
        event(3, 'blocked', 'Asks: Split the story?', 'T-split'),
        event(2, 'failed', 'Tests failed.', 'T-tests'),
        event(1, 'blocked', 'Needs one more file.', 'T-file'),
      ],
      next: null,
    },
  ];
  open('/p/project-x/settings/activity');
  expect(await screen.findByText('Asked you: Keep the old name?')).toBeTruthy();
  const log = within(screen.getByRole('region', { name: 'Recorded events' }));

  // Newest first, as recorded, each in its own words.
  expect(log.getAllByRole('listitem').map(li => li.querySelector('.sd-timeline__body > span')!.textContent)).toEqual([
    'Asked you: Keep the old name?',
    'You answered: Keep it — and say why',
    'Auto mode answered for you: Rename it',
    "You changed auto mode's answer: Keep it",
    'Asked you: Split the story?',
    'Tests failed.',
    'Needs one more file.',
  ]);
  expect(log.queryByText(/^Asks: /)).toBeNull();
  expect(log.queryByText(/the director/i)).toBeNull();

  // Both questions, the new kind and the old blocked one, read as questions in the director's color, never as stops.
  for (const text of ['Asked you: Keep the old name?', 'Asked you: Split the story?']) {
    const li = row(text);
    expect(tone(li)).toBe('sd-timeline__icon sd-timeline__icon--you');
    expect(drawn(li)).toBe('M4 5h16v11H9l-5 4z');
    expect(within(li).getByText('Question').className).toBe('sd-chip sd-chip--you sd-chip--inline');
  }
  expect(within(row('Asked you: Keep the old name?')).getByRole('link', { name: 'T-name' }).getAttribute('href')).toBe(
    '/p/project-x/tasks/T-name',
  );

  // The answers, in the same color; only auto mode's is marked as its own.
  for (const text of [
    'You answered: Keep it — and say why',
    'Auto mode answered for you: Rename it',
    "You changed auto mode's answer: Keep it",
  ]) {
    const li = row(text);
    expect(tone(li)).toBe('sd-timeline__icon sd-timeline__icon--you');
    expect(drawn(li)).toBe('M4 5h16v11H9l-5 4z');
    expect(within(li).queryByText('Question')).toBeNull();
  }
  expect(within(row('Auto mode answered for you: Rename it')).getByText('Auto mode').className).toBe(
    'sd-chip sd-chip--you sd-chip--inline',
  );
  expect(within(row('You answered: Keep it — and say why')).queryByText('Auto mode')).toBeNull();
  expect(within(row("You changed auto mode's answer: Keep it")).queryByText('Auto mode')).toBeNull();
  expect(
    within(row("You changed auto mode's answer: Keep it")).getByRole('link', { name: 'T-rename' }).getAttribute('href'),
  ).toBe('/p/project-x/tasks/T-rename');

  // A failure, and a blocked attempt that does not ask, still read as red stops, with no chip.
  for (const text of ['Tests failed.', 'Needs one more file.']) {
    const li = row(text);
    expect(tone(li)).toBe('sd-timeline__icon sd-timeline__icon--bad');
    expect(li.querySelector('.sd-chip')).toBeNull();
  }
});
