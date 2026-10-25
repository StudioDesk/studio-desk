// The story page's reading of one task (the canvas's Story board, v1.0 item 23): the steps it has passed, where it
// stands now, who did the work and the house rules it runs under, from the records the page holds. Nothing here
// sends anything.
import type { AttemptSummary, Task } from './api';
import { askedPaths, decisionState, fileRequest } from './decisions';
import { openPhaseOf, plural, sandboxed, testingPhases, took, totalsOf } from './evidence';
import { workerName } from './names';
import { active, type RunStory, type StudioState } from './studio-runs';
import { placeIn, quoted } from './today';

export type Tone = 'you' | 'live' | 'ok' | 'bad' | 'wait';
export interface Step {
  label: string;
  state: 'done' | Exclude<Tone, 'ok' | 'wait'> | 'todo';
}
export interface Stage {
  version?: string;
  phase?: string;
  current?: string;
  reason?: string;
  candidate?: { attemptId?: string; workerId?: string; hash?: string; candidateHash?: string };
  review?: { attemptId?: string; workerId?: string; verdict?: string; hash?: string };
  reviewTask?: { workerId?: string };
  continueFrom?: { attemptId?: string };
}

const kindOf = (attempt?: AttemptSummary) => (attempt?.assignment as { kind?: string } | undefined)?.kind;
export const isSourceStory = (task: Task) =>
  task.kind === 'studio-development:change' && task.sourceStage?.version === 'source-story-stages-v1';

// "Source story", or the task type's short name.
export const kindLabel = (task: Task, studio: StudioState) =>
  isSourceStory(task)
    ? 'Source story'
    : (studio.taskKinds[task.kind]?.cardLabel ?? studio.taskKinds[task.kind]?.label ?? task.kind);

// The attempts that built and reviewed the story's current candidate, and who did each. A candidate counts only
// once the story has moved past implementing it: a story sent back is building a new one.
export function storyPeople(task: Task, studio: StudioState) {
  const stage = (task.sourceStage ?? {}) as Stage,
    attempts = studio.attempts.filter(attempt => attempt.taskId === task.id),
    find = (id?: string) => attempts.find(attempt => attempt.id === id),
    builds = attempts.filter(attempt => kindOf(attempt) !== 'studio-development:change-review'),
    latest = find(task.lastAttemptId),
    build = latest && kindOf(latest) !== 'studio-development:change-review' ? latest : builds.at(-1),
    past = !!stage.phase && stage.phase !== 'implementing',
    candidate = past ? find(stage.candidate?.attemptId) : undefined,
    review = past ? find(stage.review?.attemptId) : undefined,
    editorId = candidate?.workerId ?? build?.workerId ?? task.workerId,
    reviewerId = review?.workerId ?? stage.review?.workerId ?? stage.reviewTask?.workerId;
  return {
    stage,
    attempts,
    build,
    candidate,
    review,
    editorId,
    reviewerId,
    editor: workerName(studio, editorId),
    reviewer: reviewerId ? workerName(studio, reviewerId) : 'the reviewer',
  };
}

export { testingPhases } from './evidence';

// The source phase the task's running attempt is in, as the compact record carries it; the story page reads the
// same from the full record.
export const phaseOf = (task: Task, studio: StudioState) =>
  openPhaseOf(
    studio.attempts.find(attempt => attempt.taskId === task.id && ['running', 'stopping'].includes(attempt.status)),
  );

export function storySteps(task: Task, studio: StudioState, phase: string | null = phaseOf(task, studio)): Step[] {
  const approval = (task.approval as { status?: string } | undefined)?.status,
    first: Step[] =
      approval === 'pending'
        ? [{ label: 'Approve · your call', state: 'you' }]
        : approval
          ? [{ label: 'Approved', state: 'done' }]
          : [];
  return [...first, ...(isSourceStory(task) ? sourceSteps(task, studio, phase) : workSteps(task, studio))];
}

