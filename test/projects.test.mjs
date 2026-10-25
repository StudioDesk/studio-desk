import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { sourceRepository } from './source-repository.mjs';
import { waitForTask } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { worktreeName } from '../src/connectors/source-worktrees.mjs';
import { sourcePlan, testTotals, validateCheckReport } from '../src/connectors/source-checks.mjs';
import { hash } from '../src/core/contracts.mjs';
import { studioDevelopmentPack } from '../src/packs/studio-development/index.mjs';
import { developmentOrganization } from '../src/organizations/studio-development/project.mjs';
import { resolveAdapter, executionWorker } from '../src/core/execution.mjs';
import { saveProjectOrganization } from '../src/core/project-organization.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';
import { acceptedReference } from '../src/core/artifacts.mjs';
import { newRun, setRunArchived, projectRuns } from '../src/core/graph.mjs';
import { ideaInputLimits } from '../src/core/idea-inputs.mjs';

const fixture = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url));
const cliFixture = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url));

test('new Studio desk defaults add product-owner breakdown while configured projects retain their catalog and history', async t => {
  const c = await setup(t, 'pass', true),
    shared = structuredClone(c.app.store.organization()),
    project = { id: 'project-new-studio', name: 'New Studio desk', goal: 'Fixture', direction: '', revision: 1 },
    key = 'project-organization:' + project.id;
  c.app.store.putProject(project);
  saveProjectOrganization(c.app.store, c.app.runner.registries, project.id, developmentOrganization(shared));
  const configured = c.app.store.setting(key);
  assert.ok(configured.taskKinds.includes('studio-development:breakdown'));
  assert.equal(configured.kindOwners['studio-development:breakdown'], 'W-01');
  assert.equal(configured.members.find(member => member.workerId === 'W-01').role, 'Product owner');
  // Represent a previously configured project. Setup and restart may not reseed it.
  configured.taskKinds = configured.taskKinds.filter(kind => kind !== 'studio-development:breakdown');
  delete configured.kindOwners['studio-development:breakdown'];
  configured.instructions.company.draft = 'Director draft remains intact.';
  c.app.store.putSetting(key, configured);
  const before = structuredClone(configured),
    tasks = c.app.store.tasks();
  assert.deepEqual(c.app.store.setting(key), before);
  await c.app.close();
  c.app = createStudio(c.options);
  assert.deepEqual(c.app.store.setting(key), before);
  assert.deepEqual(c.app.store.organization(), shared);
  assert.deepEqual(c.app.store.tasks(), tasks);
  const defaults = developmentOrganization(shared);
  assert.ok(defaults.taskKinds.includes('studio-development:breakdown'));
  const definition = studioDevelopmentPack.tasks.find(task => task.kind === 'studio-development:breakdown');
  assert.equal(definition.autoProposeWork, true);
  assert.equal(definition.requiresIsolation, true);
  assert.equal(definition.executionAdapter, 'source-breakdown');
  assert.match(definition.executionNotice, /Edit the teams.*default owner/);
  assert.match(
    definition.executionNotice,
    /wait for their prerequisites to be integrated.*one source story runs at a time/,
  );
  for (const provider of ['codex', 'claude']) {
    const worker = executionWorker({ provider: 'codex', model: '', enabled: true }, { execution: { provider } });
    const wrapper = resolveAdapter(c.app.runner.adapters, definition, worker);
    assert.equal(wrapper.id, 'source-breakdown');
    assert.equal(wrapper.modelFor(c.app.runner, worker).id, provider);
  }
});
async function setup(t, mode = 'pass', backendOnly = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-projects-'));
  const options = {
    directory,
    port: 0,
    runnerOptions: {
      // Checks measure a commit, so they read a disposable copy of this source, never the real repository.
      sourceChangeRoot: sourceRepository(),
      sourceCheckCommand: { executable: process.execPath, args: [fixture, mode] },
      sourceReviewSandbox: () => ({ passed: false, stderr: 'Fixture isolation denied', implementation: 'fixture' }),
    },
  };
  const c = { directory, app: createStudio(options) };
  // Studio desk steps run on the reviewer's own model CLI (here the Codex protocol fixture).
  const org = c.app.store.organization();
  org.workers.find(worker => worker.id === 'W-07').provider = 'codex';
  c.app.store.setOrganization(org);
  t.after(async () => {
    await c.app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  c.connect = async () => {
    c.origin = await c.app.start();
    const html = await (await fetch(c.origin)).text();
    c.token = html.match(/name="studio-token" content="([^"]+)"/)[1];
  };
  if (!backendOnly) await c.connect();
  c.request = async (url, data = {}, method = 'POST') => {
    const res = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: res.status, data: await res.json() };
  };
  c.state = async id => (await fetch(c.origin + '/api/state?projectId=' + id)).json();
  c.wait = async (id, status = 'review') => waitForTask(c.app.store, id, status, { interval: 20 });
  c.development = async () => {
    const res = await c.request('/api/studio-development');
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };
  c.run = async workflow => {
    const res = await c.request(`/api/workflows/${workflow.id}/run`, {
      projectId: workflow.projectId,
      expectedVersion: workflow.version,
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };
  c.options = options;
  return c;
}

// Equal timestamps and foreign sequence gaps ensure cursors use event sequence,
// not timestamps, offsets, or an assumption that an attempt's IDs are contiguous.
async function attemptLogFixture(t, count = 1007, transport = 'store') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-logs-')),
    c = { app: createStudio({ directory, port: 0 }) },
    store = c.app.store,
    project = { id: 'project-log-fixture', name: 'Attempt logs', goal: '', direction: '', revision: 1 },
    task = { ...store.task('D-001'), id: 'T-log-fixture', projectId: project.id, status: 'accepted' },
    attempt = { id: 'attempt-log-target', taskId: task.id, projectId: project.id, status: 'completed', artifacts: [] },
    other = { id: 'attempt-log-other', taskId: 'D-001', status: 'completed', artifacts: [] },
    empty = { ...attempt, id: 'attempt-log-empty' },
    events = [],
    time = '2026-10-20T12:00:00.000Z';
  t.after(async () => {
    await c.app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  c.origin = transport === 'HTTP' ? await c.app.start() : 'http://127.0.0.1:0';
  // Exercise the identical protected handler with real writable backpressure in
  // addition to loopback HTTP. Employee sandboxes may deny socket connections.
  c.fetch =
    transport === 'HTTP'
      ? fetch
      : (target, { headers = {} } = {}) =>
          new Promise((resolve, reject) => {
            const chunks = [],
              responseHeaders = new Headers(),
              req = Readable.from([]),
              res = new Writable({
                write(chunk, encoding, done) {
                  chunks.push(Buffer.from(chunk));
                  setImmediate(done);
                },
              });
            res.headersSent = false;
            res.setHeader = (name, value) => responseHeaders.set(name, value);
            res.writeHead = (status, fields) => {
              res.status = status;
              res.headersSent = true;
              for (const [name, value] of Object.entries(fields || {})) res.setHeader(name, value);
            };
            res.once('error', reject);
            res.once('finish', () => {
              const bytes = Buffer.concat(chunks);
              resolve({
                status: res.status,
                headers: responseHeaders,
                json: async () => JSON.parse(bytes.toString('utf8')),
                text: async () => bytes.toString('utf8'),
                arrayBuffer: async () => bytes,
              });
            });
            const parsed = new URL(target);
            Object.assign(req, {
              method: 'GET',
              url: parsed.pathname + parsed.search,
              headers: {
                host: '127.0.0.1:0',
                ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
              },
            });
            c.app.server.emit('request', req, res);
          });
  c.state = async id => (await c.fetch(c.origin + '/api/state?projectId=' + id)).json();
  store.putProject(project);
  store.putTask(task);
  for (const item of [attempt, other, empty]) store.insertAttempt(item, {});
  const insert = store.db.prepare('INSERT INTO events(time,kind,task_id,attempt_id,message) VALUES (?,?,?,?,?)');
  const append = (message, owner = attempt, kind = 'output') => {
    const seq = Number(insert.run(time, kind, owner.taskId, owner.id, message).lastInsertRowid);
    return { seq, time, kind, task_id: owner.taskId, attempt_id: owner.id, message };
  };
  store.tx(() => {
    for (let index = 0; index < count; index++) {
      append(`FOREIGN EVENT ${index}`, other);
      events.push(
        append(
          `event ${index}: café 🌙 原文\r\nsecond\nthird\rfourth\\literal\tend\u0085\u2028\u2029`,
          attempt,
          index ? 'output' : 'output\nkind',
        ),
      );
    }
  });
  const url = (id = attempt.id, suffix = '') => `/api/attempts/${id}/logs${suffix}?projectId=${project.id}`;
  return { c, store, project, attempt, other, empty, events, append, url };
}

test('protected attempt and project reads retain complete structured phases beyond recent activity and raw-log windows', async t => {
  const { c, store, project, attempt, other, empty, append } = await attemptLogFixture(t, 0);
  const occurrences = [];
  // More than either recent event limit, including repeated phase identities.
  for (let index = 0; index < 160; index++) {
    const phase = store.startPhase(attempt, 'integration.verification', {
      integrationOccurrenceId: `integration-${index}`,
    });
    store.finishPhase(phase, index % 2 ? 'failed' : 'succeeded', {
      totals: { tests: 2, pass: index % 2 ? 1 : 2, fail: index % 2, cancelled: 0, skipped: 0, todo: 0 },
    });
    occurrences.push(phase.payload.occurrenceId);
  }
  store.finishPhase(store.startPhase(other, 'test'), 'failed');
  for (let index = 0; index < 400; index++) append(`late log ${index}`);
  const target = `/api/attempts/${attempt.id}`,
    query = `?projectId=${project.id}`;
  const response = await c.fetch(c.origin + target + '/phases' + query);
  assert.equal(response.status, 200);
  const phases = await response.json();
  assert.equal(phases.length, 320);
  assert.deepEqual(
    phases.filter(e => e.payload.boundary === 'start').map(e => e.payload.occurrenceId),
    occurrences,
  );
  assert.ok(phases.every(e => e.attempt_id === attempt.id && e.payload.attemptId === attempt.id));
  assert.equal(
    store.events(attempt.id).some(e => e.kind === 'phase'),
    false,
  );
  const selected = await (await c.fetch(c.origin + target + query)).json();
  assert.deepEqual(selected.phaseEvents, phases);
  const state = await c.state(project.id);
  assert.deepEqual(state.attempts.find(a => a.id === attempt.id).phaseEvents, phases);
  assert.ok(!state.events.some(e => e.kind === 'phase'));
  assert.ok(!state.attempts.some(a => a.id === other.id));
  const compact = await (await c.fetch(c.origin + '/api/state' + query + '&mode=dashboard')).json();
  assert.ok(!compact.attempts.some(a => a.id === other.id));
  assert.deepEqual(compact.events, state.events);
  assert.ok(compact.attempts.every(a => !Object.hasOwn(a, 'instructions') && !Object.hasOwn(a, 'phaseEvents')));
  const exported = await (await c.fetch(c.origin + '/api/export' + query + '&mode=dashboard')).json();
  assert.deepEqual(exported.attempts.find(a => a.id === attempt.id).phaseEvents, phases);
  assert.deepEqual(exported.attempts.find(a => a.id === attempt.id).instructions, selected.instructions);
  assert.equal((await c.fetch(c.origin + '/api/state' + query + '&mode=unknown')).status, 400);
  assert.equal((await c.fetch(c.origin + target + '?projectId=project-legacy')).status, 400);
  assert.equal((await c.fetch(c.origin + target + '/phases?projectId=project-legacy')).status, 400);
  assert.equal((await c.fetch(c.origin + `/api/attempts/${other.id}/phases` + query)).status, 400);
  assert.deepEqual(await (await c.fetch(c.origin + `/api/attempts/${empty.id}/phases` + query)).json(), []);
  assert.deepEqual((await (await c.fetch(c.origin + `/api/attempts/${empty.id}` + query)).json()).phaseEvents, []);
});

test('dashboard HTTP mode reads no snapshots and preserves complete attempt, journal, result and run exports', async t => {
  const { c, store, project, attempt, other } = await attemptLogFixture(t, 0),
    snapshot = { text: 'Immutable instructions', hash: 'fixture-hash', layers: [{ text: 'Full layer' }] },
    data = {
      ...attempt,
      workerId: 'W-02',
      provider: 'codex',
      requestedModel: 'fixture',
      configuration: { mode: 'workspace', extra: 'Full configuration' },
      assignment: { kind: 'studio-development:change-review', brief: 'Full assignment' },
      result: {
        taskId: attempt.taskId,
        outcome: 'completed',
        summary: 'Independent review passed',
        checks: [{ name: 'Review fixture', status: 'pass', evidence: 'Fixture' }],
        issues: [],
        handoff: 'Full handoff',
        detail: { text: 'Full result detail' },
      },
      candidateReviewVerdict: 'pass',
      candidateReviewFindings: [],
      candidateReviewNotes: ['Recorded note'],
      sourceIntegration: {
        id: 'integration-fixture',
        method: 'merge',
        state: 'verifying',
        reviewAttemptId: attempt.id,
        reviewTaskId: attempt.taskId,
        startedAt: '2026-10-20T12:00:00Z',
        changes: [{ path: 'src/example.mjs', body: 'Full change journal' }],
        verification: { stdout: 'Complete verification output' },
        repository: { branch: 'main', commit: 'abc1234' },
      },
    };
  store.updateAttempt(data);
  store.db.prepare('UPDATE attempts SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), attempt.id);
  const run = newRun({
    id: 'run-summary-export',
    projectId: project.id,
    brief: 'Recorded run',
    workflow: { id: 'fixture', name: 'Fixture', version: 1 },
    at: '2026-10-20T12:00:00Z',
    graph: { schemaVersion: 'graph-v1', nodes: [], edges: [] },
    envelope: { nodes: 0, attemptSeconds: 0 },
    taskIds: new Map(),
  });
  store.putRun(run);
  const before = store.db.prepare('SELECT id, snapshot, data FROM attempts ORDER BY rowid').all(),
    phase = store.startPhase(data, 'attempt');
  store.finishPhase(phase, 'succeeded', { detail: { text: 'Full phase detail' } });
  const phaseBytes = store.db.prepare("SELECT * FROM events WHERE kind='phase' ORDER BY seq").all(),
    query = `?projectId=${project.id}`;
  // Scheduling readiness itself reads full records. Compact GET is a read-only
  // observation; leave its default ready tasks present to guard that boundary.
  const prepare = store.db.prepare.bind(store.db);
  t.mock.method(store.db, 'prepare', sql => {
    if (/FROM attempts/i.test(sql)) assert.ok(!/snapshot|SELECT\s+\*/i.test(sql), sql);
    return prepare(sql);
  });
  const response = await c.fetch(c.origin + '/api/state' + query + '&mode=dashboard');
  const compact = await response.json();
  assert.equal(response.status, 200, JSON.stringify(compact));
  const summary = compact.attempts.find(a => a.id === attempt.id);
  assert.equal(summary.sourceIntegration.state, 'verifying');
  assert.equal(summary.sourceIntegration.reviewAttemptId, attempt.id);
  assert.deepEqual(summary.result.checks, data.result.checks);
  assert.deepEqual(summary.candidateReviewNotes, data.candidateReviewNotes);
  assert.ok(!Object.hasOwn(summary.sourceIntegration, 'changes'));
  assert.ok(!Object.hasOwn(summary.result, 'detail'));
  assert.ok(!compact.attempts.some(a => a.id === other.id));
  t.mock.restoreAll();
  const fullResponse = await c.fetch(c.origin + `/api/attempts/${attempt.id}` + query),
    full = await fullResponse.json(),
    exported = await (await c.fetch(c.origin + '/api/export' + query + '&mode=dashboard')).json(),
    exportedAttempt = exported.attempts.find(a => a.id === attempt.id);
  assert.equal(fullResponse.status, 200);
  assert.deepEqual(full.instructions, snapshot);
  assert.deepEqual(full.result, data.result);
  assert.deepEqual(full.sourceIntegration, data.sourceIntegration);
  assert.deepEqual(exportedAttempt, full);
  assert.deepEqual(exported.project, project);
  assert.ok(exported.runs.some(item => item.id === run.id && item.brief === run.brief));
  assert.equal(full.phaseEvents.at(-1).payload.detail.text, 'Full phase detail');
  assert.deepEqual(store.db.prepare('SELECT id, snapshot, data FROM attempts ORDER BY rowid').all(), before);
  assert.deepEqual(store.db.prepare("SELECT * FROM events WHERE kind='phase' ORDER BY seq").all(), phaseBytes);
  assert.equal((await c.fetch(c.origin + `/api/attempts/${attempt.id}?projectId=project-legacy`)).status, 400);
  assert.equal((await c.fetch(c.origin + `/api/attempts/${attempt.id}/phases?projectId=project-legacy`)).status, 400);
});

test('restart observes an interrupted attempt without fabricating nested completion or releasing uncertain leases', async t => {
  const { c, store, attempt } = await attemptLogFixture(t, 0);
  const running = { ...attempt, status: 'running', pid: null, provider: 'source-checks' };
  store.updateAttempt(running);
  store.startPhase(running, 'attempt');
  const nested = store.startPhase(running, 'test');
  store.claim(['source:studio-desk-tests'], attempt.id);
  const directory = store.directory;
  await c.app.close();
  c.app = createStudio({ directory, port: 0 });
  const phases = c.app.store.phaseEvents(attempt.id).map(e => e.payload);
  assert.equal(c.app.store.attempt(attempt.id).status, 'interrupted');
  assert.equal(phases.length, 3);
  assert.equal(phases.at(-1).outcome, 'interrupted');
  assert.equal(phases.at(-1).phaseId, 'attempt');
  assert.equal(phases.at(-1).timing, 'observed-until-restart');
  assert.ok(phases.at(-1).durationMs >= 0);
  assert.equal(phases.filter(p => p.occurrenceId === nested.payload.occurrenceId).length, 1);
  assert.equal(c.app.store.leases().length, 1);
  c.app.runner.reconcile(attempt.taskId);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal(c.app.store.phaseEvents(attempt.id).length, 3);
});

test('attempt log store pages include every event once and freeze totals while active logs grow', async t => {
  const { store, attempt, events, append } = await attemptLogFixture(t);
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (/FROM events/i.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...parameters) => {
        const rows = all(...parameters);
        assert.ok(rows.length <= 500, 'Database reads must be bounded before materializing event rows.');
        return rows;
      };
    }
    return statement;
  };
  const first = store.attemptEventPage(attempt.id);
  assert.equal(first.events.length, 500);
  assert.equal(first.total, 1007);
  assert.equal(first.snapshot, events.at(-1).seq);
  assert.equal(first.events[0].seq, events[0].seq);
  const late = append('Appended after the first page');
  let page = first;
  const seen = [];
  for (let requests = 0; ; requests++) {
    assert.ok(requests < 3, 'The original snapshot finishes in three bounded pages.');
    assert.equal(page.total, 1007);
    assert.equal(page.snapshot, first.snapshot);
    assert.ok(page.events.length <= 500);
    seen.push(...page.events.map(event => event.seq));
    if (page.nextCursor === null) break;
    assert.equal(page.nextCursor, page.events.at(-1).seq);
    page = store.attemptEventPage(attempt.id, { after: page.nextCursor, snapshot: first.snapshot });
  }
  assert.deepEqual(
    seen,
    events.map(event => event.seq),
  );
  assert.equal(new Set(seen).size, 1007);
  const end = store.attemptEventPage(attempt.id, { after: first.snapshot, snapshot: first.snapshot });
  assert.deepEqual(end.events, []);
  assert.equal(end.nextCursor, null);
  assert.equal(end.total, 1007);
  const fresh = store.attemptEventPage(attempt.id);
  assert.equal(fresh.total, 1008);
  assert.equal(fresh.snapshot, late.seq);
  for (const limit of [1, 127, 500]) {
    const sequences = [];
    let next = 0;
    do {
      page = store.attemptEventPage(attempt.id, { limit, after: next, snapshot: fresh.snapshot });
      assert.ok(page.events.length <= limit);
      sequences.push(...page.events.map(event => event.seq));
      next = page.nextCursor;
    } while (next !== null);
    assert.deepEqual(sequences, [...seen, late.seq]);
  }
});

test('attempt log store pages terminate for empty and exact-boundary snapshots and reject invalid bounds', async t => {
  const { store, attempt, empty, events, append } = await attemptLogFixture(t, 1000),
    frozenEmpty = { events: [], total: 0, snapshot: 0, nextCursor: null };
  assert.deepEqual(store.attemptEventPage(empty.id), frozenEmpty);
  append('An initially empty attempt starts producing events', empty);
  assert.deepEqual(store.attemptEventPage(empty.id, { snapshot: 0 }), frozenEmpty);
  assert.equal(store.attemptEventPage(empty.id).total, 1);
  const first = store.attemptEventPage(attempt.id, { limit: 500 }),
    second = store.attemptEventPage(attempt.id, { limit: 500, after: first.nextCursor, snapshot: first.snapshot });
  assert.equal(second.events.length, 500);
  assert.equal(second.total, 1000);
  assert.equal(second.events.at(-1).seq, events.at(-1).seq);
  assert.equal(second.nextCursor, null);
  for (const [name, values] of [
    ['limit', [0, -1, 0.5, 501, Infinity, NaN, '500', null]],
    ['after', [-1, 0.5, Infinity, NaN, '0', null, Number.MAX_SAFE_INTEGER + 1]],
    ['snapshot', [-1, 0.5, Infinity, NaN, '0', null, Number.MAX_SAFE_INTEGER + 1]],
  ])
    for (const value of values) assert.throws(() => store.attemptEventPage(attempt.id, { [name]: value }), /integer/);
  assert.throws(() => store.attemptEventPage(attempt.id, { snapshot: first.snapshot + 1 }), /snapshot/);
  assert.throws(() => store.attemptEventPage(attempt.id, { snapshot: events[0].seq - 1 }), /snapshot/);
  assert.throws(() => store.attemptEventPage(attempt.id, { after: first.snapshot + 1 }), /after/);
});

for (const transport of ['HTTP', 'handler']) {
  test(`attempt log ${transport} exact page boundaries terminate without an extra page`, async t => {
    const { c, events, url } = await attemptLogFixture(t, 1000, transport),
      first = await (await c.fetch(c.origin + url() + '&limit=500')).json(),
      second = await (
        await c.fetch(c.origin + url() + `&limit=500&after=${first.nextCursor}&snapshot=${first.snapshot}`)
      ).json();
    assert.equal(first.events.length, 500);
    assert.equal(second.events.length, 500);
    assert.equal(second.total, 1000);
    assert.equal(second.snapshot, first.snapshot);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.events, ...second.events], events);
  });

  test(`attempt log ${transport} pages preserve legacy newest-300 reads and the newest-150 live window`, async t => {
    const { c, store, project, attempt, empty, events, append, url } = await attemptLogFixture(t, 1007, transport),
      read = async suffix => {
        const response = await c.fetch(c.origin + url() + suffix);
        assert.equal(response.status, 200);
        return response.json();
      },
      legacy = await read('');
    assert.ok(Array.isArray(legacy));
    assert.deepEqual(legacy, events.slice(-300));
    const first = await read('&after=0');
    assert.equal(first.events.length, 500, 'Paging without a limit defaults to 500.');
    assert.equal(first.total, 1007);
    append('HTTP append after snapshot');
    const seen = [...first.events];
    let page = first;
    for (let requests = 0; page.nextCursor !== null; requests++) {
      assert.ok(requests < 2);
      page = await read(`&limit=500&after=${page.nextCursor}&snapshot=${first.snapshot}`);
      assert.equal(page.snapshot, first.snapshot);
      assert.equal(page.total, 1007);
      assert.ok(page.events.length <= 500);
      seen.push(...page.events);
    }
    assert.deepEqual(seen, events);
    assert.equal((await read('&limit=500')).total, 1008);
    const emptyPage = await (await c.fetch(c.origin + url(empty.id) + '&limit=500')).json();
    assert.deepEqual(emptyPage, { events: [], total: 0, snapshot: 0, nextCursor: null });
    assert.equal(store.events().length, 150);
    const state = await c.state(project.id);
    assert.deepEqual(
      state.events,
      store
        .events()
        .filter(event => event.task_id === attempt.taskId)
        .map(event => ({ ...event })),
    );
    assert.ok(state.events.length <= 150);
    assert.ok(!state.events.some(event => event.seq === events[0].seq));
  });

  test(`attempt log ${transport} rejects malformed, duplicate, unsafe and excessive paging values`, async t => {
    const { c, events, url } = await attemptLogFixture(t, 2, transport);
    for (const name of ['limit', 'after', 'snapshot']) {
      for (const value of ['', '-1', '1.5', 'NaN', 'Infinity', 'abc', '1e2', '+1', ' 1', '01', '9007199254740992']) {
        const response = await c.fetch(c.origin + url() + `&${name}=${encodeURIComponent(value)}`);
        assert.equal(response.status, 400, `${name}=${value}`);
        assert.match((await response.json()).error, new RegExp(name));
      }
      const duplicate = await c.fetch(c.origin + url() + `&${name}=1&${name}=2`);
      assert.equal(duplicate.status, 400);
    }
    for (const suffix of [
      '&limit=0',
      '&limit=501',
      '&after=999999',
      `&snapshot=${events.at(-1).seq + 1}`,
      `&snapshot=${events[0].seq - 1}`,
    ]) {
      const response = await c.fetch(c.origin + url() + suffix);
      assert.equal(response.status, 400, suffix);
    }
    const response = await c.fetch(c.origin + url() + '&snapshot=0');
    assert.deepEqual(await response.json(), { events: [], total: 0, snapshot: 0, nextCursor: null });
  });

  test(`attempt log ${transport} download streams a fixed snapshot in bounded batches as escaped UTF-8 lines`, async t => {
    const { c, store, attempt, empty, events, append, url } = await attemptLogFixture(t, 1007, transport),
      original = store.attemptEventPage.bind(store),
      pages = [];
    // Append immediately after the initial read, before any response bytes. Later
    // batches must keep the original bound even when the download's log grows.
    store.attemptEventPage = (id, options) => {
      const page = original(id, options);
      pages.push({ id, options, count: page.events.length, snapshot: page.snapshot });
      if (pages.length === 1) append('LATE DOWNLOAD EVENT');
      return page;
    };
    const response = await c.fetch(c.origin + url(attempt.id, '/download'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="attempt-log-target-logs.txt"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()),
      lines = content.split('\n');
    assert.equal(lines.pop(), '');
    assert.equal(lines.length, events.length);
    // Independent JSON string escaping gives an exact oracle for these fields,
    // including literal backslashes, CR/LF, tabs and Unicode line separators.
    const field = value =>
      JSON.stringify(value)
        .slice(1, -1)
        .replace(/\u0085/g, '\\u0085')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    assert.deepEqual(
      lines,
      events.map(event => [event.time, event.kind, event.message].map(field).join('\t')),
    );
    assert.ok(!content.includes('\r'));
    assert.ok(!content.includes('FOREIGN EVENT'));
    assert.ok(!content.includes('LATE DOWNLOAD EVENT'));
    assert.deepEqual(
      pages.map(page => page.count),
      [500, 500, 7],
    );
    assert.ok(pages.every(page => page.id === attempt.id && page.snapshot === events.at(-1).seq));
    assert.ok(pages.slice(1).every(page => page.options.snapshot === events.at(-1).seq));
    store.attemptEventPage = original;
    const fresh = await c.fetch(c.origin + url(attempt.id, '/download'));
    assert.match(await fresh.text(), /LATE DOWNLOAD EVENT/);
    const emptyResponse = await c.fetch(c.origin + url(empty.id, '/download'));
    assert.equal(emptyResponse.status, 200);
    assert.equal(await emptyResponse.text(), '');
    const unsafe = { ...attempt, id: 'attempt-unsafe%22%0D%0A.txt' };
    store.insertAttempt(unsafe, {});
    const safe = await c.fetch(c.origin + url(unsafe.id, '/download'));
    assert.equal(safe.status, 200);
    assert.match(safe.headers.get('content-disposition'), /^attachment; filename="[a-zA-Z0-9_-]+-logs\.txt"$/);
    await safe.text();
  });

  test(`attempt log ${transport} pages and downloads check owning project and request protections before reading events`, async t => {
    const { c, store, attempt, url } = await attemptLogFixture(t, 2, transport),
      original = store.attemptEventPage.bind(store);
    let reads = 0;
    store.attemptEventPage = (...args) => {
      reads++;
      return original(...args);
    };
    for (const suffix of ['', '&limit=500', '/download']) {
      const path = suffix === '/download' ? url(attempt.id, suffix) : url() + suffix,
        missing = path.replace(attempt.id, 'attempt-missing'),
        foreign = path.replace('project-log-fixture', 'project-legacy');
      for (const [target, error] of [
        [missing, /Attempt not found/],
        [foreign, /another project/],
      ]) {
        const response = await c.fetch(c.origin + target);
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('content-disposition'), null);
        assert.match((await response.json()).error, error);
      }
      const origin = await c.fetch(c.origin + path, { headers: { Origin: 'https://foreign.example' } });
      assert.equal(origin.status, 403);
      await origin.text();
      const hostStatus =
        transport === 'handler'
          ? (await c.fetch(c.origin + path, { headers: { Host: 'foreign.example' } })).status
          : await new Promise((resolve, reject) => {
              const request = http.get(c.origin + path, { headers: { Host: 'foreign.example' } }, response => {
                response.on('end', () => resolve(response.statusCode));
                response.resume();
              });
              request.on('error', reject);
            });
      assert.equal(hostStatus, 403);
    }
    assert.equal(reads, 0, 'Rejected reads expose no log pages or download headers.');
  });
}

