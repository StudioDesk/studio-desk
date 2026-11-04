// The director's tool reads and changes through the controller (1.4, tools, step 3): GET /api/tools and /api/tools/:id,
// POST /api/tools, PATCH /api/tools/:id, POST /api/tools/:id/retire and POST /api/tools/:id/key, studio-wide and the
// director's alone. An agent's attempt token opens none of them, and each change reaches every tab's change list as
// { type: 'tool', id, revision }. Model-free: the commands name a program no computer has, so whether one is found
// never depends on it, and every studio keeps tools' keys in an in-memory stand-in credential store, never this
// computer's own (test/model-free-studio.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { setup } from './studio-setup.mjs';
import { createStudio, standInToolKeys } from './model-free-studio.mjs';
import { closeAndRemove } from './fixture-cleanup.mjs';
import { employeeTestsAllowed } from '../src/connectors/employee-tests.mjs';

const plain = { directorKey: false };
const limits = { callsPerHour: 60, callsPerAttempt: 10, timeoutSeconds: 30, maxResponseBytes: 1024 * 1024 };
const getFrom = 'Install it with winget install studio-desk-fixture-encoder.';
const command = (fields = {}) => ({
  name: '  Video encoder ',
  purpose: 'Cuts and encodes the launch video.',
  kind: 'command',
  rules: 'Write only into the attempt folder.',
  program: 'studio-desk-fixture-encoder',
  getFrom,
  limits,
  ...fields,
});
const studioCall = (fields = {}) => ({
  name: 'Issue tracker',
  purpose: 'Reads the issues a story names.',
  kind: 'studio-call',
  rules: 'Read only the issues the brief names.',
  address: 'https://tracker.example.com/api/',
  operations: [{ name: 'read-issue', method: 'GET', path: '/issues/{id}', arguments: ['id'], required: ['id'] }],
  limits,
  ...fields,
});
const toolId = /^tool-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unknownId = 'tool-00000000-0000-4000-8000-000000000000';
// The fields core/tools.mjs refuses as a key's; a read carries only `key`: { set: false }, or exactly
// { set: true, setAt, lastFour } once a key is set.
const keyLike = /key|secret|token|password|passwd|credential|auth|header|cookie/i;

// A request to a started studio, answered with its status, text and JSON. A command carries the page's request token
// unless `token` is false, and acts as the dashboard does (signed in by the session cookie, test/model-free-studio.mjs);
// a read acts as a local tool does, with the key. `init` replaces either, for the refusals.
async function call(c, method, route, body, { token = true, headers = {}, ...init } = {}) {
  const response = await fetch(c.origin + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token && method !== 'GET' ? { 'X-Studio-Token': c.token } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...init,
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // A page, not JSON.
  }
  return { status: response.status, text, data };
}
const add = (c, input, options) => call(c, 'POST', '/api/tools', input, options);
const change = (c, id, input, options) => call(c, 'PATCH', `/api/tools/${id}`, input, options);
const retire = (c, id, input, options) => call(c, 'POST', `/api/tools/${id}/retire`, input, options);
const list = (c, options) => call(c, 'GET', '/api/tools', undefined, options);
const one = (c, id, options) => call(c, 'GET', `/api/tools/${id}`, undefined, options);

// This start's ID, which a tab sends with what it last saw.
const startOf = async c => (await (await fetch(`${c.origin}/api/changes?after=0`)).json()).start;

// No answer holds a key field other than a tool's `key`, which reads as not set or as set with when and its last four
// characters, and none holds the director's key.
function assertNoKey(c, answer, where) {
  assert.ok(!answer.text.includes(c.app.directorKey), `${where} holds the director's key`);
  const walk = (value, at) => {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${at}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [field, inner] of Object.entries(value)) {
      if (field === 'key') {
        if (inner?.set === true) {
          assert.deepEqual(Object.keys(inner).sort(), ['lastFour', 'set', 'setAt'], `${at}.key`);
          assert.equal(new Date(inner.setAt).toISOString(), inner.setAt, `${at}.key.setAt`);
          assert.equal([...inner.lastFour].length, 4, `${at}.key.lastFour`);
        } else assert.deepEqual(inner, { set: false }, `${at}.key`);
        continue;
      }
      assert.doesNotMatch(field, keyLike, `${at}.${field}`);
      walk(inner, `${at}.${field}`);
    }
  };
  walk(answer.data, where);
}

