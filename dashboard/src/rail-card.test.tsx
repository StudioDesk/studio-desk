// The card beside another project's tile (the attention indicator, October 29): pointing at or focusing a tile with a
// count shows the project's mark, name, count and one line for each of its calls, what to do and where, in the order
// its Today lists them; leaving, blurring away and Escape close it, and it follows the rail's reads.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AttemptSummary, Live, RunRecord, Shell, Task } from './api';
import { App } from './app';
import type { Question } from './questions';
import { callLine } from './rail-card';
import { createAppRouter } from './router';
import { liveSummary, type StudioState } from './studio-runs';
import { createStream, fakeController, latest, shellFixture, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = (path = '/p/project-x') => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <App
      router={router}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
  return router;
};

// Project Y's shell: the same projects, with Eli building and Morgan reviewing.
const projectY = (): Shell => ({
  ...shellFixture(),
  project: { id: 'project-y', name: 'Project Y' },
  workers: [
    { id: 'W-1', displayName: 'Eli', team: 'Engineering' },
    { id: 'W-2', displayName: 'Morgan', team: 'Review' },
  ],
});
// An idea as the controller's run view sends it, with its tasks as its stories.
const idea = (id: string, brief: string, createdAt: string, tasks: Task[]): RunRecord => ({
  id,
  createdAt,
  brief,
  workflow: { id: 'workflow-1', name: 'Fixture flow', version: 1 },
  revisions: [{ revision: 1, at: createdAt, reason: 'created' }],
  nodes: tasks.map(task => ({
    taskId: task.id,
    key: task.id,
    kind: task.kind,
    title: task.title,
    workerId: 'W-1',
    dependencies: task.dependencies ?? [],
    revision: 1,
  })),
});
const inRun = (runId: string) => ({ workflowReference: { runId, key: runId, id: 'workflow-1', name: 'Fixture flow' } });
const railIdea = 'Show each project’s calls when I point at its tile';
// The planning step of the rail idea, waiting for the director's approval.
const plan = () =>
  taskFixture('T-plan', {
    title: 'Plan the rail card',
    kind: 'general:plan',
    status: 'backlog',
    approval: { status: 'pending' },
    ...inRun('run-rail'),
  });
// An agent's question (src/core/questions.mjs readQuestion): its attempt stopped blocked with it.
const question: Question = {
  ask: 'Keep the old route for one release?',
  why: 'Two pages still call it.',
  options: [{ label: 'Keep it' }, { label: 'Remove it' }],
  recommended: 1,
  choice: 'inside-story',
  topics: [],
};
const asked = (): [Task, AttemptSummary] => [
  taskFixture('T-ask', { title: 'Retire the old route', status: 'blocked', lastAttemptId: 'attempt-ask' }),
  {
    id: 'attempt-ask',
    taskId: 'T-ask',
    status: 'blocked',
    workerId: 'W-1',
    startedAt: '2026-10-28T11:40:00.000Z',
    finishedAt: '2026-10-28T12:00:00.000Z',
    question,
  },
];
const result = (): [Task, AttemptSummary] => [
  taskFixture('T-result', { title: 'Show the badge', status: 'review', lastAttemptId: 'attempt-result' }),
  {
    id: 'attempt-result',
    taskId: 'T-result',
    status: 'review',
    workerId: 'W-1',
    result: { outcome: 'completed', summary: 'The badge shows.' },
  },
];
// Work that never needs the director, beside the calls: running work.
const running = (): [Task, AttemptSummary] => [
  taskFixture('T-run', { title: 'Build the board', status: 'running', lastAttemptId: 'attempt-run' }),
  { id: 'attempt-run', taskId: 'T-run', status: 'running', workerId: 'W-1', startedAt: new Date().toISOString() },
];
// Project Y holding a plan to approve and a question an agent asked, with running work beside them.
const twoCalls = (): Live => {
  const [question, asking] = asked(),
    [work, attempt] = running(),
    planning = plan();
  return {
    tasks: [question, planning, work],
    attempts: [asking, attempt],
    runs: [idea('run-rail', railIdea, '2026-10-29T09:00:00.000Z', [planning])],
  };
};
const twoLines = [
  ['Approve the plan', `“${railIdea}”`],
  ['Answer a question', 'Retire the old route'],
];

