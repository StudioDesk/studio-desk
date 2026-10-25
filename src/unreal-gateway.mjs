import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './core/contracts.mjs';
import { jobDirectory } from './core/projects.mjs';
import { unrealEndpoint } from './unreal-discovery.mjs';

export const editorResource = 'unreal:editor';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bounded = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 1024 * 1024) throw new Error('Gateway reply exceeds 1 MB.');
  return bytes;
};
function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(k => !keys.includes(k)) ||
    keys.some(k => !Object.hasOwn(value, k))
  )
    throw new Error(`Invalid ${label} fields.`);
}

// A data contract, never a script or a list of arbitrary editor tools.
export function validateBlockoutManifest(manifest) {
  exact(manifest, ['version', 'namespace', 'actors'], 'blockout manifest');
  if (manifest.version !== 'studio-blockout-v1' || !/^Blockout_[a-f0-9]{16}$/.test(manifest.namespace))
    throw new Error('Blockout requires a unique Blockout_<16 hex digits> namespace.');
  if (!Array.isArray(manifest.actors) || manifest.actors.length < 3 || manifest.actors.length > 20)
    throw new Error('Blockout requires 3–20 actors.');
  const ids = new Set();
  for (const actor of manifest.actors) {
    exact(actor, ['id', 'type', 'position', 'rotation', 'scale'], 'blockout actor');
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(actor.id) ||
      ids.has(actor.id) ||
      !['cube', 'player-start', 'directional-light'].includes(actor.type)
    )
      throw new Error('Invalid or duplicate blockout actor identity/type.');
    ids.add(actor.id);
    for (const key of ['position', 'rotation', 'scale']) {
      const limit = key === 'position' ? 100000 : key === 'rotation' ? 360 : 100;
      if (
        !Array.isArray(actor[key]) ||
        actor[key].length !== 3 ||
        actor[key].some(n => !Number.isFinite(n) || Math.abs(n) > limit || (key === 'scale' && n <= 0))
      )
        throw new Error('Invalid bounded actor transform.');
    }
  }
  if (
    manifest.actors.filter(a => a.type === 'player-start').length !== 1 ||
    !manifest.actors.some(a => a.type === 'cube') ||
    !manifest.actors.some(a => a.type === 'directional-light')
  )
    throw new Error('Blockout needs cubes, one PlayerStart and lighting.');
  return structuredClone(manifest);
}

export function validateEditorPin(pin) {
  exact(
    pin,
    [
      'endpoint',
      'projectFile',
      'projectId',
      'engineVersion',
      'engineChangelist',
      'editorPid',
      'editorStartedAt',
      'sessionHash',
      'sources',
    ],
    'editor pin',
  );
  unrealEndpoint(pin.endpoint);
  if (
    !path.isAbsolute(pin.projectFile) ||
    path.extname(pin.projectFile) !== '.uproject' ||
    fs.realpathSync(pin.projectFile) !== pin.projectFile ||
    typeof pin.projectId !== 'string' ||
    !pin.projectId ||
    pin.projectId.length > 128 ||
    !/^\d+\.\d+\.\d+$/.test(pin.engineVersion) ||
    !Number.isSafeInteger(pin.engineChangelist) ||
    pin.engineChangelist <= 0 ||
    !Number.isSafeInteger(pin.editorPid) ||
    pin.editorPid <= 0 ||
    !Number.isFinite(Date.parse(pin.editorStartedAt)) ||
    !digest(pin.sessionHash)
  )
    throw new Error('Project, engine, editor process and MCP session identity must be established.');
  const roles = [
    'project',
    'engine',
    'config',
    'plugin:ModelContextProtocol',
    'plugin:MCPClientToolset',
    'plugin:EditorToolset',
  ];
  if (
    !Array.isArray(pin.sources) ||
    pin.sources.length < roles.length ||
    pin.sources.length > 20 ||
    new Set(pin.sources.map(s => s.role)).size !== pin.sources.length ||
    roles.some(role => !pin.sources.some(s => s.role === role))
  )
    throw new Error('Pin the project, engine, configuration and all three plugin descriptors.');
  for (const source of pin.sources) {
    exact(source, ['role', 'path', 'hash'], 'source pin');
    if (
      typeof source.role !== 'string' ||
      !path.isAbsolute(source.path) ||
      fs.realpathSync(source.path) !== source.path ||
      !digest(source.hash) ||
      !fs.statSync(source.path).isFile() ||
      fs.statSync(source.path).size > 1024 * 1024 ||
      hash(fs.readFileSync(source.path)) !== source.hash
    )
      throw new Error('Pinned project/configuration/plugin bytes changed.');
  }
  if (!pin.sources.some(s => s.role === 'project' && s.path === pin.projectFile))
    throw new Error('Project descriptor pin does not match the target project.');
  return structuredClone(pin);
}