test('the director adds a command and a studio call and reads them back, each with its actions and key not set', async t => {
  const c = await setup(t);
  assert.deepEqual((await list(c)).data, { tools: [] });

  const encoder = await add(c, command());
  assert.equal(encoder.status, 201, encoder.text);
  const { tool: added } = encoder.data;
  assert.match(added.id, toolId);
  assert.equal(added.name, 'Video encoder');
  assert.equal(added.kind, 'command');
  assert.equal(added.program, 'studio-desk-fixture-encoder');
  assert.deepEqual(added.limits, limits);
  assert.equal(added.revision, 1);
  assert.equal(added.retiredAt, null);
  assert.deepEqual(added.key, { set: false });
  assert.deepEqual(added.availability, { state: 'missing', getFrom });
  assert.deepEqual(added.actions, ['change', 'retire', 'set-key']);
  assert.equal(added.by, 'director');

  // An ID in the input is not the director's to choose: the controller names every tool.
  const tracker = await add(c, { ...studioCall(), id: unknownId });
  assert.equal(tracker.status, 201, tracker.text);
  const { tool: issues } = tracker.data;
  assert.match(issues.id, toolId);
  assert.notEqual(issues.id, unknownId);
  assert.equal(issues.kind, 'studio-call');
  assert.equal(issues.address, 'https://tracker.example.com/api');
  assert.deepEqual(issues.operations, studioCall().operations);
  assert.equal(issues.availability, null, 'A studio call has no program to find.');
  assert.deepEqual(issues.key, { set: false });
  assert.deepEqual(issues.actions, ['change', 'retire', 'set-key']);

  const listed = await list(c);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data, { tools: [added, issues] }, 'The list holds both, in the order they were added.');
  for (const tool of [added, issues]) {
    const read = await one(c, tool.id);
    assert.equal(read.status, 200);
    assert.deepEqual(read.data, { tool });
    assertNoKey(c, read, `GET /api/tools/${tool.id}`);
  }
  for (const [answer, where] of [
    [encoder, 'the command added'],
    [tracker, 'the studio call added'],
    [listed, 'the list'],
  ])
    assertNoKey(c, answer, where);
  assert.equal(c.app.store.tools().length, 2);

  // A tool the studio does not have, an ID the controller would never make, and a command asked for with GET.
  for (const route of [`/api/tools/${unknownId}`, '/api/tools/not-a-tool', '/api/tools/tool-..']) {
    const missing = await call(c, 'GET', route);
    assert.equal(missing.status, 404, route);
    assert.equal(missing.data.error, 'Tool not found.', route);
  }
  const asRead = await call(c, 'GET', `/api/tools/${added.id}/retire`);
  assert.equal(asRead.status, 404);
  assert.match(asRead.data.error, /Unknown read route/);
});

test('an invalid tool is refused with 400 and nothing is recorded', async t => {
  const c = await setup(t);
  const before = c.app.store.version;
  for (const [input, message] of [
    [studioCall({ address: 'http://tracker.example.com' }), /must start with https:\/\//],
    [studioCall({ address: 'https://name:secret@tracker.example.com' }), /never carries a user name or password/],
    [command({ program: 'ffmpeg; rm -rf ~' }), /Name one program/],
    [command({ program: 'ffmpeg -i in.mp4' }), /Name one program/],
    [command({ apiKey: 'sk-fixture' }), /never holds a key/],
    [command({ headers: { Authorization: 'Bearer fixture' } }), /never holds a key/],
    [command({ projectId: 'project-legacy' }), /leave out "projectId"/],
    [command({ limits: { ...limits, callsPerHour: 0 } }), /Calls per hour must be a whole number/],
    [{ ...command(), address: 'https://tracker.example.com' }, /A command names a program/],
    [[command()], /JSON object/],
  ]) {
    const refused = await add(c, input);
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.data.error, message);
    assert.ok(
      !refused.text.includes('sk-fixture') && !refused.text.includes('secret@'),
      'A refusal repeats no secret.',
    );
  }
  assert.deepEqual(c.app.store.tools(), []);
  assert.deepEqual((await list(c)).data, { tools: [] });
  const missed = await (await fetch(`${c.origin}/api/changes?after=${before}&start=${await startOf(c)}`)).json();
  assert.equal(missed.reload, undefined);
  assert.ok(!missed.changes.some(item => item.type === 'tool'), 'No tool change went on the change stream.');
});