const rail = () => within(screen.getByRole('navigation', { name: 'Projects' }));
const queryCard = () => screen.queryByRole('group', { name: /^Calls in / });
const card = () => screen.getByRole('group', { name: 'Calls in Project Y' });
// Each line of the card: what to do, and where.
const lines = () =>
  within(card())
    .getAllByRole('listitem')
    .map(item => [item.querySelector('b')?.textContent, item.querySelector('.sd-meta')?.textContent ?? null]);
const liveReads = () => controller.reads().filter(read => read === '/api/projects/project-y/live').length;
const tileY = (calls: number) =>
  screen.findByRole('link', { name: `Project Y: ${calls} ${calls === 1 ? 'call' : 'calls'} for you` });
// Tab from wherever the focus is until the element given has it.
const tabTo = async (user: ReturnType<typeof userEvent.setup>, element: HTMLElement) => {
  for (let step = 0; step < 20 && document.activeElement !== element; step++) await user.tab();
  expect(document.activeElement).toBe(element);
};

test("pointing at another project's count shows its mark, name, count and a line for each call", async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  open();
  const tile = await tileY(2);
  expect(queryCard()).toBeNull();
  fireEvent.pointerEnter(tile);
  const shown = within(card());
  // The rail's own mark: the project's initials on the tile's colors.
  const mark = shown.getByText('PY');
  expect(mark.className).toBe('sd-railcard__mark');
  expect(mark.getAttribute('style')).toBe(tile.getAttribute('style'));
  expect(shown.getByRole('link', { name: 'Project Y' }).getAttribute('href')).toBe('/p/project-y');
  expect(shown.getByText('2 calls for you')).toBeTruthy();
  // The plan names the idea in the director's words; the question, with no idea, its task's title.
  expect(lines()).toEqual(twoLines);
  // It is no dialog: the page behind it stays as it was.
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.pointerLeave(tile);
  expect(queryCard()).toBeNull();
});

test('the pointer moves from the tile into the card and it stays, then leaving the card closes it', async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  open();
  const tile = await tileY(2);
  fireEvent.pointerEnter(tile);
  fireEvent.pointerLeave(tile, { relatedTarget: card() });
  expect(queryCard()).not.toBeNull();
  // Back onto the tile's badge keeps it too.
  fireEvent.pointerLeave(card(), { relatedTarget: tile.querySelector('.sd-rail__badge') });
  expect(queryCard()).not.toBeNull();
  fireEvent.pointerLeave(card(), { relatedTarget: document.body });
  expect(queryCard()).toBeNull();
});

test('focusing the tile from the keyboard opens the card; Tab moves into it, and blurring away or Escape closes it', async () => {
  const user = userEvent.setup();
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  open();
  const tile = await tileY(2);
  await tabTo(user, tile);
  expect(lines()).toEqual(twoLines);
  // Tab moves into the card, which stays open, and on out of it, which closes it.
  await user.tab();
  expect(document.activeElement).toBe(within(card()).getByRole('link', { name: 'Project Y' }));
  await user.tab();
  expect(document.activeElement).toBe(rail().getByRole('button', { name: 'Add a project' }));
  expect(queryCard()).toBeNull();
  // Back on the tile it opens again, and Escape closes it with the focus kept on the tile.
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(tile);
  expect(queryCard()).not.toBeNull();
  await user.keyboard('{Escape}');
  expect(queryCard()).toBeNull();
  expect(document.activeElement).toBe(tile);
  // Escape inside the card closes it and gives the tile its focus back, without opening it again.
  await user.tab({ shift: true });
  await user.tab();
  expect(queryCard()).not.toBeNull();
  await user.tab();
  await user.keyboard('{Escape}');
  expect(queryCard()).toBeNull();
  expect(document.activeElement).toBe(tile);
  // Blurring away to the page closes it as well.
  await user.tab({ shift: true });
  await user.tab();
  expect(queryCard()).not.toBeNull();
  act(() => tile.blur());
  expect(queryCard()).toBeNull();
});

