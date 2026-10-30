// An idea's planning conversation, read from its records: the director's idea, the checks before the plan on a code
// project, then each planning attempt as the planner's message with its plan cards, its questions and their answers,
// the director's reply that sent it back, or a line saying it stopped. Cards that changed since the plan before are
// marked. The page fetches the plan files and passes their texts in; nothing here fetches or sends anything.
import type { AttemptSummary, Task } from './api';
import { plural, totalsOf } from './evidence';
import { runRecords } from './journey';
import { workerName } from './names';
import { changeableAnswer, exchange, waitingQuestion } from './questions';
import type { RunStory, StudioState } from './studio-runs';

const checkKinds = ['studio-development:checks'];
const planKinds = ['studio-development:breakdown', 'general:plan'];
// An attempt that finished with a plan for the director to read, accept or send back.
const planned = ['review', 'accepted', 'revision_requested'];

// One card of a plan: a source story or a planned task, numbered in the plan's order. Who builds it is an agent
// (its workerId) or a staffing role; who reviews it is the project's reviewer, which a plan does not name. What it
// builds on is the numbers of the cards its dependencies name. A source story also lists its files.
export interface PlanCard {
  key: string;
  number: number;
  title: string;
  does: string;
  acceptance: string;
  builder: string;
  builderIs: 'worker' | 'role';
  dependencies: string[];
  buildsOn: number[];
  files?: string[];
  newFiles?: string[];
  deleteFiles?: string[];
}
// A card marked when it changed after the director's reply.
export type MarkedCard = PlanCard & { changed: boolean };

export interface IdeaFile {
  id: string;
  name: string;
  mediaType?: string;
  byteLength?: number;
}

export type ConversationEntry =
  | { type: 'idea'; at: string; words: string; files: IdeaFile[] }
  | { type: 'checks'; at: string; text: string; taskId: string; attemptId: string }
  | {
      type: 'planner';
      at: string;
      taskId: string;
      attemptId: string;
      workerId: string;
      name: string;
      summary: string;
      // The plan's cards, or null when its file was not passed in or could not be read.
      cards: MarkedCard[] | null;
    }
  | {
      type: 'question';
      at: string;
      taskId: string;
      attemptId: string;
      workerId: string;
      name: string;
      ask: string;
      why?: string;
      options: { label: string; detail?: string }[];
      recommended: number | null;
      waiting: boolean;
    }
  | {
      type: 'answer';
      at: string;
      taskId: string;
      attemptId: string;
      by: 'director' | 'auto-mode';
      name: string;
      words: string;
      replaces?: 'auto-mode';
      changeable: boolean;
    }
  | { type: 'director'; at: string; taskId: string; attemptId: string; words: string }
  | {
      type: 'stopped';
      at: string;
      taskId: string;
      attemptId: string;
      workerId: string;
      status: string;
      text: string;
      reason?: string;
      next: string;
    };

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const words = (value: unknown) => (typeof value === 'string' ? value : '');
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A plan's cards from its file's text: a source breakdown's stories or a graph proposal's tasks, in order. Null for
// text that is not JSON, another schema, or items without their key and title.
export function planCards(text: string): PlanCard[] | null {
  let plan: unknown;
  try {
    plan = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(plan)) return null;
  const source = plan.schemaVersion === 'source-breakdown-v1',
    items = source ? plan.stories : plan.schemaVersion === 'graph-proposal-v1' ? plan.tasks : null;
  if (!Array.isArray(items) || !items.length) return null;
  if (!items.every(item => isObject(item) && typeof item.key === 'string' && typeof item.title === 'string'))
    return null;
  const list = items as Record<string, unknown>[],
    numbers = new Map(list.map((item, index) => [item.key as string, index + 1]));
  return list.map((item, index) => {
    const dependencies = strings(item.dependencies),
      worker = words(item.workerId);
    return {
      key: item.key as string,
      number: index + 1,
      title: item.title as string,
      does: words(source ? item.scope : item.brief),
      acceptance: words(item.acceptance),
      builder: worker || words(item.role),
      builderIs: worker ? 'worker' : 'role',
      dependencies,
      buildsOn: dependencies.map(key => numbers.get(key)).filter((number): number is number => number !== undefined),
      ...(source
        ? { files: strings(item.files), newFiles: strings(item.newFiles), deleteFiles: strings(item.deleteFiles) }
        : {}),
    };
  });
}

