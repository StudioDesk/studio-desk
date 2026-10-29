// The story page's reading of one task (the canvas's Story board, v1.0 item 23): the steps it has passed, where it
// stands now, who did the work and the house rules it runs under, from the records the page holds. Nothing here
// sends anything.
import type { AttemptSummary, Task } from './api';
import { askedPaths, decisionState, fileRequest } from './decisions';
import { openPhaseOf, plural, sandboxed, testingPhases, took, totalsOf } from './evidence';
import { workerName } from './names';
import { waitingQuestion } from './questions';
import { active, explain, type Explanation, type RunStory, type StudioState } from './studio-runs';
import { placeIn, quoted } from './today';
import { clip } from './your-part';

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

// The question an agent stopped to ask while it waits for an answer (questions.ts waitingQuestion), and whether it
// is the director's to answer, as the shared rules explain it. One they leave to the work's own auto mode
// (question-auto) is neither the director's call nor a stop.
function questionWaiting(task: Task, studio: StudioState, explanation?: Explanation) {
  const asking = waitingQuestion(task, studio.attempts);
  return { asking, yours: !!asking && (explanation ?? explain(task, studio)).kind === 'question' };
}

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
    question = questionWaiting(task, studio, decision.explanation),
    live = active(task),
    implementing = !stage.phase || stage.phase === 'implementing',
    testing = live && implementing && testingPhases.includes(phase ?? ''),
    // The controller's own waits ("source stories run one at a time") are blocked too, but nothing stopped; one that
    // needs the director is still theirs to answer. An agent's waiting question is no stop either.
    stopped =
      !question.asking &&
      (stage.current === 'failed' ||
        (stage.current === 'blocked' && (!task.controllerWait || decision.explanation.requiresDirector))),
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
        : implementing && question.yours
          ? { label: 'Build · asked you a question', state: 'you' }
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
            : stage.phase === 'candidate-review' && question.yours
              ? { label: 'Review · asked you a question', state: 'you' }
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
    history = (task.stageState as { history?: { outcome?: string }[] } | undefined)?.history ?? [],
    sentBack = task.status === 'blocked' && history[history.length - 1]?.outcome === 'sent-back',
    // Work sent back waits for the director's Start, unless the house rules already queued its rework and the
    // controller holds it (its agent busy, say): decided as the source story's build step decides.
    yours = sentBack && (!task.controllerWait || decisionState(task, studio).explanation.requiresDirector),
    question = questionWaiting(task, studio);
  const worked: Step = active(task)
    ? { label: 'Working', state: 'live' }
    : ['review', 'done'].includes(task.status)
      ? { label: minutes ? `Done · ${minutes} min` : 'Done', state: 'done' }
      : question.yours
        ? { label: 'Asked you a question', state: 'you' }
        : sentBack
          ? yours
            ? { label: 'Sent back', state: 'you' }
            : { label: 'Rework queued', state: 'todo' }
          : ['failed', 'cancelled'].includes(task.status) ||
              (task.status === 'blocked' && task.lastAttemptId && !task.controllerWait && !question.asking)
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
  // The whole account, unshortened, as the story's Checks or Overview tab tells it: the title, then each part of the
  // detail on a line of its own (each failing check with its evidence, each failed test, the error, the editor's
  // issues and the next step), or the detail as one line.
  full: { title: string; lines: string[] };
  // Whether the title or detail leaves out some of the full account, which the notice then links to.
  shortened: boolean;
}

// The notice reads in a line or two: a title or detail past these lengths keeps its first sentence, clipped if that
// is still long. A shorter one stays as it is.
const titleLength = 160,
  detailLength = 200;
const firstSentence = (text: string) => /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
const brief = (text: string, length: number) => (text.length > length ? clip(firstSentence(text), length) : text);

// Where the story stands, in the agents' plain words: the director's call, the work moving, or how it ended.
export function standing(task: Task, studio: StudioState, phase: string | null = phaseOf(task, studio)): Standing {
  const { lines, short, whole, ...stand } = stands(task, studio, phase),
    title = brief(short?.title ?? stand.title, titleLength),
    detail = whole ? stand.detail : brief(short ? short.detail : stand.detail, detailLength);
  return {
    ...stand,
    title,
    detail,
    full: { title: stand.title, lines: lines ?? (stand.detail ? [stand.detail] : []) },
    shortened: title !== stand.title || detail !== stand.detail,
  };
}

