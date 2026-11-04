// The story page's task actions as shared rules (public/task-actions.js): in every decision state the page's own
// tests open, the page offers exactly the actions the shared rules list, in the same order, apart from the page's own
// controls named below; each listed action names a route the controller answers and the fields it takes.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Task } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { taskActions, type StudioState, type TaskAction } from './studio-runs';
import { createStream, decisionStates, fakeController, type Controller } from './test-controller';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The page's own controls, which open something rather than ask the controller for one recorded step: the More
// actions menu (its items are compared in its place), Try it's strip, the file form, the link to the full account, and
// the studio's own dispatch switch, which is not a task's route.
const pageOnly = [
  'More actions',
  'Try it',
  'Edit the file list',
  'Read why in Checks',
  'Read why in Overview',
  'Resume dispatch',
];

// What each state offers, as task-decisions.test.tsx shows it, so neither side can match the other by offering nothing.
const expected: Record<string, string[]> = {
  'ready work': ['Start assignment', 'Close this step'],
  'a waiting question': ['Send to Eli', 'Start assignment', 'Close'],
  'a stop without a question': ['Start assignment', 'Close'],
  'an interrupted attempt': ['Reconcile interrupted attempt'],
  'a quarantined attempt': ['Reconcile interrupted attempt'],
  'an interrupted attempt after reconciling': ['Start assignment', 'Close'],
  'a result in review': ['Accept result', 'Request revision', 'Close without accepting'],
  'past the attempt limit': ['Start assignment', 'Close'],
  'proposed work': ['Approve work', 'Deny work'],
  'running work': ['Request cancellation'],
  'a passing review': ['Integrate', 'Send back to Eli', 'Close without integrating'],
  'a review in progress': ['Request cancellation'],
  'a review that asked for changes': ['Send back to Eli', 'Integrate over the review', 'Close without integrating'],
  'a conflict': ['Merge onto the current source', 'Integrate again', 'Send back to Eli', 'Close without integrating'],
  'landed since': ['Merge onto the current source', 'Integrate again', 'Send back to Eli', 'Close without integrating'],
  'failed with nothing landed': ['Integrate again', 'Send back to Eli', 'Close without integrating'],
  'a carry waiting': ['Carry to main', 'Not needed on main…'],
  'a landed story with bring-back lines': ['Bring back to release/1.1', 'Bring back to release/1.0'],
  'a landed story on a project with one line': [],
  'a landed carry story': [],
  'a stopped bring-back': ['Bring back to release/1.0 again', 'Not needed on release/1.0…'],
  // The code moved past the story's plan: the one step that works, with plain Close behind More actions.
  'a story the code moved past': ['Close and send as a new idea', 'Close'],
  // A file request the controller would refuse as asked: no Allow and continue, nor its file form.
  'a file request outside the measured list': ['Start assignment', 'Close'],
  'a closed story': [],
};

// The story page for a task, as task-decisions.test.tsx opens it.
const open = (controller: Controller, task: Task) => {
  controller.tasks = [task, ...controller.tasks.filter(item => item.id !== task.id)];
  render(
    createElement(App, {
      router: createAppRouter(createMemoryHistory({ initialEntries: [`/p/project-x/tasks/${task.id}`] })),
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
      createStream,
    }),
  );
};
// The records the page holds for the project: its shell and its live records.
const studioOf = (controller: Controller): StudioState => ({
  ...controller.shell,
  tasks: controller.tasks,
  attempts: controller.attempts,
  runs: controller.runs,
});

