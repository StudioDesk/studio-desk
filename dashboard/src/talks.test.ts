// The talks going in a project, as the sidebar lists them under "Talking it through": each live idea whose plan step,
// found as the idea's page finds it, is not official yet (not done, not closed and not denied), or is accepted while
// every step its accepted attempt proposed still waits for the director's approval, newest first, with its run and
// title. The records are the controller's as idea-conversation.test.tsx's stand-in sends them.
import { expect, test } from 'vitest';
import type { RunRecord, Task } from './api';
import { liveSummary, type StudioState } from './studio-runs';
import { talks } from './talks';
import { shellFixture, taskFixture } from './test-controller';

const at = (minute: number) => `2026-10-29T19:${String(minute).padStart(2, '0')}:00Z`;
// An idea as the controller's run view sends it, holding its steps.
const idea = (id: string, minute: number, brief: string, tasks: Task[]): RunRecord => ({
  id,
  createdAt: at(minute),
  brief,
  directorInputs: [],
  workflow: { id: 'workflow-1', name: 'Source checks and review', version: 3 },
  revisions: [{ revision: 1, at: at(minute), reason: 'created' }],
  nodes: tasks.map(task => ({
    taskId: task.id,
    key: task.id,
    kind: task.kind,
    title: task.title,
    workerId: task.workerId,
    dependencies: task.dependencies ?? [],
    revision: 1,
  })),
  archive: { archived: false },
});
// The checks step and Mara's plan step of an idea.
const checksStep = (runId: string, fields: Partial<Task> = {}) =>
  taskFixture(`T-checks-${runId}`, {
    title: 'Check the source',
    kind: 'studio-development:checks',
    status: 'done',
    workflowReference: { runId, key: 'checks' },
    ...fields,
  });
const planStep = (runId: string, status: string, fields: Partial<Task> = {}) =>
  taskFixture(`T-plan-${runId}`, {
    title: 'Plan the idea',
    kind: 'studio-development:breakdown',
    status,
    workerId: 'W-4',
    workflowReference: { runId, key: 'plan' },
    dependencies: [`T-checks-${runId}`],
    ...fields,
  });
// The project's live records holding each idea with its steps.
const recordsOf = (...ideas: { run: RunRecord; tasks: Task[] }[]) =>
  ({
    ...shellFixture(),
    tasks: ideas.flatMap(item => item.tasks),
    attempts: [],
    runs: ideas.map(item => item.run),
  }) as StudioState;
const holding = (id: string, minute: number, brief: string, tasks: Task[]) => ({
  run: idea(id, minute, brief, tasks),
  tasks,
});

test("an idea whose plan step is in review is being talked through, by the run's title", () => {
  const brief = 'Show the talks in the sidebar.\n\nNewest first.',
    state = recordsOf(holding('run-1', 0, brief, [checksStep('run-1'), planStep('run-1', 'review')]));
  const run = liveSummary(state).stories.find(story => story.id === 'run-1')!;
  expect(run.title).toBe('Show the talks in the sidebar');
  expect(talks(state)).toEqual([{ runId: 'run-1', title: run.title }]);
});

test('an idea is talked through while its plan step waits, runs or asks, until it is done, closed or denied', () => {
  const listed = (status: string, fields: Partial<Task> = {}) =>
    talks(recordsOf(holding('run-1', 0, 'An idea.', [checksStep('run-1'), planStep('run-1', status, fields)]))).map(
      talk => talk.runId,
    );
  for (const status of ['backlog', 'ready', 'running', 'blocked', 'review', 'revision_requested'])
    expect(listed(status)).toEqual(['run-1']);
  // Official: its stories may still run, but the idea lives on its page.
  expect(listed('done')).toEqual([]);
  expect(listed('review', { closed: true })).toEqual([]);
  expect(listed('ready', { closed: { reason: 'Not now.' } })).toEqual([]);
  expect(listed('denied')).toEqual([]);
});

test('an idea without a plan step is not a talk', () => {
  const state = recordsOf(holding('run-1', 0, 'Only checks.', [checksStep('run-1', { status: 'running' })]));
  expect(liveSummary(state).stories.map(story => story.id)).toEqual(['run-1']);
  expect(talks(state)).toEqual([]);
});

test('two talks are listed newest first, beside an official idea that is not', () => {
  const state = recordsOf(
    holding('run-1', 0, 'The older talk.', [checksStep('run-1'), planStep('run-1', 'review')]),
    holding('run-2', 5, 'An official plan.', [checksStep('run-2'), planStep('run-2', 'done')]),
    holding('run-3', 9, 'The newer talk.', [checksStep('run-3'), planStep('run-3', 'running')]),
  );
  expect(talks(state)).toEqual([
    { runId: 'run-3', title: 'The newer talk' },
    { runId: 'run-1', title: 'The older talk' },
  ]);
});