// The only current driver is injected by model-free tests. No endpoint, tools,
// credentials or driver implementation can be supplied through an HTTP request.
// A production driver must be separately implemented and verified, not enabled
// by relabelling this fixture contract or trusting discovery descriptions.
export class UnrealGateway {
  constructor(store, driver = null, timeoutMs = 5000) {
    this.store = store;
    this.driver = driver;
    this.pending = new Map();
    this.closed = false;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000)
      throw new Error('Gateway timeout must be 50–10000 ms.');
    this.timeoutMs = timeoutMs;
    if (driver && (driver.mode !== 'fixture' || typeof driver.call !== 'function' || driver.telemetryDisabled !== true))
      throw new Error('Only an explicitly labelled model-free gateway fixture is implemented.');
    this.pin = driver ? validateEditorPin(driver.pin) : null;
  }
  status() {
    return {
      available: !!this.driver,
      mode: this.driver ? 'fixture' : 'disabled',
      live: false,
      reason: this.driver
        ? 'Model-free fixture; no real engine checks.'
        : 'Live Unreal driver is not implemented: verified project identity, checkpoint and read-only reconciliation are required.',
    };
  }
  prepare(reference, artifact, manifest) {
    if (!this.driver || this.closed) throw new Error(this.status().reason);
    validateEditorPin(this.pin);
    return {
      version: 'studio-integration-v1',
      pin: structuredClone(this.pin),
      source: { reference: structuredClone(reference), artifact: structuredClone(artifact) },
      manifest: validateBlockoutManifest(manifest),
      mode: 'fixture',
    };
  }
  record(a, change) {
    Object.assign(a.integration, change);
    this.store.updateAttempt(a);
  }
  async call(a, kind, parameters = {}) {
    if (
      ![
        'inspect',
        'checkpoint',
        'create-map',
        'spawn-actor',
        'save-map',
        'reload-map',
        'capture-evidence',
        'reconcile',
      ].includes(kind)
    )
      throw new Error('Editor operation is not allowlisted.');
    if (this.closed || !this.driver || this.pending.size)
      throw new Error('Gateway is closed or an editor call may still be running.');
    const lease = this.store.leases().find(l => l.resource === editorResource && l.attemptId === a.id);
    const owns = () =>
      this.store
        .leases()
        .some(l => l.resource === editorResource && l.attemptId === a.id && l.token === a.integration.leaseToken) &&
      this.store.leases().some(l => l.resource === 'employee:' + a.workerId && l.attemptId === a.id);
    if (!lease || !owns()) throw new Error('Editor or employee lease ownership changed.');
    const intent = {
      id: randomUUID(),
      kind,
      parameters: structuredClone(parameters),
      status: 'intent',
      startedAt: new Date().toISOString(),
    };
    a.integration.operations.push(intent);
    this.store.updateAttempt(a); // commit BEFORE dispatch
    let timer;
    const operation = Promise.resolve().then(() =>
      this.driver.call(kind, {
        ...structuredClone(parameters),
        operationId: intent.id,
        pin: structuredClone(a.integration.pin),
        leaseToken: lease.token,
      }),
    );
    this.pending.set(intent.id, operation);
    operation.then(
      () => this.pending.delete(intent.id),
      () => this.pending.delete(intent.id),
    );
    try {
      const response = await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Editor call timed out; its outcome is uncertain.')),
            this.timeoutMs,
          );
        }),
      ]);
      if (this.closed || !owns() || (a.integration.state === 'uncertain' && kind !== 'reconcile'))
        throw new Error('Editor ownership requires reconciliation.');
      const bytes = bounded(response);
      intent.status = 'responded';
      intent.responseHash = hash(bytes);
      intent.finishedAt = new Date().toISOString();
      intent.response = response;
      this.store.updateAttempt(a);
      if (!same(response?.identity, a.integration.pin) && kind !== 'reconcile')
        throw new Error('Editor project/process/session identity changed.');
      return response;
    } catch (error) {
      intent.status = 'uncertain';
      intent.error = error.message;
      this.store.updateAttempt(a);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  clean(state, targetAbsent = false) {
    if (
      typeof state.activeMap !== 'string' ||
      !/^\/[A-Za-z0-9_/]+$/.test(state.activeMap) ||
      state.idle !== true ||
      !Array.isArray(state.dirtyPackages) ||
      state.dirtyPackages.length ||
      (targetAbsent && state.targetExists !== false)
    )
      throw new Error('Require a known clean, idle editor and a nonexistent target map.');
  }
  writeCheckpoint(a, contents) {
    const file = path.join(jobDirectory(this.store, a), 'checkpoint.json');
    const bytes = bounded(contents),
      fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.record(a, { checkpoint: { path: 'checkpoint.json', hash: hash(bytes), bytes: bytes.length } });
  }
  validateCheckpoint(a) {
    const bytes = fs.readFileSync(path.join(jobDirectory(this.store, a), 'checkpoint.json'));
    if (hash(bytes) !== a.integration.checkpoint?.hash) throw new Error('Recovery checkpoint changed.');
  }
  async execute(entry, finish, recheckInputs) {
    const a = entry.attempt,
      task = this.store.task(a.taskId),
      config = a.assignment.integration;
    a.integration = {
      ...structuredClone(config),
      state: 'preflight',
      leaseToken: this.store.leases().find(l => l.resource === editorResource && l.attemptId === a.id)?.token,
      operations: [],
      checkpoint: null,
    };
    this.store.updateAttempt(a);
    let mutation = false;
    try {
      const manifest = validateBlockoutManifest(config.manifest),
        mapPath = '/Game/StudioPipelineTests/' + manifest.namespace;
      validateEditorPin(config.pin);
      recheckInputs();
      const state = await this.call(a, 'inspect', { mapPath });
      this.clean(state, true);
      const checkpoint = await this.call(a, 'checkpoint', { mapPath, activeMap: state.activeMap });
      this.clean(checkpoint, true);
      if (checkpoint.captured !== true || checkpoint.activeMap !== state.activeMap || !digest(checkpoint.baselineHash))
        throw new Error('A recoverable checkpoint is required before mutation.');
      this.writeCheckpoint(a, {
        version: 'studio-checkpoint-v1',
        pin: config.pin,
        source: config.source,
        manifest,
        baseline: checkpoint,
      });
      const operations = [
        { kind: 'create-map', parameters: { mapPath } },
        ...manifest.actors.map(actor => ({ kind: 'spawn-actor', parameters: { mapPath, actor } })),
        { kind: 'save-map', parameters: { mapPath } },
        { kind: 'reload-map', parameters: { mapPath } },
      ];
      this.record(a, { state: 'mutating' });
      for (const operation of operations) {
        if (entry.cancelled) throw new Error('Integration cancelled; inspect the editor before releasing ownership.');
        validateEditorPin(config.pin);
        this.validateCheckpoint(a);
        recheckInputs();
        mutation = true;
        const reply = await this.call(a, operation.kind, operation.parameters);
        if (reply.applied !== true) throw new Error('Editor did not confirm the operation; inspect its outcome.');
      }
      this.record(a, { state: 'validating' });
      const evidence = await this.call(a, 'capture-evidence', { mapPath });
      if (
        entry.cancelled ||
        evidence.saved !== true ||
        evidence.reloaded !== true ||
        evidence.mapPath !== mapPath ||
        !same(evidence.actors, manifest.actors)
      )
        throw new Error('Saved/reloaded map and exact actor postconditions were not established.');
      const image = Buffer.from(evidence.screenshot || '', 'base64');
      if (
        image.length < 45 ||
        image.length > 512 * 1024 ||
        !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        image.toString('ascii', 12, 16) !== 'IHDR' ||
        !image.readUInt32BE(16) ||
        !image.readUInt32BE(20) ||
        image.toString('ascii', image.length - 8, image.length - 4) !== 'IEND'
      )
        throw new Error('A bounded PNG viewport evidence file is required.');
      this.validateCheckpoint(a);
      validateEditorPin(config.pin);
      recheckInputs();
      const report = {
        version: 'studio-engine-evidence-v1',
        mode: 'fixture',
        taskId: task.id,
        mapPath,
        source: config.source,
        identity: config.pin,
        checkpoint: a.integration.checkpoint,
        actors: evidence.actors,
        saved: true,
        reloaded: true,
        engineInspection: 'simulated',
        screenshot: 'simulated',
        build: 'not-run',
        traversal: 'not-run',
        playtest: 'not-run',
      };
      fs.writeFileSync(path.join(entry.output, 'viewport.png'), image, { flag: 'wx' });
      fs.writeFileSync(path.join(entry.output, 'engine-evidence.json'), JSON.stringify(report, null, 2), {
        flag: 'wx',
      });
      this.record(a, { state: 'validated' });
      finish(entry, {
        taskId: task.id,
        outcome: 'completed',
        summary:
          'Model-free gateway fixture: saved map, actor and screenshot contracts validated. No real engine work performed.',
        artifacts: [
          { path: 'engine-evidence.json', kind: 'engine-evidence' },
          { path: 'viewport.png', kind: 'image' },
        ],
        checks: [
          {
            name: 'Gateway fixture postconditions',
            status: 'pass',
            evidence: 'Simulated saved/reloaded map, exact actors and PNG bytes checked.',
          },
          ...['Engine traversal', 'Build', 'Human playtest'].map(name => ({
            name,
            status: 'not-run',
            evidence: 'Not performed.',
          })),
        ],
        issues: [],
        handoff: 'Inspect fixture evidence; acceptance does not establish a real engine result.',
      });
    } catch (error) {
      if (!mutation && !this.pending.size && !a.integration.operations.some(op => op.status === 'uncertain')) {
        this.record(a, { state: 'failed-before-mutation' });
        finish(entry, null, error.message);
      } else this.uncertain(entry, error.message);
    }
  }
  uncertain(entry, reason) {
    clearTimeout(entry.timer);
    const a = entry.attempt,
      task = this.store.task(a.taskId);
    a.status = 'interrupted';
    a.error = reason;
    a.integration.state = 'uncertain';
    a.finishedAt = new Date().toISOString();
    task.status = 'blocked';
    task.queued = false;
    task.controllerWait = false;
    task.reason = reason + ' Editor ownership retained; read-only reconciliation is required.';
    this.store.tx(() => {
      this.store.updateAttempt(a);
      this.store.putTask(task);
    });
    this.store.event('integration_uncertain', task.id, a.id, task.reason);
  }
  async reconcile(taskId) {
    const task = this.store.task(taskId),
      a = this.store.attempt(task.lastAttemptId);
    if (
      task.kind !== 'unreal-integration' ||
      a.status !== 'interrupted' ||
      a.reconciledAt ||
      this.pending.size ||
      !this.driver
    )
      throw new Error('Integration is not ready for read-only reconciliation; an operation may still be running.');
    const pin = validateEditorPin(a.integration.pin);
    const evidence = await this.call(a, 'reconcile', {
      mapPath: '/Game/StudioPipelineTests/' + a.integration.manifest.namespace,
      journalHash: hash(bounded(a.integration.operations)),
    });
    const stableProject = value => {
      const { editorPid, editorStartedAt, sessionHash, ...project } = value;
      return project;
    };
    if (
      evidence.quiescent !== true ||
      evidence.targetInspected !== true ||
      !['absent', 'partial', 'complete'].includes(evidence.targetState) ||
      !same(stableProject(validateEditorPin(evidence.identity)), stableProject(pin)) ||
      (!same(evidence.identity, pin) && evidence.previousSessionStopped !== true)
    )
      throw new Error('Reconciliation did not prove a quiescent editor and pinned project. Ownership retained.');
    a.integration.reconciliation = evidence;
    a.integration.state = 'reconciled';
    a.status = 'failed';
    a.reconciledAt = new Date().toISOString();
    task.status = 'failed';
    task.queued = false;
    task.reason =
      'Editor ownership reconciled. No mutation replayed; inspect retained evidence and scope a new assignment.';
    this.store.tx(() => {
      this.store.updateAttempt(a);
      this.store.putTask(task);
      this.store.release(a.id);
    });
    this.store.event('integration_reconciled', task.id, a.id, task.reason);
  }
}
