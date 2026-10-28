// An agent's question (1.2 step 2): the card with who asked, the story, when, whose call it is, the question and why,
// and the Answer box built on the message box, which offers the agent's options with the recommended one marked and
// the work's Auto mode, and sends the answer, or auto mode's changed answer, as the controller's recorded step.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, Shell, Task } from './api';
import { AnswerBox, QuestionCard } from './question-card';
import type { Question } from './questions';
import { fakeController, taskFixture, type Controller } from './test-controller';
import { when } from './today';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const askedAt = '2026-03-04T12:00:00.000Z',
  question: Question = {
    ask: 'Keep the old route for one release?',
    why: 'Two pages still call it.',
    options: [{ label: 'Keep it' }, { label: 'Remove it', detail: 'and update both pages' }],
    recommended: 1,
    choice: 'inside-story',
    topics: [],
  },
  story = (extra: Partial<Task> = {}) =>
    taskFixture('T-1', {
      title: 'Retire the old route',
      kind: 'studio-development:change',
      status: 'blocked',
      lastAttemptId: 'attempt-2',
      ...extra,
    }),
  asking = (asked: Question = question): AttemptSummary => ({
    id: 'attempt-2',
    taskId: 'T-1',
    status: 'blocked',
    workerId: 'W-1',
    startedAt: '2026-03-04T11:40:00.000Z',
    finishedAt: askedAt,
    question: asked,
  });

// The card with the box inside it, as a page shows them, from the project's records.
function show({
  task = story(),
  attempt = asking(),
  change = false,
  agentPermissions,
}: { task?: Task; attempt?: AttemptSummary; change?: boolean; agentPermissions?: Shell['agentPermissions'] } = {}) {
  const state = { ...controller.shell, agentPermissions, tasks: [task], attempts: [attempt], runs: [] },
    onSent = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuestionCard projectId="project-x" state={state} task={task} attempt={attempt}>
        <AnswerBox projectId="project-x" state={state} task={task} attempt={attempt} change={change} onSent={onSent} />
      </QuestionCard>
    </QueryClientProvider>,
  );
  const card = screen.getByRole('article', { name: "Eli's question" }),
    box = within(screen.getByRole('form', { name: 'Answer Eli' }));
  return {
    card,
    box,
    text: box.getByRole('textbox', { name: 'Answer Eli' }) as HTMLTextAreaElement,
    option: (label: string) => box.getByRole('button', { name: new RegExp(`^${label}`) }),
    onSent,
  };
}
const posted = () => controller.requests.filter(request => request.method === 'POST');

test('the card shows the agent, the story, when it asked, the question and why, and what asking costs', () => {
  const { card } = show();
  const words = card.textContent ?? '';
  expect(within(card).getByText('Eli asks')).toBeTruthy();
  // The agent's face beside its words, as Today's calls show an agent: stopped on the story to ask.
  expect(card.querySelector('svg.sd-avatar')?.getAttribute('data-state')).toBe('stuck');
  expect(within(card).getByRole('heading', { level: 3, name: 'Retire the old route' })).toBeTruthy();
  expect(when(askedAt)).not.toBe('');
  expect(within(card).getByText(when(askedAt))).toBeTruthy();
  expect(within(card).getByText('Keep the old route for one release?')).toBeTruthy();
  expect(within(card).getByText('Two pages still call it.')).toBeTruthy();
  expect(words).toContain('Eli marked it a choice inside its story.');
  expect(words).toContain('Once you answer, Eli continues from its saved work. Asking used none of its attempts.');
});

test('a question of a kind always kept for the director names each kind, whatever the agent marked', () => {
  const { card } = show({ attempt: asking({ ...question, topics: ['package', 'scope'] }) });
  expect(card.textContent).toContain("Always your call: a new package and past the story's files.");
  expect(card.textContent).not.toContain('inside its story');
  cleanup();
  const marked = show({ attempt: asking({ ...question, choice: 'director' }) }).card;
  expect(marked.textContent).toContain('Eli marked it as your call.');
  expect(marked.textContent).not.toContain('inside its story');
});

test("the Answer box offers the agent's options, the recommended one marked, and Auto mode, and no files", () => {
  const { box, option } = show();
  expect(box.getByRole('switch', { name: 'Auto mode' }).getAttribute('aria-checked')).toBe('false');
  expect(box.queryByRole('button', { name: /Files/ })).toBeNull();
  expect(box.getByText("Eli's options")).toBeTruthy();
  // The recommended option, and only it, carries the mark.
  expect(within(option('Remove it')).getByText('Recommended')).toBeTruthy();
  expect(within(option('Keep it')).queryByText('Recommended')).toBeNull();
  expect(box.getAllByText('Recommended')).toHaveLength(1);
  // An option's detail shows beside its label.
  expect(box.getByText('and update both pages')).toBeTruthy();
});