function sourceSteps(task: Task, studio: StudioState, phase: string | null): Step[] {
  const { stage, build, candidate, review, reviewer } = storyPeople(task, studio),
    decision = decisionState(task, studio),
    live = active(task),
    implementing = !stage.phase || stage.phase === 'implementing',
    testing = live && implementing && testingPhases.includes(phase ?? ''),
    // The controller's own waits ("source stories run one at a time") are blocked too, but nothing stopped; one that
    // needs the director is still theirs to answer.
    stopped =
      stage.current === 'failed' ||
      (stage.current === 'blocked' && (!task.controllerWait || decision.explanation.requiresDirector)),
    tried = implementing ? totalsOf(build) : null,
    measured = totalsOf(candidate),
    minutes = took(candidate);
  const built: Step =
    live && implementing
      ? testing
        ? { label: 'Built', state: 'done' }
        : { label: 'Building', state: 'live' }
      : candidate
        ? { label: minutes ? `Built · ${minutes} min` : 'Built', state: 'done' }
        : implementing && stopped && decision.explanation.requiresDirector
          ? { label: 'Build · your call', state: 'you' }
          : tried?.tests
            ? { label: 'Built', state: 'done' }
            : implementing && stopped
              ? { label: 'Build stopped', state: 'bad' }
              : { label: 'Build', state: 'todo' };
  const tested: Step = testing
    ? { label: 'Testing', state: 'live' }
    : candidate
      ? { label: measured?.tests ? `Tested · ${measured.pass} of ${measured.tests}` : 'Tested', state: 'done' }
      : tried?.tests && tried.fail
        ? { label: `Tests · ${tried.pass} of ${tried.tests}`, state: 'bad' }
        : { label: 'Test', state: 'todo' };
  const verdict = stage.review?.verdict,
    reviewed: Step =
      review && verdict === 'pass'
        ? { label: `Reviewed by ${reviewer}`, state: 'done' }
        : verdict === 'needs-work'
          ? { label: `${reviewer} asked for changes`, state: decision.returnable ? 'you' : 'bad' }
          : stage.phase === 'candidate-review' && live
            ? { label: `${reviewer} reviewing`, state: 'live' }
            : stage.phase === 'candidate-review' && stopped
              ? { label: 'Review stopped', state: 'bad' }
              : { label: 'Review', state: 'todo' };
  const integrated: Step =
    stage.current === 'integrated'
      ? { label: 'Integrated', state: 'done' }
      : decision.progress?.busy
        ? { label: 'Integrating', state: 'live' }
        : decision.integrable
          ? { label: 'Integrate · your call', state: 'you' }
          : stage.phase === 'integration' && stopped
            ? { label: 'Integration stopped', state: 'bad' }
            : { label: 'Integrate', state: 'todo' };
  return [built, tested, reviewed, integrated];
}

// Other work runs Ready → Working → Review → Accepted.
function workSteps(task: Task, studio: StudioState): Step[] {
  const attempt = studio.attempts.find(item => item.id === (task.acceptedAttemptId ?? task.lastAttemptId)),
    minutes = took(attempt),
    by = (attempt?.acceptedBy as { type?: string } | undefined)?.type,
    history = (task.stageState as { history?: { outcome?: string }[] } | undefined)?.history ?? [];
  const worked: Step = active(task)
    ? { label: 'Working', state: 'live' }
    : ['review', 'done'].includes(task.status)
      ? { label: minutes ? `Done · ${minutes} min` : 'Done', state: 'done' }
      : task.status === 'blocked' && history[history.length - 1]?.outcome === 'sent-back'
        ? { label: 'Sent back', state: 'you' }
        : ['failed', 'cancelled'].includes(task.status) ||
            (task.status === 'blocked' && task.lastAttemptId && !task.controllerWait)
          ? { label: 'Stopped', state: 'bad' }
          : { label: 'Work', state: 'todo' };
  const accepted: Step =
    task.status === 'done'
      ? { label: by === 'policy' ? 'Accepted by house rules' : 'Accepted', state: 'done' }
      : task.status === 'review'
        ? { label: 'Accept · your call', state: 'you' }
        : { label: 'Accept', state: 'todo' };
  return [worked, accepted];
}

export interface Standing {
  tone: Tone;
  // The phone's chip for a call: "Ready to integrate", as Today's calls name them.
  chip?: string;
  title: string;
  detail: string;
  // The agent whose face the banner shows; none when the call is the director's.
  workerId?: string;
}

