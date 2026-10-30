// The talks going in a project, as the sidebar lists them under "Talking it through": each live idea whose plan step,
// found as the idea's page finds it, is not official yet (not done, not closed and not denied), newest first, with its
// run and title. The records are the controller's as idea-conversation.test.tsx's stand-in sends them.
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
