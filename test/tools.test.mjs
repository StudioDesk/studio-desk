// A studio tool's record and its checks: a command names one program and where to get it, a studio call an https
// address with nothing secret in it and the operations it allows, every tool its rules and limits, and no record ever
// holds a key. The studio's tool list on a temporary store: adding, changing by revision, retiring, the change stream
// and what each reader may do. Model-free: the program finder is injected, or reads a temporary folder of plain files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import * as tools from '../src/core/tools.mjs';
import {
  addTool,
  changeTool,
  checkToolInput,
  maxTools,
  operationRequest,
  programAvailability,
  programOnPath,
  readTool,
  readTools,
  retireTool,
  toolActions,
  toolKey,
  toolLimitBounds,
} from '../src/core/tools.mjs';

const limits = { callsPerHour: 60, callsPerAttempt: 10, timeoutSeconds: 30, maxResponseBytes: 1024 * 1024 };
const command = (fields = {}) => ({
  name: '  Video encoder ',
  purpose: 'Cuts and encodes the launch video.',
  kind: 'command',
  rules: 'Write only into the attempt folder.',
  program: 'ffmpeg',
  getFrom: 'Install it with winget install ffmpeg, or from https://ffmpeg.org/download.html',
  limits,
  ...fields,
});
const studioCall = (fields = {}) => ({
  name: 'Issue tracker',
  purpose: 'Reads and files issues.',
  kind: 'studio-call',
  rules: 'File an issue only when the brief asks for one.',
  address: 'https://API.example.com/v2/',
  operations: [
    {
      name: 'list-issues',
      method: 'GET',
      path: '/repos/{repo}/issues',
      arguments: ['repo', 'state'],
      required: ['repo'],
    },
    {
      name: 'file_issue',
      method: 'POST',
      path: '/repos/{repo}/issues',
      arguments: ['repo', 'title'],
      required: ['repo', 'title'],
    },
  ],
  limits,
  ...fields,
});
const withOperation = (operation, fields = {}) =>
  studioCall({ operations: [{ name: 'read', method: 'GET', path: '/items', ...operation }], ...fields });
// The input is refused with status 400 and a plain message that says what is wrong.
function refused(input, message) {
  assert.throws(
    () => checkToolInput(input),
    error => {
      assert.equal(error.status, 400);
      assert.match(error.message, message);
      return true;
    },
  );
}

test('a valid command is accepted and normalized', () => {
  assert.deepEqual(checkToolInput(command()), {
    name: 'Video encoder',
    purpose: 'Cuts and encodes the launch video.',
    kind: 'command',
    rules: 'Write only into the attempt folder.',
    program: 'ffmpeg',
    getFrom: 'Install it with winget install ffmpeg, or from https://ffmpeg.org/download.html',
    limits,
  });
  // Rules may be left out; dots, underscores and hyphens name a program.
  const body = checkToolInput(command({ rules: undefined, program: 'magick.v7_q16-hdri' }));
  assert.equal(body.rules, '');
  assert.equal(body.program, 'magick.v7_q16-hdri');
});

test('a valid studio call is accepted and normalized', () => {
  const input = studioCall(),
    body = checkToolInput(input);
  assert.deepEqual(body, {
    name: 'Issue tracker',
    purpose: 'Reads and files issues.',
    kind: 'studio-call',
    rules: 'File an issue only when the brief asks for one.',
    address: 'https://api.example.com/v2',
    operations: [
      {
        name: 'list-issues',
        method: 'GET',
        path: '/repos/{repo}/issues',
        arguments: ['repo', 'state'],
        required: ['repo'],
      },
      {
        name: 'file_issue',
        method: 'POST',
        path: '/repos/{repo}/issues',
        arguments: ['repo', 'title'],
        required: ['repo', 'title'],
      },
    ],
    limits,
  });
  // The record is its own copy, not the input's objects.
  assert.notEqual(body.operations[0], input.operations[0]);
  assert.notEqual(body.limits, input.limits);
  // Arguments and required arguments may be left out of an operation that takes none.
  assert.deepEqual(checkToolInput(withOperation({})).operations, [
    { name: 'read', method: 'GET', path: '/items', arguments: [], required: [] },
  ]);
});