// The labels the page offers, in its order: the question card's send button, then each button under "Where it
// stands" (a command request's form, the decisions row, Try it and Bring back), with More actions standing for the
// closing actions its menu lists. Buttons in a closed dialog are not offered.
function offered() {
  const asking = screen.queryByRole('article', { name: /'s question$/ }),
    answer = asking
      ? within(asking)
          .getAllByRole('button')
          .filter(button => (button as HTMLButtonElement).type === 'submit')
          .map(button => button.textContent?.trim() ?? '')
      : [],
    region = screen.getByRole('region', { name: 'Where it stands' }),
    closing = within(region)
      .queryAllByRole('menuitem', { hidden: true })
      .map(item => document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''),
    stands = within(region)
      .queryAllByRole('button')
      .flatMap(button => {
        const name = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
        return name === 'More actions' ? [name, ...closing] : [name];
      });
  return [...answer, ...stands];
}
const compared = (labels: string[]) => labels.filter(label => !pageOnly.includes(label));

test.each(Object.keys(decisionStates))(
  'in the state "%s", the page offers what the shared rules list, in order',
  async name => {
    const controller = fakeController(),
      task = decisionStates[name]!(controller);
    vi.stubGlobal('confirm', () => true);
    open(controller, task);
    await screen.findByRole('region', { name: 'Where it stands' });
    const listed = () =>
      taskActions(task, studioOf(controller), { bringBack: controller.bringBack[task.id] ?? { lines: [] } }).map(
        action => action.label,
      );
    expect(listed()).toEqual(expected[name]);
    // The page reads what it offers as it loads (Try it, Bring back's lines), so it is compared once it settles.
    await waitFor(() => expect(compared(offered())).toEqual(listed()));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(compared(offered())).toEqual(listed());
  },
);

// Every listed action names a route the controller answers for the task, or the pipeline, and the fields it takes,
// the project among them.
test('every listed action has a key, a label, a POST or PATCH, a route and fields with the project', () => {
  const all: { task: Task; action: TaskAction }[] = [];
  for (const setUp of Object.values(decisionStates)) {
    const controller = fakeController(),
      task = setUp(controller);
    controller.tasks = [task, ...controller.tasks.filter(item => item.id !== task.id)];
    const state = studioOf(controller);
    // With and without the bring-back read, and a command request, so every kind of action is checked.
    for (const reads of [{ bringBack: controller.bringBack[task.id] ?? { lines: [] } }, {}])
      for (const action of taskActions(task, state, reads)) all.push({ task, action });
  }
  expect(all.length).toBeGreaterThan(30);
  for (const { task, action } of all) {
    expect(action.key).toBeTruthy();
    expect(action.label).toBeTruthy();
    expect(['POST', 'PATCH']).toContain(action.method);
    const id = encodeURIComponent(task.id);
    expect(
      action.path === `/api/tasks/${id}` ||
        action.path.startsWith(`/api/tasks/${id}/`) ||
        action.path === '/api/pipeline',
    ).toBe(true);
    expect(action.fields.find(field => field.name === 'projectId')).toEqual({
      name: 'projectId',
      required: true,
      kind: 'id',
      value: 'project-x',
    });
    for (const field of action.fields) expect(typeof field.required).toBe('boolean');
  }
});

// The routes and fields the page sends, as task-decisions.test.tsx records them.
test('the listed routes and fields are the ones the page sends', () => {
  const listed = (name: string, setUp?: (controller: Controller, task: Task) => Task) => {
    const controller = fakeController();
    let task = decisionStates[name]!(controller);
    if (setUp) task = setUp(controller, task);
    controller.tasks = [task, ...controller.tasks.filter(item => item.id !== task.id)];
    return taskActions(task, studioOf(controller), { bringBack: controller.bringBack[task.id] ?? { lines: [] } });
  };
  const brief = (action?: TaskAction) =>
    action && {
      method: action.method,
      path: action.path,
      fields: Object.fromEntries(
        action.fields.map(field => [field.name, field.value ?? (field.required ? 'needed' : 'may')]),
      ),
    };
  expect(brief(listed('ready work').find(action => action.key === 'start'))).toEqual({
    method: 'POST',
    path: '/api/tasks/T-1/start',
    fields: { projectId: 'project-x', direction: 'may' },
  });
  // Past the attempt limit, the same Start, whose note is the next attempt's direction.
  expect(listed('past the attempt limit')[0]!.key).toBe('start-past-limit');
  // The served count decides it (attemptCount): one the controller counts below its limit, such as a flow's next
  // round with the earlier round's attempt on record, is an ordinary Start; one at its limit is past it.
  expect(
    listed('past the attempt limit', (_, task) => ({ ...task, attemptCount: { used: 0, allowed: 1 } }))[0]!.key,
  ).toBe('start');
  expect(listed('ready work', (_, task) => ({ ...task, attemptCount: { used: 3, allowed: 3 } }))[0]!.key).toBe(
    'start-past-limit',
  );
  expect(brief(listed('a result in review').find(action => action.key === 'revise'))).toEqual({
    method: 'POST',
    path: '/api/tasks/T-1/revise',
    fields: { projectId: 'project-x', direction: 'needed' },
  });
  // Accepting may carry a reason, to accept over a failed check.
  expect(brief(listed('a result in review').find(action => action.key === 'accept'))?.fields).toEqual({
    projectId: 'project-x',
    overReason: 'may',
  });
  expect(brief(listed('a passing review').find(action => action.key === 'integrate'))).toEqual({
    method: 'POST',
    path: '/api/tasks/T-1/integrate-source',
    fields: { projectId: 'project-x', attemptId: 'attempt-review', reviewHash: 'review-hash', overrideReason: 'may' },
  });
  // A pass that noted nothing needs the director's note; the review that asked for changes sent its findings.
  expect(brief(listed('a passing review').find(action => action.key === 'send-back-passed'))?.fields.note).toBe(
    'needed',
  );
  expect(brief(listed('a review that asked for changes').find(action => action.key === 'over'))?.fields).toEqual({
    projectId: 'project-x',
    attemptId: 'attempt-review',
    reviewHash: 'review-hash',
    overrideReason: 'needed',
  });
  expect(brief(listed('a stopped bring-back').find(action => action.key === 'carry-skip'))?.fields).toEqual({
    projectId: 'project-x',
    line: 'release/1.0',
    reason: 'needed',
  });
  expect(brief(listed('a landed story with bring-back lines').at(-1))).toEqual({
    method: 'POST',
    path: '/api/tasks/T-1/bring-back',
    fields: { projectId: 'project-x', line: 'release/1.0' },
  });
  expect(brief(listed('a waiting question')[0])).toEqual({
    method: 'POST',
    path: '/api/tasks/T-1/answer',
    fields: { projectId: 'project-x', attemptId: 'attempt-1', option: 'may', text: 'may', autoMode: 'may' },
  });
  // Close and send as a new idea may carry the director's words for the idea.
  expect(brief(listed('a story the code moved past')[0])).toEqual({
    method: 'POST',
    path: '/api/tasks/T-1/send-as-idea',
    fields: { projectId: 'project-x', idea: 'may' },
  });
  // A held task's Release hold is a change to the task itself.
  expect(
    brief(listed('ready work', (_, task) => ({ ...task, hold: true })).find(action => action.key === 'hold')),
  ).toEqual({ method: 'PATCH', path: '/api/tasks/T-1', fields: { projectId: 'project-x', hold: false } });
  // A command request is allowed from the attempt that stopped, with the commands it asked for.
  const commands = listed('a stop without a question', (controller, task) => {
    controller.attempts[0]!.commandDenials = [{ tool: 'Bash', input: { command: 'npm run lint' } }];
    return task;
  });
  // Shown only where the shared explanation says the stop is a command request.
  for (const action of commands.filter(item => item.key === 'allow-commands'))
    expect(brief(action)?.path).toBe('/api/tasks/T-1/allow-commands');
});

// The script needs nothing but the run rules before it: no imports, and it sets a frozen module.
test('the shared script has no imports and runs after the run rules', async () => {
  // The file's base kept apart, so Vite does not rewrite the script's URL as a browser asset's.
  const base = import.meta.url,
    { readFileSync } = await vi.importActual<{ readFileSync: (file: URL, encoding: 'utf8') => string }>('node:fs'),
    read = (name: string) => readFileSync(new URL('../../public/' + name, base), 'utf8'),
    script = read('task-actions.js');
  expect(script).not.toMatch(/^\s*import\b|\brequire\(|\bimport\(/m);
  const scope: { StudioRuns?: unknown; StudioTaskActions?: { taskActions: unknown } } = {};
  new Function('globalThis', read('runs.js'))(scope);
  new Function('globalThis', script)(scope);
  expect(Object.isFrozen(scope.StudioTaskActions)).toBe(true);
  expect(Object.keys(scope.StudioTaskActions ?? {})).toEqual(['taskActions']);
  expect(typeof scope.StudioTaskActions?.taskActions).toBe('function');
});
