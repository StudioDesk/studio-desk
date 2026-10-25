// The board's reading of the work (the canvas's Board, v1.0 item 23): which of five columns a task stands in, what
// its card says, and the filters. A stopped or waiting task stays in the column where it stopped, with a chip that
// says why. Nothing here sends anything.
import type { AttemptSummary, Task } from './api';
import { decisionState, fileRequest, askedPaths } from './decisions';
import type { AgentState } from './design/agent-kit.js';
import { diffStatOf, openPhaseOf, testingPhases, took, totalsOf } from './evidence';
import { agentState } from './faces';
import { workerName } from './names';
import { isSourceStory, kindLabel, standing, storyPeople } from './story';
import { active, type RunStory, type StudioState } from './studio-runs';
import { placeIn, quoted } from './today';

export type ColumnId = 'planned' | 'ready' | 'progress' | 'review' | 'done';
export const columns: { id: ColumnId; name: string }[] = [
  { id: 'planned', name: 'Planned' },
  { id: 'ready', name: 'Ready' },
  { id: 'progress', name: 'In progress' },
  { id: 'review', name: 'Review' },
  { id: 'done', name: 'Done' },
];

const kindOf = (attempt?: AttemptSummary) => (attempt?.assignment as { kind?: string } | undefined)?.kind;

// The column a task stands in; closed and denied work stands in none unless it is shown, then with what is done.
export function columnOf(task: Task, showClosed = false): ColumnId | null {
  if (task.closed || ['denied', 'cancelled'].includes(task.status)) return showClosed ? 'done' : null;
  const approval = (task.approval as { status?: string } | undefined)?.status;
  if (approval === 'pending' || task.status === 'backlog') return 'planned';
  const stage = task.sourceStage as { phase?: string; current?: string } | null | undefined,
    source = isSourceStory(task);
  if (task.status === 'done') return !source || stage?.current === 'integrated' ? 'done' : 'review';
  if (task.status === 'review') return 'review';
  if (source && stage?.phase && stage.phase !== 'implementing') return 'review';
  if (active(task)) return 'progress';
  if (task.status === 'ready') return 'ready';
  // Failed or blocked: where it stopped. Blocked work that never started waits with what is ready.
  return task.status === 'failed' || task.lastAttemptId ? 'progress' : 'ready';
}

export type Tone = 'you' | 'live' | 'ok' | 'bad' | 'wait';
export interface CardChip {
  tone: Tone;
  label: string;
}

// The prerequisite a ready task waits for, named as the board names it: "story 2", or its title.
function waitsFor(task: Task, state: StudioState, stories: RunStory[]) {
  const open = (task.dependencies ?? [])
    .map(id => state.tasks.find(item => item.id === id))
    .find(item => item && item.status !== 'done');
  if (!open) return null;
  const place = placeIn(stories, open);
  return place && place.index > 0 ? `story ${place.index}` : quoted(open.title, 32);
}

export interface Card {
  task: Task;
  column: ColumnId;
  // "Story 3", or the task type's short name.
  eyebrow: string;
  chip?: CardChip;
  // The chip that waits: "Waits for story 2".
  waits?: string;
  // A running attempt's time used of its limit, and its number.
  running?: { share: number; attempt: number; used: string };
  // A blocked editor's file request: "+ public/app.js".
  asks?: { path: string; sign: string }[];
  // A change ready to integrate: its size, tests and review.
  change?: { added?: number; removed?: number; tests?: string };
  // A review that asked for changes: its findings and the first finding's place.
  blocking?: { count: number; place?: string };
  commit?: string;
  idea?: { runId: string; text: string; index: number };
  since?: string;
  workerId?: string;
  // The face of the agent the card names, telling its part in this work (faces.ts).
  face: AgentState;
  foot: string;
  calls: boolean;
}