test('a record accepts only its own fields, never a key', () => {
  refused(command({ colour: 'blue' }), /takes only a name, purpose, kind, rules, limits.*leave out "colour"/);
  for (const field of ['key', 'secret', 'token', 'password', 'apiKey', 'headers', 'Authorization'])
    refused(studioCall({ [field]: 'abc123' }), new RegExp(`never holds a key.*leave out "${field}"`));
  // No key hides in an operation or the limits either.
  refused(withOperation({ headers: { Authorization: 'Bearer abc' } }), /never holds a key.*"headers"/);
  refused(withOperation({ body: '{}' }), /operation takes only.*leave out "body"/);
  refused(command({ limits: { ...limits, apiKey: 'abc' } }), /never holds a key.*"apiKey"/);
  refused(command({ limits: { ...limits, retries: 3 } }), /limits are only.*leave out "retries"/);
  // Each kind keeps to its own fields.
  refused(command({ address: 'https://example.com' }), /command .* has no address or operations/);
  refused(studioCall({ program: 'curl' }), /studio call .* has no program/);
  refused(studioCall({ getFrom: 'anywhere' }), /studio call .* has no program/);
  refused(null, /object of its fields/);
  refused([command()], /object of its fields/);
  // The check never echoes a key's value.
  assert.throws(
    () => checkToolInput(studioCall({ token: 'sk-very-secret' })),
    error => !error.message.includes('sk-very-secret'),
  );
});

test('a tool is a command or a studio call', () => {
  refused(command({ kind: 'script' }), /either a command .* or a studio call/);
  refused(command({ kind: undefined }), /either a command .* or a studio call/);
  refused(command({ kind: 'Command' }), /either a command .* or a studio call/);
});

test('a name, purpose and rules are bounded text', () => {
  refused(command({ name: '' }), /name of 1 to 80 characters/);
  refused(command({ name: '   ' }), /name of 1 to 80 characters/);
  refused(command({ name: 'n'.repeat(81) }), /name of 1 to 80 characters/);
  refused(command({ name: 42 }), /name of 1 to 80 characters/);
  assert.equal(checkToolInput(command({ name: 'n'.repeat(80) })).name.length, 80);
  refused(command({ purpose: '' }), /what the tool is for in 1 to 500 characters/);
  refused(command({ purpose: undefined }), /what the tool is for in 1 to 500 characters/);
  refused(command({ purpose: 'p'.repeat(501) }), /what the tool is for in 1 to 500 characters/);
  refused(command({ rules: 'r'.repeat(8001) }), /rules .* at most 8000 characters/);
  refused(command({ rules: ['no lists'] }), /rules .* at most 8000 characters/);
  assert.equal(checkToolInput(command({ rules: 'r'.repeat(8000) })).rules.length, 8000);
});

test('a command names one program, never a path or a shell line', () => {
  const program = /Name one program, such as ffmpeg or magick/;
  for (const value of [
    'ffmpeg -i in.mp4',
    'ffmpeg ',
    '/usr/bin/ffmpeg',
    'bin/ffmpeg',
    'C:\\tools\\ffmpeg.exe',
    'ffmpeg;rm',
    'ffmpeg|tee',
    'a&b',
    '$HOME',
    'a>b',
    'a<b',
    '`id`',
    'a(b)',
    '"ffmpeg"',
    "'ffmpeg'",
    '-version',
    '.hidden',
    '',
    'p'.repeat(65),
    undefined,
    ['ffmpeg'],
  ])
    refused(command({ program: value }), program);
  assert.equal(checkToolInput(command({ program: 'p'.repeat(64) })).program.length, 64);
});

test('a command says where to get its program', () => {
  refused(command({ getFrom: undefined }), /where to get the program .* 1 to 500 characters/);
  refused(command({ getFrom: '  ' }), /where to get the program .* 1 to 500 characters/);
  refused(command({ getFrom: 'g'.repeat(501) }), /where to get the program .* 1 to 500 characters/);
});