// The plan file a planning attempt carries: its source breakdown or its graph proposal.
export function planArtifact(attempt?: AttemptSummary) {
  const artifacts = attempt?.artifacts ?? [];
  return (
    artifacts.find(item => item.kind === 'source-breakdown' || item.kind === 'graph-proposal') ??
    artifacts.find(item => !item.kind && ['source-breakdown.json', 'plan.json'].includes(item.path)) ??
    null
  );
}

const sameList = (a: string[] = [], b: string[] = []) => [...a].sort().join('\n') === [...b].sort().join('\n');

// A plan's cards marked changed against the plan before it: a card is changed when no earlier card had its key, or
// when what it says, who builds it, what it builds on or (for a source story) its files differ. The first plan, with
// no plan before it, marks nothing.
export function markChanged(cards: PlanCard[], before: PlanCard[] | null): MarkedCard[] {
  const earlier = new Map((before ?? []).map(card => [card.key, card]));
  return cards.map(card => {
    const was = earlier.get(card.key);
    const changed =
      before !== null &&
      (!was ||
        was.title !== card.title ||
        was.does !== card.does ||
        was.acceptance !== card.acceptance ||
        was.builder !== card.builder ||
        was.builderIs !== card.builderIs ||
        !sameList(was.dependencies, card.dependencies) ||
        !sameList(was.files, card.files) ||
        !sameList(was.newFiles, card.newFiles) ||
        !sameList(was.deleteFiles, card.deleteFiles));
    return { ...card, changed };
  });
}

// The first line of a recorded error or stop reason, without its closing full stop.
const firstLine = (text?: string) =>
  String(text ?? '')
    .trim()
    .split('\n')[0]!
    .trim()
    .replace(/\.+$/, '');

// The checks before the plan, in one line: how many of the current code's tests passed, from the checks step's
// accepted attempt, else its latest finished one. No line until a checks attempt has finished.
function checksEntry(task: Task, own: AttemptSummary[]): ConversationEntry | null {
  const attempt = own.find(item => item.status === 'accepted') ?? own.filter(item => item.finishedAt).at(-1);
  if (!attempt?.finishedAt) return null;
  const totals = totalsOf(attempt),
    tests = totals?.tests ?? 0,
    pass = totals?.pass ?? 0;
  return {
    type: 'checks',
    at: attempt.finishedAt,
    text: tests
      ? pass === tests
        ? `Checks ran on the current code: ${tests} ${plural(tests, 'test')} passed.`
        : `Checks ran on the current code: ${pass} of ${tests} ${plural(tests, 'test')} passed.`
      : 'Checks ran on the current code.',
    taskId: task.id,
    attemptId: attempt.id,
  };
}

// The director's reply that sent a plan back, as their words. A revision the house rules asked for is not the
// director's, and the one recorded when the director changed auto mode's answer reads as that answer instead.
function reply(task: Task, attempt: AttemptSummary): ConversationEntry | null {
  const by = attempt.revisionRequestedBy as { type?: string; at?: string; reason?: string } | undefined;
  if (!by?.at || !by.reason?.trim() || (by.type ?? 'director') !== 'director') return null;
  const answers = Array.isArray(task.answers) ? (task.answers as { replaces?: string; at?: string }[]) : [];
  if (answers.some(answer => answer.replaces === 'auto-mode' && answer.at === by.at)) return null;
  return { type: 'director', at: by.at, taskId: task.id, attemptId: attempt.id, words: by.reason };
}

// Entries in the order they happened; an entry without a readable time keeps its place after the one before it.
function inTimeOrder(entries: ConversationEntry[]) {
  let last = -Infinity;
  return entries
    .map((entry, index) => {
      const time = Date.parse(entry.at);
      if (Number.isFinite(time)) last = time;
      return { entry, time: last, index };
    })
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(item => item.entry);
}

