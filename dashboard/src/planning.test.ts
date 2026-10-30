// Where an idea's planning stands: Planning with the planner and the minutes so far, Waiting for you with the
// question or the call, or the stop in plain words; nothing once the plan is official.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task } from './api';
import { planningOf } from './planning';
import { standing } from './story';
import { explain, type RunStory, type StudioState } from './studio-runs';

const at = (minute: number) => `2026-10-22T19:${String(minute).padStart(2, '0')}:00Z`;
const step = (id: string, kind: string, fields: Partial<Task>): Task => ({
  id,
  title: `Title of ${id}`,
  kind,
  status: 'ready',
  maxSeconds: 1200,
  maxAttempts: 3,
  ...fields,
});
// A code idea's checks, by Avery, and its plan after them, by Mara.
const checks = (fields: Partial<Task> = {}) =>
  step('T-checks', 'studio-development:checks', { workerId: 'W-3', ...fields });
const plan = (fields: Partial<Task> = {}) =>
  step('T-plan', 'studio-development:breakdown', { workerId: 'W-4', dependencies: ['T-checks'], ...fields });
const attempt = (id: string, taskId: string, start: number, fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id,
  taskId,
  status: 'running',
  workerId: taskId === 'T-checks' ? 'W-3' : 'W-4',
  startedAt: at(start),
  ...fields,
});
const checked = attempt('a-checks', 'T-checks', 1, { status: 'accepted', finishedAt: at(3) }),
  passed = checks({ status: 'done', lastAttemptId: 'a-checks', acceptedAttemptId: 'a-checks' });
const state = (tasks: Task[], attempts: AttemptSummary[] = []) =>
  ({
    project: { id: 'project-x', name: 'Project X' },
    projects: [],
    workers: [
      { id: 'W-1', displayName: 'Eli' },
      { id: 'W-3', displayName: 'Avery' },
      { id: 'W-4', displayName: 'Mara' },
    ],
    taskKinds: {},
    workflows: [],
    tasks,
    attempts,
    runs: [],
  }) as unknown as StudioState;
// An idea as the live set tells it: its tasks in its graph, one after another.
const idea = (tasks: Task[]) =>
  ({
    id: 'run-1',
    name: 'Idea',
    title: 'An idea',
    brief: 'An idea.',
    directorInputs: [],
    graph: {
      revisions: 1,
      envelope: null,
      legacy: false,
      stages: tasks.map(task => [{ taskId: task.id, title: task.title, kind: task.kind, status: task.status }]),
    },
    startedAt: at(0),
    taskIds: tasks.map(task => task.id),
    steps: [],
    needsYou: [],
    outcome: { tone: 'busy', label: 'In progress', text: '' },
  }) as unknown as RunStory;
const read = (
  tasks: Task[],
  attempts: AttemptSummary[] = [],
  now = Date.parse(at(10)),
  records = state(tasks, attempts),
) => planningOf(idea(tasks), records, now);

// The planner's question at minute 5, with a second line the reader leaves out.
const question = {
  ask: 'Split the page part into two stories?\nTwo pages share it, so either way works.',
  why: 'Two pages share it.',
  options: [{ label: 'One story' }, { label: 'Two stories', detail: 'one a page' }],
  recommended: 1,
  choice: 'inside-story',
  topics: [] as string[],
};
const asked = attempt('a-ask', 'T-plan', 4, {
  status: 'blocked',
  finishedAt: at(5),
  error: 'Needs a call from the director.',
  result: { outcome: 'blocked', summary: 'Needs a call from the director.' },
  question,
});

test('while the checks run and the plan is queued, the idea reads Planning with the planner and the minutes so far', () => {
  const tasks = [checks({ status: 'running', lastAttemptId: 'a-checks' }), plan({ queued: true })],
    running = attempt('a-checks', 'T-checks', 1);
  // The checks are the step the idea is on, and the planner is the plan step's agent, not the checks'.
  expect(read(tasks, [running], Date.parse(at(7)))).toEqual({
    state: 'planning',
    taskId: 'T-checks',
    workerId: 'W-4',
    label: 'Planning',
    minutes: 6,
  });
  // The minutes follow the time given, at least 1.
  expect(read(tasks, [running], Date.parse(at(9)))!.minutes).toBe(8);
  expect(read(tasks, [running], Date.parse(at(1)) + 10000)!.minutes).toBe(1);
  // Nothing started yet: Planning, with no minutes.
  const queued = read([checks({ queued: true }), plan({ queued: true })], []);
  expect(queued).toMatchObject({ state: 'planning', taskId: 'T-checks', workerId: 'W-4', label: 'Planning' });
  expect(queued).not.toHaveProperty('minutes');
  expect(queued).not.toHaveProperty('text');
});

