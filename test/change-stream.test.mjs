// The dashboard receives only what changed (Decision MP-026, v1.0 item 19). On October 21, 2026
// every recorded event, including each line of an agent's output, told every tab to refetch the
// whole 1.98 MB state, and a 2-second poll downloaded it again even when nothing had changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './studio-setup.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Reads one event stream as the browser's EventSource would, keeping each named event.
async function open(origin, query = '', headers = {}) {
  const controller = new AbortController(),
    response = await fetch(origin + '/api/events' + query, { headers, signal: controller.signal });
  if (!response.ok) return { status: response.status, error: (await response.json()).error };
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    events = [];
  let buffer = '';
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const fields = {};
          for (const line of buffer.slice(0, end).split('\n')) {
            if (line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          buffer = buffer.slice(end + 2);
          if (fields.event) events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data) });
        }
      }
    } catch {
      // Aborted when the test closes the stream.
    }
  })();
  return {
    status: response.status,
    events,
    named: name => events.filter(event => event.event === name),
    close: () => controller.abort(),
  };
}

async function controller(t) {
  const c = await setup(t),
    store = c.app.store;
  // Attempt records are enough for a watch; their tasks need not exist.
  for (const [id, projectId] of [
    ['attempt-watch-a', undefined],
    ['attempt-watch-b', undefined],
    ['attempt-watch-other', 'project-other'],
  ])
    store.insertAttempt({ id, taskId: 'T-watch', ...(projectId ? { projectId } : {}), status: 'running' }, {});
  // Let the throttled change event for these writes go out before any test opens a stream.
  await pause(300);
  const streams = [];
  const watch = async (...args) => {
    const stream = await open(c.origin, ...args);
    if (stream.close) streams.push(stream);
    return stream;
  };
  t.after(() => streams.forEach(stream => stream.close()));
  return { ...c, store, watch };
}

test('every write raises the version and notifies; a log line changes neither and wakes neither the scheduler nor other tabs', async t => {
  const { store, app } = await controller(t),
    calls = { change: 0, schedule: 0, events: [], changes: [] },
    notify = store.onChange,
    forward = store.onEvent,
    schedule = app.runner.schedule.bind(app.runner);
  store.onChange = change => {
    calls.change++;
    calls.changes.push(change);
    notify(change);
  };
  store.onEvent = event => {
    calls.events.push(event);
    forward(event);
  };
  app.runner.schedule = () => {
    calls.schedule++;
    schedule();
  };
  const step = (label, write, changes) => {
    const before = { version: store.version, change: calls.change, schedule: calls.schedule };
    write();
    assert.equal(store.version - before.version, changes, `${label} raises the version ${changes} time(s)`);
    assert.equal(calls.change - before.change, changes, `${label} notifies ${changes} time(s)`);
    assert.equal(calls.schedule - before.schedule, changes, `${label} runs the scheduler ${changes} time(s)`);
  };
  const task = store.tasks()[0];
  step('a setting', () => store.putSetting('change-stream-test', { value: 1 }), 1);
  step('a task', () => store.putTask(task), 1);
  step('the organization', () => store.setOrganization(store.organization()), 1);
  step('an attempt', () => store.updateAttempt(store.attempt('attempt-watch-a')), 1);
  step('a claim', () => store.claim(['local:change-stream'], 'attempt-watch-a'), 1);
  step('a release', () => store.release('attempt-watch-a'), 1);
  step('a recorded event', () => store.event('note', 'T-watch', 'attempt-watch-a', 'Something happened.'), 1);
  step('a log line', () => store.event('log', 'T-watch', 'attempt-watch-a', 'stdout: working'), 0);
  const versionBefore = store.version;
  store.release('attempt-watch-a');
  assert.equal(store.version, versionBefore, 'releasing nothing is not a change');
  assert.deepEqual(
    calls.events.map(event => [event.kind, event.attempt_id, event.message]),
    [
      ['note', 'attempt-watch-a', 'Something happened.'],
      ['log', 'attempt-watch-a', 'stdout: working'],
    ],
  );
  assert.ok(calls.events.every(event => Number.isSafeInteger(event.seq) && event.time && event.task_id === 'T-watch'));
  // Each change names its record and project, numbered by the version it raised.
  const noteSeq = calls.events[0].seq;
  assert.deepEqual(
    calls.changes.map(({ seq, ...change }) => change),
    [
      { type: 'setting', id: 'change-stream-test' },
      { type: 'task', id: task.id, projectId: 'project-legacy' },
      { type: 'organization' },
      { type: 'attempt', id: 'attempt-watch-a', taskId: 'T-watch', projectId: 'project-legacy' },
      { type: 'leases' },
      { type: 'leases' },
      { type: 'event', id: noteSeq, kind: 'note', taskId: 'T-watch', attemptId: 'attempt-watch-a', projectId: null },
    ],
  );
  assert.deepEqual(
    calls.changes.map(change => change.seq),
    calls.changes.map((change, index) => calls.changes[0].seq + index),
  );
});

