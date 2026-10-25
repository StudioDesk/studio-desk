// The source story on its page: the change read one file at a time from its recorded evidence (checked by
// public/source-diff.js), and editing the story's files.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { Task } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, type Controller } from './test-controller';

// Hashes as the controller records them (SHA-256, hexadecimal), worked out once before the tests.
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
const before = 'export const greeting = "hello";\n',
  after = 'export const greeting = "hello, director";\nexport const farewell = "bye";\n',
  diffText =
    'diff --git a/src/greeting.mjs b/src/greeting.mjs\n--- a/src/greeting.mjs\n+++ b/src/greeting.mjs\n@@ -1 +1,2 @@\n-export const greeting = "hello";\n+export const greeting = "hello, director";\n+export const farewell = "bye";\n';
let manifestText = '',
  hashes: Record<'manifest' | 'diff' | 'after' | 'candidate', string>;
beforeAll(async () => {
  const [base, candidate, beforeHash, afterHash, diff] = await Promise.all(
    ['base', 'candidate', before, after, diffText].map(sha256),
  );
  manifestText = JSON.stringify({
    schemaVersion: 'source-change-v1',
    proposal: { taskId: 'planning' },
    baseHash: base,
    candidateHash: candidate,
    changes: [
      { path: 'src/greeting.mjs', beforeHash, afterHash, bytes: after.length, artifact: 'changes/src/greeting.mjs' },
    ],
    diffFormat: 'unified-full-deletions-v1',
  });
  hashes = { manifest: await sha256(manifestText), diff: diff!, after: afterHash!, candidate: candidate! };
});

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.attempts = [
    {
      id: 'attempt-edit',
      taskId: 'T-story',
      projectId: 'project-x',
      workerId: 'W-1',
      status: 'accepted',
      startedAt: '2026-10-21T10:01:00.000Z',
      finishedAt: '2026-10-21T10:02:00.000Z',
      assignment: { kind: 'studio-development:change' },
      sourceCandidate: { sourceHash: hashes.candidate },
      result: { outcome: 'completed', summary: 'Greets the director.', issues: [] },
      artifacts: [
        { path: 'source-change.json', kind: 'source-change', hash: hashes.manifest },
        { path: 'change.diff', kind: 'source-change-diff', hash: hashes.diff },
        { path: 'changes/src/greeting.mjs', kind: 'source-file', hash: hashes.after },
      ],
    },
  ];
  controller.artifacts = {
    'attempt-edit/source-change.json': manifestText,
    'attempt-edit/change.diff': diffText,
    'attempt-edit/changes/src/greeting.mjs': after,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const story = (extra: Partial<Task> = {}) =>
  taskFixture('T-story', {
    title: 'Greet the director',
    kind: 'studio-development:change',
    status: 'review',
    lastAttemptId: 'attempt-edit',
    sourceStage: {
      version: 'source-story-stages-v1',
      phase: 'candidate-review',
      current: 'candidate-review',
      history: [],
      candidate: {
        taskId: 'T-story',
        attemptId: 'attempt-edit',
        workerId: 'W-1',
        path: 'source-change.json',
        hash: hashes.manifest,
        candidateHash: hashes.candidate,
      },
    },
    ...extra,
  });
const open = (task: Task) => {
  controller.tasks = [task];
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [`/p/project-x/tasks/${task.id}`] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
};

test('the change reads one file at a time from its checked evidence, which is read once', async () => {
  const user = userEvent.setup();
  open(story());
  // A story with a candidate opens on its change, the first file chosen.
  expect((await screen.findByRole('tab', { name: 'Changes' })).getAttribute('aria-selected')).toBe('true');
  const panel = within(screen.getByRole('tabpanel'));
  const file = await panel.findByRole('button', { name: /^src\/greeting\.mjs.*2 added, 1 removed/ });
  expect(file.getAttribute('aria-current')).toBe('true');
  const rows = within(await screen.findByRole('region', { name: 'Diff of src/greeting.mjs' }));
  expect(rows.getByText('export const farewell = "bye";')).toBeTruthy();
  expect(rows.getByText('export const greeting = "hello";')).toBeTruthy();
  await user.click(file);
  await user.click(screen.getByRole('tab', { name: 'Overview' }));
  await user.click(screen.getByRole('tab', { name: 'Changes' }));
  expect(await screen.findByRole('region', { name: 'Diff of src/greeting.mjs' })).toBeTruthy();
  expect(controller.reads().filter(url => url.includes('/artifact?'))).toEqual([
    '/api/attempts/attempt-edit/artifact?projectId=project-x&path=source-change.json',
    '/api/attempts/attempt-edit/artifact?projectId=project-x&path=change.diff',
  ]);
  expect(panel.getByRole('link', { name: 'Download change.diff' }).getAttribute('href')).toBe(
    '/api/attempts/attempt-edit/artifact?projectId=project-x&path=change.diff',
  );
  // The build attempt the change rests on is in the record.
  await user.click(screen.getByRole('tab', { name: 'Record' }));
  expect(within(screen.getByRole('tabpanel')).getByText('attempt-edit')).toBeTruthy();
});

test("a blocked editor's file request is offered for approval and sent back with the attempt that asked", async () => {
  const user = userEvent.setup();
  controller.attempts.push({
    id: 'attempt-blocked',
    taskId: 'T-story',
    projectId: 'project-x',
    workerId: 'W-1',
    status: 'blocked',
    startedAt: '2026-10-21T11:00:00.000Z',
    finishedAt: '2026-10-21T11:05:00.000Z',
    assignment: { kind: 'studio-development:change' },
    scopeRequest: {
      files: ['test/greeting.test.mjs'],
      newFiles: [],
      deleteFiles: [],
      reason: 'The test asserts the old text.',
    },
    artifacts: [],
  });
  open(
    story({
      status: 'blocked',
      lastAttemptId: 'attempt-blocked',
      brief: 'Greet the director.\n\nFiles: src/greeting.mjs',
      approval: { status: 'approved' },
      proposalReference: { taskId: 'planning' },
      sourceStage: { version: 'source-story-stages-v1', phase: 'implementing', current: 'blocked', history: [] },
    }),
  );
  expect(await screen.findByText(/stopped because the change needs paths the story does not have/)).toBeTruthy();
  expect((screen.getByLabelText('Files to edit') as HTMLTextAreaElement).value).toBe(
    'src/greeting.mjs\ntest/greeting.test.mjs',
  );
  await user.click(screen.getByRole('button', { name: 'Approve these files and send back to implementation' }));
  await waitFor(() =>
    expect(controller.requests.find(request => request.method === 'POST')).toEqual({
      url: '/api/tasks/T-story/edit-scope',
      method: 'POST',
      body: {
        projectId: 'project-x',
        files: ['src/greeting.mjs', 'test/greeting.test.mjs'],
        newFiles: [],
        deleteFiles: [],
        reason: 'The test asserts the old text.',
        // The earlier attempt staged work, so continuing from it starts checked.
        keepWork: true,
        request: 'attempt-blocked',
      },
    }),
  );
});
