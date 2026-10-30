// The board's reading of the work (the canvas's Board, v1.0 item 23): which of five columns a task stands in, what
// its card says, and the filters. A stopped or waiting task stays in the column where it stopped, with a chip that
// says why. An idea's checks and plan have no cards of their own: until its plan is official, the idea's own card
// tells its planning. Nothing here sends anything.
import type { AttemptSummary, Task } from './api';
import { decisionState, fileRequest, askedPaths } from './decisions';
import type { AgentState } from './design/agent-kit.js';
import { diffStatOf, openPhaseOf, testingPhases, took, totalsOf } from './evidence';
import { agentState } from './faces';
import { checkKinds, journeyStories, planKinds } from './journey';
import { workerName } from './names';
import { planningOf } from './planning';
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
  // The controller's own words for a wait, shown when the chip is pointed at.
  title?: string;
}

// The shared rules' passive waits (public/runs.js taskExplanation): the controller holds the work, and nothing is
// needed from the director. Mirrors the rules' wait kinds.
const controllerWaits = [
  'queued',
  'retry-queued',
  'slot-wait',
  'resource-wait',
  'test-turn-wait',
  'prerequisite-wait',
  'prerequisite-acceptance',
  'subscription-wait',
  'integration-pending',
];
// The rules' calls whose action is Accept result: a completed result, or a review that asked for changes.
const acceptKinds = ['result-approval', 'review-result'];

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
  // An idea's card (ideaCards): the idea it opens in place of a task, its own title in place of its step's, the
  // line under the title, and the idea's whole words a search finds it by.
  runId?: string;
  title?: string;
  text?: string;
  words?: string;
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
  // The idea it belongs to: its words and its place among the live ideas, then the finished ones, for its hue.
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