test("the card's lines are Project Y's calls in the order its Today lists them", async () => {
  // A story of a newer idea waits for approval too; the newer idea's calls come first, then work outside any idea.
  const live = twoCalls(),
    story = taskFixture('T-story', {
      title: 'Name the tiles',
      kind: 'studio-development:change',
      status: 'backlog',
      approval: { status: 'pending' },
      ...inRun('run-names'),
    });
  live.tasks.push(story);
  live.runs.push(idea('run-names', 'Name every tile', '2026-10-29T15:00:00.000Z', [story]));
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = live;
  open();
  fireEvent.pointerEnter(await tileY(3));
  // Today's Your calls are liveSummary(state).items for the director, in order: each is one line, in its place.
  const state: StudioState = { ...projectY(), ...live },
    summary = liveSummary(state),
    calls = summary.items.filter(item => item.requiresDirector);
  expect(calls.map(item => ('taskId' in item ? item.taskId : null))).toEqual(['T-story', 'T-plan', 'T-ask']);
  expect(lines()).toEqual(
    calls.map(item => {
      const line = callLine(item, state, summary.stories);
      return [line.verb, line.where];
    }),
  );
  expect(lines()).toEqual([['Approve the story', '“Name every tile”'], ...twoLines]);
  // Project Y's own Today lists the same calls in the same order.
  cleanup();
  controller = fakeController('project-y');
  controller.shell = projectY();
  controller.shells['project-x'] = shellFixture();
  controller.tasks = live.tasks;
  controller.attempts = live.attempts;
  controller.runs = live.runs;
  open('/p/project-y');
  const today = await screen.findByRole('region', { name: 'Your calls' });
  await waitFor(() =>
    expect(
      within(today)
        .getAllByRole('heading', { level: 3 })
        .map(heading => heading.textContent),
    ).toEqual(['Name the tiles', 'Plan the rail card', 'Retire the old route']),
  );
});

