import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { hash } from '../src/contracts.mjs';
import { validateBlockoutManifest, validateEditorPin } from '../src/unreal-gateway.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=';
const manifest = (namespace = 'Blockout_0123456789abcdef') => ({
  version: 'studio-blockout-v1',
  namespace,
  actors: ['cube', 'player-start', 'directional-light'].map((type, i) => ({
    id: 'Actor' + i,
    type,
    position: [0, 0, i * 100],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  })),
});

async function setup(t, { timeoutMs = 500, disabled = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gateway-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const roles = [
    'project',
    'engine',
    'config',
    'plugin:ModelContextProtocol',
    'plugin:MCPClientToolset',
    'plugin:EditorToolset',
  ];
  const sources = roles.map((role, i) => {
    const file = path.join(project, i === 0 ? 'fixture.uproject' : `source-${i}.json`);
    fs.writeFileSync(file, JSON.stringify({ fixture: true, role }));
    return { role, path: fs.realpathSync(file), hash: hash(fs.readFileSync(file)) };
  });
  const pin = {
    endpoint: 'http://127.0.0.1:8000/mcp',
    projectFile: sources[0].path,
    projectId: 'disposable-model-free-project',
    engineVersion: '5.8.3',
    engineChangelist: 58210709,
    editorPid: process.pid,
    editorStartedAt: new Date().toISOString(),
    sessionHash: hash('fixture-session'),
    sources,
  };
  const c = { directory, calls: [], busy: 0, maxBusy: 0, pin, scenes: new Map() };
  const driver = (c.driver = {
    mode: 'fixture',
    telemetryDisabled: true,
    pin,
    identity: structuredClone(pin),
    async call(kind, params) {
      c.busy++;
      c.maxBusy = Math.max(c.busy, c.maxBusy);
      c.calls.push(kind);
      try {
        const lease = c.app.store.leases().find(l => l.resource === 'unreal:editor');
        assert.equal(lease.token, params.leaseToken);
        const a = c.app.store.attempt(lease.attemptId),
          op = a.integration.operations.at(-1);
        assert.equal(op.id, params.operationId);
        assert.equal(op.status, 'intent', 'Intent must be committed before the driver call.');
        assert.ok(c.app.store.leases().some(l => l.resource === 'employee:' + a.workerId && l.attemptId === a.id));
        if (['create-map', 'spawn-actor', 'save-map', 'reload-map'].includes(kind)) {
          assert.ok(a.integration.checkpoint);
          assert.equal(
            hash(fs.readFileSync(path.join(c.app.store.directory, 'jobs', a.id, 'checkpoint.json'))),
            a.integration.checkpoint.hash,
          );
        }
        if (c.before) await c.before(kind, params);
        const identity = structuredClone(driver.identity);
        const clean = {
          identity,
          activeMap: '/Game/CleanOriginal',
          idle: true,
          dirtyPackages: [],
          targetExists: c.scenes.has(params.mapPath),
        };
        let response;
        if (kind === 'inspect') response = clean;
        if (kind === 'checkpoint') response = { ...clean, captured: true, baselineHash: hash('clean-fixture-map') };
        if (kind === 'create-map') {
          if (c.scenes.has(params.mapPath)) throw new Error('Target already exists.');
          c.scenes.set(params.mapPath, { actors: [] });
          response = { identity, applied: true };
        }
        if (kind === 'spawn-actor') {
          c.scenes.get(params.mapPath).actors.push(structuredClone(params.actor));
          response = { identity, applied: true };
        }
        if (kind === 'save-map') {
          c.scenes.get(params.mapPath).saved = true;
          response = { identity, applied: true };
        }
        if (kind === 'reload-map') {
          c.scenes.get(params.mapPath).reloaded = true;
          response = { identity, applied: true };
        }
        if (kind === 'capture-evidence')
          response = { identity, mapPath: params.mapPath, ...c.scenes.get(params.mapPath), screenshot: png };
        if (kind === 'reconcile')
          response = {
            identity,
            quiescent: true,
            targetInspected: true,
            targetState: c.scenes.has(params.mapPath) ? 'partial' : 'absent',
          };
        return c.alter ? c.alter(kind, response) : response;
      } finally {
        c.busy--;
      }
    },
  });
  c.open = async () => {
    c.app = createStudio({
      directory: path.join(directory, 'records'),
      port: 0,
      runnerOptions: { ...(disabled ? {} : { integrationDriver: driver }), integrationTimeoutMs: timeoutMs },
    });
    const runMock = c.app.runner.runMock.bind(c.app.runner);
    c.app.runner.runMock = entry => {
      if (entry.attempt.assignment.brief !== 'Manifest fixture') return runMock(entry);
      fs.writeFileSync(path.join(entry.output, 'manifest.json'), JSON.stringify(c.nextManifest || manifest()));
      c.app.runner.finish(entry, {
        taskId: entry.attempt.taskId,
        outcome: 'completed',
        summary: 'Model-free manifest fixture.',
        artifacts: [{ path: 'manifest.json', kind: 'unreal-manifest' }],
        checks: [],
        issues: [],
        handoff: 'No real engine work.',
      });
    };
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await c.open();
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  c.request = async (url, data = {}, token = c.token) => {
    const response = await fetch(c.origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.wait = async check => {
    await waitFor(check, 'the gateway fixture', { interval: 10 });
  };
  c.source = async (value = manifest(), accept = true) => {
    c.nextManifest = value;
    const task = (
      await c.request('/api/tasks', {
        title: 'Manifest fixture',
        workerId: 'W-03',
        kind: 'general',
        brief: 'Manifest fixture',
      })
    ).data;
    assert.equal((await c.request(`/api/tasks/${task.id}/start`)).status, 202);
    await c.wait(() => c.app.store.task(task.id).status === 'review');
    const a = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId);
    if (accept) assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 200);
    return { sourceTaskId: task.id, attemptId: a.id, manifestHash: a.artifacts[0].hash, workerId: 'W-04' };
  };
  c.integration = async (value = manifest()) => {
    const request = await c.source(value),
      response = await c.request('/api/integrations', request);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  return c;
}

test('typed blockout manifests reject scripts, asset paths, overwrites and unbounded parameters', () => {
  assert.deepEqual(validateBlockoutManifest(manifest()), manifest());
  for (const mutate of [
    m => (m.script = 'arbitrary code'),
    m => (m.namespace = '../Existing'),
    m => (m.actors[0].type = '/Script/Anything'),
    m => (m.actors[0].position[0] = Infinity),
    m => (m.actors[0].scale[0] = 0),
    m => (m.actors[0].asset = '/Game/Existing'),
    m => (m.actors[1].id = m.actors[0].id),
    m => m.actors.pop(),
  ]) {
    const m = manifest();
    mutate(m);
    assert.throws(() => validateBlockoutManifest(m));
  }
});

test('gateway API requires protected requests, exact accepted manifests and a configured fixture', async t => {
  const c = await setup(t);
  const unaccepted = await c.source(manifest(), false);
  assert.equal((await c.request('/api/integrations', unaccepted)).status, 400);
  const source = await c.source();
  assert.equal((await c.request('/api/integrations', source, 'wrong')).status, 403);
  assert.equal((await c.request('/api/integrations', { ...source, endpoint: 'http://evil.test' })).status, 400);
  assert.equal((await c.request('/api/integrations', { ...source, manifestHash: hash('forged') })).status, 400);
  assert.equal((await c.request('/api/integrations', source)).status, 201);
  assert.equal((await c.request('/api/integrations', source)).status, 409);
  assert.equal(c.calls.length, 0, 'Creation never starts engine work.');
  const disabled = await setup(t, { disabled: true });
  assert.equal((await disabled.request('/api/integrations', await disabled.source())).status, 400);
  assert.equal(disabled.app.store.tasks().filter(t => t.kind === 'unreal-integration').length, 0);
  const state = await (await fetch(disabled.origin + '/api/state')).json();
  assert.equal(state.runtime.engineConnected, false);
  assert.equal(state.runtime.integrationGateway.live, false);
});

test('editor pins require literal loopback, known process/session identity and intact descriptors', async t => {
  const c = await setup(t);
  assert.deepEqual(validateEditorPin(c.pin), c.pin);
  for (const change of [
    { endpoint: 'http://localhost:8000/mcp' },
    { editorPid: null },
    { sessionHash: '' },
    { projectId: '' },
    { sources: c.pin.sources.slice(1) },
  ])
    assert.throws(() => validateEditorPin({ ...c.pin, ...change }));
  fs.appendFileSync(c.pin.sources.find(s => s.role === 'plugin:EditorToolset').path, ' ');
  assert.throws(() => validateEditorPin(c.pin), /bytes changed/);
  const directory = path.join(c.directory, 'invalid-controller');
  assert.throws(
    () => createStudio({ directory, port: 0, runnerOptions: { integrationDriver: { ...c.driver, mode: 'live' } } }),
    /model-free/,
  );
  const replacement = createStudio({ directory, port: 0 });
  await replacement.close();
});

test('integration uses shared board attempts, atomic ownership, durable intents and director acceptance', async t => {
  const c = await setup(t),
    task = await c.integration();
  const other = await c.integration(manifest('Blockout_fedcba9876543210'));
  other.workerId = 'W-02';
  other.team = c.app.store.organization().workers.find(w => w.id === other.workerId).team;
  c.app.store.putTask(other);
  let release;
  const gate = new Promise(resolve => (release = resolve));
  c.before = async kind => {
    if (kind === 'create-map' && !c.released) await gate;
  };
  assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id, other.id] })).status, 200);
  await c.wait(() => c.calls.includes('create-map'));
  assert.equal(c.app.store.attempts(other.id).length, 0);
  assert.equal(c.app.store.leases().length, 2);
  assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 400);
  c.released = true;
  release();
  await c.wait(() => c.app.store.task(task.id).status === 'review' && c.app.store.task(other.id).status === 'review');
  assert.equal(c.maxBusy, 1);
  assert.equal(c.app.store.leases().length, 0);
  const a = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId);
  assert.equal(a.provider, 'unreal-gateway-fixture');
  assert.equal(a.pid, null);
  assert.equal(a.inputReferences[0].attemptId, task.integration.source.reference.attemptId);
  assert.equal(a.integration.state, 'validated');
  assert.ok(a.integration.operations.every(op => op.status === 'responded'));
  assert.match(a.instructions.text, /No employee CLI is launched/);
  const report = JSON.parse(fs.readFileSync(path.join(a.outputFolder, 'engine-evidence.json')));
  assert.equal(report.engineInspection, 'simulated');
  assert.equal(report.playtest, 'not-run');
  assert.equal((await c.request(`/api/tasks/${task.id}/revise`, { direction: 'Replay map' })).status, 400);
  assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 200);
  assert.equal(c.app.store.task(task.id).status, 'done');
  const screenshot = a.artifacts.find(item => item.path === 'viewport.png');
  assert.equal(hash(fs.readFileSync(path.join(a.outputFolder, screenshot.path))), screenshot.hash);
});