// The conversation of one idea, from its run's records: the idea, the checks line on a code project, then the
// planning attempts oldest first with their questions, answers and the director's replies where they happened.
// `texts` holds each planning attempt's plan file text by attempt id, as the page fetched them.
export function conversation(
  run: RunStory,
  state: StudioState,
  texts: Readonly<Record<string, string | undefined>> | ReadonlyMap<string, string> = {},
): ConversationEntry[] {
  const { tasks, attempts } = runRecords(run, state),
    own = [...tasks.values()],
    textOf = (id: string) => (texts instanceof Map ? texts.get(id) : (texts as Record<string, string>)[id]);
  const head: ConversationEntry[] = [
    {
      type: 'idea',
      at: run.startedAt,
      words: run.brief,
      files: (run.directorInputs ?? []).filter(
        (item): item is IdeaFile => isObject(item) && typeof item.id === 'string' && typeof item.name === 'string',
      ),
    },
  ];
  const checks = own.find(task => checkKinds.includes(task.kind));
  const line = checks && checksEntry(checks, attempts(checks.id));
  if (line) head.push(line);

  const planning = own
    .filter(task => planKinds.includes(task.kind))
    .flatMap(task => attempts(task.id).map(attempt => ({ task, attempt })))
    .sort((a, b) => Date.parse(String(a.attempt.startedAt ?? '')) - Date.parse(String(b.attempt.startedAt ?? '')));
  const body: ConversationEntry[] = [];
  let before: PlanCard[] | null = null;
  for (const { task, attempt } of planning) {
    const workerId = attempt.workerId ?? task.workerId ?? '',
      name = workerName(state, workerId),
      at = String(attempt.finishedAt ?? attempt.startedAt ?? '');
    if (['running', 'stopping'].includes(attempt.status)) continue;
    const told = attempt.status === 'blocked' ? exchange(task, attempt) : null;
    if (planned.includes(attempt.status)) {
      const text = textOf(attempt.id),
        cards = text === undefined ? null : planCards(text);
      body.push({
        type: 'planner',
        at,
        taskId: task.id,
        attemptId: attempt.id,
        workerId,
        name,
        summary: attempt.result?.summary ?? '',
        cards: cards && markChanged(cards, before),
      });
      if (cards) before = cards;
    } else if (told) {
      const { question } = told,
        changeable = changeableAnswer(task);
      body.push({
        type: 'question',
        at,
        taskId: task.id,
        attemptId: attempt.id,
        workerId,
        name,
        ask: question.ask ?? '',
        ...(question.why ? { why: question.why } : {}),
        options: (question.options ?? []).map(option => ({
          label: option.label,
          ...(option.detail ? { detail: option.detail } : {}),
        })),
        recommended: typeof question.recommended === 'number' ? question.recommended : null,
        waiting: waitingQuestion(task, attempts(task.id))?.id === attempt.id,
      });
      for (const answer of told.answers) {
        const auto = answer.by?.type === 'auto-mode';
        body.push({
          type: 'answer',
          at: String(answer.at ?? answer.by?.at ?? at),
          taskId: task.id,
          attemptId: attempt.id,
          by: auto ? 'auto-mode' : 'director',
          name: auto ? 'Auto mode' : 'You',
          words: [answer.label, answer.text].filter(Boolean).join(' — '),
          ...(answer.replaces ? { replaces: answer.replaces } : {}),
          changeable: auto && answer === changeable,
        });
      }
    } else {
      const outcome = attempt.status === 'failed' ? 'failed' : 'stopped',
        reason = firstLine(
          attempt.error || (attempt.stopContext as { reason?: string } | undefined)?.reason || undefined,
        );
      body.push({
        type: 'stopped',
        at,
        taskId: task.id,
        attemptId: attempt.id,
        workerId,
        status: attempt.status,
        text: `${name}'s plan attempt ${outcome}${reason ? `: ${reason}.` : '.'}`,
        ...(reason ? { reason } : {}),
        next: 'Start the plan step again from its page.',
      });
    }
    const sent = reply(task, attempt);
    if (sent) body.push(sent);
  }
  return [...head, ...inTimeOrder(body)];
}