test('a change names the current revision; a stale one, or any change once retired, is refused with 409', async t => {
  const c = await setup(t);
  const { tool: added } = (await add(c, command())).data;

  const changed = await change(c, added.id, { expectedRevision: 1, ...command({ purpose: 'Encodes the trailer.' }) });
  assert.equal(changed.status, 200, changed.text);
  const { tool } = changed.data;
  assert.equal(tool.id, added.id);
  assert.equal(tool.revision, 2);
  assert.equal(tool.purpose, 'Encodes the trailer.');
  assert.equal(tool.createdAt, added.createdAt);
  assert.deepEqual(tool.actions, ['change', 'retire', 'set-key']);
  assertNoKey(c, changed, 'the change');

  // A change from someone who last read revision 1 would overwrite revision 2 unseen.
  const stale = await change(c, added.id, { expectedRevision: 1, ...command({ purpose: 'Older purpose.' }) });
  assert.equal(stale.status, 409, stale.text);
  assert.match(stale.data.error, /Tool changed\. Refresh before saving\./);
  // A change must name its revision as a whole number, and its record must pass the checks.
  for (const [input, message] of [
    [command(), /expectedRevision/],
    [{ expectedRevision: '2', ...command() }, /expectedRevision must be a whole number/],
    [{ expectedRevision: 2, ...command({ program: 'bash -c ls' }) }, /Name one program/],
    [{ expectedRevision: 2, ...command({ secret: 'x' }) }, /never holds a key/],
  ]) {
    const refused = await change(c, added.id, input);
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.data.error, message);
  }
  assert.deepEqual((await one(c, added.id)).data, { tool }, 'Nothing refused changed the tool.');
  assert.equal((await change(c, unknownId, { expectedRevision: 1, ...command() })).status, 404);
  assert.equal((await change(c, 'not-a-tool', { expectedRevision: 1, ...command() })).status, 404);

  // There is no delete, and no other tool command.
  const deleted = await call(c, 'DELETE', `/api/tools/${added.id}`);
  assert.equal(deleted.status, 405);
  assert.equal((await call(c, 'POST', `/api/tools/${added.id}`, { expectedRevision: 2 })).status, 404);
  assert.equal((await call(c, 'PATCH', '/api/tools', command())).status, 404);
  assert.deepEqual((await one(c, added.id)).data, { tool }, 'DELETE changed nothing.');

  // Retiring names the revision too, and takes nothing else.
  assert.equal((await retire(c, added.id, { expectedRevision: 1 })).status, 409);
  const extra = await retire(c, added.id, { expectedRevision: 2, reason: 'Replaced.' });
  assert.equal(extra.status, 400);
  assert.match(extra.data.error, /takes only expectedRevision/);
  assert.equal((await retire(c, added.id, {})).status, 400);
  const retired = await retire(c, added.id, { expectedRevision: 2 });
  assert.equal(retired.status, 200, retired.text);
  assert.equal(retired.data.tool.revision, 3);
  assert.equal(typeof retired.data.tool.retiredAt, 'string');
  assert.deepEqual(retired.data.tool.actions, [], 'A retired tool takes no action.');
  assert.equal(retired.data.tool.purpose, 'Encodes the trailer.');

  // Retiring keeps the tool, in the list as on its own.
  const { tools } = (await list(c)).data;
  assert.deepEqual(tools, [retired.data.tool]);
  const afterwards = await change(c, added.id, { expectedRevision: 3, ...command() });
  assert.equal(afterwards.status, 409);
  assert.match(afterwards.data.error, /retired, so it cannot be changed/);
  const again = await retire(c, added.id, { expectedRevision: 3 });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already retired/);
  assert.equal((await call(c, 'DELETE', `/api/tools/${added.id}`)).status, 405);
  assert.deepEqual((await one(c, added.id)).data, { tool: retired.data.tool });
  assert.equal(c.app.store.tools().length, 1);
});