const clockOf = (value?: string | null, now = new Date()) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// Everything a card shows of its task.
export function cardOf(
  task: Task,
  state: StudioState,
  stories: RunStory[],
  showClosed = false,
  now = Date.now(),
): Card | null {
  const column = columnOf(task, showClosed);
  if (!column) return null;
  const place = placeIn(stories, task),
    stand = standing(task, state),
    decision = decisionState(task, state),
    people = storyPeople(task, state),
    attempts = state.attempts.filter(item => item.taskId === task.id),
    latest = attempts.find(item => item.id === task.lastAttemptId),
    running = attempts.find(item => ['running', 'stopping'].includes(item.status)),
    source = isSourceStory(task),
    who = workerName(state, task.workerId),
    calls = stand.tone === 'you';
  const card: Card = {
    task,
    column,
    eyebrow: place && place.index > 0 ? `Story ${place.index}` : (shortKinds[task.kind] ?? kindLabel(task, state)),
    foot: who,
    calls,
    workerId: task.workerId,
    face: agentState(state, task.workerId, task),
  };
  if (place) {
    const runs = stories.map(story => story.id);
    card.idea = { runId: place.run.id, text: quoted(place.run.brief, 34), index: runs.indexOf(place.run.id) };
  } else card.since = `Started ${clockOf(task.createdAt) || 'earlier'}`;
  if (task.closed || ['denied', 'cancelled'].includes(task.status)) {
    card.chip = { tone: 'wait', label: task.status === 'cancelled' ? 'Cancelled' : 'Closed' };
    return card;
  }
  if (column === 'planned') {
    card.chip = { tone: 'you', label: 'Approve?' };
    card.foot = `${who} · ${limitsOf(task)}`;
    return card;
  }
  if (column === 'ready') {
    const waits = waitsFor(task, state, stories);
    if (waits) card.waits = `Waits for ${waits}`;
    else if (calls) card.chip = { tone: 'you', label: stand.chip ?? 'Your call' };
    card.foot = `${who} · ${limitsOf(task)}`;
    return card;
  }
  if (column === 'progress') {
    if (running) {
      const started = Date.parse(String(running.startedAt ?? '')),
        limit = (task.maxSeconds ?? 0) * 1000,
        used = Number.isFinite(started) ? Math.max(0, now - started) : 0,
        builds = attempts.filter(item => kindOf(item) !== 'studio-development:change-review');
      card.chip = {
        tone: 'live',
        label: !source ? 'Working' : testingPhases.includes(openPhaseOf(running) ?? '') ? 'Testing' : 'Building',
      };
      card.running = {
        share: limit ? Math.min(100, (used / limit) * 100) : 0,
        attempt: builds.indexOf(running) + 1 || attempts.length,
        used: `${Math.max(1, Math.round(used / 60000))} of ${Math.round(limit / 60000)} min`,
      };
      card.foot = `${workerName(state, running.workerId)} · ${task.id}`;
      return card;
    }
    const asking = fileRequest(task, state);
    if (asking.request) card.asks = askedPaths(task, asking.request).slice(0, 2);
    card.chip = calls
      ? { tone: 'you', label: 'Your call' }
      : // The controller's own wait (a usage reset, its turn) is not a stop.
        { tone: task.controllerWait ? 'wait' : 'bad', label: task.status === 'failed' ? 'Stopped' : 'Waiting' };
    card.foot = `${who} · ${task.id}`;
    return card;
  }
  if (column === 'review') {
    const review = people.review,
      reviewer = people.reviewer;
    if (decision.integrable) {
      const stat = diffStatOf(people.candidate),
        totals = totalsOf(people.candidate);
      card.chip = { tone: 'you', label: 'Integrate?' };
      card.change = {
        ...(stat ? { added: stat.added, removed: stat.removed } : {}),
        ...(totals?.tests ? { tests: `${totals.pass}/${totals.tests}` } : {}),
      };
    } else if (decision.returnable) {
      const findings = (review?.candidateReviewFindings as string[] | undefined) ?? [],
        place = /^([\w@./-]+\.\w+(?::\d+)?)/.exec(String(findings[0] ?? ''))?.[1];
      card.chip = { tone: 'you', label: 'Changes asked' };
      card.blocking = { count: findings.length, place };
    } else if (calls) card.chip = { tone: 'you', label: stand.chip ?? 'Your call' };
    else if (active(task)) card.chip = { tone: 'live', label: 'Reviewing' };
    else if (decision.progress?.busy) card.chip = { tone: 'live', label: 'Integrating' };
    else if (task.status === 'review') card.chip = { tone: 'you', label: 'Accept?' };
    card.foot = review?.finishedAt ? `${reviewer} reviewed` : active(task) ? `${reviewer} reviewing` : who;
    card.workerId = review?.workerId ?? people.reviewerId ?? task.workerId;
    return card;
  }
  // Done: what it came to, and when.
  const finished = latest?.finishedAt ?? attempts.at(-1)?.finishedAt,
    commit = (people.review?.sourceIntegration as { repository?: { commit?: string } } | undefined)?.repository?.commit;
  card.chip = { tone: 'ok', label: source ? 'Integrated' : 'Accepted' };
  if (commit) card.commit = commit.slice(0, 7);
  const totals = totalsOf(latest),
    minutes = took(latest);
  card.foot = commit
    ? ''
    : [
        who,
        task.kind === 'studio-development:breakdown' || task.kind === 'general:plan'
          ? `${(task.proposedTaskIds as string[] | undefined)?.length ?? 0} stories`
          : totals?.tests
            ? `${totals.pass}/${totals.tests}`
            : minutes && !source
              ? `${minutes} min`
              : '',
        commit ? '' : clockOf(finished),
      ]
        .filter(Boolean)
        .join(' · ');
  if (commit) card.since = clockOf(finished);
  return card;
}

// A card's kind in a word, as the board draws it.
const shortKinds: Record<string, string> = {
  'studio-development:change': 'Story',
  'studio-development:breakdown': 'Plan',
  'general:plan': 'Plan',
  'studio-development:checks': 'Checks',
  'studio-development:change-review': 'Review',
  'general:review': 'Review',
  'general:work': 'Work',
};

const limitsOf = (task: Task) =>
  `${Math.round((task.maxSeconds ?? 0) / 60)} min · ${task.maxAttempts ?? 0} ${task.maxAttempts === 1 ? 'attempt' : 'attempts'}`;

export type Filter = 'open' | 'calls' | 'working' | 'waiting';
// Open work is every card not done; your calls only the director can move; working runs now; waiting is neither.
export function matches(card: Card, filter: Filter) {
  if (filter === 'open') return card.column !== 'done';
  if (filter === 'calls') return card.calls;
  if (filter === 'working') return active(card.task) || card.chip?.label === 'Integrating';
  return card.column !== 'done' && !card.calls && !active(card.task) && card.chip?.label !== 'Integrating';
}

// A search finds a task by its title, its ID or a file its story may change.
export function found(card: Card, search: string) {
  const text = search.trim().toLowerCase();
  if (!text) return true;
  return [card.task.title, card.task.id, card.task.brief ?? ''].some(value => value.toLowerCase().includes(text));
}

// The newest work first: what finished last, else what was made last.
export const newest = (state: StudioState) => (a: Card, b: Card) => {
  const at = (card: Card) =>
    Date.parse(
      String(
        state.attempts.find(item => item.id === (card.task.acceptedAttemptId ?? card.task.lastAttemptId))?.finishedAt ??
          card.task.createdAt ??
          '',
      ),
    ) || 0;
  return at(b) - at(a);
};
