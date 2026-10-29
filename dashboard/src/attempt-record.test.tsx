// An attempt's full record in the new dashboard (v1.0 item 14): result files read in place, pictures shown,
// files inspected, what it received, its phases, the whole log on request, and a run step's attempt.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.tasks = [
    taskFixture('T-1', { title: 'Write the notes', status: 'review', lastAttemptId: 'attempt-1' }),
    taskFixture('T-0', {
      title: 'Earlier step',
      status: 'done',
      lastAttemptId: 'attempt-0',
      acceptedAttemptId: 'attempt-0',
    }),
  ];
  controller.attempts = [
    {
      id: 'attempt-1',
      taskId: 'T-1',
      status: 'succeeded',
      workerId: 'W-1',
      provider: 'codex',
      startedAt: '2026-10-22T10:00:00Z',
      finishedAt: '2026-10-22T10:05:00Z',
      result: { summary: 'Notes written.', issues: [] },
      artifacts: [
        { path: 'result.json', hash: 'h-result', kind: 'result' },
        { path: 'notes.md', hash: 'h-notes', kind: 'work-file' },
        { path: 'review.json', hash: 'h-review', kind: 'review' },
        { path: 'drawing.svg', hash: 'h-svg', kind: 'work-file' },
      ],
    },
    {
      id: 'attempt-0',
      taskId: 'T-0',
      status: 'accepted',
      workerId: 'W-1',
      artifacts: [{ path: 'brief.txt', hash: 'h-brief', kind: 'work-file' }],
    },
  ];
  controller.artifacts = {
    'attempt-1/notes.md': '# Findings\n\nThe **door** sticks.',
    'attempt-1/review.json': JSON.stringify({
      verdict: 'revise',
      findings: ['The door sticks.'],
      evidence: ['Opened it.'],
    }),
    'attempt-1/drawing.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    'attempt-0/brief.txt': 'Make the door open.',
  };
  controller.details['attempt-1'] = {
    sessionId: 'session-9',
    outputFolder: 'C:/data/jobs/attempt-1/output',
    result: { summary: 'Notes written.', issues: [], handoff: 'Fix the hinge next.' },
    instructions: { hash: 'h-instructions', text: 'You are the engineer.' },
    inputReferences: [
      {
        taskId: 'T-0',
        attemptId: 'attempt-0',
        summary: 'The brief.',
        artifacts: [{ path: '../inputs/T-0/0-brief.txt', hash: 'h-brief', kind: 'work-file' }],
      },
    ],
    phaseEvents: [
      {
        attempt_id: 'attempt-1',
        task_id: 'T-1',
        payload: {
          schemaVersion: 'source-phase-v1',
          attemptId: 'attempt-1',
          taskId: 'T-1',
          occurrenceId: 'o-1',
          phaseId: 'test',
          boundary: 'start',
          timestamp: '2026-10-22T10:01:00Z',
        },
      },
      {
        attempt_id: 'attempt-1',
        task_id: 'T-1',
        payload: {
          schemaVersion: 'source-phase-v1',
          attemptId: 'attempt-1',
          taskId: 'T-1',
          occurrenceId: 'o-1',
          phaseId: 'test',
          boundary: 'finish',
          durationMs: 4200,
          outcome: 'succeeded',
          totals: { pass: 12, fail: 0, cancelled: 0, tests: 12 },
        },
      },
    ],
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (path: string) => {
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

test('a returned Markdown file reads in place, and a drawing shows as a picture', async () => {
  open('/p/project-x/tasks/T-1');
  const notes = (await screen.findByRole('heading', { name: 'notes.md' })).closest('section')!;
  expect(await within(notes as HTMLElement).findByRole('heading', { name: 'Findings' })).toBeTruthy();
  expect(within(notes as HTMLElement).getByText('door').tagName).toBe('STRONG');
  const picture = (await screen.findByRole('img', { name: 'drawing.svg' })) as HTMLImageElement;
  expect(picture.src).toMatch(/^data:image\/svg\+xml/);
  // Only readable text is read in place: not the result record, the review's JSON or the drawing.
  expect(screen.queryByRole('heading', { name: 'review.json' })).toBeNull();
});

test('a drawing with active content is not shown', async () => {
  controller.artifacts['attempt-1/drawing.svg'] =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" width="10" height="10"/></svg>';
  open('/p/project-x/tasks/T-1');
  expect(await screen.findByText('Preview unavailable')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'drawing.svg' })).toBeNull();
});