test('dispatch rechecks accepted hashes, manifests and project files without starting a mutation', async t => {
  for (const mode of ['artifact', 'acceptance', 'project', 'manifest']) {
    const c = await setup(t),
      task = await c.integration();
    if (mode === 'artifact')
      fs.appendFileSync(
        path.join(c.app.store.attempt(task.integration.source.reference.attemptId).outputFolder, 'manifest.json'),
        ' ',
      );
    if (mode === 'acceptance') {
      const source = c.app.store.task(task.dependencies[0]);
      source.acceptedAttemptId = 'missing';
      c.app.store.putTask(source);
    }
    if (mode === 'project') fs.appendFileSync(c.pin.projectFile, ' ');
    if (mode === 'manifest') {
      task.integration.manifest.actors[0].position[0] = 1;
      c.app.store.putTask(task);
    }
    assert.equal((await c.request(`/api/tasks/${task.id}/start`)).status, 400, mode);
    assert.equal(c.calls.length, 0);
    assert.equal(c.app.store.attempts(task.id).length, 0);
    assert.equal(c.app.store.leases().length, 0);
  }
});

test('unknown identity, dirty state, existing targets and missing checkpoints fail before mutation', async t => {
  for (const mode of ['identity', 'dirty', 'existing', 'checkpoint']) {
    const c = await setup(t),
      task = await c.integration();
    c.alter = (kind, response) => {
      if (mode === 'identity' && kind === 'inspect') response.identity.sessionHash = hash('changed');
      if (mode === 'dirty' && kind === 'inspect') response.dirtyPackages = ['/Game/Unsaved'];
      if (mode === 'existing' && kind === 'inspect') response.targetExists = true;
      if (mode === 'checkpoint' && kind === 'checkpoint') response.captured = false;
      return response;
    };
    await c.request(`/api/tasks/${task.id}/start`);
    await c.wait(() => ['failed', 'blocked'].includes(c.app.store.task(task.id).status));
    assert.ok(!c.calls.includes('create-map'), mode);
    assert.equal(c.app.store.leases().length, mode === 'identity' ? 2 : 0, mode);
    assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 400);
  }
});

