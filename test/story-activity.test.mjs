import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { setup } from './studio-setup.mjs';

test("a task's events are read from around its creation, without agent output, phases or other tasks", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-story-'));
  const store = new Store(directory, () => ({ organization: { workers: [], teams: [] }, tasks: [] }));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(store.taskEvents({ id: 'T-story', createdAt: '2026-06-01T10:00:00.000Z' }), []);
  // A long history before the task, some of it naming the task's identity, then the task's own events.
  for (let index = 0; index < 300; index++)
    store.event(
      'started',
      index % 3 ? 'T-other' : 'T-story',
      null,
      `Earlier ${index}.`,
      null,
      `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    );
  store.event('created', 'T-story', null, 'Assigned the story to Eli.', null, '2026-06-01T10:00:00.000Z');
  store.event('log', 'T-story', 'attempt-1', 'stdout: working', null, '2026-06-01T10:01:00.000Z');
  store.event('phase', 'T-story', 'attempt-1', '{"phaseId":"test"}', null, '2026-06-01T10:02:00.000Z');
  store.event('started', 'T-other', null, 'Another task started.', null, '2026-06-01T10:03:00.000Z');
  store.event(
    'sent_back',
    'T-story',
    'attempt-1',
    'Director sent this work back for another attempt. Note: Keep it short.',
    null,
    '2026-06-01T10:04:00.000Z',
  );
  const story = { id: 'T-story', createdAt: '2026-06-01T10:00:00.000Z' };
  assert.deepEqual(
    store.taskEvents(story).map(event => [event.kind, event.message]),
    [
      ['created', 'Assigned the story to Eli.'],
      ['sent_back', 'Director sent this work back for another attempt. Note: Keep it short.'],
    ],
  );
  // A task recorded without its creation time is read from the start of the history.
  assert.equal(store.taskEvents({ id: 'T-story' }).length, 102);
  // A task made after everything recorded has nothing yet.
  assert.deepEqual(store.taskEvents({ id: 'T-story', createdAt: '2026-07-01T00:00:00.000Z' }), []);
});

test("a task's activity names its events, its idea and the instructions published while it ran, from its own project only", async t => {
  const c = await setup(t),
    store = c.app.store,
    task = { ...store.tasks()[0], createdAt: new Date(Date.now() - 60_000).toISOString() };
  store.putTask(task);
  store.event('log', task.id, 'attempt-x', 'stdout: agent output');
  store.event('sent_back', task.id, null, 'Director sent this work back for another attempt. Note: Keep the old path.');
  store.event('sent_back', 'T-other', null, 'Director sent other work back.');
  const text = 'Company instructions, revised.';
  assert.equal((await c.request('/api/instructions/company/company/draft', { baseRevision: 1, text })).status, 200);
  assert.equal(
    (await c.request('/api/instructions/company/company/publish', { baseRevision: 1, text, note: 'Say less.' })).status,
    200,
  );
  const response = await fetch(`${c.origin}/api/tasks/${task.id}/activity`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.events.filter(event => event.kind === 'sent_back').map(event => event.message),
    ['Director sent this work back for another attempt. Note: Keep the old path.'],
  );
  assert.equal(
    body.events.some(event => event.kind === 'log'),
    false,
  );
  assert.equal(body.idea, null);
  assert.deepEqual(
    body.instructions.map(({ scope, id, revision, note }) => ({ scope, id, revision, note })),
    [{ scope: 'company', id: 'company', revision: 2, note: 'Say less.' }],
  );
  assert.equal((await fetch(`${c.origin}/api/tasks/T-missing/activity`)).status, 404);
  store.putTask({ ...task, id: 'T-elsewhere', projectId: 'project-other' });
  assert.equal((await fetch(`${c.origin}/api/tasks/T-elsewhere/activity`)).status, 400);
});