test("a studio call's address is https, has a host and carries nothing secret", () => {
  refused(studioCall({ address: 'http://api.example.com' }), /must start with https:\/\//);
  refused(studioCall({ address: 'ftp://api.example.com' }), /must start with https:\/\//);
  refused(studioCall({ address: 'https://' }), /address with a host/);
  refused(studioCall({ address: 'api.example.com' }), /address with a host/);
  refused(studioCall({ address: undefined }), /address with a host/);
  refused(studioCall({ address: 'https://user:hunter2@api.example.com' }), /never carries a user name or password/);
  refused(studioCall({ address: 'https://user@api.example.com' }), /never carries a user name or password/);
  refused(studioCall({ address: 'https://api.example.com/v2?api_key=abc' }), /has no query string/);
  refused(studioCall({ address: 'https://api.example.com/v2?' }), /has no query string/);
  refused(studioCall({ address: 'https://api.example.com/v2#token=abc' }), /has no fragment/);
  refused(studioCall({ address: 'https://api.example.com/v2#' }), /has no fragment/);
  refused(studioCall({ address: `https://api.example.com/${'a'.repeat(2048)}` }), /at most 2048 characters/);
  // A refused address is never repeated in the message.
  assert.throws(
    () => checkToolInput(studioCall({ address: 'https://user:hunter2@api.example.com' })),
    error => !error.message.includes('hunter2'),
  );
  assert.equal(checkToolInput(studioCall({ address: 'https://api.example.com' })).address, 'https://api.example.com');
});

test("a studio call's operations are named once, use one of five methods and declare their arguments", () => {
  refused(studioCall({ operations: [] }), /from 1 to 50 operations/);
  refused(studioCall({ operations: undefined }), /from 1 to 50 operations/);
  refused(
    studioCall({
      operations: Array.from({ length: 51 }, (_, index) => ({ name: `op${index}`, method: 'GET', path: '/items' })),
    }),
    /from 1 to 50 operations/,
  );
  refused(studioCall({ operations: ['GET /items'] }), /Each operation is an object/);
  refused(
    studioCall({
      operations: [
        { name: 'read', method: 'GET', path: '/items' },
        { name: 'read', method: 'POST', path: '/items' },
      ],
    }),
    /Two operations are named "read"/,
  );
  refused(withOperation({ name: 'read items' }), /Name each operation with 1 to 64/);
  refused(withOperation({ name: 'o'.repeat(65) }), /Name each operation with 1 to 64/);
  for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'get', undefined])
    refused(withOperation({ method }), /uses GET, POST, PUT, PATCH or DELETE/);
  refused(withOperation({ arguments: ['id', 'id'] }), /each named once/);
  refused(withOperation({ arguments: ['an id'] }), /each named once/);
  refused(withOperation({ arguments: Array.from({ length: 21 }, (_, index) => `a${index}`) }), /at most 20 arguments/);
  refused(withOperation({ arguments: 'id' }), /at most 20 arguments/);
  refused(withOperation({ arguments: ['id'], required: ['token'] }), /can require only arguments it lists/);
  refused(withOperation({ required: ['id'] }), /can require only arguments it lists/);
  refused(
    withOperation({ arguments: ['id'], required: ['id', 'id'] }),
    /can require only arguments it lists, each once/,
  );
});