test("only the director reads and changes tools: 401 without the session or key, and the session's change needs the token", async t => {
  const c = await setup(t);
  const { tool } = (await add(c, command())).data;
  const unchanged = () =>
    assert.deepEqual(
      c.app.store.tools().map(item => [item.id, item.revision]),
      [[tool.id, 1]],
    );

  // Neither the session nor the key: no read and no change, even with this start's request token.
  for (const answer of [
    await list(c, plain),
    await one(c, tool.id, plain),
    await add(c, studioCall(), plain),
    await change(c, tool.id, { expectedRevision: 1, ...command({ purpose: 'Unsigned.' }) }, plain),
    await retire(c, tool.id, { expectedRevision: 1 }, plain),
  ]) {
    assert.equal(answer.status, 401, answer.text);
    assert.match(answer.data.error, /launch/);
  }
  unchanged();

  // Signed in by the session cookie, as the dashboard is: reads need nothing more, a change needs the request token.
  const cookie = (await fetch(c.app.launchUrl, { ...plain, redirect: 'manual' })).headers
    .get('set-cookie')
    .split(';')[0];
  const session = { ...plain, token: false, headers: { cookie } };
  assert.equal((await list(c, session)).status, 200);
  assert.equal((await one(c, tool.id, session)).status, 200);
  for (const answer of [
    await add(c, studioCall(), session),
    await change(c, tool.id, { expectedRevision: 1, ...command({ purpose: 'No token.' }) }, session),
    await retire(c, tool.id, { expectedRevision: 1 }, session),
  ]) {
    assert.equal(answer.status, 403, answer.text);
    assert.match(answer.data.error, /X-Studio-Token/);
  }
  unchanged();

  // The director's key in its header needs no token, and leaves a line for each command in the activity.
  const keyed = { ...plain, token: false, headers: { 'x-studio-key': c.app.directorKey } };
  const keyedAdd = await add(c, studioCall(), keyed);
  assert.equal(keyedAdd.status, 201, keyedAdd.text);
  const keyedChange = await change(c, tool.id, { expectedRevision: 1, ...command({ purpose: 'Keyed.' }) }, keyed);
  assert.equal(keyedChange.status, 200, keyedChange.text);
  assert.equal(keyedChange.data.tool.revision, 2);
  const keyedRetire = await retire(c, tool.id, { expectedRevision: 2 }, keyed);
  assert.equal(keyedRetire.status, 200, keyedRetire.text);
  for (const answer of [keyedAdd, keyedChange, keyedRetire]) assertNoKey(c, answer, 'a keyed command');
  assert.deepEqual(
    c.app.store.db
      .prepare("SELECT message FROM events WHERE kind='director_key' ORDER BY seq")
      .all()
      .map(row => row.message),
    [
      "A local tool sent POST /api/tools with the director's key.",
      `A local tool sent PATCH /api/tools/${tool.id} with the director's key.`,
      `A local tool sent POST /api/tools/${tool.id}/retire with the director's key.`,
    ],
  );
});

test("an attempt's test token can neither read nor change a tool", async t => {
  const c = await setup(t);
  const { tool } = (await add(c, command())).data;
  // A live token, as an editing agent holds while its CLI runs (connectors/employee-tests.mjs); it authorizes only
  // that attempt's own test run.
  const attemptId = 'attempt-tool-routes',
    token = 'a'.repeat(64),
    entry = { attempt: { id: attemptId, taskId: 'T-tool-routes' }, employeeTests: { token, child: null } };
  c.app.runner.active.set(attemptId, entry);
  try {
    assert.ok(employeeTestsAllowed(c.app.runner.active.get(attemptId), token));
    const agent = { ...plain, token: false, headers: { 'x-studio-attempt-token': token } };
    for (const answer of [
      await list(c, agent),
      await one(c, tool.id, agent),
      await add(c, studioCall(), agent),
      await change(c, tool.id, { expectedRevision: 1, ...command({ purpose: 'From an agent.' }) }, agent),
      await retire(c, tool.id, { expectedRevision: 1 }, agent),
      // With the page's request token as well, which no agent should hold, it is still not the director.
      await change(
        c,
        tool.id,
        { expectedRevision: 1, ...command({ purpose: 'From an agent.' }) },
        { ...agent, token: true },
      ),
    ]) {
      assert.equal(answer.status, 401, answer.text);
      assert.ok(!answer.text.includes('Video encoder'), 'A refusal shows nothing of the tool.');
    }
  } finally {
    c.app.runner.active.delete(attemptId);
  }
  assert.deepEqual(
    c.app.store.tools().map(item => [item.id, item.revision, item.purpose, item.retiredAt ?? null]),
    [[tool.id, 1, 'Cuts and encodes the launch video.', null]],
  );
});

