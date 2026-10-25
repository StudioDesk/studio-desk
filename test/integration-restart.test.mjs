// The recovery drill (v1.0 criterion 3): a controller that stops at once during a source integration, as closing its
// window does, leaves the integration's journal where it was. When it starts again, that integration becomes
// uncertain and waits for Reconcile source integration, keeping the state it reached and the resources it held;
// one only waiting, or already settled, stays as it is. No git, model or integration runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';

const journal = (attemptId, state) => ({
  id: 'source-integration:' + attemptId,
  state,
  method: 'merge',
  startedAt: '2026-10-24T09:20:18.189Z',
});

test('an integration a stopped controller left running is uncertain once it starts again, and keeps its resources', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-integration-restart-'));
  let again;
  t.after(async () => {
    await again?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = createStudio({ directory, port: 0 });
  for (const [taskId, attemptId, state] of [
    ['T-verifying', 'attempt-verifying', 'verifying'],
    ['T-committing', 'attempt-committing', 'committing'],
    ['T-waiting', 'attempt-waiting', 'waiting'],
    ['T-abandoned', 'attempt-abandoned', 'abandoned'],
  ]) {
    first.store.putTask({
      id: taskId,
      title: taskId,
      kind: 'studio-development:change',
      status: 'done',
      dependencies: [],
    });
    first.store.insertAttempt(
      {
        id: attemptId,
        taskId,
        workerId: 'W-07',
        provider: 'claude',
        status: 'accepted',
        startedAt: '2026-10-24T09:19:00.000Z',
        finishedAt: '2026-10-24T09:20:00.000Z',
        artifacts: [],
        inputReferences: [],
        sourceIntegration: journal(attemptId, state),
      },
      { hash: 'snapshot', text: 'Instructions.' },
    );
  }
  first.store.claim(['source:project-x:integration', 'source:project-x:tests'], 'source-integration:attempt-verifying');
  // No integration process of the controller runs them, as when its window closed during each; a close finds
  // nothing to stop and leaves the journals as they are.
  await first.close();

  again = createStudio({ directory, port: 0 });
  const recorded = id => again.store.attempt(id).sourceIntegration;
  for (const [id, was] of [
    ['attempt-verifying', 'verifying'],
    ['attempt-committing', 'committing'],
  ]) {
    assert.equal(recorded(id).state, 'needs-reconciliation', id);
    assert.equal(recorded(id).interrupted, was, id);
    assert.equal(recorded(id).error, 'The controller stopped while this integration was running.', id);
  }
  assert.equal(recorded('attempt-waiting').state, 'waiting');
  assert.equal(recorded('attempt-abandoned').state, 'abandoned');
  assert.match(
    again.store
      .events()
      .filter(event => event.kind === 'source_attention' && event.task_id === 'T-verifying')
      .at(-1).message,
    /stopped part-way when the controller stopped \(during verifying\).*Use Reconcile source integration/,
  );
  // Its resources stay held until the director reconciles it.
  assert.deepEqual(
    again.store
      .leases()
      .filter(lease => lease.attemptId === 'source-integration:attempt-verifying')
      .map(lease => lease.resource)
      .sort(),
    ['source:project-x:integration', 'source:project-x:tests'],
  );
});
