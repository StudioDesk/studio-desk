// When an idea's plan is still being talked through, as the sidebar's Talking it through (talks.ts) and the idea's page
// (idea-page.tsx) both read it: while its plan step is not done, closed or denied, and once the plan is accepted, while
// every step it proposed still waits for the director's approval. A plan's steps are found as src/core/proposals.mjs
// records them, pinned to the plan step and its accepted attempt; the plan's proposedTaskIds can also hold steps an
// earlier plan proposed, set aside when it was planned again.
import type { Task } from './api';

type ProposalReference = { taskId?: string; attemptId?: string } | undefined;

// A step that still waits for the director's approval: not started, approved, set aside or closed.
const waiting = (task: Task) =>
  (task.approval as { status?: string } | undefined)?.status === 'pending' &&
  task.status === 'backlog' &&
  !task.lastAttemptId &&
  !task.closed;

// The steps an accepted plan proposed, while every one of them waits; none once any has started or been decided.
export function waitingSteps(plan: Task, tasks: Task[]): Task[] {
  if (plan.status !== 'done' || !plan.acceptedAttemptId || plan.closed) return [];
  const steps = tasks.filter(task => {
    const reference = task.proposalReference as ProposalReference;
    return reference?.taskId === plan.id && reference.attemptId === plan.acceptedAttemptId;
  });
  return steps.every(waiting) ? steps : [];
}

// The plan is still being talked through: it is not official yet, or it is accepted and all its steps wait.
export const talkingThrough = (plan: Task | undefined, tasks: Task[]) =>
  !!plan && !plan.closed && (!['done', 'denied'].includes(plan.status) || waitingSteps(plan, tasks).length > 0);