test('each tool change reaches a tab following a project and one following none, in order, with its revision', async t => {
  // A fresh install's No projects yet, so a tab that names no project follows none; then one project to follow.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const app = createStudio({
    directory,
    port: 0,
    bootstrap: { organizationPreset: 'first-run', workflowPresets: [] },
  });
  const origin = await app.start();
  t.after(() => closeAndRemove(app, directory));
  const page = await (await fetch(origin)).text(),
    c = { app, origin, token: page.match(/name="studio-token" content="([^"]+)"/)[1] };
  app.store.putProject({ id: 'project-followed', name: 'Followed', goal: 'Fixture', direction: '', revision: 1 });
  const start = await startOf(c),
    after = app.store.version;

  const added = await add(c, command());
  assert.equal(added.status, 201, added.text);
  const { id } = added.data.tool;
  const changed = await change(c, id, { expectedRevision: 1, ...command({ purpose: 'Encodes the trailer.' }) });
  assert.equal(changed.status, 200, changed.text);
  const retired = await retire(c, id, { expectedRevision: 2 });
  assert.equal(retired.status, 200, retired.text);
  const expected = [1, 2, 3].map(revision => ({ type: 'tool', id, revision }));
  assert.deepEqual(
    [added, changed, retired].map(answer => answer.data.tool.revision),
    [1, 2, 3],
  );

  for (const follows of ['&projectId=project-followed', '']) {
    const missed = await (await fetch(`${origin}/api/changes?after=${after}&start=${start}${follows}`)).json();
    assert.equal(missed.reload, undefined, follows || 'no project');
    const tools = missed.changes.filter(item => item.type === 'tool');
    assert.deepEqual(
      tools.map(({ type, id: toolId, revision }) => ({ type, id: toolId, revision })),
      expected,
      follows || 'no project',
    );
    assert.ok(
      tools.every(item => !Object.hasOwn(item, 'projectId')),
      'A tool belongs to the studio, not a project.',
    );
    assert.ok(
      tools.every((item, index) => index === 0 || item.seq > tools[index - 1].seq),
      'The changes are in the order they were made.',
    );
  }
});

// The tools' key command (1.4, tools): POST /api/tools/:id/key with { expectedRevision, key } sets or replaces a
// tool's key, and key: null removes it. The studios below keep keys in a recording stand-in credential store, which
// holds every key in memory and records each call it gets as [operation, tool ID].
const testKey = 'sd-test-key-QX7J-9481',
  secondKey = 'sd-test-key-ZP3M-5502';
const setKey = (c, id, input, options) => call(c, 'POST', `/api/tools/${id}/key`, input, options);
const withoutSeq = changes => changes.map(({ seq, ...change }) => change);
const holdsKey = text => [testKey, secondKey].some(key => text.includes(key));
const only = "A tool's key command takes only expectedRevision and key.";
// The tool command each action the director reads is sent as.
const actionRoutes = {
  change: 'PATCH /api/tools/:id',
  retire: 'POST /api/tools/:id/retire',
  'set-key': 'POST /api/tools/:id/key',
  'remove-key': 'POST /api/tools/:id/key',
};

// A started studio whose tools' keys go to a recording stand-in credential store, with its data folder.
async function keyStudio(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-')),
    keys = standInToolKeys(),
    app = createStudio({ directory, port: 0, toolKeys: keys });
  const origin = await app.start();
  t.after(() => closeAndRemove(app, directory));
  const page = await (await fetch(origin)).text();
  return { app, origin, directory, keys, token: page.match(/name="studio-token" content="([^"]+)"/)[1] };
}
// The tool changes a tab missed since `after`, without their seq, and the whole answer's text.
async function toolChangesSince(c, start, after) {
  const answer = await fetch(`${c.origin}/api/changes?after=${after}&start=${start}`),
    text = await answer.text(),
    missed = JSON.parse(text);
  assert.equal(missed.reload, undefined);
  return { text, tools: withoutSeq(missed.changes.filter(item => item.type === 'tool')) };
}
// One tab's change stream that names no project, kept as text until closed.
async function watch(origin) {
  const controller = new AbortController(),
    response = await fetch(origin + '/api/events', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let text = '';
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // Aborted when the test closes the stream.
    }
  })();
  return {
    get text() {
      return text;
    },
    async close() {
      controller.abort();
      await reading;
    },
  };
}
// Every file under a folder, at any depth.
const filesUnder = directory =>
  fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name));

