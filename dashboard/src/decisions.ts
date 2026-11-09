// What the director can decide about a task, worked out once for every page that offers it: the task page's
// decisions and Today's calls (v1.0 item 23) read the same conditions, so a call never offers what the task page
// would not. Nothing here sends anything; each page asks the controller for one recorded step.
import type { AttemptSummary, ScopeRequest, Task } from './api';
import { workerName } from './names';
import { commandProblem, ruleFrom } from './permissions';
import {
  active,
  awaitedSource,
  explain,
  integrationReview,
  progressOf,
  recordedAttempt,
  type Explanation,
  type StudioState,
} from './studio-runs';

const unsettledStates = ['interrupted', 'quarantined', 'uncertain'];
export const artifact = (
  attempt: AttemptSummary | undefined,
  test: (item: { path: string; kind?: string; hash: string }) => boolean,
) => attempt?.artifacts?.find(test);

export interface StageRecord {
  current?: string;
  phase?: string;
  review?: { verdict?: string; attemptId?: string; hash?: string };
  integration?: { attemptId?: string };
}

// A source story the director can send back over its accepted review, as the controller's sourceStoryReturnable
// allows: a review that asked for changes, or one that passed while its own checks failed (November 1, 2026: a visual
// check that captured an error page), which left the story failed at its review with nothing else to press. A review
// that asked for changes also goes back from waiting for an integration nothing will run, where a refused request left
// it: no integration of this review on its stage and, with the project's records, no integration journal on the
// review and no request of its own waiting for its turn.
export function reviewReturnable(task: Task, studio?: Pick<StudioState, 'attempts' | 'autonomy'>) {
  const stage = task.sourceStage as StageRecord | null | undefined;
  if (task.status !== 'done' || !stage?.review || task.acceptedAttemptId !== stage.review.attemptId) return false;
  if (stage.current === 'failed')
    return (
      stage.review.verdict === 'needs-work' || (stage.review.verdict === 'pass' && stage.phase === 'candidate-review')
    );
  const review = studio?.attempts.find(attempt => attempt.id === stage.review?.attemptId),
    pending = studio?.autonomy?.pendingIntegration as { taskId?: string } | null | undefined;
  return (
    stage.review.verdict === 'needs-work' &&
    stage.phase === 'integration' &&
    stage.current === 'waiting-for-integration' &&
    stage.integration?.attemptId !== stage.review.attemptId &&
    !review?.sourceIntegration &&
    pending?.taskId !== task.id
  );
}

// The task page's conditions (app-dialogs.js renderTaskModal and the source story's decisions), unchanged.
export function decisionState(task: Task, studio: StudioState) {
  const attempts = studio.attempts.filter(attempt => attempt.taskId === task.id),
    live = active(task),
    explanation = explain(task, studio),
    progress = progressOf(studio, task),
    latest = recordedAttempt(studio, task),
    current = recordedAttempt(
      studio,
      task,
      task.status === 'done' ? task.acceptedAttemptId || task.lastAttemptId : task.lastAttemptId,
    ),
    approval = task.approval as { status?: string } | undefined,
    awaited = awaitedSource(studio, task),
    closed = !!task.closed;
  const unsettled = attempts.some(attempt => unsettledStates.includes(attempt.status) && !attempt.reconciledAt);
  // Started work that is not live and has no accepted result, or a source story that will not be integrated.
  const closable =
    !live &&
    !closed &&
    attempts.length > 0 &&
    !['denied', 'backlog'].includes(task.status) &&
    !unsettled &&
    (task.status !== 'done' ||
      (!!progress &&
        progress.stage.current !== 'integrated' &&
        !progress.busy &&
        (!progress.journal || ['rejected', 'abandoned'].includes(progress.journal.state ?? ''))));
  // A reviewed change ready for integration: a staged story's passing review, or the older layout's review task.
  const review =
    task.status === 'done' && current?.id === task.acceptedAttemptId
      ? task.kind === 'studio-development:change-review' ||
        (progress &&
          current?.assignment &&
          (current.assignment as { kind?: string }).kind === 'studio-development:change-review')
        ? current
        : undefined
      : undefined;
  const journal = review?.sourceIntegration,
    reviewItem = artifact(review, item => item.kind === 'source-change-review'),
    integrable =
      !!review &&
      (progress
        ? integrationReview(studio, task)?.id === review.id
        : (!journal || ['rejected', 'abandoned'].includes(journal.state ?? '')) &&
          review.candidateReviewVerdict === 'pass');
  // The independent review asked for changes, or passed while its checks failed: send the story back, or integrate over
  // the review with a reason.
  const stage = task.sourceStage as StageRecord | null | undefined,
    returnable = reviewReturnable(task, studio);
  // An integration that stopped on a conflict (1.1 step 3), or failed only merged onto work that landed after the
  // change was tested (October 27): the story goes back to its editor merged onto the current source.
  const landed = journal?.verification?.landedSince,
    mergeable =
      journal?.state === 'rejected' &&
      stage?.current === 'failed' &&
      (!!journal.verification?.conflicts?.length || !!landed);
  const plan =
      task.kind === 'plan' ? artifact(latest, item => item.path === 'plan.json' && item.kind === 'plan') : undefined,
    proposal =
      studio.taskKinds[task.kind]?.['proposesWork' as never] &&
      !(task.proposedTaskIds as string[] | undefined)?.length &&
      !task.materializedTaskIds &&
      ['review', 'done'].includes(task.status)
        ? artifact(current, item => ['source-review', 'plan'].includes(item.kind ?? ''))
        : undefined;
  // The code moved past the story's plan (the controller's outdated note, public/task-actions.js): the controller
  // refuses its Start and any edit of its files, and only Close and send as a new idea carries its work on. It takes
  // what Close takes, and a story that never started, as Deny does.
  const outdated = task.kind === 'studio-development:change' && !!task.sourceStage?.outdated,
    neverStarted =
      approval?.status === 'approved' &&
      !attempts.length &&
      !['running', 'stopping', 'review', 'done', 'denied', 'backlog'].includes(task.status),
    sendable = outdated && !closed && task.status !== 'denied' && (closable || neverStarted);
  return {
    attempts,
    live,
    explanation,
    progress,
    latest,
    current,
    approval,
    awaited,
    closed,
    unsettled,
    closable,
    review,
    journal,
    reviewItem,
    integrable,
    stage,
    returnable,
    landed,
    mergeable,
    plan,
    proposal,
    outdated,
    sendable,
  };
}

