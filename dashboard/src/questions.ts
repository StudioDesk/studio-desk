// An agent's question to the director (1.2 step 2) as the pages read it, by the controller's rules
// (src/core/questions.mjs): the question that still waits for an answer, auto mode's answer the director may still
// change, the kinds of question always kept for the director, the body an answer sends, and the exchange of one
// asking attempt. The shared run rules (public/runs.js taskExplanation) explain the same waiting question.
import type { AttemptSummary, Task } from './api';

export type Question = NonNullable<AttemptSummary['question']>;

// An answer recorded on the task (task.answers): the attempt whose question it answers, the option picked and its
// label, the words written, the work's auto mode it set (null follows Settings), who gave it and when. The
// director's answer that replaced auto mode's says so.
export interface Answer {
  attemptId: string;
  option?: number;
  label?: string;
  text?: string;
  autoMode?: boolean | null;
  replaces?: 'auto-mode';
  by?: { type?: string; at?: string };
  at?: string;
}

// What an answer, or a change of auto mode's answer, sends besides the project and the asking attempt.
export interface AnswerBody {
  option?: number;
  text?: string;
  autoMode?: boolean;
}

// One asking attempt's exchange: its question, then the answers recorded for it in order.
export interface Exchange {
  attemptId: string;
  question: Question;
  answers: Answer[];
}

const answersOf = (task: Task): Answer[] => (Array.isArray(task.answers) ? (task.answers as Answer[]) : []);

// The attempt whose question waits for an answer: the blocked task's latest attempt, blocked with a question it
// asked, which no recorded answer names. A question that could not be read has no ask, so it never waits.
export function waitingQuestion(task: Task, attempts: AttemptSummary[]): AttemptSummary | null {
  if (task.status !== 'blocked' || !task.lastAttemptId) return null;
  const asking = attempts.find(attempt => attempt.id === task.lastAttemptId && attempt.taskId === task.id);
  if (asking?.status !== 'blocked' || !asking.question?.ask) return null;
  return answersOf(task).some(answer => answer.attemptId === asking.id) ? null : asking;
}

// Auto mode's answer the director may still change: the task's latest answer, given by auto mode, while the work it
// started is neither accepted, denied, back in planning nor closed.
export function changeableAnswer(task: Task): Answer | null {
  const last = answersOf(task).at(-1);
  if (!last || last.by?.type !== 'auto-mode') return null;
  if (['done', 'denied', 'backlog'].includes(task.status) || task.closed) return null;
  return last;
}

// The kinds of question that always wait for the director, in the director's words.
const keptWords: Record<string, string> = {
  package: 'a new package',
  scope: "past the story's files",
  permission: 'a permission',
  push: 'a push',
  delete: 'deleting work',
  art: 'art direction',
  playtest: 'playtesting',
};
export const keptKinds = (topics: readonly string[] = []) => topics.map(topic => keptWords[topic] ?? topic);

// An answer's request body. Picking an option puts its label at the start of the text: while the label still starts
// it, the option is sent with the rest of the words, if any. Once the label was edited away, the words go alone. Auto
// mode is sent only when the director changed the switch from what it showed; otherwise the work keeps its own.
export function answerBody(
  question: Question,
  pickedIndex: number | null,
  text: string,
  autoMode: boolean,
  shownAutoMode: boolean,
): AnswerBody {
  const words = text.trim(),
    label = pickedIndex === null ? undefined : question.options?.[pickedIndex]?.label,
    body: AnswerBody = {};
  if (pickedIndex !== null && label && words.startsWith(label)) {
    const rest = words.slice(label.length).trim();
    body.option = pickedIndex;
    if (rest) body.text = rest;
  } else if (words) body.text = words;
  if (autoMode !== shownAutoMode) body.autoMode = autoMode;
  return body;
}

// The exchange an asking attempt started: its question, then every answer recorded for it as the controller recorded
// them, auto mode's first, then the director's that replaced it. An attempt without a readable question has none.
export function exchange(task: Task, attempt: AttemptSummary): Exchange | null {
  if (!attempt.question?.ask) return null;
  return {
    attemptId: attempt.id,
    question: attempt.question,
    answers: answersOf(task).filter(answer => answer.attemptId === attempt.id),
  };
}
