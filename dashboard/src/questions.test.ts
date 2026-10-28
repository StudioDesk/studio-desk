// An agent's question as the pages read it (1.2 step 2): the question that waits, auto mode's answer the director
// may change, the kinds kept for the director in their words, an answer's request body, and one attempt's exchange.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { answerBody, changeableAnswer, exchange, keptKinds, waitingQuestion, type Answer } from './questions';

const question = {
    ask: 'Keep the old route for one release?',
    why: 'Two pages still call it.',
    options: [{ label: 'Keep it' }, { label: 'Remove it', detail: 'and update both pages' }],
    recommended: 0,
    choice: 'inside-story',
    topics: [],
  },
  asked = (id: string, fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
    id,
    taskId: 'T-1',
    status: 'blocked',
    workerId: 'W-02',
    question,
    ...fields,
  }),
  story = (fields: Partial<Task> = {}): Task => ({
    id: 'T-1',
    title: 'Retire the old route',
    kind: 'studio-development:change',
    status: 'blocked',
    lastAttemptId: 'a-2',
    ...fields,
  }),
  byAuto = { type: 'auto-mode', at: '2026-10-28T10:00:00.000Z' },
  byDirector = { type: 'director', at: '2026-10-28T10:05:00.000Z' };

test("the blocked task's latest attempt waits with its question until an answer names it", () => {
  const attempts = [asked('a-1', { status: 'revision_requested' }), asked('a-2')];
  expect(waitingQuestion(story(), attempts)?.id).toBe('a-2');
  // An answered question no longer waits, even before the task moves on.
  expect(
    waitingQuestion(story({ answers: [{ attemptId: 'a-2', option: 0, label: 'Keep it', by: byDirector }] }), attempts),
  ).toBeNull();
  // An answer to an older attempt's question leaves the latest one waiting.
  expect(
    waitingQuestion(story({ answers: [{ attemptId: 'a-1', text: 'Keep it.', by: byDirector }] }), attempts)?.id,
  ).toBe('a-2');
});

test("an older attempt's question, an unblocked task or an unreadable question waits for nothing", () => {
  // The older attempt asked; the latest did not.
  expect(waitingQuestion(story(), [asked('a-1'), asked('a-2', { question: undefined })])).toBeNull();
  expect(waitingQuestion(story({ lastAttemptId: 'a-2' }), [asked('a-1')])).toBeNull();
  for (const status of ['ready', 'running', 'review', 'done', 'failed'])
    expect(waitingQuestion(story({ status }), [asked('a-2')]), status).toBeNull();
  // The attempt itself must be the one that stopped to ask.
  expect(waitingQuestion(story(), [asked('a-2', { status: 'failed' })])).toBeNull();
  expect(
    waitingQuestion(story(), [asked('a-2', { question: { problem: 'question.json must be readable JSON.' } })]),
  ).toBeNull();
  // Another task's attempt of the same name is not this task's.
  expect(waitingQuestion(story(), [asked('a-2', { taskId: 'T-9' })])).toBeNull();
  expect(waitingQuestion(story({ lastAttemptId: undefined }), [asked('a-2')])).toBeNull();
});

test("auto mode's last answer can be changed until the director's answer follows it or the work is settled", () => {
  const auto: Answer = { attemptId: 'a-2', option: 0, label: 'Keep it', by: byAuto, at: byAuto.at };
  for (const status of ['ready', 'running', 'review', 'blocked', 'failed'])
    expect(changeableAnswer(story({ status, answers: [auto] })), status).toEqual(auto);
  // The latest of several answers is the one that counts.
  const older: Answer = { attemptId: 'a-1', text: 'Use the new name.', by: byDirector };
  expect(changeableAnswer(story({ status: 'running', answers: [older, auto] }))).toEqual(auto);
  const changed: Answer = { attemptId: 'a-2', option: 1, label: 'Remove it', replaces: 'auto-mode', by: byDirector };
  expect(changeableAnswer(story({ status: 'running', answers: [auto, changed] }))).toBeNull();
  expect(changeableAnswer(story({ status: 'running', answers: [older] }))).toBeNull();
  expect(changeableAnswer(story({ status: 'running' }))).toBeNull();
  for (const status of ['done', 'denied', 'backlog'])
    expect(changeableAnswer(story({ status, answers: [auto] })), status).toBeNull();
  expect(changeableAnswer(story({ status: 'review', closed: true, answers: [auto] }))).toBeNull();
  expect(changeableAnswer(story({ status: 'review', closed: { reason: 'Not needed.' }, answers: [auto] }))).toBeNull();
});