// A step Mara's plan proposed, as src/core/proposals.mjs records it: waiting for the director's approval and pinned to
// the plan step and the attempt that proposed it, which joins it to the idea.
const proposedStep = (runId: string, key: string, attemptId: string, fields: Partial<Task> = {}) =>
  taskFixture(`T-${key}-${runId}`, {
    title: `Story ${key}`,
    kind: 'studio-development:change',
    status: 'backlog',
    approval: { status: 'pending' },
    proposalReference: { taskId: `T-plan-${runId}`, attemptId, path: 'source-breakdown.json', hash: 'h', key },
    dependencies: [`T-plan-${runId}`],
    ...fields,
  });
// An idea whose plan Mara's attempt a-plan made, accepted, with the two steps it proposed, the second as given.
const accepted = (second: Partial<Task> = {}, plan: Partial<Task> = {}, more: Task[] = []) =>
  recordsOf(
    holding('run-1', 0, 'An accepted plan.', [
      checksStep('run-1'),
      planStep('run-1', 'done', { acceptedAttemptId: 'a-plan', lastAttemptId: 'a-plan', ...plan }),
      proposedStep('run-1', 'records', 'a-plan'),
      proposedStep('run-1', 'page', 'a-plan', second),
      ...more,
    ]),
  );
const listedIn = (state: StudioState) => talks(state).map(talk => talk.runId);

test('an accepted plan whose proposed steps all wait for your approval is still being talked through', () => {
  const state = accepted();
  // The steps join the idea, which the run view then names by them.
  const run = liveSummary(state).stories.find(story => story.id === 'run-1')!;
  expect(run.taskIds).toContain('T-page-run-1');
  expect(talks(state)).toEqual([{ runId: 'run-1', title: 'Story records (and 1 more)' }]);
});

test('once one of its steps is approved, runs, is set aside or has an attempt, the accepted plan is official', () => {
  expect(listedIn(accepted({ status: 'ready', approval: { status: 'approved' } }))).toEqual([]);
  expect(listedIn(accepted({ status: 'running', approval: { status: 'approved' }, lastAttemptId: 'a-1' }))).toEqual([]);
  expect(listedIn(accepted({ status: 'denied', approval: { status: 'denied', reason: 'Not now.' } }))).toEqual([]);
  expect(listedIn(accepted({ lastAttemptId: 'a-1' }))).toEqual([]);
  expect(listedIn(accepted({ closed: { reason: 'Not now.' } }))).toEqual([]);
});

test("steps an earlier plan proposed, set aside by planning again, do not count against the accepted plan's", () => {
  // Planned again (src/core/proposals.mjs replanWork): the first plan's steps were denied, and the plan's proposed
  // task IDs hold them beside the accepted plan's own.
  const earlier = (key: string) =>
      proposedStep('run-1', key, 'a-plan-0', {
        status: 'denied',
        approval: { status: 'denied', reason: 'Planned again with your reply: Split it.' },
      }),
    plan = { proposedTaskIds: ['T-old-1-run-1', 'T-old-2-run-1', 'T-records-run-1', 'T-page-run-1'] };
  expect(listedIn(accepted({}, plan, [earlier('old-1'), earlier('old-2')]))).toEqual(['run-1']);
  // Once one of the accepted plan's own steps is approved, the idea leaves the list as before.
  const approved = accepted({ status: 'ready', approval: { status: 'approved' } }, plan, [earlier('old-1')]);
  expect(listedIn(approved)).toEqual([]);
});

test('an accepted plan that proposed no steps, or a closed one whose steps wait, is not a talk', () => {
  const bare = recordsOf(
    holding('run-1', 0, 'Nothing to build.', [
      checksStep('run-1'),
      planStep('run-1', 'done', { acceptedAttemptId: 'a-plan', lastAttemptId: 'a-plan' }),
    ]),
  );
  expect(listedIn(bare)).toEqual([]);
  expect(listedIn(accepted({}, { closed: { reason: 'Not now.' } }))).toEqual([]);
  // A done plan without an accepted attempt has no steps of its own.
  expect(listedIn(accepted({}, { acceptedAttemptId: undefined }))).toEqual([]);
});

test('a plan step in review is listed as today, beside the steps an earlier plan proposed that were set aside', () => {
  const state = recordsOf(
    holding('run-1', 0, 'Planned again.', [
      checksStep('run-1'),
      planStep('run-1', 'review', { lastAttemptId: 'a-plan-2' }),
      proposedStep('run-1', 'records', 'a-plan', { status: 'denied', approval: { status: 'denied' } }),
    ]),
  );
  expect(listedIn(state)).toEqual(['run-1']);
});
