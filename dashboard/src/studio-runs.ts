// The run stories, task explanations and Needs you rules the current dashboard uses (public/runs.js), loaded
// unchanged so both dashboards say the same thing until the old one is removed. They read a state shaped like
// the old one's: a project's shell with the records a page holds.
import '../../public/runs.js';
import type { AttemptSummary, Live, RunRecord, Shell, Task } from './api';

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

export interface Outcome {
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

export function integrationAction(state: StudioState, task: Task, attempt: AttemptSummary) {
  const retry =
    ['rejected', 'abandoned'].includes(attempt.sourceIntegration?.state ?? '') ||
    (task.sourceStage?.phase === 'integration' && task.sourceStage.current === 'failed') ||
    !!(task.sourceStage?.['reason' as never] || task.reason) ||
    /could not request integration|approve it yourself/i.test(String(task.autonomyNote ?? ''));
  if (state.autonomy?.policy?.enabled || task.sourceStage)
    return retry ? 'Approve integration again' : 'Approve integration';
  return retry ? 'Integrate again' : 'Integrate reviewed source';
}

// The current dashboard's explanation (app-core.js taskExplanation): the shared rules, plus a passing review in
// the older two-task layout that waits for integration.
export function explain(task: Task, state: StudioState): Explanation {
  const explanation = rules.taskExplanation(task, state),
    accepted = recordedAttempt(state, task, task.acceptedAttemptId),
    journal = accepted?.sourceIntegration;
  if (explanation.kind === 'denied' && task.reason) return { ...explanation, details: [String(task.reason)] };
  if (
    !task.sourceStage &&
    !task.closed &&
    task.kind === 'studio-development:change-review' &&
    task.status === 'done' &&
    accepted &&
    (!journal || ['rejected', 'abandoned'].includes(journal.state ?? '')) &&
    accepted.candidateReviewVerdict === 'pass'
  ) {
    const action = integrationAction(state, task, accepted);
    return {
      ...explanation,
      kind: journal ? 'integration-stopped' : 'integration-approval',
      reason: journal
        ? 'The last integration did not complete.'
        : 'The current independent review passed and awaits integration approval.',
      next: journal
        ? `Inspect the recorded failure and resolve it before using ${action}.`
        : `Use ${action} to request controller-owned integration.`,
      action,
      requiresDirector: true,
    };
  }
  return explanation;
}

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

// What Home lists (app-pages.js needsYouItems): each run's items, its unstarted steps waiting on stopped work
// as one cleanup, then work outside any run, then each CLI's usage hold with no known reset, once.
export function needsYouItems(state: StudioState, runs: RunStory[]): HomeItem[] {
  const runOf = rules.runMembership(state.tasks),
    seen = new Set<string>(),
    items: HomeItem[] = [];
  for (const run of runs) {
    const rows = run.needsYou.filter(item => !seen.has(item.taskId));
    rows.forEach(item => seen.add(item.taskId));
    const cleanup = rows.filter(item => item.cleanup);
    rows.filter(item => !item.cleanup).forEach(item => items.push({ ...item, run }));
    if (cleanup.length)
      items.push({
        run,
        members: cleanup,
        taskIds: cleanup.map(item => item.taskId),
        requiresDirector: cleanup.some(item => item.requiresDirector),
      });
  }
  const standalone = state.tasks.filter(task => !runOf.has(task.id) && !seen.has(task.id));
  items.push(...rules.needsYou(state, standalone, explain));
  items.push(...rules.holdItems(state, explain).filter(hold => hold.requiresDirector));
  return items;
}

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