test('timeout retains editor and employee ownership through late completion and read-only reconciliation', async t => {
  const c = await setup(t, { timeoutMs: 60 }),
    task = await c.integration();
  let release;
  const gate = new Promise(resolve => (release = resolve));
  c.before = kind => (kind === 'create-map' ? gate : undefined);
  await c.request(`/api/tasks/${task.id}/start`);
  await c.wait(() => c.app.store.task(task.id).status === 'blocked');
  const a = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId);
  assert.equal(a.status, 'interrupted');
  assert.equal(c.app.store.leases().length, 2);
  assert.equal((await c.request(`/api/tasks/${task.id}/reconcile`)).status, 400);
  release();
  await c.wait(() => !c.app.runner.gateway.pending.size);
  assert.equal(c.app.store.leases().length, 2, 'A late success is not automatic reconciliation or acceptance.');
  assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 400);
  c.alter = (kind, response) => (kind === 'reconcile' ? { ...response, quiescent: false } : response);
  assert.equal((await c.request(`/api/tasks/${task.id}/reconcile`)).status, 400);
  assert.equal(c.app.store.leases().length, 2);
  c.alter = null;
  assert.equal((await c.request(`/api/tasks/${task.id}/reconcile`)).status, 200);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal((await c.request(`/api/tasks/${task.id}/start`)).status, 400);
  assert.equal(c.calls.filter(kind => kind === 'create-map').length, 1);
});