test("the open project's tile and a tile without calls open no card", async () => {
  controller.tasks = [taskFixture('T-1', { title: 'Waiting to start' })];
  controller.shells['project-y'] = projectY();
  const [work, attempt] = running();
  controller.lives['project-y'] = { tasks: [work], attempts: [attempt], runs: [] };
  open();
  const own = await screen.findByRole('link', { name: 'Project X: 1 call for you' });
  await waitFor(() => expect(liveReads()).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  const other = rail().getByRole('link', { name: 'Project Y' });
  for (const tile of [own, other]) {
    fireEvent.pointerEnter(tile);
    expect(queryCard()).toBeNull();
    act(() => tile.focus());
    expect(queryCard()).toBeNull();
    fireEvent.keyDown(tile, { key: 'Escape' });
    act(() => tile.blur());
  }
});

test("the project's name in the card, and the tile itself, open Project Y's Today", async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  let router = open();
  fireEvent.pointerEnter(await tileY(2));
  fireEvent.click(within(card()).getByRole('link', { name: 'Project Y' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-y'));
  // Project Y is the open project now: its tile opens no card.
  await waitFor(() =>
    expect(
      rail()
        .getByRole('link', { name: /^Project Y/ })
        .getAttribute('aria-current'),
    ).toBe('true'),
  );
  expect(queryCard()).toBeNull();
  cleanup();
  controller = fakeController();
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  router = open();
  fireEvent.click(await tileY(2));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-y'));
});

test('after a projects event names Project Y and it is read again, the open card lists its changed calls', async () => {
  controller.shells['project-y'] = projectY();
  controller.lives['project-y'] = twoCalls();
  open();
  fireEvent.pointerEnter(await tileY(2));
  expect(lines()).toEqual(twoLines);
  // The plan was approved and the question answered; a result waits for acceptance instead.
  const [task, attempt] = result();
  controller.lives['project-y'] = { tasks: [task], attempts: [attempt], runs: [] };
  latest().emit('projects', { projectIds: ['project-y'] });
  await waitFor(() => expect(lines()).toEqual([['Accept the result', 'Show the badge']]));
  expect(within(card()).getByText('1 call for you')).toBeTruthy();
  expect(liveReads()).toBe(2);
});

// Each call as callLine puts it, from Project Y's shell with the records given.
const linesOf = (records: Partial<Live>, shell: Partial<Shell> = {}) => {
  const state: StudioState = { ...projectY(), ...shell, tasks: [], attempts: [], runs: [], ...records },
    summary = liveSummary(state);
  return summary.items
    .filter(item => item.requiresDirector)
    .map(item => {
      const line = callLine(item, state, summary.stories);
      return [line.verb, line.where];
    });
};
// A staged story whose passing review waits to be integrated, or whose review asked for changes.
const reviewed = (verdict: 'pass' | 'needs-work'): Partial<Live> => {
  const pin = {
    taskId: 'T-1',
    attemptId: 'attempt-edit',
    workerId: 'W-1',
    path: 'source-change.json',
    hash: 'change-hash',
    candidateHash: 'candidate-hash',
  };
  return {
    attempts: [
      {
        id: 'attempt-edit',
        taskId: 'T-1',
        status: 'accepted',
        workerId: 'W-1',
        assignment: { kind: 'studio-development:change' },
        result: { outcome: 'completed' },
        sourceCandidate: { sourceHash: 'candidate-hash' },
        artifacts: [{ path: 'source-change.json', hash: 'change-hash', kind: 'source-change' }],
      },
      {
        id: 'attempt-review',
        taskId: 'T-1',
        status: 'accepted',
        workerId: 'W-2',
        finishedAt: '2026-10-27T19:02:00.000Z',
        assignment: { kind: 'studio-development:change-review' },
        result: { outcome: 'completed' },
        candidateReviewVerdict: verdict,
        candidateReview: { ...pin, passed: verdict === 'pass' },
        inputReferences: [
          { taskId: 'T-1', attemptId: 'attempt-edit', artifacts: [{ kind: 'source-change', hash: 'change-hash' }] },
        ],
        artifacts: [{ path: 'source-change-review.json', hash: 'review-hash', kind: 'source-change-review' }],
        ...(verdict === 'pass' ? { sourceIntegration: { state: 'rejected', verification: { conflicts: [] } } } : {}),
      },
    ],
    tasks: [
      taskFixture('T-1', {
        title: 'Explain a change',
        kind: 'studio-development:change',
        status: 'done',
        acceptedAttemptId: 'attempt-review',
        lastAttemptId: 'attempt-review',
        sourceStage: {
          version: 'source-story-stages-v1',
          phase: verdict === 'pass' ? 'integration' : 'candidate-review',
          current: 'failed',
          candidate: pin,
          review: {
            taskId: 'T-1',
            attemptId: 'attempt-review',
            workerId: 'W-2',
            path: 'source-change-review.json',
            hash: 'review-hash',
            verdict,
          },
        },
      }),
    ],
  };
};
// An editor stopped blocked: for files outside its story, or after Claude Code refused its commands.
const stopped = (extra: Partial<AttemptSummary>): Partial<Live> => ({
  attempts: [
    {
      id: 'attempt-blocked',
      taskId: 'T-story',
      workerId: 'W-1',
      status: 'blocked',
      startedAt: '2026-10-21T11:00:00.000Z',
      finishedAt: '2026-10-21T11:05:00.000Z',
      assignment: { kind: 'studio-development:change' },
      result: { outcome: 'blocked', summary: 'It needs more.' },
      artifacts: [],
      ...extra,
    },
  ],
  tasks: [
    taskFixture('T-story', {
      title: 'Greet the director',
      kind: 'studio-development:change',
      status: 'blocked',
      lastAttemptId: 'attempt-blocked',
      brief: 'Greet the director.\n\nFiles: src/greeting.mjs',
      approval: { status: 'approved' },
      sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'blocked', history: [] },
    }),
  ],
});

test('callLine says what each kind of call asks, as Today chooses its card, and where it is', () => {
  expect(linesOf(reviewed('pass'))).toEqual([['Try and integrate', 'Explain a change']]);
  expect(linesOf(reviewed('needs-work'))).toEqual([['Look at the requested changes', 'Explain a change']]);
  expect(
    linesOf(
      stopped({
        scopeRequest: {
          files: ['test/greeting.test.mjs'],
          newFiles: [],
          deleteFiles: [],
          reason: 'The test asserts it.',
        },
      }),
    ),
  ).toEqual([['Answer a file request', 'Greet the director']]);
  expect(linesOf(stopped({ commandDenials: [{ tool: 'Bash', command: 'npm test', reason: 'Not allowed' }] }))).toEqual([
    ['Answer a command request', 'Greet the director'],
  ]);
  const [question, asking] = asked();
  expect(linesOf({ tasks: [question], attempts: [asking] })).toEqual([['Answer a question', 'Retire the old route']]);
  // A planning step asks to approve the plan, and a story to approve the story, each named by its idea's words.
  const story = taskFixture('T-story', {
    title: 'Name the tiles',
    kind: 'general:work',
    status: 'backlog',
    approval: { status: 'pending' },
    ...inRun('run-rail'),
  });
  expect(
    linesOf({
      tasks: [plan(), story],
      runs: [idea('run-rail', railIdea, '2026-10-29T09:00:00.000Z', [plan(), story])],
    }),
  ).toEqual([
    ['Approve the plan', `“${railIdea}”`],
    ['Approve the story', `“${railIdea}”`],
  ]);
  const [task, attempt] = result();
  expect(linesOf({ tasks: [task], attempts: [attempt] })).toEqual([['Accept the result', 'Show the badge']]);
});

test('callLine puts a hold and stopped work only the director can clear in their own words', () => {
  // A CLI's usage hold with no known reset, with the work waiting on it.
  expect(
    linesOf(
      {
        tasks: [
          taskFixture('T-1', { title: 'First held work', status: 'ready', queued: true }),
          taskFixture('T-2', { title: 'Second held work', status: 'ready', queued: true }),
        ],
      },
      {
        workers: [{ id: 'W-1', displayName: 'Eli', team: 'Engineering', provider: 'claude' }],
        quota: { claude: true },
        adapters: { claude: { id: 'claude', name: 'Claude Code CLI', quotaLabel: 'Claude Code' } },
      },
    ),
  ).toEqual([['Clear the Claude Code hold', '2 steps wait on it']]);
  // A cancelled story, and the unstarted step of its idea that waits on it.
  const cancelled = taskFixture('T-stop', {
      title: 'Draw the card',
      status: 'cancelled',
      lastAttemptId: 'attempt-stop',
      ...inRun('run-rail'),
    }),
    next = taskFixture('T-next', {
      title: 'Test the card',
      status: 'ready',
      dependencies: ['T-stop'],
      ...inRun('run-rail'),
    });
  expect(
    linesOf({
      tasks: [cancelled, next],
      attempts: [{ id: 'attempt-stop', taskId: 'T-stop', status: 'cancelled', workerId: 'W-1' }],
      runs: [idea('run-rail', railIdea, '2026-10-29T09:00:00.000Z', [cancelled, next])],
    }),
  ).toEqual([
    ['Start assignment', `“${railIdea}”`],
    ['Close 1 unstarted step', `“${railIdea}”`],
  ]);
});