// Where the story stands, in the agents' plain words: the director's call, the work moving, or how it ended.
export function standing(task: Task, studio: StudioState, phase: string | null = phaseOf(task, studio)): Standing {
  const { stage, build, editor, editorId, reviewer, reviewerId } = storyPeople(task, studio),
    decision = decisionState(task, studio),
    { explanation } = decision,
    live = active(task),
    source = isSourceStory(task),
    journal = decision.progress?.journal as
      | {
          repository?: { commit?: string; branch?: string };
          verification?: { totals?: { pass?: number; tests?: number } };
        }
      | undefined;
  if (task.closed)
    return {
      tone: 'wait',
      title: 'Closed.',
      detail: (typeof task.closed === 'object' && task.closed.reason) || explanation.reason,
    };
  if (source && stage.current === 'integrated') {
    const commit = journal?.repository?.commit,
      totals = journal?.verification?.totals;
    return {
      tone: 'ok',
      chip: 'Integrated',
      title: 'Integrated.',
      workerId: editorId,
      detail: [
        commit
          ? `Commit ${commit.slice(0, 7)}${journal?.repository?.branch ? ` on ${journal.repository.branch}` : ''}.`
          : '',
        totals?.tests ? `${totals.pass} of ${totals.tests} tests passed after the merge.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }
  if (source && decision.progress?.busy)
    return { tone: 'live', title: 'Integrating. Nothing needed from you.', detail: explanation.reason };
  const asking = fileRequest(task, studio);
  if (asking.request && asking.requested) {
    const asked = askedPaths(task, asking.request).length;
    return {
      tone: 'you',
      chip: asked === 1 ? 'Needs one more file' : 'Needs more files',
      title: `${asking.editor} needs ${asked === 1 ? 'one more file' : asked ? `${asked} more files` : 'more files'}.`,
      detail: `${asking.editor}'s reason: ${asking.request.reason}`,
      workerId: asking.requested.workerId,
    };
  }
  if (decision.integrable)
    return {
      tone: 'you',
      chip: 'Ready to integrate',
      title: `${reviewer} passed it. It's ready to integrate.`,
      detail: `Integrating merges it onto the current source in its own worktree, formats it, runs the full suite, then moves the branch forward. If any step fails, nothing changes.${integratesController(studio) ? ' The controller pauses new work, waits for running work to finish, integrates, then restarts.' : ''}`,
    };
  if (decision.returnable)
    return {
      tone: 'you',
      chip: 'Changes requested',
      title: `${reviewer} asked for changes.`,
      detail: `Send it back and ${editor} gets the findings, or integrate over the review with your reason.`,
    };
  if (live && source && (!stage.phase || stage.phase === 'implementing'))
    return testingPhases.includes(phase ?? '')
      ? {
          tone: 'live',
          title: `${editor} finished editing and the ${sandboxed(build) ? 'sandbox ' : ''}tests are running. Nothing needed from you.`,
          detail: '',
          workerId: editorId,
        }
      : { tone: 'live', title: `${editor} is editing. Nothing needed from you.`, detail: '', workerId: editorId };
  if (live && source && stage.phase === 'candidate-review')
    return {
      tone: 'live',
      title: `${reviewer} is reviewing it. Nothing needed from you.`,
      detail: '',
      workerId: reviewerId,
    };
  if (live)
    return {
      tone: 'live',
      title: `${workerName(studio, task.workerId)} is working on it. Nothing needed from you.`,
      detail: '',
      workerId: task.workerId,
    };
  return {
    tone: explanation.requiresDirector
      ? 'you'
      : task.status === 'done'
        ? 'ok'
        : ['failed', 'cancelled'].includes(task.status)
          ? 'bad'
          : 'wait',
    title: explanation.reason,
    detail: [...explanation.details, explanation.next].filter(Boolean).join(' '),
  };
}

// What the house rules decide for this task type, and what is left to the director.
export function houseRules(task: Task, studio: StudioState) {
  const policy = studio.autonomy?.policy,
    integrates = !!studio.taskKinds[task.kind]?.integrationLabel,
    mode = policy?.enabled
      ? { approve: 'director', accept: 'director', ...policy.kinds?.[task.kind] }
      : { approve: 'director', accept: 'director', integrate: 'director', scope: 'director' };
  const story = isSourceStory(task) || task.kind === 'studio-development:change',
    yours = [
      mode.approve === 'director' ? (story ? 'stories' : 'proposed work') : '',
      mode.accept === 'director' ? 'results' : '',
      integrates && (mode.integrate ?? 'director') === 'director' ? 'integration' : '',
    ].filter(Boolean),
    yoursText = yours.length
      ? `You approve ${yours.length > 1 ? `${yours.slice(0, -1).join(', ')} and ${yours.at(-1)}` : yours[0]}.`
      : '',
    automatic = [
      mode.approve === 'auto' ? `${story ? 'Proposed stories' : 'Proposed work'} is approved for you.` : '',
      mode.accept === 'auto' ? 'Results with passing checks are accepted for you.' : '',
      integrates && mode.integrate === 'auto' ? 'Changes with a passing review are integrated for you.' : '',
      story && mode.scope === 'auto' ? "An editor's request for more files is approved for you." : '',
    ].filter(Boolean);
  return [yoursText, ...automatic].filter(Boolean).join(' ').replace('Proposed stories is', 'Proposed stories are');
}

// As in the controller (countsTowardLimit): an attempt a usage limit stopped, or one the controller's stop
// interrupted and the director reconciled, doesn't use up one of a story's attempts.
export const countsTowardLimit = (attempt: AttemptSummary) =>
  !attempt.subscriptionHold && !(attempt.status === 'interrupted' && attempt.reconciledAt);

// Whether integrating this project's stories replaces the running controller's source: a controller that develops
// itself, on the project without a repository of its own. A repository project's story integrates into its own
// repository without pausing or restarting anything (the recovery drill, October 24).
export const integratesController = (studio: Pick<StudioState, 'autonomy' | 'project'>) =>
  !!studio.autonomy?.selfHosted && !studio.project?.source;

// The attempts a story has used of the ones it may. As in the controller, a task with stages counts only its own
// work's attempts: a review's attempts are not tries at the work.
export const attemptsUsed = (task: Task, attempts: AttemptSummary[]) => {
  const builds = attempts.filter(
      attempt =>
        countsTowardLimit(attempt) &&
        (task.stageState
          ? (kindOf(attempt) ?? task.kind) === task.kind
          : kindOf(attempt) !== 'studio-development:change-review'),
    ).length,
    allowed = task.maxAttempts ?? 0;
  return { used: builds, allowed, left: Math.max(0, allowed - builds) };
};

// The CLI an attempt ran on, by the name the director knows ("Codex", "Claude Code"). A code editor's attempt is
// recorded under its wrapping adapter, so its configuration names the CLI; older records may not say.
export function cliName(studio: StudioState, attempt?: AttemptSummary, provider?: string) {
  const id =
    provider ??
    (attempt?.configuration as { provider?: string } | undefined)?.provider ??
    (['source-change', 'source-breakdown'].includes(attempt?.provider ?? '') ? undefined : attempt?.provider);
  if (!id) return '';
  if (id === 'mock') return 'Simulator, no model';
  return (studio.adapters?.[id]?.name ?? id).replace(/ CLI$/, '');
}

export const limitsLine = (task: Task) => {
  const seconds = task.maxSeconds ?? 0,
    time = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
  return `${time} an attempt · ${task.maxAttempts} ${plural(task.maxAttempts ?? 0, 'attempt')}`;
};

const products: Record<string, string> = {
  'studio-development:breakdown': 'plan',
  'general:plan': 'plan',
  'studio-development:checks': 'checks',
  'studio-development:change-review': 'review',
  'general:review': 'review',
};

// A prerequisite as the canvas says it: "Story 2 integrated", "Mara's plan accepted", or, until it is met,
// "Story 2 to be integrated".
export function prerequisite(other: Task, studio: StudioState, stories: RunStory[]) {
  const place = placeIn(stories, other),
    integrated = (other.sourceStage as Stage | null | undefined)?.current === 'integrated',
    met = other.status === 'done',
    product = products[other.kind];
  const subject =
    place && place.index > 0
      ? `Story ${place.index}`
      : product
        ? `${workerName(studio, other.workerId)}'s ${product}`
        : quoted(other.title, 40);
  if (isSourceStory(other) && place && place.index > 0)
    return { met: integrated, words: `${subject} ${integrated ? 'integrated' : 'to be integrated'}` };
  return { met, words: `${subject} ${met ? 'accepted' : 'to be accepted'}` };
}
