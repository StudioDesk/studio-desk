// An integration requested while another is verifying waits for the source, then starts as soon as that one settles,
// passed or not, and one still waiting when the controller stops starts once it runs again (v1.0 item 30: on October
// 24 item 27's first story waited behind item 28's integration with no attempt left to settle and start it). The
// runner is a stand-in around a real store; no integration, git or model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Autonomy } from '../src/core/autonomy-runtime.mjs';
import { bootstrapFactory } from '../src/core/bootstrap.mjs';
import { createRegistries } from '../src/registry.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function studio(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-integration-queue-')),
    store = new Store(
      directory,
      bootstrapFactory(createRegistries(), { organizationPreset: 'game-studio', workflowPresets: [] }),
    );
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store.putSetting('project-autonomy:project-legacy', {
    revision: 1,
    enabled: true,
    kinds: {},
    retries: 0,
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  for (const id of ['T-first', 'T-second'])
    store.putTask({ id, title: id, kind: 'studio-development:change', status: 'done', dependencies: [] });
  // Each integration holds the repository's resource until it settles, as source integration does.
  const integrations = [];
  const integrate = (runner, task, attemptId, reviewHash, settled) => {
    store.claim(['source:repository'], 'source-integration:' + attemptId);
    integrations.push({
      taskId: task.id,
      settle(result) {
        store.release('source-integration:' + attemptId);
        settled(result);
      },
    });
    return { state: 'verifying' };
  };
  const runner = {
    store,
    closing: false,
    active: new Map(),
    selfHosted: false,
    schedule() {},
    integration: {
      target: (records, task) => task,
      resources: () => ['source:repository'],
      pauses: () => false,
      controllerSource: () => false,
      requested() {},
      failed() {},
    },
  };
  t.after(() => (runner.closing = true));
  return { store, runner, integrate, integrations };
}

test('an integration requested while another verifies starts as soon as that one settles, passed or not', async t => {
  const { store, runner, integrate, integrations } = studio(t),
    autonomy = new Autonomy(runner, { integrate });
  await tick();
  assert.equal(autonomy.requestIntegration(store.task('T-first'), 'attempt-first', 'hash-first').state, 'verifying');
  assert.equal(autonomy.requestIntegration(store.task('T-second'), 'attempt-second', 'hash-second').state, 'waiting');
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-first'],
  );
  assert.equal(autonomy.pendingIntegration().taskId, 'T-second');
  // The first settles; nothing else runs, and the waiting one starts by itself.
  integrations[0].settle({ state: 'integrated' });
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-first', 'T-second'],
  );
  assert.equal(autonomy.pendingIntegration(), null);
  // A failed integration frees the source too.
  assert.equal(autonomy.requestIntegration(store.task('T-first'), 'attempt-first-2', 'hash-first').state, 'waiting');
  integrations[1].settle({ state: 'failed', error: 'main moved during verification.' });
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-first', 'T-second', 'T-first'],
  );
  assert.match(store.task('T-second').autonomyNote, /main moved during verification/);
  integrations[2].settle({ state: 'integrated' });
  // What a settled integration schedules runs before the store closes.
  await tick();
});

test('an integration still waiting when the controller stopped starts once it runs again', async t => {
  const { store, runner, integrate, integrations } = studio(t);
  // As a stopped controller left it: a request recorded, nothing holding the source.
  store.putSetting('autonomy-integration', {
    taskId: 'T-second',
    attemptId: 'attempt-second',
    reviewHash: 'hash-second',
    projectId: 'project-legacy',
    requestedAt: new Date().toISOString(),
    paused: false,
    previousPaused: false,
    by: { type: 'policy', revision: 1, reason: 'Integrate after a passing review.' },
  });
  const autonomy = new Autonomy(runner, { integrate });
  assert.deepEqual(integrations, [], 'Not while the controller is still being built.');
  await tick();
  assert.deepEqual(
    integrations.map(item => item.taskId),
    ['T-second'],
  );
  assert.equal(autonomy.pendingIntegration(), null);
  integrations[0].settle({ state: 'integrated' });
  await tick();
});