test("the director sets, replaces and removes a tool's key with one command, and the key shows nowhere but the credential store", async t => {
  // What the controller writes to the console, kept as it is written.
  const consoleMethods = ['log', 'warn', 'error'].map(method => t.mock.method(console, method));
  const c = await keyStudio(t);
  const { tool } = (await add(c, command())).data;
  assert.deepEqual(tool.actions, ['change', 'retire', 'set-key']);
  const stream = await watch(c.origin),
    start = await startOf(c),
    first = c.app.store.version,
    texts = [];

  // Each command answers the tool as the director reads it, raises the revision and puts exactly the tool's change on
  // the change stream.
  const step = async (input, options) => {
    const after = c.app.store.version,
      answer = await setKey(c, tool.id, input, options);
    assert.equal(answer.status, 200, answer.text);
    assertNoKey(c, answer, `the key command at revision ${input.expectedRevision}`);
    assert.equal(answer.data.tool.revision, input.expectedRevision + 1);
    const missed = await toolChangesSince(c, start, after);
    assert.deepEqual(missed.tools, [{ type: 'tool', id: tool.id, revision: input.expectedRevision + 1 }]);
    texts.push(answer.text, missed.text);
    return answer.data.tool;
  };

  const set = await step({ expectedRevision: 1, key: testKey });
  assert.deepEqual(set.key, { set: true, setAt: set.key.setAt, lastFour: '9481' });
  assert.equal(new Date(set.key.setAt).toISOString(), set.key.setAt);
  assert.deepEqual(set.actions, ['change', 'retire', 'set-key', 'remove-key']);
  assert.deepEqual([...c.keys.held], [[tool.id, testKey]]);
  assert.deepEqual((await one(c, tool.id)).data, { tool: set });

  const replaced = await step({ expectedRevision: 2, key: secondKey });
  assert.deepEqual(replaced.key, { set: true, setAt: replaced.key.setAt, lastFour: '5502' });
  assert.ok(replaced.key.setAt >= set.key.setAt);
  assert.deepEqual(replaced.actions, ['change', 'retire', 'set-key', 'remove-key']);
  assert.deepEqual([...c.keys.held], [[tool.id, secondKey]]);

  const removed = await step({ expectedRevision: 3, key: null });
  assert.deepEqual(removed.key, { set: false });
  assert.deepEqual(removed.actions, ['change', 'retire', 'set-key']);
  assert.equal(c.keys.held.size, 0);
  assert.deepEqual((await one(c, tool.id)).data, { tool: removed });

  // Sent with the director's key and no request token, it works, and its line in the activity names only the method
  // and the route.
  const keyed = { ...plain, token: false, headers: { 'x-studio-key': c.app.directorKey } };
  const keyedSet = await step({ expectedRevision: 4, key: testKey }, keyed);
  assert.equal(keyedSet.key.lastFour, '9481');
  assert.deepEqual([...c.keys.held], [[tool.id, testKey]]);
  assert.deepEqual(
    c.app.store.db
      .prepare("SELECT message FROM events WHERE kind='director_key' ORDER BY seq")
      .all()
      .map(row => row.message),
    [`A local tool sent POST /api/tools/${tool.id}/key with the director's key.`],
  );

  // A refusal that carries the key repeats none of it.
  for (const input of [
    { expectedRevision: 1, key: secondKey },
    { expectedRevision: 5, key: `${secondKey}\n` },
    { expectedRevision: 5, key: secondKey, note: testKey },
  ]) {
    const refused = await setKey(c, tool.id, input);
    assert.ok(refused.status >= 400, refused.text);
    texts.push(refused.text);
  }
  for (const read of [await list(c), await one(c, tool.id)]) {
    assert.equal(read.status, 200);
    assertNoKey(c, read, 'a read');
    texts.push(read.text);
  }
  const all = await toolChangesSince(c, start, first);
  assert.deepEqual(
    all.tools,
    [2, 3, 4, 5].map(revision => ({ type: 'tool', id: tool.id, revision })),
  );
  texts.push(all.text);

  // The change stream carried each change, and none of the key.
  const deadline = Date.now() + 5000;
  while (!stream.text.includes('"revision":5') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  await stream.close();
  assert.ok(stream.text.includes(tool.id) && stream.text.includes('"revision":5'), 'The stream carried the changes.');
  assert.ok(!holdsKey(stream.text), 'The change stream holds no key.');

  for (const text of texts) assert.ok(!holdsKey(text), `An answer holds a key: ${text.slice(0, 200)}`);
  for (const table of ['settings', 'events'])
    assert.ok(
      !holdsKey(JSON.stringify(c.app.store.db.prepare(`SELECT * FROM ${table}`).all())),
      `A row of ${table} holds a key.`,
    );
  // The data folder's files, the database and its journal files included, hold no byte of either key.
  const files = filesUnder(c.directory);
  assert.ok(
    files.some(file => path.basename(file) === 'studio.sqlite'),
    'The data folder holds the database.',
  );
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    for (const key of [testKey, secondKey])
      for (const encoding of ['utf8', 'utf16le'])
        assert.ok(!bytes.includes(Buffer.from(key, encoding)), `${path.relative(c.directory, file)} holds a key.`);
  }
  const written = consoleMethods.flatMap(method => method.mock.calls.map(entry => util.inspect(entry.arguments)));
  assert.ok(!written.some(holdsKey), 'Nothing written to the console holds a key.');
  // Only the stand-in holds it.
  assert.deepEqual([...c.keys.held], [[tool.id, testKey]]);
});

