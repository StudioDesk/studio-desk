import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitForTask } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { gameOrganization } from '../src/organizations/game-studio/index.mjs';
import { ConnectorRegistry } from '../src/core/connectors.mjs';
import { localRecordsConnector } from '../src/connectors/local-records.mjs';
import { localOperationAdapter } from '../src/adapters/local-operation.mjs';
import { hash } from '../src/core/contracts.mjs';

const records = categories => ({
  schemaVersion: 'records-v1',
  records: [...categories].reverse().map(category => ({ id: category, label: ` ${category} fixture `, category })),
});
const gameData = records(['entry', 'objective', 'exit']);
const architectureData = records(['public', 'private']);
async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-composition-'));
  const registries = options.registries || createRegistries();
  const c = {
    directory,
    registries,
    app: createStudio({ directory, port: 0, ...options, runnerOptions: { registries } }),
  };
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  c.connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await c.connect();
  c.request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.create = async (domain, source = 'prepare', extra = {}) => {
    const response = await c.request('/api/tasks', {
      title: `${domain} ${source} fixture`,
      brief: 'Bounded fixture record processing; no scene checks.',
      kind: `${domain}-fixture:${source}`,
      workerId: domain === 'game' ? 'W-03' : 'W-04',
      ...(source === 'prepare' ? { inputData: domain === 'game' ? gameData : architectureData } : {}),
      ...extra,
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  c.wait = async (task, status = 'review') => waitForTask(c.app.store, task.id, status, { interval: 10 });
  c.accept = async task => assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 200);
  return c;
}

test('two fixture workflow configurations reuse one local operation and forward exact accepted artifacts', async t => {
  const c = await setup(t),
    sources = [await c.create('game'), await c.create('architecture')];
  const dependents = [
    await c.create('game', 'handoff', { dependencies: [sources[0].id], workerId: 'W-07' }),
    await c.create('architecture', 'handoff', { dependencies: [sources[1].id], workerId: 'W-02' }),
  ];
  const state = await (await fetch(c.origin + '/api/state')).json();
  assert.equal(state.operations.length, 1);
  assert.equal(
    state.taskKinds['game-fixture:prepare'].operation.connector,
    state.taskKinds['architecture-fixture:prepare'].operation.connector,
  );
  assert.deepEqual(state.taskKinds['architecture-fixture:prepare'].requiredResources, ['local:record-processing']);
  assert.deepEqual(state.taskKinds['architecture-fixture:prepare'].requiredCapabilities, ['local-json']);
  assert.equal(
    state.adapters['local-operation'],
    undefined,
    'A workflow cannot grant the operation as an employee CLI.',
  );
  await c.request('/api/pipeline', { action: 'queue', taskIds: [...sources, ...dependents].map(task => task.id) });
  const first = await c.wait(sources[0]),
    second = await c.wait(sources[1]);
  assert.equal(first.provider, 'local-operation');
  assert.equal(second.provider, first.provider);
  assert.deepEqual(first.contracts.connector, second.contracts.connector);
  assert.deepEqual(first.contracts.operation, second.contracts.operation);
  assert.notDeepEqual(first.operation.configuration, second.operation.configuration);
  assert.match(first.instructions.text, /Controller-owned local operation binding/);
  assert.ok(first.controllerChecks.some(check => check.name === 'Local operation contract and provenance'));
  for (const dependent of dependents) {
    assert.equal(c.app.store.attempts(dependent.id).length, 0);
    assert.equal((await c.request(`/api/tasks/${dependent.id}/accept`)).status, 400);
  }
  await c.accept(sources[0]);
  const downstream = await c.wait(dependents[0]);
  assert.equal(c.app.store.attempts(dependents[1].id).length, 0, 'Accepting one workflow does not advance another.');
  await c.accept(sources[1]);
  const other = await c.wait(dependents[1]);
  for (const [index, attempt] of [downstream, other].entries()) {
    const source = [first, second][index],
      item = source.artifacts.find(item => item.kind === 'normalized-records');
    assert.deepEqual(attempt.operation.input.source, {
      type: 'accepted-artifact',
      taskId: sources[index].id,
      attemptId: source.id,
      path: item.path,
      kind: item.kind,
      hash: item.hash,
    });
    assert.equal(attempt.inputReferences[0].attemptId, source.id);
    assert.equal(attempt.artifacts[0].hash, item.hash);
    const staged = fs.readFileSync(path.resolve(attempt.outputFolder, attempt.inputReferences[0].artifacts[0].path));
    assert.equal(hash(staged), item.hash);
    const evidence = JSON.parse(fs.readFileSync(path.join(attempt.outputFolder, 'operation-evidence.json')));
    assert.deepEqual(evidence.source, attempt.operation.input.source);
    assert.match(evidence.evidence, /No model, scene, engine, render or playtest checks/);
    assert.equal(c.app.store.task(dependents[index].id).status, 'review');
    await c.accept(dependents[index]);
  }
});

test('organization selection is independent of workflow definitions and does not reseed existing history', async t => {
  const registries = createRegistries();
  let calls = 0;
  registries.organizations.register({
    id: 'architecture-test',
    version: 'architecture-test-v1',
    create() {
      calls++;
      const org = gameOrganization();
      org.company.name = 'Architecture fixture office';
      const team = org.teams.find(team => team.name === 'Level Design');
      team.name = 'Spatial planning';
      org.workers
        .filter(worker => worker.team === 'Level Design')
        .forEach(worker => {
          worker.team = team.name;
          worker.role = 'Space analyst';
          worker.responsibility = 'Prepare local room records.';
        });
      org.instructions.teams[team.id].text = 'Check fixture space categories. No renderer access.';
      return org;
    },
  });
  const c = await setup(t, { registries, bootstrap: { organizationPreset: 'architecture-test', workflowPresets: [] } });
  assert.equal(calls, 1);
  assert.equal(c.app.store.tasks().length, 0);
  const task = await c.create('architecture', 'prepare', { workerId: 'W-03' });
  assert.equal(task.team, 'Spatial planning');
  c.app.runner.start(task.id);
  const attempt = await c.wait(task);
  await c.accept(task);
  assert.match(attempt.instructions.text, /Check fixture space categories/);
  const org = c.app.store.organization();
  org.instructions.company.draft = { text: 'Director draft remains', baseRevision: 1 };
  c.app.store.setOrganization(org);
  const before = c.app.store.organization();
  await c.app.close();
  // Even missing selections are irrelevant when opening recorded organization data.
  c.app = createStudio({
    directory: c.directory,
    port: 0,
    runnerOptions: { registries },
    bootstrap: { organizationPreset: 'removed-preset', workflowPresets: ['removed-workflow'] },
  });
  await c.connect();
  assert.equal(calls, 1);
  assert.deepEqual(c.app.store.organization(), before);
  assert.equal(c.app.store.task(task.id).acceptedAttemptId, attempt.id);
  assert.deepEqual(c.app.store.attempt(attempt.id).operation, attempt.operation);
  assert.equal(c.app.store.attempt(attempt.id).instructions.hash, attempt.instructions.hash);
  assert.equal(c.app.store.tasks().length, 1);
});

test('operation input shape, workflow scope, contracts and capabilities block before reservations', async t => {
  const c = await setup(t);
  for (const inputData of [
    { schemaVersion: 'wrong', records: [] },
    { ...gameData, target: 'C:/other' },
    { schemaVersion: 'records-v1', records: [gameData.records[0], gameData.records[0]] },
  ]) {
    assert.equal(
      (
        await c.request('/api/tasks', {
          title: 'Invalid data',
          brief: 'Fixture.',
          kind: 'game-fixture:prepare',
          workerId: 'W-03',
          inputData,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await c.request('/api/tasks', {
        title: 'Denied grant',
        brief: 'Fixture.',
        kind: 'game-fixture:prepare',
        workerId: 'W-03',
        inputData: gameData,
        operation: { scope: 'editor' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await c.request('/api/tasks', {
        title: 'Incompatible data',
        brief: 'Fixture.',
        kind: 'game-fixture:prepare',
        workerId: 'W-03',
        inputData: architectureData,
      })
    ).status,
    400,
  );
  const incompatible = await c.create('game');
  incompatible.inputData = architectureData;
  c.app.store.putTask(incompatible);
  assert.throws(() => c.app.runner.start(incompatible.id), /outside the workflow binding/);
  assert.equal(c.app.store.attempts(incompatible.id).length, 0);
  assert.deepEqual(c.app.store.leases(), []);
  const definition = c.registries.workflows.get('game-fixture:prepare');
  assert.throws(
    () => c.registries.connectors.resolve({ ...definition.operation, inputContract: 'other-v1' }),
    /incompatible operation contracts/,
  );
  assert.throws(
    () => c.registries.connectors.resolve({ ...definition.operation, connector: 'missing' }),
    /Unknown connector/,
  );
  const good = await c.create('game');
  c.registries.adapters.adapters.set('local-operation', { ...localOperationAdapter, capabilities: [] });
  assert.throws(() => c.app.runner.start(good.id), /lacks required capability: local-json/);
  assert.equal(c.app.store.attempts(good.id).length, 0);
  assert.deepEqual(c.app.store.leases(), []);
});

test('different workflows share one atomic connector resource and cancellation stops local work', async t => {
  const c = await setup(t),
    game = await c.create('game'),
    architecture = await c.create('architecture');
  const { attemptId } = c.app.runner.start(game.id);
  assert.deepEqual(
    c.app.store.leases().map(lease => lease.resource),
    ['employee:W-03', 'local:record-processing'],
  );
  const holder = c.app.store.organization().workers.find(worker => worker.id === game.workerId);
  assert.throws(() => c.app.runner.start(architecture.id), {
    message: `Waiting for ${holder.displayName}'s work on ${game.id} (${game.title}) to finish.`,
  });
  assert.equal(c.app.store.attempts(architecture.id).length, 0);
  assert.equal(
    c.app.store.leases().some(lease => lease.resource === 'employee:W-04'),
    false,
  );
  c.app.runner.stop(attemptId);
  assert.equal(c.app.store.attempt(attemptId).status, 'cancelled');
  assert.deepEqual(c.app.store.leases(), []);
  c.app.runner.start(architecture.id);
  await c.wait(architecture);
});

test('operation direction, configuration, supplied data and published instructions stay immutable across revision', async t => {
  const registries = createRegistries();
  let resume;
  registries.adapters.adapters.set('local-operation', {
    ...localOperationAdapter,
    start(runtime, entry) {
      resume = () => localOperationAdapter.start(runtime, entry);
    },
  });
  const c = await setup(t, { registries }),
    task = await c.create('game');
  c.app.runner.start(task.id);
  const first = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId);
  const updated = c.app.store.task(task.id);
  updated.direction = 'Future direction only';
  updated.inputData.records[0].label = 'Changed future label';
  c.app.store.putTask(updated);
  const org = c.app.store.organization();
  org.workers.find(worker => worker.id === task.workerId).model = 'future-cli-setting';
  org.instructions.company.text = 'Future company instructions';
  org.instructions.company.revision = 2;
  c.app.store.setOrganization(org);
  resume();
  await c.wait(task);
  const recorded = c.app.store.attempt(first.id);
  assert.equal(recorded.configuration.model, first.configuration.model);
  assert.deepEqual(recorded.operation, first.operation);
  assert.deepEqual(recorded.assignment.inputData, gameData);
  assert.equal(recorded.assignment.direction, '');
  assert.equal(recorded.instructions.hash, first.instructions.hash);
  assert.equal((await c.request(`/api/tasks/${task.id}/revise`, { direction: 'Revision direction' })).status, 200);
  c.app.runner.start(task.id);
  resume();
  const next = await c.wait(task);
  assert.notEqual(next.id, first.id);
  assert.notEqual(next.outputFolder, first.outputFolder);
  assert.equal(next.configuration.model, 'future-cli-setting');
  assert.equal(next.assignment.direction, 'Revision direction');
  assert.match(next.instructions.text, /Future company instructions/);
  assert.notEqual(next.operation.input.source.hash, first.operation.input.source.hash);
  assert.deepEqual(c.app.store.attempt(first.id).operation, first.operation);
});

test('dependent operations reject incompatible, ambiguous and tampered accepted artifacts', async t => {
  const c = await setup(t),
    game = await c.create('game'),
    architecture = await c.create('architecture');
  for (const task of [game, architecture]) {
    c.app.runner.start(task.id);
    await c.wait(task);
    await c.accept(task);
  }
  const incompatible = await c.create('game', 'handoff', { dependencies: [architecture.id] });
  assert.throws(() => c.app.runner.start(incompatible.id), /outside the workflow binding/);
  const ambiguous = await c.create('game', 'handoff', { dependencies: [game.id, architecture.id] });
  assert.throws(() => c.app.runner.start(ambiguous.id), /exactly one accepted artifact/);
  const attempt = c.app.store.attempt(c.app.store.task(game.id).acceptedAttemptId);
  fs.appendFileSync(path.join(attempt.outputFolder, 'records.json'), ' ');
  const changed = await c.create('game', 'handoff', { dependencies: [game.id] });
  assert.throws(() => c.app.runner.start(changed.id), /modified after acceptance/);
  for (const task of [incompatible, ambiguous, changed]) assert.equal(c.app.store.attempts(task.id).length, 0);
  assert.deepEqual(c.app.store.leases(), []);
});

test('interrupted local operations keep ownership and require reconciliation without replay after restart', async t => {
  const registries = createRegistries();
  registries.adapters.adapters.set('local-operation', { ...localOperationAdapter, start() {} });
  const c = await setup(t, { registries }),
    task = await c.create('game');
  c.app.runner.start(task.id);
  const running = c.app.store.attempt(c.app.store.task(task.id).lastAttemptId);
  await c.app.close();
  // Model a crash record: no external mutation is claimed and no replay is safe by default.
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { registries } });
  running.status = 'running';
  running.finishedAt = null;
  c.app.store.tx(() => {
    c.app.store.updateAttempt(running);
    c.app.store.claim(['employee:W-03', 'local:record-processing'], running.id);
  });
  // Close just the idle controller; it has no live entry for the crash record.
  await c.app.close();
  c.app = createStudio({ directory: c.directory, port: 0, runnerOptions: { registries } });
  await c.connect();
  assert.equal(c.app.store.attempt(running.id).status, 'interrupted');
  assert.equal(c.app.store.leases().length, 2);
  assert.equal(c.app.store.attempts(task.id).length, 1);
  assert.equal(fs.existsSync(path.join(running.outputFolder, 'records.json')), false);
  assert.throws(() => c.app.runner.start(task.id), /Reconcile/);
  c.app.runner.reconcile(task.id);
  assert.deepEqual(c.app.store.leases(), []);
  assert.equal(c.app.store.attempts(task.id).length, 1);
  registries.adapters.adapters.set('local-operation', localOperationAdapter);
  c.app.runner.start(task.id);
  const fresh = await c.wait(task);
  assert.notEqual(fresh.id, running.id);
});

test('local operation evidence is validated and async or externally mutating contracts are unsupported', async t => {
  const operation = localRecordsConnector.operations[0];
  assert.throws(
    () =>
      new ConnectorRegistry().register({
        ...localRecordsConnector,
        operations: [{ ...operation, externalMutation: true }],
      }),
    /Unsupported local operation scope/,
  );
  const c = await setup(t),
    task = await c.create('game');
  c.registries.adapters.adapters.set('local-operation', {
    ...localOperationAdapter,
    start(runtime, entry) {
      fs.writeFileSync(
        path.join(entry.output, 'records.json'),
        JSON.stringify(operation.run({ data: gameData, configuration: entry.attempt.operation.configuration })),
      );
      fs.writeFileSync(path.join(entry.output, 'operation-evidence.json'), JSON.stringify({ source: 'forged' }));
      runtime.finish(entry, {
        taskId: entry.attempt.taskId,
        outcome: 'completed',
        summary: 'Forged fixture evidence',
        artifacts: [
          { path: 'records.json', kind: 'normalized-records' },
          { path: 'operation-evidence.json', kind: 'local-operation-evidence' },
        ],
        checks: [],
        issues: [],
        handoff: 'Review.',
      });
    },
  });
  c.app.runner.start(task.id);
  const failed = await c.wait(task, 'failed');
  assert.match(failed.error, /evidence does not match/);
  assert.equal((await c.request(`/api/tasks/${task.id}/accept`)).status, 400);
  const asyncRegistries = createRegistries();
  asyncRegistries.connectors.operations.set('local-records/normalize', {
    ...operation,
    connectorId: 'local-records',
    connectorVersion: 'local-records-v1',
    validateInput: async () => {},
  });
  const asyncTask = { ...task, id: 'async-fixture', lastAttemptId: null, status: 'ready' };
  c.app.store.putTask(asyncTask);
  c.app.runner.registries.connectors = asyncRegistries.connectors;
  assert.throws(() => c.app.runner.start(asyncTask.id), /must complete synchronously/);
  assert.equal(c.app.store.attempts(asyncTask.id).length, 0);
});

test('workflow handoffs accept equivalent operation configuration regardless of key order', async t => {
  // The shipped connector accepts only { categories }; a multi-key configuration exposes key-order sensitivity.
  const registries = createRegistries(),
    key = 'local-records/normalize',
    operation = registries.connectors.operations.get(key);
  registries.connectors.operations.set(key, {
    ...operation,
    validateConfiguration: () => {},
    validateInput: (data, { categories }) => operation.validateInput(data, { categories }),
  });
  const bind = (kind, configuration) => {
    const definition = registries.workflows.tasks.get(kind);
    registries.workflows.tasks.set(kind, { ...definition, operation: { ...definition.operation, configuration } });
  };
  const categories = ['entry', 'objective', 'exit'];
  bind('game-fixture:prepare', { categories, mode: 'strict' });
  bind('game-fixture:handoff', { mode: 'strict', categories: [...categories] });
  const c = await setup(t, { registries });
  const steps = [
    { key: 'prepare', kind: 'game-fixture:prepare', workerId: 'W-03', inputData: gameData, dependencies: [] },
    { key: 'handoff', kind: 'game-fixture:handoff', workerId: 'W-04', dependencies: ['prepare'] },
  ].map(step => ({
    title: step.key,
    brief: 'Fixture.',
    acceptance: 'Fixture.',
    resources: [],
    maxSeconds: 30,
    maxAttempts: 1,
    ...step,
  }));
  const save = () => c.request('/api/workflows', { name: 'Key order', steps });
  const saved = await save();
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  bind('game-fixture:handoff', { mode: 'lenient', categories });
  assert.equal((await save()).status, 400);
});