test("a step's Overview shows what it handed on and how its time went; its Record, what it received and ran with", async () => {
  const user = userEvent.setup();
  open('/p/project-x/tasks/T-1');
  expect(await screen.findByText('Fix the hinge next.')).toBeTruthy();
  // The step opens on its Overview, which has taken the Result tab's place.
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('tab', { name: 'Result' })).toBeNull();
  expect(screen.getByText('Tests: 12 passed, 0 failed, 0 cancelled of 12.')).toBeTruthy();
  expect(screen.getByText('4.2s')).toBeTruthy();
  // Nothing on the Overview is raw JSON or folded away.
  expect(screen.getByRole('tabpanel').querySelector('details')).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'Record' }));
  const record = within(screen.getByRole('tabpanel'));
  await user.click(record.getByText("The attempt's whole record"));
  expect(await record.findByText('session-9')).toBeTruthy();
  const received = within(record.getByText('Received from previous steps').closest('section')!);
  expect(received.getByText('The brief.')).toBeTruthy();
  expect(await received.findByText('Make the door open.')).toBeTruthy();
  await user.click(record.getByText('The instructions it ran with'));
  expect(record.getByText('You are the engineer.')).toBeTruthy();
});

test("the editor's own test runs show their failed tests and open each saved run's output", async () => {
  controller.details['attempt-1']!.employeeTestRuns = [
    // Recorded before runs were saved: no number, no failed tests, no saved files.
    {
      startedAt: '2026-10-22T10:01:00Z',
      files: ['test/a.test.mjs'],
      exitCode: 0,
      totals: { pass: 12, fail: 0, tests: 12 },
    },
    {
      number: 1,
      startedAt: '2026-10-22T10:02:00Z',
      files: [],
      exitCode: 1,
      totals: null,
      failedTests: [],
      output: { bytes: 40, hash: 'h-output-1' },
      errors: { bytes: 120, hash: 'h-errors-1' },
    },
    {
      number: 2,
      startedAt: '2026-10-22T10:03:00Z',
      files: [],
      exitCode: 1,
      totals: { pass: 755, fail: 1, tests: 756 },
      failedTests: [
        {
          name: 'a saved run is served while its bytes match',
          file: 'test/source-changes.test.mjs',
          error: 'Expected values to be strictly equal: 409 !== 200',
        },
      ],
      output: { bytes: 412000, hash: 'h-output-2' },
      errors: { bytes: 0, hash: 'h-empty' },
    },
  ];
  open('/p/project-x/tasks/T-1');
  const runs = await screen.findByRole('region', { name: "Eli's test runs" });
  // One row a run, in the order they ran; a row's failed tests are a list of their own.
  const rows = Array.from(runs.querySelector('ol')!.children) as HTMLElement[];
  expect(rows).toHaveLength(3);
  const [older, stopped, failing] = rows as [HTMLElement, HTMLElement, HTMLElement];
  // The run that failed a test names it, where it is and how its error starts, and opens its whole output.
  expect(within(failing).getByText('755/756 passed, 1 failed')).toBeTruthy();
  const failed = within(within(failing).getByRole('list', { name: 'Failed tests' }));
  expect(failed.getByText('a saved run is served while its bytes match')).toBeTruthy();
  expect(failed.getByText(/test\/source-changes\.test\.mjs/)).toBeTruthy();
  expect(failed.getByText(/Expected values to be strictly equal: 409 !== 200/)).toBeTruthy();
  expect(
    within(failing)
      .getByRole('link', { name: /Test output/ })
      .getAttribute('href'),
  ).toBe('/api/attempts/attempt-1/test-runs/2?projectId=project-x&file=output');
  // Its errors file is empty, so there is nothing to open.
  expect(within(failing).queryByRole('link', { name: /Errors/ })).toBeNull();
  // A run that stopped before its totals still opens what it printed, errors too.
  expect(within(stopped).getByText('Stopped with exit code 1 before reporting totals')).toBeTruthy();
  expect(within(stopped).queryByRole('list', { name: 'Failed tests' })).toBeNull();
  expect(
    within(stopped)
      .getByRole('link', { name: /Errors/ })
      .getAttribute('href'),
  ).toBe('/api/attempts/attempt-1/test-runs/1?projectId=project-x&file=errors');
  // A run recorded before runs were saved shows as before, without links.
  expect(within(older).getByText('12/12 passed')).toBeTruthy();
  expect(within(older).getByText('test/a.test.mjs')).toBeTruthy();
  expect(within(older).queryByRole('link')).toBeNull();
});

