// What a scheduler pass reads and what starts one (C-19, November 2, 2026). A pass ran after nearly every write and
// parsed every task the studio ever had, three times; C-18's fixture measured 27 ms a pass at 2,000 tasks, and an
// attempt's event rows and speech bubble each started one. A pass now reads the waiting and queued tasks through
// their indexes, and a write no task's readiness depends on starts none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './studio-setup.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));

test("a pass's indexed reads find what a full read would, in the same order", async t => {
  const c = await setup(t),
    { store } = c.app;
  const project = store.tasks()[0]?.projectId ?? 'project-legacy',
    base = { projectId: project, kind: 'general', title: 'A task', reason: '', resources: [], dependencies: [] };
  store.tx(() => {
    for (const [id, status, queued] of [
      ['T-a', 'ready', true],
      ['T-b', 'blocked', false],
      ['T-c', 'done', false],
      ['T-d', 'blocked', true],
      ['T-e', 'review', true],
    ])
      store.putTask({ ...base, id, status, queued });
  });
  const all = store.tasks();
  assert.deepEqual(
    store.tasksWithStatus('ready', 'blocked').map(task => task.id),
    all.filter(task => ['ready', 'blocked'].includes(task.status)).map(task => task.id),
  );
  assert.deepEqual(
    store.queuedTasks().map(task => task.id),
    all.filter(task => task.queued).map(task => task.id),
  );
  assert.equal(store.anyQueued(), true);
  store.tx(() => {
    for (const task of store.queuedTasks()) store.putTask({ ...task, queued: false });
  });
  assert.equal(store.anyQueued(), false);
  assert.deepEqual(store.queuedTasks(), []);
});

test("an event row or an attempt's speech bubble starts no scheduler pass; a task's change does", async t => {
  const c = await setup(t),
    { store, runner } = c.app;
  let passes = 0;
  const pass = runner.dispatchQueued.bind(runner);
  runner.dispatchQueued = () => {
    passes++;
    return pass();
  };
  t.after(() => (runner.dispatchQueued = pass));
  const task = store.tasks()[0];
  store.insertAttempt(
    { id: 'attempt-talking', taskId: task.id, projectId: task.projectId, status: 'accepted', workerId: task.workerId },
    { layers: [] },
  );
  await turn();
  // Work that waits keeps the pipeline on, so each pass below is one the writes asked for.
  store.putTask({ ...store.task(task.id), queued: true, status: 'blocked' });
  const org = store.organization();
  org.pipelineEnabled = true;
  store.setOrganization(org);
  await turn();
  passes = 0;
  const attempt = store.attempt('attempt-talking');
  for (let i = 0; i < 5; i++) {
    store.event('note', task.id, attempt.id, `Line ${i}.`);
    await turn();
    store.updateAttempt({ ...attempt, lastSay: { text: `Step ${i}.`, at: new Date().toISOString() } }, { trace: true });
    await turn();
  }
  assert.equal(passes, 0, 'quiet writes start no pass');
  store.updateAttempt({ ...attempt, status: 'accepted' });
  await turn();
  assert.equal(passes, 1, "an attempt's own change starts one");
  store.putTask({ ...store.task(task.id), reason: 'Changed.' });
  await turn();
  assert.equal(passes, 2, "a task's change starts one");
});