// The ideas the records name that the live stories do not tell, all of their work settled: a page of settled work's,
// or the live set's for a prerequisite from a finished idea. Newest first, after the live ideas, so their hues differ.
export function finishedIdeas(state: StudioState, stories: RunStory[]) {
  const live = new Set(stories.map(story => story.id));
  return (state.ideas ?? [])
    .filter(idea => !live.has(idea.id))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

// An idea's checks or plan step: a live idea's, or one the records name.
const planningStep = (task: Task, state: StudioState, stories: RunStory[]) =>
  [...checkKinds, ...planKinds].includes(task.kind) &&
  (!!placeIn(stories, task) || (state.ideas ?? []).some(idea => idea.taskIds.includes(task.id)));

// The settled work the board knows of and draws no card for, an idea's checks and plan, so that Done counts only what
// it can show: those accepted, and those closed, denied or cancelled. Those on pages not read yet it cannot know of.
export function unshown(state: StudioState, stories: RunStory[]) {
  const steps = state.tasks.filter(task => planningStep(task, state, stories));
  return {
    accepted: steps.filter(task => task.status === 'done' && !task.closed).length,
    closed: steps.filter(task => task.closed || ['denied', 'cancelled'].includes(task.status)).length,
  };
}

// Everything a card shows of its task. An idea's checks and plan have none, in any column.
export function cardOf(
  task: Task,
  state: StudioState,
  stories: RunStory[],
  showClosed = false,
  now = Date.now(),
): Card | null {
  const column = columnOf(task, showClosed);
  if (!column || planningStep(task, state, stories)) return null;
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
  const doneIdeas = place ? [] : finishedIdeas(state, stories),
    named = doneIdeas.findIndex(idea => idea.taskIds.includes(task.id));
  if (place) {
    const runs = stories.map(story => story.id);
    card.idea = { runId: place.run.id, text: quoted(place.run.brief, 34), index: runs.indexOf(place.run.id) };
  } else if (named >= 0) {
    const idea = doneIdeas[named]!;
    card.idea = { runId: idea.id, text: quoted(idea.brief, 34), index: stories.length + named };
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
    // Only the shared rules' explanation says whether a card in review waits for the director: the chip in the
    // director's color and the Your calls filter both follow it.
    const review = people.review,
      reviewer = people.reviewer,
      { explanation } = decision,
      yours = !!explanation.requiresDirector;
    card.calls = yours;
    if (yours && decision.integrable) {
      const stat = diffStatOf(people.candidate),
        totals = totalsOf(people.candidate);
      card.chip = { tone: 'you', label: 'Integrate?' };
      card.change = {
        ...(stat ? { added: stat.added, removed: stat.removed } : {}),
        ...(totals?.tests ? { tests: `${totals.pass}/${totals.tests}` } : {}),
      };
    } else if (yours && decision.returnable) {
      const findings = (review?.candidateReviewFindings as string[] | undefined) ?? [],
        place = /^([\w@./-]+\.\w+(?::\d+)?)/.exec(String(findings[0] ?? ''))?.[1];
      card.chip = { tone: 'you', label: 'Changes asked' };
      card.blocking = { count: findings.length, place };
    } else if (yours)
      card.chip = {
        tone: 'you',
        label: stand.chip ?? (acceptKinds.includes(explanation.kind) ? 'Accept?' : 'Your call'),
      };
    else if (active(task)) card.chip = { tone: 'live', label: 'Reviewing' };
    else if (decision.progress?.busy) card.chip = { tone: 'live', label: 'Integrating' };
    // The controller holds it: the chip says so in grey, with the controller's own reason.
    else if (task.controllerWait || task.queued || controllerWaits.includes(explanation.kind))
      card.chip = { tone: 'wait', label: 'Waiting', title: explanation.reason };
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

// One card for each live idea whose plan is not official yet, telling its planning (planning.ts), in Planned where its
// stories will land. It is built on the step the idea is on, so the filters, the sort and the person filter read it
// as they would that step: your call while it waits for the director, working while the step runs, otherwise waiting.
export function ideaCards(state: StudioState, stories: RunStory[], now = Date.now()): Card[] {
  return stories.flatMap((run, index): Card[] => {
    const planning = planningOf(run, state, now),
      task = planning && state.tasks.find(item => item.id === planning.taskId);
    if (!planning || !task) return [];
    const words = (run.brief || run.title).trim(),
      calls = planning.state === 'you';
    return [
      {
        task,
        column: 'planned',
        eyebrow: 'Idea',
        runId: run.id,
        title: words.split('\n')[0]!,
        ...(planning.text ? { text: planning.text } : {}),
        words,
        chip: {
          tone: calls ? 'you' : planning.state === 'stopped' ? 'bad' : active(task) ? 'live' : 'wait',
          label: planning.label,
        },
        idea: { runId: run.id, text: quoted(run.brief, 34), index },
        workerId: planning.workerId,
        face: agentState(state, planning.workerId, task),
        foot: [workerName(state, planning.workerId), planning.minutes ? `${planning.minutes} min` : '']
          .filter(Boolean)
          .join(' · '),
        calls,
      },
    ];
  });
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

// A search finds a task by its title, its ID or a file its story may change, and an idea's card by the idea's words.
export function found(card: Card, search: string) {
  const text = search.trim().toLowerCase();
  if (!text) return true;
  return [card.title ?? card.task.title, card.task.id, card.words ?? card.task.brief ?? ''].some(value =>
    value.toLowerCase().includes(text),
  );
}

// An idea lane's quiet details, its stories counted as the Ideas list counts them: "1 of 3 done · 1 running · waits
// for you". An idea with no stories yet says nothing of them.
export function laneDetails(run: RunStory, state: StudioState) {
  const stories = journeyStories(run, state),
    count = (tone: Tone) => stories.filter(story => story.chip.tone === tone).length;
  return [
    stories.length ? `${count('ok')} of ${stories.length} done` : '',
    count('live') ? `${count('live')} running` : '',
    count('you') ? 'waits for you' : '',
  ]
    .filter(Boolean)
    .join(' · ');
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