test("an operation's path is literal parts and whole placeholders for its own arguments", () => {
  refused(withOperation({ path: '/items/{id}', arguments: ['name'] }), /names \{id\}, which is not one of/);
  refused(withOperation({ path: '/items/{id}' }), /names \{id\}, which is not one of/);
  refused(withOperation({ path: '/items/../admin' }), /no "\." or "\.\." part/);
  refused(withOperation({ path: '/items/./list' }), /no "\." or "\.\." part/);
  refused(withOperation({ path: '/items?all=true' }), /no query string or fragment/);
  refused(withOperation({ path: '/items#top' }), /no query string or fragment/);
  refused(withOperation({ path: '/items//list' }), /no empty part/);
  refused(withOperation({ path: '/items/' }), /no empty part/);
  refused(withOperation({ path: '/' }), /no empty part/);
  refused(withOperation({ path: 'items' }), /path of at most 300 characters starting with \//);
  refused(withOperation({ path: `/${'a'.repeat(300)}` }), /path of at most 300 characters/);
  refused(withOperation({ path: undefined }), /path of at most 300 characters/);
  for (const route of ['/items/{id}.json', '/items/x{id}', '/items/%2e%2e', '/items/a b', '/items/a:b', '/items/@me'])
    refused(withOperation({ path: route, arguments: ['id'] }), /Each part of the path .* is letters, digits/);
  assert.equal(
    checkToolInput(withOperation({ path: '/v1/items.json/{id}/~x_y-z', arguments: ['id'] })).operations[0].path,
    '/v1/items.json/{id}/~x_y-z',
  );
});

test('limits are required, closed and whole numbers within their bounds', () => {
  assert.deepEqual(toolLimitBounds, {
    callsPerHour: 10000,
    callsPerAttempt: 1000,
    timeoutSeconds: 600,
    maxResponseBytes: 10 * 1024 * 1024,
  });
  refused(command({ limits: undefined }), /Set the tool's limits/);
  refused(command({ limits: [] }), /Set the tool's limits/);
  const { timeoutSeconds, ...partial } = limits;
  assert.ok(timeoutSeconds);
  refused(command({ limits: partial }), /time limit in seconds must be a whole number from 1 to 600/);
  for (const [field, bound] of Object.entries(toolLimitBounds)) {
    for (const value of [0, -1, 1.5, bound + 1, '10', Number.NaN, Number.POSITIVE_INFINITY, null])
      refused(command({ limits: { ...limits, [field]: value } }), new RegExp(`a whole number from 1 to ${bound}\\.`));
    assert.equal(checkToolInput(command({ limits: { ...limits, [field]: bound } })).limits[field], bound);
    assert.equal(checkToolInput(command({ limits: { ...limits, [field]: 1 } })).limits[field], 1);
  }
});

test('a record never has a key set', () => {
  assert.deepEqual(toolKey(), { set: false });
  for (const body of [checkToolInput(command()), checkToolInput(studioCall())]) assert.ok(!('key' in body));
});

test("programAvailability says whether this computer has a command's program, never where", () => {
  const record = checkToolInput(command()),
    asked = [];
  const found = programAvailability(record, program => {
    asked.push(program);
    return 'C:\\Users\\someone\\tools\\ffmpeg.exe';
  });
  assert.deepEqual(asked, ['ffmpeg']);
  assert.deepEqual(found, { state: 'found' });
  assert.deepEqual(
    programAvailability(record, () => null),
    { state: 'missing', getFrom: record.getFrom },
  );
  assert.deepEqual(
    programAvailability(record, () => false),
    { state: 'missing', getFrom: record.getFrom },
  );
  // A finder that fails answers missing.
  assert.deepEqual(
    programAvailability(record, () => {
      throw new Error('C:\\Users\\someone\\tools is unreadable');
    }),
    { state: 'missing', getFrom: record.getFrom },
  );
  // A studio call has no program, and its finder is never asked.
  assert.equal(
    programAvailability(checkToolInput(studioCall()), () => assert.fail('a studio call has no program')),
    null,
  );
  // A record whose program is not one plain name is refused before any finder looks for it.
  assert.throws(
    () => programAvailability({ ...record, program: '../../secret' }, () => assert.fail('never asked')),
    error => error.status === 400,
  );
});

test('the default finder looks in the PATH folders, with each PATHEXT extension on Windows', t => {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tools-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const empty = path.join(folder, 'empty'),
    bin = path.join(folder, 'bin');
  fs.mkdirSync(empty);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'encoder'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'resizer.CMD'), '@echo off\r\n');
  fs.mkdirSync(path.join(bin, 'folder-not-program'));
  const PATH = [empty, bin].join(path.delimiter);

  assert.equal(programOnPath('encoder', { environment: { PATH }, platform: 'linux' }), true);
  assert.equal(programOnPath('resizer', { environment: { PATH }, platform: 'linux' }), false);
  assert.equal(programOnPath('resizer', { environment: { PATH, PATHEXT: '.EXE;.CMD' }, platform: 'win32' }), true);
  assert.equal(programOnPath('resizer', { environment: { PATH, PATHEXT: '.EXE' }, platform: 'win32' }), false);
  // Windows names its variables in any case.
  assert.equal(programOnPath('resizer', { environment: { Path: PATH, PathExt: '.CMD' }, platform: 'win32' }), true);
  assert.equal(programOnPath('resizer.CMD', { environment: { Path: PATH, PATHEXT: '.EXE' }, platform: 'win32' }), true);
  // A folder is not a program, nor is a relative PATH folder searched, nor a path for a name.
  assert.equal(programOnPath('folder-not-program', { environment: { PATH }, platform: 'linux' }), false);
  assert.equal(programOnPath('missing', { environment: { PATH }, platform: 'linux' }), false);
  assert.equal(programOnPath('encoder', { environment: { PATH: 'bin' }, platform: 'linux' }), false);
  assert.equal(programOnPath('encoder', { environment: {}, platform: 'linux' }), false);
  assert.equal(programOnPath(`../bin/encoder`, { environment: { PATH: empty }, platform: 'linux' }), false);

  // Through programAvailability, the answer is only found or missing.
  const record = checkToolInput(command({ program: 'encoder' })),
    find = program => programOnPath(program, { environment: { PATH }, platform: 'linux' });
  const answer = programAvailability(record, find);
  assert.deepEqual(answer, { state: 'found' });
  assert.ok(!JSON.stringify(answer).includes(folder));
  const missing = programAvailability(checkToolInput(command({ program: 'absent' })), find);
  assert.deepEqual(missing, { state: 'missing', getFrom: record.getFrom });
  assert.ok(!JSON.stringify(missing).includes(folder));
});

test('operationRequest builds only a declared operation with its declared arguments', () => {
  const record = checkToolInput(studioCall());
  assert.deepEqual(operationRequest(record, 'list-issues', { repo: 'studio desk/main', state: 'open' }), {
    method: 'GET',
    url: 'https://api.example.com/v2/repos/studio%20desk%2Fmain/issues',
    query: { state: 'open' },
  });
  assert.deepEqual(operationRequest(record, 'list-issues', { repo: 'a?b#c&d=e' }), {
    method: 'GET',
    url: 'https://api.example.com/v2/repos/a%3Fb%23c%26d%3De/issues',
    query: {},
  });
  assert.deepEqual(operationRequest(record, 'file_issue', { repo: 42, title: 'It broke' }), {
    method: 'POST',
    url: 'https://api.example.com/v2/repos/42/issues',
    query: { title: 'It broke' },
  });
  // An encoded argument stays inside its own part of the path and on the record's host.
  const escape = operationRequest(record, 'list-issues', { repo: '../../@evil.example.com:443' });
  assert.equal(escape.url, 'https://api.example.com/v2/repos/..%2F..%2F%40evil.example.com%3A443/issues');
  assert.equal(new URL(escape.url).host, 'api.example.com');
});

test('operationRequest refuses anything a record does not declare', () => {
  const record = checkToolInput(studioCall());
  const refusedCall = (call, message) =>
    assert.throws(call, error => {
      assert.equal(error.status, 400);
      assert.match(error.message, message);
      return true;
    });
  refusedCall(() => operationRequest(record, 'delete-repo', { repo: 'x' }), /no operation named "delete-repo"/);
  refusedCall(() => operationRequest(record, undefined, { repo: 'x' }), /no operation named/);
  refusedCall(() => operationRequest(record, 'list-issues', { repo: 'x', admin: 'true' }), /takes no argument "admin"/);
  // An argument another operation declares is still not this one's.
  refusedCall(() => operationRequest(record, 'list-issues', { repo: 'x', title: 'y' }), /takes no argument "title"/);
  refusedCall(() => operationRequest(record, 'file_issue', { repo: 'x' }), /needs the argument "title"/);
  refusedCall(() => operationRequest(record, 'list-issues', {}), /needs the argument "repo"/);
  refusedCall(() => operationRequest(record, 'list-issues'), /needs the argument "repo"/);
  // Inherited names are not arguments.
  refusedCall(() => operationRequest(record, 'list-issues', Object.create({ repo: 'x' })), /needs the argument "repo"/);
  for (const value of [null, true, { a: 1 }, ['x'], Number.NaN, Number.POSITIVE_INFINITY])
    refusedCall(() => operationRequest(record, 'list-issues', { repo: value }), /must be text or a number/);
  for (const value of ['', '.', '..'])
    refusedCall(() => operationRequest(record, 'list-issues', { repo: value }), /cannot be empty, "\." or "\.\."/);
  refusedCall(() => operationRequest(record, 'list-issues', 'repo=x'), /object of names and values/);
  refusedCall(() => operationRequest(checkToolInput(command()), 'list-issues', {}), /not a studio call/);
  refusedCall(() => operationRequest(null, 'list-issues', {}), /not a studio call/);
  // A path argument the operation does not require is still needed to fill its path.
  const optional = checkToolInput(withOperation({ path: '/items/{id}', arguments: ['id'] }));
  refusedCall(() => operationRequest(optional, 'read', {}), /needs the argument "id" for its path/);
  assert.equal(operationRequest(optional, 'read', { id: 7 }).url, 'https://api.example.com/v2/items/7');
});

// A temporary store whose changes are kept, as the change stream hears them.
function studio(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tool-list-')),
    store = new Store(directory, () => ({ organization: { company: {}, workers: [], teams: [] }, tasks: [] })),
    changes = [];
  store.onChange = change => changes.push(change);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, changes };
}
function refusedWith(call, status, message) {
  assert.throws(call, error => {
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  });
}
const stale = /^Tool changed\. Refresh before saving\.$/;
const notFound = /^Tool not found\.$/;
const uuid = /^tool-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('adding a tool gives it an ID the controller makes and revision 1, ignoring any ID in the input', t => {
  const { store, changes } = studio(t);
  const added = addTool(store, command({ id: 'tool-mine' }));
  assert.match(added.id, uuid);
  assert.notEqual(added.id, 'tool-mine');
  refusedWith(() => store.tool('tool-mine'), 404, notFound);
  assert.deepEqual(added, {
    id: added.id,
    ...checkToolInput(command()),
    key: { set: false },
    revision: 1,
    createdAt: added.createdAt,
    updatedAt: added.createdAt,
    by: 'director',
  });
  assert.ok(Number.isFinite(Date.parse(added.createdAt)));
  // The record is kept as the studio's own setting, with no project.
  assert.deepEqual(store.tool(added.id), added);
  assert.deepEqual(store.setting('tool:' + added.id), added);
  assert.ok(!('projectId' in added));
  // Each tool has its own ID, and the list keeps the order they were added in.
  const second = addTool(store, studioCall(), 'director');
  assert.match(second.id, uuid);
  assert.notEqual(second.id, added.id);
  assert.deepEqual(
    store.tools().map(tool => tool.id),
    [added.id, second.id],
  );
  // Refused input stores nothing and announces nothing; a key or a controller field never comes from the input.
  const announced = changes.length;
  refusedWith(() => addTool(store, command({ key: 'sk-secret' })), 400, /never holds a key/);
  refusedWith(() => addTool(store, command({ revision: 7 })), 400, /leave out "revision"/);
  refusedWith(() => addTool(store, null), 400, /object of its fields/);
  assert.equal(store.tools().length, 2);
  assert.equal(changes.length, announced);
  refusedWith(() => store.tool(undefined), 404, notFound);
});