test('separate projects preserve legacy records and reject cross-project tasks, attempts, artifacts and workflow runs', async t => {
  const c = await setup(t),
    org = c.app.store.organization(),
    legacy = c.app.store.task('D-001');
  const { project, workflow } = await c.development();
  assert.deepEqual(c.app.store.organization(), org);
  assert.deepEqual(c.app.store.task('D-001'), legacy);
  assert.equal(c.app.store.attempts('D-001').length, 0);
  const repeated = await c.development();
  assert.equal(repeated.project.id, project.id);
  assert.equal(c.app.store.workflows(project.id).length, 1);
  assert.deepEqual((await c.state(project.id)).tasks, []);
  assert.equal((await c.request('/api/tasks/D-001/start', { projectId: project.id })).status, 400);
  assert.equal(
    (
      await c.request('/api/tasks', {
        projectId: project.id,
        title: 'Bad transfer',
        brief: 'No transfer',
        kind: 'general',
        workerId: 'W-02',
        dependencies: ['D-001'],
      })
    ).status,
    400,
  );
  assert.equal((await c.request(`/api/workflows/${workflow.id}/run`, { expectedVersion: 1 })).status, 400);
  const run = await c.run(workflow),
    first = await c.wait(run.taskIds[0]);
  assert.match(first.outputFolder, /projects[\\/]project-studio-desk[\\/]jobs/);
  assert.equal(first.project.id, project.id);
  assert.equal(
    (await c.state('project-legacy')).tasks.some(task => task.id === first.taskId),
    false,
  );
  assert.equal((await c.state(project.id)).tasks.length, 2);
  for (const suffix of ['', '/logs', '/artifact?path=check-report.json'])
    assert.equal((await fetch(c.origin + '/api/attempts/' + first.id + suffix)).status, 400);
  assert.equal(
    (await fetch(c.origin + `/api/attempts/${first.id}/artifact?projectId=${project.id}&path=check-report.json`))
      .status,
    200,
  );
  assert.equal((await c.request('/api/pipeline', { action: 'queue', taskIds: [first.taskId] })).status, 400);
  assert.equal(
    (await c.state('project-legacy')).events.some(event => event.kind === 'workflow_started'),
    false,
  );
});