test('a running plan reads Planning, its minutes from the first of the checks and plan attempts', () => {
  const tasks = [passed, plan({ status: 'running', lastAttemptId: 'a-plan' })],
    planning = attempt('a-plan', 'T-plan', 4);
  expect(read(tasks, [checked, planning], Date.parse(at(10)))).toEqual({
    state: 'planning',
    taskId: 'T-plan',
    workerId: 'W-4',
    label: 'Planning',
    minutes: 9,
  });
  // Work with no checks counts from the plan's own start.
  const general = step('T-plan', 'general:plan', { workerId: 'W-4', status: 'running', lastAttemptId: 'a-plan' });
  expect(read([general], [planning], Date.parse(at(10)))).toMatchObject({ taskId: 'T-plan', minutes: 6 });
});

test("a plan step's unanswered question reads Waiting for you, with only the question's first line", () => {
  const tasks = [passed, plan({ status: 'blocked', lastAttemptId: 'a-ask' })],
    records = state(tasks, [checked, asked]);
  expect(explain(tasks[1]!, records).kind).toBe('question');
  expect(read(tasks, [checked, asked])).toEqual({
    state: 'you',
    taskId: 'T-plan',
    workerId: 'W-4',
    label: 'Waiting for you',
    text: 'Split the page part into two stories?',
  });
});

test('the same question once answered, or left to auto mode, does not read Waiting for you', () => {
  // Answered: the controller queues the plan again with the answer as its direction.
  const answered = [
    passed,
    plan({
      status: 'ready',
      queued: true,
      lastAttemptId: 'a-ask',
      answers: [{ attemptId: 'a-ask', option: 1, label: 'Two stories', by: { type: 'director' }, at: at(6) }],
    }),
  ];
  expect(read(answered, [checked, asked])).toMatchObject({ state: 'planning', label: 'Planning', minutes: 9 });
  // Left to the work's own auto mode, which answers a choice inside the story with the recommendation.
  const auto = [passed, plan({ status: 'blocked', lastAttemptId: 'a-ask', autoMode: true })];
  expect(explain(auto[1]!, state(auto, [checked, asked])).kind).toBe('question-auto');
  expect(read(auto, [checked, asked])).toMatchObject({ state: 'planning', taskId: 'T-plan', label: 'Planning' });
  // A question that touches a kind kept for the director still waits for them, auto mode or not.
  const kept = { ...asked, question: { ...question, topics: ['scope'] } };
  expect(read(auto, [checked, kept])).toMatchObject({ state: 'you', label: 'Waiting for you' });
});

test('a plan in review waiting for the director to accept it reads Waiting for you, with the call', () => {
  const tasks = [passed, plan({ status: 'review', lastAttemptId: 'a-plan' })],
    done = attempt('a-plan', 'T-plan', 4, {
      status: 'review',
      finishedAt: at(7),
      result: { outcome: 'completed', summary: 'Two stories.' },
    }),
    records = state(tasks, [checked, done]);
  expect(read(tasks, [checked, done])).toEqual({
    state: 'you',
    taskId: 'T-plan',
    workerId: 'W-4',
    label: 'Waiting for you',
    text: standing(tasks[1]!, records).title,
  });
  expect(read(tasks, [checked, done])!.text).toBe('The completed result is ready for acceptance.');
  // With the house rules accepting plans, the controller accepts it: still Planning.
  const auto = {
    ...records,
    autonomy: { policy: { enabled: true, kinds: { 'studio-development:breakdown': { accept: 'auto' } } } },
  } as unknown as StudioState;
  expect(read(tasks, [], Date.parse(at(10)), auto)).toMatchObject({ state: 'planning', label: 'Planning' });
});