test('retiring a tool with a key set removes the key from the credential store', async t => {
  const c = await keyStudio(t);
  const { tool } = (await add(c, command())).data;
  assert.equal((await setKey(c, tool.id, { expectedRevision: 1, key: testKey })).status, 200);
  assert.deepEqual([...c.keys.held], [[tool.id, testKey]]);

  const retired = await retire(c, tool.id, { expectedRevision: 2 });
  assert.equal(retired.status, 200, retired.text);
  assert.equal(c.keys.held.size, 0, 'The stand-in holds no key.');
  assert.deepEqual(retired.data.tool.key, { set: false });
  assert.deepEqual(retired.data.tool.actions, []);
  assert.equal(retired.data.tool.revision, 3);
  assert.equal(typeof retired.data.tool.retiredAt, 'string');
  assertNoKey(c, retired, 'the retired tool');
  assert.ok(!holdsKey(retired.text));
  assert.deepEqual((await one(c, tool.id)).data, { tool: retired.data.tool });

  // A tool with no key retires without calling the credential store.
  const { tool: other } = (await add(c, studioCall())).data,
    calls = c.keys.calls.length;
  assert.equal((await retire(c, other.id, { expectedRevision: 1 })).status, 200);
  assert.equal(c.keys.calls.length, calls);
});

test('each refusal of the key command answers its status and plain words before the credential store is called', async t => {
  const c = await keyStudio(t);
  const { tool } = (await add(c, command())).data;
  // At revision 2 with no key set, and a second tool retired.
  const changed = await change(c, tool.id, { expectedRevision: 1, ...command({ purpose: 'Encodes the trailer.' }) });
  assert.equal(changed.status, 200, changed.text);
  const { tool: gone } = (await add(c, studioCall())).data;
  assert.equal((await retire(c, gone.id, { expectedRevision: 1 })).status, 200);
  const before = c.app.store.tools();

  for (const [id, input, status, message] of [
    [tool.id, { expectedRevision: 1, key: testKey }, 409, 'Tool changed. Refresh before saving.'],
    [gone.id, { expectedRevision: 2, key: testKey }, 409, 'This tool is retired, so it cannot have a key.'],
    [gone.id, { expectedRevision: 2, key: null }, 409, 'This tool is retired, so it cannot have a key.'],
    [tool.id, { expectedRevision: 2, key: testKey.slice(0, 11) }, 400, "A tool's key is at least 12 characters."],
    [
      tool.id,
      { expectedRevision: 2, key: `${testKey}\nsecond line` },
      400,
      "A tool's key is one line, with no line break.",
    ],
    [tool.id, { expectedRevision: 2, key: `${testKey}\r` }, 400, "A tool's key is one line, with no line break."],
    [tool.id, { expectedRevision: 2, key: 123456789012345 }, 400, "A tool's key is text."],
    [tool.id, { expectedRevision: '2', key: testKey }, 400, 'expectedRevision must be a whole number from 1.'],
    [tool.id, { expectedRevision: 1.5, key: testKey }, 400, 'expectedRevision must be a whole number from 1.'],
    [tool.id, { key: testKey }, 400, 'Name the revision this changes as expectedRevision, from the tool as last read.'],
    [tool.id, { expectedRevision: 2, key: testKey, name: 'Video encoder' }, 400, only],
    [tool.id, { expectedRevision: 2, apiKey: testKey }, 400, only],
    [tool.id, { expectedRevision: 2 }, 400, 'Send the key to set as key, or key: null to remove it.'],
    [tool.id, { expectedRevision: 2, key: null }, 409, 'This tool has no key to remove.'],
    // A projectId is allowed beside the two fields, as the other tool commands allow it.
    [tool.id, { projectId: 'project-legacy', expectedRevision: 2, key: null }, 409, 'This tool has no key to remove.'],
    [unknownId, { expectedRevision: 1, key: testKey }, 404, 'Tool not found.'],
    ['not-a-tool', { expectedRevision: 1, key: testKey }, 404, 'Tool not found.'],
  ]) {
    const refused = await setKey(c, id, input);
    assert.equal(refused.status, status, `${JSON.stringify(input)}: ${refused.text}`);
    assert.equal(refused.data.error, message);
    assert.ok(!holdsKey(refused.text) && !refused.text.includes('sd-test-key'), 'A refusal repeats no key.');
  }
  const json = await call(c, 'POST', `/api/tools/${tool.id}/key`, [testKey]);
  assert.equal(json.status, 400);
  assert.equal(json.data.error, 'Send a tool command as a JSON object.');

  // Neither the session nor the key: 401, even with this start's request token.
  const unsigned = await setKey(c, tool.id, { expectedRevision: 2, key: testKey }, plain);
  assert.equal(unsigned.status, 401, unsigned.text);
  assert.match(unsigned.data.error, /launch/);
  // The session without the request token: 403.
  const cookie = (await fetch(c.app.launchUrl, { ...plain, redirect: 'manual' })).headers
    .get('set-cookie')
    .split(';')[0];
  const session = await setKey(
    c,
    tool.id,
    { expectedRevision: 2, key: testKey },
    {
      ...plain,
      token: false,
      headers: { cookie },
    },
  );
  assert.equal(session.status, 403, session.text);
  assert.match(session.data.error, /X-Studio-Token/);
  // An attempt's test token: 401, with the page's request token as well.
  const attemptId = 'attempt-tool-key',
    token = 'b'.repeat(64);
  c.app.runner.active.set(attemptId, {
    attempt: { id: attemptId, taskId: 'T-tool-key' },
    employeeTests: { token, child: null },
  });
  try {
    assert.ok(employeeTestsAllowed(c.app.runner.active.get(attemptId), token));
    const agent = { ...plain, token: false, headers: { 'x-studio-attempt-token': token } };
    for (const options of [agent, { ...agent, token: true }]) {
      const refused = await setKey(c, tool.id, { expectedRevision: 2, key: testKey }, options);
      assert.equal(refused.status, 401, refused.text);
      assert.ok(!holdsKey(refused.text));
    }
  } finally {
    c.app.runner.active.delete(attemptId);
  }
  for (const answer of [unsigned, session]) assert.ok(!holdsKey(answer.text));

  assert.deepEqual(c.keys.calls, [], 'The credential store was never called.');
  assert.equal(c.keys.held.size, 0);
  assert.deepEqual(c.app.store.tools(), before, 'Nothing refused changed a tool.');
});