test('a director run brief is validated, recorded on the run and reaches each attempt as direction', async t => {
  const c = await setup(t),
    { project, workflow } = await c.development(),
    run = (brief, extra = {}) =>
      c.request(`/api/workflows/${workflow.id}/run`, {
        projectId: project.id,
        expectedVersion: workflow.version,
        brief,
        ...extra,
      });
  assert.equal((await run('x'.repeat(4001))).status, 400);
  assert.equal((await run(42)).status, 400);
  assert.deepEqual((await c.state(project.id)).tasks, []);
  const brief = 'Propose the dashboard Needs you panel.',
    started = await run(`  ${brief}  `);
  assert.equal(started.status, 201, JSON.stringify(started.data));
  for (const id of started.data.taskIds) {
    const task = c.app.store.task(id);
    assert.equal(task.direction, `Director brief for this run: ${brief}`);
    assert.equal(task.workflowReference.brief, brief);
    assert.equal(task.workflowReference.runId, c.app.store.task(started.data.taskIds[0]).workflowReference.runId);
  }
  const first = await c.wait(started.data.taskIds[0]),
    snapshot = JSON.parse(fs.readFileSync(path.join(path.dirname(first.outputFolder), 'instructions.json'), 'utf8'));
  assert.match(snapshot.text, /Director brief for this run: Propose the dashboard Needs you panel\./);
  assert.ok(
    (await c.state(project.id)).events.some(
      event => event.kind === 'workflow_started' && /with a run brief/.test(event.message),
    ),
  );
  const plain = await c.run(workflow);
  assert.equal(c.app.store.task(plain.taskIds[0]).direction, '');
  assert.equal('brief' in c.app.store.task(plain.taskIds[0]).workflowReference, false);
});

test('source checks record immutable source/process evidence, wait for acceptance, and block unverified Codex before dispatch', async t => {
  const c = await setup(t),
    { project, workflow } = await c.development(),
    run = await c.run(workflow),
    first = await c.wait(run.taskIds[0]);
  assert.equal(first.checkExecution.fixture, true);
  assert.equal(first.result.outcome, 'completed');
  assert.ok(first.controllerChecks.some(check => check.name === 'Source execution and provenance'));
  assert.equal(
    first.sourceCheck.files.some(item => item.path.startsWith('data/')),
    false,
  );
  assert.equal(
    first.sourceCheck.files.some(item => item.path.startsWith('.')),
    false,
  );
  assert.equal(c.app.store.attempts(run.taskIds[1]).length, 0);
  assert.equal((await c.request(`/api/tasks/${run.taskIds[1]}/accept`, { projectId: project.id })).status, 400);
  const reportFile = path.join(first.outputFolder, 'check-report.json'),
    original = fs.readFileSync(reportFile),
    report = JSON.parse(original);
  const read = name => fs.readFileSync(path.join(first.outputFolder, name), 'utf8');
  assert.deepEqual(
    validateCheckReport(
      report,
      first.sourceCheck,
      first.checkExecution,
      read('test-output.txt'),
      read('test-errors.txt'),
    ),
    report,
  );
  assert.throws(
    () =>
      validateCheckReport(
        { ...report, passed: false },
        first.sourceCheck,
        first.checkExecution,
        read('test-output.txt'),
        read('test-errors.txt'),
      ),
    /does not match/,
  );
  fs.writeFileSync(reportFile, JSON.stringify({ ...report, totals: { tests: 900, pass: 900 } }));
  assert.equal((await c.request(`/api/tasks/${first.taskId}/accept`, { projectId: project.id })).status, 400);
  fs.writeFileSync(reportFile, original);
  assert.equal((await c.request(`/api/tasks/${first.taskId}/accept`, { projectId: project.id })).status, 200);
  assert.throws(() => c.app.runner.start(run.taskIds[1]), /not a fixture/);
  // This trusted protocol seam lets us reach the live-review preflight without
  // invoking a model. Production records never modify this flag.
  const accepted = c.app.store.attempt(first.id);
  accepted.checkExecution.fixture = false;
  const measuredReport = JSON.parse(read('check-report.json'));
  measuredReport.execution.fixture = false;
  fs.writeFileSync(reportFile, JSON.stringify(measuredReport));
  accepted.artifacts.find(item => item.path === 'check-report.json').hash = hash(fs.readFileSync(reportFile));
  c.app.store.updateAttempt(accepted);
  assert.throws(() => c.app.runner.start(run.taskIds[1]), /isolation did not pass/);
  c.app.runner.refreshReadiness();
  assert.equal(
    c.app.store.task(run.taskIds[1]).status,
    'blocked',
    'A failed isolation probe must not become an automatic retry loop.',
  );
  assert.equal(c.app.store.attempts(run.taskIds[1]).length, 0);
  assert.equal(c.app.store.leases().length, 0);
  const snapshot = first.instructions.hash;
  await c.request(
    '/api/projects/' + project.id,
    {
      projectId: project.id,
      expectedRevision: 1,
      name: project.name,
      goal: 'New future goal',
      direction: 'New future direction',
    },
    'PATCH',
  );
  assert.equal(c.app.store.attempt(first.id).project.revision, 1);
  assert.equal(c.app.store.attempt(first.id).instructions.hash, snapshot);
});

test('negative source reports remain reviewable while malformed totals and changed copied source fail validation', async t => {
  for (const mode of ['fail', 'malformed', 'mutate']) {
    const c = await setup(t, mode),
      { project, workflow } = await c.development(),
      run = await c.run(workflow);
    const first = await c.wait(run.taskIds[0], mode === 'fail' ? 'review' : 'failed');
    assert.equal(c.app.store.leases().length, 0);
    if (mode === 'fail') {
      assert.ok(first.result.checks.some(check => check.status === 'fail'));
      assert.equal((await c.request(`/api/tasks/${first.taskId}/accept`, { projectId: project.id })).status, 200);
    } else {
      assert.match(first.error, /totals|copied source/);
      assert.equal((await c.request(`/api/tasks/${first.taskId}/accept`, { projectId: project.id })).status, 400);
    }
  }
});

test('source checks hold no source reservation across projects; cancellation waits for process close and restart requires reconciliation', async t => {
  const c = await setup(t, 'hang'),
    { project, workflow } = await c.development();
  const first = (
    await c.request('/api/tasks', {
      projectId: project.id,
      title: 'Hold source checks',
      brief: 'Fixture process',
      kind: 'studio-development:checks',
      workerId: 'W-06',
    })
  ).data;
  const other = (
    await c.request('/api/tasks', {
      title: 'Competing project checks',
      brief: 'Fixture process',
      kind: 'studio-development:checks',
      workerId: 'W-07',
    })
  ).data;
  // Checks measure a commit in their own worktree and write no source (MP-016 slice 4), so two
  // projects' checks run side by side, each holding only its employee.
  c.app.runner.start(first.id);
  c.app.runner.start(other.id);
  assert.deepEqual(
    c.app.store
      .leases()
      .map(lease => lease.resource)
      .sort(),
    ['employee:W-06', 'employee:W-07'],
  );
  for (const id of [first.id, other.id]) {
    assert.equal(c.app.store.task(id).status, 'running');
    c.app.runner.stop(c.app.store.task(id).lastAttemptId);
    await c.wait(id, 'cancelled');
  }
  assert.equal(c.app.store.leases().length, 0);
  const id = 'interrupted-source-fixture';
  c.app.store.tx(() => {
    c.app.store.insertAttempt(
      {
        id,
        projectId: project.id,
        taskId: first.id,
        workerId: first.workerId,
        provider: 'source-checks',
        status: 'running',
        pid: null,
        artifacts: [],
      },
      { text: 'Recorded source instructions', hash: 'fixture' },
    );
    // An interrupted check from before slice 4 held the source lock; it stays held until reconciled.
    c.app.store.claim(['employee:W-06', 'source:studio-desk-tests'], id);
    const task = c.app.store.task(first.id);
    task.status = 'running';
    task.lastAttemptId = id;
    c.app.store.putTask(task);
  });
  await c.app.close();
  c.app = createStudio(c.options);
  await c.connect();
  assert.equal(c.app.store.attempt(id).status, 'interrupted');
  assert.equal(c.app.store.leases().length, 2);
  assert.throws(() => c.app.runner.start(first.id), /Reconcile/);
  c.app.runner.reconcile(first.id);
  assert.equal(c.app.store.leases().length, 0);
  assert.equal(c.app.store.attempts(first.id).length, 2);
});

