// An agent asks the director (1.2 step 2). An agent that needs a call it should not make alone stops with
// outcome blocked and returns question.json; the controller records the question on the attempt, the attempt
// counts toward no limit, and an answer becomes the next attempt's direction, which continues from the saved work.
// Domain-free: any task type's agent may ask.
import { artifactPath } from './artifacts.mjs';
import { hash } from './contracts.mjs';
import fs from 'node:fs';

export const questionFile = 'question.json';
export const questionKind = 'question';
export const questionSchema = 'question-v1';
// The kinds of question that always wait for the director, whatever the agent marks (decided October 28).
export const keptTopics = Object.freeze(['scope', 'permission', 'package', 'push', 'delete', 'art', 'playtest']);
const maxQuestionBytes = 32 * 1024,
  maxOptions = 5,
  maxAnswers = 20;

const text = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must be text of 1 to ${max} characters.`);
  return value.trim();
};

// The question an attempt's blocked result returned: `{ ask, why, options, recommended, choice, topics }`, or
// `{ problem }` when the file is not a valid question. The result itself is never changed.
export function readQuestion(attempt, store) {
  const listed = attempt.artifacts.filter(item => item.path === questionFile);
  if (!listed.length) return null;
  try {
    if (listed.length > 1 || listed[0].kind !== questionKind)
      throw new Error(`Return ${questionFile} once, with kind ${questionKind}.`);
    let question;
    try {
      const bytes = fs.readFileSync(artifactPath(store, attempt, questionFile));
      if (bytes.length > maxQuestionBytes || hash(bytes) !== listed[0].hash) throw new Error();
      question = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error(`${questionFile} must be readable JSON of at most ${maxQuestionBytes / 1024} KiB.`);
    }
    if (!question || typeof question !== 'object' || Array.isArray(question))
      throw new Error('The question must be a JSON object.');
    const allowed = ['schemaVersion', 'ask', 'why', 'options', 'recommended', 'choice', 'topics'],
      extra = Object.keys(question).filter(key => !allowed.includes(key));
    if (extra.length) throw new Error(`The question has fields it may not have: ${extra.join(', ')}.`);
    if (question.schemaVersion !== questionSchema)
      throw new Error(`The question must have schemaVersion ${questionSchema}.`);
    const options = question.options ?? [];
    if (!Array.isArray(options) || options.length > maxOptions)
      throw new Error(`The question's options must be a list of at most ${maxOptions}.`);
    const read = options.map((option, index) => {
      if (!option || typeof option !== 'object' || Array.isArray(option))
        throw new Error(`Option ${index + 1} must be an object with a label.`);
      const unknown = Object.keys(option).filter(key => !['label', 'detail'].includes(key));
      if (unknown.length) throw new Error(`Option ${index + 1} has fields it may not have: ${unknown.join(', ')}.`);
      return {
        label: text(option.label, 120, `Option ${index + 1}'s label`),
        ...(option.detail !== undefined ? { detail: text(option.detail, 500, `Option ${index + 1}'s detail`) } : {}),
      };
    });
    const recommended = question.recommended ?? null;
    if (recommended !== null && !(Number.isInteger(recommended) && recommended >= 0 && recommended < read.length))
      throw new Error("The question's recommended must be the index of one of its options, or null.");
    if (!['inside-story', 'director'].includes(question.choice))
      throw new Error('The question\'s choice must be "inside-story" or "director".');
    const topics = question.topics ?? [];
    if (
      !Array.isArray(topics) ||
      topics.some(topic => !keptTopics.includes(topic)) ||
      new Set(topics).size !== topics.length
    )
      throw new Error(`The question's topics must be distinct names from: ${keptTopics.join(', ')}.`);
    return {
      ask: text(question.ask, 500, "The question's ask"),
      why: text(question.why, 2000, "The question's why"),
      options: read,
      recommended,
      choice: question.choice,
      topics,
    };
  } catch (error) {
    return { problem: error.message };
  }
}

// Whether auto mode may answer for the director: a choice the agent marked as inside its story, touching none
// of the kinds kept for the director, with a recommendation, from an attempt that asked for no files.
export const answerableInAutoMode = attempt =>
  !!attempt?.question?.ask &&
  attempt.question.choice === 'inside-story' &&
  !attempt.question.topics.length &&
  attempt.question.recommended !== null &&
  !attempt.scopeRequest;

// The question of the task's latest attempt that is still waiting for an answer, with that attempt.
export function waitingQuestion(store, task) {
  if (task.status !== 'blocked' || !task.lastAttemptId) return null;
  const attempt = store.attempt(task.lastAttemptId);
  if (attempt?.status !== 'blocked' || !attempt.question?.ask) return null;
  if ((task.answers || []).some(answer => answer.attemptId === attempt.id)) return null;
  return attempt;
}