test("settings name runs, workflows and their project; an event takes its task's project", async t => {
  const { store } = await controller(t),
    changes = [],
    notify = store.onChange;
  store.onChange = change => {
    changes.push(change);
    notify(change);
  };
  const task = store.tasks()[0];
  store.putSetting('run:run-1', { id: 'run-1', projectId: 'project-other' });
  store.putSetting('workflow:flow-1', { id: 'flow-1', projectId: 'project-other' });
  store.putSetting('project-organization:project-other', {});
  store.putSetting('projects', store.projects());
  store.event('note', task.id, null, 'A recorded step for a real task.');
  store.event('note', null, null, 'A step recorded for another project.', 'project-other');
  assert.deepEqual(
    changes.map(({ seq, ...change }) => change),
    [
      { type: 'run', id: 'run-1', projectId: 'project-other' },
      { type: 'workflow', id: 'flow-1', projectId: 'project-other' },
      { type: 'setting', id: 'project-organization:project-other', projectId: 'project-other' },
      { type: 'projects', id: 'projects' },
      { type: 'event', id: changes[4].id, kind: 'note', taskId: task.id, projectId: 'project-legacy' },
      { type: 'event', id: changes[5].id, kind: 'note', projectId: 'project-other' },
    ],
  );
  assert.equal(store.setting('event-project:' + changes[5].id), 'project-other', 'The event keeps its project.');
});