test('source checks measure the current commit in their own worktree while a story holds the source (MP-016 slice 4)', async t => {
  const { c, project } = await intakeProject(t),
    store = c.app.store;
  measuredIntakeSource(c, t);
  const root = c.app.runner.sourceChangeRoot,
    head = git(root, ['rev-parse', 'HEAD']),
    committed = fs.readFileSync(path.join(root, 'src/core/projects.mjs'));
  // Uncommitted and untracked files in the development copy are not part of the commit.
  fs.writeFileSync(path.join(root, 'src/core/projects.mjs'), 'export const project = "uncommitted";');
  fs.writeFileSync(path.join(root, 'src/untracked.mjs'), 'export const untracked = true;');
  // A story's edit or integration holds the source locks; checks write no source and do not wait.
  store.claim(['source:studio-desk-tests', 'source:studio-desk-integration'], 'source-integration:held-by-a-story');
  const task = (
    await c.request('/api/tasks', {
      projectId: project.id,
      title: 'Checks while a story integrates',
      brief: 'Measure the current commit.',
      kind: 'studio-development:checks',
      workerId: 'W-06',
    })
  ).data;
  const started = await c.request(`/api/tasks/${task.id}/start`, { projectId: project.id });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const attempt = await c.wait(task.id);
  assert.equal(attempt.checkExecution.fixture, false);
  assert.equal(attempt.result.checks.find(check => check.name === 'Node test suite').status, 'pass');
  assert.deepEqual(attempt.sourceCheck.base, { commit: head, branch: 'main' });
  assert.equal(attempt.sourceCheck.root, root);
  const measured = file => attempt.sourceCheck.files.find(item => item.path === file);
  assert.equal(measured('src/core/projects.mjs').hash, hash(committed));
  assert.equal(measured('src/untracked.mjs'), undefined);
  const report = JSON.parse(fs.readFileSync(path.join(attempt.outputFolder, 'check-report.json'), 'utf8'));
  assert.equal(report.source.commit, head);
  assert.equal(report.source.root, root);
  assert.deepEqual(
    fs.readFileSync(path.join(path.dirname(attempt.outputFolder), 'source', 'src/core/projects.mjs')),
    committed,
  );
  // The worktree was removed before the tests ran, and the held locks were never touched.
  assert.equal(fs.existsSync(path.join(store.directory, 'wt', 'c-' + worktreeName(attempt.id))), false);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  assert.deepEqual(
    store.leases().map(lease => lease.attemptId),
    ['source-integration:held-by-a-story', 'source-integration:held-by-a-story'],
  );
  assert.equal((await c.request(`/api/tasks/${task.id}/accept`, { projectId: project.id })).status, 200);
  // Checks need a git repository to measure a commit, and say so before any attempt. Inside a
  // candidate's worktree (the sandboxed suite) this folder sits within that repository instead.
  const plain = path.join(c.directory, 'plain-source');
  fs.cpSync(root, plain, { recursive: true, filter: source => path.basename(source) !== '.git' });
  c.app.runner.sourceChangeRoot = fs.realpathSync(plain);
  const again = (
    await c.request('/api/tasks', {
      projectId: project.id,
      title: 'Checks without git',
      brief: 'Refused.',
      kind: 'studio-development:checks',
      workerId: 'W-06',
    })
  ).data;
  const refused = await c.request(`/api/tasks/${again.id}/start`, { projectId: project.id });
  assert.equal(refused.status, 400);
  assert.match(
    refused.data.error,
    /^The live source must be (a git repository before measuring the source|the root of its git repository)\.$/,
  );
  assert.equal(store.attempts(again.id).length, 0);
});

test('saved workflows reject cycles, forged fields, incompatible handoffs, stale versions and excessive budgets', async t => {
  const c = await setup(t),
    { project, workflow } = await c.development();
  for (const mutate of [
    steps => steps[0].dependencies.push('review'),
    steps => (steps[0].status = 'done'),
    steps => (steps[1].dependencies = []),
    steps => {
      steps[0].maxAttempts = 3;
      steps[0].maxSeconds = 600;
      steps[1].maxAttempts = 3;
      steps[1].maxSeconds = 600;
    },
  ]) {
    const steps = structuredClone(workflow.steps);
    mutate(steps);
    assert.equal(
      (await c.request('/api/workflows', { projectId: project.id, name: 'Rejected workflow', steps })).status,
      400,
    );
  }
  assert.equal(
    (await c.request(`/api/workflows/${workflow.id}/run`, { projectId: project.id, expectedVersion: 9 })).status,
    409,
  );
  assert.equal(c.app.store.tasks().length, 2); // original game starters only
  assert.throws(
    () => testTotals('# tests 1\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0'),
    /inconsistent/,
  );
  const plan = sourcePlan();
  assert.ok(plan.files.length > 40);
  assert.equal(plan.command.args[0], '--test');
});

test('source review validates exact accepted identities, negative findings, bounded file scope and unperformed checks', () => {
  const validate = studioDevelopmentPack.tasks[1].validateOutput,
    source = {
      taskId: 'T-input',
      attemptId: 'attempt-input',
      path: 'check-report.json',
      hash: hash('report'),
      sourceHash: hash('source'),
      passed: true,
      files: ['src/core/projects.mjs'],
    };
  const report = {
    schemaVersion: 'source-review-v1',
    source: {
      sourceHash: source.sourceHash,
      hash: source.hash,
      path: source.path,
      attemptId: source.attemptId,
      taskId: source.taskId,
    },
    verdict: 'pass',
    summary: 'Measured checks pass; one improvement is proposed.',
    findings: [],
    proposal: {
      complexity: 1,
      title: 'Refine project context',
      reason: 'A bounded improvement from supplied source context.',
      files: source.files,
      scope: 'Clarify one project check.',
      acceptance: 'Verify project isolation behavior.',
    },
    unperformedChecks: ['Browser layout', 'Engine integration', 'Playtest'],
  };
  const run = data => {
    const checks = [];
    validate({
      attempt: {
        contracts: { task: { kind: 'studio-development:review', version: 'source-review-v2' } },
        sourceReview: source,
        artifacts: [{ path: 'source-review.json', kind: 'source-review' }],
      },
      readArtifact: () => Buffer.from(JSON.stringify(data)),
      checks,
    });
    return checks;
  };
  assert.equal(run(report)[0].status, 'pass');
  for (const complexity of [undefined, 13, '2', null]) {
    const invalid = structuredClone(report);
    if (complexity === undefined) delete invalid.proposal.complexity;
    else invalid.proposal.complexity = complexity;
    assert.throws(() => run(invalid), /proposal.complexity.*smaller stories/);
  }
  const definition = studioDevelopmentPack.tasks[1];
  assert.equal(definition.version, 'source-review-v2');
  assert.equal(definition.instructions().assignment.reviewShape.proposal.complexity, 1);
  assert.match(definition.instructions().layers[0].text, /complexity is required/);
  const assess = 'Source review must assess and link the exact accepted report: ',
    improve = 'Propose one bounded improvement to recorded source files: ',
    label = 'Label unperformed source review checks: ';
  // Each rejection keeps its earlier generic message as the prefix.
  for (const [mutate, prefix] of [
    [data => (data.source.hash = hash('forged')), assess],
    [data => (data.proposal.files = ['data/studio.sqlite']), improve],
    [data => (data.unperformedChecks = []), label],
    [
      data => {
        data.verdict = 'needs-work';
        data.findings = [];
      },
      assess,
    ],
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(
      () => run(invalid),
      error => error.message.startsWith(prefix),
    );
  }
  // An automatic retry receives this message as its direction, so it names each problem.
  const named = (mutate, expected) => {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => run(invalid), { message: expected });
  };
  named(
    data => (data.findings = [{ severity: 'minor', file: 'src/core/projects.mjs', summary: 'Structured.' }]),
    assess + 'findings must be an array of at most 20 plain strings, not objects.',
  );
  named(data => (data.source.sourceHash = hash('forged')), `${assess}source.sourceHash must be ${source.sourceHash}.`);
  named(
    data => delete data.unperformedChecks,
    label + 'unperformedChecks must include Browser layout, Engine integration and Playtest.',
  );
  named(
    data => {
      data.verdict = 'fail';
      data.proposal.files = [];
      data.unperformedChecks = ['Playtest'];
    },
    assess +
      'verdict must be pass or needs-work; proposal must list 1 to 100 source paths in total across files, newFiles and deleteFiles; ' +
      'unperformedChecks must include Browser layout, Engine integration and Playtest.',
  );
  source.passed = false;
  assert.throws(() => run(report), /exact accepted report: failing source checks require verdict needs-work\.$/);
});

test('a workflow step that never started can be closed; started work cannot', async t => {
  const c = await setup(t),
    { project, workflow } = await c.development(),
    run = await c.run(workflow),
    [checks, review] = run.taskIds;
  await c.wait(checks);
  const closed = await c.request(`/api/tasks/${review}/deny-work`, {
    projectId: project.id,
    reason: 'Prerequisite will not be accepted.',
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const task = c.app.store.task(review);
  assert.equal(task.status, 'denied');
  assert.equal(task.queued, false);
  assert.equal(task.approval.workflowStep, true);
  assert.equal(task.reason, 'Prerequisite will not be accepted.');
  assert.equal((await c.request(`/api/tasks/${checks}/deny-work`, { projectId: project.id })).status, 400);
});

test('closing what is left of a run checks every task before changing any', async t => {
  const c = await setup(t),
    { project, workflow } = await c.development(),
    run = await c.run(workflow),
    [checks, review] = run.taskIds;
  await c.wait(checks);
  const refused = await c.request('/api/tasks/close', { projectId: project.id, taskIds: [review, checks] });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, new RegExp(`${checks} has started or finished`));
  assert.equal(c.app.store.task(review).status, 'blocked', 'Nothing is closed when one task cannot be.');
  assert.equal((await c.request('/api/tasks/close', { projectId: project.id, taskIds: [] })).status, 400);
  assert.equal(
    (await c.request('/api/tasks/close', { taskIds: [review] })).status,
    400,
    'Tasks stay in their project.',
  );
  const closed = await c.request('/api/tasks/close', {
    projectId: project.id,
    taskIds: [review],
    reason: 'Closed from the run story.',
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(c.app.store.task(review).status, 'denied');
  assert.equal(c.app.store.task(review).reason, 'Closed from the run story.');
});

test('project-scoped archive actions are protected, reversible and leave settled run history available', async t => {
  const c = await setup(t),
    { project, workflow } = await c.development(),
    run = await c.run(workflow),
    url = `/api/projects/${project.id}/runs/${run.runId}`;
  await c.wait(run.taskIds[0]);
  const unsettled = await c.request(url + '/archive', { projectId: project.id });
  assert.equal(unsettled.status, 400);
  assert.match(unsettled.data.error, /cannot be archived/);
  for (const id of run.taskIds) {
    const closed = await c.request(`/api/tasks/${id}/close`, { projectId: project.id, reason: 'End this run.' });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
  }
  const store = c.app.store,
    before = { run: store.run(run.runId), tasks: store.tasks(), attempts: store.allAttempts(), leases: store.leases() };
  for (const action of ['archive', 'restore']) {
    const unprotected = await fetch(c.origin + url + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    });
    assert.equal(unprotected.status, 403);
    const foreignOrigin = await fetch(c.origin + url + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token, Origin: 'https://example.invalid' },
      body: JSON.stringify({ projectId: project.id }),
    });
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await fetch(c.origin + url + '/' + action)).status, 403);
    assert.equal((await c.request(url + '/' + action, { projectId: 'project-legacy' })).status, 400);
    const crossProject = await c.request(`/api/projects/project-legacy/runs/${run.runId}/${action}`);
    assert.equal(crossProject.status, 400);
    assert.match(crossProject.data.error, /another project/);
    const unknown = await c.request(`/api/projects/${project.id}/runs/run-missing/${action}`, {
      projectId: project.id,
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.data.error, /Run not found/);
  }
  assert.equal((await c.request(url + '/archive', { projectId: project.id, archived: true })).status, 400);
  // Controller operations can retain leases under a journal ID after model work stops.
  const stopped = store.attempts(run.taskIds[0])[0];
  for (const field of ['integration', 'sourceIntegration']) {
    store.updateAttempt({ ...stopped, [field]: { id: 'archive-reservation-fixture' } });
    store.claim(['fixture:archive-reservation'], 'archive-reservation-fixture');
    const leases = store.leases(),
      refused = await c.request(url + '/archive', { projectId: project.id });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /reservation/);
    assert.deepEqual(store.leases(), leases);
    store.release('archive-reservation-fixture');
    store.updateAttempt(stopped);
  }
  const archived = await c.request(url + '/archive', { projectId: project.id });
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  assert.equal(archived.data.archive.archived, true);
  const events = store.events();
  assert.deepEqual((await c.request(url + '/archive', { projectId: project.id })).data, archived.data);
  assert.deepEqual(store.events(), events);
  const state = await c.state(project.id);
  assert.deepEqual(state.runs.find(item => item.id === run.runId).archive, archived.data.archive);
  const exported = await (await fetch(c.origin + '/api/export?projectId=' + project.id)).json();
  assert.ok(exported.runs.some(item => item.id === run.runId));
  assert.deepEqual(
    { run: store.run(run.runId), tasks: store.tasks(), attempts: store.allAttempts(), leases: store.leases() },
    before,
  );
  await c.app.close();
  c.app = createStudio(c.options);
  await c.connect();
  assert.deepEqual((await c.state(project.id)).runs.find(item => item.id === run.runId).archive, archived.data.archive);
  const restored = await c.request(url + '/restore', { projectId: project.id });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.archive.archived, false);
  assert.deepEqual((await c.request(url + '/restore', { projectId: project.id })).data, restored.data);
  await c.app.close();
  c.app = createStudio(c.options);
  await c.connect();
  assert.deepEqual((await c.state(project.id)).runs.find(item => item.id === run.runId).archive, restored.data.archive);
  assert.deepEqual(c.app.store.run(run.runId), before.run);
  assert.deepEqual(c.app.store.tasks(), before.tasks);
  assert.deepEqual(c.app.store.allAttempts(), before.attempts);
});

