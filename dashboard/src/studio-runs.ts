// The run stories, task explanations and Needs you rules the current dashboard uses (public/runs.js), loaded
// unchanged so both dashboards say the same thing until the old one is removed. They read a state shaped like
// the old one's: a project's shell with the records a page holds.
import '../../public/runs.js';
// The story page's task actions as shared rules the controller can run too (public/task-actions.js), after runs.js.
import '../../public/task-actions.js';
import type { AttemptSummary, Live, RunRecord, Shell, Task, TaskAction } from './api';

export type StudioState = Shell & Live;

export interface Explanation {
  kind: string;
  reason: string;
  details: string[];
  next: string;
  action: string | null;
  requiresDirector?: boolean;
  attemptId?: string;
  // A command request's refused commands, as Claude Code reported them.
  commands?: string[];
}

export interface NeedsItem extends Explanation {
  taskId: string;
  text: string;
  cleanup: boolean;
  canClose: boolean;
}

// How a run stands. Pages decide from state, a fixed name; label and text are the words shown.
export interface Outcome {
  state: 'closed' | 'cancelled' | 'in-progress' | 'needs-you' | 'integrated' | 'stopped' | 'finished' | 'idle';
  tone: 'ok' | 'busy' | 'wait' | 'bad' | 'muted';
  label: string;
  text: string;
}

export interface RunStep {
  at: string;
  kind: string;
  tone: string;
  text: string;
  taskId?: string;
  attemptId?: string;
  detail?: string;
  tests?: string[];
  execution?: { attemptId: string; label: string };
}

export interface GraphNode {
  taskId: string;
  title: string;
  kind?: string;
  status: string;
  worker: string;
  revision?: number;
}

export interface RunStory {
  id: string;
  name: string;
  title: string;
  brief: string;
  directorInputs: unknown[];
  graph: {
    revisions: number;
    envelope: { nodes: number; attemptSeconds: number } | null;
    legacy: boolean;
    stages: GraphNode[][];
  } | null;
  archive?: { archived?: boolean };
  startedAt: string;
  taskIds: string[];
  steps: RunStep[];
  needsYou: NeedsItem[];
  outcome: Outcome;
}

export interface SourceProgress {
  stage: {
    phase?: string;
    current?: string;
    review?: { workerId?: string };
    reviewTask?: { workerId?: string; team?: string };
  };
  busy: boolean;
  label: string;
  status: string;
  reason: string;
  journal?: { state?: string } | null;
}

interface StudioRunsModule {
  buildRunStories(state: StudioState): RunStory[];
  runMembership(tasks: Task[]): Map<string, string>;
  taskExplanation(task: Task, state: StudioState): Explanation;
  needsYou(state: StudioState, tasks: Task[], explain: (task: Task, state: StudioState) => Explanation): NeedsItem[];
  sourceProgress(task: Task, attempts: AttemptSummary[], pending: unknown): SourceProgress | null;
  awaitedSource(task: Task, find: (id: string) => Task | undefined): Task | null;
  integrationReview(task: Task, attempts: AttemptSummary[], pending: unknown, tasks: Task[]): AttemptSummary | null;
  holdItems(state: StudioState, explain: (task: Task, state: StudioState) => Explanation): HoldItem[];
  integrationAction(state: StudioState, task: Task, attempt: AttemptSummary): string;
  directorExplanation(task: Task, state: StudioState): Explanation;
  needsYouItems(state: StudioState, runs: RunStory[]): HomeItem[];
}

// One action the story page offers on a task (public/task-actions.js): the words on its button, its emphasis, whether
// it is a closing action behind More actions, the route it is sent to and the body fields that route takes (api.ts).
export type { TaskAction, TaskActionField } from './api';
// What the page reads besides the records: the controller's answer to a landed story's bring-back read.
export interface TaskActionReads {
  bringBack?: { lines: ({ line: string; through: string[] } | { line: string; reason: string })[] };
}
export interface StudioTaskActionsModule {
  taskActions(task: Task, state: StudioState, reads?: TaskActionReads): TaskAction[];
  // Whether the task is a source story that landed, whose actions name the lines its bring-back read reaches.
  bringBackable(task: Task, state: StudioState): boolean;
}

// A CLI's usage hold (public/runs.js holdItems): one item for the CLI, with the work waiting on it. It needs the
// director only when no reset time is known.
export interface HoldItem {
  kind: 'subscription-hold';
  provider: string;
  label: string;
  resetAt: string | null;
  resetTime: string | null;
  taskIds: string[];
  reason: string;
  next: string;
  action: string | null;
  requiresDirector: boolean;
}

const rules = (globalThis as unknown as { StudioRuns: StudioRunsModule }).StudioRuns;
// The task actions the shared rules list (public/task-actions.js); the story page keeps its own conditions for now.
export const taskActions: StudioTaskActionsModule['taskActions'] = (task, state, reads) =>
  (globalThis as unknown as { StudioTaskActions: StudioTaskActionsModule }).StudioTaskActions.taskActions(
    task,
    state,
    reads,
  );