test('picking an option puts its label in the text, and the words added after it go with the option', async () => {
  const user = userEvent.setup(),
    { text, option, onSent, box } = show();
  await user.click(option('Remove it'));
  expect(text.value).toBe('Remove it');
  await user.type(text, ' — and say so in the release notes.');
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(posted()).toEqual([
    {
      url: '/api/tasks/T-1/answer',
      method: 'POST',
      body: {
        projectId: 'project-x',
        attemptId: 'attempt-2',
        option: 1,
        text: '— and say so in the release notes.',
      },
    },
  ]);
  // The sent answer leaves the box empty.
  expect(text.value).toBe('');
});

test('words alone send the text without an option, and a changed Auto mode goes with them', async () => {
  const user = userEvent.setup(),
    { text, box, onSent } = show();
  await user.type(text, 'Ask the pages team first.');
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  expect(posted().at(-1)?.body).toEqual({
    projectId: 'project-x',
    attemptId: 'attempt-2',
    text: 'Ask the pages team first.',
  });
  // An option picked and then edited away sends the words alone.
  await user.click(box.getByRole('button', { name: /^Keep it/ }));
  await user.clear(text);
  await user.type(text, 'Keep the old route until 1.3.');
  const auto = box.getByRole('switch', { name: 'Auto mode' });
  await user.click(auto);
  expect(auto.getAttribute('aria-checked')).toBe('true');
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() => expect(onSent).toHaveBeenCalledTimes(2));
  expect(posted().at(-1)?.body).toEqual({
    projectId: 'project-x',
    attemptId: 'attempt-2',
    text: 'Keep the old route until 1.3.',
    autoMode: true,
  });
});

test("Auto mode shows the work's own choice, otherwise the Settings, and only a change is sent", async () => {
  const user = userEvent.setup();
  // The Settings' auto mode, when the work has no choice of its own.
  let { box, option } = show({ agentPermissions: { auto: true } });
  expect(box.getByRole('switch', { name: 'Auto mode' }).getAttribute('aria-checked')).toBe('true');
  await user.click(option('Keep it'));
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]!.body).toEqual({ projectId: 'project-x', attemptId: 'attempt-2', option: 0 });
  cleanup();
  // The work's own choice comes before the Settings; turning it off sends the change.
  ({ box, option } = show({ task: story({ autoMode: false }), agentPermissions: { auto: true } }));
  const auto = box.getByRole('switch', { name: 'Auto mode' });
  expect(auto.getAttribute('aria-checked')).toBe('false');
  await user.click(auto);
  await user.click(option('Remove it'));
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[1]!.body).toEqual({ projectId: 'project-x', attemptId: 'attempt-2', option: 1, autoMode: true });
});

test("change mode sends the director's answer in place of auto mode's", async () => {
  const user = userEvent.setup(),
    task = story({
      status: 'running',
      answers: [{ attemptId: 'attempt-2', option: 1, label: 'Remove it', by: { type: 'auto-mode' } }],
    }),
    { box, option, onSent } = show({ task, attempt: { ...asking(), status: 'revision_requested' }, change: true });
  expect(box.getByText("Your answer replaces auto mode's, and Eli reworks from its saved work.")).toBeTruthy();
  await user.click(option('Keep it'));
  await user.click(box.getByRole('button', { name: 'Change the answer' }));
  await waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(posted()).toEqual([
    {
      url: '/api/tasks/T-1/change-answer',
      method: 'POST',
      body: { projectId: 'project-x', attemptId: 'attempt-2', option: 0 },
    },
  ]);
});

test("a refused answer shows the controller's message and keeps the draft", async () => {
  const user = userEvent.setup(),
    refusal = "Only the question of the task's latest attempt can be answered, while it waits for an answer.";
  controller.command = () => {
    throw new Error(refusal);
  };
  const { box, text, option, onSent } = show();
  await user.click(option('Remove it'));
  await user.type(text, ' after the release.');
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  expect((await box.findByRole('alert')).textContent).toBe(refusal);
  expect(text.value).toBe('Remove it after the release.');
  expect(onSent).not.toHaveBeenCalled();
  // Editing the draft clears the message; sending again sends the same answer.
  await user.type(text, '!');
  expect(box.queryByRole('alert')).toBeNull();
  controller.command = () => ({});
  await user.click(box.getByRole('button', { name: 'Send to Eli' }));
  await waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(posted().at(-1)?.body).toEqual({
    projectId: 'project-x',
    attemptId: 'attempt-2',
    option: 1,
    text: 'after the release.!',
  });
});