test('accepted source stories cannot archive before integration, but explicit closure settles the run', async t => {
  const c = await setup(t, 'pass', true),
    store = c.app.store,
    projectId = 'project-legacy',
    runId = 'run-source-archive',
    task = {
      id: 'T-source-archive',
      projectId,
      kind: 'studio-development:change',
      title: 'Source archive fixture',
      workerId: 'W-02',
      status: 'done',
      queued: false,
      dependencies: [],
      resources: [],
      approval: { status: 'approved' },
      acceptedAttemptId: 'A-source-archive',
      lastAttemptId: 'A-source-archive',
      sourceStage: {
        current: 'waiting-for-integration',
        phase: 'candidate-review',
        review: { attemptId: 'A-source-archive' },
      },
      workflowReference: { runId, key: 'story' },
    };
  store.putTask(task);
  store.insertAttempt(
    {
      id: task.acceptedAttemptId,
      taskId: task.id,
      projectId,
      status: 'accepted',
      result: { outcome: 'completed' },
      artifacts: [],
    },
    {},
  );
  store.putRun(
    newRun({
      id: runId,
      projectId,
      workflow: { id: 'workflow-source-archive', name: 'Source archive fixture', version: 1 },
      graph: { schemaVersion: 'graph-v1', nodes: [{ key: 'story', kind: task.kind, title: task.title }], edges: [] },
      envelope: { nodes: 1, attemptSeconds: 30 },
      taskIds: [['story', task.id]],
      at: '2026-10-01T00:00:00.000Z',
    }),
  );
  const archive = () => setRunArchived(store, c.app.runner.registries, projectId, runId, true);
  for (const current of ['waiting-for-integration', 'failed', 'blocked']) {
    store.putTask({ ...task, sourceStage: { ...task.sourceStage, current } });
    assert.throws(archive, /unfinished stages or integration/);
  }
  // A recorded external operation needs reconciliation even though its attempt is accepted.
  const attempt = store.attempt(task.acceptedAttemptId);
  store.updateAttempt({ ...attempt, sourceIntegration: { id: 'integration-fixture', state: 'needs-reconciliation' } });
  assert.throws(archive, /Reconcile the recorded source integration/);
  store.updateAttempt(attempt);
  store.putTask({ ...task, sourceStage: { ...task.sourceStage, current: 'integrated' } });
  assert.equal(archive().archived, true);
  setRunArchived(store, c.app.runner.registries, projectId, runId, false);
  store.putTask({
    ...task,
    status: 'denied',
    closed: { at: '2026-10-01T00:00:00.000Z', by: { type: 'director' } },
    sourceStage: { ...task.sourceStage, current: 'closed' },
  });
  assert.equal(archive().archived, true);
  assert.equal(projectRuns(store, projectId).find(item => item.id === runId).archive.archived, true);
});

const intakeUrl = '/api/studio-development/intake';
// Run the real protected handler without sockets or model processes. This also
// works in employee sandboxes that deny loopback connections.
async function fileIntakeProject(t) {
  const c = await setup(t, 'pass', true);
  c.send = (url, { method = 'GET', data, raw, chunks, headers = {} } = {}) =>
    new Promise(resolve => {
      const req = Readable.from(chunks || [Buffer.from(raw ?? (data === undefined ? '' : JSON.stringify(data)))]),
        responseHeaders = {},
        res = {
          headersSent: false,
          setHeader(name, value) {
            responseHeaders[name.toLowerCase()] = value;
          },
          writeHead(status, fields = {}) {
            this.status = status;
            this.headersSent = true;
            for (const [name, value] of Object.entries(fields)) this.setHeader(name, value);
          },
          end(content) {
            const bytes = Buffer.from(content || '');
            resolve({
              status: this.status,
              headers: responseHeaders,
              bytes,
              json: () => JSON.parse(bytes.toString('utf8')),
            });
          },
        };
      Object.assign(req, { url, method, headers: { host: '127.0.0.1:0', ...headers } });
      c.app.server.emit('request', req, res);
    });
  c.refreshToken = async () => {
    c.token = (await c.send('/')).bytes.toString().match(/name="studio-token" content="([^"]+)"/)[1];
  };
  await c.refreshToken();
  c.request = async (url, data = {}, method = 'POST') => {
    const response = await c.send(url, { method, data, headers: { 'x-studio-token': c.token } });
    return { status: response.status, data: response.json() };
  };
  c.state = async id => (await c.send('/api/state?projectId=' + id)).json();
  const { project } = await c.development(),
    org = c.app.store.organization();
  for (const id of ['W-01', 'W-02']) org.workers.find(worker => worker.id === id).provider = 'codex';
  c.app.store.setOrganization(org);
  return { c, project };
}
const inputFile = (name, mediaType, bytes) => ({ name, mediaType, data: Buffer.from(bytes).toString('base64') });
const directorFileFixtures = () => [
  inputFile(
    'reference.png',
    'image/png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=',
      'base64',
    ),
  ),
  inputFile('settings.json', 'application/json', '{\r\n  "count": 3, "label": "原文"\r\n}\r\n'),
  inputFile('direction.md', 'text/markdown', '\ufeff# Keep original bytes\r\n\r\n  Spacing\tand Unicode: café.\n'),
];
const inputUrl = item =>
  `/api/projects/${item.projectId}/runs/${item.runId}/inputs/${item.id}?projectId=${item.projectId}`;

test('file intake preserves a metadata-only immutable manifest and exact PNG, JSON and Markdown bytes across restart', async t => {
  const { c, project } = await fileIntakeProject(t),
    files = directorFileFixtures(),
    response = await c.request(intakeUrl, { projectId: project.id, idea: 'Original local references', files });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  // The idea composer's thumbnails are blob: URLs of the director's own files, so the page allows
  // images from them; scripts stay limited to the page's own files.
  const policy = (await c.send('/')).headers['content-security-policy'];
  assert.match(policy, /; img-src 'self' data: blob:;/);
  assert.match(policy, /; script-src 'self';/);
  const { runId, taskIds, directorInputs } = response.data;
  assert.equal(directorInputs.length, 3);
  assert.equal(new Set(directorInputs.map(item => item.id)).size, 3);
  const checkInputs = async () => {
    const state = await c.state(project.id),
      run = c.app.store.run(runId);
    assert.deepEqual(run.directorInputs, directorInputs);
    assert.deepEqual(state.runs.find(item => item.id === runId).directorInputs, directorInputs);
    for (const id of taskIds) {
      assert.equal(c.app.store.task(id).workflowReference.runId, runId);
      assert.deepEqual(c.app.store.task(id).directorInputs, directorInputs);
      assert.deepEqual(state.tasks.find(item => item.id === id).directorInputs, directorInputs);
    }
    for (const [index, item] of directorInputs.entries()) {
      const bytes = Buffer.from(files[index].data, 'base64');
      assert.deepEqual(
        Object.keys(item).sort(),
        ['id', 'projectId', 'runId', 'name', 'byteLength', 'mediaType', 'sha256'].sort(),
      );
      assert.match(item.id, /^input-[0-9a-f-]{36}$/);
      assert.equal(item.projectId, project.id);
      assert.equal(item.runId, runId);
      assert.equal(item.name, files[index].name);
      assert.equal(item.mediaType, files[index].mediaType);
      assert.equal(item.byteLength, bytes.length);
      assert.equal(item.sha256, hash(bytes));
      assert.equal(
        JSON.stringify(state).includes(files[index].data),
        false,
        'General state contains no encoded bytes.',
      );
      const download = await c.send(inputUrl(item));
      assert.equal(download.status, 200);
      assert.deepEqual(download.bytes, bytes);
      assert.equal(download.headers['content-type'], 'application/octet-stream');
      assert.match(download.headers['content-disposition'], /^attachment;/);
      assert.equal(download.headers['x-content-type-options'], 'nosniff');
      assert.match(download.headers['content-security-policy'], /sandbox/);
    }
  };
  await checkInputs();
  const raw = c.app.store.db.prepare('SELECT data FROM settings WHERE id=?').get('run:' + runId).data;
  await c.app.close();
  c.app = createStudio(c.options);
  await c.refreshToken();
  await checkInputs();
  assert.equal(c.app.store.db.prepare('SELECT data FROM settings WHERE id=?').get('run:' + runId).data, raw);
  const changedRun = c.app.store.run(runId);
  changedRun.directorInputs[0].name = 'replacement.png';
  assert.throws(() => c.app.store.putRun(changedRun), /immutable/);
  const changedTask = c.app.store.task(taskIds[0]);
  changedTask.directorInputs = [];
  assert.throws(() => c.app.store.putTask(changedTask), /immutable/);
  const textOnly = await c.request(intakeUrl, { projectId: project.id, idea: 'Text only still works' });
  assert.equal(textOnly.status, 201);
  assert.deepEqual(textOnly.data.directorInputs, []);
  assert.deepEqual(c.app.store.run(textOnly.data.runId).directorInputs, []);
  assert.ok(textOnly.data.taskIds.every(id => c.app.store.task(id).directorInputs.length === 0));
  assert.equal(c.app.store.allAttempts().length, 0, 'No dispatch or model execution is part of intake.');
});

test('file intake rejects invalid files and all four size ceilings before creating a run or tasks', async t => {
  const { c, project } = await fileIntakeProject(t),
    valid = directorFileFixtures()[2],
    before = intakeRecords(c.app.store),
    payload = { projectId: project.id, idea: 'Validate before dispatch' };
  assert.deepEqual(ideaInputLimits, { count: 10, fileBytes: 5242880, totalBytes: 20971520, wireBytes: 29360128 });
  const rejected = async (files, status = 400) => {
    const response = await c.request(intakeUrl, { ...payload, files });
    assert.equal(response.status, status, JSON.stringify(response.data));
    assert.deepEqual(intakeRecords(c.app.store), before);
    assert.equal(c.app.runner.active.size, 0);
  };
  for (const files of [
    null,
    {},
    'files',
    [null],
    [{ ...valid, path: '../escape' }],
    [{ ...valid, data: '!!!!' }],
    [{ ...valid, data: 'YQ' }],
    [{ ...valid, data: 'YR==' }],
    [{ ...valid, data: 'YQ==\n' }],
    [{ ...valid, data: 'data:text/plain;base64,YQ==' }],
    [inputFile('bad.txt', 'text/plain', Buffer.from([0xc3, 0x28]))],
    [inputFile('bad.json', 'application/json', '{not json}')],
    [inputFile('fake.png', 'image/png', '<svg onload="alert(1)">')],
    [inputFile('active.html', 'text/html', '<script>alert(1)</script>')],
    [inputFile('active.svg', 'image/svg+xml', '<svg/>')],
    [{ ...valid, mediaType: 'text/html' }],
    [{ ...valid, name: 'program.exe' }],
    [valid, { ...valid }],
    [valid, { ...valid, name: valid.name.toUpperCase() }],
    Array.from({ length: 11 }, (_, index) => ({ ...valid, name: `file-${index}.md` })),
  ])
    await rejected(files);
  for (const name of [
    '../outside.md',
    '..\\outside.md',
    '/absolute.md',
    'C:\\file.md',
    'bad\r\nheader.md',
    'CON.md',
    'trailing.md ',
    'trailing.md.',
    'quote".md',
    '\ud800.md',
    'a'.repeat(181) + '.md',
  ])
    await rejected([{ ...valid, name }]);
  const maxFile = Buffer.alloc(ideaInputLimits.fileBytes, 0x61),
    large = inputFile('large.txt', 'text/plain', Buffer.alloc(ideaInputLimits.fileBytes + 1, 0x61));
  await rejected([large], 413);
  const four = Array.from({ length: 4 }, (_, index) => inputFile(`limit-${index}.txt`, 'text/plain', maxFile));
  await rejected([...four, inputFile('extra.txt', 'text/plain', 'x')], 413);
  // Both declared and chunked wire lengths have their own ceiling, independent
  // of decoded sizes; unrelated API routes retain their existing 512 KiB cap.
  const wire = Buffer.alloc(ideaInputLimits.wireBytes + 1, 0x20);
  for (const headers of [{ 'content-length': String(wire.length) }, {}]) {
    const response = await c.send(intakeUrl, {
      method: 'POST',
      chunks: [wire.subarray(0, 1024), wire.subarray(1024)],
      headers: { 'x-studio-token': c.token, ...headers },
    });
    assert.equal(response.status, 413);
    assert.deepEqual(intakeRecords(c.app.store), before);
  }
  assert.equal(
    (
      await c.send('/api/projects', {
        method: 'POST',
        raw: ' '.repeat(512 * 1024 + 1),
        headers: { 'x-studio-token': c.token },
      })
    ).status,
    413,
  );
  assert.equal(fs.existsSync(path.join(c.directory, 'projects', project.id, 'idea-inputs')), false);
  const boundary = await c.request(intakeUrl, { ...payload, files: four });
  assert.equal(boundary.status, 201, JSON.stringify(boundary.data));
  assert.equal(
    boundary.data.directorInputs.reduce((size, item) => size + item.byteLength, 0),
    ideaInputLimits.totalBytes,
  );
  const ten = await c.request(intakeUrl, {
    ...payload,
    files: Array.from({ length: 10 }, (_, index) => inputFile(`empty-${index}.txt`, 'text/plain', '')),
  });
  assert.equal(ten.status, 201);
  assert.equal(ten.data.directorInputs.length, 10);
});