// Whether the task is a source story that landed, whose actions name the lines it can be brought back to.
export const bringBackable: StudioTaskActionsModule['bringBackable'] = (task, state) =>
  (globalThis as unknown as { StudioTaskActions: StudioTaskActionsModule }).StudioTaskActions.bringBackable(
    task,
    state,
  );

export const statusLabels: Record<string, string> = {
  backlog: 'Planned',
  denied: 'Denied',
  running: 'Working',
  review: 'Needs review',
  ready: 'Ready',
  done: 'Accepted',
  stopping: 'Stopping',
  failed: 'Failed',
  cancelled: 'Cancelled',
  blocked: 'Waiting',
};
export const active = (task: Task) => task.status === 'running' || task.status === 'stopping';

// The attempt a task records under the name given, from this project's summaries.
export const recordedAttempt = (state: StudioState, task: Task, id = task.lastAttemptId) =>
  state.attempts.find(
    attempt =>
      attempt.id === id && attempt.taskId === task.id && (!attempt.projectId || attempt.projectId === state.project.id),
  );

// The words of a passing review's integration action in the older two-task layout (public/runs.js integrationAction).
export const integrationAction = (state: StudioState, task: Task, attempt: AttemptSummary) =>
  rules.integrationAction(state, task, attempt);

// The director's explanation of a task (public/runs.js directorExplanation): the shared rules, plus a passing review
// in the older two-task layout that waits for integration. The controller's list of calls reads the same rule.
export const explain = (task: Task, state: StudioState): Explanation => rules.directorExplanation(task, state);

// Each CLI's usage hold once, with its reset time when the CLI named one and the work waiting on it.
export const usageHolds = (state: StudioState) => rules.holdItems(state, explain);

// Proposed work waits for the accepted result of the step it was proposed from, while that step can still be
// accepted.
export const awaitedSource = (state: StudioState, task: Task) =>
  rules.awaitedSource(task, id => state.tasks.find(item => item.id === id));

// The passing review a source story would integrate now, when it may.
export const integrationReview = (state: StudioState, task: Task) =>
  rules.integrationReview(task, state.attempts, state.autonomy?.pendingIntegration, state.tasks);

export const progressOf = (state: StudioState, task: Task) =>
  rules.sourceProgress(task, state.attempts, state.autonomy?.pendingIntegration);

// What a task's card or row shows as its status: closed, its source story stage, or its status.
export function statusOf(state: StudioState, task: Task) {
  if (task.closed) return { tone: 'denied', label: 'Closed' };
  const progress = progressOf(state, task);
  return progress
    ? { tone: progress.status, label: progress.label }
    : { tone: task.status, label: statusLabels[task.status] ?? task.status };
}

// Stories for the runs a set of records holds in full. The live set also holds settled prerequisites from
// finished runs, so only the runs it names are told from it.
export function runStories(state: StudioState, runs: RunRecord[] = state.runs) {
  const named = new Set(runs.map(run => run.id));
  return rules.buildRunStories(state).filter(story => named.has(story.id));
}

export interface CleanupItem {
  run: RunStory;
  members: NeedsItem[];
  taskIds: string[];
  requiresDirector: boolean;
}
export type HomeItem = (NeedsItem & { run?: RunStory }) | CleanupItem | HoldItem;
export const isCleanup = (item: HomeItem): item is CleanupItem => 'members' in item;
export const isHold = (item: HomeItem): item is HoldItem => 'kind' in item && item.kind === 'subscription-hold';

// What Home lists (public/runs.js needsYouItems): each run's items, its unstarted steps waiting on stopped work as
// one cleanup, then work outside any run, then each CLI's usage hold with no known reset, once. The controller's list
// of what needs the director now (GET /api/projects/:id/calls) runs the same rule.
export const needsYouItems = (state: StudioState, runs: RunStory[]): HomeItem[] => rules.needsYouItems(state, runs);

// The live set's stories and Needs you items, worked out once for each version of the records, since the
// sidebar's count and Home both read them.
const summaries = new WeakMap<StudioState, { stories: RunStory[]; items: HomeItem[]; decisions: number }>();
export function liveSummary(state: StudioState) {
  let summary = summaries.get(state);
  if (!summary) {
    const stories = runStories(state),
      items = needsYouItems(state, stories);
    summary = { stories, items, decisions: items.filter(item => item.requiresDirector).length };
    summaries.set(state, summary);
  }
  return summary;
}

// The controller's rule for settled work (src/core/project-records.mjs settled): closed, denied, or accepted
// with nothing left to integrate.
export function settled(task: Task, attempts: AttemptSummary[]) {
  if (task.closed || task.status === 'denied') return true;
  if (task.status !== 'done') return false;
  if (task.kind === 'studio-development:change' && task.sourceStage?.version === 'source-story-stages-v1')
    return task.sourceStage.current === 'integrated';
  if (task.kind === 'studio-development:change-review' && !task.sourceStage) {
    const review = attempts.find(attempt => attempt.id === task.acceptedAttemptId);
    return review?.candidateReviewVerdict !== 'pass' || review.sourceIntegration?.state === 'integrated';
  }
  return true;
}
