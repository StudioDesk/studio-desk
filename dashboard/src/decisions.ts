// What the director can decide about a task, worked out once for every page that offers it: the task page's
// decisions and Today's calls (v1.0 item 23) read the same conditions, so a call never offers what the task page
// would not. Nothing here sends anything; each page asks the controller for one recorded step.
import type { AttemptSummary, Task } from './api';
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
  review?: { verdict?: string; attemptId?: string; hash?: string };
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
  // The independent review asked for changes: send the story back, or integrate over the review with a reason.
  const stage = task.sourceStage as StageRecord | null | undefined,
    returnable =
      task.status === 'done' &&
      stage?.current === 'failed' &&
      stage.review?.verdict === 'needs-work' &&
      task.acceptedAttemptId === stage.review.attemptId;
  const plan =
      task.kind === 'plan' ? artifact(latest, item => item.path === 'plan.json' && item.kind === 'plan') : undefined,
    proposal =
      studio.taskKinds[task.kind]?.['proposesWork' as never] &&
      !(task.proposedTaskIds as string[] | undefined)?.length &&
      !task.materializedTaskIds &&
      ['review', 'done'].includes(task.status)
        ? artifact(current, item => ['source-review', 'plan'].includes(item.kind ?? ''))
        : undefined;
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
    plan,
    proposal,
  };
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
    scope = latest?.scopeRequest as (Paths & { reason?: string; problem?: string }) | undefined,
    requested =
      task.status === 'blocked' &&
      latest?.status === 'blocked' &&
      (latest.assignment as { kind?: string } | undefined)?.kind === 'studio-development:change' &&
      scope &&
      !edits.some(edit => edit.at >= String(latest.finishedAt ?? ''))
        ? latest
        : null,
    request = requested && scope?.reason ? scope : null,
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
  return { requested, request, scope, offered, worked, editor };
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