test('input downloads enforce protected project and run ownership and never serve active content inline', async t => {
  const { c, project } = await fileIntakeProject(t),
    first = await c.request(intakeUrl, { projectId: project.id, idea: 'Reference', files: directorFileFixtures() }),
    second = await c.request(intakeUrl, {
      projectId: project.id,
      idea: 'A different run',
      files: directorFileFixtures(),
    }),
    item = first.data.directorInputs[0],
    other = (await c.request('/api/projects', { name: 'Other project' })).data;
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(item.id, second.data.directorInputs[0].id);
  for (const url of [
    inputUrl(item).replace(`projectId=${project.id}`, `projectId=${other.id}`),
    inputUrl(item).replaceAll(project.id, other.id),
    inputUrl(item).replace(`?projectId=${project.id}`, ''),
  ])
    assert.equal((await c.send(url)).status, 400);
  assert.equal((await c.send(inputUrl(item).replace(item.runId, second.data.runId))).status, 404);
  for (const headers of [{ origin: 'https://foreign.example' }, { host: 'foreign.example' }])
    assert.equal((await c.send(inputUrl(item), { headers })).status, 403);
  assert.equal(
    (
      await c.send(intakeUrl, {
        method: 'POST',
        data: { projectId: project.id, idea: 'No token', files: directorFileFixtures() },
      })
    ).status,
    403,
  );
  const hostile = await c.request(intakeUrl, {
      projectId: project.id,
      idea: 'Untrusted reference data',
      files: [inputFile("untrusted ' text.md", 'text/markdown', '<svg onload="alert(1)"><script>alert(1)</script>')],
    }),
    download = await c.send(inputUrl(hostile.data.directorInputs[0]));
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(download.headers['content-disposition'], /^attachment;/);
  assert.match(download.headers['content-disposition'], /filename\*=UTF-8''untrusted%20%27%20text.md/);
  const filename = path.join(c.directory, 'projects', project.id, 'idea-inputs', item.runId, item.id + '.bin'),
    original = fs.readFileSync(filename),
    tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 1;
  fs.writeFileSync(filename, tampered);
  assert.equal((await c.send(inputUrl(item))).status, 409);
  fs.writeFileSync(filename, original);
  assert.deepEqual((await c.send(inputUrl(item))).bytes, original);
  assert.equal(c.app.store.allAttempts().length, 0);
});

test('file intake write and transaction failures leave no usable partial run and permit a clean retry', async t => {
  const { c, project } = await fileIntakeProject(t),
    store = c.app.store,
    before = intakeRecords(store),
    files = directorFileFixtures(),
    root = path.join(c.directory, 'projects', project.id, 'idea-inputs'),
    originalWrite = fs.writeFileSync;
  let writes = 0;
  const failure = t.mock.method(fs, 'writeFileSync', function (filename, ...args) {
    if (String(filename).endsWith('.bin') && ++writes === 2) throw new Error('Simulated input disk failure');
    return originalWrite.call(this, filename, ...args);
  });
  const failedWrite = await c.request(intakeUrl, { projectId: project.id, idea: 'Write failure', files });
  assert.equal(failedWrite.status, 400);
  assert.match(failedWrite.data.error, /Simulated input disk failure/);
  failure.mock.restore();
  assert.equal(writes, 2);
  assert.deepEqual(intakeRecords(store), before);
  assert.deepEqual(fs.readdirSync(root), []);
  const failedCommit = t.mock.method(store, 'putRun', () => {
    throw new Error('Simulated commit failure');
  });
  const response = await c.request(intakeUrl, { projectId: project.id, idea: 'Commit failure', files });
  failedCommit.mock.restore();
  assert.equal(response.status, 400);
  assert.match(response.data.error, /Simulated commit failure/);
  assert.deepEqual(intakeRecords(store), before, 'Task inserts roll back with the run.');
  assert.deepEqual(fs.readdirSync(root), []);
  // Even if cleanup itself is denied, partially written bytes have no run and
  // cannot be downloaded or dispatched. A retry uses a fresh storage identity.
  writes = 0;
  const failedAgain = t.mock.method(fs, 'writeFileSync', function (filename, ...args) {
      if (String(filename).endsWith('.bin') && ++writes === 2) throw new Error('Simulated partial write');
      return originalWrite.call(this, filename, ...args);
    }),
    failedCleanup = t.mock.method(fs, 'rmSync', () => {
      throw new Error('Simulated cleanup refusal');
    });
  const orphaned = await c.request(intakeUrl, { projectId: project.id, idea: 'Unreachable partial data', files });
  failedAgain.mock.restore();
  failedCleanup.mock.restore();
  assert.equal(orphaned.status, 400);
  assert.deepEqual(intakeRecords(store), before);
  const [orphanRun] = fs.readdirSync(root),
    [orphanFile] = fs.readdirSync(path.join(root, orphanRun));
  assert.equal(store.run(orphanRun), null);
  assert.equal(
    (await c.send(inputUrl({ projectId: project.id, runId: orphanRun, id: orphanFile.slice(0, -4) }))).status,
    404,
  );
  const retry = await c.request(intakeUrl, { projectId: project.id, idea: 'Clean retry', files });
  assert.equal(retry.status, 201);
  assert.notEqual(retry.data.runId, orphanRun);
  for (const item of retry.data.directorInputs) assert.equal((await c.send(inputUrl(item))).status, 200);
  assert.equal(store.allAttempts().length, 0);
});

async function intakeProject(t) {
  const c = await setup(t),
    { project, workflow } = await c.development(),
    org = c.app.store.organization();
  // Only protocol fixtures are used for model execution.
  for (const id of ['W-01', 'W-02']) org.workers.find(worker => worker.id === id).provider = 'codex';
  c.app.store.setOrganization(org);
  c.app.runner.codexBinary = cliFixture;
  c.app.runner.sourceReviewSandbox = () => ({ passed: true, implementation: 'protocol-fixture' });
  return { c, project, workflow };
}
function measuredIntakeSource(c, t) {
  // A real Node test process on a tiny disposable git repository, not the controller
  // suite and not a forged fixture=false report. No nested model invocation. Checks
  // measure its current commit (MP-016 slice 4).
  const root = path.join(c.directory, 'intake-source');
  const files = {
    'package.json': '{}',
    'AGENTS.md': 'Disposable model-free source fixture.',
    'HANDOFF.md': 'Fixture status.',
    'README.md': 'Fixture source repository.',
    'start-studio.cmd': '@echo off',
    'start-studio.sh': '#!/bin/sh',
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
    'vite.config.mjs': 'export default {};',
    'eslint.config.js': 'export default [];',
    'docs/module-contracts.md': 'Fixture contracts.',
    'src/core/projects.mjs': 'export const project = "fixture";',
    'src/core/workflows.mjs': 'export const workflow = "fixture";',
    'test/intake.test.mjs':
      'import test from "node:test"; import assert from "node:assert/strict"; test("fixture source", () => assert.equal(1 + 1, 2));',
  };
  for (const dir of ['src', 'public', 'test', 'scripts', 'docs'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  }
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Fixture source']);
  c.app.runner.sourceChangeRoot = fs.realpathSync(root);
  c.app.runner.sourceCheckCommand = undefined;
  // The nested fixed Node suite is a separate measured process. Do not let the
  // outer test runner mark it as another child of its own reporter protocol.
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
  });
}
function intakeRecords(store) {
  return {
    tasks: store.tasks(),
    runs: store.runs(),
    workflows: store.workflows(),
    attempts: store.allAttempts(),
    leases: store.leases(),
  };
}