test("failed checks or a failed plan read Stopped with the step's reason and what to do, never '<name> stopped:'", () => {
  const failedChecks = [checks({ status: 'failed', lastAttemptId: 'a-checks' }), plan({ queued: true })],
    failing = attempt('a-checks', 'T-checks', 1, {
      status: 'failed',
      finishedAt: at(3),
      error: 'The source checks did not pass.',
      testEvidence: { totals: { tests: 539, pass: 537, fail: 2 } },
    }),
    stand = standing(failedChecks[0]!, state(failedChecks, [failing])),
    stopped = read(failedChecks, [failing])!;
  expect(stopped).toMatchObject({ state: 'stopped', taskId: 'T-checks', workerId: 'W-3', label: 'Stopped' });
  expect(stopped.text).toBe(`${stand.title} ${stand.detail}`);
  expect(stopped.text).toContain("The attempt's tests did not pass: 537 of 539.");
  expect(stopped.text).toContain('then use Start assignment.');
  const failedPlan = [passed, plan({ status: 'failed', lastAttemptId: 'a-plan' })],
    failed = attempt('a-plan', 'T-plan', 4, { status: 'failed', finishedAt: at(7), error: 'The plan was not valid.' }),
    plain = standing(failedPlan[1]!, state(failedPlan, [checked, failed])),
    planStop = read(failedPlan, [checked, failed])!;
  expect(planStop).toMatchObject({ state: 'stopped', taskId: 'T-plan', workerId: 'W-4', label: 'Stopped' });
  expect(planStop.text).toBe(`${plain.title} ${plain.detail}`);
  expect(planStop.text).toBe(
    'The attempt stopped without a validated completed result. Inspect the validation detail, correct the output or scope, then use Start assignment.',
  );
  for (const text of [stopped.text, planStop.text]) {
    expect(text).not.toMatch(/(Avery|Mara) stopped/);
    expect(text).not.toMatch(/\w stopped:/);
    expect(text).not.toBe('failed');
  }
  expect(stopped).not.toHaveProperty('minutes');
});

test('a plan the controller holds reads Planning; a question that could not be read is a stop', () => {
  const blocked = (fields: Partial<Task>, attempts: AttemptSummary[]) =>
    read([passed, plan({ status: 'blocked', ...fields })], [checked, ...attempts]);
  // Held for a free slot before it started: the controller's own wait.
  expect(
    blocked({ controllerWait: true, queued: true, reason: 'Waiting for a studio execution slot.' }, []),
  ).toMatchObject({ state: 'planning', taskId: 'T-plan', label: 'Planning', minutes: 9 });
  // The planner's question.json could not be read, so nothing waits for an answer: it stopped.
  const unread = {
      ...asked,
      result: { outcome: 'blocked', summary: 'Needs a call from the director.' },
      question: { problem: 'question.json must be readable JSON.' },
    },
    stop = blocked({ lastAttemptId: 'a-ask', reason: 'Needs a call from the director.' }, [unread])!;
  expect(stop).toMatchObject({ state: 'stopped', taskId: 'T-plan', label: 'Stopped' });
  expect(stop.text).toContain("The agent's question could not be read: question.json must be readable JSON.");
});

test('an accepted plan is official, and an idea with no plan step has no planning to read', () => {
  const official = [passed, plan({ status: 'done', lastAttemptId: 'a-plan', acceptedAttemptId: 'a-plan' })],
    accepted = attempt('a-plan', 'T-plan', 4, { status: 'accepted', finishedAt: at(7) });
  expect(read(official, [checked, accepted])).toBeNull();
  // Work with no plan, even with checks still running, and an idea with no graph yet.
  const work = step('T-1', 'general:work', { workerId: 'W-1', status: 'running', lastAttemptId: 'a-1' });
  expect(read([work], [attempt('a-1', 'T-1', 2)])).toBeNull();
  expect(
    read([checks({ status: 'running', lastAttemptId: 'a-checks' })], [attempt('a-checks', 'T-checks', 1)]),
  ).toBeNull();
  expect(planningOf({ ...idea([]), graph: null }, state([]), Date.parse(at(10)))).toBeNull();
});
