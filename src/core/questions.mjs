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

// Records an answer to the task's waiting question and gives it to the next attempt as its direction. The
// caller starts the task (the server queues it as Start does). `by` is the director, or auto mode.
export function answerQuestion(store, registries, task, { attemptId, option, text: words }, by) {
  const attempt = waitingQuestion(store, task);
  if (!attempt || attempt.id !== attemptId)
    throw new Error("Only the question of the task's latest attempt can be answered, while it waits for an answer.");
  const { question } = attempt;
  if (
    option !== undefined &&
    option !== null &&
    !(Number.isInteger(option) && option >= 0 && option < question.options.length)
  )
    throw new Error('The answer names an option the question does not have.');
  const note = words === undefined || words === null || words === '' ? '' : text(words, 4000, 'The answer');
  const picked = Number.isInteger(option) ? question.options[option] : null;
  if (!picked && !note) throw new Error('Answer with one of the options, your own words, or both.');
  const answer = {
    attemptId,
    ...(picked ? { option, label: picked.label } : {}),
    ...(note ? { text: note } : {}),
    by,
    at: new Date().toISOString(),
  };
  task.answers = [...(task.answers || []), answer].slice(-maxAnswers);
  const who = by.type === 'auto-mode' ? 'Auto mode answered for the director' : 'The director answered';
  const direction = [
    `${who} the question of ${attemptId}: ${question.ask}`,
    picked ? `Chosen: ${picked.label}${picked.detail ? ` (${picked.detail})` : ''}.` : '',
    note ? `${by.type === 'auto-mode' ? 'Note' : 'The director wrote'}: ${note}` : '',
    'Continue from your saved work with this answer.',
  ]
    .filter(Boolean)
    .join('\n');
  registries.workflows.direct(task, direction);
  task.status = 'ready';
  task.reason = '';
  delete task.autonomyNote;
  registries.workflows.stageProgress(store, task);
  store.putTask(task);
  store.event(
    'question_answered',
    task.id,
    attemptId,
    `${who}: ${picked ? picked.label : ''}${picked && note ? ' — ' : ''}${note}`.trim(),
  );
  return answer;
}

// The words a stopped task shows while its question waits.
export const questionReason = question => `Asks: ${question.ask}`;
