// A studio tool's record and its checks: a command names one program and where to get it, a studio call an https
// address with nothing secret in it and the operations it allows, every tool its rules and limits, and no record ever
// holds a key. Model-free: the program finder is injected, or reads a temporary folder of plain files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkToolInput,
  operationRequest,
  programAvailability,
  programOnPath,
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