test('the compact state answers an unchanged tag with an empty 304; other state reads are never stored', async t => {
  const { origin, store } = await controller(t),
    url = origin + '/api/state?mode=dashboard';
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const tag = first.headers.get('etag');
  assert.match(tag, /^"[0-9a-f]{12}-\d+-project-legacy"$/);
  assert.ok(Array.isArray((await first.json()).tasks));
  for (const attempt of [1, 2]) {
    const again = await fetch(url, { headers: { 'If-None-Match': tag } });
    assert.equal(again.status, 304, `unchanged read ${attempt}: building the compact state writes nothing`);
    assert.equal(await again.text(), '');
    assert.equal(again.headers.get('etag'), tag);
  }
  store.putSetting('change-stream-test', { value: 2 });
  const changed = await fetch(url, { headers: { 'If-None-Match': tag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), tag);
  await changed.arrayBuffer();
  // Agent output is left out of the compact state, so a running agent's lines leave its tag valid,
  // while a recorded step for the same task is a new version that lists it.
  const current = changed.headers.get('etag'),
    taskId = store.tasks()[0].id;
  store.event('log', taskId, 'attempt-watch-a', 'stdout: still working');
  const logged = await fetch(url, { headers: { 'If-None-Match': current } });
  assert.equal(logged.status, 304);
  store.event('note', taskId, 'attempt-watch-a', 'A recorded step.');
  const stepped = await fetch(url, { headers: { 'If-None-Match': current } });
  assert.equal(stepped.status, 200);
  const events = (await stepped.json()).events;
  assert.ok(events.some(event => event.message === 'A recorded step.'));
  assert.ok(!events.some(event => event.kind === 'log'));
  const full = await (await fetch(origin + '/api/state')).json();
  assert.ok(
    full.events.some(event => event.message === 'stdout: still working'),
    'the full state keeps them',
  );
  for (const other of ['/api/state', '/api/export']) {
    const response = await fetch(origin + other, { headers: { 'If-None-Match': tag } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
    await response.arrayBuffer();
  }
});

// The dashboard's built files are named by their content and kept (next-dashboard.test.mjs); the theme script
// it loads first is revalidated by content.
test('the theme script is revalidated by content; the page with its request token is never stored', async t => {
  const { origin } = await controller(t);
  for (const file of ['/theme.js']) {
    const first = await fetch(origin + file);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    assert.match(first.headers.get('content-security-policy'), /script-src 'self'/);
    const tag = first.headers.get('etag');
    assert.match(tag, /^"[0-9a-f]{64}"$/);
    await first.arrayBuffer();
    const again = await fetch(origin + file, { headers: { 'If-None-Match': tag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
  }
  const page = await fetch(origin + '/');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('etag'), null);
  assert.match(await page.text(), /name="studio-token" content="[0-9a-f]{48}"/);
});

test("an attempt's events reach only the tabs watching it, and a log line is no change event for any tab", async t => {
  const { store, watch, until } = await controller(t);
  const plain = await watch(),
    watchingA = await watch('?log=attempt-watch-a'),
    watchingB = await watch('?projectId=project-legacy&log=attempt-watch-b');
  for (const stream of [plain, watchingA, watchingB]) {
    assert.equal(stream.status, 200);
    await until(() => stream.named('change').length === 1, 'the connection change event');
    assert.equal(stream.named('change')[0].data.version, store.version);
  }
  store.event('log', 'T-watch', 'attempt-watch-a', 'stdout: line for a');
  await until(() => watchingA.named('log').length === 1, 'the watched line');
  const [line] = watchingA.named('log');
  assert.equal(line.data.message, 'stdout: line for a');
  assert.equal(line.data.attempt_id, 'attempt-watch-a');
  assert.equal(line.id, String(line.data.seq));
  await pause(400);
  assert.equal(watchingB.named('log').length, 0, "another attempt's watcher gets nothing");
  assert.equal(plain.named('log').length, 0, 'a tab watching no log gets no lines');
  for (const stream of [plain, watchingA, watchingB])
    assert.equal(stream.named('change').length, 1, 'a log line is not a change event');
  store.event('note', 'T-watch', 'attempt-watch-a', 'A recorded step.');
  await until(() => plain.named('change').length === 2, 'the change event for a recorded step');
  await until(() => watchingA.named('log').length === 2, "the recorded step on its attempt's stream");
  assert.equal(watchingA.named('log')[1].data.kind, 'note');
  assert.equal(watchingB.named('log').length, 0);
});

test('a watch is refused for an attempt of another project, beyond four attempts or with a malformed resume point', async t => {
  const { watch } = await controller(t);
  const other = await watch('?log=attempt-watch-other');
  assert.equal(other.status, 400);
  assert.match(other.error, /another project/);
  const missing = await watch('?log=attempt-missing');
  assert.equal(missing.status, 400);
  assert.match(missing.error, /Attempt not found/);
  const many = await watch('?' + Array.from({ length: 5 }, () => 'log=attempt-watch-a').join('&'));
  assert.equal(many.status, 400);
  assert.match(many.error, /at most four/);
  for (const resume of ['-1', '1.5', 'x'.repeat(3)]) {
    const malformed = await watch('?log=attempt-watch-a', { 'Last-Event-ID': resume });
    assert.equal(malformed.status, 400, resume);
    assert.match(malformed.error, /resume point/);
  }
});

test("a reconnecting tab resumes an attempt's events after the last one it received, in order", async t => {
  const { store, watch, until } = await controller(t);
  const seq = () => store.db.prepare('SELECT MAX(seq) AS seq FROM events').get().seq;
  store.event('log', 'T-watch', 'attempt-watch-a', 'stdout: one');
  const received = seq();
  store.event('log', 'T-watch', 'attempt-watch-b', 'stdout: other attempt');
  store.event('log', 'T-watch', 'attempt-watch-a', 'stdout: two');
  store.event('phase', 'T-watch', 'attempt-watch-a', JSON.stringify({ boundary: 'start' }));
  const resumed = await watch('?log=attempt-watch-a', { 'Last-Event-ID': String(received) });
  await until(() => resumed.named('log').length === 2, 'the missed events');
  assert.deepEqual(
    resumed.named('log').map(event => [event.data.kind, event.data.message]),
    [
      ['log', 'stdout: two'],
      ['phase', '{"boundary":"start"}'],
    ],
  );
  store.event('log', 'T-watch', 'attempt-watch-a', 'stdout: three');
  await until(() => resumed.named('log').length === 3, 'the next live line');
  assert.equal(resumed.named('log')[2].data.message, 'stdout: three');
  const fresh = await watch('?log=attempt-watch-a');
  await pause(200);
  assert.equal(fresh.named('log').length, 0, 'a new watch without a resume point starts from now');
});

test('a burst of writes reaches each tab as at most two change events, the last carrying the final version', async t => {
  const { store, watch, until } = await controller(t);
  const stream = await watch();
  await until(() => stream.named('change').length === 1, 'the connection change event');
  for (let index = 0; index < 50; index++) store.putSetting('change-stream-burst', { index });
  await pause(600);
  const changes = stream.named('change').slice(1);
  assert.ok(changes.length >= 1 && changes.length <= 2, `${changes.length} change events for 50 writes`);
  assert.equal(changes.at(-1).data.version, store.version);
});

test("a tab's change events name only its project's records and the shared ones, and a tab catches up after a reconnect", async t => {
  const { store, watch, until, origin } = await controller(t);
  const legacy = await watch();
  await until(() => legacy.named('change').length === 1, 'the connection change event');
  const { version, start } = legacy.named('change')[0].data;
  assert.match(start, /^[0-9a-f]{12}$/);
  store.putTask({ ...store.tasks()[0], id: 'T-elsewhere', projectId: 'project-other' });
  await pause(400);
  assert.equal(legacy.named('change').length, 1, "Another project's task is not this tab's change.");
  const task = store.tasks()[0];
  store.putTask(task);
  store.putSetting('change-stream-shared', { value: true });
  // The two writes arrive in one event or two, as the throttle's timing falls (batching has its own test).
  const heard = () =>
    legacy
      .named('change')
      .slice(1)
      .flatMap(event => event.data.changes);
  await until(() => heard().some(change => change.id === 'change-stream-shared'), 'the change events');
  assert.deepEqual(
    heard().map(change => [change.type, change.id]),
    [
      ['task', task.id],
      ['setting', 'change-stream-shared'],
    ],
  );
  assert.equal(legacy.named('change').at(-1).data.version, store.version);
  // A reconnecting tab asks what it missed since the last change it saw.
  const missed = await (await fetch(`${origin}/api/changes?after=${version}&start=${start}`)).json();
  assert.deepEqual(
    missed.changes.map(change => change.id),
    [task.id, 'change-stream-shared'],
    "Another project's change is left out here too.",
  );
  const current = await (await fetch(`${origin}/api/changes?after=${store.version}&start=${start}`)).json();
  assert.deepEqual(current, { start, version: store.version, changes: [] });
  // The list cannot answer for another start, a time before its oldest change, or the future.
  for (const query of [
    `after=${version}&start=000000000000`,
    `after=0&start=${start}`,
    `after=${store.version + 1}&start=${start}`,
  ])
    assert.deepEqual(await (await fetch(`${origin}/api/changes?${query}`)).json(), {
      start,
      version: store.version,
      reload: true,
    });
  assert.equal((await fetch(`${origin}/api/changes?after=x`)).status, 400);
});

test("a task's page reads that task and its attempt summaries, from its own project only", async t => {
  const { store, origin } = await controller(t);
  const task = store.tasks()[0];
  store.insertAttempt(
    { id: 'attempt-page', taskId: task.id, status: 'review', instructions: { text: 'x'.repeat(5000) } },
    {
      text: 'Composed instructions are never part of a summary.',
    },
  );
  const page = await fetch(`${origin}/api/tasks/${task.id}`);
  assert.equal(page.status, 200);
  const body = await page.json();
  assert.equal(body.task.id, task.id);
  assert.deepEqual(body.task.directorInputs, []);
  assert.deepEqual(
    body.attempts.map(attempt => attempt.id),
    ['attempt-page'],
  );
  assert.equal(JSON.stringify(body).includes('Composed instructions'), false);
  assert.equal((await fetch(`${origin}/api/tasks/T-missing`)).status, 404);
  store.putTask({ ...task, id: 'T-elsewhere', projectId: 'project-other' });
  const foreign = await fetch(`${origin}/api/tasks/T-elsewhere`);
  assert.equal(foreign.status, 400);
  assert.match((await foreign.json()).error, /another project/);
});