test('a change naming the current revision raises it; one naming an earlier revision is refused', t => {
  const { store } = studio(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T10:00:00.000Z') });
  const added = addTool(store, command());
  t.mock.timers.tick(60_000);
  // The director's fields are replaced (a command may become a studio call); the ID, when it was added and the key
  // state are kept, whatever ID the input names.
  const changed = changeTool(store, added.id, 1, studioCall({ id: 'tool-other' }), 'director');
  assert.deepEqual(changed, {
    id: added.id,
    ...checkToolInput(studioCall()),
    key: { set: false },
    revision: 2,
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:01:00.000Z',
    by: 'director',
  });
  assert.ok(!('program' in changed) && !('getFrom' in changed));
  assert.deepEqual(store.tool(added.id), changed);
  refusedWith(() => store.tool('tool-other'), 404, notFound);
  // A second change naming revision 1 was made before the first and is refused, leaving the record as it was.
  refusedWith(() => changeTool(store, added.id, 1, command({ name: 'Stale' })), 409, stale);
  for (const revision of [3, 0, undefined, null, '2'])
    refusedWith(() => changeTool(store, added.id, revision, command({ name: 'Stale' })), 409, stale);
  assert.deepEqual(store.tool(added.id), changed);
  // Input that breaks the record's rules is refused before anything is read or saved.
  refusedWith(() => changeTool(store, added.id, 2, command({ program: 'ffmpeg -i in.mp4' })), 400, /Name one program/);
  refusedWith(() => changeTool(store, added.id, 2, command({ token: 'abc' })), 400, /never holds a key/);
  assert.deepEqual(store.tool(added.id), changed);
  refusedWith(() => changeTool(store, 'tool-missing', 1, command()), 404, notFound);
  // The current revision changes it again.
  assert.equal(changeTool(store, added.id, 2, command({ name: 'Encoder' })).revision, 3);
});

test('retiring raises the revision and keeps the tool listed with retiredAt; then a change or retire is refused', t => {
  const { store } = studio(t);
  const added = addTool(store, command()),
    other = addTool(store, studioCall());
  changeTool(store, added.id, 1, command({ name: 'Encoder' }));
  refusedWith(() => retireTool(store, added.id, 1), 409, stale);
  assert.equal(store.tool(added.id).retiredAt, undefined);
  const retired = retireTool(store, added.id, 2);
  assert.equal(retired.revision, 3);
  assert.ok(Number.isFinite(Date.parse(retired.retiredAt)));
  assert.equal(retired.updatedAt, retired.retiredAt);
  assert.equal(retired.name, 'Encoder');
  assert.equal(retired.createdAt, added.createdAt);
  assert.deepEqual(retired.key, { set: false });
  // The record is kept, in its place in the list, and read as retired.
  assert.deepEqual(store.tool(added.id), retired);
  assert.deepEqual(
    store.tools().map(tool => tool.id),
    [added.id, other.id],
  );
  assert.deepEqual(
    readTools(store, { find: () => true }).map(tool => [tool.id, tool.retiredAt]),
    [
      [added.id, retired.retiredAt],
      [other.id, null],
    ],
  );
  // A retired tool takes no further change or retiring, at its current revision or any other.
  refusedWith(() => changeTool(store, added.id, 3, command()), 409, /retired, so it cannot be changed/);
  refusedWith(() => retireTool(store, added.id, 3), 409, /already retired/);
  refusedWith(() => retireTool(store, added.id, 2), 409, stale);
  refusedWith(() => retireTool(store, 'tool-missing', 1), 404, notFound);
  assert.deepEqual(store.tool(added.id), retired);
});

test('nothing deletes a tool, and deleting a project leaves the studio its tools', t => {
  const { store } = studio(t);
  assert.deepEqual(
    Object.keys(tools).filter(name => /delete|remove|drop|purge|erase|destroy/i.test(name)),
    [],
  );
  assert.deepEqual(
    Object.getOwnPropertyNames(Store.prototype).filter(name => /tool/i.test(name)),
    ['tools', 'tool', 'putTool'],
  );
  const added = addTool(store, command());
  store.deleteProjectRecords('project-other', [], []);
  assert.deepEqual(store.tools(), [added]);
});

test("every add, change and retire goes on the change stream with the tool's ID and revision and no project", t => {
  const { store, changes } = studio(t);
  changes.length = 0;
  const added = addTool(store, command());
  changeTool(store, added.id, 1, command({ name: 'Encoder' }));
  refusedWith(() => changeTool(store, added.id, 1, command()), 409, stale);
  refusedWith(() => retireTool(store, added.id, 1), 409, stale);
  retireTool(store, added.id, 2);
  assert.deepEqual(
    changes.map(({ seq, ...change }) => change),
    [
      { type: 'tool', id: added.id, revision: 1 },
      { type: 'tool', id: added.id, revision: 2 },
      { type: 'tool', id: added.id, revision: 3 },
    ],
  );
  assert.deepEqual(
    changes.map(change => change.seq),
    [changes[0].seq, changes[0].seq + 1, changes[0].seq + 2],
  );
  assert.equal(store.version, changes[2].seq);
  // A tool's setting never names a project, even one its data holds, so every tab hears it.
  store.putSetting('tool:tool-elsewhere', { id: 'tool-elsewhere', revision: 4, projectId: 'project-other' });
  const { seq, ...last } = changes.at(-1);
  assert.ok(seq);
  assert.deepEqual(last, { type: 'tool', id: 'tool-elsewhere', revision: 4 });
});

test('the director may change or retire an active tool; a retired one and any other reader take no action', t => {
  const { store } = studio(t);
  const active = addTool(store, command()),
    retired = retireTool(store, addTool(store, studioCall()).id, 1),
    find = () => true;
  assert.deepEqual(readTool(store, active.id, { find }).actions, ['change', 'retire']);
  assert.deepEqual(readTool(store, retired.id, { find }).actions, []);
  assert.deepEqual(
    readTools(store, { find }).map(tool => tool.actions),
    [['change', 'retire'], []],
  );
  for (const reader of ['attempt-d4508f47', 'W-02', 'Director', '', null])
    assert.deepEqual(
      readTools(store, { reader, find }).map(tool => tool.actions),
      [[], []],
      `reader ${reader}`,
    );
  assert.deepEqual(readTool(store, active.id, { reader: 'attempt-d4508f47', find }).actions, []);
  assert.deepEqual(toolActions(active, 'director'), ['change', 'retire']);
  assert.deepEqual(toolActions(retired, 'director'), []);
  assert.deepEqual(toolActions(active, 'attempt-d4508f47'), []);
  // A read with no options is the director's.
  assert.deepEqual(readTool(store, retired.id).actions, []);
  assert.deepEqual(readTool(store, addTool(store, studioCall()).id).actions, ['change', 'retire']);
});

test("every read's key is exactly { set: false }, and the list holds no other key field", t => {
  const { store } = studio(t);
  const added = addTool(store, command()),
    call = addTool(store, studioCall());
  // Even a record written past the checks with key material reads as having no key set, and nothing else of it.
  store.putTool({
    ...store.tool(call.id),
    key: { set: true, value: 'sk-live-secret' },
    apiKey: 'sk-live-secret',
    headers: { Authorization: 'Bearer sk-live-secret' },
  });
  retireTool(store, added.id, 1);
  const list = readTools(store, { find: () => true });
  assert.equal(list.length, 2);
  for (const tool of list) assert.deepEqual(tool.key, { set: false });
  assert.deepEqual(readTool(store, call.id).key, { set: false });
  const json = JSON.stringify(list);
  assert.ok(!json.includes('sk-live-secret'));
  const keyFields = [];
  JSON.parse(json, (name, value) => {
    if (/key|secret|token|password|passwd|credential|auth|header|cookie/i.test(name)) keyFields.push([name, value]);
    return value;
  });
  assert.deepEqual(keyFields, [
    ['key', { set: false }],
    ['key', { set: false }],
  ]);
});

test("a command's read says found, or missing with where to get it, from an injected finder", t => {
  const { store } = studio(t);
  const encoder = addTool(store, command()),
    resizer = addTool(store, command({ name: 'Resizer', program: 'magick', getFrom: 'https://imagemagick.org' })),
    call = addTool(store, studioCall()),
    asked = [];
  const find = program => {
    asked.push(program);
    return program === 'ffmpeg' ? 'C:\\Users\\someone\\bin\\ffmpeg.exe' : null;
  };
  const list = readTools(store, { find });
  assert.deepEqual(
    list.map(tool => [tool.id, tool.availability]),
    [
      [encoder.id, { state: 'found' }],
      [resizer.id, { state: 'missing', getFrom: 'https://imagemagick.org' }],
      [call.id, null],
    ],
  );
  assert.deepEqual(asked, ['ffmpeg', 'magick']);
  assert.ok(!JSON.stringify(list).includes('someone'));
  // A read is the stored fields, the key as not set, when it was retired, whether its program is here and the actions.
  assert.deepEqual(readTool(store, encoder.id, { find }), {
    ...checkToolInput(command()),
    id: encoder.id,
    key: { set: false },
    revision: 1,
    createdAt: encoder.createdAt,
    updatedAt: encoder.updatedAt,
    by: 'director',
    retiredAt: null,
    availability: { state: 'found' },
    actions: ['change', 'retire'],
  });
  refusedWith(() => readTool(store, 'tool-missing', { find }), 404, notFound);
});

test('the studio keeps at most 200 tools, retired ones included', t => {
  const { store, changes } = studio(t);
  assert.equal(maxTools, 200);
  const first = addTool(store, command());
  for (let index = 1; index < maxTools; index++) addTool(store, command({ name: `Tool ${index}` }));
  assert.equal(store.tools().length, 200);
  retireTool(store, first.id, 1);
  const announced = changes.length;
  refusedWith(() => addTool(store, studioCall()), 400, /at most 200 tools, retired ones included/);
  assert.equal(store.tools().length, 200);
  assert.equal(changes.length, announced);
  // The tools it keeps can still change.
  const last = store.tools().at(-1);
  assert.equal(changeTool(store, last.id, 1, command({ name: 'Last tool' })).revision, 2);
});
