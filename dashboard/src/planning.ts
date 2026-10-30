// Where an idea's planning stands, as the board's idea card and the Ideas list's row read it: Planning, with the
// planner and the minutes so far; Waiting for you, with the question or the call; or the stop in plain words, with
// what to do. Nothing once the plan is official. Read from the idea's checks and plan steps; nothing here sends
// anything.
import type { Task } from './api';
import { checkKinds, planKinds, runRecords } from './journey';
import { waitingQuestion } from './questions';
import { standing } from './story';
import { explain, type RunStory, type StudioState } from './studio-runs';

export interface Planning {
  state: 'planning' | 'you' | 'stopped';
  // The step the idea is on now: the checks until they pass, then the plan.
  taskId: string;
  // While planning goes on, the planner, even while the checks run; otherwise the agent who asked or stopped.
  workerId?: string;
  label: 'Planning' | 'Waiting for you' | 'Stopped';
  // The question's first line, the call's title, or the stop's reason and what to do.
  text?: string;
  // Whole minutes since the idea's checks or plan first started, at least 1; none while nothing has started.
  minutes?: number;
}

const firstLine = (text = '') => text.trim().split('\n')[0]!.trim();

export function planningOf(run: RunStory, state: StudioState, now = Date.now()): Planning | null {
  const { nodes, tasks, attempts } = runRecords(run, state),
    steps = (kinds: string[]) =>
      nodes
        .filter(node => kinds.includes(node.kind ?? ''))
        .map(node => tasks.get(node.taskId))
        .filter((task): task is Task => !!task),
    checks = steps(checkKinds),
    plans = steps(planKinds),
    // The plan is official once it is accepted.
    plan = plans.find(task => task.status !== 'done');
  if (!plan) return null;
  const task = checks.find(item => item.status !== 'done') ?? plan,
    on = { taskId: task.id, workerId: task.workerId },
    // A question the director must answer, as the story page tells one (story.ts): one the shared rules leave to
    // the work's own auto mode is not the director's, and no stop either.
    asking = waitingQuestion(task, state.attempts);
  if (asking && explain(task, state).kind === 'question')
    return {
      state: 'you',
      ...on,
      workerId: asking.workerId ?? task.workerId,
      label: 'Waiting for you',
      text: firstLine(asking.question?.ask),
    };
  const stand = standing(task, state);
  // A stop, not the controller's own wait or a question: its reason and what to do, as the step's notice says them.
  if (['failed', 'cancelled'].includes(task.status) || (task.status === 'blocked' && !asking && !task.controllerWait))
    return { state: 'stopped', ...on, label: 'Stopped', text: [stand.title, stand.detail].filter(Boolean).join(' ') };
  if (stand.tone === 'you') return { state: 'you', ...on, label: 'Waiting for you', text: stand.title };
  const starts = [...checks, ...plans]
    .flatMap(item => attempts(item.id))
    .map(attempt => Date.parse(String(attempt.startedAt ?? '')))
    .filter(Number.isFinite);
  return {
    state: 'planning',
    taskId: task.id,
    workerId: plan.workerId,
    label: 'Planning',
    ...(starts.length ? { minutes: Math.max(1, Math.round((now - Math.min(...starts)) / 60000)) } : {}),
  };
}