test("every kind kept for the director reads in the director's words", () => {
  expect(keptKinds(['package', 'scope', 'permission', 'push', 'delete', 'art', 'playtest'])).toEqual([
    'a new package',
    "past the story's files",
    'a permission',
    'a push',
    'deleting work',
    'art direction',
    'playtesting',
  ]);
  expect(keptKinds([])).toEqual([]);
  expect(keptKinds()).toEqual([]);
});

test('an answer sends the picked option, the words added after its label, or the words alone', () => {
  // The picked option alone, its label untouched, or with only spaces after it.
  expect(answerBody(question, 0, 'Keep it', false, false)).toEqual({ option: 0 });
  expect(answerBody(question, 1, '  Remove it  ', false, false)).toEqual({ option: 1 });
  // The option with the words added after its label.
  expect(answerBody(question, 1, 'Remove it — and say so in the release notes. ', false, false)).toEqual({
    option: 1,
    text: '— and say so in the release notes.',
  });
  // Once the label was edited away, the words go alone.
  expect(answerBody(question, 0, 'Keep the old route until 1.3.', false, false)).toEqual({
    text: 'Keep the old route until 1.3.',
  });
  // No option picked: the words alone, trimmed; nothing written sends no text.
  expect(answerBody(question, null, '  Ask the pages team first. ', false, false)).toEqual({
    text: 'Ask the pages team first.',
  });
  expect(answerBody(question, null, '   ', false, false)).toEqual({});
  // An option the question does not have is not sent.
  expect(answerBody(question, 4, 'Keep it', false, false)).toEqual({ text: 'Keep it' });
});

test('auto mode is sent only when the director changed the switch from what it showed', () => {
  expect(answerBody(question, 0, 'Keep it', true, true)).toEqual({ option: 0 });
  expect(answerBody(question, 0, 'Keep it', false, false)).toEqual({ option: 0 });
  expect(answerBody(question, 0, 'Keep it', true, false)).toEqual({ option: 0, autoMode: true });
  expect(answerBody(question, null, 'Remove it later.', false, true)).toEqual({
    text: 'Remove it later.',
    autoMode: false,
  });
});

test("an asking attempt's exchange has its question, then auto mode's answer before the director's replacement", () => {
  const auto: Answer = { attemptId: 'a-2', option: 0, label: 'Keep it', by: byAuto, at: byAuto.at },
    changed: Answer = {
      attemptId: 'a-2',
      option: 1,
      label: 'Remove it',
      text: 'Both pages move this week.',
      replaces: 'auto-mode',
      by: byDirector,
      at: byDirector.at,
    },
    other: Answer = { attemptId: 'a-1', text: 'Use the new name.', by: byDirector },
    task = story({ status: 'running', answers: [other, auto, changed] });
  expect(exchange(task, asked('a-2'))).toEqual({ attemptId: 'a-2', question, answers: [auto, changed] });
  expect(exchange(task, asked('a-1'))?.answers).toEqual([other]);
  // A question still waiting has no answer yet.
  expect(exchange(story(), asked('a-2'))).toEqual({ attemptId: 'a-2', question, answers: [] });
  // An attempt that asked nothing, or whose question could not be read, has no exchange.
  expect(exchange(task, asked('a-3', { question: undefined }))).toBeNull();
  expect(exchange(task, asked('a-3', { question: { problem: 'The question must be a JSON object.' } }))).toBeNull();
});
