// What an agent's face shows (the agent kit's states), from what the controller records. An agent is working
// while it runs an attempt. On a piece of work its face tells its part in that work: working while it runs it,
// done when its work there passed, stuck when its work there stopped (the card beside it says why), otherwise idle.
// Talking and thinking wait for item 21's record of the agents' own messages.
import type { AttemptSummary, Task } from './api';
import type { AgentState } from './design/agent-kit.js';
import type { StudioState } from './studio-runs';

const running = ['running', 'stopping'],
  stopped = ['failed', 'blocked', 'interrupted'],
  // A code candidate's review or other work's independent review.
  verdictOf = (attempt: AttemptSummary) => attempt.candidateReviewVerdict ?? attempt.workReviewVerdict;

// One attempt's face: what came of it.
export function attemptState(attempt: AttemptSummary): AgentState {
  if (running.includes(attempt.status)) return 'working';
  // A review did its part whatever it found; only a review that passed is a happy one.
  const verdict = verdictOf(attempt);
  if (verdict) return verdict === 'pass' ? 'done' : 'idle';
  return stopped.includes(attempt.status) ? 'stuck' : attempt.status === 'accepted' ? 'done' : 'idle';
}

// An agent's face, on its own or on some work: one task, or several, such as an idea's stories.
export function agentState(studio: StudioState, workerId: string | undefined, work?: Task | Task[]): AgentState {
  if (!workerId) return 'idle';
  const tasks = work === undefined ? null : Array.isArray(work) ? work : [work],
    attempts = studio.attempts.filter(
      attempt => attempt.workerId === workerId && (!tasks || tasks.some(task => task.id === attempt.taskId)),
    );
  if (attempts.some(attempt => running.includes(attempt.status))) return 'working';
  if (!tasks) return 'idle';
  const states = tasks.flatMap(task => {
    const latest = attempts
      .filter(attempt => attempt.taskId === task.id)
      .sort((a, b) => Date.parse(String(b.startedAt ?? '')) - Date.parse(String(a.startedAt ?? '')))[0];
    if (!latest) return [];
    // Work that ended done is done, whatever came before; a review keeps its own verdict.
    return [task.status === 'done' && !verdictOf(latest) ? 'done' : attemptState(latest)];
  });
  if (states.includes('stuck')) return 'stuck';
  return states.length && states.every(state => state === 'done') ? 'done' : 'idle';
}