test('a record that cannot be saved after the credential store took a replacement keeps the old key and the tool as they were', async t => {
  const c = await keyStudio(t);
  const { tool } = (await add(c, command())).data;
  assert.equal((await setKey(c, tool.id, { expectedRevision: 1, key: testKey })).status, 200);
  const before = await one(c, tool.id),
    start = await startOf(c),
    after = c.app.store.version;
  c.keys.calls.length = 0;

  // putTool fails once, after the stand-in has taken the replacement.
  const putTool = t.mock.method(c.app.store, 'putTool');
  putTool.mock.mockImplementationOnce(() => {
    throw new Error('The disk is full.');
  });
  const failed = await setKey(c, tool.id, { expectedRevision: 2, key: secondKey });
  putTool.mock.restore();
  assert.equal(failed.status, 400, failed.text);
  assert.equal(failed.data.error, 'The disk is full.');
  assert.ok(!holdsKey(failed.text));
  assert.deepEqual(c.keys.calls, [
    ['read', tool.id],
    ['put', tool.id],
    ['put', tool.id],
  ]);
  assert.deepEqual([...c.keys.held], [[tool.id, testKey]], 'The stand-in holds the old key again.');
  assert.deepEqual((await one(c, tool.id)).data, before.data, 'The tool reads exactly as before.');
  assert.deepEqual((await toolChangesSince(c, start, after)).tools, [], 'No tool change went on the stream.');
});

test('the director reads the key actions an active tool offers, and each names a route the table lists', async t => {
  const c = await keyStudio(t);
  const table = await call(c, 'GET', '/api/routes');
  assert.equal(table.status, 200);
  const listed = new Set(table.data.routes.map(route => `${route.method} ${route.path}`));
  assert.ok(listed.has('POST /api/tools/:id/key'));

  const { tool } = (await add(c, studioCall())).data,
    seen = [tool.actions];
  assert.deepEqual(tool.actions, ['change', 'retire', 'set-key']);
  const set = await setKey(c, tool.id, { expectedRevision: 1, key: testKey });
  assert.deepEqual(set.data.tool.actions, ['change', 'retire', 'set-key', 'remove-key']);
  assert.deepEqual((await one(c, tool.id)).data.tool.actions, ['change', 'retire', 'set-key', 'remove-key']);
  assert.deepEqual(
    (await list(c)).data.tools.map(item => item.actions),
    [['change', 'retire', 'set-key', 'remove-key']],
  );
  seen.push(set.data.tool.actions);
  const retired = await retire(c, tool.id, { expectedRevision: 2 });
  assert.deepEqual(retired.data.tool.actions, []);
  assert.deepEqual((await one(c, tool.id)).data.tool.actions, []);

  const actions = [...new Set(seen.flat())];
  assert.deepEqual(actions.sort(), Object.keys(actionRoutes).sort(), 'Every action has its command.');
  for (const action of actions) assert.ok(listed.has(actionRoutes[action]), `${action}: ${actionRoutes[action]}`);
});