test('the files a step returned are listed beside the one open, and a review reads as its findings', async () => {
  const user = userEvent.setup();
  open('/p/project-x/tasks/T-1');
  // What it made comes first, the first of it open; the review is a filter away.
  const files = within(await screen.findByRole('list', { name: 'Files' }));
  expect(files.getAllByRole('button').map(item => item.textContent)).toEqual([
    'mdnotes.mdWritten',
    'svgdrawing.svgWritten',
  ]);
  await user.click(screen.getByRole('button', { name: 'Reviews · 1' }));
  const pane = within(await screen.findByRole('region', { name: 'review.json' }));
  expect(await pane.findByRole('heading', { name: 'Review · revise' })).toBeTruthy();
  expect(pane.getByText('The door sticks.')).toBeTruthy();
  expect(pane.getByRole('link', { name: 'Download review.json' }).getAttribute('href')).toBe(
    '/api/attempts/attempt-1/artifact?projectId=project-x&path=review.json',
  );
});

test('the whole log loads a page at a time when asked for', async () => {
  const user = userEvent.setup();
  controller.logs['attempt-1'] = Array.from({ length: 620 }, (_, index) => ({
    seq: index + 1,
    time: '2026-10-22T10:00:00Z',
    kind: 'log',
    message: `line ${index + 1}`,
    task_id: 'T-1',
    attempt_id: 'attempt-1',
  }));
  open('/p/project-x/tasks/T-1');
  await user.click(await screen.findByRole('tab', { name: 'Activity' }));
  const log = await screen.findByLabelText('Raw log');
  expect(log.textContent?.split('\n')).toHaveLength(300);
  await user.click(screen.getByRole('button', { name: 'Show every line' }));
  expect(await screen.findByText('620 of 620 event lines read · Complete.')).toBeTruthy();
  expect(screen.getByLabelText('Raw log').textContent?.split('\n')).toHaveLength(620);
  expect(controller.reads().filter(url => url.includes('/logs?') && url.includes('limit='))).toEqual([
    '/api/attempts/attempt-1/logs?projectId=project-x&limit=500&after=0',
    '/api/attempts/attempt-1/logs?projectId=project-x&limit=500&after=500&snapshot=620',
  ]);
});

test("an idea's finished step leads to its story, where its attempt's record is read", async () => {
  const user = userEvent.setup();
  const reference = { workflowReference: { runId: 'run-1', key: 'notes', id: 'flow', name: 'Flow', version: 1 } };
  controller.tasks = [{ ...controller.tasks[0]!, ...reference }];
  controller.runs = [
    {
      id: 'run-1',
      createdAt: '2026-10-22T09:59:00Z',
      brief: 'Write it down.',
      workflow: { id: 'flow', name: 'Flow', version: 1 },
      revisions: [{ revision: 1, at: '2026-10-22T09:59:00Z', reason: 'created' }],
      nodes: [
        {
          taskId: 'T-1',
          key: 'notes',
          kind: 'general',
          title: 'Write the notes',
          workerId: 'W-1',
          dependencies: [],
          revision: 1,
        },
      ],
      archive: { archived: false },
    },
  ];
  controller.attempts[0] = { ...controller.attempts[0]!, executionTiming: { durationMs: 300000, activeStart: null } };
  open('/p/project-x/runs/run-1');
  // The idea's page says who worked on it and for how long, and reads no attempt's whole record.
  const who = within(await screen.findByRole('region', { name: 'Who worked on it' }));
  expect(who.getByText('5 min')).toBeTruthy();
  // What it produced lists the step's files, read only when one is open.
  const made = within(screen.getByRole('region', { name: 'What it produced' }));
  expect(made.getByRole('button', { name: /notes\.md/ })).toBeTruthy();
  expect(controller.reads().some(url => url.startsWith('/api/attempts/attempt-1?'))).toBe(false);
  await user.click(
    within(screen.getByRole('region', { name: 'One story' })).getByRole('link', { name: /Write the notes/ }),
  );
  expect(await screen.findByText('Fix the hinge next.')).toBeTruthy();
  expect(controller.reads().some(url => url.startsWith('/api/attempts/attempt-1?'))).toBe(true);
});