test('idea intake queues only current-project planning, gates on fresh accepted checks and pins CLI story provenance', async t => {
  const { c, project, workflow } = await intakeProject(t),
    store = c.app.store;
  measuredIntakeSource(c, t);
  // Record a real prior attempt, then change the current defaults. Saved workflow
  // ownership must not determine the new intake owners.
  const oldTask = (
    await c.request('/api/tasks', {
      projectId: project.id,
      title: 'Earlier checks',
      brief: 'Prior fixture evidence',
      kind: 'studio-development:checks',
      workerId: 'W-06',
    })
  ).data;
  assert.equal((await c.request(`/api/tasks/${oldTask.id}/start`, { projectId: project.id })).status, 202);
  const oldAttempt = await c.wait(oldTask.id),
    config = store.setting('project-organization:' + project.id),
    saved = await c.request(`/api/projects/${project.id}/organization`, {
      projectId: project.id,
      expectedRevision: config.revision,
      teams: config.teams.map(({ goalTaskIds, ...team }) => team),
      members: config.members,
      taskKinds: config.taskKinds,
      kindOwners: { ...config.kindOwners, 'studio-development:checks': 'W-07', 'studio-development:breakdown': 'W-02' },
    });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const before = {
      project: store.project(project.id),
      config: store.setting('project-organization:' + project.id),
      workflows: store.workflows(),
      shared: store.organization(),
      oldAttempt: store.db.prepare('SELECT snapshot, data FROM attempts WHERE id=?').get(oldAttempt.id),
    },
    idea = 'Add a clear intake.\n\n  Keep  interior\twhitespace.  Finish with evidence.',
    response = await c.request(intakeUrl, { projectId: project.id, idea: ` \r\n${idea}\t ` });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const { runId, taskIds, budget } = response.data,
    [checksId, breakdownId] = taskIds,
    tasks = taskIds.map(id => store.task(id));
  assert.equal(taskIds.length, 2);
  assert.equal(new Set(taskIds).size, 2);
  assert.match(runId, /^run-/);
  assert.deepEqual(budget, { steps: 2, totalAttemptSeconds: 1620 });
  assert.equal(
    budget.totalAttemptSeconds,
    tasks.reduce((sum, task) => sum + task.maxSeconds * task.maxAttempts, 0),
  );
  assert.deepEqual(
    tasks.map(task => task.kind),
    ['studio-development:checks', 'studio-development:breakdown'],
  );
  assert.deepEqual(
    tasks.map(task => task.workerId),
    ['W-07', 'W-02'],
  );
  assert.deepEqual(
    tasks.map(task => task.dependencies),
    [[], [checksId]],
  );
  assert.equal(store.tasks().length, 5); // Two legacy starters, earlier checks, two intake steps.
  for (const task of tasks) {
    assert.equal(task.projectId, project.id);
    assert.equal(task.queued, true);
    assert.equal(task.lastAttemptId, null);
    assert.equal(task.workflowReference.runId, runId);
    assert.equal(task.workflowReference.brief, idea);
    assert.equal(task.direction, `Director brief for this run: ${idea}`);
    assert.equal(task.execution, undefined);
    assert.equal(task.approval, undefined);
    assert.deepEqual(task.resources, []);
  }
  assert.deepEqual(store.project(project.id), before.project);
  assert.deepEqual(store.setting('project-organization:' + project.id), before.config);
  assert.deepEqual(store.workflows(), before.workflows);
  assert.deepEqual(store.workflow(workflow.id), workflow);
  assert.deepEqual(store.organization().instructions, before.shared.instructions);
  assert.deepEqual(
    store.db.prepare('SELECT snapshot, data FROM attempts WHERE id=?').get(oldAttempt.id),
    before.oldAttempt,
  );
  assert.equal(c.app.runner.active.size, 0, 'Project pause retains queued work without dispatch.');
  // Accepting an older same-project check cannot release this breakdown.
  assert.equal((await c.request(`/api/tasks/${oldTask.id}/accept`, { projectId: project.id })).status, 200);
  assert.equal(store.attempts(breakdownId).length, 0);
  assert.deepEqual(
    (await c.request(`/api/tasks/${breakdownId}/start`, { projectId: project.id })).data.queued,
    true,
    'Start keeps work that waits for accepted checks queued.',
  );
  assert.match(store.task(breakdownId).reason, new RegExp(checksId));
  const oldBytes = store.db.prepare('SELECT snapshot, data FROM attempts WHERE id=?').get(oldAttempt.id),
    oldFiles = ['assignment.json', 'instructions.json'].map(name => {
      const file = path.join(path.dirname(oldAttempt.outputFolder), name);
      return [file, fs.readFileSync(file)];
    });
  assert.equal((await c.request('/api/pipeline', { projectId: project.id, action: 'resume' })).status, 200);
  const checked = await c.wait(checksId);
  assert.equal(checked.provider, 'source-checks');
  assert.equal(checked.contracts.adapter.id, 'source-checks');
  assert.equal(checked.checkExecution.fixture, false);
  assert.equal(checked.result.outcome, 'completed');
  assert.equal(store.attempts(breakdownId).length, 0);
  assert.deepEqual(
    (await c.request(`/api/tasks/${breakdownId}/start`, { projectId: project.id })).data.queued,
    true,
    'Start keeps work that waits for accepted checks queued.',
  );
  assert.equal((await c.request(`/api/tasks/${checksId}/accept`, { projectId: 'project-legacy' })).status, 400);
  assert.equal(store.task(checksId).status, 'review');
  assert.equal((await c.request(`/api/tasks/${checksId}/accept`, { projectId: project.id })).status, 200);
  const planned = await c.wait(breakdownId),
    report = checked.artifacts.find(item => item.kind === 'source-check-report'),
    context = checked.artifacts.find(item => item.kind === 'source-context');
  assert.equal(planned.provider, 'source-breakdown');
  assert.equal(planned.contracts.adapter.id, 'source-breakdown');
  assert.equal(planned.configuration.model, 'codex');
  assert.equal(planned.workerId, 'W-02');
  assert.equal(planned.contracts.task.version, 'source-breakdown-v1');
  assert.equal(planned.sessionId, 'fixture-session');
  assert.deepEqual(planned.sourceBreakdown, {
    taskId: checksId,
    attemptId: checked.id,
    path: report.path,
    hash: report.hash,
    sourceHash: checked.sourceCheck.sourceHash,
    contextPath: context.path,
    contextHash: context.hash,
    files: checked.sourceCheck.files,
    // New checks record Studio desk's second profile revision (MP-026).
    profile: checked.sourceCheck.profile,
  });
  assert.deepEqual(checked.sourceCheck.profile.directories.at(-1), 'dashboard');
  assert.equal(planned.inputReferences.length, 1);
  assert.equal(planned.inputReferences[0].taskId, checksId);
  assert.equal(planned.inputReferences[0].attemptId, checked.id);
  assert.deepEqual(
    planned.inputReferences[0].artifacts.map(item => item.hash),
    checked.artifacts.map(item => item.hash),
  );
  for (const item of planned.inputReferences[0].artifacts)
    assert.equal(hash(fs.readFileSync(path.resolve(planned.outputFolder, item.path))), item.hash);
  const stories = store.task(breakdownId).proposedTaskIds;
  assert.equal(stories.length, 2);
  assert.equal((await c.request(`/api/tasks/${stories[0]}/approve-work`, { projectId: project.id })).status, 400);
  const assertPlanned = () => {
    for (const [index, id] of stories.entries()) {
      const story = store.task(id);
      assert.equal(story.projectId, project.id);
      assert.equal(story.status, 'backlog');
      assert.equal(story.approval.status, 'pending');
      assert.equal(story.queued, false);
      assert.equal(store.attempts(id).length, 0);
      assert.deepEqual(story.proposalReference, {
        taskId: breakdownId,
        attemptId: planned.id,
        path: 'source-breakdown.json',
        hash: planned.artifacts[0].hash,
        key: ['validate', 'document'][index],
      });
      assert.deepEqual(story.acceptedInputs, [acceptedReference(store, checksId, checked.id, project.id)]);
    }
    assert.deepEqual(store.task(stories[0]).dependencies, [breakdownId, checksId]);
    assert.deepEqual(store.task(stories[1]).dependencies, [breakdownId, stories[0], checksId]);
  };
  assertPlanned();
  assert.equal((await c.request(`/api/tasks/${breakdownId}/accept`, { projectId: project.id })).status, 200);
  assertPlanned();
  assert.equal(store.allAttempts().length, 3);
  assert.equal(store.leases().length, 0);
  assert.equal(c.app.runner.autonomy.pendingIntegration(), null);
  assert.deepEqual(store.db.prepare('SELECT snapshot, data FROM attempts WHERE id=?').get(oldAttempt.id), oldBytes);
  for (const [file, bytes] of oldFiles) assert.deepEqual(fs.readFileSync(file), bytes);
  for (const [name, item] of Object.entries({ 'check-report.json': report, 'source-context.json': context }))
    assert.equal(hash(fs.readFileSync(path.join(checked.outputFolder, name))), item.hash);

  // Future edits affect future attempts; the recorded idea and each composed
  // assignment remain byte-for-byte immutable.
  const snapshots = [checked, planned].map(attempt => ({
    id: attempt.id,
    row: store.db.prepare('SELECT snapshot, data FROM attempts WHERE id=?').get(attempt.id),
    file: path.join(path.dirname(attempt.outputFolder), 'instructions.json'),
  }));
  for (const snapshot of snapshots) {
    snapshot.bytes = fs.readFileSync(snapshot.file);
    const instructions = JSON.parse(snapshot.bytes),
      assignment = JSON.parse(instructions.layers.find(layer => layer.title === 'Assignment').text);
    assert.equal(assignment.direction, `Director brief for this run: ${idea}`);
    assert.equal(assignment.workflow.brief, idea);
  }
  assert.equal(
    (
      await c.request(
        `/api/projects/${project.id}`,
        {
          projectId: project.id,
          expectedRevision: project.revision,
          name: project.name,
          goal: project.goal,
          direction: 'Later project direction',
        },
        'PATCH',
      )
    ).status,
    200,
  );
  const doc = before.config.instructions.company,
    instructionUrl = '/api/instructions/company/company';
  assert.equal(
    (
      await c.request(instructionUrl + '/draft', {
        projectId: project.id,
        baseRevision: doc.revision,
        text: 'Later published instructions',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await c.request(instructionUrl + '/publish', {
        projectId: project.id,
        baseRevision: doc.revision,
        text: 'Later published instructions',
      })
    ).status,
    200,
  );
  const next = store.setting('project-organization:' + project.id);
  assert.equal(
    (
      await c.request(`/api/projects/${project.id}/organization`, {
        projectId: project.id,
        expectedRevision: next.revision,
        teams: next.teams.map(({ goalTaskIds, ...team }) => team),
        members: next.members,
        taskKinds: next.taskKinds,
        kindOwners: { ...next.kindOwners, 'studio-development:checks': 'W-06', 'studio-development:breakdown': 'W-01' },
      })
    ).status,
    200,
  );
  for (const snapshot of snapshots) {
    assert.deepEqual(store.db.prepare('SELECT snapshot, data FROM attempts WHERE id=?').get(snapshot.id), snapshot.row);
    assert.deepEqual(fs.readFileSync(snapshot.file), snapshot.bytes);
  }
  assert.deepEqual(store.db.prepare('SELECT snapshot, data FROM attempts WHERE id=?').get(oldAttempt.id), oldBytes);
  for (const [file, bytes] of oldFiles) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(store.workflows(), before.workflows);
  assert.deepEqual(store.setting('project-organization:' + project.id).instructions.company.history[0], doc.history[0]);
});

test('idea intake rejects untrusted fields, invalid ideas, protected requests and foreign project inputs before any write or process', async t => {
  const { c, project } = await intakeProject(t),
    store = c.app.store,
    before = intakeRecords(store),
    valid = { projectId: project.id, idea: 'One bounded idea' };
  const rejected = async (data, expected = 400) => {
    const response = await c.request(intakeUrl, data);
    assert.equal(response.status, expected, JSON.stringify({ data, response }));
    assert.deepEqual(intakeRecords(store), before);
    assert.equal(c.app.runner.active.size, 0);
  };
  for (const idea of ['', ' \t\r\n\u00a0 ', 42, null, {}, [], true, 'x'.repeat(4001)])
    await rejected({ ...valid, idea });
  for (const data of [null, [], 'idea', 42, {}, { idea: valid.idea }, { projectId: project.id }]) await rejected(data);
  for (const field of [
    'path',
    'sourceRoot',
    'command',
    'args',
    'workerId',
    'employeeId',
    'execution',
    'provider',
    'model',
    'steps',
    'graph',
    'dependencies',
    'acceptedInputs',
    'resources',
    'permissions',
    'limits',
    'maxSeconds',
    'maxAttempts',
    'workflowId',
    'taskId',
    'runId',
    'direction',
    'approval',
    'autonomy',
  ])
    await rejected({ ...valid, [field]: 'untrusted' });
  for (const projectId of [null, 42, '../project', 'project-missing', 'project-legacy'])
    await rejected({ ...valid, projectId });
  await rejected({ ...valid, dependencies: ['D-001'], acceptedInputs: ['R-001'] });
  for (const headers of [
    {},
    { 'X-Studio-Token': 'wrong' },
    { 'X-Studio-Token': c.token, Origin: 'https://foreign.example' },
  ]) {
    const response = await fetch(c.origin + intakeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(valid),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(intakeRecords(store), before);
    assert.equal(c.app.runner.active.size, 0);
  }
  // Fetch rewrites Host; use node:http to send the forged value on the wire.
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(
      c.origin + intakeUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token, Host: 'foreign.example' },
      },
      response => {
        response.on('error', reject);
        response.on('end', () => resolve(response.statusCode));
        response.resume();
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(valid));
  });
  assert.equal(forgedHostStatus, 403);
  assert.deepEqual(intakeRecords(store), before);
  assert.equal(c.app.runner.active.size, 0);
  assert.equal((await fetch(c.origin + intakeUrl, { headers: { 'X-Studio-Token': c.token } })).status, 403);
  assert.equal((await c.request(intakeUrl, valid, 'PATCH')).status, 404);
  assert.deepEqual(intakeRecords(store), before);
});

test('idea intake requires explicit current enabled defaults, catalogs and a subscription model without expanding configuration', async t => {
  const { c, project } = await intakeProject(t),
    store = c.app.store,
    key = 'project-organization:' + project.id,
    config = store.setting(key),
    org = store.organization(),
    before = intakeRecords(store);
  for (const kind of ['studio-development:checks', 'studio-development:breakdown']) {
    for (const [mutate, error] of [
      [draft => delete draft.kindOwners[kind], /explicit default owner/],
      [draft => (draft.kindOwners[kind] = ''), /explicit default owner/],
      [draft => (draft.kindOwners[kind] = 'W-missing'), /not a project member/],
      [draft => (draft.kindOwners[kind] = 'W-03'), /not a project member/],
    ]) {
      const draft = structuredClone(config);
      mutate(draft);
      store.putSetting(key, draft);
      const response = await c.request(intakeUrl, { projectId: project.id, idea: 'An idea' });
      assert.equal(response.status, 400);
      assert.match(response.data.error, error);
      assert.match(response.data.error, /Edit the teams/);
      assert.deepEqual(store.setting(key), draft);
      assert.deepEqual(intakeRecords(store), before);
      assert.equal(c.app.runner.active.size, 0);
    }
    store.putSetting(key, config);
    const disabled = structuredClone(org);
    disabled.workers.find(worker => worker.id === config.kindOwners[kind]).enabled = false;
    store.setOrganization(disabled);
    const response = await c.request(intakeUrl, { projectId: project.id, idea: 'An idea' });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /disabled.*Enable the employee/);
    assert.deepEqual(intakeRecords(store), before);
    store.setOrganization(org);
  }
  for (const name of ['checks', 'breakdown', 'change', 'change-review']) {
    const kind = 'studio-development:' + name,
      draft = structuredClone(config);
    draft.taskKinds = draft.taskKinds.filter(item => item !== kind);
    delete draft.kindOwners[kind];
    store.putSetting(key, draft);
    const response = await c.request(intakeUrl, { projectId: project.id, idea: 'An idea' });
    assert.equal(response.status, 400);
    assert.ok(response.data.error.includes(kind));
    assert.match(response.data.error, /Enable.*Edit the teams/);
    assert.deepEqual(store.setting(key), draft);
    assert.deepEqual(intakeRecords(store), before);
  }
  store.putSetting(key, config);
  for (const provider of ['mock', 'source-checks', 'not-registered']) {
    const changed = structuredClone(org);
    changed.workers.find(worker => worker.id === config.kindOwners['studio-development:breakdown']).provider = provider;
    store.setOrganization(changed);
    const response = await c.request(intakeUrl, { projectId: project.id, idea: 'An idea' });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /model delivery mode/);
    assert.deepEqual(intakeRecords(store), before);
    assert.equal(c.app.runner.active.size, 0);
  }
  store.setOrganization(org);
  // No configured project catalog: inherited global kinds never count as explicit enablement.
  const other = (await c.request('/api/projects', { name: 'Foreign intake target', goal: '', direction: '' })).data,
    otherBefore = intakeRecords(store),
    response = await c.request(intakeUrl, { projectId: other.id, idea: 'An idea' });
  assert.equal(response.status, 400);
  assert.deepEqual(intakeRecords(store), otherBefore);
  assert.deepEqual(store.setting(key), config);
});