// What Close and send as a new idea sends when the director does not change it: the story's title, its plain
// summary when the page has one, and that it continues work the code moved past, as the controller composes it; never
// its files, scope or identifiers. The controller takes in an idea of up to sendIdeaLimit characters.
export const sendIdeaLimit = 4000;
export const sentIdeaContinues = 'It continues work an earlier story planned, which the code has since moved past.';
export function storyIdea(task: Task) {
  const summary = typeof task.summary === 'string' ? task.summary.trim() : '';
  return [task.title.trim(), summary, sentIdeaContinues].filter(Boolean).join('\n\n');
}

export interface Paths {
  files: string[];
  newFiles: string[];
  deleteFiles: string[];
}
export interface ScopeEdit extends Paths {
  at: string;
  reason: string;
  by?: { type?: string; revision?: number };
  request?: { attemptId?: string; workerId?: string };
}

// The paths a story may change: the director's latest edit, or the path lines of its brief.
export function storyPaths(task: Task): Paths {
  const edit = (task.scopeEdits as ScopeEdit[] | undefined)?.at(-1);
  if (edit) return { files: edit.files, newFiles: edit.newFiles, deleteFiles: edit.deleteFiles };
  const line = (label: string) =>
    (task.brief?.split('\n').find(text => text.startsWith(label + ': ')) ?? '')
      .slice(label.length + 2)
      .split(', ')
      .filter(Boolean);
  return { files: line('Files'), newFiles: line('New files'), deleteFiles: line('Delete') };
}

// A blocked editor's file request (MP-021): the attempt that asked, its usable request, the story's paths with the
// ones it named, and whether staged work exists to continue from. The story page offers it as a form; Today
// approves it as asked in one step.
export function fileRequest(task: Task, studio: StudioState) {
  const latest = studio.attempts.find(attempt => attempt.id === task.lastAttemptId),
    edits = (task.scopeEdits as ScopeEdit[] | undefined) ?? [],
    scope = latest?.scopeRequest as ScopeRequest | undefined,
    requested =
      task.status === 'blocked' &&
      latest?.status === 'blocked' &&
      (latest.assignment as { kind?: string } | undefined)?.kind === 'studio-development:change' &&
      scope &&
      !edits.some(edit => edit.at >= String(latest.finishedAt ?? ''))
        ? latest
        : null,
    // A request carrying a problem is one the controller found it would refuse as asked, so it is not usable; the
    // page shows the problem instead of Allow and continue.
    request = requested && scope?.reason && !scope.problem ? scope : null,
    problem = requested && typeof scope?.problem === 'string' && scope.problem.trim() ? scope.problem.trim() : '',
    current = storyPaths(task),
    offered: Paths = {
      files: [...new Set([...current.files, ...(request?.files ?? [])])],
      newFiles: [...new Set([...current.newFiles, ...(request?.newFiles ?? [])])],
      deleteFiles: [...new Set([...current.deleteFiles, ...(request?.deleteFiles ?? [])])],
    },
    worked = studio.attempts.some(
      attempt =>
        attempt.taskId === task.id &&
        (attempt.assignment as { kind?: string } | undefined)?.kind === 'studio-development:change' &&
        attempt.artifacts?.some(item => item.kind === 'source-file' && item.path.startsWith('changes/')),
    ),
    editor = requested ? workerName(studio, requested.workerId) : '';
  return { requested, request, scope, problem, offered, worked, editor };
}

// Each path a file request adds to the story: a file to edit or create joins with +, a file to delete with −.
export function askedPaths(task: Task, request: Paths) {
  const current = storyPaths(task);
  return [
    ...(request.files ?? []).filter(path => !current.files.includes(path)).map(path => ({ path, sign: '+', note: '' })),
    ...(request.newFiles ?? [])
      .filter(path => !current.newFiles.includes(path))
      .map(path => ({ path, sign: '+', note: ' (new)' })),
    ...(request.deleteFiles ?? [])
      .filter(path => !current.deleteFiles.includes(path))
      .map(path => ({ path, sign: '−', note: ' (delete)' })),
  ];
}

// The commands an employee stopped for, as the rules the director would approve unchanged, and whether every one
// is a rule the controller accepts.
export function commandRequest(explanation: Explanation) {
  const rules = (explanation.commands ?? []).map(command => ruleFrom(command));
  return { rules, valid: rules.length > 0 && rules.every(rule => !commandProblem(rule)) };
}