// The answer to a question: one of its options, the director's own words, or both, and optionally the work's
// auto mode from here on (the message box's Auto mode, decided October 28): true, false, or null to follow Settings.
function readAnswer(question, { option, text: words, autoMode }) {
  if (
    option !== undefined &&
    option !== null &&
    !(Number.isInteger(option) && option >= 0 && option < question.options.length)
  )
    throw new Error('The answer names an option the question does not have.');
  const note = words === undefined || words === null || words === '' ? '' : text(words, 4000, 'The answer');
  const picked = Number.isInteger(option) ? question.options[option] : null;
  if (!picked && !note) throw new Error('Answer with one of the options, your own words, or both.');
  if (autoMode !== undefined && autoMode !== null && typeof autoMode !== 'boolean')
    throw new Error('Auto mode must be true, false or null.');
  return { picked, note, option };
}
const chosen = picked => (picked ? `Chosen: ${picked.label}${picked.detail ? ` (${picked.detail})` : ''}.` : '');
// Records an answer on the task (at most 20 kept) and sets the work's auto mode when the answer carries one.
function record(store, task, attemptId, { picked, note, option }, autoMode, by, extra = {}) {
  const answer = {
    attemptId,
    ...(picked ? { option, label: picked.label } : {}),
    ...(note ? { text: note } : {}),
    ...(autoMode !== undefined ? { autoMode } : {}),
    ...extra,
    by,
    at: new Date().toISOString(),
  };
  task.answers = [...(task.answers || []), answer].slice(-maxAnswers);
  if (autoMode === null) delete task.autoMode;
  else if (typeof autoMode === 'boolean') task.autoMode = autoMode;
  return answer;
}
const ready = (store, registries, task, direction) => {
  registries.workflows.direct(task, direction);
  task.status = 'ready';
  task.reason = '';
  delete task.autonomyNote;
  registries.workflows.stageProgress(store, task);
};

// Records an answer to the task's waiting question and gives it to the next attempt as its direction. The
// caller starts the task (the server queues it as Start does). `by` is the director, or auto mode.
export function answerQuestion(store, registries, task, fields, by) {
  const { attemptId } = fields,
    attempt = waitingQuestion(store, task);
  if (!attempt || attempt.id !== attemptId)
    throw new Error("Only the question of the task's latest attempt can be answered, while it waits for an answer.");
  const { question } = attempt,
    read = readAnswer(question, fields),
    answer = record(store, task, attemptId, read, fields.autoMode, by),
    who = by.type === 'auto-mode' ? 'Auto mode answered for the director' : 'The director answered';
  ready(
    store,
    registries,
    task,
    [
      `${who} the question of ${attemptId}: ${question.ask}`,
      chosen(read.picked),
      read.note ? `${by.type === 'auto-mode' ? 'Note' : 'The director wrote'}: ${read.note}` : '',
      'Continue from your saved work with this answer.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  store.putTask(task);
  store.event(
    'question_answered',
    task.id,
    attemptId,
    `${who}: ${read.picked ? read.picked.label : ''}${read.picked && read.note ? ' — ' : ''}${read.note}`.trim(),
  );
  return answer;
}

// Auto mode's answer the director may still change: the task's latest answer, given by auto mode, while the work
// it started is neither accepted nor closed (October 28, the page part's plan).
export function changeableAnswer(task) {
  const last = (task.answers || []).at(-1);
  if (!last || last.by?.type !== 'auto-mode') return null;
  if (['done', 'denied', 'backlog'].includes(task.status) || task.closed) return null;
  return last;
}

// The director changes auto mode's answer: the answer is recorded as theirs and becomes the next attempt's direction,
// which reworks what was done on auto mode's answer, continuing from the saved work. An attempt in Review is marked
// revision requested, as by Request revision. Returns `{ answer, stop }`: `stop` names a running attempt the caller
// stops; the task then starts again once that attempt has stopped (`task.answerChange`, Autonomy.settled).
export function changeAnswer(store, registries, task, fields) {
  const previous = changeableAnswer(task);
  if (!previous || previous.attemptId !== fields.attemptId)
    throw new Error("Only auto mode's latest answer can be changed, before the work it started is accepted or closed.");
  const asking = store.attempt(previous.attemptId),
    { question } = asking,
    read = readAnswer(question, fields),
    by = { type: 'director', at: new Date().toISOString() },
    answer = record(store, task, previous.attemptId, read, fields.autoMode, by, { replaces: 'auto-mode' }),
    direction = [
      `The director changed auto mode's answer to the question of ${previous.attemptId}: ${question.ask}`,
      previous.label ? `Auto mode had chosen: ${previous.label}.` : '',
      chosen(read.picked),
      read.note ? `The director wrote: ${read.note}` : '',
      "Rework what you did on auto mode's answer to follow this one, continuing from your saved work.",
    ]
      .filter(Boolean)
      .join('\n'),
    current = task.lastAttemptId && store.attempt(task.lastAttemptId);
  let stop = null;
  if (['running', 'stopping'].includes(task.status)) {
    // The attempt working on auto mode's answer stops first; the work starts again with this one.
    registries.workflows.direct(task, direction);
    task.answerChange = { attemptId: current?.id ?? null, at: by.at };
    stop = current?.status === 'running' ? current.id : null;
  } else {
    if (task.status === 'review' && current?.status === 'review') {
      current.status = 'revision_requested';
      current.revisionRequestedBy = { type: 'director', at: by.at, reason: direction };
      store.updateAttempt(current);
    }
    ready(store, registries, task, direction);
  }
  store.putTask(task);
  store.event(
    'answer_changed',
    task.id,
    previous.attemptId,
    `The director changed auto mode's answer: ${read.picked ? read.picked.label : ''}${read.picked && read.note ? ' — ' : ''}${read.note}`.trim(),
  );
  return { answer, stop };
}

// Once the attempt a changed answer stopped has finished, the work is ready to start again with that answer.
export function answerChangeSettled(store, registries, task) {
  if (!task.answerChange || ['running', 'stopping'].includes(task.status)) return false;
  delete task.answerChange;
  task.status = 'ready';
  task.reason = '';
  delete task.autonomyNote;
  registries.workflows.stageProgress(store, task);
  store.putTask(task);
  return true;
}

// The words a stopped task shows while its question waits.
export const questionReason = question => `Asks: ${question.ask}`;
