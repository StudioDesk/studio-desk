// A studio tool's record and its checks: a command names one program and where to get it, a studio call an https
// address with nothing secret in it and the operations it allows, every tool its rules and limits, and no record ever
// holds a key. The studio's tool list on a temporary store: adding, changing by revision, retiring, the change stream
// and what each reader may do, and setting, replacing and removing a tool's key in a stand-in credential store that
// keeps keys in memory. Model-free: the program finder is injected, or reads a temporary folder of plain files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { realPath } from '../src/core/real-path.mjs';
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
  removeToolKey,
  retireTool,
  setToolKey,
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

test('a key state reads as set, when and its last four characters, or as not set, and nothing else', () => {
  const setAt = '2026-11-03T09:30:00.000Z';
  assert.deepEqual(toolKey(), { set: false });
  assert.deepEqual(toolKey({ set: false }), { set: false });
  assert.deepEqual(toolKey({ set: true, setAt, lastFour: '9481' }), { set: true, setAt, lastFour: '9481' });
  // Any other field under the key is never read.
  assert.deepEqual(toolKey({ set: true, setAt, lastFour: '9481', value: 'sk-live-secret', key: 'sk-live-secret' }), {
    set: true,
    setAt,
    lastFour: '9481',
  });
  // Anything that is not a well-formed set state reads as not set.
  for (const stored of [
    undefined,
    null,
    'set',
    [],
    { set: 'true', setAt, lastFour: '9481' },
    { set: true, lastFour: '9481' },
    { set: true, setAt: 'yesterday', lastFour: '9481' },
    { set: true, setAt: '2026-11-03', lastFour: '9481' },
    { set: true, setAt },
    { set: true, setAt, lastFour: 9481 },
    { set: true, setAt, lastFour: '481' },
    { set: true, setAt, lastFour: 'sk-live-secret' },
    { set: true, value: 'sk-live-secret' },
  ])
    assert.deepEqual(toolKey(stored), { set: false }, JSON.stringify(stored));
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
  const folder = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tools-')));
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
  // Removing a tool's key keeps the tool.
  assert.deepEqual(
    Object.keys(tools).filter(name => /delete|remove|drop|purge|erase|destroy/i.test(name)),
    ['removeToolKey'],
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

test('the director may change or retire an active tool and set its key, and remove one once set; a retired one and any other reader take no action', t => {
  const { store } = studio(t);
  const active = addTool(store, command()),
    retired = retireTool(store, addTool(store, studioCall()).id, 1),
    find = () => true;
  const director = ['change', 'retire', 'set-key'];
  assert.deepEqual(readTool(store, active.id, { find }).actions, director);
  assert.deepEqual(readTool(store, retired.id, { find }).actions, []);
  assert.deepEqual(
    readTools(store, { find }).map(tool => tool.actions),
    [director, []],
  );
  for (const reader of ['attempt-d4508f47', 'W-02', 'Director', '', null])
    assert.deepEqual(
      readTools(store, { reader, find }).map(tool => tool.actions),
      [[], []],
      `reader ${reader}`,
    );
  assert.deepEqual(readTool(store, active.id, { reader: 'attempt-d4508f47', find }).actions, []);
  assert.deepEqual(toolActions(active, 'director'), director);
  assert.deepEqual(toolActions(retired, 'director'), []);
  assert.deepEqual(toolActions(active, 'attempt-d4508f47'), []);
  // A read with no options is the director's.
  assert.deepEqual(readTool(store, retired.id).actions, []);
  assert.deepEqual(readTool(store, addTool(store, studioCall()).id).actions, director);

  // Once a key is set the director may remove it too; no other reader may, and removing it takes the action away.
  const keys = credentials(),
    keyed = setToolKey(store, keys, active.id, 1, testKey);
  assert.deepEqual(readTool(store, active.id, { find }).actions, [...director, 'remove-key']);
  assert.deepEqual(toolActions(keyed, 'director'), [...director, 'remove-key']);
  assert.deepEqual(readTool(store, active.id, { reader: 'attempt-d4508f47', find }).actions, []);
  removeToolKey(store, keys, active.id, 2);
  assert.deepEqual(readTool(store, active.id, { find }).actions, director);
  // A record whose key state is not well formed reads as no key set, and offers no removal.
  assert.deepEqual(toolActions({ ...keyed, key: { set: true } }, 'director'), director);
  // A retired tool takes no action, even one whose record says a key is set.
  assert.deepEqual(toolActions({ ...keyed, retiredAt: keyed.updatedAt }, 'director'), []);
});

test("every read's key says only whether a key is set, when and its last four, and the list holds no other key field", t => {
  const { store } = studio(t);
  const setAt = '2026-11-03T09:30:00.000Z';
  const added = addTool(store, command()),
    call = addTool(store, studioCall()),
    keyed = addTool(store, studioCall({ name: 'Keyed call' }));
  // A record written past the checks with key material and no well-formed set state reads as having no key set, and
  // nothing else of it.
  store.putTool({
    ...store.tool(call.id),
    key: { set: true, value: 'sk-live-secret' },
    apiKey: 'sk-live-secret',
    headers: { Authorization: 'Bearer sk-live-secret' },
  });
  // One with a set state and extra key material reads only set, setAt and lastFour, never the material.
  store.putTool({
    ...store.tool(keyed.id),
    key: { set: true, setAt, lastFour: 'cret', value: 'sk-live-secret', protectedKey: 'sk-live-secret' },
  });
  retireTool(store, added.id, 1);
  const list = readTools(store, { find: () => true });
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map(tool => tool.key),
    [{ set: false }, { set: false }, { set: true, setAt, lastFour: 'cret' }],
  );
  assert.deepEqual(readTool(store, call.id).key, { set: false });
  assert.deepEqual(readTool(store, keyed.id).key, { set: true, setAt, lastFour: 'cret' });
  const json = JSON.stringify([...list, readTool(store, call.id), readTool(store, keyed.id)]);
  assert.ok(!json.includes('sk-live-secret'));
  const keyFields = [];
  JSON.parse(JSON.stringify(list), (name, value) => {
    if (/key|secret|token|password|passwd|credential|auth|header|cookie/i.test(name)) keyFields.push([name, value]);
    return value;
  });
  assert.deepEqual(keyFields, [
    ['key', { set: false }],
    ['key', { set: false }],
    ['key', { set: true, setAt, lastFour: 'cret' }],
  ]);
});

// A stand-in for the computer's credential store: it keeps keys in memory and records every call it gets, by
// operation and tool ID. refuse names operations it refuses, in its own plain words.
function credentials({ refuse = [] } = {}) {
  const held = new Map(),
    calls = [];
  const call = (operation, id, act) => {
    calls.push([operation, id]);
    if (refuse.includes(operation)) throw new Error(`The stand-in store refused to ${operation} the key.`);
    return act();
  };
  return {
    held,
    calls,
    put: (id, key) => call('put', id, () => void held.set(id, key)),
    remove: id => call('remove', id, () => void held.delete(id)),
    read: id => call('read', id, () => (held.has(id) ? held.get(id) : null)),
    has: id => call('has', id, () => held.has(id)),
  };
}
const testKey = 'sd-test-key-QX7J-9481',
  secondKey = 'sd-test-key-ZP3M-5502';
const withoutSeq = changes => changes.map(({ seq, ...change }) => change);
// Every row of the store's settings and events tables, as text.
const storedRows = store =>
  JSON.stringify([store.db.prepare('SELECT * FROM settings').all(), store.db.prepare('SELECT * FROM events').all()]);
const validTime = value => typeof value === 'string' && new Date(value).toISOString() === value;

test("setting, replacing and removing a tool's key keep the key in the credential store and its state on the record", t => {
  const { store, changes } = studio(t);
  const keys = credentials(),
    added = addTool(store, studioCall());
  changes.length = 0;
  const set = setToolKey(store, keys, added.id, 1, testKey);
  assert.equal(set.revision, 2);
  assert.equal(set.by, 'director');
  assert.equal(set.updatedAt, set.key.setAt);
  assert.deepEqual(set.key, { set: true, setAt: set.key.setAt, lastFour: '9481' });
  assert.ok(validTime(set.key.setAt));
  assert.deepEqual(store.tool(added.id), set);
  assert.deepEqual([...keys.held], [[added.id, testKey]]);
  // A first key reads nothing from the store before keeping the new one.
  assert.deepEqual(keys.calls, [['put', added.id]]);
  assert.deepEqual(readTool(store, added.id).key, { set: true, setAt: set.key.setAt, lastFour: '9481' });
  assert.deepEqual(readTools(store)[0].key, { set: true, setAt: set.key.setAt, lastFour: '9481' });
  // The director's fields are unchanged.
  assert.deepEqual({ ...set, key: added.key, revision: 1, updatedAt: added.updatedAt }, added);

  // Replacing it at the new revision keeps the new key, with its own last four characters and a later revision.
  keys.calls.length = 0;
  const replaced = setToolKey(store, keys, added.id, 2, secondKey, 'director');
  assert.equal(replaced.revision, 3);
  assert.deepEqual(replaced.key, { set: true, setAt: replaced.key.setAt, lastFour: '5502' });
  assert.ok(validTime(replaced.key.setAt));
  assert.deepEqual([...keys.held], [[added.id, secondKey]]);
  assert.deepEqual(keys.calls, [
    ['read', added.id],
    ['put', added.id],
  ]);
  assert.deepEqual(readTool(store, added.id).key, replaced.key);

  // Removing it at the current revision leaves the store empty and the read says no key is set.
  keys.calls.length = 0;
  const removed = removeToolKey(store, keys, added.id, 3);
  assert.equal(removed.revision, 4);
  assert.deepEqual(removed.key, { set: false });
  assert.deepEqual(store.tool(added.id), removed);
  assert.equal(keys.held.size, 0);
  assert.deepEqual(keys.calls, [
    ['read', added.id],
    ['remove', added.id],
  ]);
  assert.deepEqual(readTool(store, added.id).key, { set: false });
  assert.deepEqual(readTools(store)[0].key, { set: false });
  // The tool can have a key again afterwards, and other tools are untouched.
  assert.equal(setToolKey(store, keys, added.id, 4, testKey).revision, 5);

  // Each write goes on the change stream as the tool's ID and revision and nothing else.
  assert.deepEqual(withoutSeq(changes), [
    { type: 'tool', id: added.id, revision: 2 },
    { type: 'tool', id: added.id, revision: 3 },
    { type: 'tool', id: added.id, revision: 4 },
    { type: 'tool', id: added.id, revision: 5 },
  ]);
});

test('retiring a tool with a key set removes the key; one with no key never calls the credential store', t => {
  const { store, changes } = studio(t);
  const keys = credentials(),
    keyed = addTool(store, command()),
    plain = addTool(store, studioCall());
  setToolKey(store, keys, keyed.id, 1, testKey);
  keys.calls.length = 0;
  changes.length = 0;
  const retired = retireTool(store, keyed.id, 2, 'director', keys);
  assert.equal(retired.revision, 3);
  assert.ok(validTime(retired.retiredAt));
  assert.deepEqual(retired.key, { set: false });
  assert.deepEqual(store.tool(keyed.id), retired);
  assert.equal(keys.held.size, 0);
  assert.deepEqual(keys.calls, [
    ['read', keyed.id],
    ['remove', keyed.id],
  ]);
  assert.deepEqual(readTool(store, keyed.id).key, { set: false });

  // A tool with no key retires without the credential store, given or not.
  keys.calls.length = 0;
  assert.equal(retireTool(store, plain.id, 1, 'director', keys).revision, 2);
  assert.deepEqual(keys.calls, []);
  const other = addTool(store, command());
  assert.equal(retireTool(store, other.id, 1).revision, 2);
  assert.deepEqual(withoutSeq(changes), [
    { type: 'tool', id: keyed.id, revision: 3 },
    { type: 'tool', id: plain.id, revision: 2 },
    { type: 'tool', id: other.id, revision: 1 },
    { type: 'tool', id: other.id, revision: 2 },
  ]);

  // Retiring a tool with a key set and no credential store is refused in plain words before anything changes.
  const unprovided = addTool(store, command());
  setToolKey(store, keys, unprovided.id, 1, testKey);
  const before = store.tool(unprovided.id),
    announced = changes.length;
  keys.calls.length = 0;
  refusedWith(() => retireTool(store, unprovided.id, 2), 500, /no credential store for tools' keys/);
  assert.deepEqual(store.tool(unprovided.id), before);
  assert.deepEqual([...keys.held], [[unprovided.id, testKey]]);
  assert.deepEqual(keys.calls, []);
  assert.equal(changes.length, announced);
});

test('every refusal comes before the credential store is called, and changes nothing', t => {
  const { store, changes } = studio(t);
  const keys = credentials(),
    plain = addTool(store, studioCall()),
    keyed = addTool(store, command()),
    retired = addTool(store, command());
  setToolKey(store, keys, keyed.id, 1, testKey);
  retireTool(store, retired.id, 1);
  keys.calls.length = 0;
  changes.length = 0;
  const records = () => store.tools(),
    before = records(),
    held = [...keys.held];
  const messages = [];
  const refusal = (call, status, message) =>
    assert.throws(call, error => {
      assert.equal(error.status, status);
      assert.match(error.message, message);
      messages.push(error.message);
      return true;
    });
  const retiredKey = /^This tool is retired, so it cannot have a key\.$/;
  // A stale revision, for setting and removing.
  for (const revision of [1, 3, 0, undefined, null, '2']) {
    refusal(() => setToolKey(store, keys, keyed.id, revision, secondKey), 409, stale);
    refusal(() => removeToolKey(store, keys, keyed.id, revision), 409, stale);
  }
  refusal(() => setToolKey(store, keys, plain.id, 2, testKey), 409, stale);
  // A retired tool, for setting and removing.
  refusal(() => setToolKey(store, keys, retired.id, 2, testKey), 409, retiredKey);
  refusal(() => removeToolKey(store, keys, retired.id, 2), 409, retiredKey);
  // A key that is not a key.
  refusal(
    () => setToolKey(store, keys, plain.id, 1, testKey.slice(-11)),
    400,
    /^A tool's key is at least 12 characters\.$/,
  );
  refusal(
    () => setToolKey(store, keys, plain.id, 1, 'Q'.repeat(2001)),
    400,
    /^A tool's key is at most 2000 characters\.$/,
  );
  const oneLine = /^A tool's key is one line, with no line break\.$/;
  for (const broken of [`${testKey}\n`, `sd-test\r-key-QX7J-9481`, `sd-test-key\0-QX7J-9481`, `sd-test\r\nkey-QX7J`])
    refusal(() => setToolKey(store, keys, plain.id, 1, broken), 400, oneLine);
  for (const notText of [undefined, null, 123456789012345, ['sd-test-key-QX7J-9481'], { key: testKey }])
    refusal(() => setToolKey(store, keys, plain.id, 1, notText), 400, /^A tool's key is text\.$/);
  // Removing a key that is not set.
  refusal(() => removeToolKey(store, keys, plain.id, 1), 409, /^This tool has no key to remove\.$/);
  // A tool that does not exist.
  refusal(() => setToolKey(store, keys, 'tool-missing', 1, testKey), 404, notFound);
  refusal(() => removeToolKey(store, keys, 'tool-missing', 1), 404, notFound);

  assert.deepEqual(keys.calls, []);
  assert.deepEqual([...keys.held], held);
  assert.deepEqual(records(), before);
  assert.deepEqual(changes, []);
  // No refusal repeats the key, or any part of it beyond what a read says.
  for (const message of messages) assert.ok(!message.includes('QX7J') && !message.includes('sd-test'), message);
  // A key of exactly 12 and of exactly 2000 characters is accepted.
  assert.equal(setToolKey(store, keys, plain.id, 1, 'sd-test-1234').key.lastFour, '1234');
  assert.equal(setToolKey(store, keys, plain.id, 2, 'Q'.repeat(1996) + '2000').key.lastFour, '2000');
});

test('a record that cannot be saved after the credential store changed puts the store back as it was', t => {
  const { store, changes } = studio(t);
  const keys = credentials(),
    tool = addTool(store, studioCall());
  // putTool throws once, after the credential store has changed.
  const failOnce = () =>
    t.mock.method(store, 'putTool').mock.mockImplementationOnce(() => {
      throw new Error('The disk is full.');
    });
  const failing = (call, check) => {
    const before = store.tool(tool.id),
      announced = changes.length;
    failOnce();
    assert.throws(call, { message: 'The disk is full.' });
    t.mock.restoreAll();
    assert.deepEqual(store.tool(tool.id), before);
    assert.equal(changes.length, announced);
    check();
  };

  // A first key: the store is left empty.
  failing(
    () => setToolKey(store, keys, tool.id, 1, testKey),
    () => {
      assert.equal(keys.held.size, 0);
      assert.deepEqual(keys.calls, [
        ['put', tool.id],
        ['remove', tool.id],
      ]);
    },
  );
  setToolKey(store, keys, tool.id, 1, testKey);

  // Replacing a key: the store holds the old key again.
  keys.calls.length = 0;
  failing(
    () => setToolKey(store, keys, tool.id, 2, secondKey),
    () => {
      assert.deepEqual([...keys.held], [[tool.id, testKey]]);
      assert.deepEqual(keys.calls, [
        ['read', tool.id],
        ['put', tool.id],
        ['put', tool.id],
      ]);
    },
  );

  // Removing a key: the store holds the old key again.
  failing(
    () => removeToolKey(store, keys, tool.id, 2),
    () => assert.deepEqual([...keys.held], [[tool.id, testKey]]),
  );

  // Retiring a tool with a key: the store holds the old key and the tool stays active.
  failing(
    () => retireTool(store, tool.id, 2, 'director', keys),
    () => {
      assert.deepEqual([...keys.held], [[tool.id, testKey]]);
      assert.equal(store.tool(tool.id).retiredAt, undefined);
    },
  );

  // The record and the store are still in step: the key can be replaced, then removed.
  assert.equal(setToolKey(store, keys, tool.id, 2, secondKey).revision, 3);
  assert.deepEqual([...keys.held], [[tool.id, secondKey]]);
  assert.equal(removeToolKey(store, keys, tool.id, 3).revision, 4);
  assert.equal(keys.held.size, 0);
});

test("a put the credential store refuses leaves the record unchanged and passes on the store's message", t => {
  const { store, changes } = studio(t);
  const tool = addTool(store, studioCall()),
    refusing = credentials({ refuse: ['put'] });
  const before = store.tool(tool.id),
    announced = changes.length;
  assert.throws(() => setToolKey(store, refusing, tool.id, 1, testKey), {
    message: 'The stand-in store refused to put the key.',
  });
  assert.deepEqual(store.tool(tool.id), before);
  assert.equal(refusing.held.size, 0);
  assert.equal(changes.length, announced);
  // A refused replacement keeps the old key and the record as they were.
  const keys = credentials();
  setToolKey(store, keys, tool.id, 1, testKey);
  const keyed = store.tool(tool.id);
  refusing.held.set(tool.id, testKey);
  assert.throws(() => setToolKey(store, refusing, tool.id, 2, secondKey), /refused to put the key/);
  assert.deepEqual(store.tool(tool.id), keyed);
  assert.deepEqual([...refusing.held], [[tool.id, testKey]]);
});

test('only the credential store ever holds the key: no read, change, message or stored row does', t => {
  const { store, changes } = studio(t);
  const keys = credentials(),
    tool = addTool(store, studioCall()),
    other = addTool(store, command());
  const seen = [];
  const keep = value => (seen.push(value), value);
  keep(setToolKey(store, keys, tool.id, 1, testKey));
  keep(readTool(store, tool.id));
  keep(readTools(store));
  for (const attempt of [
    () => setToolKey(store, keys, tool.id, 1, testKey),
    () => setToolKey(store, keys, tool.id, 2, `${testKey}\n`),
    () => setToolKey(store, keys, tool.id, 2, testKey.repeat(100)),
    () => setToolKey(store, credentials({ refuse: ['put'] }), tool.id, 2, testKey),
    () => removeToolKey(store, keys, other.id, 1),
  ])
    assert.throws(attempt, error => (keep(error.message), keep({ ...error }), true));
  keep(setToolKey(store, keys, tool.id, 2, testKey));
  keep(retireTool(store, tool.id, 3, 'director', keys));
  keep(readTools(store));
  const everything = JSON.stringify([seen, changes, storedRows(store)]);
  assert.ok(!everything.includes(testKey));
  assert.ok(!everything.includes('QX7J'));
  for (const change of changes) assert.deepEqual(Object.keys(change).sort(), ['id', 'revision', 'seq', 'type']);
  // The stand-in held it until the tool was retired.
  assert.equal(keys.held.size, 0);
  assert.deepEqual(
    keys.calls.filter(([operation]) => operation === 'put'),
    [
      ['put', tool.id],
      ['put', tool.id],
    ],
  );
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
    actions: ['change', 'retire', 'set-key'],
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