// A notice as stands tells it in full, with what its short form says instead (short), or that its detail is the
// decision's own words and stays whole.
type Told = Omit<Standing, 'full' | 'shortened'> & {
  lines?: string[];
  short?: { title?: string; detail: string };
  whole?: boolean;
};

function stands(task: Task, studio: StudioState, phase: string | null): Told {
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
  // An agent's question waiting for the director, who answers it in the card above the notice. One the shared rules
  // leave to the work's own auto mode reads as they explain it, below.
  const question = questionWaiting(task, studio, explanation);
  if (question.asking && question.yours) {
    const { ask = '', why = '' } = question.asking.question ?? {};
    return {
      tone: 'you',
      chip: 'Asked you a question',
      title: `${workerName(studio, question.asking.workerId ?? task.workerId)} asked you a question.`,
      detail: ask,
      lines: [ask, why].filter(Boolean),
    };
  }
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
  // What integrating does, and that the controller restarts, the director reads whole before deciding.
  if (decision.integrable)
    return {
      tone: 'you',
      chip: 'Ready to integrate',
      title: `${reviewer} passed it. It's ready to integrate.`,
      detail: `Integrating merges it onto the current source in its own worktree, formats it, runs the full suite, then moves the branch forward. If any step fails, nothing changes.${integratesController(studio) ? ' The controller pauses new work, waits for running work to finish, integrates, then restarts.' : ''}`,
      whole: true,
    };
  if (decision.returnable)
    return {
      tone: 'you',
      chip: 'Changes requested',
      title: `${reviewer} asked for changes.`,
      detail: `Send it back and ${editor} gets the findings, or integrate over the review with your reason.`,
    };
  // A run waiting for the computer's one full test suite at a time says whose suite it waits for, as recorded.
  if (live && explanation.kind === 'test-turn-wait')
    return {
      tone: 'wait',
      title: explanation.reason,
      detail: explanation.next,
      workerId: source ? editorId : task.workerId,
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
  const lines = [...explanation.details, explanation.next].filter(Boolean),
    // A stop, not one of the controller's own waits, as the build step decides; and the tests of the build the story
    // is on, not of a candidate already past it.
    stopped =
      ['failed', 'cancelled', 'blocked'].includes(task.status) &&
      (!task.controllerWait || explanation.requiresDirector),
    tried = !stage.phase || stage.phase === 'implementing' ? totalsOf(build) : null,
    // A question the agent returned that could not be read is no question: its stop (the shared rules'
    // blocked-result) says why in the notice as well as in full.
    problem = studio.attempts.find(attempt => attempt.id === task.lastAttemptId)?.question?.problem,
    unread = problem ? explanation.details.find(line => line.includes(problem)) : undefined;
  return {
    tone: explanation.requiresDirector
      ? 'you'
      : task.status === 'done'
        ? 'ok'
        : ['failed', 'cancelled'].includes(task.status)
          ? 'bad'
          : 'wait',
    title: explanation.reason,
    detail: lines.join(' '),
    lines,
    // The notice says what failed in plain words and what the director can do; the checks' evidence, the failed
    // tests, the error and the issues are told in full under Checks or Overview.
    short: {
      title:
        stopped && tried?.tests && tried.fail
          ? `The attempt's tests did not pass: ${tried.pass ?? 0} of ${tried.tests}.`
          : undefined,
      detail: [unread, explanation.next].filter(Boolean).join(' '),
    },
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

// As in the controller (countsTowardLimit): an attempt a usage limit stopped, one the controller's stop interrupted
// and the director reconciled, or one that stopped to ask a question, doesn't use up one of a story's attempts.
export const countsTowardLimit = (attempt: AttemptSummary) =>
  !attempt.subscriptionHold && !(attempt.status === 'interrupted' && attempt.reconciledAt) && !attempt.question?.ask;

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