test('idea intake preserves independent global and project pauses and uses the provider-neutral model contract', async t => {
  for (const [globalPause, projectPause, provider] of [
    [true, false, 'codex'],
    [false, true, 'claude'],
    [true, true, 'fixture-subscription'],
  ]) {
    const { c, project } = await intakeProject(t),
      store = c.app.store,
      org = store.organization();
    // An additional model contract proves eligibility does not branch on provider names.
    c.app.runner.adapters.register({ ...codexAdapter, id: 'fixture-subscription', name: 'Fixture subscription model' });
    c.app.runner.adapters.register({
      ...codexAdapter,
      id: 'fixture-unpaid',
      name: 'Fixture non-subscription model',
      subscription: false,
    });
    org.workers.find(worker => worker.id === 'W-01').provider = 'fixture-unpaid';
    store.setOrganization(org);
    const before = intakeRecords(store),
      rejected = await c.request(intakeUrl, { projectId: project.id, idea: 'An idea' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /subscription-authenticated model CLI/);
    assert.deepEqual(intakeRecords(store), before);
    org.workers.find(worker => worker.id === 'W-01').provider = provider;
    store.setOrganization(org);
    assert.equal((await c.request('/api/control', { projectId: project.id, paused: globalPause })).status, 200);
    assert.equal(
      (
        await c.request('/api/pipeline', {
          projectId: project.id,
          action: projectPause ? 'pause' : 'resume',
        })
      ).status,
      200,
    );
    // Trimming is normal String.trim; its bounded value, not padded input length, is measured.
    const idea = '\u00a0 \n' + 'x'.repeat(4000) + '\t\u00a0',
      response = await c.request(intakeUrl, { projectId: project.id, idea });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    await new Promise(resolve => setImmediate(resolve));
    c.app.runner.dispatchQueued();
    assert.equal(store.organization().paused, globalPause);
    assert.equal(store.project(project.id).dispatchPaused, projectPause);
    assert.equal(store.allAttempts().length, 0);
    assert.equal(c.app.runner.active.size, 0);
    assert.ok(response.data.taskIds.every(id => store.task(id).queued));
    assert.ok(response.data.taskIds.every(id => store.task(id).workflowReference.brief === 'x'.repeat(4000)));
    assert.equal(store.task(response.data.taskIds[1]).workerId, 'W-01');
  }
});

test('idea intake retains existing autonomy acceptance while source stories still require director work approval', async t => {
  const { c, project } = await intakeProject(t),
    store = c.app.store;
  measuredIntakeSource(c, t);
  const saved = await c.request(`/api/projects/${project.id}/autonomy`, {
    projectId: project.id,
    expectedRevision: 0,
    enabled: true,
    retries: 0,
    kinds: {
      'studio-development:checks': { approve: 'director', accept: 'auto' },
      'studio-development:breakdown': { approve: 'director', accept: 'auto' },
      'studio-development:change': { approve: 'director', accept: 'auto' },
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const response = await c.request(intakeUrl, { projectId: project.id, idea: 'Retain director story gates.' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.deepEqual(store.setting('project-autonomy:' + project.id), saved.data);
  await c.request('/api/pipeline', { projectId: project.id, action: 'resume' });
  const planned = await c.wait(response.data.taskIds[1], 'done');
  assert.equal(planned.acceptedBy.type, 'policy');
  assert.equal(store.task(response.data.taskIds[0]).status, 'done');
  const stories = store.task(planned.taskId).proposedTaskIds;
  assert.equal(stories.length, 2);
  for (const id of stories) {
    const story = store.task(id);
    assert.equal(story.approval.status, 'pending');
    assert.equal(story.status, 'backlog');
    assert.equal(story.queued, false);
    assert.equal(store.attempts(id).length, 0);
  }
  assert.equal(store.allAttempts().length, 2);
  assert.equal(c.app.runner.autonomy.pendingIntegration(), null);
  assert.deepEqual(store.setting('project-autonomy:' + project.id), saved.data);
});

// 1.0 items 8 and 9: a project with its own repository measures that repository with its own source
// profile, under its own source resources, while Studio desk's resources are held by another story.
test('a project with its own repository checks it with its own profile and source resources', async t => {
  const { c, project } = await intakeProject(t),
    store = c.app.store,
    runner = c.app.runner;
  measuredIntakeSource(c, t);
  const { recordProjectSource, projectSource } = await import('../src/connectors/source-projects.mjs');
  const profile = {
      id: 'field-notes',
      directories: ['lib', 'spec', 'notes'],
      files: ['README.md'],
      extensions: ['js', 'md', 'txt'],
      protectedNames: ['SECRETS.md'],
      contextFiles: ['README.md', 'notes/overview.md'],
      tests: { directory: 'spec', suffix: '.spec.mjs' },
      formatter: null,
      limits: { files: 50, fileBytes: 64 * 1024, totalBytes: 1024 * 1024 },
    },
    root = path.join(c.directory, 'field-notes');
  for (const [file, text] of Object.entries({
    'README.md': '# Field notes\n',
    'lib/notes.js': 'export const notes = [];\n',
    'notes/overview.md': 'How the notes are kept.\n',
    'spec/notes.spec.mjs':
      'import test from "node:test"; import assert from "node:assert/strict"; test("notes", () => assert.equal(2 * 2, 4));\n',
    // Studio desk's folders are outside this profile.
    'src/core/projects.mjs': 'export {};\n',
    'test/ignored.test.mjs': 'throw new Error("Outside the profile; never run.");\n',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Field notes']);
  // Recording a repository checks it; the controller's default source and a taken one are refused.
  assert.throws(
    () => recordProjectSource(store, project.id, { root: 'field-notes', profile }, runner),
    /absolute path/,
  );
  assert.throws(
    () => recordProjectSource(store, project.id, { root: runner.sourceChangeRoot, profile }, runner),
    /controller's default source/,
  );
  assert.throws(
    () => recordProjectSource(store, project.id, { root, profile: { ...profile, formatter: 'prettier' } }, runner),
    /source profile is not valid/,
  );
  assert.throws(
    () => recordProjectSource(store, project.id, { root: path.join(root, 'lib'), profile }, runner),
    /root of its git repository/,
  );
  recordProjectSource(store, project.id, { root, profile }, runner);
  assert.throws(
    () => recordProjectSource(store, 'project-legacy', { root, profile }, runner),
    /already works on this repository/,
  );
  const source = projectSource(store, project.id, runner);
  assert.equal(source.root, fs.realpathSync.native(root));
  assert.deepEqual(source.resources, [`source:${project.id}:integration`, `source:${project.id}:tests`]);
  // A story in this project holds this repository's resources; Studio desk's stay its own.
  const story = { kind: 'studio-development:change', resources: [], projectId: project.id },
    legacy = { kind: 'studio-development:change', resources: [] };
  assert.deepEqual(runner.workflows.requirements(story, { store }).resources, source.resources);
  assert.deepEqual(runner.workflows.requirements(legacy, { store }).resources, [
    'source:studio-desk-integration',
    'source:studio-desk-tests',
  ]);
  assert.deepEqual(runner.integration.resources(story), source.resources);
  // Integrating another repository never pauses or restarts the controller, nor asks for a promotion.
  assert.equal(runner.integration.pauses(story), false);
  assert.equal(runner.integration.pauses(legacy), !!runner.selfHosted);
  assert.equal(runner.integration.controllerSource(story), false);
  // Checks measure this repository's current commit with its profile, while a Studio desk story
  // holds Studio desk's source.
  store.claim(['source:studio-desk-tests', 'source:studio-desk-integration'], 'source-integration:held-by-a-story');
  const task = (
    await c.request('/api/tasks', {
      projectId: project.id,
      title: 'Check the field notes',
      brief: 'Measure the current commit.',
      kind: 'studio-development:checks',
      workerId: 'W-06',
    })
  ).data;
  const started = await c.request(`/api/tasks/${task.id}/start`, { projectId: project.id });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const attempt = await c.wait(task.id);
  assert.equal(attempt.checkExecution.fixture, false);
  assert.equal(attempt.result.checks.find(check => check.name === 'Node test suite').status, 'pass');
  assert.equal(attempt.sourceCheck.root, source.root);
  assert.deepEqual(attempt.sourceCheck.profile, profile);
  assert.deepEqual(
    attempt.sourceCheck.files.map(item => item.path),
    ['lib/notes.js', 'notes/overview.md', 'README.md', 'spec/notes.spec.mjs'],
  );
  assert.deepEqual(attempt.sourceCheck.command.args.slice(-1), ['spec/notes.spec.mjs']);
  const read = name => JSON.parse(fs.readFileSync(path.join(attempt.outputFolder, name), 'utf8'));
  assert.equal(read('check-report.json').totals.pass, 1);
  assert.deepEqual(
    read('source-context.json').documents.map(doc => doc.path),
    ['README.md', 'notes/overview.md'],
  );
  assert.deepEqual(
    store.leases().map(lease => lease.attemptId),
    ['source-integration:held-by-a-story', 'source-integration:held-by-a-story'],
  );
});

// 1.0 step 4b: adding a git repository checks it and runs its tests on a copy of its commit, then
// creates a project with a neutral software team and its own New idea box. A failed check records nothing.
test('adding a project for a git repository checks the repository and its tests before creating it', async t => {
  const c = await setup(t),
    store = c.app.store,
    root = path.join(c.directory, 'site'),
    write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    },
    commit = message => {
      git(root, ['add', '-A']);
      git(root, ['commit', '--quiet', '-m', message]);
    },
    contactTest = expected =>
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isEmail } from '../lib/contact.mjs';\n" +
      `test('a bare name is not an email address', () => assert.equal(isEmail('director'), ${expected}));\n`;
  write('README.md', '# A site\n');
  write('lib/contact.mjs', 'export const isEmail = value => /^[^\\s@]+@[^\\s@]+$/.test(value);\n');
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  commit('A site');
  const before = store.projects().length,
    add = () => c.request('/api/projects', { name: 'Site', repository: { root } });
  // Inspection proposes a profile and records nothing.
  const inspected = await c.request('/api/projects/inspect-repository', { root });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
  assert.deepEqual(inspected.data.problems, []);
  assert.deepEqual(inspected.data.profile.tests, { directory: 'tests', suffix: '.test.mjs' });
  assert.equal(inspected.data.testFiles, 0);
  assert.equal(store.projects().length, before);
  // A failing test refuses the repository, naming the test, and records nothing.
  write('tests/contact.test.mjs', contactTest(true));
  commit('A failing test');
  let refused = await add();
  assert.equal(refused.status, 400);
  assert.match(
    refused.data.error,
    /tests must pass before it is added: 0 of 1 passed \(failing: a bare name is not an email address\)/,
  );
  // And it says what to do next.
  assert.match(refused.data.error, /otherwise fix the failing tests, commit, then create the project again\.$/);
  // So does an uncommitted edit: stories start from a clean tree.
  write('tests/contact.test.mjs', contactTest(false));
  refused = await add();
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Commit or stash the tracked changes first/);
  assert.equal(store.projects().length, before);
  commit('Fix the test');
  const created = await add();
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.tests.tests, 1);
  assert.equal(created.data.tests.pass, 1);
  const project = store.project(created.data.id);
  assert.equal(project.source.root, fs.realpathSync.native(root));
  assert.deepEqual(project.source.profile, {
    ...inspected.data.profile,
    tests: { directory: 'tests', suffix: '.test.mjs' },
  });
  const config = store.setting('project-organization:' + project.id);
  assert.deepEqual(config.taskKinds.slice().sort(), [
    'general',
    'studio-development:breakdown',
    'studio-development:change',
    'studio-development:change-review',
    'studio-development:checks',
  ]);
  // Its published instructions are generic: none of them is about Studio desk.
  assert.doesNotMatch(JSON.stringify(config.instructions), /Studio desk|orchestration/i);
  assert.match(
    store.events().at(-1).message,
    /^Project created: Site, working on .+site \(main\); its tests on [0-9a-f]{7}: 1\/1 tests passed\.$/,
  );
  // The same repository cannot be added twice.
  refused = await c.request('/api/projects', { name: 'Site again', repository: { root } });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Site already works on this repository/);
  // The project takes ideas through its own New idea box (dispatch paused: nothing runs here). Its
  // product owner needs a model CLI, as Studio desk's does (here the Codex protocol fixture).
  assert.equal((await c.request('/api/control', { paused: true })).status, 200);
  const org = store.organization();
  for (const id of ['W-01', 'W-02']) org.workers.find(worker => worker.id === id).provider = 'codex';
  store.setOrganization(org);
  const idea = await c.request('/api/studio-development/intake', {
    projectId: project.id,
    idea: 'Accept plus signs in email addresses.',
  });
  assert.equal(idea.status, 201, JSON.stringify(idea.data));
  assert.deepEqual(
    idea.data.taskIds.map(id => store.task(id).kind),
    ['studio-development:checks', 'studio-development:breakdown'],
  );
});

// The dashboard's folder browser reads folder names only through the protected API: a POST with the request
// token, so a page without the dashboard's token cannot read them.
test('the folder list answers the dashboard with its request token and nothing else', async t => {
  const c = await setup(t),
    folder = path.join(c.directory, 'folders');
  fs.mkdirSync(path.join(folder, 'site', '.git'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'Notes'));
  fs.mkdirSync(path.join(folder, '.cache'));
  fs.writeFileSync(path.join(folder, 'readme.txt'), 'A file is never listed.\n');
  const real = fs.realpathSync.native(folder),
    listed = await c.request('/api/folders', { path: folder });
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(listed.data.path, real);
  assert.equal(listed.data.parent, path.dirname(real));
  assert.deepEqual(listed.data.folders, [
    { name: 'Notes', path: path.join(real, 'Notes'), repository: false },
    { name: 'site', path: path.join(real, 'site'), repository: true },
  ]);
  assert.equal(listed.data.limited, false);
  const without = await fetch(c.origin + '/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folder }),
  });
  assert.equal(without.status, 403);
  assert.equal((await without.json()).folders, undefined);
  const extra = await c.request('/api/folders', { path: folder, root: folder });
  assert.equal(extra.status, 400);
  assert.equal(extra.data.error, 'The folder list accepts only an optional path and nearest.');
  const relative = await c.request('/api/folders', { path: 'folders' });
  assert.equal(relative.status, 400);
  assert.equal(relative.data.error, 'Choose an absolute folder path.');
  // With nearest, a folder that does not exist lists the nearest folder above it; without, it is refused.
  const missing = path.join(folder, 'missing'),
    nearest = await c.request('/api/folders', { path: missing, nearest: true });
  assert.equal(nearest.status, 200, JSON.stringify(nearest.data));
  assert.equal(nearest.data.path, real);
  for (const body of [{ path: missing }, { path: missing, nearest: false }]) {
    const refused = await c.request('/api/folders', body);
    assert.equal(refused.status, 400);
    assert.equal(refused.data.error, 'The folder does not exist.');
  }
  for (const value of ['true', 1, null]) {
    const unclear = await c.request('/api/folders', { path: missing, nearest: value });
    assert.equal(unclear.status, 400);
    assert.equal(unclear.data.error, 'Nearest must be true or false.');
  }
  // GET is not offered, even with the token.
  const read = await fetch(c.origin + '/api/folders?path=' + encodeURIComponent(folder), {
    headers: { 'X-Studio-Token': c.token },
  });
  assert.equal(read.status, 403);
  assert.equal((await read.json()).folders, undefined);
});