test('restart pauses integration queue, retains uncertain journals and never replays a mutation', async t => {
  const c = await setup(t),
    task = await c.integration();
  c.before = kind => {
    if (kind === 'spawn-actor') throw new Error('Disconnected fixture.');
  };
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id] });
  await c.wait(() => c.app.store.task(task.id).status === 'blocked');
  const a = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId),
    journal = structuredClone(a.integration.operations);
  // Simulate a crash before the last status commit, with durable intent/leases.
  a.status = 'running';
  c.app.store.updateAttempt(a);
  const interruptedTask = c.app.store.task(task.id);
  interruptedTask.status = 'running';
  c.app.store.putTask(interruptedTask);
  const org = c.app.store.organization();
  org.pipelineEnabled = true;
  c.app.store.setOrganization(org);
  await c.app.close();
  c.before = null;
  await c.open();
  assert.equal(c.app.store.organization().pipelineEnabled, false);
  assert.equal(c.app.store.leases().length, 2);
  assert.deepEqual(c.app.store.attempt(a.id).integration.operations, journal);
  assert.equal((await c.request(`/api/tasks/${task.id}/start`)).status, 400);
  c.driver.identity.sessionHash = hash('new-editor-session');
  assert.equal((await c.request(`/api/tasks/${task.id}/reconcile`)).status, 400);
  c.alter = (kind, response) => (kind === 'reconcile' ? { ...response, previousSessionStopped: true } : response);
  assert.equal((await c.request(`/api/tasks/${task.id}/reconcile`)).status, 200);
  assert.equal(c.calls.filter(kind => kind === 'create-map').length, 1);
  assert.equal(c.app.store.leases().length, 0);
});

test('cancellation, checkpoint corruption and invalid final evidence retain uncertain ownership', async t => {
  for (const mode of ['cancel', 'checkpoint', 'evidence']) {
    const c = await setup(t),
      task = await c.integration();
    c.before = async (kind, params) => {
      if (kind !== 'spawn-actor') return;
      if (mode === 'cancel') await c.request(`/api/tasks/${task.id}/cancel`);
      if (mode === 'checkpoint') {
        const lease = c.app.store.leases().find(l => l.resource === 'unreal:editor');
        fs.appendFileSync(path.join(c.app.store.directory, 'jobs', lease.attemptId, 'checkpoint.json'), ' ');
      }
    };
    c.alter = (kind, response) =>
      kind === 'capture-evidence' && mode === 'evidence' ? { ...response, actors: [] } : response;
    await c.request(`/api/tasks/${task.id}/start`);
    await c.wait(() => c.app.store.task(task.id).status === 'blocked');
    assert.equal(c.app.store.leases().length, 2, mode);
    const a = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId);
    assert.equal(a.artifacts.length, 0);
    assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 400);
  }
});

test('independent review waits for engine evidence acceptance and consumes the exact pinned attempts', async t => {
  const c = await setup(t),
    task = await c.integration();
  const review = (
    await c.request('/api/tasks', {
      title: 'Independent fixture evidence review',
      workerId: 'W-07',
      kind: 'review',
      brief: 'Review the exact accepted manifest and integration evidence. No real engine checks were performed.',
      dependencies: [task.dependencies[0], task.id],
    })
  ).data;
  await c.request('/api/pipeline', { action: 'queue', taskIds: [task.id, review.id] });
  await c.wait(() => c.app.store.task(task.id).status === 'review');
  assert.equal(c.app.store.attempts(review.id).length, 0);
  assert.equal((await c.request(`/api/tasks/${review.id}/accept`)).status, 400);
  await c.request(`/api/tasks/${task.id}/accept`);
  await c.wait(() => c.app.store.task(review.id).status === 'review');
  const a = c.app.store.attempt(c.app.store.task(review.id).lastAttemptId);
  assert.notEqual(a.workerId, task.workerId);
  assert.equal(a.inputReferences[0].attemptId, task.integration.source.reference.attemptId);
  assert.equal(a.inputReferences[1].attemptId, c.app.store.task(task.id).acceptedAttemptId);
  for (const ref of a.inputReferences)
    for (const item of ref.artifacts)
      assert.equal(hash(fs.readFileSync(path.resolve(a.outputFolder, item.path))), item.hash);
  assert.equal(
    a.reviewVerdict,
    'blocked',
    'The logical-layout Simulator truthfully reports unavailable engine review.',
  );
});
